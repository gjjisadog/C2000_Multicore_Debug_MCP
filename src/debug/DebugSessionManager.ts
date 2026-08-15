import { randomUUID } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import type { AdapterSession, DebugAdapter } from "../adapters/types.js";
import type {
  BatchItemResult,
  CoreConfig,
  CoreId,
  CoreInfo,
  CoreSnapshot,
  CreateDebugSessionOptions,
  EvaluateResult,
  ExpressionComparisonRequest,
  ExpressionComparisonResult,
  ExpressionAssignmentResult,
  ExpressionAssignmentBatchItemResult,
  ExpressionAssignmentRequest,
  ExpressionAssignmentValue,
  FaultInjectionBatchItemResult,
  FaultInjectionRequest,
  LoadedProgramInfo,
  LoadProgramRequest,
  RamOwnershipPolicy,
  RamOwnershipPreparation,
  ResetType,
  ResolveResult,
  SessionTopology,
  TargetState
} from "./types.js";
import { defaultF28P65xCoreMap } from "./types.js";
import { CoreSession } from "./CoreSession.js";
import { LoadedProgramRegistry } from "./LoadedProgramRegistry.js";
import { fileMetadata } from "../utils/fileHash.js";
import { DebugMcpError, toStructuredError } from "../utils/errors.js";
import type { Logger } from "../utils/logger.js";
import { noopLogger } from "../utils/logger.js";
import { normalizeProgramUri, normalizeWorkspacePath } from "../utils/pathUtils.js";
import { assertCoreIsolation, CHECKED_PEER_FIELDS, type MulticoreSnapshotLike } from "./isolationAssertions.js";
import { buildRunPauseAcceptanceSummary } from "./runPauseAcceptance.js";
import { flashOwnershipActionsForMap, mapPathForProgram, mergeOwnershipActions, ownershipActionsForMap, parseLinkerMap, type RamOwnershipAction } from "../hardware/mapOwnership.js";
import { resolveDiagnosticsDefaults, type DiagnosticsDefaults } from "./defaultDiagnostics.js";
import { valuesEqual } from "../utils/expressionMatch.js";
import { sleep } from "../utils/async.js";
import { SessionQueue } from "../utils/sessionQueue.js";
import { resolveAddressFromMap } from "../hardware/mapSymbols.js";
import type { DebugProbeCoordinator, DebugProbeLease } from "../hardware/debugProbeCoordinator.js";

interface LogicalDebugSession {
  sessionId: string;
  sessionName: string;
  ccxmlPath?: string;
  adapterSession: AdapterSession;
  cores: Map<CoreId, CoreSession>;
  activity: {
    inFlightCalls: number;
    lastActivityAt: number;
    closing: boolean;
    autoClose?: {
      idleTimeoutMs: number;
      timer?: ReturnType<typeof setTimeout>;
    };
  };
  probeLease?: DebugProbeLease;
}

export interface DebugSessionManagerOptions {
  defaultCcxmlPath?: string;
  defaultCoreMap?: CoreConfig[];
  /** Base directory for relative program/map paths (usually ccs.workspacePath). */
  defaultWorkspacePath?: string;
  diagnostics?: Partial<DiagnosticsDefaults>;
  probeCoordinator?: DebugProbeCoordinator;
  prepareProbe?: (lease?: DebugProbeLease) => Promise<unknown>;
}

const F28P65X_CPU1_CORE_ID = 0;
const F28P65X_CPU2_CORE_ID = 2;
const F28P65X_MEMCFG_GSXMSEL_ADDRESS = 0x0005F444;

export class DebugSessionManager {
  private readonly sessions = new Map<string, LogicalDebugSession>();
  private readonly queue = new SessionQueue();
  private readonly diagnostics: DiagnosticsDefaults;
  private readonly defaultCcxmlPath?: string;
  private readonly defaultCoreMap: CoreConfig[];
  private readonly defaultWorkspacePath?: string;
  private readonly probeCoordinator?: DebugProbeCoordinator;
  private readonly prepareProbe?: (lease?: DebugProbeLease) => Promise<unknown>;

  constructor(
    private readonly adapter: DebugAdapter,
    private readonly loadedPrograms: LoadedProgramRegistry,
    private readonly logger: Logger = noopLogger,
    options: DebugSessionManagerOptions = {}
  ) {
    this.defaultCcxmlPath = options.defaultCcxmlPath;
    this.defaultCoreMap = options.defaultCoreMap ?? defaultF28P65xCoreMap;
    this.defaultWorkspacePath = normalizeWorkspacePath(options.defaultWorkspacePath);
    this.diagnostics = resolveDiagnosticsDefaults(options.diagnostics);
    this.probeCoordinator = options.probeCoordinator;
    this.prepareProbe = options.prepareProbe;
  }

  /** Normalize program/map input consistently for manager and workflow checks. */
  normalizeArtifactUri(uri: string): string {
    return normalizeProgramUri(uri, this.defaultWorkspacePath);
  }

  private exclusive<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    return this.queue.run(sessionId, work);
  }

  async createDebugSession(options: Partial<CreateDebugSessionOptions>): Promise<{ sessionId: string; cores: CoreInfo[]; probeQueue?: Record<string, unknown>; probeRecovery?: unknown }> {
    const sessionName = options.sessionName ?? "c2000-debug-session";
    const coreMap = validateCoreMap(options.coreMap ?? this.defaultCoreMap);
    const ccxmlPath = options.ccxmlPath ?? this.defaultCcxmlPath;
    const probeLease = await this.probeCoordinator?.acquire(sessionName, { probeId: options.probeId, preferredProbeIds: options.preferredProbeIds, allowAutoProbeAllocation: options.allowAutoProbeAllocation });
    let probeRecovery: unknown;
    let adapterSession: AdapterSession;
    try {
      probeRecovery = await this.prepareProbe?.(probeLease);
      adapterSession = await this.adapter.createSession({ sessionName, ccxmlPath: probeLease?.probe?.ccxmlPath ?? ccxmlPath, coreMap });
    } catch (error) {
      await probeLease?.release();
      throw error;
    }
    const sessionId = `dbg-${randomUUID()}`;
    const cores = new Map(coreMap.map(core => [core.coreId, new CoreSession(core)]));
    this.sessions.set(sessionId, {
      sessionId,
      sessionName,
      ccxmlPath,
      adapterSession,
      cores,
      activity: { inFlightCalls: 0, lastActivityAt: Date.now(), closing: false },
      probeLease
    });
    this.logger.info("debug session created", { sessionId, sessionName, ccxmlPath, coreMap });
    try {
      return {
        sessionId,
        cores: await this.listCores(sessionId),
        ...(probeLease ? { probeQueue: { leaseId: probeLease.leaseId, queuePositionAtEntry: probeLease.queuePositionAtEntry, waitedMs: probeLease.waitedMs, ...(probeLease.probe ?? {}) } } : {}),
        ...(probeRecovery !== undefined ? { probeRecovery } : {})
      };
    } catch (error) {
      try { await this.closeDebugSession(sessionId); } catch { /* Preserve the original creation error. */ }
      throw error;
    }
  }

  async listCores(sessionId: string): Promise<CoreInfo[]> {
    return this.exclusive(sessionId, async () => {
      const session = this.requireSession(sessionId);
      const cores: CoreInfo[] = [];
      for (const core of session.cores.values()) {
        try {
          const state = await this.adapter.getState(session.adapterSession, core.coreId);
          core.connected = state.connected;
          core.state = state.state;
          core.pc = state.pc ?? core.pc;
          core.active = state.connected;
          cores.push({
            coreId: core.coreId,
            coreName: core.coreName,
            corePattern: core.corePattern,
            connected: state.connected,
            active: state.connected
          });
        } catch {
          cores.push({
            coreId: core.coreId,
            coreName: core.coreName,
            corePattern: core.corePattern,
            connected: core.connected,
            active: core.active
          });
        }
      }
      return cores;
    });
  }

  async getSessionTopology(sessionId: string): Promise<SessionTopology> {
    const session = this.requireSession(sessionId);
    return {
      sessionId,
      sessionName: session.sessionName,
      ccxmlPath: session.ccxmlPath,
      workspacePath: this.defaultWorkspacePath,
      adapterName: this.adapter.name,
      adapterSessionId: session.adapterSession.adapterSessionId,
      debugSessionRoute: "sessionId -> adapterSessionId -> coreId -> DebugSession",
      cores: Array.from(session.cores.values()).map(core => ({
        coreId: core.coreId,
        coreName: core.coreName,
        corePattern: core.corePattern,
        targetSelector: core.corePattern ?? core.coreName,
        debugSessionKey: `${session.adapterSession.adapterSessionId}:${core.coreId}`
      }))
    };
  }

  async closeDebugSession(sessionId: string) {
    return this.exclusive(sessionId, async () => {
      const startedAtMs = Date.now();
      const session = this.requireSession(sessionId);
      session.activity.closing = true;
      this.cancelIdleAutoClose(session);
      try {
        await this.adapter.disposeSession?.(session.adapterSession);
      } finally {
        await session.probeLease?.release();
        this.sessions.delete(sessionId);
        this.loadedPrograms.deleteSession(sessionId);
        this.queue.clearWhenIdle(sessionId);
        this.logger.info("debug session closed", { sessionId });
      }
      const finishedAtMs = Date.now();
      return {
        sessionId,
        closed: true as const,
        cleanup: {
          startedAt: new Date(startedAtMs).toISOString(),
          finishedAt: new Date(finishedAtMs).toISOString(),
          durationMs: finishedAtMs - startedAtMs,
          adapterDisposed: true
        }
      };
    });
  }

  async withSessionActivity<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const session = this.requireSession(sessionId);
    if (session.activity.closing) {
      throw new DebugMcpError("SessionNotFound", `Debug session ${sessionId} is closing`, { sessionId });
    }
    this.cancelIdleAutoClose(session);
    session.activity.inFlightCalls += 1;
    session.activity.lastActivityAt = Date.now();
    try {
      return await operation();
    } finally {
      const current = this.sessions.get(sessionId);
      if (current) {
        current.activity.inFlightCalls = Math.max(0, current.activity.inFlightCalls - 1);
        current.activity.lastActivityAt = Date.now();
        this.scheduleIdleAutoClose(current);
      }
    }
  }

  armIdleAutoClose(sessionId: string, idleTimeoutMs: number): {
    armed: true;
    idleTimeoutMs: number;
    lastActivityAt: string;
    scheduledCloseAt: string;
  } {
    const session = this.requireSession(sessionId);
    session.activity.autoClose = { idleTimeoutMs };
    session.activity.lastActivityAt = Date.now();
    this.scheduleIdleAutoClose(session);
    return {
      armed: true,
      idleTimeoutMs,
      lastActivityAt: new Date(session.activity.lastActivityAt).toISOString(),
      scheduledCloseAt: new Date(session.activity.lastActivityAt + idleTimeoutMs).toISOString()
    };
  }

  async disposeAllSessions(): Promise<{
    closedSessionIds: string[];
    failures: Array<{ sessionId: string; error: ReturnType<typeof toStructuredError> }>;
  }> {
    const sessionIds = Array.from(this.sessions.keys());
    const closedSessionIds: string[] = [];
    const failures: Array<{ sessionId: string; error: ReturnType<typeof toStructuredError> }> = [];
    for (const sessionId of sessionIds) {
      try {
        await this.closeDebugSession(sessionId);
        closedSessionIds.push(sessionId);
      } catch (error) {
        failures.push({ sessionId, error: toStructuredError(error) });
        this.logger.error("debug session cleanup failed", { sessionId, error: toStructuredError(error) });
      }
    }
    return { closedSessionIds, failures };
  }

  private cancelIdleAutoClose(session: LogicalDebugSession): void {
    const timer = session.activity.autoClose?.timer;
    if (timer) {
      clearTimeout(timer);
      session.activity.autoClose!.timer = undefined;
    }
  }

  private scheduleIdleAutoClose(session: LogicalDebugSession): void {
    this.cancelIdleAutoClose(session);
    const policy = session.activity.autoClose;
    if (!policy || session.activity.closing || session.activity.inFlightCalls > 0) {
      return;
    }
    const remainingMs = Math.max(1, session.activity.lastActivityAt + policy.idleTimeoutMs - Date.now());
    policy.timer = setTimeout(() => { void this.closeIdleSession(session.sessionId); }, remainingMs);
    policy.timer.unref?.();
  }

  private async closeIdleSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    const policy = session?.activity.autoClose;
    if (!session || !policy || session.activity.closing) {
      return;
    }
    const idleForMs = Date.now() - session.activity.lastActivityAt;
    if (session.activity.inFlightCalls > 0 || idleForMs < policy.idleTimeoutMs) {
      this.scheduleIdleAutoClose(session);
      return;
    }
    try {
      await this.closeDebugSession(sessionId);
      this.logger.info("idle debug session auto-closed", { sessionId, idleForMs, idleTimeoutMs: policy.idleTimeoutMs });
    } catch (error) {
      this.logger.error("idle debug session cleanup failed", { sessionId, error: toStructuredError(error) });
    }
  }

  async connectTarget(sessionId: string, coreId: CoreId): Promise<TargetState> {
    return this.exclusive(sessionId, async () => this.connectTargetUnlocked(sessionId, coreId));
  }

  private async connectTargetUnlocked(sessionId: string, coreId: CoreId): Promise<TargetState> {
    const { session, core } = this.requireCore(sessionId, coreId);
    await this.adapter.connect(session.adapterSession, coreId);
    core.connected = true;
    core.active = true;
    core.state = "Connected";
    this.logger.info("core connected", { sessionId, coreId, coreName: core.coreName });
    return this.getTargetStateUnlocked(sessionId, coreId);
  }

  async disconnectTarget(sessionId: string, coreId: CoreId): Promise<TargetState> {
    return this.exclusive(sessionId, async () => {
      const { session, core } = this.requireCore(sessionId, coreId);
      await this.adapter.disconnect(session.adapterSession, coreId);
      core.connected = false;
      core.active = false;
      core.state = "Disconnected";
      this.logger.info("core disconnected", { sessionId, coreId, coreName: core.coreName });
      return this.getTargetStateUnlocked(sessionId, coreId);
    });
  }

  async runCore(sessionId: string, coreId: CoreId): Promise<TargetState> {
    return this.exclusive(sessionId, async () => this.runCoreUnlocked(sessionId, coreId));
  }

  private async runCoreUnlocked(sessionId: string, coreId: CoreId): Promise<TargetState> {
    const { session, core } = this.requireCore(sessionId, coreId);
    await this.adapter.run(session.adapterSession, coreId);
    core.state = "Running";
    core.active = true;
    this.logger.info("core run", { sessionId, coreId, coreName: core.coreName });
    return this.getTargetStateUnlocked(sessionId, coreId);
  }

  async haltCore(sessionId: string, coreId: CoreId): Promise<TargetState> {
    return this.exclusive(sessionId, async () => this.haltCoreUnlocked(sessionId, coreId));
  }

  private async haltCoreUnlocked(sessionId: string, coreId: CoreId): Promise<TargetState> {
    const { session, core } = this.requireCore(sessionId, coreId);
    await this.adapter.halt(session.adapterSession, coreId);
    core.state = "Halted";
    core.active = true;
    this.logger.info("core halted", { sessionId, coreId, coreName: core.coreName });
    return this.getTargetStateUnlocked(sessionId, coreId);
  }

  async resetCore(sessionId: string, coreId: CoreId, resetType: ResetType = "default"): Promise<TargetState> {
    return this.exclusive(sessionId, async () => this.resetCoreUnlocked(sessionId, coreId, resetType));
  }

  private async resetCoreUnlocked(sessionId: string, coreId: CoreId, resetType: ResetType = "default"): Promise<TargetState> {
    const { session, core } = this.requireCore(sessionId, coreId);
    await this.adapter.reset(session.adapterSession, coreId, resetType);
    core.state = "Halted";
    core.pc = "0x00000000";
    this.logger.info("core reset", { sessionId, coreId, coreName: core.coreName, resetType });
    return this.getTargetStateUnlocked(sessionId, coreId);
  }

  async getTargetState(sessionId: string, coreId: CoreId): Promise<TargetState> {
    return this.exclusive(sessionId, async () => this.getTargetStateUnlocked(sessionId, coreId));
  }

  private async getTargetStateUnlocked(sessionId: string, coreId: CoreId): Promise<TargetState> {
    const { session, core } = this.requireCore(sessionId, coreId);
    const state = await this.adapter.getState(session.adapterSession, coreId);
    core.connected = state.connected;
    core.state = state.state;
    core.pc = state.pc ?? core.pc;
    return { ...state, coreName: core.coreName };
  }

  async loadProgram(sessionId: string, coreId: CoreId, programUri: string): Promise<LoadedProgramInfo> {
    return this.loadProgramWithMap(sessionId, coreId, programUri);
  }

  async loadSymbols(sessionId: string, coreId: CoreId, programUri: string) {
    return this.exclusive(sessionId, async () => {
      const normalizedUri = this.normalizeArtifactUri(programUri);
      const { session, core } = this.requireCore(sessionId, coreId);
      try {
        await access(normalizedUri);
      } catch {
        throw new DebugMcpError("ProgramFileNotFound", `Symbol file was not found: ${normalizedUri}`, { programUri: normalizedUri });
      }
      if (!this.adapter.loadSymbols) {
        throw new DebugMcpError("AdapterNotAvailable", "The active debug adapter does not support symbol-only loading", {
          adapter: this.adapter.name,
          sessionId,
          coreId
        });
      }
      try {
        await this.adapter.loadSymbols(session.adapterSession, coreId, normalizedUri);
      } catch (error) {
        throw new DebugMcpError("ProgramLoadFailed", `Symbol-only load failed for core ${coreId}`, {
          coreId,
          programUri: normalizedUri,
          targetMemoryWritten: false,
          cause: toStructuredError(error)
        });
      }
      const metadata = await fileMetadata(normalizedUri);
      this.logger.info("symbols loaded without target programming", { sessionId, coreId, programUri: normalizedUri, sha256: metadata.sha256 });
      return {
        sessionId,
        coreId,
        coreName: core.coreName,
        programUri: normalizedUri,
        symbolsLoaded: true,
        targetMemoryWritten: false,
        loadedAt: new Date().toISOString(),
        fileMTime: metadata.fileMTime,
        fileSize: metadata.fileSize,
        sha256: metadata.sha256
      };
    });
  }

  async loadProgramWithMap(sessionId: string, coreId: CoreId, programUri: string, mapUri?: string, ramOwnershipPolicy: RamOwnershipPolicy = "require-map", fallbackGsRegions?: number[]): Promise<LoadedProgramInfo> {
    return this.exclusive(sessionId, async () => this.loadProgramWithMapUnlocked(sessionId, coreId, programUri, mapUri, ramOwnershipPolicy, fallbackGsRegions));
  }

  private async loadProgramWithMapUnlocked(sessionId: string, coreId: CoreId, programUri: string, mapUri?: string, ramOwnershipPolicy: RamOwnershipPolicy = "require-map", fallbackGsRegions?: number[]): Promise<LoadedProgramInfo> {
    const normalizedUri = this.normalizeArtifactUri(programUri);
    const normalizedMapUri = mapUri === undefined ? undefined : this.normalizeArtifactUri(mapUri);
    const { session, core } = this.requireCore(sessionId, coreId);
    try {
      await access(normalizedUri);
    } catch {
      throw new DebugMcpError("ProgramFileNotFound", `Program file was not found: ${normalizedUri}`, { programUri: normalizedUri });
    }
    let ownershipNote: string | undefined;
    try {
      await this.refreshSessionForProgramLoad(sessionId, session, coreId);
      ownershipNote = await this.prepareCpu2RamOwnership(sessionId, session, coreId, normalizedUri, normalizedMapUri, ramOwnershipPolicy, fallbackGsRegions);
      await this.adapter.loadProgram(session.adapterSession, coreId, normalizedUri);
    } catch (error) {
      if (error instanceof DebugMcpError && (
        error.code === "OwnerCoreNotConnected" ||
        error.code === "CoreNotConnected" ||
        error.code === "FlashLoadPreparationUnsupported" ||
        error.code === "ProgramLoadSessionRefreshFailed"
      )) {
        throw error;
      }
      throw new DebugMcpError("ProgramLoadFailed", `Program load failed for core ${coreId}`, {
        coreId,
        programUri: normalizedUri,
        cause: toStructuredError(error)
      });
    }
    const metadata = await fileMetadata(normalizedUri);
    const warnings = ["This info is guaranteed only if program was loaded through this MCP."];
    if (ownershipNote) {
      warnings.push(ownershipNote);
    }
    const info: LoadedProgramInfo = {
      sessionId,
      coreId,
      coreName: core.coreName,
      programUri: normalizedUri,
      ...(normalizedMapUri ? { mapUri: normalizedMapUri } : {}),
      loadedAt: new Date().toISOString(),
      fileMTime: metadata.fileMTime,
      fileSize: metadata.fileSize,
      sha256: metadata.sha256,
      symbolsLoaded: true,
      warning: warnings.join(" ")
    };
    this.loadedPrograms.set(info);
    this.logger.info("program loaded", { sessionId, coreId, programUri: normalizedUri, sha256: info.sha256 });
    return info;
  }

  private async refreshSessionForProgramLoad(
    sessionId: string,
    session: LogicalDebugSession,
    coreId: CoreId
  ): Promise<void> {
    if (!this.adapter.refreshSessionForProgramLoad) {
      return;
    }
    const previousAdapterSession = session.adapterSession;
    const connectedCoreIds = Array.from(session.cores.values())
      .filter(candidate => candidate.connected)
      .map(candidate => candidate.coreId);
    let refreshedAdapterSession: AdapterSession;
    try {
      refreshedAdapterSession = await this.adapter.refreshSessionForProgramLoad(previousAdapterSession, coreId);
    } catch (error) {
      throw new DebugMcpError("ProgramLoadSessionRefreshFailed", `Failed to refresh the debugger session before loading core ${coreId}`, {
        sessionId,
        coreId,
        previousAdapterSessionId: previousAdapterSession.adapterSessionId,
        cause: toStructuredError(error)
      });
    }
    if (refreshedAdapterSession.adapterSessionId === previousAdapterSession.adapterSessionId) {
      return;
    }
    session.adapterSession = refreshedAdapterSession;
    for (const candidate of session.cores.values()) {
      candidate.connected = false;
      candidate.active = false;
      candidate.state = "Disconnected";
    }
    try {
      for (const connectedCoreId of connectedCoreIds) {
        const candidate = session.cores.get(connectedCoreId)!;
        await this.adapter.connect(refreshedAdapterSession, connectedCoreId);
        candidate.connected = true;
        candidate.active = true;
        candidate.state = "Connected";
      }
    } catch (error) {
      throw new DebugMcpError("ProgramLoadSessionRefreshFailed", `Failed to reconnect cores after refreshing the debugger session for core ${coreId}`, {
        sessionId,
        coreId,
        previousAdapterSessionId: previousAdapterSession.adapterSessionId,
        refreshedAdapterSessionId: refreshedAdapterSession.adapterSessionId,
        connectedCoreIds,
        cause: toStructuredError(error)
      });
    }
    this.logger.info("debugger session refreshed before program load", {
      sessionId,
      coreId,
      previousAdapterSessionId: previousAdapterSession.adapterSessionId,
      refreshedAdapterSessionId: refreshedAdapterSession.adapterSessionId,
      reconnectedCoreIds: connectedCoreIds
    });
  }

  private async prepareCpu2RamOwnership(
    sessionId: string,
    session: LogicalDebugSession,
    coreId: CoreId,
    programUri: string,
    mapUri: string | undefined,
    policy: RamOwnershipPolicy,
    fallbackGsRegions?: number[]
  ): Promise<string | undefined> {
    if (coreId !== F28P65X_CPU2_CORE_ID || !session.cores.has(F28P65X_CPU1_CORE_ID)) {
      return undefined;
    }
    if (policy === "skip") {
      return "CPU2 RAM ownership preparation was explicitly skipped.";
    }
    const ownership = await this.cpu2RamOwnershipActions(coreId, programUri, mapUri, policy, fallbackGsRegions);
    const actions = mergeOwnershipActions(ownership.actions);
    const flashBanks = ownership.flashBanks;
    if (actions.length === 0 && flashBanks.length === 0) {
      return ownership.fallbackWarning;
    }
    if (ownership.fallbackWarning) {
      this.logger.warn("cpu2 gs ram ownership using map fallback", {
        sessionId,
        programUri,
        mapUri,
        reason: ownership.fallbackWarning
      });
    }
    const ownerState = await this.adapter.getState(session.adapterSession, F28P65X_CPU1_CORE_ID);
    if (!ownerState.connected) {
      throw new DebugMcpError(
        "OwnerCoreNotConnected",
        "CPU1 must be connected before CPU2 GS RAM ownership can be written",
        {
          sessionId,
          ownerCoreId: F28P65X_CPU1_CORE_ID,
          targetCoreId: F28P65X_CPU2_CORE_ID,
          programUri
        }
      );
    }
    if (flashBanks.length > 0) {
      if (!this.adapter.prepareFlashLoad) {
        throw new DebugMcpError(
          "FlashLoadPreparationUnsupported",
          "CPU2 Flash image requires Flash bank preparation, but the debug adapter does not implement prepareFlashLoad",
          {
            sessionId,
            targetCoreId: coreId,
            ownerCoreId: F28P65X_CPU1_CORE_ID,
            flashBanks,
            programUri,
            mapUri
          }
        );
      }
      await this.adapter.prepareFlashLoad(session.adapterSession, coreId, flashBanks);
      this.logger.info("cpu2 flash banks prepared", {
        sessionId,
        ownerCoreId: F28P65X_CPU1_CORE_ID,
        targetCoreId: coreId,
        flashBanks
      });
    }
    const writes: Array<{ address: number; requestedValue: number; writtenValue: number; rmw: boolean; memoryRegion: string }> = [];
    for (const action of actions) {
      let writtenValue = action.value;
      let rmw = false;
      if (this.adapter.readMemory) {
        try {
          const current = await this.adapter.readMemory(
            session.adapterSession,
            action.ownerCoreId,
            action.page,
            action.address,
            action.typeSize
          );
          writtenValue = current | action.value;
          rmw = true;
        } catch (error) {
          this.logger.warn("cpu2 gs ownership RMW read failed; writing absolute mask", {
            sessionId,
            address: action.address,
            value: action.value,
            error: toStructuredError(error)
          });
        }
      }
      await this.adapter.writeMemory(
        session.adapterSession,
        action.ownerCoreId,
        action.page,
        action.address,
        writtenValue,
        action.typeSize
      );
      writes.push({
        address: action.address,
        requestedValue: action.value,
        writtenValue,
        rmw,
        memoryRegion: action.memoryRegion
      });
    }
    this.logger.info("cpu2 gs ram ownership prepared", {
      sessionId,
      ownerCoreId: F28P65X_CPU1_CORE_ID,
      targetCoreId: F28P65X_CPU2_CORE_ID,
      fallback: Boolean(ownership.fallbackWarning),
      writes
    });
    return ownership.fallbackWarning;
  }

  async readMemory(sessionId: string, coreId: CoreId, page: string, address: number, typeSize: number): Promise<number> {
    return this.exclusive(sessionId, async () => {
      const { session } = this.requireCore(sessionId, coreId);
      if (!this.adapter.readMemory) {
        throw new DebugMcpError("MemoryReadFailed", "Debug adapter does not implement readMemory", {
          adapter: this.adapter.name,
          coreId
        });
      }
      return this.adapter.readMemory(session.adapterSession, coreId, page, address, typeSize);
    });
  }

  /**
   * Narrow manager-level primitive for worker-owned, capability-gated register
   * backends (for example ERAD). It is intentionally not exposed as an
   * arbitrary-address MCP tool.
   */
  async writeMemory(
    sessionId: string,
    coreId: CoreId,
    page: string,
    address: number,
    value: number,
    typeSize: number
  ): Promise<void> {
    return this.exclusive(sessionId, async () => {
      const { session } = this.requireCore(sessionId, coreId);
      await this.adapter.writeMemory(session.adapterSession, coreId, page, address, value, typeSize);
    });
  }

  async verifyRuntimeRamOwnership(
    sessionId: string,
    actions: RamOwnershipAction[]
  ): Promise<{
    requested: true;
    supported: boolean;
    skipped: boolean;
    matched?: boolean;
    expectedMask?: number;
    actualValue?: number;
    reason?: string;
    reads?: Array<{ address: number; value: number; expectedBits: number }>;
  }> {
    return this.exclusive(sessionId, async () => {
      if (!this.adapter.readMemory) {
        return {
          requested: true as const,
          supported: false,
          skipped: true,
          reason: "Debug adapter does not implement readMemory for MEMCFG verification."
        };
      }
      if (actions.length === 0) {
        return {
          requested: true as const,
          supported: true,
          skipped: true,
          reason: "No ownership actions to verify."
        };
      }
      const expectedMask = actions.reduce((mask, action) => mask | action.value, 0);
      const address = actions[0]!.address;
      const ownerCoreId = actions[0]!.ownerCoreId;
      const page = actions[0]!.page;
      const typeSize = actions[0]!.typeSize;
      const { session } = this.requireCore(sessionId, ownerCoreId);
      const actualValue = await this.adapter.readMemory!(session.adapterSession, ownerCoreId, page, address, typeSize);
      const matched = (actualValue & expectedMask) === expectedMask;
      if (!matched) {
        throw new DebugMcpError("RamOwnershipVerifyFailed", "Runtime MEMCFG GS ownership bits did not match expected mask", {
          sessionId,
          address,
          expectedMask,
          actualValue
        });
      }
      return {
        requested: true as const,
        supported: true,
        skipped: false,
        matched: true,
        expectedMask,
        actualValue,
        reads: [{ address, value: actualValue, expectedBits: expectedMask }]
      };
    });
  }

  private async cpu2RamOwnershipActions(
    coreId: CoreId,
    programUri: string,
    mapUri: string | undefined,
    policy: RamOwnershipPolicy,
    fallbackGsRegions?: number[]
  ): Promise<{ actions: RamOwnershipAction[]; flashBanks: number[]; fallbackUsed: boolean; fallbackWarning?: string }> {
    const candidateMap = mapUri ?? mapPathForProgram(programUri);
    if (candidateMap) {
      try {
        await access(candidateMap);
        const parsed = parseLinkerMap(await readFile(candidateMap, "utf8"), { coreId, coreName: "C28xx_CPU2", mapPath: candidateMap });
        const actions = ownershipActionsForMap(parsed);
        const flashBanks = [...new Set(
          flashOwnershipActionsForMap(parsed).flatMap(action => action.flashBanks)
        )].sort((left, right) => left - right);
        return { actions, flashBanks, fallbackUsed: false };
      } catch (error) {
        if (policy === "require-map") {
          throw new DebugMcpError(mapUri ? "RamOwnershipMapParseFailed" : "RamOwnershipMapUnavailable", `CPU2 RAM ownership requires a readable linker map: ${candidateMap}`, { mapUri: candidateMap, cause: toStructuredError(error) });
        }
      }
    }
    if (policy !== "explicit-fallback" || !fallbackGsRegions?.length) {
      throw new DebugMcpError("RamOwnershipEvidenceRequired", "CPU2 program load requires linker-map evidence or an explicit fallback GS RAM policy", { programUri, mapUri: candidateMap });
    }
    const reason =
      "CPU2 RAM ownership used caller-authorized fallback GS regions because linker-map evidence was unavailable.";
    return {
      actions: fallbackGsRegions.map(gsIndex => ({
        ownerCoreId: F28P65X_CPU1_CORE_ID,
        targetCoreId: F28P65X_CPU2_CORE_ID,
        targetCoreName: "C28xx_CPU2",
        memoryRegion: `RAMGS${gsIndex}`,
        gsIndex,
        page: "DATA",
        address: F28P65X_MEMCFG_GSXMSEL_ADDRESS,
        value: 1 << gsIndex,
        typeSize: 32,
        reason
      })),
      flashBanks: [],
      fallbackUsed: true,
      fallbackWarning: reason
    };
  }

  async loadPrograms(sessionId: string, programs: LoadProgramRequest[]) {
    return this.exclusive(sessionId, async () => {
      const results: BatchItemResult[] = [];
      for (const program of programs) {
        try {
          const normalizedUri = this.normalizeArtifactUri(program.programUri);
          const existing = this.loadedPrograms.get(sessionId, program.coreId);
          const metadata = await fileMetadata(normalizedUri);
          const unchanged = Boolean(existing && existing.programUri === normalizedUri && existing.fileMTime === metadata.fileMTime && existing.fileSize === metadata.fileSize && existing.sha256 === metadata.sha256);
          const registryVerification = program.loadPolicy === "verify-mcp-registry" || program.loadPolicy === "verify-only";
          if (registryVerification || (program.loadPolicy === "if-changed" && unchanged)) {
            results.push({
              coreId: program.coreId,
              coreName: this.requireCore(sessionId, program.coreId).core.coreName,
              success: !registryVerification || unchanged,
              programUri: normalizedUri,
              loaded: false,
              skipped: true,
              skipReason: unchanged ? "program-unchanged" : "mcp-registry-verification-failed",
              ...(registryVerification ? {
                verificationScope: "mcp-session-loaded-program-registry",
                targetFlashVerified: false,
                deprecatedPolicyAliasUsed: program.loadPolicy === "verify-only"
              } : {})
            });
            continue;
          }
          const info = await this.loadProgramWithMapUnlocked(sessionId, program.coreId, program.programUri, program.mapUri, program.ramOwnershipPolicy, program.fallbackGsRegions);
          results.push({ ...info, success: true, loaded: true, skipped: false });
        } catch (error) {
          results.push({ coreId: program.coreId, success: false, programUri: program.programUri, error: toStructuredError(error) });
          this.logger.error("program load failed", error);
        }
      }
      return { sessionId, results };
    });
  }

  async connectCores(sessionId: string, coreIds: CoreId[]) {
    return this.batchCoreOperation(sessionId, coreIds, coreId => this.connectTargetUnlocked(sessionId, coreId));
  }

  async haltCores(sessionId: string, coreIds: CoreId[]) {
    return this.batchCoreOperation(sessionId, coreIds, coreId => this.haltCoreUnlocked(sessionId, coreId));
  }

  async resetCores(sessionId: string, coreIds: CoreId[], resetType: ResetType = "default") {
    return this.batchCoreOperation(sessionId, coreIds, coreId => this.resetCoreUnlocked(sessionId, coreId, resetType));
  }

  async runCores(sessionId: string, coreIds: CoreId[]) {
    return this.batchCoreOperation(sessionId, coreIds, coreId => this.runCoreUnlocked(sessionId, coreId));
  }

  async getMulticoreSnapshot(sessionId: string, coreIds?: CoreId[]): Promise<{ sessionId: string; cores: CoreSnapshot[] }> {
    return this.exclusive(sessionId, async () => this.getMulticoreSnapshotUnlocked(sessionId, coreIds));
  }

  private async getMulticoreSnapshotUnlocked(sessionId: string, coreIds?: CoreId[]): Promise<{ sessionId: string; cores: CoreSnapshot[] }> {
    const session = this.requireSession(sessionId);
    const cores: CoreSnapshot[] = [];
    const selectedCores = coreIds === undefined
      ? Array.from(session.cores.values())
      : coreIds.map(coreId => this.requireCore(sessionId, coreId).core);
    for (const core of selectedCores) {
      const state = await this.getTargetStateUnlocked(sessionId, core.coreId);
      const loadedProgramInfo = this.loadedPrograms.get(sessionId, core.coreId);
      cores.push({
        coreId: core.coreId,
        coreName: core.coreName,
        name: core.coreName,
        connected: state.connected,
        state: state.state,
        pc: state.pc,
        loadedProgram: loadedProgramInfo?.programUri,
        loadedProgramInfo
      });
    }
    return { sessionId, cores };
  }

  async evaluateMany(sessionId: string, coreId: CoreId, expressions: string[]): Promise<EvaluateResult[]> {
    return this.exclusive(sessionId, async () => this.evaluateManyUnlocked(sessionId, coreId, expressions));
  }

  async evaluateManyWithTimeout(
    sessionId: string,
    coreId: CoreId,
    expressions: string[],
    timeoutMs: number,
    options?: { diagnostics?: "full" | "errors-only" }
  ): Promise<EvaluateResult[]> {
    return this.exclusive(
      sessionId,
      async () => this.evaluateManyUnlocked(sessionId, coreId, expressions, timeoutMs, options)
    );
  }

  private async evaluateManyUnlocked(
    sessionId: string,
    coreId: CoreId,
    expressions: string[],
    timeoutMs?: number,
    options?: { diagnostics?: "full" | "errors-only" }
  ): Promise<EvaluateResult[]> {
    const { session } = this.requireCore(sessionId, coreId);
    const uniqueExpressions = [...new Set(expressions)];
    const results = new Map<string, EvaluateResult>();
    const evaluatorExpressions: string[] = [];
    const readMemory = this.adapter.readMemory?.bind(this.adapter);
    for (const expression of uniqueExpressions) {
      const rawMemory = parseRawMemoryExpression(expression);
      if (!rawMemory || !readMemory) {
        evaluatorExpressions.push(expression);
        continue;
      }
      try {
        const value = await readMemory(
          session.adapterSession,
          coreId,
          "DATA",
          rawMemory.address,
          rawMemory.typeSize
        );
        results.set(expression, {
          expression,
          success: true,
          value: String(normalizeRawMemoryValue(value, rawMemory.typeSize)),
          type: rawMemory.typeName,
          address: rawMemory.addressText
        });
      } catch (error) {
        const structured = toStructuredError(error);
        results.set(expression, { expression, success: false, error: structured });
        this.logger.warn("raw memory expression read failed", { sessionId, coreId, expression, error: structured });
      }
    }

    if (evaluatorExpressions.length > 0 && this.adapter.evaluateExpressions) {
      try {
        const evaluated = await this.adapter.evaluateExpressions(
          session.adapterSession,
          coreId,
          evaluatorExpressions,
          timeoutMs,
          options
        );
        for (const result of evaluated) {
          if (typeof result.expression === "string") results.set(result.expression, result);
        }
      } catch (error) {
        this.logger.warn("batch expression evaluation failed", { sessionId, coreId, error: toStructuredError(error) });
      }
    }

    for (const expression of evaluatorExpressions) {
      if (results.has(expression)) continue;
      try {
        const result = await this.adapter.evaluateExpression(session.adapterSession, coreId, expression);
        results.set(expression, result);
        this.logger.debug("expression evaluated", { sessionId, coreId, expression, result });
      } catch (error) {
        const structured = toStructuredError(error);
        results.set(expression, { expression, success: false, error: structured });
        this.logger.warn("expression evaluation failed", { sessionId, coreId, expression, error: structured });
      }
    }
    return uniqueExpressions.map(expression => results.get(expression) ?? {
      expression,
      success: false,
      error: {
        code: "ExpressionEvaluateFailed",
        message: "Expression evaluator returned no result",
        details: { sessionId, coreId, expression }
      }
    });
  }

  async assignExpression(
    sessionId: string,
    coreId: CoreId,
    expression: string,
    value: ExpressionAssignmentValue,
    verify = true
  ): Promise<ExpressionAssignmentResult> {
    return this.exclusive(sessionId, async () => this.assignExpressionUnlocked(sessionId, coreId, expression, value, verify));
  }

  private async assignExpressionUnlocked(
    sessionId: string,
    coreId: CoreId,
    expression: string,
    value: ExpressionAssignmentValue,
    verify = true
  ): Promise<ExpressionAssignmentResult> {
    const { session, core } = this.requireCore(sessionId, coreId);
    const assignedValue = formatAssignmentValue(value);
    const write = await this.adapter.assignExpression(session.adapterSession, coreId, expression, assignedValue);
    if (write.success === false) {
      throw new DebugMcpError("ExpressionAssignFailed", `Expression assignment failed for ${expression}`, {
        sessionId,
        coreId,
        expression,
        assignedValue,
        write
      });
    }
    let readback: EvaluateResult | undefined;
    if (verify) {
      readback = await this.adapter.evaluateExpression(session.adapterSession, coreId, expression);
      if (readback.success !== true || !assignmentValuesEqual(readback.value, assignedValue)) {
        throw new DebugMcpError("ExpressionVerifyFailed", `Expression readback did not match assigned value for ${expression}`, {
          sessionId,
          coreId,
          expression,
          assignedValue,
          write,
          readback
        });
      }
    }
    this.logger.info("expression assigned", { sessionId, coreId, expression, assignedValue, verify });
    return {
      sessionId,
      coreId,
      coreName: core.coreName,
      expression,
      assignedValue,
      write,
      readback
    };
  }

  async assignExpressions(
    sessionId: string,
    assignments: ExpressionAssignmentRequest[]
  ): Promise<{ sessionId: string; results: ExpressionAssignmentBatchItemResult[] }> {
    return this.exclusive(sessionId, async () => {
      const results: ExpressionAssignmentBatchItemResult[] = [];
      for (const assignment of assignments) {
        try {
          const result = await this.assignExpressionUnlocked(
            sessionId,
            assignment.coreId,
            assignment.expression,
            assignment.value,
            assignment.verify ?? true
          );
          results.push({ ...result, success: true });
        } catch (error) {
          results.push({
            coreId: assignment.coreId,
            expression: assignment.expression,
            success: false,
            error: toStructuredError(error)
          });
          this.logger.error("expression assignment failed", error);
        }
      }
      return { sessionId, results };
    });
  }

  async injectFaults(
    sessionId: string,
    faults: FaultInjectionRequest[]
  ): Promise<{ sessionId: string; summary: { total: number; succeeded: number; failed: number }; results: FaultInjectionBatchItemResult[] }> {
    return this.exclusive(sessionId, async () => {
      const results: FaultInjectionBatchItemResult[] = [];
      for (const fault of faults) {
        try {
          const result = await this.assignExpressionUnlocked(
            sessionId,
            fault.coreId,
            fault.expression,
            fault.value,
            fault.verify ?? true
          );
          results.push({ ...result, label: fault.label, success: true });
        } catch (error) {
          results.push({
            label: fault.label,
            coreId: fault.coreId,
            expression: fault.expression,
            success: false,
            error: toStructuredError(error)
          });
          this.logger.error("fault injection failed", error);
        }
      }
      const failed = results.filter(result => result.success === false).length;
      return {
        sessionId,
        summary: {
          total: faults.length,
          succeeded: faults.length - failed,
          failed
        },
        results
      };
    });
  }

  async compareExpressions(
    sessionId: string,
    comparisons: ExpressionComparisonRequest[]
  ): Promise<{ sessionId: string; matched: boolean; comparisons: ExpressionComparisonResult[] }> {
    return this.exclusive(sessionId, async () => {
      const results: ExpressionComparisonResult[] = [];
      for (const comparison of comparisons) {
        const left = await this.evaluateEndpointUnlocked(sessionId, comparison.left);
        const right = await this.evaluateEndpointUnlocked(sessionId, comparison.right);
        const matched = Boolean(left.success && right.success && valuesEqual(left.value, right.value));
        results.push({
          label: comparison.label,
          matched,
          left,
          right
        });
      }
      return {
        sessionId,
        matched: results.every(result => result.matched),
        comparisons: results
      };
    });
  }

  async getLoadedProgramInfo(sessionId: string, coreId: CoreId): Promise<LoadedProgramInfo | undefined> {
    this.requireCore(sessionId, coreId);
    return this.loadedPrograms.get(sessionId, coreId);
  }

  async resolvePc(sessionId: string, coreId: CoreId): Promise<ResolveResult> {
    return this.exclusive(sessionId, async () => this.resolvePcUnlocked(sessionId, coreId));
  }

  private async resolvePcUnlocked(sessionId: string, coreId: CoreId): Promise<ResolveResult> {
    const { session } = this.requireCore(sessionId, coreId);
    const pc = await this.adapter.readPc(session.adapterSession, coreId);
    try {
      const resolved = await this.adapter.resolveAddress(session.adapterSession, coreId, pc);
      if (resolved.success !== true) {
        const fallback = await this.resolveLoadedProgramMap(sessionId, coreId, pc);
        if (fallback?.success) return { ...fallback, pc };
      }
      return {
        success: true,
        pc,
        address: resolved.address ?? pc,
        function: resolved.function,
        sourceFile: resolved.sourceFile,
        line: resolved.line,
        offset: resolved.offset,
        memoryRegion: resolved.memoryRegion,
        resolutionSource: resolved.resolutionSource ?? "ccs",
        partial: resolved.partial ?? resolved.success !== true,
        ...(resolved.error ? { error: resolved.error } : resolved.success === false
          ? { error: { code: "AddressResolveFailed", message: "Address-to-source mapping is partial or unavailable" } }
          : {})
      };
    } catch (error) {
      const fallback = await this.resolveLoadedProgramMap(sessionId, coreId, pc);
      return fallback?.success
        ? { ...fallback, pc }
        : { success: true, pc, address: pc, partial: true, error: toStructuredError(error) };
    }
  }

  async resolveAddress(sessionId: string, coreId: CoreId, address: string): Promise<ResolveResult> {
    return this.exclusive(sessionId, async () => {
      const { session } = this.requireCore(sessionId, coreId);
      try {
        const resolved = await this.adapter.resolveAddress(session.adapterSession, coreId, address);
        this.logger.debug("address resolved", { sessionId, coreId, address, resolved });
        if (resolved.success !== true) {
          return await this.resolveLoadedProgramMap(sessionId, coreId, address) ?? resolved;
        }
        return { ...resolved, resolutionSource: resolved.resolutionSource ?? "ccs" };
      } catch (error) {
        return await this.resolveLoadedProgramMap(sessionId, coreId, address)
          ?? { success: false, address, partial: true, error: toStructuredError(error) };
      }
    });
  }

  private async resolveLoadedProgramMap(sessionId: string, coreId: CoreId, address: string) {
    const mapUri = this.loadedPrograms.get(sessionId, coreId)?.mapUri;
    if (!mapUri) return undefined;
    try {
      return await resolveAddressFromMap(mapUri, address);
    } catch (error) {
      return {
        success: false,
        address,
        partial: true,
        resolutionSource: "linker-map" as const,
        error: toStructuredError(error)
      };
    }
  }

  async diagnoseCpu2Boot(options: {
    sessionId: string;
    cpu1CoreId: CoreId;
    cpu2CoreId: CoreId;
    cpu1Expressions?: string[];
    cpu2Expressions?: string[];
  }) {
    return this.exclusive(options.sessionId, async () => {
      const cpu1CoreId = options.cpu1CoreId;
      const cpu2CoreId = options.cpu2CoreId;
      const cpu1Expressions = options.cpu1Expressions ?? this.diagnostics.cpu1BootExpressions;
      const cpu2Expressions = options.cpu2Expressions ?? this.diagnostics.cpu2BootExpressions;
      const snapshot = await this.getMulticoreSnapshotUnlocked(options.sessionId);
      const cpu1Pc = await this.resolvePcUnlocked(options.sessionId, cpu1CoreId);
      const cpu2Pc = await this.resolvePcUnlocked(options.sessionId, cpu2CoreId);
      const cpu1Results = await this.evaluateManyUnlocked(options.sessionId, cpu1CoreId, cpu1Expressions);
      const cpu2Results = await this.evaluateManyUnlocked(options.sessionId, cpu2CoreId, cpu2Expressions);

      return {
        sessionId: options.sessionId,
        snapshot,
        cpu1: {
          coreId: cpu1CoreId,
          pc: cpu1Pc,
          expressions: cpu1Results
        },
        cpu2: {
          coreId: cpu2CoreId,
          pc: cpu2Pc,
          expressions: cpu2Results
        }
      };
    });
  }

  async verifyRunPauseIsolation(options: {
    sessionId: string;
    cpu1CoreId?: CoreId;
    cpu2CoreId?: CoreId;
    settleMs?: number;
  }) {
    return this.exclusive(options.sessionId, async () => {
      const cpu1CoreId = options.cpu1CoreId ?? 0;
      const cpu2CoreId = options.cpu2CoreId ?? 2;
      const cpu1CoreName = this.requireCore(options.sessionId, cpu1CoreId).core.coreName;
      const cpu2CoreName = this.requireCore(options.sessionId, cpu2CoreId).core.coreName;
      const settleMs = options.settleMs ?? 250;
      const steps = [];

      // Start from a known halted baseline so peer PC drift cannot false-fail isolation.
      await this.haltCoreUnlocked(options.sessionId, cpu1CoreId);
      await this.haltCoreUnlocked(options.sessionId, cpu2CoreId);
      const initialSnapshot = await this.getMulticoreSnapshotUnlocked(options.sessionId);
      let currentSnapshot: MulticoreSnapshotLike = initialSnapshot;

      const cpu1Run = await this.runIsolatedOperation({
        label: "c2000_continue(cpu1)",
        sessionId: options.sessionId,
        beforeSnapshot: currentSnapshot,
        targetCoreId: cpu1CoreId,
        expectedTargetState: "Running",
        settleMs,
        command: () => this.runCoreUnlocked(options.sessionId, cpu1CoreId)
      });
      steps.push(cpu1Run);
      currentSnapshot = cpu1Run.afterSnapshot;

      const cpu1Pause = await this.runIsolatedOperation({
        label: "c2000_pause(cpu1)",
        sessionId: options.sessionId,
        beforeSnapshot: currentSnapshot,
        targetCoreId: cpu1CoreId,
        expectedTargetState: "Halted",
        command: () => this.haltCoreUnlocked(options.sessionId, cpu1CoreId)
      });
      steps.push(cpu1Pause);
      currentSnapshot = cpu1Pause.afterSnapshot;

      const cpu2Run = await this.runIsolatedOperation({
        label: "c2000_continue(cpu2)",
        sessionId: options.sessionId,
        beforeSnapshot: currentSnapshot,
        targetCoreId: cpu2CoreId,
        expectedTargetState: "Running",
        settleMs,
        command: () => this.runCoreUnlocked(options.sessionId, cpu2CoreId)
      });
      steps.push(cpu2Run);
      currentSnapshot = cpu2Run.afterSnapshot;

      const cpu2Pause = await this.runIsolatedOperation({
        label: "c2000_pause(cpu2)",
        sessionId: options.sessionId,
        beforeSnapshot: currentSnapshot,
        targetCoreId: cpu2CoreId,
        expectedTargetState: "Halted",
        command: () => this.haltCoreUnlocked(options.sessionId, cpu2CoreId)
      });
      steps.push(cpu2Pause);
      currentSnapshot = cpu2Pause.afterSnapshot;

      return {
        sessionId: options.sessionId,
        initialSnapshot,
        steps,
        acceptanceSummary: buildRunPauseAcceptanceSummary(steps, { cpu1CoreId, cpu2CoreId, cpu1CoreName, cpu2CoreName }),
        finalSnapshot: currentSnapshot
      };
    });
  }

  private async batchCoreOperation(
    sessionId: string,
    coreIds: CoreId[],
    operation: (coreId: CoreId) => Promise<TargetState>
  ): Promise<{ sessionId: string; sequential: boolean; results: BatchItemResult[] }> {
    return this.exclusive(sessionId, async () => {
      const results: BatchItemResult[] = [];
      for (const coreId of coreIds) {
        try {
          const state = await operation(coreId);
          results.push({ coreId, coreName: state.coreName, success: true });
        } catch (error) {
          results.push({ coreId, success: false, error: toStructuredError(error) });
          this.logger.error("batch core operation failed", error);
        }
      }
      return { sessionId, sequential: !this.adapter.supportsSimultaneousOperations, results };
    });
  }

  private async runIsolatedOperation(input: {
    label: string;
    sessionId: string;
    beforeSnapshot: MulticoreSnapshotLike;
    targetCoreId: CoreId;
    expectedTargetState: "Running" | "Halted";
    command: () => Promise<TargetState>;
    settleMs?: number;
  }) {
    let commandResult: TargetState | { success: false; error: ReturnType<typeof toStructuredError> };
    const commandFailures: string[] = [];
    try {
      commandResult = await input.command();
    } catch (error) {
      const structuredError = toStructuredError(error);
      commandResult = { success: false, error: structuredError };
      commandFailures.push(`command failed: ${structuredError.message}`);
    }
    if (input.settleMs && input.settleMs > 0) {
      await sleep(input.settleMs);
    }
    const afterSnapshot = await this.getMulticoreSnapshotUnlocked(input.sessionId);
    let assertion;
    try {
      assertion = assertCoreIsolation({
        label: input.label,
        before: input.beforeSnapshot,
        after: afterSnapshot,
        targetCoreId: input.targetCoreId,
        expectedTargetState: input.expectedTargetState
      });
      if (commandFailures.length > 0) {
        assertion = {
          ...assertion,
          success: false,
          failures: commandFailures
        };
      }
    } catch (error) {
      assertion = {
        label: input.label,
        targetCoreId: input.targetCoreId,
        expectedTargetState: input.expectedTargetState,
        peerCoreIds: input.beforeSnapshot.cores
          .filter(core => core.coreId !== input.targetCoreId)
          .map(core => core.coreId),
        checkedPeerFields: [...CHECKED_PEER_FIELDS],
        success: false,
        failures: [...commandFailures, error instanceof Error ? error.message : String(error)]
      };
    }

    return {
      label: input.label,
      commandResult,
      beforeSnapshot: input.beforeSnapshot,
      afterSnapshot,
      assertion
    };
  }

  private async evaluateEndpointUnlocked(sessionId: string, endpoint: { coreId: CoreId; expression: string }) {
    this.requireCore(sessionId, endpoint.coreId);
    const [result] = await this.evaluateManyUnlocked(sessionId, endpoint.coreId, [endpoint.expression]);
    return {
      coreId: endpoint.coreId,
      expression: endpoint.expression,
      success: result?.success === true,
      value: result?.value,
      type: result?.type,
      address: result?.address,
      error: result?.error
    };
  }

  private requireSession(sessionId: string): LogicalDebugSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new DebugMcpError("SessionNotFound", `Debug session ${sessionId} was not found`, { sessionId });
    }
    return session;
  }

  private requireCore(sessionId: string, coreId: CoreId): { session: LogicalDebugSession; core: CoreSession } {
    const session = this.requireSession(sessionId);
    const core = session.cores.get(coreId);
    if (!core) {
      throw new DebugMcpError("CoreNotFound", `Core ${coreId} was not found in session ${sessionId}`, { sessionId, coreId });
    }
    return { session, core };
  }
}

function validateCoreMap(coreMap: CoreConfig[]): CoreConfig[] {
  if (coreMap.length === 0) {
    throw new DebugMcpError("CoreNotFound", "coreMap must include at least one core");
  }
  const seenCoreIds = new Set<CoreId>();
  const seenCoreTargets = new Map<string, CoreConfig>();
  for (const core of coreMap) {
    if (seenCoreIds.has(core.coreId)) {
      throw new DebugMcpError("DuplicateCoreId", `coreMap contains duplicate coreId ${core.coreId}`, {
        coreId: core.coreId,
        coreName: core.coreName
      });
    }
    seenCoreIds.add(core.coreId);
    const coreTarget = core.corePattern ?? core.coreName;
    const existing = seenCoreTargets.get(coreTarget);
    if (existing) {
      throw new DebugMcpError("DuplicateCoreTarget", `coreMap maps multiple coreIds to target ${coreTarget}`, {
        coreTarget,
        coreId: core.coreId,
        existingCoreId: existing.coreId
      });
    }
    seenCoreTargets.set(coreTarget, core);
  }
  return coreMap;
}

function formatAssignmentValue(value: ExpressionAssignmentValue): string {
  if (typeof value === "boolean") {
    return value ? "1" : "0";
  }
  return String(value);
}

function assignmentValuesEqual(actual: unknown, expected: string): boolean {
  return valuesEqual(actual, expected);
}

interface RawMemoryExpression {
  typeName: "uint8_t" | "uint16_t" | "uint32_t";
  typeSize: 8 | 16 | 32;
  address: number;
  addressText: string;
}

const rawMemoryExpressionPattern = /^\s*\*\s*\(\s*(uint8_t|uint16_t|uint32_t)\s*\*\s*\)\s*(0[xX][0-9a-fA-F]+|[0-9]+)\s*$/;

function parseRawMemoryExpression(expression: string): RawMemoryExpression | undefined {
  const match = rawMemoryExpressionPattern.exec(expression);
  if (!match) return undefined;
  const typeName = match[1] as RawMemoryExpression["typeName"];
  const typeSize = typeName === "uint8_t" ? 8 : typeName === "uint16_t" ? 16 : 32;
  const address = Number(match[2]);
  if (!Number.isSafeInteger(address) || address < 0) return undefined;
  return { typeName, typeSize, address, addressText: match[2]! };
}

function normalizeRawMemoryValue(value: number, typeSize: RawMemoryExpression["typeSize"]): number {
  if (!Number.isFinite(value)) return value;
  if (typeSize === 8) return value & 0xff;
  if (typeSize === 16) return value & 0xffff;
  return value >>> 0;
}
