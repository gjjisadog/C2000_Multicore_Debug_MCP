import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BoardLeaseContext } from "../boards/types.js";
import type { BoardWorkerSupervisor } from "../boards/BoardWorkerSupervisor.js";
import type { C2000McpConfig } from "../config/config.schema.js";
import type { BoardRepository } from "../storage/repositories/BoardRepository.js";
import type { SessionRepository } from "../storage/repositories/SessionRepository.js";
import {
  type EradProfileRecord,
  type EradProfileStatus,
  EradProfileRepository
} from "../storage/repositories/EradProfileRepository.js";
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
import { SERVER_VERSION } from "../runtimeInfo.js";
import { DebugMcpError, toStructuredError } from "../utils/errors.js";
import { parseMapSymbols } from "../hardware/mapSymbols.js";
import {
  ERAD_INTERNAL_TOOL,
  ERAD_SCHEMA_VERSION,
  configureEradProfileSchema,
  eradCapabilitiesSchema,
  eradProfileIdentitySchema,
  eradProfileResultSchema,
  exportEradProfileSchema,
  getEradCapabilitiesSchema,
  readEradProfileSchema,
  startEradProfileSchema,
  stopEradProfileSchema,
  type EradConfigureRequest,
  type EradProfileResult
} from "./EradSchemas.js";

const COMMAND_TIMEOUT_MS = 10_000;

export class EradService {
  private readonly writer: AtomicArtifactWriter;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly abortControllers = new Map<string, AbortController>();
  private readonly finalizing = new Map<string, Promise<EradProfileRecord>>();

  constructor(private readonly options: {
    rootDirectory: string;
    config: C2000McpConfig;
    profiles: EradProfileRepository;
    boards: BoardRepository;
    sessions: SessionRepository;
    workers: BoardWorkerSupervisor;
    leaseContext: (sessionId: string, boardId: string, ttlMs: number) => BoardLeaseContext;
    writer?: AtomicArtifactWriter;
  }) {
    this.writer = options.writer ?? new AtomicArtifactWriter();
    options.profiles.markInterruptedOnStartup();
  }

  async capabilities(value: unknown): Promise<Record<string, unknown>> {
    const input = getEradCapabilitiesSchema.parse(value);
    const bound = await this.bindIdentity(input);
    const response = await this.invoke(bound, "capabilities", {}, true);
    const capabilities = eradCapabilitiesSchema.parse(response.capabilities);
    return { success: true, capabilities, ...identity(bound) };
  }

  async configure(value: unknown): Promise<Record<string, unknown>> {
    const input = configureEradProfileSchema.parse(value);
    validateConfigureRelationships(input);
    if (this.options.profiles.activeForBoard(input.boardId)) {
      throw new DebugMcpError("EradProfileAlreadyActive", "First-version ERAD profiling permits one configured/running profile per board", {
        boardId: input.boardId
      });
    }
    const bound = await this.bindIdentity(input);
    const capabilitiesResponse = await this.invoke(bound, "capabilities", {}, true);
    const capabilities = eradCapabilitiesSchema.parse(capabilitiesResponse.capabilities);
    if (!capabilities.supported) {
      throw new DebugMcpError("EradDeviceUnsupported", capabilities.reason ?? "ERAD profiling is unsupported", {
        device: bound.device,
        capabilities
      });
    }
    const sessionSnapshot = this.options.sessions.get(input.sessionId)?.lastSnapshot;
    let startAddress: number;
    let endAddress: number;
    let symbolSource: "debug-symbols" | "linker-map" = "debug-symbols";
    try {
      const resolved = await this.invoke(bound, "resolve", {
        startSymbol: input.startSymbol,
        endSymbol: input.endSymbol
      }, true);
      startAddress = requireAddress(resolved.startAddress, input.startSymbol);
      endAddress = requireAddress(resolved.endAddress, input.endSymbol);
    } catch (error) {
      const fallback = await resolveSymbolsFromPersistedMap(
        sessionSnapshot,
        input.coreId,
        input.startSymbol,
        input.endSymbol
      );
      if (!fallback) throw error;
      startAddress = fallback.startAddress;
      endAddress = fallback.endAddress;
      symbolSource = "linker-map";
    }
    const hashes = await firmwareHashes(sessionSnapshot, input.coreId);
    const profileId = `erad-${randomUUID()}`;
    const configured = await this.invoke(bound, "configure", {
      profileId,
      startAddress,
      endAddress,
      ...(input.resources ? { resources: input.resources } : {}),
      allowOverwrite: input.allowOverwrite
    });
    const resources = configured.resources as EradProfileRecord["resources"];
    const now = new Date().toISOString();
    const record: EradProfileRecord = {
      profileId,
      ...identity(bound),
      leaseId: bound.lease.leaseId,
      leaseGeneration: bound.lease.leaseGeneration,
      fencingToken: bound.lease.fencingToken,
      device: bound.device,
      config: {
        schemaVersion: ERAD_SCHEMA_VERSION,
        profileName: input.profileName,
        startSymbol: input.startSymbol,
        startAddress: toHex(startAddress),
        endSymbol: input.endSymbol,
        endAddress: toHex(endAddress),
        symbolSource,
        mode: input.mode,
        durationMs: input.durationMs,
        timeoutMs: input.timeoutMs ?? null,
        allowOverwrite: input.allowOverwrite,
        sysclkHz: input.sysclkHz ?? null,
        sysclkSource: input.sysclkSource,
        firmwareHashes: hashes
      },
      resources,
      savedConfiguration: recordValue(configured.savedConfiguration),
      status: "CONFIGURED",
      configuredAt: now,
      artifactDirectory: path.join(this.options.rootDirectory, profileId),
      artifactStatus: "PENDING"
    };
    this.options.profiles.create(record);
    return {
      success: true,
      profileId,
      profile: publicRecord(record),
      capabilities,
      overwritten: configured.overwritten === true,
      ...identity(bound)
    };
  }

  async start(value: unknown): Promise<Record<string, unknown>> {
    const input = startEradProfileSchema.parse(value);
    const record = this.requireBoundRecord(input);
    if (record.status === "RUNNING") return { success: true, idempotent: true, profile: publicRecord(record), ...identity(record) };
    if (record.status !== "CONFIGURED") {
      throw new DebugMcpError("EradProfileStateInvalid", "Only a CONFIGURED ERAD profile can be started", {
        profileId: record.profileId,
        status: record.status
      });
    }
    const bound = this.validateLive(record);
    await this.invoke(bound, "start", { profileId: record.profileId, resources: record.resources });
    record.status = "RUNNING";
    record.startedAt = new Date().toISOString();
    this.options.profiles.update(record);
    const durationMs = Number(record.config.durationMs);
    const timeoutMs = nullablePositiveInteger(record.config.timeoutMs);
    const deadlineMs = timeoutMs ? Math.min(durationMs, timeoutMs) : durationMs;
    const deadlineStatus: EradProfileStatus = timeoutMs !== null && timeoutMs < durationMs ? "TIMED_OUT" : "COMPLETED";
    const deadlineReason = deadlineStatus === "TIMED_OUT" ? "PROFILE_TIMEOUT" : "DURATION_ELAPSED";
    const abort = new AbortController();
    const timer = setTimeout(() => {
      this.timers.delete(record.profileId);
      this.abortControllers.delete(record.profileId);
      void this.finalize(record.profileId, deadlineStatus, deadlineReason).catch(() => undefined);
    }, deadlineMs);
    abort.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
    timer.unref?.();
    this.timers.set(record.profileId, timer);
    this.abortControllers.set(record.profileId, abort);
    return { success: true, profile: publicRecord(record), ...identity(record) };
  }

  async stop(value: unknown): Promise<Record<string, unknown>> {
    const input = stopEradProfileSchema.parse(value);
    const existing = this.requireBoundRecord(input);
    if (isTerminal(existing.status)) {
      return { success: true, idempotent: true, profile: publicRecord(existing), ...identity(existing) };
    }
    const status: EradProfileStatus = input.disposition === "cancel" ? "CANCELLED" : "STOPPED";
    const record = await this.finalize(input.profileId, status, input.disposition === "cancel" ? "USER_CANCELLED" : "USER_STOPPED");
    return { success: record.status !== "FAILED", profile: publicRecord(record), ...identity(record) };
  }

  async read(value: unknown): Promise<Record<string, unknown>> {
    const input = readEradProfileSchema.parse(value);
    const record = this.requireBoundRecord(input);
    return { success: record.status !== "FAILED", profile: publicRecord(record), ...identity(record) };
  }

  async export(value: unknown): Promise<Record<string, unknown>> {
    const input = exportEradProfileSchema.parse(value);
    const record = this.requireBoundRecord(input);
    if (!isTerminal(record.status)) {
      throw new DebugMcpError("EradProfileStillActive", "Stop or wait for the ERAD profile before exporting", {
        profileId: record.profileId,
        status: record.status
      });
    }
    try {
      await this.writeArtifacts(record);
      record.artifactStatus = "EXPORTED";
      delete record.artifactError;
      this.options.profiles.update(record);
      return {
        success: true,
        profileId: record.profileId,
        artifactDirectory: record.artifactDirectory,
        artifactStatus: record.artifactStatus,
        ...identity(record)
      };
    } catch (error) {
      record.artifactStatus = "FAILED";
      record.artifactError = { ...toStructuredError(error) };
      this.options.profiles.update(record);
      return {
        success: false,
        profileId: record.profileId,
        artifactDirectory: record.artifactDirectory,
        artifactStatus: record.artifactStatus,
        originalProfileStatus: record.status,
        error: toStructuredError(error),
        ...identity(record)
      };
    }
  }

  async preemptBoard(boardId: string, toolName: string): Promise<void> {
    if (toolName === ERAD_INTERNAL_TOOL || toolName.startsWith("c2000_") && toolName.includes("Erad")) return;
    const record = this.options.profiles.activeForBoard(boardId);
    if (!record) return;
    await this.finalize(record.profileId, "CANCELLED", `PREEMPTED_BY:${toolName}`).catch(() => undefined);
  }

  async invalidateSession(sessionId: string, reason: string): Promise<void> {
    const sessions = this.options.sessions.get(sessionId);
    if (!sessions) return;
    const record = this.options.profiles.activeForBoard(sessions.boardId);
    if (record?.sessionId === sessionId) {
      await this.finalize(record.profileId, "CANCELLED", `SESSION_INVALIDATED:${reason}`).catch(() => undefined);
    }
  }

  async stopAll(): Promise<void> {
    const tasks = this.options.boards.list().map(async board => {
      const record = this.options.profiles.activeForBoard(board.boardId);
      if (record) await this.finalize(record.profileId, "CANCELLED", "DAEMON_SHUTDOWN");
    });
    await Promise.allSettled(tasks);
  }

  private async finalize(profileId: string, status: EradProfileStatus, reason: string): Promise<EradProfileRecord> {
    const existing = this.finalizing.get(profileId);
    if (existing) return existing;
    const task = this.finalizeOnce(profileId, status, reason).finally(() => this.finalizing.delete(profileId));
    this.finalizing.set(profileId, task);
    return task;
  }

  private async finalizeOnce(profileId: string, status: EradProfileStatus, reason: string): Promise<EradProfileRecord> {
    const record = requireRecord(this.options.profiles.get(profileId), profileId);
    const timer = this.timers.get(profileId);
    if (timer) clearTimeout(timer);
    this.timers.delete(profileId);
    this.abortControllers.get(profileId)?.abort();
    this.abortControllers.delete(profileId);
    if (isTerminal(record.status)) return record;
    const endedAt = new Date().toISOString();
    try {
      const bound = this.validateLive(record);
      const response = await this.invoke(bound, "stop-read-restore", {
        profileId: record.profileId,
        resources: record.resources,
        savedConfiguration: record.savedConfiguration
      }, true);
      const raw = recordValue(response.raw);
      const overflowResources = Array.isArray(raw.overflowResources)
        ? raw.overflowResources.map(String)
        : [];
      const overflowCount = overflowResources.length;
      const count = safeCounter(raw.count);
      const totalCycles = safeCounter(raw.totalCycles);
      const maxCycles = safeCounter(raw.maxCycles);
      const exact = overflowCount === 0;
      const sysclkHz = nullablePositiveInteger(record.config.sysclkHz);
      const observationDurationMs = record.startedAt
        ? Math.max(0, Date.parse(endedAt) - Date.parse(record.startedAt))
        : 0;
      const result = eradProfileResultSchema.parse({
        schemaVersion: ERAD_SCHEMA_VERSION,
        profileId: record.profileId,
        ...identity(record),
        device: record.device,
        profileName: String(record.config.profileName),
        mode: record.config.mode,
        resources: record.resources,
        startSymbol: String(record.config.startSymbol),
        startAddress: String(record.config.startAddress),
        endSymbol: String(record.config.endSymbol),
        endAddress: String(record.config.endAddress),
        sysclkHz,
        sysclkSource: record.config.sysclkSource,
        count: exact ? count : null,
        totalCycles: exact ? totalCycles : null,
        minCycles: null,
        minCyclesSource: "unavailable-on-f28p65x-erad",
        maxCycles: exact ? maxCycles : null,
        meanCycles: exact && count > 0 ? totalCycles / count : null,
        minSeconds: null,
        maxSeconds: exact && sysclkHz ? maxCycles / sysclkHz : null,
        meanSeconds: exact && sysclkHz && count > 0 ? (totalCycles / count) / sysclkHz : null,
        overflowCount,
        overflowResources,
        observationDurationMs,
        completeness: exact ? "COMPLETE" : "INCOMPLETE",
        incompleteReason: exact ? null : `ERAD counter overflow: ${overflowResources.join(", ")}`,
        restoreStatus: response.restoreStatus,
        firmwareHashes: record.config.firmwareHashes,
        evidenceClassification: this.isMock ? "MOCK" : "HARDWARE_TARGET"
      });
      record.status = status;
      record.endedAt = endedAt;
      record.stopReason = reason;
      record.result = result;
      this.options.profiles.update(record);
      return record;
    } catch (error) {
      const structured = toStructuredError(error);
      const code = structured.code;
      record.status = [
        "WorkerGenerationChanged",
        "LeaseGenerationChanged",
        "LeaseExpired",
        "LeaseInvalidated",
        "LeaseFencingRejected",
        "SessionInvalidated"
      ].includes(code)
        ? "INVALIDATED"
        : "FAILED";
      record.endedAt = endedAt;
      record.stopReason = reason;
      record.error = { ...structured };
      this.options.profiles.update(record);
      return record;
    }
  }

  private async bindIdentity(input: { boardId: string; sessionId: string; coreId: number }): Promise<BoundIdentity> {
    const session = this.options.sessions.get(input.sessionId);
    if (!session || session.closedAt || session.status === "CLOSED" || session.boardId !== input.boardId) {
      throw new DebugMcpError("SessionNotFound", "ERAD requires an open session bound to the requested board", input);
    }
    const board = this.options.boards.require(input.boardId);
    const lease = this.options.leaseContext(input.sessionId, input.boardId, COMMAND_TIMEOUT_MS + 30_000);
    const worker = this.options.workers.currentWorker(input.boardId);
    if (!worker || worker.workerInstanceId !== lease.workerInstanceId) {
      throw new DebugMcpError("LeaseWorkerMismatch", "ERAD lease does not bind the current worker generation", {
        boardId: input.boardId,
        worker,
        leaseWorkerInstanceId: lease.workerInstanceId
      });
    }
    const topology = await this.options.workers.invokeBoardLowPriority(input.boardId, "c2000_getSessionTopology", {
      sessionId: input.sessionId,
      __leaseContext: lease
    }, COMMAND_TIMEOUT_MS);
    const core = arrayRecords(topology.cores).find(candidate => candidate.coreId === input.coreId);
    if (!core || typeof core.coreName !== "string" || typeof topology.adapterSessionId !== "string") {
      throw new DebugMcpError("CoreIdentityMismatch", "ERAD core is absent from the explicit DebugSession topology", {
        sessionId: input.sessionId,
        coreId: input.coreId,
        cores: topology.cores
      });
    }
    return {
      boardId: input.boardId,
      sessionId: input.sessionId,
      adapterSessionId: topology.adapterSessionId,
      coreId: input.coreId,
      coreName: core.coreName,
      workerInstanceId: worker.workerInstanceId,
      workerGeneration: worker.workerGeneration,
      device: board.device,
      lease
    };
  }

  private validateLive(record: EradProfileRecord): BoundIdentity {
    const session = this.options.sessions.get(record.sessionId);
    if (!session || session.closedAt || session.status === "CLOSED" || session.boardId !== record.boardId ||
        session.adapterSessionId !== record.adapterSessionId) {
      throw new DebugMcpError("SessionInvalidated", "ERAD session identity changed", { profileId: record.profileId });
    }
    const worker = this.options.workers.currentWorker(record.boardId);
    if (!worker || worker.workerInstanceId !== record.workerInstanceId ||
        worker.workerGeneration !== record.workerGeneration) {
      throw new DebugMcpError("WorkerGenerationChanged", "ERAD worker generation changed", {
        expectedWorkerInstanceId: record.workerInstanceId,
        expectedWorkerGeneration: record.workerGeneration,
        actual: worker
      });
    }
    const lease = this.options.leaseContext(record.sessionId, record.boardId, COMMAND_TIMEOUT_MS + 30_000);
    if (lease.leaseId !== record.leaseId || lease.leaseGeneration !== record.leaseGeneration ||
        lease.fencingToken !== record.fencingToken || lease.workerInstanceId !== record.workerInstanceId) {
      throw new DebugMcpError("LeaseGenerationChanged", "ERAD fencing lease changed", { profileId: record.profileId });
    }
    return { ...identity(record), device: record.device, lease };
  }

  private requireBoundRecord(input: { profileId: string; boardId: string; sessionId: string; coreId: number }): EradProfileRecord {
    eradProfileIdentitySchema.parse(input);
    const record = requireRecord(this.options.profiles.get(input.profileId), input.profileId);
    if (record.boardId !== input.boardId || record.sessionId !== input.sessionId || record.coreId !== input.coreId) {
      throw new DebugMcpError("EradProfileIdentityMismatch", "ERAD profile identity does not match board/session/core", {
        expected: identity(record),
        received: input
      });
    }
    return record;
  }

  private async invoke(
    bound: BoundIdentity,
    operation: string,
    body: Record<string, unknown>,
    lowPriority = false
  ): Promise<Record<string, unknown>> {
    const input = {
      operation,
      sessionId: bound.sessionId,
      coreId: bound.coreId,
      device: bound.device,
      ...body,
      __leaseContext: bound.lease
    };
    const response = lowPriority
      ? await this.options.workers.invokeBoardLowPriority(bound.boardId, ERAD_INTERNAL_TOOL, input, COMMAND_TIMEOUT_MS)
      : await this.options.workers.invokeBoard(bound.boardId, ERAD_INTERNAL_TOOL, input, COMMAND_TIMEOUT_MS);
    if (response.sessionId !== bound.sessionId || response.adapterSessionId !== bound.adapterSessionId ||
        response.coreId !== bound.coreId || response.coreName !== bound.coreName ||
        response.workerInstanceId !== bound.workerInstanceId) {
      throw new DebugMcpError("CoreIdentityMismatch", "ERAD worker response identity mismatch", {
        expected: identity(bound),
        received: response
      });
    }
    return response;
  }

  private async writeArtifacts(record: EradProfileRecord): Promise<void> {
    const result = record.result;
    const complete = result?.completeness === "COMPLETE" && record.status !== "FAILED" && record.status !== "INVALIDATED";
    const evidence = result?.evidenceClassification ?? (this.isMock ? "MOCK" : "HARDWARE_TARGET");
    const board = this.options.boards.require(record.boardId);
    const manifest: ArtifactManifest = {
      schemaVersion: ARTIFACT_SCHEMA_VERSION,
      jobId: record.profileId,
      jobType: "erad-profile",
      targets: [{
        boardId: record.boardId,
        boardProfile: { device: board.device, tags: board.tags },
        xds110Serial: board.probeSerial,
        adapterType: this.options.config.adapter,
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
        profileName: record.config.profileName,
        mode: record.config.mode,
        symbolSource: record.config.symbolSource,
        durationMs: record.config.durationMs,
        timeoutMs: record.config.timeoutMs,
        resources: record.resources,
        sysclkHz: record.config.sysclkHz,
        sysclkSource: record.config.sysclkSource
      },
      startedAt: record.startedAt ?? record.configuredAt,
      endedAt: record.endedAt ?? record.configuredAt,
      evidenceLevel: evidence,
      completeness: {
        status: complete ? "COMPLETE" : "INCOMPLETE",
        reason: complete ? null : result?.incompleteReason ?? record.stopReason ?? "ERAD result unavailable"
      }
    };
    const machineResult: ArtifactResult = {
      schemaVersion: ARTIFACT_SCHEMA_VERSION,
      jobId: record.profileId,
      overallStatus: record.status,
      errorCode: record.error ? String(record.error.code ?? "EradProfileFailed") : null,
      failedStep: null,
      assertions: [{
        name: "erad-profile-complete",
        status: complete ? "PASSED" : "FAILED",
        message: result?.incompleteReason ?? record.stopReason
      }],
      evidenceClassification: evidence,
      cancelled: record.status === "CANCELLED",
      timedOut: record.status === "TIMED_OUT",
      incompleteReason: complete ? null : result?.incompleteReason ?? record.stopReason ?? "ERAD result unavailable"
    };
    const events = artifactEvents(record);
    artifactManifestSchema.parse(manifest);
    artifactResultSchema.parse(machineResult);
    events.forEach(event => artifactEventSchema.parse(event));
    await this.writer.ensureDirectory(path.join(record.artifactDirectory, "attachments"));
    if (result) await this.writer.writeJson(path.join(record.artifactDirectory, "erad.json"), result);
    await this.writer.writeJson(path.join(record.artifactDirectory, "result.json"), machineResult);
    await this.writer.writeJsonLines(path.join(record.artifactDirectory, "events.jsonl"), events);
    await this.writer.writeText(path.join(record.artifactDirectory, "summary.md"), renderSummary(record));
    await this.writer.writeJson(path.join(record.artifactDirectory, "manifest.json"), manifest);
  }

  private get isMock(): boolean {
    return this.options.config.adapter === "mock" || this.options.config.ccs.scriptingMode === "mock";
  }
}

interface BoundIdentity {
  boardId: string;
  sessionId: string;
  adapterSessionId: string;
  coreId: number;
  coreName: string;
  workerInstanceId: string;
  workerGeneration: number;
  device: string;
  lease: BoardLeaseContext;
}

function publicRecord(record: EradProfileRecord): Record<string, unknown> {
  return {
    profileId: record.profileId,
    ...identity(record),
    device: record.device,
    config: record.config,
    resources: record.resources,
    status: record.status,
    configuredAt: record.configuredAt,
    startedAt: record.startedAt ?? null,
    endedAt: record.endedAt ?? null,
    stopReason: record.stopReason ?? null,
    result: record.result ?? null,
    error: record.error ?? null,
    artifactDirectory: record.artifactDirectory,
    artifactStatus: record.artifactStatus,
    artifactError: record.artifactError ?? null
  };
}

function artifactEvents(record: EradProfileRecord): ArtifactEvent[] {
  const base = {
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    jobId: record.profileId,
    source: { type: "erad-profile", id: record.profileId },
    boardId: record.boardId,
    workerGeneration: record.workerGeneration,
    adapterSessionId: record.adapterSessionId,
    sessionId: record.sessionId,
    coreId: record.coreId,
    coreName: record.coreName
  } as const;
  const events: ArtifactEvent[] = [{
    ...base,
    sequence: 1,
    eventType: "ERAD_CONFIGURED",
    timestamp: record.configuredAt,
    monotonicTimestampNs: "1",
    payload: { resources: record.resources, profileName: record.config.profileName }
  }];
  if (record.startedAt) {
    events.push({
      ...base,
      sequence: events.length + 1,
      eventType: "ERAD_STARTED",
      timestamp: record.startedAt,
      monotonicTimestampNs: "2",
      payload: {}
    });
  }
  if (record.endedAt) {
    const durationNs = record.startedAt
      ? BigInt(Math.max(0, Date.parse(record.endedAt) - Date.parse(record.startedAt))) * 1_000_000n + 3n
      : 3n;
    events.push({
      ...base,
      sequence: events.length + 1,
      eventType: "ERAD_FINISHED",
      timestamp: record.endedAt,
      monotonicTimestampNs: durationNs.toString(),
      payload: { status: record.status, stopReason: record.stopReason, result: record.result ?? null }
    });
  }
  return events;
}

function renderSummary(record: EradProfileRecord): string {
  const result = record.result;
  return [
    `# ERAD profile ${record.profileId}`,
    "",
    `- Status: ${record.status}`,
    `- Board/core: ${record.boardId} / ${record.coreName} (${record.coreId})`,
    `- Device: ${record.device}`,
    `- PC range: ${record.config.startSymbol} (${record.config.startAddress}) → ${record.config.endSymbol} (${record.config.endAddress})`,
    `- Event count: ${result?.count ?? "unavailable"}`,
    `- Mean cycles: ${result?.meanCycles ?? "unavailable"}`,
    `- Maximum cycles: ${result?.maxCycles ?? "unavailable"}`,
    "- Minimum cycles: unavailable on F28P65x ERAD hardware",
    `- Overflow count: ${result?.overflowCount ?? "unavailable"}`,
    `- SYSCLK: ${result?.sysclkHz ?? "unknown"} (${result?.sysclkSource ?? record.config.sysclkSource})`,
    `- Restore status: ${result?.restoreStatus ?? "unknown"}`,
    "",
    "This Markdown file is generated from erad.json and persisted profile state; it is not the sole evidence source.",
    ""
  ].join("\n");
}

async function firmwareHashes(value: unknown, coreId: number): Promise<EradProfileResult["firmwareHashes"]> {
  const program = findProgramInfo(value, coreId);
  const outSha256 = typeof program?.sha256 === "string" && /^[a-f0-9]{64}$/.test(program.sha256)
    ? program.sha256
    : findHash(value, "out");
  let mapSha256 = findHash(value, "map");
  if (!mapSha256 && typeof program?.mapUri === "string") {
    try {
      mapSha256 = createHash("sha256").update(await readFile(program.mapUri)).digest("hex");
    } catch {
      mapSha256 = null;
    }
  }
  return {
    outSha256,
    mapSha256,
    source: outSha256 || mapSha256 ? "session-snapshot" : "unavailable"
  };
}

async function resolveSymbolsFromPersistedMap(
  value: unknown,
  coreId: number,
  startSymbol: string,
  endSymbol: string
): Promise<{ startAddress: number; endAddress: number } | null> {
  const program = findProgramInfo(value, coreId);
  if (typeof program?.mapUri !== "string") return null;
  try {
    const symbols = parseMapSymbols(await readFile(program.mapUri, "utf8"));
    const start = symbols.find(symbol => symbol.name === startSymbol);
    const end = symbols.find(symbol => symbol.name === endSymbol);
    return start && end ? { startAddress: start.address, endAddress: end.address } : null;
  } catch {
    return null;
  }
}

function findProgramInfo(value: unknown, coreId: number): Record<string, unknown> | undefined {
  const seen = new Set<unknown>();
  const visit = (candidate: unknown): Record<string, unknown> | undefined => {
    if (!candidate || typeof candidate !== "object" || seen.has(candidate)) return undefined;
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        const result = visit(item);
        if (result) return result;
      }
      return undefined;
    }
    const record = candidate as Record<string, unknown>;
    if (record.coreId === coreId && typeof record.programUri === "string") return record;
    for (const item of Object.values(record)) {
      const result = visit(item);
      if (result) return result;
    }
    return undefined;
  };
  return visit(value);
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
      if (typeof item === "string" && /^[a-f0-9]{64}$/.test(item) &&
          (key.toLowerCase().includes(kind) || kind === "out" && key.toLowerCase() === "sha256")) return item;
      const result = visit(item);
      if (result) return result;
    }
    return null;
  };
  return visit(value);
}

function identity(value: Pick<BoundIdentity, "boardId" | "sessionId" | "adapterSessionId" | "coreId" | "coreName" | "workerInstanceId" | "workerGeneration">) {
  return {
    boardId: value.boardId,
    sessionId: value.sessionId,
    adapterSessionId: value.adapterSessionId,
    coreId: value.coreId,
    coreName: value.coreName,
    workerInstanceId: value.workerInstanceId,
    workerGeneration: value.workerGeneration
  };
}

function requireRecord(record: EradProfileRecord | undefined, profileId: string): EradProfileRecord {
  if (!record) throw new DebugMcpError("EradProfileNotFound", "ERAD profile was not found", { profileId });
  return record;
}

function isTerminal(status: EradProfileStatus): boolean {
  return !["CONFIGURED", "RUNNING"].includes(status);
}

function requireAddress(value: unknown, symbol: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new DebugMcpError("EradAddressInvalid", "ERAD symbol did not resolve to a safe C28x address", { symbol, value });
  }
  return parsed;
}

function safeCounter(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 0xffff_ffff) {
    throw new DebugMcpError("EradCounterInvalid", "ERAD counter value is invalid", { value });
  }
  return parsed;
}

function nullablePositiveInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function arrayRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(recordValue) : [];
}

function toHex(value: number): string {
  return `0x${value.toString(16)}`;
}

function validateConfigureRelationships(input: EradConfigureRequest): void {
  if (input.allowOverwrite && !input.resources) {
    throw new DebugMcpError("EradOverwriteSelectionRequired", "allowOverwrite requires explicit ERAD resources");
  }
  if (input.sysclkSource === "user-config" && input.sysclkHz === undefined) {
    throw new DebugMcpError("EradSysclkInvalid", "user-config SYSCLK requires sysclkHz");
  }
  if (input.sysclkHz !== undefined && input.sysclkSource === "unknown") {
    throw new DebugMcpError("EradSysclkInvalid", "sysclkHz requires an explicit non-unknown source");
  }
}
