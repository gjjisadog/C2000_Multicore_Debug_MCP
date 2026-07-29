import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { BoardLeaseContext } from "../boards/types.js";
import type { BoardWorkerSupervisor } from "../boards/BoardWorkerSupervisor.js";
import type { C2000McpConfig } from "../config/config.schema.js";
import type { BoardRepository } from "../storage/repositories/BoardRepository.js";
import type { SessionRepository } from "../storage/repositories/SessionRepository.js";
import { DebugMcpError } from "../utils/errors.js";
import { SERVER_VERSION } from "../runtimeInfo.js";
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
  DLOG_EXPRESSION_BATCH_TOOL,
  DLOG_SCHEMA_VERSION,
  dlogBufferRequestSchema,
  dlogCaptureSchema,
  dlogChannelMetadataSchema,
  dlogDescriptorSchema,
  dlogStatusSnapshotSchema,
  type DlogBufferRequest,
  type DlogCapture,
  type DlogDescriptor,
  type DlogStatusSnapshot
} from "./DlogSchemas.js";

const DLOG_BATCH_SIZE = 96;
const DLOG_BATCH_TIMEOUT_MS = 5000;

interface BoundRequest {
  input: DlogBufferRequest;
  lease: BoardLeaseContext;
  descriptor: DlogDescriptor;
}

interface ReadAttempt {
  before: DlogStatusSnapshot;
  after: DlogStatusSnapshot;
  channels: Array<{ name: string; unit: string; type: DlogBufferRequest["channels"][number]["type"]; values: number[] }>;
  changedFields: Array<"state" | "writeIndex" | "triggerIndex" | "generation" | "sampleRateHz">;
}

export class DlogService {
  private readonly writer: AtomicArtifactWriter;

  constructor(private readonly options: {
    rootDirectory: string;
    config: C2000McpConfig;
    boards: BoardRepository;
    sessions: SessionRepository;
    workers: BoardWorkerSupervisor;
    leaseContext: (sessionId: string, boardId: string, ttlMs: number) => BoardLeaseContext;
    writer?: AtomicArtifactWriter;
  }) {
    this.writer = options.writer ?? new AtomicArtifactWriter();
  }

  async describe(value: unknown): Promise<Record<string, unknown>> {
    const bound = await this.bind(value);
    return { success: true, descriptor: bound.descriptor, ...identity(bound.descriptor) };
  }

  async status(value: unknown): Promise<Record<string, unknown>> {
    const bound = await this.bind(value);
    const status = await this.readStatus(bound);
    return { success: true, descriptor: bound.descriptor, status, ...identity(bound.descriptor) };
  }

  async read(value: unknown): Promise<Record<string, unknown>> {
    const bound = await this.bind(value);
    const capture = await this.capture(bound);
    return {
      success: capture.captureCompleteness === "COMPLETE",
      capture,
      ...identity(bound.descriptor),
      ...(capture.incompleteReason
        ? { error: { code: "DlogSnapshotInconsistent", message: capture.incompleteReason } }
        : {})
    };
  }

  async export(value: unknown): Promise<Record<string, unknown>> {
    const bound = await this.bind(value);
    const capture = await this.capture(bound);
    const directory = this.captureDirectory(capture.captureId);
    await this.writeArtifacts(directory, bound, capture);
    return {
      success: capture.captureCompleteness === "COMPLETE",
      captureId: capture.captureId,
      artifactDirectory: directory,
      captureCompleteness: capture.captureCompleteness,
      consistency: capture.consistency,
      ...identity(bound.descriptor),
      ...(capture.incompleteReason
        ? { error: { code: "DlogSnapshotInconsistent", message: capture.incompleteReason } }
        : {})
    };
  }

  private async bind(value: unknown): Promise<BoundRequest> {
    const raw = record(value);
    if (raw.layout === "array-of-structures") {
      throw new DebugMcpError("UnsupportedLayout", "First-version DLOG export supports structure-of-arrays only", {
        layout: raw.layout,
        supportedLayouts: ["structure-of-arrays"]
      });
    }
    const input = dlogBufferRequestSchema.parse(value);
    validateRequestRelationships(input);
    const session = this.options.sessions.get(input.sessionId);
    if (!session || session.closedAt || session.status === "CLOSED") {
      throw new DebugMcpError("SessionNotFound", "DLOG access requires an open persisted debug session", {
        sessionId: input.sessionId
      });
    }
    if (session.boardId !== input.boardId) {
      throw new DebugMcpError("SessionBoardMismatch", "DLOG session is bound to another board", {
        boardId: input.boardId,
        sessionBoardId: session.boardId
      });
    }
    const lease = this.options.leaseContext(input.sessionId, input.boardId, DLOG_BATCH_TIMEOUT_MS + 30_000);
    const worker = this.options.workers.currentWorker(input.boardId);
    if (!worker || worker.workerInstanceId !== lease.workerInstanceId) {
      throw new DebugMcpError("LeaseWorkerMismatch", "DLOG lease does not bind the current board worker", {
        boardId: input.boardId,
        leaseWorkerInstanceId: lease.workerInstanceId,
        currentWorkerInstanceId: worker?.workerInstanceId
      });
    }
    const topology = await this.invoke(input, lease, "c2000_getSessionTopology", { sessionId: input.sessionId });
    const core = arrayRecords(topology.cores).find(candidate => candidate.coreId === input.coreId);
    if (!core || typeof core.coreName !== "string" || typeof topology.adapterSessionId !== "string") {
      throw new DebugMcpError("CoreIdentityMismatch", "DLOG core is absent from the explicit DebugSession topology", {
        sessionId: input.sessionId,
        coreId: input.coreId,
        cores: topology.cores
      });
    }
    const metadataExpressions = [
      `&(${input.bufferSymbol})`,
      ...input.channels.flatMap(channel => [`&(${channel.symbol})`, `sizeof(${channel.symbol}[0])`])
    ];
    const metadataResult = await this.evaluate(input, lease, metadataExpressions);
    this.assertIdentity(input, topology.adapterSessionId, String(core.coreName), worker.workerInstanceId, metadataResult);
    const values = evaluationMap(metadataResult.results);
    const bufferAddress = parseAddress(requireEvaluation(values, `&(${input.bufferSymbol})`).value);
    const channels = input.channels.map(channel => {
      const width = elementWidth(channel.type);
      const actualAddressUnits = parseInteger(requireEvaluation(values, `sizeof(${channel.symbol}[0])`).value);
      if (actualAddressUnits !== width.addressUnitsPerElement) {
        throw new DebugMcpError("DlogElementWidthMismatch", "C28x sizeof result does not match the configured DLOG element type", {
          channel: channel.name,
          symbol: channel.symbol,
          type: channel.type,
          expectedAddressUnits: width.addressUnitsPerElement,
          actualAddressUnits
        });
      }
      return dlogChannelMetadataSchema.parse({
        ...channel,
        resolvedAddress: parseAddress(requireEvaluation(values, `&(${channel.symbol})`).value),
        ...width,
        totalAddressUnits: input.sampleCount * width.addressUnitsPerElement,
        totalOctets: input.sampleCount * width.elementWidthOctets
      });
    });
    const totalReadOctets = channels.reduce((total, channel) => total + channel.totalOctets, 0);
    const totalReadAddressUnits = channels.reduce((total, channel) => total + channel.totalAddressUnits, 0);
    if (totalReadOctets > input.maxArtifactBytes) {
      throw new DebugMcpError("DlogBufferTooLarge", "DLOG raw channel data exceeds the artifact size limit", {
        totalReadOctets,
        maxArtifactBytes: input.maxArtifactBytes
      });
    }
    const descriptor = dlogDescriptorSchema.parse({
      schemaVersion: DLOG_SCHEMA_VERSION,
      boardId: input.boardId,
      sessionId: input.sessionId,
      adapterSessionId: topology.adapterSessionId,
      workerInstanceId: worker.workerInstanceId,
      workerGeneration: worker.workerGeneration,
      coreId: input.coreId,
      coreName: core.coreName,
      bufferSymbol: input.bufferSymbol,
      bufferAddress,
      layout: input.layout,
      sampleCount: input.sampleCount,
      sampleRateHz: input.sampleRateHz,
      sampleRateSource: input.sampleRateSource,
      channels,
      totalReadOctets,
      totalReadAddressUnits,
      targetAddressUnitBits: 16
    });
    return { input, lease, descriptor };
  }

  private async capture(bound: BoundRequest): Promise<DlogCapture> {
    const startedNs = process.hrtime.bigint();
    let attempt: ReadAttempt | undefined;
    let attempts = 0;
    for (let index = 0; index <= bound.input.maxReadRetries; index += 1) {
      attempts = index + 1;
      this.validateIdentity(bound);
      const before = await this.readStatus(bound);
      const channels = [];
      for (const channel of bound.input.channels) {
        const values: number[] = [];
        for (let offset = 0; offset < bound.input.sampleCount; offset += DLOG_BATCH_SIZE) {
          this.validateIdentity(bound);
          const end = Math.min(bound.input.sampleCount, offset + DLOG_BATCH_SIZE);
          const expressions = Array.from({ length: end - offset }, (_, item) => `${channel.symbol}[${offset + item}]`);
          const result = await this.evaluate(bound.input, bound.lease, expressions);
          this.assertDescriptorIdentity(bound.descriptor, result);
          const byExpression = evaluationMap(result.results);
          for (const expression of expressions) {
            values.push(parseChannelValue(channel.type, requireEvaluation(byExpression, expression).value));
          }
        }
        channels.push({ name: channel.name, unit: channel.unit, type: channel.type, values });
      }
      const after = await this.readStatus(bound);
      const changedFields = changedStatusFields(before, after);
      attempt = { before, after, channels, changedFields };
      if (changedFields.length === 0) break;
    }
    if (!attempt) throw new Error("DLOG read attempt did not execute");
    const order = normalizedOrder(bound.input, attempt.after);
    const orderedChannels = attempt.channels.map(channel => ({
      ...channel,
      values: order.map(index => channel.values[index]!)
    }));
    const consistent = attempt.changedFields.length === 0;
    const sampleRateHz = attempt.after.sampleRateHz;
    const outSha256 = findHash(this.options.sessions.get(bound.input.sessionId)?.lastSnapshot, "out");
    const mapSha256 = findHash(this.options.sessions.get(bound.input.sessionId)?.lastSnapshot, "map");
    return dlogCaptureSchema.parse({
      schemaVersion: DLOG_SCHEMA_VERSION,
      captureId: `dlog-${randomUUID()}`,
      ...identity(bound.descriptor),
      layout: bound.descriptor.layout,
      sampleCount: bound.input.sampleCount,
      exportedSampleCount: order.length,
      sampleRateHz,
      sampleRateSource: bound.input.sampleRateSource,
      sampleTimeBasis: "configured-relative-time",
      channelMetadata: bound.descriptor.channels,
      rawIndices: {
        writeIndex: attempt.after.writeIndex,
        triggerIndex: attempt.after.triggerIndex,
        writeIndexMeaning: bound.input.writeIndexMeaning,
        triggerIndexMeaning: bound.input.triggerIndexMeaning
      },
      normalizedOrder: order,
      consistency: {
        status: consistent ? "CONSISTENT" : "INCONSISTENT",
        attempts,
        before: attempt.before,
        after: attempt.after,
        changedFields: attempt.changedFields
      },
      readDurationMs: Number(process.hrtime.bigint() - startedNs) / 1_000_000,
      firmwareHashes: {
        outSha256,
        mapSha256,
        source: outSha256 || mapSha256 ? "session-snapshot" : "unavailable"
      },
      evidenceClassification: this.adapterType === "mock" ? "MOCK" : "HARDWARE_TARGET",
      captureCompleteness: consistent ? "COMPLETE" : "INCOMPLETE",
      incompleteReason: consistent ? null : `DLOG status changed during all ${bound.input.maxReadRetries + 1} read attempt(s): ${attempt.changedFields.join(", ")}`,
      sampleIndex: order.map((_, index) => index),
      relativeTimeSeconds: order.map((_, index) => index / sampleRateHz),
      channels: orderedChannels
    });
  }

  private async readStatus(bound: BoundRequest): Promise<DlogStatusSnapshot> {
    this.validateIdentity(bound);
    const expressions = [
      bound.input.stateSymbol,
      bound.input.writeIndexSymbol,
      bound.input.triggerIndexSymbol,
      ...(bound.input.generationSymbol ? [bound.input.generationSymbol] : []),
      ...(bound.input.sampleRateSource === "firmware-variable" && bound.input.sampleRateSymbol
        ? [bound.input.sampleRateSymbol]
        : [])
    ];
    const result = await this.evaluate(bound.input, bound.lease, expressions);
    this.assertDescriptorIdentity(bound.descriptor, result);
    const values = evaluationMap(result.results);
    const writeIndex = parseInteger(requireEvaluation(values, bound.input.writeIndexSymbol).value);
    const triggerIndex = parseInteger(requireEvaluation(values, bound.input.triggerIndexSymbol).value);
    if (writeIndex < 0 || writeIndex >= bound.input.sampleCount ||
        triggerIndex < 0 || triggerIndex >= bound.input.sampleCount) {
      throw new DebugMcpError("DlogIndexOutOfRange", "DLOG indices are outside the configured ring buffer", {
        sampleCount: bound.input.sampleCount,
        writeIndex,
        triggerIndex
      });
    }
    const sampleRateHz = bound.input.sampleRateSource === "firmware-variable"
      ? parseFinite(requireEvaluation(values, bound.input.sampleRateSymbol!).value)
      : bound.input.sampleRateHz;
    return dlogStatusSnapshotSchema.parse({
      state: scalar(requireEvaluation(values, bound.input.stateSymbol).value),
      writeIndex,
      triggerIndex,
      generation: bound.input.generationSymbol
        ? scalar(requireEvaluation(values, bound.input.generationSymbol).value)
        : null,
      sampleRateHz,
      timestamp: new Date().toISOString(),
      monotonicTimestampNs: process.hrtime.bigint().toString()
    });
  }

  private validateIdentity(bound: BoundRequest): void {
    const session = this.options.sessions.get(bound.input.sessionId);
    if (!session || session.closedAt || session.status === "CLOSED" ||
        session.boardId !== bound.input.boardId ||
        (session.adapterSessionId && session.adapterSessionId !== bound.descriptor.adapterSessionId)) {
      throw new DebugMcpError("SessionInvalidated", "DLOG session identity changed during the read", {
        sessionId: bound.input.sessionId
      });
    }
    const worker = this.options.workers.currentWorker(bound.input.boardId);
    if (!worker ||
        worker.workerInstanceId !== bound.descriptor.workerInstanceId ||
        worker.workerGeneration !== bound.descriptor.workerGeneration) {
      throw new DebugMcpError("WorkerGenerationChanged", "DLOG worker generation changed during the read", {
        expectedWorkerInstanceId: bound.descriptor.workerInstanceId,
        expectedWorkerGeneration: bound.descriptor.workerGeneration,
        actual: worker
      });
    }
    const currentLease = this.options.leaseContext(bound.input.sessionId, bound.input.boardId, DLOG_BATCH_TIMEOUT_MS + 30_000);
    if (currentLease.leaseId !== bound.lease.leaseId ||
        currentLease.leaseGeneration !== bound.lease.leaseGeneration ||
        currentLease.fencingToken !== bound.lease.fencingToken ||
        currentLease.workerInstanceId !== bound.lease.workerInstanceId) {
      throw new DebugMcpError("LeaseGenerationChanged", "DLOG lease fencing identity changed during the read", {
        boardId: bound.input.boardId,
        sessionId: bound.input.sessionId
      });
    }
  }

  private async evaluate(
    input: DlogBufferRequest,
    lease: BoardLeaseContext,
    expressions: string[]
  ): Promise<Record<string, unknown>> {
    return this.invoke(input, lease, DLOG_EXPRESSION_BATCH_TOOL, {
      sessionId: input.sessionId,
      coreId: input.coreId,
      expressions,
      timeoutMs: DLOG_BATCH_TIMEOUT_MS
    });
  }

  private invoke(
    input: Pick<DlogBufferRequest, "boardId">,
    lease: BoardLeaseContext,
    toolName: string,
    toolInput: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return this.options.workers.invokeBoardLowPriority(input.boardId, toolName, {
      ...toolInput,
      __leaseContext: lease
    }, DLOG_BATCH_TIMEOUT_MS + 1000);
  }

  private assertIdentity(
    input: DlogBufferRequest,
    adapterSessionId: unknown,
    coreName: string,
    workerInstanceId: string,
    result: Record<string, unknown>
  ): void {
    if (result.sessionId !== input.sessionId ||
        result.adapterSessionId !== adapterSessionId ||
        result.coreId !== input.coreId ||
        result.coreName !== coreName ||
        result.workerInstanceId !== workerInstanceId) {
      throw new DebugMcpError("CoreIdentityMismatch", "DLOG response identity does not match the explicit board/session/core route", {
        expected: { sessionId: input.sessionId, adapterSessionId, coreId: input.coreId, coreName, workerInstanceId },
        received: result
      });
    }
  }

  private assertDescriptorIdentity(descriptor: DlogDescriptor, result: Record<string, unknown>): void {
    this.assertIdentity({
      boardId: descriptor.boardId,
      sessionId: descriptor.sessionId,
      coreId: descriptor.coreId
    } as DlogBufferRequest, descriptor.adapterSessionId, descriptor.coreName, descriptor.workerInstanceId, result);
  }

  private async writeArtifacts(directory: string, bound: BoundRequest, capture: DlogCapture): Promise<void> {
    const csv = renderCsv(capture);
    const json = `${JSON.stringify(capture, null, 2)}\n`;
    const totalBytes = Buffer.byteLength(csv) + Buffer.byteLength(json);
    if (totalBytes > bound.input.maxArtifactBytes) {
      throw new DebugMcpError("DlogArtifactSizeLimit", "Serialized DLOG CSV and JSON exceed the artifact size limit", {
        totalBytes,
        maxArtifactBytes: bound.input.maxArtifactBytes
      });
    }
    const { manifest, result, events } = this.artifactSnapshot(bound, capture);
    artifactManifestSchema.parse(manifest);
    artifactResultSchema.parse(result);
    events.forEach(event => artifactEventSchema.parse(event));
    await this.writer.ensureDirectory(path.join(directory, "attachments"));
    await this.writer.writeText(path.join(directory, "dlog.csv"), csv);
    await this.writer.writeText(path.join(directory, "dlog.json"), json);
    await this.writer.writeJson(path.join(directory, "result.json"), result);
    await this.writer.writeJsonLines(path.join(directory, "events.jsonl"), events);
    await this.writer.writeText(path.join(directory, "summary.md"), renderSummary(capture));
    await this.writer.writeJson(path.join(directory, "manifest.json"), manifest);
  }

  private artifactSnapshot(bound: BoundRequest, capture: DlogCapture): {
    manifest: ArtifactManifest;
    result: ArtifactResult;
    events: ArtifactEvent[];
  } {
    const board = this.options.boards.require(bound.input.boardId);
    const complete = capture.captureCompleteness === "COMPLETE";
    const startedAt = capture.consistency.before.timestamp;
    const endedAt = capture.consistency.after.timestamp;
    const evidence = capture.evidenceClassification;
    const manifest: ArtifactManifest = {
      schemaVersion: ARTIFACT_SCHEMA_VERSION,
      jobId: capture.captureId,
      jobType: "dlog-readonly-export",
      targets: [{
        boardId: board.boardId,
        boardProfile: { device: board.device, tags: [...board.tags].sort() },
        xds110Serial: board.probeSerial,
        adapterType: this.adapterType,
        workerGeneration: capture.workerGeneration,
        adapterSessionId: capture.adapterSessionId,
        sessionId: capture.sessionId,
        cores: [{ coreId: capture.coreId, coreName: capture.coreName }],
        programs: []
      }],
      mcpVersion: SERVER_VERSION,
      nodeVersion: process.version,
      operatingSystem: { platform: os.platform(), release: os.release(), architecture: os.arch() },
      ccsVersion: null,
      configSummary: {
        dlogSchemaVersion: DLOG_SCHEMA_VERSION,
        layout: capture.layout,
        sampleCount: capture.sampleCount,
        exportedSampleCount: capture.exportedSampleCount,
        sampleRateHz: capture.sampleRateHz,
        sampleRateSource: capture.sampleRateSource,
        channelCount: capture.channels.length,
        targetAddressUnitBits: 16,
        readOnly: true
      },
      startedAt,
      endedAt,
      evidenceLevel: evidence,
      completeness: { status: complete ? "COMPLETE" : "INCOMPLETE", reason: capture.incompleteReason }
    };
    const result: ArtifactResult = {
      schemaVersion: ARTIFACT_SCHEMA_VERSION,
      jobId: capture.captureId,
      overallStatus: complete ? "COMPLETED" : "INCONSISTENT",
      errorCode: complete ? null : "DlogSnapshotInconsistent",
      failedStep: null,
      assertions: [{
        name: "dlog-snapshot-consistency",
        status: complete ? "PASSED" : "FAILED",
        message: complete ? "DLOG state and indices were stable across the read." : capture.incompleteReason ?? undefined
      }],
      evidenceClassification: evidence,
      cancelled: false,
      timedOut: false,
      incompleteReason: capture.incompleteReason
    };
    const base = {
      schemaVersion: ARTIFACT_SCHEMA_VERSION,
      jobId: capture.captureId,
      source: { type: "daemon", id: "dlog-readonly-export" },
      boardId: capture.boardId,
      workerGeneration: capture.workerGeneration,
      adapterSessionId: capture.adapterSessionId,
      sessionId: capture.sessionId,
      coreId: capture.coreId,
      coreName: capture.coreName
    } as const;
    const events: ArtifactEvent[] = [{
      ...base,
      sequence: 1,
      eventType: "DLOG_READ_STARTED",
      timestamp: startedAt,
      monotonicTimestampNs: capture.consistency.before.monotonicTimestampNs,
      payload: { descriptor: bound.descriptor }
    }, {
      ...base,
      sequence: 2,
      eventType: complete ? "DLOG_READ_COMPLETED" : "DLOG_READ_INCONSISTENT",
      timestamp: endedAt,
      monotonicTimestampNs: capture.consistency.after.monotonicTimestampNs,
      payload: { consistency: capture.consistency, captureCompleteness: capture.captureCompleteness }
    }];
    return { manifest, result, events };
  }

  private captureDirectory(captureId: string): string {
    if (!/^[A-Za-z0-9._-]+$/.test(captureId)) throw new Error("Unsafe DLOG capture id");
    return path.join(path.resolve(this.options.rootDirectory), captureId);
  }

  private get adapterType(): "mock" | "ccs" {
    const configured = this.options.config.adapter === "auto"
      ? this.options.config.ccs.scriptingMode
      : this.options.config.adapter;
    return configured === "mock" ? "mock" : "ccs";
  }
}

function elementWidth(type: DlogBufferRequest["channels"][number]["type"]) {
  return type.endsWith("16")
    ? { elementWidthBits: 16 as const, elementWidthOctets: 2 as const, addressUnitsPerElement: 1 as const, addressUnitBits: 16 as const }
    : { elementWidthBits: 32 as const, elementWidthOctets: 4 as const, addressUnitsPerElement: 2 as const, addressUnitBits: 16 as const };
}

function validateRequestRelationships(input: DlogBufferRequest): void {
  if ((input.preTriggerSamples === undefined) !== (input.postTriggerSamples === undefined)) {
    throw new DebugMcpError("DlogIndexOutOfRange", "preTriggerSamples and postTriggerSamples must be supplied together");
  }
  if (input.preTriggerSamples !== undefined &&
      input.postTriggerSamples !== undefined &&
      input.preTriggerSamples + input.postTriggerSamples + 1 > input.sampleCount) {
    throw new DebugMcpError("DlogIndexOutOfRange", "Pre-trigger, trigger, and post-trigger window exceeds sampleCount", {
      sampleCount: input.sampleCount,
      preTriggerSamples: input.preTriggerSamples,
      postTriggerSamples: input.postTriggerSamples
    });
  }
  if (input.sampleRateSource === "firmware-variable" && !input.sampleRateSymbol) {
    throw new DebugMcpError("DlogSymbolReadFailed", "sampleRateSymbol is required for firmware-variable sample rate");
  }
  const names = new Set<string>();
  for (const channel of input.channels) {
    if (names.has(channel.name)) {
      throw new DebugMcpError("DlogSymbolReadFailed", "DLOG channel names must be unique", { channelName: channel.name });
    }
    names.add(channel.name);
  }
}

function normalizedOrder(input: DlogBufferRequest, status: DlogStatusSnapshot): number[] {
  if (input.preTriggerSamples !== undefined && input.postTriggerSamples !== undefined) {
    const start = modulo(status.triggerIndex - input.preTriggerSamples, input.sampleCount);
    const length = input.preTriggerSamples + 1 + input.postTriggerSamples;
    return Array.from({ length }, (_, index) => modulo(start + index, input.sampleCount));
  }
  return Array.from({ length: input.sampleCount }, (_, index) => modulo(status.writeIndex + index, input.sampleCount));
}

function changedStatusFields(before: DlogStatusSnapshot, after: DlogStatusSnapshot): ReadAttempt["changedFields"] {
  return (["state", "writeIndex", "triggerIndex", "generation", "sampleRateHz"] as const)
    .filter(field => before[field] !== after[field]);
}

function renderCsv(capture: DlogCapture): string {
  const header = ["sampleIndex", "relativeTimeSeconds", ...capture.channels.map(channel => channel.name)].join(",");
  const lines = capture.sampleIndex.map((sampleIndex, index) => [
    sampleIndex,
    capture.relativeTimeSeconds[index]!.toPrecision(17),
    ...capture.channels.map(channel => channel.values[index]!)
  ].join(","));
  return `${header}\n${lines.join("\n")}\n`;
}

function renderSummary(capture: DlogCapture): string {
  return `# DLOG evidence summary

- Capture: ${capture.captureId}
- Board/session/core: ${capture.boardId} / ${capture.sessionId} / ${capture.coreName} (${capture.coreId})
- Layout: ${capture.layout}
- Channels: ${capture.channels.length}
- Exported samples: ${capture.exportedSampleCount}
- Sample rate: ${capture.sampleRateHz} Hz (${capture.sampleRateSource})
- Consistency: ${capture.consistency.status}
- Attempts: ${capture.consistency.attempts}
- Evidence: ${capture.evidenceClassification}
- Completeness: ${capture.captureCompleteness}

Relative time is calculated from the declared sample rate. It is not a target-side timestamp.
`;
}

function evaluationMap(value: unknown): Map<string, Record<string, unknown>> {
  return new Map(arrayRecords(value).map(item => [String(item.expression), item]));
}

function requireEvaluation(
  values: Map<string, Record<string, unknown>>,
  expression: string
): Record<string, unknown> {
  const value = values.get(expression);
  if (!value || value.success !== true) {
    throw new DebugMcpError("DlogSymbolReadFailed", "DLOG symbol expression failed", {
      expression,
      error: value?.error
    });
  }
  return value;
}

function parseAddress(value: unknown): string {
  const match = String(value ?? "").match(/0x[0-9a-f]+/i);
  if (!match) throw new DebugMcpError("DlogAddressInvalid", "DLOG symbol address is missing or invalid", { value });
  return match[0].toLowerCase();
}

function parseInteger(value: unknown): number {
  const raw = String(value ?? "").trim();
  if (!/^(?:[-+]?\d+|0x[0-9a-f]+)$/i.test(raw)) {
    throw new DebugMcpError("DlogIntegerInvalid", "DLOG expression is not an integer", { value });
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) {
    throw new DebugMcpError("DlogIntegerUnsafe", "DLOG integer exceeds the host safe range", { value });
  }
  return parsed;
}

function parseFinite(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new DebugMcpError("DlogNumberInvalid", "DLOG expression is not a positive finite number", { value });
  }
  return parsed;
}

function parseChannelValue(type: DlogBufferRequest["channels"][number]["type"], value: unknown): number {
  if (type === "float32") {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new DebugMcpError("DlogFloatInvalid", "DLOG channel returned a non-finite float", { value });
    return parsed;
  }
  const parsed = parseInteger(value);
  if (type === "uint16" && (parsed < 0 || parsed > 0xffff)) throw rangeError(type, value);
  if (type === "int16" && (parsed < -0x8000 || parsed > 0x7fff)) throw rangeError(type, value);
  if (type === "uint32" && (parsed < 0 || parsed > 0xffff_ffff)) throw rangeError(type, value);
  if (type === "int32" && (parsed < -0x8000_0000 || parsed > 0x7fff_ffff)) throw rangeError(type, value);
  return parsed;
}

function rangeError(type: string, value: unknown): DebugMcpError {
  return new DebugMcpError("DlogValueOutOfRange", "DLOG channel value is outside its configured integer type", { type, value });
}

function scalar(value: unknown): string | number {
  const raw = String(value ?? "").trim();
  if (/^(?:[-+]?\d+|0x[0-9a-f]+)$/i.test(raw)) return Number(raw);
  if (!raw) throw new DebugMcpError("DlogStateInvalid", "DLOG state expression returned no value", { value });
  return raw;
}

function modulo(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

function identity(descriptor: DlogDescriptor) {
  return {
    boardId: descriptor.boardId,
    sessionId: descriptor.sessionId,
    adapterSessionId: descriptor.adapterSessionId,
    workerInstanceId: descriptor.workerInstanceId,
    workerGeneration: descriptor.workerGeneration,
    coreId: descriptor.coreId,
    coreName: descriptor.coreName
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function arrayRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(record) : [];
}

function findHash(value: unknown, kind: "out" | "map"): string | null {
  const seen = new Set<unknown>();
  const visit = (candidate: unknown): string | null => {
    if (!candidate || typeof candidate !== "object" || seen.has(candidate)) return null;
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        const result = visit(item);
        if (result) return result;
      }
      return null;
    }
    for (const [key, item] of Object.entries(candidate as Record<string, unknown>)) {
      const normalized = key.toLowerCase();
      if (typeof item === "string" &&
          /^[a-f0-9]{64}$/.test(item) &&
          (normalized.includes(kind) || (kind === "out" && normalized === "sha256"))) {
        return item;
      }
      const result = visit(item);
      if (result) return result;
    }
    return null;
  };
  return visit(value);
}
