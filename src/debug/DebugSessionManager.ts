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
import { normalizeProgramUri } from "../utils/pathUtils.js";
import { assertCoreIsolation, CHECKED_PEER_FIELDS, type MulticoreSnapshotLike } from "./isolationAssertions.js";
import { buildRunPauseAcceptanceSummary } from "./runPauseAcceptance.js";
import {
  flashOwnershipActionsForMap,
  mapPathForProgram,
  ownershipActionsForMap,
  parseLinkerMap,
  type FlashOwnershipAction,
  type RamOwnershipAction
} from "../hardware/mapOwnership.js";

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
}

const F28P65X_CPU1_CORE_ID = 0;
const F28P65X_CPU2_CORE_ID = 2;
const F28P65X_MEMCFG_GSXMSEL_ADDRESS = 0x0005F444;
const F28P65X_GS4_CPU2_OWNER_BIT = 0x10;

export class DebugSessionManager {
  private readonly sessions = new Map<string, LogicalDebugSession>();

  constructor(
    private readonly adapter: DebugAdapter,
    private readonly loadedPrograms: LoadedProgramRegistry,
    private readonly logger: Logger = noopLogger
  ) {}

  async createDebugSession(options: Partial<CreateDebugSessionOptions>): Promise<{ sessionId: string; cores: CoreInfo[] }> {
    const sessionName = options.sessionName ?? "c2000-debug-session";
    const coreMap = validateCoreMap(options.coreMap ?? defaultF28P65xCoreMap);
    const adapterSession = await this.adapter.createSession({ sessionName, ccxmlPath: options.ccxmlPath, coreMap });
    const sessionId = `dbg-${randomUUID()}`;
    const cores = new Map(coreMap.map(core => [core.coreId, new CoreSession(core)]));
    this.sessions.set(sessionId, {
      sessionId,
      sessionName,
      ccxmlPath: options.ccxmlPath,
      adapterSession,
      cores,
      activity: { inFlightCalls: 0, lastActivityAt: Date.now(), closing: false }
    });
    this.logger.info("debug session created", { sessionId, sessionName, coreMap });
    return { sessionId, cores: await this.listCores(sessionId) };
  }

  async listCores(sessionId: string): Promise<CoreInfo[]> {
    const session = this.requireSession(sessionId);
    const adapterCores = await this.adapter.listCores(session.adapterSession);
    for (const info of adapterCores) {
      const core = session.cores.get(info.coreId);
      if (core) {
        core.connected = info.connected;
        core.active = info.active;
        core.state = info.connected ? core.state === "Disconnected" ? "Connected" : core.state : "Disconnected";
      }
    }
    return adapterCores;
  }

  async getSessionTopology(sessionId: string): Promise<SessionTopology> {
    const session = this.requireSession(sessionId);
    return {
      sessionId,
      sessionName: session.sessionName,
      ccxmlPath: session.ccxmlPath,
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

  async closeDebugSession(sessionId: string): Promise<{ sessionId: string; closed: true }> {
    const session = this.requireSession(sessionId);
    session.activity.closing = true;
    this.cancelIdleAutoClose(session);
    try {
      await this.adapter.disposeSession?.(session.adapterSession);
    } finally {
      this.sessions.delete(sessionId);
      this.loadedPrograms.deleteSession(sessionId);
      this.logger.info("debug session closed", { sessionId });
    }
    return { sessionId, closed: true };
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
    const { session, core } = this.requireCore(sessionId, coreId);
    await this.adapter.connect(session.adapterSession, coreId);
    core.connected = true;
    core.active = true;
    core.state = "Connected";
    this.logger.info("core connected", { sessionId, coreId, coreName: core.coreName });
    return this.getTargetState(sessionId, coreId);
  }

  async disconnectTarget(sessionId: string, coreId: CoreId): Promise<TargetState> {
    const { session, core } = this.requireCore(sessionId, coreId);
    await this.adapter.disconnect(session.adapterSession, coreId);
    core.connected = false;
    core.active = false;
    core.state = "Disconnected";
    this.logger.info("core disconnected", { sessionId, coreId, coreName: core.coreName });
    return this.getTargetState(sessionId, coreId);
  }

  async runCore(sessionId: string, coreId: CoreId): Promise<TargetState> {
    const { session, core } = this.requireCore(sessionId, coreId);
    await this.adapter.run(session.adapterSession, coreId);
    core.state = "Running";
    core.active = true;
    this.logger.info("core run", { sessionId, coreId, coreName: core.coreName });
    return this.getTargetState(sessionId, coreId);
  }

  async haltCore(sessionId: string, coreId: CoreId): Promise<TargetState> {
    const { session, core } = this.requireCore(sessionId, coreId);
    await this.adapter.halt(session.adapterSession, coreId);
    core.state = "Halted";
    core.active = true;
    this.logger.info("core halted", { sessionId, coreId, coreName: core.coreName });
    return this.getTargetState(sessionId, coreId);
  }

  async resetCore(sessionId: string, coreId: CoreId, resetType: ResetType = "default"): Promise<TargetState> {
    const { session, core } = this.requireCore(sessionId, coreId);
    await this.adapter.reset(session.adapterSession, coreId, resetType);
    core.state = "Halted";
    core.pc = "0x00000000";
    this.logger.info("core reset", { sessionId, coreId, coreName: core.coreName, resetType });
    return this.getTargetState(sessionId, coreId);
  }

  async getTargetState(sessionId: string, coreId: CoreId): Promise<TargetState> {
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

  async loadProgramWithMap(sessionId: string, coreId: CoreId, programUri: string, mapUri?: string): Promise<LoadedProgramInfo> {
    const normalizedUri = normalizeProgramUri(programUri);
    const { session, core } = this.requireCore(sessionId, coreId);
    try {
      await access(normalizedUri);
    } catch {
      throw new DebugMcpError("ProgramFileNotFound", `Program file was not found: ${normalizedUri}`, { programUri: normalizedUri });
    }
    try {
      const ownership = await this.prepareCpu2MemoryOwnership(sessionId, session, coreId, normalizedUri, mapUri);
      if (ownership.flashBanks.length > 0) {
        await this.adapter.prepareFlashLoad?.(session.adapterSession, coreId, ownership.flashBanks);
      }
      await this.adapter.loadProgram(session.adapterSession, coreId, normalizedUri);
    } catch (error) {
      throw new DebugMcpError("ProgramLoadFailed", `Program load failed for core ${coreId}`, {
        coreId,
        programUri: normalizedUri,
        cause: toStructuredError(error)
      });
    }
    const metadata = await fileMetadata(normalizedUri);
    const info: LoadedProgramInfo = {
      sessionId,
      coreId,
      coreName: core.coreName,
      programUri: normalizedUri,
      loadedAt: new Date().toISOString(),
      fileMTime: metadata.fileMTime,
      fileSize: metadata.fileSize,
      sha256: metadata.sha256,
      symbolsLoaded: true,
      warning: "This info is guaranteed only if program was loaded through this MCP."
    };
    this.loadedPrograms.set(info);
    this.logger.info("program loaded", { sessionId, coreId, programUri: normalizedUri, sha256: info.sha256 });
    return info;
  }

  private async prepareCpu2MemoryOwnership(sessionId: string, session: LogicalDebugSession, coreId: CoreId, programUri: string, mapUri?: string): Promise<{ flashBanks: number[] }> {
    if (coreId !== F28P65X_CPU2_CORE_ID || !session.cores.has(F28P65X_CPU1_CORE_ID)) {
      return { flashBanks: [] };
    }
    const actions = await this.cpu2OwnershipActions(coreId, programUri, mapUri);
    for (const action of [...actions.ram, ...actions.flash]) {
      await this.adapter.writeMemory(session.adapterSession, action.ownerCoreId, action.page, action.address, action.value, action.typeSize);
    }
    this.logger.info("cpu2 memory ownership prepared", {
      sessionId,
      ownerCoreId: F28P65X_CPU1_CORE_ID,
      targetCoreId: F28P65X_CPU2_CORE_ID,
      ramActions: actions.ram,
      flashActions: actions.flash
    });
    return { flashBanks: [...new Set(actions.flash.flatMap(action => action.flashBanks))] };
  }

  private async cpu2OwnershipActions(coreId: CoreId, programUri: string, mapUri?: string): Promise<{ ram: RamOwnershipAction[]; flash: FlashOwnershipAction[] }> {
    const candidateMap = mapUri ?? mapPathForProgram(programUri);
    if (candidateMap) {
      try {
        await access(candidateMap);
        const parsed = parseLinkerMap(await readFile(candidateMap, "utf8"), { coreId, coreName: "C28xx_CPU2", mapPath: candidateMap });
        return {
          ram: ownershipActionsForMap(parsed),
          flash: flashOwnershipActionsForMap(parsed)
        };
      } catch {
        // Preserve the previous safe default when the map file is unavailable.
      }
    }
    return {
      ram: [{
        ownerCoreId: F28P65X_CPU1_CORE_ID,
        targetCoreId: F28P65X_CPU2_CORE_ID,
        targetCoreName: "C28xx_CPU2",
        memoryRegion: "RAMGS4",
        gsIndex: 4,
        page: "DATA",
        address: F28P65X_MEMCFG_GSXMSEL_ADDRESS,
        value: F28P65X_GS4_CPU2_OWNER_BIT,
        typeSize: 32,
        reason: "No CPU2 map was available; preserving the F28P65x RAMGS4 handoff default for CPU2 RAM loads."
      }],
      flash: []
    };
  }

  async loadPrograms(sessionId: string, programs: LoadProgramRequest[]) {
    const results: BatchItemResult[] = [];
    for (const program of programs) {
      try {
        const info = await this.loadProgramWithMap(sessionId, program.coreId, program.programUri, program.mapUri);
        results.push({ coreId: program.coreId, coreName: info.coreName, success: true, programUri: info.programUri });
      } catch (error) {
        results.push({ coreId: program.coreId, success: false, programUri: program.programUri, error: toStructuredError(error) });
        this.logger.error("program load failed", error);
      }
    }
    return { sessionId, results };
  }

  async connectCores(sessionId: string, coreIds: CoreId[]) {
    return this.batchCoreOperation(sessionId, coreIds, coreId => this.connectTarget(sessionId, coreId));
  }

  async haltCores(sessionId: string, coreIds: CoreId[]) {
    return this.batchCoreOperation(sessionId, coreIds, coreId => this.haltCore(sessionId, coreId));
  }

  async resetCores(sessionId: string, coreIds: CoreId[], resetType: ResetType = "default") {
    return this.batchCoreOperation(sessionId, coreIds, coreId => this.resetCore(sessionId, coreId, resetType));
  }

  async runCores(sessionId: string, coreIds: CoreId[]) {
    return this.batchCoreOperation(sessionId, coreIds, coreId => this.runCore(sessionId, coreId));
  }

  async getMulticoreSnapshot(sessionId: string, coreIds?: CoreId[]): Promise<{ sessionId: string; cores: CoreSnapshot[] }> {
    const session = this.requireSession(sessionId);
    const cores: CoreSnapshot[] = [];
    const selectedCores = coreIds === undefined
      ? Array.from(session.cores.values())
      : coreIds.map(coreId => this.requireCore(sessionId, coreId).core);
    for (const core of selectedCores) {
      const state = await this.getTargetState(sessionId, core.coreId);
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
    const { session } = this.requireCore(sessionId, coreId);
    const results: EvaluateResult[] = [];
    for (const expression of expressions) {
      try {
        const result = await this.adapter.evaluateExpression(session.adapterSession, coreId, expression);
        results.push(result);
        this.logger.debug("expression evaluated", { sessionId, coreId, expression, result });
      } catch (error) {
        const structured = toStructuredError(error);
        results.push({ expression, success: false, error: structured });
        this.logger.warn("expression evaluation failed", { sessionId, coreId, expression, error: structured });
      }
    }
    return results;
  }

  async assignExpression(
    sessionId: string,
    coreId: CoreId,
    expression: string,
    value: ExpressionAssignmentValue,
    verify = true
  ): Promise<ExpressionAssignmentResult> {
    const { session, core } = this.requireCore(sessionId, coreId);
    const assignedValue = formatAssignmentValue(value);
    const write = await this.adapter.assignExpression(session.adapterSession, coreId, expression, assignedValue);
    const readback = verify ? await this.adapter.evaluateExpression(session.adapterSession, coreId, expression) : undefined;
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
    const results: ExpressionAssignmentBatchItemResult[] = [];
    for (const assignment of assignments) {
      try {
        const result = await this.assignExpression(
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
  }

  async injectFaults(
    sessionId: string,
    faults: FaultInjectionRequest[]
  ): Promise<{ sessionId: string; summary: { total: number; succeeded: number; failed: number }; results: FaultInjectionBatchItemResult[] }> {
    const results: FaultInjectionBatchItemResult[] = [];
    for (const fault of faults) {
      try {
        const result = await this.assignExpression(
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
  }

  async compareExpressions(
    sessionId: string,
    comparisons: ExpressionComparisonRequest[]
  ): Promise<{ sessionId: string; matched: boolean; comparisons: ExpressionComparisonResult[] }> {
    const results: ExpressionComparisonResult[] = [];
    for (const comparison of comparisons) {
      const [left, right] = await Promise.all([
        this.evaluateEndpoint(sessionId, comparison.left),
        this.evaluateEndpoint(sessionId, comparison.right)
      ]);
      const matched = Boolean(left.success && right.success && String(left.value) === String(right.value));
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
  }

  async getLoadedProgramInfo(sessionId: string, coreId: CoreId): Promise<LoadedProgramInfo | undefined> {
    this.requireCore(sessionId, coreId);
    return this.loadedPrograms.get(sessionId, coreId);
  }

  async resolvePc(sessionId: string, coreId: CoreId): Promise<ResolveResult> {
    const { session } = this.requireCore(sessionId, coreId);
    const pc = await this.adapter.readPc(session.adapterSession, coreId);
    try {
      const resolved = await this.adapter.resolveAddress(session.adapterSession, coreId, pc);
      return { ...resolved, pc };
    } catch (error) {
      return { success: true, pc, address: pc, partial: true, error: toStructuredError(error) };
    }
  }

  async resolveAddress(sessionId: string, coreId: CoreId, address: string): Promise<ResolveResult> {
    const { session } = this.requireCore(sessionId, coreId);
    try {
      const resolved = await this.adapter.resolveAddress(session.adapterSession, coreId, address);
      this.logger.debug("address resolved", { sessionId, coreId, address, resolved });
      return resolved;
    } catch (error) {
      return { success: false, address, partial: true, error: toStructuredError(error) };
    }
  }

  async diagnoseCpu2Boot(options: {
    sessionId: string;
    cpu1CoreId: CoreId;
    cpu2CoreId: CoreId;
    cpu1Expressions?: string[];
    cpu2Expressions?: string[];
  }) {
    const cpu1CoreId = options.cpu1CoreId;
    const cpu2CoreId = options.cpu2CoreId;
    const cpu1Expressions = options.cpu1Expressions ?? [
      "g_emHybrid30kCpu1Stage",
      "g_ulHybrid30kIpcPass",
      "g_ulHybrid30kMsgRamPass",
      "g_ulHybrid30kParamPass"
    ];
    const cpu2Expressions = options.cpu2Expressions ?? ["g_emHybrid30kCpu2Stage"];
    const [snapshot, cpu1Pc, cpu2Pc, cpu1Results, cpu2Results] = await Promise.all([
      this.getMulticoreSnapshot(options.sessionId),
      this.resolvePc(options.sessionId, cpu1CoreId),
      this.resolvePc(options.sessionId, cpu2CoreId),
      this.evaluateMany(options.sessionId, cpu1CoreId, cpu1Expressions),
      this.evaluateMany(options.sessionId, cpu2CoreId, cpu2Expressions)
    ]);

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
  }

  async verifyRunPauseIsolation(options: {
    sessionId: string;
    cpu1CoreId?: CoreId;
    cpu2CoreId?: CoreId;
    settleMs?: number;
  }) {
    const cpu1CoreId = options.cpu1CoreId ?? 0;
    const cpu2CoreId = options.cpu2CoreId ?? 2;
    const cpu1CoreName = this.requireCore(options.sessionId, cpu1CoreId).core.coreName;
    const cpu2CoreName = this.requireCore(options.sessionId, cpu2CoreId).core.coreName;
    const settleMs = options.settleMs ?? 250;
    const steps = [];
    const initialSnapshot = await this.getMulticoreSnapshot(options.sessionId);
    let currentSnapshot: MulticoreSnapshotLike = initialSnapshot;

    const cpu1Run = await this.runIsolatedOperation({
      label: "c2000_continue(cpu1)",
      sessionId: options.sessionId,
      beforeSnapshot: currentSnapshot,
      targetCoreId: cpu1CoreId,
      expectedTargetState: "Running",
      settleMs,
      command: () => this.runCore(options.sessionId, cpu1CoreId)
    });
    steps.push(cpu1Run);
    currentSnapshot = cpu1Run.afterSnapshot;

    const cpu1Pause = await this.runIsolatedOperation({
      label: "c2000_pause(cpu1)",
      sessionId: options.sessionId,
      beforeSnapshot: currentSnapshot,
      targetCoreId: cpu1CoreId,
      expectedTargetState: "Halted",
      command: () => this.haltCore(options.sessionId, cpu1CoreId)
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
      command: () => this.runCore(options.sessionId, cpu2CoreId)
    });
    steps.push(cpu2Run);
    currentSnapshot = cpu2Run.afterSnapshot;

    const cpu2Pause = await this.runIsolatedOperation({
      label: "c2000_pause(cpu2)",
      sessionId: options.sessionId,
      beforeSnapshot: currentSnapshot,
      targetCoreId: cpu2CoreId,
      expectedTargetState: "Halted",
      command: () => this.haltCore(options.sessionId, cpu2CoreId)
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
  }

  private async batchCoreOperation(
    sessionId: string,
    coreIds: CoreId[],
    operation: (coreId: CoreId) => Promise<TargetState>
  ): Promise<{ sessionId: string; sequential: boolean; results: BatchItemResult[] }> {
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
    const afterSnapshot = await this.getMulticoreSnapshot(input.sessionId);
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

  private async evaluateEndpoint(sessionId: string, endpoint: { coreId: CoreId; expression: string }) {
    this.requireCore(sessionId, endpoint.coreId);
    const [result] = await this.evaluateMany(sessionId, endpoint.coreId, [endpoint.expression]);
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

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatAssignmentValue(value: ExpressionAssignmentValue): string {
  if (typeof value === "boolean") {
    return value ? "1" : "0";
  }
  return String(value);
}
