import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BoardLeaseContext } from "../boards/types.js";
import type { BoardWorkerSupervisor } from "../boards/BoardWorkerSupervisor.js";
import type { C2000McpConfig } from "../config/config.schema.js";
import { SERVER_VERSION } from "../runtimeInfo.js";
import type { BoardRepository } from "../storage/repositories/BoardRepository.js";
import type { SessionRepository } from "../storage/repositories/SessionRepository.js";
import {
  type VariableStreamRecord,
  type VariableStreamStatus,
  VariableStreamRepository
} from "../storage/repositories/VariableStreamRepository.js";
import { DebugMcpError, toStructuredError } from "../utils/errors.js";
import { AtomicArtifactWriter } from "../artifacts/AtomicArtifactWriter.js";
import {
  ARTIFACT_SCHEMA_VERSION,
  artifactEventSchema,
  artifactManifestSchema,
  artifactResultSchema,
  type ArtifactEvent,
  type ArtifactManifest,
  type ArtifactResult
} from "../artifacts/ArtifactSchemas.js";
import {
  VARIABLE_STREAM_INTERNAL_TOOL,
  VARIABLE_STREAM_SCHEMA_VERSION,
  exportVariableStreamSchema,
  getVariableStreamStatusSchema,
  readVariableSamplesSchema,
  startVariableStreamSchema,
  stopVariableStreamSchema,
  variableMetadataSchema,
  variableSampleSchema,
  variableStreamStatsSchema,
  type StartVariableStreamInput,
  type VariableMetadata,
  type VariableSample,
  type VariableStreamStats
} from "./VariableStreamSchemas.js";

const TERMINAL = new Set<VariableStreamStatus>(["COMPLETED", "STOPPED", "CANCELLED", "INTERRUPTED", "FAILED"]);
const POLL_TIMEOUT_MS = 1000;

interface ActiveStream {
  abort: AbortController;
  requestedStatus?: "STOPPED" | "CANCELLED";
  reason?: string;
  task: Promise<void>;
}

interface BatchResult {
  success?: boolean;
  sessionId?: unknown;
  adapterSessionId?: unknown;
  coreId?: unknown;
  coreName?: unknown;
  workerInstanceId?: unknown;
  results?: unknown;
}

export class VariableStreamService {
  private readonly writer: AtomicArtifactWriter;
  private readonly active = new Map<string, ActiveStream>();

  constructor(private readonly options: {
    rootDirectory: string;
    config: C2000McpConfig;
    streams: VariableStreamRepository;
    boards: BoardRepository;
    sessions: SessionRepository;
    workers: BoardWorkerSupervisor;
    leaseContext: (sessionId: string, boardId: string, ttlMs: number) => BoardLeaseContext;
    writer?: AtomicArtifactWriter;
  }) {
    this.writer = options.writer ?? new AtomicArtifactWriter();
  }

  async recoverInterrupted(): Promise<void> {
    const interrupted = this.options.streams.markInterruptedOnStartup();
    await Promise.allSettled(interrupted.map(streamId => this.exportRecord(this.requireStream(streamId))));
  }

  async start(input: unknown): Promise<Record<string, unknown>> {
    const parsed = startVariableStreamSchema.parse(input);
    const session = this.options.sessions.get(parsed.sessionId);
    if (!session || session.closedAt || session.status === "CLOSED") {
      throw new DebugMcpError("SessionNotFound", "Variable stream requires an open persisted debug session", {
        sessionId: parsed.sessionId
      });
    }
    if (session.boardId !== parsed.boardId) {
      throw new DebugMcpError("SessionBoardMismatch", "Variable stream session is bound to another board", {
        boardId: parsed.boardId,
        sessionBoardId: session.boardId
      });
    }
    if (this.options.streams.activeForBoard(parsed.boardId)) {
      throw new DebugMcpError("VariableStreamAlreadyActive", "Only one active variable stream is allowed per board", {
        boardId: parsed.boardId
      });
    }

    const lease = this.options.leaseContext(parsed.sessionId, parsed.boardId, POLL_TIMEOUT_MS + 30_000);
    const worker = this.options.workers.currentWorker(parsed.boardId);
    if (!worker || worker.workerInstanceId !== lease.workerInstanceId) {
      throw new DebugMcpError("LeaseWorkerMismatch", "Variable stream lease does not bind the current board worker", {
        boardId: parsed.boardId,
        leaseWorkerInstanceId: lease.workerInstanceId,
        currentWorkerInstanceId: worker?.workerInstanceId
      });
    }
    const topology = await this.invokeLow(parsed, "c2000_getSessionTopology", {
      sessionId: parsed.sessionId
    }, lease, POLL_TIMEOUT_MS);
    const topologyCore = arrayRecords(topology.cores).find(core => core.coreId === parsed.coreId);
    if (!topologyCore || typeof topologyCore.coreName !== "string" || typeof topology.adapterSessionId !== "string") {
      throw new DebugMcpError("CoreIdentityMismatch", "Requested variable stream core is absent from the explicit DebugSession topology", {
        sessionId: parsed.sessionId,
        coreId: parsed.coreId,
        cores: topology.cores
      });
    }
    const metadata = await this.resolveMetadata(parsed, String(topologyCore.coreName), lease);
    const streamId = `varstream-${randomUUID()}`;
    const startedAt = new Date().toISOString();
    const artifactDirectory = this.streamDirectory(streamId);
    const record: VariableStreamRecord = {
      streamId,
      boardId: parsed.boardId,
      sessionId: parsed.sessionId,
      adapterSessionId: topology.adapterSessionId,
      coreId: parsed.coreId,
      coreName: String(topologyCore.coreName),
      workerInstanceId: worker.workerInstanceId,
      workerGeneration: worker.workerGeneration,
      leaseId: lease.leaseId,
      leaseGeneration: lease.leaseGeneration,
      fencingToken: lease.fencingToken,
      config: {
        variables: parsed.variables,
        samplePeriodMs: parsed.samplePeriodMs,
        durationMs: parsed.durationMs,
        maxSamples: parsed.maxSamples,
        maxArtifactBytes: parsed.maxArtifactBytes
      },
      metadata,
      status: "RUNNING",
      stats: emptyStats(parsed.samplePeriodMs),
      startedAt,
      artifactDirectory,
      evidenceLevel: this.evidenceLevel,
      artifactBytes: 0,
      artifactStatus: "PENDING"
    };
    this.options.streams.create(record);
    const control: ActiveStream = { abort: new AbortController(), task: Promise.resolve() };
    control.task = this.poll(record, parsed, control).finally(() => this.active.delete(streamId));
    this.active.set(streamId, control);
    return this.response(record);
  }

  async stop(input: unknown): Promise<Record<string, unknown>> {
    const parsed = stopVariableStreamSchema.parse(input);
    const record = this.requireIdentity(parsed);
    if (TERMINAL.has(record.status)) return this.response(record);
    const control = this.active.get(record.streamId);
    if (!control) {
      record.status = parsed.cancel ? "CANCELLED" : "STOPPED";
      record.stopReason = parsed.cancel ? "CANCEL_REQUESTED" : "STOP_REQUESTED";
      record.endedAt = new Date().toISOString();
      this.options.streams.update(record);
      await this.exportRecord(record);
      return this.response(this.requireStream(record.streamId));
    }
    control.requestedStatus = parsed.cancel ? "CANCELLED" : "STOPPED";
    control.reason = parsed.cancel ? "CANCEL_REQUESTED" : "STOP_REQUESTED";
    control.abort.abort();
    await control.task;
    return this.response(this.requireStream(record.streamId));
  }

  status(input: unknown): Record<string, unknown> {
    return this.response(this.requireIdentity(getVariableStreamStatusSchema.parse(input)));
  }

  readSamples(input: unknown): Record<string, unknown> {
    const parsed = readVariableSamplesSchema.parse(input);
    const record = this.requireIdentity(parsed);
    return {
      ...this.response(record),
      samples: this.options.streams.samples(record.streamId, parsed.afterSequence, parsed.limit)
    };
  }

  async export(input: unknown): Promise<Record<string, unknown>> {
    const record = this.requireIdentity(exportVariableStreamSchema.parse(input));
    await this.exportRecord(record);
    return this.response(this.requireStream(record.streamId));
  }

  async preemptBoard(boardId: string, toolName: string): Promise<void> {
    const record = this.options.streams.activeForBoard(boardId);
    if (!record) return;
    const control = this.active.get(record.streamId);
    if (!control) return;
    control.requestedStatus = "CANCELLED";
    control.reason = `PREEMPTED_BY:${toolName}`;
    control.abort.abort();
  }

  async stopAll(): Promise<void> {
    const tasks: Promise<void>[] = [];
    for (const [streamId, control] of this.active) {
      control.requestedStatus = "CANCELLED";
      control.reason = "DAEMON_SHUTDOWN";
      control.abort.abort();
      tasks.push(control.task);
      this.active.set(streamId, control);
    }
    await Promise.allSettled(tasks);
  }

  private async poll(record: VariableStreamRecord, input: StartVariableStreamInput, control: ActiveStream): Promise<void> {
    const originNs = process.hrtime.bigint();
    const durationNs = BigInt(input.durationMs) * 1_000_000n;
    const periodNs = BigInt(input.samplePeriodMs) * 1_000_000n;
    let nextPollNs = originNs;
    let previousPollNs: bigint | undefined;
    let intervalTotal = 0;
    let intervalCount = 0;
    try {
      while (!control.abort.signal.aborted && record.stats.totalSamples < input.maxSamples) {
        const nowNs = process.hrtime.bigint();
        if (nowNs - originNs >= durationNs) break;
        if (nowNs < nextPollNs) {
          await wait(Number(nextPollNs - nowNs) / 1_000_000, control.abort.signal);
          if (control.abort.signal.aborted) break;
        }
        const pollingStartNs = process.hrtime.bigint();
        if (pollingStartNs - originNs >= durationNs) break;
        if (pollingStartNs > nextPollNs + periodNs) {
          const missed = Number((pollingStartNs - nextPollNs) / periodNs);
          record.stats.missedPollCount += missed;
          record.stats.droppedSampleCount += missed;
          nextPollNs += BigInt(missed) * periodNs;
        }
        const pollingStartedAt = new Date().toISOString();
        const actualInterval = previousPollNs === undefined
          ? null
          : Number(pollingStartNs - previousPollNs) / 1_000_000;
        previousPollNs = pollingStartNs;
        if (actualInterval !== null) {
          intervalTotal += actualInterval;
          intervalCount += 1;
          record.stats.actualHostIntervalMs = {
            last: actualInterval,
            min: record.stats.actualHostIntervalMs.min === null ? actualInterval : Math.min(record.stats.actualHostIntervalMs.min, actualInterval),
            max: record.stats.actualHostIntervalMs.max === null ? actualInterval : Math.max(record.stats.actualHostIntervalMs.max, actualInterval),
            mean: intervalTotal / intervalCount
          };
        }
        const lease = this.validateRuntimeIdentity(record);
        const result = await this.invokeLow(input, VARIABLE_STREAM_INTERNAL_TOOL, {
          sessionId: record.sessionId,
          coreId: record.coreId,
          expressions: record.metadata.map(item => item.symbol),
          timeoutMs: POLL_TIMEOUT_MS
        }, lease, POLL_TIMEOUT_MS + 250);
        this.assertBatchIdentity(record, result);
        const pollingEndNs = process.hrtime.bigint();
        const readDurationMs = Number(pollingEndNs - pollingStartNs) / 1_000_000;
        if (readDurationMs > input.samplePeriodMs) record.stats.overrunCount += 1;
        const reads = mapReads(record.metadata, result.results);
        record.stats.readErrorCount += Object.values(reads).filter(item => item.status === "ERROR").length;
        const sample: VariableSample = variableSampleSchema.parse({
          schemaVersion: VARIABLE_STREAM_SCHEMA_VERSION,
          streamId: record.streamId,
          sequence: record.stats.totalSamples + 1,
          boardId: record.boardId,
          sessionId: record.sessionId,
          coreId: record.coreId,
          coreName: record.coreName,
          timestamp: new Date().toISOString(),
          monotonicTimestampNs: pollingEndNs.toString(),
          pollingStartedAt,
          pollingEndedAt: new Date().toISOString(),
          readDurationMs,
          actualHostIntervalMs: actualInterval,
          targetSampleTime: null,
          variables: reads
        });
        const sampleBytes = Buffer.byteLength(`${JSON.stringify(sample)}\n`);
        if (record.artifactBytes + sampleBytes > input.maxArtifactBytes) {
          record.stats.droppedSampleCount += 1;
          throw new DebugMcpError("VariableArtifactSizeLimit", "Variable stream artifact size limit was reached", {
            maxArtifactBytes: input.maxArtifactBytes
          });
        }
        this.options.streams.appendSample(record.streamId, sample);
        record.artifactBytes += sampleBytes;
        record.stats.totalSamples += 1;
        this.options.streams.update(record);
        nextPollNs += periodNs;
      }
      record.status = control.requestedStatus ?? "COMPLETED";
      record.stopReason = control.reason ?? (record.stats.totalSamples >= input.maxSamples ? "MAX_SAMPLES_REACHED" : "DURATION_REACHED");
    } catch (error) {
      if (control.abort.signal.aborted) {
        record.status = control.requestedStatus ?? "CANCELLED";
        record.stopReason = control.reason ?? "CANCEL_REQUESTED";
      } else {
        record.status = "FAILED";
        record.stopReason = errorCode(error);
        record.error = { ...toStructuredError(error) };
      }
    } finally {
      record.endedAt = new Date().toISOString();
      variableStreamStatsSchema.parse(record.stats);
      this.options.streams.update(record);
      await this.exportRecord(record);
    }
  }

  private validateRuntimeIdentity(record: VariableStreamRecord): BoardLeaseContext {
    const session = this.options.sessions.get(record.sessionId);
    if (!session || session.closedAt || session.status === "CLOSED") {
      throw new DebugMcpError("SessionInvalidated", "Variable stream session is no longer open", { sessionId: record.sessionId });
    }
    if (session.boardId !== record.boardId || (session.adapterSessionId && session.adapterSessionId !== record.adapterSessionId)) {
      throw new DebugMcpError("SessionIdentityMismatch", "Variable stream persisted session identity changed", {
        sessionId: record.sessionId
      });
    }
    const worker = this.options.workers.currentWorker(record.boardId);
    if (!worker || worker.workerInstanceId !== record.workerInstanceId || worker.workerGeneration !== record.workerGeneration) {
      throw new DebugMcpError("WorkerGenerationChanged", "Variable stream worker generation changed", {
        expectedWorkerInstanceId: record.workerInstanceId,
        expectedWorkerGeneration: record.workerGeneration,
        actual: worker
      });
    }
    const lease = this.options.leaseContext(record.sessionId, record.boardId, POLL_TIMEOUT_MS + 30_000);
    if (lease.leaseId !== record.leaseId ||
        lease.leaseGeneration !== record.leaseGeneration ||
        lease.fencingToken !== record.fencingToken ||
        lease.workerInstanceId !== record.workerInstanceId) {
      throw new DebugMcpError("LeaseGenerationChanged", "Variable stream lease fencing identity changed", {
        streamId: record.streamId
      });
    }
    return lease;
  }

  private async resolveMetadata(input: StartVariableStreamInput, coreName: string, lease: BoardLeaseContext): Promise<VariableMetadata[]> {
    const requested: Array<{ symbol: string; typeName?: string; enumSignedness?: "signed" | "unsigned" }> =
      input.variables.map(item => typeof item === "string" ? { symbol: item } : item);
    const expressions = requested.flatMap(item => [item.symbol, `&(${item.symbol})`, `sizeof(${item.symbol})`]);
    const result = await this.invokeLow(input, VARIABLE_STREAM_INTERNAL_TOOL, {
      sessionId: input.sessionId,
      coreId: input.coreId,
      expressions,
      timeoutMs: POLL_TIMEOUT_MS
    }, lease, POLL_TIMEOUT_MS + 250);
    if (result.coreId !== input.coreId || result.coreName !== coreName || result.sessionId !== input.sessionId) {
      throw new DebugMcpError("CoreIdentityMismatch", "Variable metadata response did not match the requested core", {
        expected: { sessionId: input.sessionId, coreId: input.coreId, coreName },
        received: { sessionId: result.sessionId, coreId: result.coreId, coreName: result.coreName }
      });
    }
    const byExpression = new Map(arrayRecords(result.results).map(item => [String(item.expression), item]));
    return requested.map(item => {
      const value = requireEvaluation(byExpression.get(item.symbol), item.symbol);
      const address = requireEvaluation(byExpression.get(`&(${item.symbol})`), `&(${item.symbol})`);
      const size = requireEvaluation(byExpression.get(`sizeof(${item.symbol})`), `sizeof(${item.symbol})`);
      const typeName = item.typeName ?? stringValue(value.type);
      if (!typeName) {
        throw new DebugMcpError("VariableTypeRequired", "The adapter did not expose a reliable C type; provide typeName explicitly", {
          symbol: item.symbol
        });
      }
      const type = classifyType(typeName, item.enumSignedness);
      const addressUnits = parseInteger(size.value);
      if (addressUnits !== type.addressUnits) {
        throw new DebugMcpError("VariableWidthMismatch", "C28x sizeof result does not match the declared variable type", {
          symbol: item.symbol,
          typeName,
          expectedAddressUnits: type.addressUnits,
          actualAddressUnits: addressUnits
        });
      }
      const metadata: VariableMetadata = {
        symbol: item.symbol,
        resolvedAddress: parseAddress(stringValue(address.value) ?? stringValue(value.address)),
        typeName,
        byteWidth: type.byteWidth,
        addressUnits: type.addressUnits,
        addressUnitBits: 16,
        signedness: type.signedness,
        encoding: type.encoding,
        coreId: input.coreId,
        coreName
      };
      return variableMetadataSchema.parse(metadata);
    });
  }

  private async invokeLow(
    input: { boardId: string },
    toolName: string,
    toolInput: Record<string, unknown>,
    lease: BoardLeaseContext,
    timeoutMs: number
  ): Promise<BatchResult & Record<string, unknown>> {
    return this.options.workers.invokeBoardLowPriority(input.boardId, toolName, {
      ...toolInput,
      __leaseContext: lease
    }, timeoutMs) as Promise<BatchResult & Record<string, unknown>>;
  }

  private assertBatchIdentity(record: VariableStreamRecord, result: BatchResult): void {
    if (result.sessionId !== record.sessionId ||
        result.adapterSessionId !== record.adapterSessionId ||
        result.coreId !== record.coreId ||
        result.coreName !== record.coreName ||
        result.workerInstanceId !== record.workerInstanceId) {
      throw new DebugMcpError("CoreIdentityMismatch", "Variable sample response identity changed", {
        expected: {
          sessionId: record.sessionId,
          adapterSessionId: record.adapterSessionId,
          coreId: record.coreId,
          coreName: record.coreName,
          workerInstanceId: record.workerInstanceId
        },
        received: result
      });
    }
  }

  private requireIdentity(input: { streamId: string; boardId: string; sessionId: string; coreId: number }): VariableStreamRecord {
    const record = this.requireStream(input.streamId);
    if (record.boardId !== input.boardId || record.sessionId !== input.sessionId || record.coreId !== input.coreId) {
      throw new DebugMcpError("VariableStreamIdentityMismatch", "Variable stream identity did not match board/session/core binding", {
        streamId: input.streamId
      });
    }
    return record;
  }

  private requireStream(streamId: string): VariableStreamRecord {
    const record = this.options.streams.get(streamId);
    if (!record) throw new DebugMcpError("VariableStreamNotFound", "Variable stream was not found", { streamId });
    return record;
  }

  private response(record: VariableStreamRecord): Record<string, unknown> {
    return {
      success: record.status !== "FAILED",
      streamId: record.streamId,
      boardId: record.boardId,
      sessionId: record.sessionId,
      adapterSessionId: record.adapterSessionId,
      coreId: record.coreId,
      coreName: record.coreName,
      workerInstanceId: record.workerInstanceId,
      workerGeneration: record.workerGeneration,
      status: record.status,
      metadata: record.metadata,
      stats: record.stats,
      startedAt: record.startedAt,
      endedAt: record.endedAt ?? null,
      stopReason: record.stopReason ?? null,
      error: record.error ?? null,
      artifactDirectory: record.artifactDirectory,
      artifactStatus: record.artifactStatus,
      artifactError: record.artifactError ?? null,
      evidenceLevel: record.evidenceLevel
    };
  }

  private async exportRecord(record: VariableStreamRecord): Promise<void> {
    const directory = record.artifactDirectory;
    try {
      await this.writer.ensureDirectory(path.join(directory, "attachments"));
      const samples = this.options.streams.allSamples(record.streamId);
      samples.forEach(sample => variableSampleSchema.parse(sample));
      if (samples.length > 0) {
        await this.writer.writeJsonLines(path.join(directory, "variables.jsonl"), samples);
      } else {
        await rm(path.join(directory, "variables.jsonl"), { force: true });
      }
      const { manifest, result, events } = this.snapshot(record);
      artifactManifestSchema.parse(manifest);
      artifactResultSchema.parse(result);
      events.forEach(event => artifactEventSchema.parse(event));
      await this.writer.writeJson(path.join(directory, "result.json"), result);
      await this.writer.writeJsonLines(path.join(directory, "events.jsonl"), events);
      await this.writer.writeText(path.join(directory, "summary.md"), renderSummary(manifest, result, record.stats));
      await this.writer.writeJson(path.join(directory, "manifest.json"), manifest);
      record.artifactStatus = "EXPORTED";
      record.artifactError = undefined;
      this.options.streams.update(record);
    } catch (error) {
      record.artifactStatus = "FAILED";
      record.artifactError = { ...toStructuredError(error) };
      this.options.streams.update(record);
    }
  }

  private snapshot(record: VariableStreamRecord): {
    manifest: ArtifactManifest;
    result: ArtifactResult;
    events: ArtifactEvent[];
  } {
    const board = this.options.boards.require(record.boardId);
    const terminal = TERMINAL.has(record.status);
    const complete = record.status === "COMPLETED";
    const reason = complete ? null : terminal ? record.stopReason ?? record.status : "STREAM_ACTIVE";
    const adapterType = this.adapterType;
    const endedAt = record.endedAt ?? new Date().toISOString();
    const manifest: ArtifactManifest = {
      schemaVersion: ARTIFACT_SCHEMA_VERSION,
      jobId: record.streamId,
      jobType: "variable-stream",
      targets: [{
        boardId: board.boardId,
        boardProfile: { device: board.device, tags: [...board.tags].sort() },
        xds110Serial: board.probeSerial,
        adapterType,
        workerGeneration: record.workerGeneration,
        adapterSessionId: record.adapterSessionId,
        sessionId: record.sessionId,
        cores: [{ coreId: record.coreId, coreName: record.coreName }],
        programs: []
      }],
      mcpVersion: SERVER_VERSION,
      nodeVersion: process.version,
      operatingSystem: { platform: os.platform(), release: os.release(), architecture: os.arch() },
      ccsVersion: null,
      configSummary: {
        variableStreamSchemaVersion: VARIABLE_STREAM_SCHEMA_VERSION,
        samplePeriodMs: record.stats.requestedSamplePeriodMs,
        variableCount: record.metadata.length,
        maxSamples: record.config.maxSamples,
        durationMs: record.config.durationMs,
        maxArtifactBytes: record.config.maxArtifactBytes
      },
      startedAt: record.startedAt,
      endedAt,
      evidenceLevel: record.evidenceLevel,
      completeness: { status: complete ? "COMPLETE" : "INCOMPLETE", reason }
    };
    const result: ArtifactResult = {
      schemaVersion: ARTIFACT_SCHEMA_VERSION,
      jobId: record.streamId,
      overallStatus: record.status,
      errorCode: stringValue(record.error?.code) ?? null,
      failedStep: null,
      assertions: [],
      evidenceClassification: record.evidenceLevel,
      cancelled: record.status === "CANCELLED",
      timedOut: Boolean(record.stopReason && /timeout/i.test(record.stopReason)),
      incompleteReason: reason
    };
    const baseEvent = {
      schemaVersion: ARTIFACT_SCHEMA_VERSION,
      jobId: record.streamId,
      source: { type: "daemon", id: "variable-stream" },
      boardId: record.boardId,
      workerGeneration: record.workerGeneration,
      adapterSessionId: record.adapterSessionId,
      sessionId: record.sessionId,
      coreId: record.coreId,
      coreName: record.coreName
    } as const;
    const events: ArtifactEvent[] = [{
      ...baseEvent,
      sequence: 1,
      eventType: "VARIABLE_STREAM_STARTED",
      timestamp: record.startedAt,
      monotonicTimestampNs: "1",
      payload: { metadata: record.metadata, config: record.config }
    }, {
      ...baseEvent,
      sequence: 2,
      eventType: terminal ? "VARIABLE_STREAM_ENDED" : "VARIABLE_STREAM_SNAPSHOT",
      timestamp: endedAt,
      monotonicTimestampNs: "2",
      payload: { status: record.status, stopReason: record.stopReason ?? null, stats: record.stats }
    }];
    return { manifest, result, events };
  }

  private streamDirectory(streamId: string): string {
    if (!/^[A-Za-z0-9._-]+$/.test(streamId)) throw new Error("Unsafe variable stream id");
    return path.join(path.resolve(this.options.rootDirectory), streamId);
  }

  private get adapterType(): "mock" | "ccs" | "auto" {
    return this.options.config.adapter === "auto" ? this.options.config.ccs.scriptingMode : this.options.config.adapter;
  }

  private get evidenceLevel(): VariableStreamRecord["evidenceLevel"] {
    return this.adapterType === "mock" ? "MOCK" : this.adapterType === "ccs" ? "HARDWARE_TARGET" : "UNKNOWN";
  }
}

export function classifyType(typeName: string, enumSignedness?: "signed" | "unsigned"): Pick<VariableMetadata, "byteWidth" | "addressUnits" | "signedness" | "encoding"> {
  const normalized = typeName.toLowerCase().replace(/\b(const|volatile)\b/g, "").replace(/\s+/g, " ").trim();
  if (["uint16_t", "unsigned int", "unsigned short"].includes(normalized)) {
    return { byteWidth: 2, addressUnits: 1, signedness: "unsigned", encoding: "unsigned-integer" };
  }
  if (["int16_t", "int", "signed int", "short", "signed short"].includes(normalized)) {
    return { byteWidth: 2, addressUnits: 1, signedness: "signed", encoding: "signed-integer" };
  }
  if (["uint32_t", "unsigned long"].includes(normalized)) {
    return { byteWidth: 4, addressUnits: 2, signedness: "unsigned", encoding: "unsigned-integer" };
  }
  if (["int32_t", "long", "signed long"].includes(normalized)) {
    return { byteWidth: 4, addressUnits: 2, signedness: "signed", encoding: "signed-integer" };
  }
  if (normalized === "float") {
    return { byteWidth: 4, addressUnits: 2, signedness: "not-applicable", encoding: "ieee754-binary32" };
  }
  if (/^enum(?:\s|$)/.test(normalized)) {
    if (!enumSignedness) {
      throw new DebugMcpError("VariableEnumSignednessRequired", "Simple enum variables require explicit enumSignedness", { typeName });
    }
    return { byteWidth: 2, addressUnits: 1, signedness: enumSignedness, encoding: "enum" };
  }
  throw new DebugMcpError("VariableTypeUnsupported", "Variable type is not supported by slow streaming", { typeName });
}

function mapReads(metadata: VariableMetadata[], raw: unknown): VariableSample["variables"] {
  const byExpression = new Map(arrayRecords(raw).map(item => [String(item.expression), item]));
  return Object.fromEntries(metadata.map(item => {
    const value = byExpression.get(item.symbol);
    if (!value || value.success !== true) {
      return [item.symbol, {
        status: "ERROR" as const,
        value: null,
        error: {
          code: stringValue(record(value?.error).code) ?? "VariableReadFailed",
          message: stringValue(record(value?.error).message) ?? "Variable expression read failed"
        }
      }];
    }
    try {
      return [item.symbol, { status: "OK" as const, value: parseTypedValue(item, value.value) }];
    } catch (error) {
      return [item.symbol, {
        status: "ERROR" as const,
        value: null,
        error: { code: errorCode(error), message: error instanceof Error ? error.message : String(error) }
      }];
    }
  }));
}

function parseTypedValue(metadata: VariableMetadata, value: unknown): number | string {
  const raw = stringValue(value);
  if (raw === undefined) throw new Error(`No value returned for ${metadata.symbol}`);
  if (metadata.encoding === "ieee754-binary32") {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) throw new Error(`Non-finite float returned for ${metadata.symbol}`);
    return parsed;
  }
  if (metadata.encoding === "enum" && !/^\s*(?:[-+]?\d+|0x[0-9a-f]+)\s*$/i.test(raw)) return raw;
  return parseInteger(raw);
}

function requireEvaluation(value: Record<string, unknown> | undefined, expression: string): Record<string, unknown> {
  if (!value || value.success !== true) {
    throw new DebugMcpError("VariableSymbolResolutionFailed", "Variable metadata expression failed", {
      expression,
      error: value?.error
    });
  }
  return value;
}

function parseAddress(value: string | undefined): string {
  if (!value) throw new DebugMcpError("VariableAddressMissing", "Variable address was not returned", {});
  const match = value.match(/0x[0-9a-f]+/i);
  if (!match) throw new DebugMcpError("VariableAddressInvalid", "Variable address is not hexadecimal", { value });
  return match[0].toLowerCase();
}

function parseInteger(value: unknown): number {
  const raw = stringValue(value);
  if (raw === undefined || !/^\s*(?:[-+]?\d+|0x[0-9a-f]+)\s*$/i.test(raw)) {
    throw new DebugMcpError("VariableIntegerInvalid", "Variable expression is not an integer", { value });
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) throw new DebugMcpError("VariableIntegerUnsafe", "Variable integer exceeds host safe range", { value });
  return parsed;
}

function emptyStats(samplePeriodMs: number): VariableStreamStats {
  return {
    requestedSamplePeriodMs: samplePeriodMs,
    actualHostIntervalMs: { last: null, min: null, max: null, mean: null },
    missedPollCount: 0,
    overrunCount: 0,
    readErrorCount: 0,
    droppedSampleCount: 0,
    totalSamples: 0
  };
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted || milliseconds <= 0) return resolve();
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

function renderSummary(manifest: ArtifactManifest, result: ArtifactResult, stats: VariableStreamStats): string {
  return `# Variable stream evidence summary

- Stream: ${manifest.jobId}
- Status: ${result.overallStatus}
- Evidence: ${result.evidenceClassification}
- Artifact completeness: ${manifest.completeness.status}
- Requested period: ${stats.requestedSamplePeriodMs} ms
- Samples: ${stats.totalSamples}
- Missed polls: ${stats.missedPollCount}
- Overruns: ${stats.overrunCount}
- Read errors: ${stats.readErrorCount}
- Dropped samples: ${stats.droppedSampleCount}

Host polling timestamps are not MCU sample timestamps. targetSampleTime is null because this stream has no firmware-provided clock.

This summary is generated from manifest.json, result.json, events.jsonl, and variables.jsonl.
`;
}

function errorCode(error: unknown): string {
  return error instanceof DebugMcpError ? error.code : error instanceof Error ? error.name : "VariableStreamError";
}

function arrayRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
