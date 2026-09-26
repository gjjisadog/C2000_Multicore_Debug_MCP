import type { C2000ToolInvoker } from "../mcp/tools.js";
import { DebugMcpError, toStructuredError } from "../utils/errors.js";
import { BoardRegistry } from "../boards/BoardRegistry.js";
import { BoardWorkerSupervisor } from "../boards/BoardWorkerSupervisor.js";
import { SessionRepository } from "../storage/repositories/SessionRepository.js";
import type { LeasedBoard } from "../boards/BoardLeaseManager.js";
import type { BoardLeaseContext } from "../boards/types.js";
import type { VariableStreamService } from "../observability/VariableStreamService.js";
import type { DlogService } from "../observability/DlogService.js";
import type { EradService } from "../observability/EradService.js";
import type { OutcomeAnalyticsService } from "../analytics/OutcomeAnalyticsService.js";
import { fileMetadata } from "../utils/fileHash.js";
import { normalizeProgramUri } from "../utils/pathUtils.js";
import type { TargetProgramMutation } from "../boards/types.js";
import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { cycleBoardPowerSchema, confirmManualPowerCycleSchema } from "../mcp/toolSchemas.js";
import type { TestRunRepository } from "../storage/repositories/TestRunRepository.js";
import type { EventRepository } from "../storage/repositories/EventRepository.js";
import type { LabPowerCycleClient } from "../power/BleLabPowerMcpClient.js";

interface PowerCycleDependencies {
  runs: Pick<TestRunRepository, "listActiveForBoard">;
  events: Pick<EventRepository, "append">;
  client?: LabPowerCycleClient;
  enabled: boolean;
  safetyProfile: "readonly" | "safe" | "full";
}

const POST_CYCLE_STARTUP_TOOLS = new Set([
  "c2000_runCore", "c2000_continue", "c2000_runCores", "c2000_reset", "c2000_resetCores",
  "c2000_reloadResetRunToMain", "c2000_runBootHandoffDiagnosis", "c2000_runReloadAndDiagnose",
  "c2000_launchMulticoreDebug", "c2000_launchMulticoreDebugSafe", "c2000_launchMulticoreDebugWithActions",
  "c2000_waitForIpcReady"
]);

/** Routes board-bound tools to a single worker without changing sessionId/coreId semantics. */
export class DaemonToolRouter implements C2000ToolInvoker {
  private readonly interactiveLeases = new Map<string, LeasedBoard>();
  private readonly activeBoardCommands = new Map<string, number>();
  private readonly powerCycleInProgress = new Set<string>();
  private variableStreams?: VariableStreamService;
  private dlog?: DlogService;
  private erad?: EradService;
  constructor(
    private readonly local: C2000ToolInvoker,
    private readonly registry: BoardRegistry,
    private readonly workers: BoardWorkerSupervisor,
    private readonly sessions: SessionRepository,
    private readonly analytics?: OutcomeAnalyticsService,
    private readonly workspacePath?: string,
    private readonly powerCycle?: PowerCycleDependencies
  ) {}

  setVariableStreamService(service: VariableStreamService): void {
    this.variableStreams = service;
  }

  setDlogService(service: DlogService): void {
    this.dlog = service;
  }

  setEradService(service: EradService): void {
    this.erad = service;
  }

  requireInteractiveLeaseContext(sessionId: string, boardId: string, ttlMs: number): BoardLeaseContext {
    const session = this.sessions.get(sessionId);
    if (!session || session.boardId !== boardId || session.closedAt || session.status === "CLOSED") {
      throw new DebugMcpError("SessionNotFound", "No open board-bound session exists for the variable stream", {
        sessionId,
        boardId
      });
    }
    const interactive = this.interactiveLeases.get(sessionId);
    if (!interactive) {
      throw new DebugMcpError("BoardLeaseRequired", "Variable streams require the live fencing lease owned by the debug session", {
        sessionId,
        boardId
      });
    }
    const worker = this.workers.currentWorker(boardId);
    if (!worker || worker.workerInstanceId !== interactive.context.workerInstanceId) {
      throw new DebugMcpError("LeaseWorkerMismatch", "Interactive lease does not bind the current board worker", {
        sessionId,
        boardId,
        expectedWorkerInstanceId: worker?.workerInstanceId,
        receivedWorkerInstanceId: interactive.context.workerInstanceId,
        expectedWorkerGeneration: worker?.workerGeneration,
        stage: "interactive-lease",
        targetAccessAttempted: false
      });
    }
    this.registry.leases.renew(interactive.lease.leaseId, interactive.leaseToken, ttlMs);
    return interactive.context;
  }

  async invokeTool(toolName: string, input: unknown): Promise<Record<string, unknown>> {
    const startedAt = Date.now();
    if (toolName === "c2000_cycleBoardPower" || toolName === "c2000_confirmManualPowerCycle") {
      try {
        const result = toolName === "c2000_cycleBoardPower"
          ? await this.cycleBoardPower(cycleBoardPowerSchema.parse(input))
          : this.confirmManualPowerCycle(confirmManualPowerCycleSchema.parse(input));
        this.recordAnalytics({ toolName, input, result, durationMs: Date.now() - startedAt });
        return result;
      } catch (error) {
        this.recordAnalytics({ toolName, input, error, durationMs: Date.now() - startedAt });
        throw error;
      }
    }
    const boardIds = this.boardIdsForInvocation(toolName, input);
    for (const boardId of boardIds) {
      const board = this.registry.list().find(candidate => candidate.boardId === boardId);
      if (!board) continue;
      if (this.powerCycleInProgress.has(boardId) ||
          (board.status === "QUARANTINED" && String(board.lastError?.code ?? "").startsWith("PowerCycle"))) {
        throw new DebugMcpError("PowerCyclePending", "Board power transition is pending; no target operation was started", {
          boardId, status: board.status, powerCycle: board.lastError, targetAccessAttempted: false
        });
      }
      const symbolsOnlyIpc = (toolName === "c2000_runIpcAcceptance" || toolName === "c2000_launchAndRunIpcAcceptance")
        && record(input).programPreparation === "symbols-only";
      if (board.targetIdentity.requiresVerificationAfterPowerCycle && (POST_CYCLE_STARTUP_TOOLS.has(toolName) || symbolsOnlyIpc)) {
        throw new DebugMcpError("TargetImageIdentityUnknown", "Power cycling requires fresh CPU1/CPU2 image verification before target startup or IPC conclusions", {
          boardId, toolName, targetGeneration: board.targetIdentity.generation, targetAccessAttempted: false,
          nextAction: "Create a new session, connect both cores, and verify both resident images from manifests before starting either core."
        });
      }
    }
    for (const boardId of boardIds) this.activeBoardCommands.set(boardId, (this.activeBoardCommands.get(boardId) ?? 0) + 1);
    try {
      const result = await this.invokeToolInternal(toolName, input);
      this.recordAnalytics({ toolName, input, result, durationMs: Date.now() - startedAt });
      return result;
    } catch (error) {
      this.recordAnalytics({ toolName, input, error, durationMs: Date.now() - startedAt });
      throw error;
    } finally {
      for (const boardId of boardIds) {
        const remaining = (this.activeBoardCommands.get(boardId) ?? 1) - 1;
        if (remaining > 0) this.activeBoardCommands.set(boardId, remaining);
        else this.activeBoardCommands.delete(boardId);
      }
    }
  }

  private boardIdsForInvocation(toolName: string, input: unknown): string[] {
    if (toolName === "c2000_registerBoard") return [];
    const values = record(input);
    const leaseBoardId = record(values.__leaseContext).boardId;
    if (typeof leaseBoardId === "string") return [leaseBoardId];
    if (typeof values.sessionId === "string") {
      const session = this.sessions.get(values.sessionId);
      return session ? [session.boardId] : [];
    }
    if (typeof values.boardId === "string") return [values.boardId];
    if (toolName === "c2000_launchMultiBoardDebug" && Array.isArray(values.boards)) {
      return [...new Set(values.boards.map(item => record(item).boardId).filter((id): id is string => typeof id === "string"))];
    }
    if (["c2000_createDebugSession", "c2000_launchMulticoreDebug", "c2000_launchMulticoreDebugSafe", "c2000_launchMulticoreDebugWithActions", "c2000_launchAndRunIpcAcceptance", "c2000_launchResidentIpcDebug"].includes(toolName)) {
      const boards = this.registry.list();
      return boards.length === 1 ? [boards[0]!.boardId] : [];
    }
    return [];
  }

  private recordAnalytics(input: { toolName: string; input?: unknown; result?: Record<string, unknown>; error?: unknown; durationMs: number }): void {
    try {
      this.analytics?.recordToolInvocation(input);
    } catch {
      // Analytics is best effort and must never alter target/debug semantics.
    }
  }

  private async invokeToolInternal(toolName: string, input: unknown): Promise<Record<string, unknown>> {
    if (this.variableStreams) {
      if (toolName === "c2000_startVariableStream") {
        this.assertObserverTargetIdentity(toolName, input);
        return this.variableStreams.start(input);
      }
      if (toolName === "c2000_stopVariableStream") return this.variableStreams.stop(input);
      if (toolName === "c2000_getVariableStreamStatus") return this.variableStreams.status(input);
      if (toolName === "c2000_readVariableSamples") return this.variableStreams.readSamples(input);
      if (toolName === "c2000_exportVariableStream") return this.variableStreams.export(input);
    }
    if (this.dlog) {
      if (["c2000_describeDlogBuffer", "c2000_getDlogStatus", "c2000_readDlogBuffer", "c2000_exportDlog"].includes(toolName)) {
        this.assertObserverTargetIdentity(toolName, input);
        if (toolName === "c2000_describeDlogBuffer") return this.dlog.describe(input);
        if (toolName === "c2000_getDlogStatus") return this.dlog.status(input);
        if (toolName === "c2000_readDlogBuffer") return this.dlog.read(input);
        return this.dlog.export(input);
      }
    }
    if (this.erad) {
      if (["c2000_getEradCapabilities", "c2000_readClaTaskTiming", "c2000_configureEradProfile", "c2000_startEradProfile", "c2000_stopEradProfile", "c2000_readEradProfile", "c2000_exportEradProfile"].includes(toolName)) {
        this.assertObserverTargetIdentity(toolName, input);
        if (toolName === "c2000_getEradCapabilities") return this.erad.capabilities(input);
        if (toolName === "c2000_readClaTaskTiming") return this.erad.readClaTaskTiming(input);
        if (toolName === "c2000_configureEradProfile") return this.erad.configure(input);
        if (toolName === "c2000_startEradProfile") return this.erad.start(input);
        if (toolName === "c2000_stopEradProfile") return this.erad.stop(input);
        if (toolName === "c2000_readEradProfile") return this.erad.read(input);
        return this.erad.export(input);
      }
    }
    if (toolName === "c2000_launchMultiBoardDebug") {
      return this.launchMultiBoard(input);
    }
    const sessionId = record(input).sessionId;
    if (typeof sessionId === "string") {
      const session = this.sessions.get(sessionId);
      if (session) {
        const interactive = this.interactiveLeases.get(sessionId);
        const timeoutMs = this.workers.commandTimeoutMs(toolName, input);
        if (interactive) this.registry.leases.renew(interactive.lease.leaseId, interactive.leaseToken, leaseTtlMs(timeoutMs));
        await this.assertResidentImageIdentity(session.boardId, toolName, input);
        const invocation = this.withLeaseInput(input, interactive);
        let result: Record<string, unknown>;
        try {
          result = await this.workers.invokeBoard(session.boardId, toolName, invocation, timeoutMs);
        } catch (error) {
          this.invalidateTargetIdentityAfterFailure(session.boardId, toolName, input);
          throw error;
        }
        this.recordTargetMutation(session.boardId, toolName, input, result);
        await this.recordVerifiedResidentImage(session.boardId, toolName, input, result);
        if (toolName === "c2000_closeDebugSession" && isConfirmedSessionClose(result, sessionId)) {
          this.sessions.close(sessionId);
          this.releaseInteractiveLease(sessionId);
        }
        return result;
      }
      // Compatibility for sessions that pre-date worker routing or no-board mock configurations.
      return this.local.invokeTool(toolName, input);
    }
    if ([
      "c2000_createDebugSession",
      "c2000_launchMulticoreDebug",
      "c2000_launchMulticoreDebugSafe",
      "c2000_launchMulticoreDebugWithActions",
      "c2000_launchAndRunIpcAcceptance",
      "c2000_launchResidentIpcDebug"
    ].includes(toolName)) {
      const boardId = this.selectBoard(record(input).boardId);
      const supplied = readLease(input);
      const timeoutMs = this.workers.commandTimeoutMs(toolName, input);
      const interactive = supplied
        ? undefined
        : await this.acquireInteractiveLease(boardId, leaseTtlMs(timeoutMs), toolName, input);
      try {
        await this.assertResidentImageIdentity(boardId, toolName, input);
        let result: Record<string, unknown>;
        try {
          result = await this.workers.invokeBoard(boardId, toolName, this.withLeaseInput(input, interactive), timeoutMs);
        } catch (error) {
          this.invalidateTargetIdentityAfterFailure(boardId, toolName, input);
          throw error;
        }
        this.recordTargetMutation(boardId, toolName, input, result);
        await this.recordVerifiedResidentImage(boardId, toolName, input, result);
        if (result.success === false && result.cleanedUp !== true && failedLaunchCleanupEnabled(toolName, input)) {
          const failedSessionId = launchSessionIdFromResult(result);
          if (failedSessionId) {
            const priorCleanup = logicalCleanupEvidence(result, failedSessionId);
            const cleanup = priorCleanup
              ? {
                cleanedUp: false,
                cleanupFinalized: true,
                cleanup: {
                  mode: "worker-failure-finalization",
                  closeConfirmed: false,
                  sessionClosed: true,
                  logicalSessionRemoved: true,
                  probeLeaseReleased: priorCleanup.probeLeaseReleased,
                  adapterDisposed: priorCleanup.adapterDisposed
                }
              }
              : await this.cleanupFailedLaunchSession(
                boardId,
                failedSessionId,
                input,
                interactive
              );
            result = {
              ...result,
              sessionId: failedSessionId,
              ...cleanup
            };
          }
        }
        if ((result.cleanedUp === true || result.cleanupFinalized === true) && typeof result.sessionId === "string") {
          // A workflow may return the failed session identity as evidence after
          // logically disposing it in the worker. Never resurrect that closed
          // session as OPEN in durable daemon state, even when adapter cleanup
          // reported a secondary failure.
          this.sessions.close(result.sessionId);
          if (interactive) this.releaseLease(interactive);
          return result;
        }
        const sessionPersisted = this.persistCreatedSession(boardId, input, result, toolName);
        if (interactive && sessionPersisted && typeof result.sessionId === "string") {
          this.interactiveLeases.set(result.sessionId, interactive);
        } else if (interactive) {
          this.releaseLease(interactive);
        }
        return result;
      } catch (error) {
        if (interactive) this.releaseLease(interactive);
        throw error;
      }
    }
    return this.local.invokeTool(toolName, input);
  }

  private async cycleBoardPower(input: z.infer<typeof cycleBoardPowerSchema>): Promise<Record<string, unknown>> {
    const { boardId, sessionId } = input;
    if (this.powerCycle?.safetyProfile === "readonly") {
      throw new DebugMcpError("PowerCycleUnavailable", "Board power control is disabled by the readonly safety profile", { boardId, targetAccessAttempted: false });
    }
    const board = this.registry.get(boardId);
    if (this.powerCycleInProgress.has(boardId) ||
        (board.status === "QUARANTINED" && String(board.lastError?.code ?? "").startsWith("PowerCycle"))) {
      throw new DebugMcpError("PowerCyclePending", "A board power transition is already pending", { boardId, powerCycle: board.lastError });
    }
    if (input.mode === "auto" && (!this.powerCycle?.enabled || !this.powerCycle.client)) {
      throw new DebugMcpError("PowerCycleUnavailable", "Automatic ble-lab-power MCP control is not configured", { boardId, targetAccessAttempted: false });
    }
    this.powerCycleInProgress.add(boardId);
    const requestId = randomUUID();
    let quarantined = false;
    try {
      // The first failed operation is durable before any cleanup or power action.
      if (input.reason === "connection_recovery") {
        this.powerCycle?.events.append({
          level: "warn", sourceType: "board", sourceId: boardId, boardId,
          eventType: "POWER_CYCLE_FIRST_FAILURE",
          payload: { requestId, sessionId, evidenceSource: "caller-reported", firstFailure: input.firstFailure }
        });
      }
      if (!this.powerCycle?.runs || !this.powerCycle.events) {
        throw new DebugMcpError("PowerCycleRequiresDaemon", "Power-cycle coordination requires daemon job and event repositories");
      }
      const activeJobs = this.powerCycle.runs.listActiveForBoard(boardId);
      const activeCommands = this.activeBoardCommands.get(boardId) ?? 0;
      if (activeJobs.length > 0 || activeCommands > 0) {
        throw new DebugMcpError("PowerCycleBusy", "Board has an active job or target command; Flash may still be in progress", {
          boardId, activeJobs, activeCommands, targetAccessAttempted: false
        });
      }
      const session = this.sessions.get(sessionId);
      const lease = this.interactiveLeases.get(sessionId);
      const activeLease = this.registry.leases.active(boardId);
      if (!session || session.boardId !== boardId || session.closedAt || !lease ||
          activeLease?.leaseId !== lease.lease.leaseId ||
          this.workers.currentWorker(boardId)?.workerInstanceId !== lease.context.workerInstanceId) {
        throw new DebugMcpError("PowerCycleSessionUnsafe", "The old session cannot be closed through its current fenced board lease", {
          boardId, sessionId, leaseId: activeLease?.leaseId, targetAccessAttempted: false
        });
      }
      const otherSessions = this.sessions.listByBoard(boardId).filter(item => !item.closedAt && item.sessionId !== sessionId);
      if (otherSessions.length > 0) {
        throw new DebugMcpError("PowerCycleBusy", "Another debug session still owns this board", {
          boardId, sessionIds: otherSessions.map(item => item.sessionId), targetAccessAttempted: false
        });
      }

      let flashVerification: Record<string, unknown> | undefined;
      if (input.reason === "after_flash") {
        const checks = input.flashChecks ?? [];
        for (const check of checks) {
          const loaded = await this.invokeToolInternal("c2000_getLoadedProgramInfo", { sessionId, coreId: check.coreId });
          const programUri = normalizeProgramUri(check.programUri, this.workspacePath);
          const metadata = await fileMetadata(programUri);
          if (loaded.success !== true || loaded.sessionId !== sessionId || loaded.coreId !== check.coreId ||
              loaded.targetMemoryWritten !== true || loaded.programUri !== programUri || loaded.sha256 !== metadata.sha256) {
            throw new DebugMcpError("PowerCycleFlashIncomplete", "Both current-session images must be successfully written and match their unchanged host artifacts", {
              boardId, sessionId, coreId: check.coreId, loaded, expectedSha256: metadata.sha256, powerActionAttempted: false
            });
          }
        }
        flashVerification = await this.invokeToolInternal("c2000_verifyResidentImage", {
          sessionId, checks, connectIfNeeded: false
        });
        if (flashVerification.success !== true || flashVerification.verified !== true ||
            flashVerification.verificationMethod !== "resident-image-manifest-raw-memory" ||
            !Array.isArray(flashVerification.checks) || flashVerification.checks.length !== checks.length) {
          throw new DebugMcpError("PowerCycleFlashUnverified", "Both programmed images must pass manifest-bound target readback before power cycling", {
            boardId, sessionId, flashVerification, powerActionAttempted: false
          });
        }
      }

      // Marker reads can take time; a durable job may have been submitted meanwhile.
      const jobsBeforeQuarantine = this.powerCycle.runs.listActiveForBoard(boardId);
      if (jobsBeforeQuarantine.length > 0) {
        throw new DebugMcpError("PowerCycleBusy", "A board job started while Flash verification was in progress", {
          boardId, activeJobs: jobsBeforeQuarantine, targetAccessAttempted: false, powerActionAttempted: false
        });
      }

      this.registry.transition(boardId, "QUARANTINED", {
        code: "PowerCycleInProgress", requestId, reason: input.reason, sessionId, requestedOffSeconds: input.offSeconds
      });
      quarantined = true;
      this.powerCycle.events.append({
        level: "info", sourceType: "board", sourceId: boardId, boardId,
        eventType: "POWER_CYCLE_PREPARED",
        payload: { requestId, sessionId, reason: input.reason, mode: input.mode, flashVerification }
      });
      const close = await this.invokeToolInternal("c2000_closeDebugSession", { sessionId });
      const leaseAfterClose = this.registry.leases.describe(boardId, this.workers.currentWorker(boardId)?.workerInstanceId);
      if (!isConfirmedSessionClose(close, sessionId) || leaseAfterClose.status !== "NONE") {
        throw new DebugMcpError("PowerCycleSessionCloseFailed", "Old debug session and board lease were not both confirmed closed; board remains quarantined", {
          boardId, sessionId, close, leaseAfterClose, powerActionAttempted: false
        });
      }
      this.registry.markTargetIdentityUnknown(boardId, `power-cycle:pending:${requestId}`);

      let response: Record<string, unknown>;
      try {
        response = this.powerCycle.enabled && this.powerCycle.client
          ? await this.powerCycle.client.powercycle({
              device: "lab_power", off_seconds: input.offSeconds, mode: input.mode, reason: input.reason
            })
          : { status: "manual_required", reason: "ble_lab_power_mcp_not_configured", protocol_verified: false, physical_state: null };
      } catch (error) {
        response = {
          status: "manual_required", reason: "automatic_cycle_failed", protocol_verified: false,
          physical_state: null, may_remain_off: true, error: toStructuredError(error)
        };
      }
      const automaticComplete = response.status === "completed" && response.protocol_verified === true &&
        response.device === "lab_power" && response.trigger === input.reason && response.mode_used === "auto" &&
        typeof response.off_hold_seconds === "number" && response.off_hold_seconds >= input.offSeconds;
      if (automaticComplete) {
        this.registry.transition(boardId, this.workers.currentWorker(boardId) ? "READY" : "AVAILABLE");
        this.powerCycle.events.append({
          level: "info", sourceType: "board", sourceId: boardId, boardId,
          eventType: "POWER_CYCLE_PROTOCOL_COMPLETED",
          payload: { requestId, sessionId, reason: input.reason, response, physicalStateVerified: false }
        });
        return {
          success: true, status: "completed", boardId, requestId, reason: input.reason,
          oldSessionId: sessionId, oldSessionClosed: true, oldLeaseReleased: true,
          protocolVerified: true, physicalState: null, coldStartVerified: false,
          targetImageIdentity: "UNKNOWN", reconnectRequired: true, identityVerificationRequired: true,
          ...(flashVerification ? { flashVerification } : {}), powerCycle: response
        };
      }

      this.registry.transition(boardId, "QUARANTINED", {
        code: "PowerCycleManualRequired", requestId, reason: input.reason,
        requestedOffSeconds: input.offSeconds, powerCycle: response
      });
      this.powerCycle.events.append({
        level: "warn", sourceType: "board", sourceId: boardId, boardId,
        eventType: "POWER_CYCLE_MANUAL_REQUIRED",
        payload: { requestId, sessionId, reason: input.reason, response }
      });
      return {
        success: false, status: "manual_required", boardId, requestId, reason: input.reason,
        oldSessionId: sessionId, oldSessionClosed: true, oldLeaseReleased: true,
        protocolVerified: false, physicalState: null, coldStartVerified: false,
        targetImageIdentity: "UNKNOWN", reconnectRequired: true, identityVerificationRequired: true,
        instruction: `Remove board power for at least ${input.offSeconds} seconds, restore it, then call c2000_confirmManualPowerCycle with this requestId.`,
        ...(flashVerification ? { flashVerification } : {}), powerCycle: response
      };
    } catch (error) {
      if (!quarantined) throw error;
      this.powerCycle?.events.append({
        level: "error", sourceType: "board", sourceId: boardId, boardId,
        eventType: "POWER_CYCLE_BLOCKED",
        payload: { requestId, sessionId, reason: input.reason, cause: toStructuredError(error), powerActionMayHaveStarted: this.registry.targetIdentity(boardId).requiresVerificationAfterPowerCycle === true }
      });
      throw new DebugMcpError("PowerCycleSessionCloseFailed", "Power transition is blocked and the board remains quarantined; inspect the old session and complete a supervised manual cycle", {
        boardId, sessionId, requestId, cause: toStructuredError(error), boardQuarantined: true,
        nextAction: "Confirm the old debug session and lease are closed. Manually remove power for the requested interval, restore it, then call c2000_confirmManualPowerCycle."
      });
    } finally {
      this.powerCycleInProgress.delete(boardId);
    }
  }

  private confirmManualPowerCycle(input: z.infer<typeof confirmManualPowerCycleSchema>): Record<string, unknown> {
    if (this.powerCycle?.safetyProfile === "readonly") {
      throw new DebugMcpError("PowerCycleUnavailable", "Board power control is disabled by the readonly safety profile", { boardId: input.boardId });
    }
    const board = this.registry.get(input.boardId);
    const pending = record(board.lastError);
    if (board.status !== "QUARANTINED" || !["PowerCycleManualRequired", "PowerCycleInProgress"].includes(String(pending.code)) || pending.requestId !== input.requestId) {
      throw new DebugMcpError("PowerCycleConfirmationInvalid", "No matching manual power-cycle request is pending", {
        boardId: input.boardId, requestId: input.requestId
      });
    }
    const required = Number(pending.requestedOffSeconds);
    if (!Number.isFinite(required) || input.observedOffSeconds < required) {
      throw new DebugMcpError("PowerCycleConfirmationInvalid", "Operator-observed power-off interval is shorter than requested", {
        boardId: input.boardId, requiredOffSeconds: required, observedOffSeconds: input.observedOffSeconds
      });
    }
    if (this.powerCycleInProgress.has(input.boardId) || (this.activeBoardCommands.get(input.boardId) ?? 0) > 0 ||
        this.registry.leases.describe(input.boardId, this.workers.currentWorker(input.boardId)?.workerInstanceId).status !== "NONE" ||
        this.powerCycle?.runs.listActiveForBoard(input.boardId).length ||
        this.sessions.listByBoard(input.boardId).some(session => !session.closedAt)) {
      throw new DebugMcpError("PowerCycleBusy", "Board is not idle for manual power-cycle confirmation", { boardId: input.boardId });
    }
    if (!this.registry.targetIdentity(input.boardId).requiresVerificationAfterPowerCycle) {
      this.registry.markTargetIdentityUnknown(input.boardId, `power-cycle:manual-confirmed:${input.requestId}`);
    }
    this.registry.transition(input.boardId, this.workers.currentWorker(input.boardId) ? "READY" : "AVAILABLE");
    this.powerCycle?.events.append({
      level: "info", sourceType: "board", sourceId: input.boardId, boardId: input.boardId,
      eventType: "POWER_CYCLE_MANUAL_CONFIRMED",
      payload: { requestId: input.requestId, observedOffSeconds: input.observedOffSeconds, evidenceSource: "operator-attested", physicalStateVerified: false }
    });
    return {
      success: true, status: "operator_confirmed", boardId: input.boardId, requestId: input.requestId,
      protocolVerified: false, physicalState: null, coldStartVerified: false,
      targetImageIdentity: "UNKNOWN", reconnectRequired: true, identityVerificationRequired: true
    };
  }

  private async acquireInteractiveLease(
    boardId: string,
    ttlMs = 60000,
    replacingToolName?: string,
    replacingInput?: unknown
  ): Promise<LeasedBoard> {
    const worker = await this.workers.ensureWorker(boardId);
    if (replacingToolName === "c2000_launchResidentIpcDebug" &&
        record(replacingInput).replaceExistingResidentSession !== false) {
      await this.closeReplaceableResidentSessions(boardId, worker.workerInstanceId, ttlMs);
    }
    return this.registry.leases.acquire({
      boardId,
      ownerJobId: `interactive-${randomId()}`,
      workerInstanceId: worker.workerInstanceId,
      ttlMs
    });
  }

  /**
   * A resident attach is interactive, so its old session can outlive the MCP
   * frontend that created it. Close only MCP-owned resident sessions through
   * their existing fenced lease before taking a new board lease. This keeps
   * probe cleanup on the normal close path and avoids queueing behind a stale
   * resident ticket.
   */
  private async closeReplaceableResidentSessions(boardId: string, workerInstanceId: string, timeoutMs: number): Promise<void> {
    const candidates = this.sessions.listByBoard(boardId)
      .filter(session => session.status === "OPEN" && isReplaceableResidentSession(session.sessionName));
    for (const session of candidates) {
      const interactive = this.interactiveLeases.get(session.sessionId);
      const activeLease = this.registry.leases.active(boardId);
      const canNormalClose = Boolean(
        interactive
        && interactive.context.workerInstanceId === workerInstanceId
        && activeLease?.leaseId === interactive.context.leaseId
      );
      let result: Record<string, unknown>;
      if (canNormalClose) {
        const closeInput = { sessionId: session.sessionId, __leaseContext: interactive!.context };
        result = await this.workers.invokeBoard(boardId, "c2000_closeDebugSession", closeInput, timeoutMs);
      } else {
        if (activeLease) {
          throw new DebugMcpError("BoardLeased", "A previous resident session cannot be recovered while another live board lease is active", {
            boardId,
            sessionId: session.sessionId,
            sessionName: session.sessionName,
            leaseId: activeLease.leaseId,
            ownerJobId: activeLease.ownerJobId,
            targetAccessAttempted: false,
            nextAction: "Release the live board lease through its owning MCP session; no new probe request was queued."
          });
        }
        if (session.workerInstanceId !== workerInstanceId) {
          throw new DebugMcpError("ProbeRecoveryBlocked", "The resident session belongs to a different or stale worker generation; refusing to guess which process owns the probe", {
            boardId,
            sessionId: session.sessionId,
            sessionName: session.sessionName,
            expectedWorkerInstanceId: workerInstanceId,
            persistedWorkerInstanceId: session.workerInstanceId,
            targetAccessAttempted: false,
            nextAction: "Use the MCP session that created the resident session, or restart the daemon after confirming no external CCS/DSS owner remains."
          });
        }
        try {
          result = await this.workers.closeStaleResidentSession(
            boardId,
            session.sessionId,
            workerInstanceId,
            Math.min(timeoutMs, 15_000)
          );
        } catch (error) {
          throw new DebugMcpError("ProbeRecoveryBlocked", "The expired resident lease was not recoverable within the bounded cleanup window; the new request was not queued", {
            boardId,
            sessionId: session.sessionId,
            sessionName: session.sessionName,
            targetAccessAttempted: false,
            nextAction: "Retry the resident launch after the old worker finishes cleanup, or inspect the worker/CCS owner; no lock was force-deleted.",
            cause: toStructuredError(error)
          });
        }
      }
      if (!isConfirmedSessionClose(result, session.sessionId)) {
        const details = record(record(result.error).details);
        throw new DebugMcpError("WorkflowCleanupFailed", "The previous resident session did not confirm adapter and probe cleanup; the new request was not started", {
          boardId,
          sessionId: session.sessionId,
          sessionName: session.sessionName,
          closeResult: result,
          cleanup: record(details.cleanup),
          nextAction: "Retry c2000_closeDebugSession so the same owned probe lease can be released normally."
        });
      }
      this.sessions.close(session.sessionId);
      this.releaseInteractiveLease(session.sessionId);
    }
  }

  private withLeaseInput(input: unknown, interactive?: LeasedBoard): unknown {
    if (readLease(input) || !interactive) return input;
    return { ...record(input), __leaseContext: interactive.context };
  }

  private releaseInteractiveLease(sessionId: string): void {
    const lease = this.interactiveLeases.get(sessionId);
    if (!lease) return;
    this.interactiveLeases.delete(sessionId);
    this.releaseLease(lease);
  }

  private releaseLease(lease: LeasedBoard): void {
    try { this.registry.leases.release(lease.lease.leaseId, lease.leaseToken); } catch { /* already expired or invalidated */ }
  }

  private selectBoard(value: unknown): string {
    const boards = this.registry.list();
    if (typeof value === "string") {
      if (boards.some(board => board.boardId === value)) return value;
      throw boardRegistrationError({
        requestedBoardId: value,
        registeredBoardIds: boards.map(board => board.boardId)
      });
    }
    if (boards.length === 0) throw boardRegistrationError({ registeredBoardIds: [] });
    if (boards.length === 1) return boards[0]!.boardId;
    throw new DebugMcpError("ProbeBindingMissing", "Multiple registered boards require an explicit boardId", { boardIds: boards.map(board => board.boardId) });
  }

  private persistCreatedSession(
    boardId: string,
    input: unknown,
    result: Record<string, unknown>,
    toolName?: string
  ): boolean {
    if (typeof result.sessionId !== "string") return false;
    const values = record(input);
    if (values.sessionMode === "ephemeral") return false;
    const requestedSessionName = typeof values.sessionName === "string" ? values.sessionName : "c2000-debug-session";
    const sessionName = toolName === "c2000_launchResidentIpcDebug" && !isReplaceableResidentSession(requestedSessionName)
      ? `launch-resident-ipc-debug:${requestedSessionName}`
      : requestedSessionName;
    this.sessions.upsert({
      sessionId: result.sessionId,
      boardId,
      ...(typeof result.workerInstanceId === "string" ? { workerInstanceId: result.workerInstanceId } : {}),
      sessionName,
      ...(typeof result.adapterSessionId === "string" ? { adapterSessionId: result.adapterSessionId } : {}),
      ...(typeof values.ccxmlPath === "string" ? { ccxmlPath: values.ccxmlPath } : {}),
      coreMap: Array.isArray(values.coreMap) ? values.coreMap : Array.isArray(values.cores) ? values.cores : [],
      status: "OPEN",
      createdAt: new Date().toISOString()
    });
    return true;
  }

  /**
   * A worker can return a structured failure after creating its logical
   * session.  Finalize that session on the same fenced worker before the
   * launch path decides whether to persist it; otherwise an interactive lease
   * can survive a failed one-shot and block recovery.
   */
  private async cleanupFailedLaunchSession(
    boardId: string,
    sessionId: string,
    originalInput: unknown,
    interactive?: LeasedBoard
  ): Promise<Record<string, unknown>> {
    const startedAt = Date.now();
    const leaseInput = readLease(originalInput)
      ? { sessionId, __leaseContext: readLease(originalInput) }
      : interactive
        ? { sessionId, __leaseContext: interactive.context }
        : { sessionId };
    try {
      const closeResult = await this.workers.invokeBoard(
        boardId,
        "c2000_closeDebugSession",
        leaseInput,
        this.workers.commandTimeoutMs("c2000_closeDebugSession", leaseInput)
      );
      if (isConfirmedSessionClose(closeResult, sessionId)) {
        this.sessions.close(sessionId);
        if (interactive) this.releaseLease(interactive);
        return {
          cleanedUp: true,
          cleanup: {
            mode: "router-failure-finalization",
            closeConfirmed: true,
            sessionClosed: true,
            probeLeaseReleased: Boolean(interactive),
            closeResult,
            durationMs: Date.now() - startedAt
          }
        };
      }
      const partialCleanup = logicalCleanupEvidence(closeResult, sessionId);
      if (partialCleanup) {
        this.sessions.close(sessionId);
        if (interactive) this.releaseLease(interactive);
        return {
          cleanedUp: false,
          cleanupFinalized: true,
          cleanup: {
            mode: "router-failure-finalization",
            closeConfirmed: false,
            sessionClosed: true,
            logicalSessionRemoved: true,
            probeLeaseReleased: partialCleanup.probeLeaseReleased,
            adapterDisposed: partialCleanup.adapterDisposed,
            closeResult,
            durationMs: Date.now() - startedAt
          },
          cleanupError: record(closeResult.error)
        };
      }
      return {
        cleanedUp: false,
        cleanupError: {
          code: "SessionCloseUnconfirmed",
          message: "Failed launch returned a session, but the worker did not confirm its closure",
          details: { sessionId, closeResult, durationMs: Date.now() - startedAt }
        }
      };
    } catch (error) {
      const structured = toStructuredError(error);
      const partialCleanup = logicalCleanupEvidence({
        success: false,
        sessionId,
        error: structured
      }, sessionId);
      if (partialCleanup) {
        this.sessions.close(sessionId);
        if (interactive) this.releaseLease(interactive);
        return {
          cleanedUp: false,
          cleanupFinalized: true,
          cleanup: {
            mode: "router-failure-finalization",
            closeConfirmed: false,
            sessionClosed: true,
            logicalSessionRemoved: true,
            probeLeaseReleased: partialCleanup.probeLeaseReleased,
            adapterDisposed: partialCleanup.adapterDisposed,
            durationMs: Date.now() - startedAt
          },
          cleanupError: structured
        };
      }
      return {
        cleanedUp: false,
        cleanupError: {
          ...structured,
          details: {
            ...(structured.details ?? {}),
            sessionId,
            durationMs: Date.now() - startedAt
          }
        }
      };
    }
  }

  /**
   * Resident-symbol and observation operations are valid only when the
   * current lease has a known target-image identity.  The check happens in
   * the daemon before the worker is invoked, so a stale Scope session cannot
   * reset/run a target with mismatched symbols.
   */
  private async assertResidentImageIdentity(boardId: string, toolName: string, input: unknown): Promise<void> {
    const requirements = residentImageRequirements(toolName, input);
    if (requirements.length === 0) return;
    const values = record(input);
    const existingIdentity = this.registry.targetIdentity(boardId);
    const missingCoreIds = requirements
      .map(item => item.coreId)
      .filter(coreId => !existingIdentity.programs[String(coreId)]);
    const manifestVerificationRequested = hasResidentManifestVerification(toolName, input);
    const operatorConfirmed = (toolName === "c2000_launchResidentIpcDebug" || toolName === "c2000_runResidentIpcDebug")
      && values.residentIdentityPolicy !== "require-known";
    const manifestChecks = Array.isArray(values.residentImageManifests) ? values.residentImageManifests.map(record) : [];
    const completePostCycleManifest = manifestChecks.length === requirements.length &&
      requirements.every(requirement => manifestChecks.some(check => check.coreId === requirement.coreId));
    if (existingIdentity.requiresVerificationAfterPowerCycle &&
        (toolName === "c2000_runResidentIpcDebug" || toolName === "c2000_launchResidentIpcDebug") &&
        !completePostCycleManifest) {
      throw new DebugMcpError("TargetImageIdentityUnknown", "Power cycling requires a fresh manifest-backed target image verification before resident Flash startup or IPC conclusions", {
        boardId, targetGeneration: existingIdentity.generation, targetAccessAttempted: false,
        nextAction: "Reconnect with a fresh session and provide CPU1/CPU2 residentImageManifests, or intentionally reprogram the exact pair through MCP."
      });
    }
    if ((existingIdentity.status !== "KNOWN" || missingCoreIds.length > 0) &&
        !operatorConfirmed && !manifestVerificationRequested) {
      this.registry.requireKnownTargetIdentity(boardId, requirements.map(item => item.coreId));
    }
    if (existingIdentity.status !== "KNOWN" || missingCoreIds.length > 0) {
      if (operatorConfirmed) {
        await this.assertLastKnownResidentArtifacts(boardId, requirements, existingIdentity);
      }
      // The resident workflow will establish identity through its read-only
      // manifest marker before symbols are loaded. Do not force a separate
      // verifyResidentImage round trip when that evidence was supplied.
      return;
    }
    const identity = existingIdentity;
    for (const requirement of requirements) {
      const expected = identity.programs[String(requirement.coreId)];
      const requestedProgramUri = requirement.programUri ?? expected?.programUri;
      if (!requestedProgramUri) continue;
      try {
        const normalizedRequestedUri = normalizeProgramUri(requestedProgramUri, this.workspacePath);
        const metadata = await fileMetadata(normalizedRequestedUri);
        if (metadata.sha256 !== expected?.sha256) {
          throw new DebugMcpError("TargetImageMismatch", "Requested symbols do not match the image recorded for the resident target", {
            boardId,
            coreId: requirement.coreId,
            targetGeneration: identity.generation,
            expectedSha256: expected?.sha256,
            requestedSha256: metadata.sha256,
            requestedProgramUri: normalizedRequestedUri,
            nextAction: "Discard the old observation session and load the exact CPU1/CPU2 image pair under one fresh board lease."
          });
        }
      } catch (error) {
        if (error instanceof DebugMcpError) throw error;
        throw new DebugMcpError("TargetImageMismatch", "The requested resident-image artifact could not be hashed for identity verification", {
          boardId,
          coreId: requirement.coreId,
          programUri: requestedProgramUri,
          targetGeneration: identity.generation,
          cause: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }

  private async assertLastKnownResidentArtifacts(
    boardId: string,
    requirements: ImageRequirement[],
    identity: ReturnType<BoardRegistry["targetIdentity"]>
  ): Promise<void> {
    const lastKnown = identity.lastKnownPrograms ?? {};
    for (const requirement of requirements) {
      const expected = lastKnown[String(requirement.coreId)];
      const requestedProgramUri = requirement.programUri ?? expected?.programUri;
      if (!expected || !requestedProgramUri) continue;
      try {
        const normalizedRequestedUri = normalizeProgramUri(requestedProgramUri, this.workspacePath);
        const metadata = await fileMetadata(normalizedRequestedUri);
        if (metadata.sha256 !== expected.sha256) {
          throw new DebugMcpError("TargetImageMismatch", "Requested symbols do not match the last image recorded for this board; operator confirmation cannot override an artifact mismatch", {
            boardId,
            coreId: requirement.coreId,
            targetGeneration: identity.generation,
            expectedSha256: expected.sha256,
            requestedSha256: metadata.sha256,
            requestedProgramUri: normalizedRequestedUri,
            nextAction: "Use the exact CPU1/CPU2 image pair that was programmed, or intentionally program and record the new pair through MCP."
          });
        }
      } catch (error) {
        if (error instanceof DebugMcpError) throw error;
        throw new DebugMcpError("TargetImageMismatch", "The requested resident-image artifact could not be checked against the last MCP image evidence", {
          boardId,
          coreId: requirement.coreId,
          programUri: requestedProgramUri,
          targetGeneration: identity.generation,
          cause: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }

  private assertObserverTargetIdentity(toolName: string, input: unknown): void {
    const values = record(input);
    const boardId = typeof values.boardId === "string" ? values.boardId : undefined;
    const coreIds = observerCoreIds(toolName, values);
    if (!boardId || coreIds.length === 0) return;
    this.registry.requireKnownTargetIdentity(boardId, coreIds);
  }

  private recordTargetMutation(boardId: string, toolName: string, input: unknown, result: Record<string, unknown>): void {
    if (!isTargetMutationTool(toolName)) return;
    // The single-core load handler returns LoadedProgramInfo directly and
    // therefore has no batch-level `loaded: true` marker.  Its successful
    // result is nevertheless authoritative target-write evidence.
    const collected = collectTargetProgramMutations(result, toolName === "c2000_loadProgram");
    if (collected.failed > 0 || (shouldAttemptProgramMutation(toolName, input) && result.success === false && collected.programs.length === 0)) {
      this.registry.markTargetIdentityUnknown(boardId, `target-operation-failed:${toolName}`);
      return;
    }
    if (collected.programs.length > 0) {
      this.registry.recordTargetPrograms(boardId, collected.programs, `target-operation:${toolName}`);
    }
  }

  /**
   * Promote UNKNOWN only after the worker reports a complete, successful
   * manifest verification and the daemon independently re-hashes every host
   * artifact. This is evidence recording, not a target mutation.
   */
  private async recordVerifiedResidentImage(
    boardId: string,
    toolName: string,
    input: unknown,
    result: Record<string, unknown>
  ): Promise<void> {
    const directVerification = toolName === "c2000_verifyResidentImage" ? result : record(result.residentVerification);
    const workflowVerification = toolName === "c2000_runResidentIpcDebug" || toolName === "c2000_launchResidentIpcDebug";
    if (!workflowVerification && toolName !== "c2000_verifyResidentImage") return;
    if (directVerification.success !== true || directVerification.verified !== true) return;
    if (directVerification.verificationMethod !== "resident-image-manifest-raw-memory") {
      throw new DebugMcpError("ResidentImageVerificationInvalid", "Resident-image verification did not report the required verification method", { boardId, targetMemoryWritten: false });
    }
    const access = record(directVerification.targetAccess);
    if (access.programming !== false || access.symbolLoad !== false || access.reset !== false || access.run !== false || access.targetMemoryWrite !== false) {
      throw new DebugMcpError("ResidentImageVerificationInvalid", "Resident-image verification reported an unsafe target access", { boardId, targetMemoryWritten: false });
    }
    const inputChecks = workflowVerification
      ? record(input).residentImageManifests
      : record(input).checks;
    const requested = Array.isArray(inputChecks) ? inputChecks.map(record) : [];
    const reported = Array.isArray(directVerification.checks) ? directVerification.checks.map(record) : [];
    if (requested.length === 0 || requested.length !== reported.length) {
      throw new DebugMcpError("ResidentImageVerificationInvalid", "Resident-image verification did not return one result for each requested core", { boardId, requestedChecks: requested.length, reportedChecks: reported.length, targetMemoryWritten: false });
    }

    const programs: TargetProgramMutation[] = [];
    for (const request of requested) {
      const coreId = typeof request.coreId === "number" ? request.coreId : undefined;
      const match = reported.find(candidate => candidate.coreId === coreId);
      const programUri = typeof request.programUri === "string"
        ? normalizeProgramUri(request.programUri, this.workspacePath)
        : typeof match?.programUri === "string" ? normalizeProgramUri(match.programUri, this.workspacePath) : undefined;
      const manifestUri = typeof request.manifestUri === "string" ? normalizeProgramUri(request.manifestUri, this.workspacePath) : undefined;
      const marker = record(match?.marker);
      if (coreId === undefined || !programUri || !manifestUri || !match || marker.matched !== true) {
        throw new DebugMcpError("ResidentImageVerificationInvalid", "Resident-image verification returned incomplete core evidence", { boardId, coreId, targetMemoryWritten: false });
      }
      const [programMetadata, manifestMetadata] = await Promise.all([fileMetadata(programUri), fileMetadata(manifestUri)]);
      if ((typeof request.programUri === "string" && match.programUri !== programUri) || match.manifestUri !== manifestUri ||
          match.programSha256 !== programMetadata.sha256 || match.manifestSha256 !== manifestMetadata.sha256) {
        throw new DebugMcpError("ResidentImageVerificationInvalid", "Resident-image verification artifact metadata changed before daemon recording", {
          boardId,
          coreId,
          programUri,
          manifestUri,
          targetMemoryWritten: false
        });
      }
      programs.push({ coreId, programUri, sha256: programMetadata.sha256 });
    }
    this.registry.recordVerifiedResidentPrograms(boardId, programs);
  }

  private invalidateTargetIdentityAfterFailure(boardId: string, toolName: string, input: unknown): void {
    if (isTargetMutationTool(toolName) && shouldAttemptProgramMutation(toolName, input)) {
      this.registry.markTargetIdentityUnknown(boardId, `target-operation-threw:${toolName}`);
    }
  }

  private async launchMultiBoard(input: unknown): Promise<Record<string, unknown>> {
    const values = record(input);
    const boards = Array.isArray(values.boards) ? values.boards : [];
    if (boards.length === 0) return this.local.invokeTool("c2000_launchMultiBoardDebug", input);
    const results: Array<Record<string, unknown>> = await Promise.all(boards.map(async boardInput => {
      const boardValues = record(boardInput);
      const boardId = this.findBoardId(boardValues);
      const workerInput = {
        boardId,
        ccsInstallPath: values.ccsInstallPath,
        sessionName: boardValues.sessionName,
        cores: boardValues.cores
      };
      const timeoutMs = this.workers.commandTimeoutMs("c2000_launchMulticoreDebug", workerInput);
      const interactive = await this.acquireInteractiveLease(boardId, leaseTtlMs(timeoutMs));
      try {
        const result = await this.workers.invokeBoard(boardId, "c2000_launchMulticoreDebug", {
          ...workerInput,
          __leaseContext: interactive.context
        }, timeoutMs);
        this.recordTargetMutation(boardId, "c2000_launchMulticoreDebug", boardInput, result);
        const sessionPersisted = this.persistCreatedSession(boardId, boardInput, result);
        if (sessionPersisted && typeof result.sessionId === "string") {
          this.interactiveLeases.set(result.sessionId, interactive);
        } else {
          this.releaseLease(interactive);
        }
        return { boardId, probeSerial: this.registry.get(boardId).probeSerial, ...result };
      } catch (error) {
        this.invalidateTargetIdentityAfterFailure(boardId, "c2000_launchMulticoreDebug", boardInput);
        this.releaseLease(interactive);
        throw error;
      }
    }));
    const failed = results.filter(result => result.success !== true);
    return {
      success: failed.length === 0,
      timestamp: new Date().toISOString(),
      workflow: "c2000_launchMultiBoardDebug",
      results,
      ...(failed.length ? { error: { code: "BatchOperationFailed", message: `${failed.length} board launch(es) failed`, details: { failed } } } : {})
    };
  }

  private findBoardId(input: Record<string, unknown>): string {
    if (typeof input.boardId === "string") return this.selectBoard(input.boardId)!;
    if (typeof input.probeSerial === "string") {
      const board = this.registry.list().find(candidate => candidate.probeSerial === input.probeSerial);
      if (board) return board.boardId;
    }
    throw new DebugMcpError("ProbeBindingMissing", "Multi-board launch entry does not map to a registered board", { boardId: input.boardId, probeSerial: input.probeSerial });
  }
}

function readLease(input: unknown): unknown {
  return record(input).__leaseContext;
}

interface ImageRequirement {
  coreId: number;
  programUri?: string;
}

function hasResidentManifestVerification(toolName: string, input: unknown): boolean {
  if (toolName !== "c2000_runResidentIpcDebug" && toolName !== "c2000_launchResidentIpcDebug") return false;
  const manifests = record(input).residentImageManifests;
  return Array.isArray(manifests) && manifests.length > 0;
}

function residentImageRequirements(toolName: string, input: unknown): ImageRequirement[] {
  const values = record(input);
  if (toolName === "c2000_loadSymbols" && typeof values.coreId === "number" && typeof values.programUri === "string") {
    return [{ coreId: values.coreId, programUri: values.programUri }];
  }
  if ((toolName === "c2000_runIpcAcceptance" || toolName === "c2000_launchAndRunIpcAcceptance" || toolName === "c2000_runResidentIpcDebug" || toolName === "c2000_launchResidentIpcDebug") &&
      (toolName === "c2000_runResidentIpcDebug" || toolName === "c2000_launchResidentIpcDebug" || values.programPreparation === "symbols-only")) {
    const cpu1CoreId = typeof values.cpu1CoreId === "number"
      ? values.cpu1CoreId
      : toolName === "c2000_launchResidentIpcDebug" ? 0 : undefined;
    const cpu2CoreId = typeof values.cpu2CoreId === "number"
      ? values.cpu2CoreId
      : toolName === "c2000_launchResidentIpcDebug" ? 2 : undefined;
    return [
      ...(typeof cpu1CoreId === "number" ? [{ coreId: cpu1CoreId, programUri: stringValue(values.cpu1OutPath) }] : []),
      ...(typeof cpu2CoreId === "number" ? [{ coreId: cpu2CoreId, programUri: stringValue(values.cpu2OutPath) }] : [])
    ];
  }
  return [];
}

function observerCoreIds(toolName: string, input: Record<string, unknown>): number[] {
  const observerTools = new Set([
    "c2000_startVariableStream",
    "c2000_describeDlogBuffer",
    "c2000_getDlogStatus",
    "c2000_readDlogBuffer",
    "c2000_exportDlog",
    "c2000_getEradCapabilities",
    "c2000_readClaTaskTiming",
    "c2000_configureEradProfile",
    "c2000_startEradProfile",
    "c2000_stopEradProfile",
    "c2000_readEradProfile",
    "c2000_exportEradProfile"
  ]);
  return observerTools.has(toolName) && typeof input.coreId === "number" ? [input.coreId] : [];
}

function isTargetMutationTool(toolName: string): boolean {
  return new Set([
    "c2000_loadProgram",
    "c2000_loadPrograms",
    "c2000_reloadResetRunToMain",
    "c2000_launchMulticoreDebug",
    "c2000_launchMulticoreDebugSafe",
    "c2000_launchMulticoreDebugWithActions",
    "c2000_launchAndRunIpcAcceptance",
    "c2000_runIpcAcceptance",
    "c2000_runReloadAndDiagnose"
  ]).has(toolName);
}

function shouldAttemptProgramMutation(toolName: string, input: unknown): boolean {
  const values = record(input);
  if (toolName === "c2000_runIpcAcceptance" || toolName === "c2000_launchAndRunIpcAcceptance") {
    return values.programPreparation !== "symbols-only";
  }
  if (toolName === "c2000_launchMulticoreDebug" || toolName === "c2000_launchMulticoreDebugSafe" || toolName === "c2000_launchMulticoreDebugWithActions") {
    return values.loadPrograms !== false;
  }
  return true;
}

function collectTargetProgramMutations(value: unknown, rootWasLoaded = false): { programs: TargetProgramMutation[]; failed: number } {
  const programs = new Map<string, TargetProgramMutation>();
  let failed = 0;
  const seen = new Set<object>();
  const visit = (candidate: unknown, fromLoadedProgramInfo = false, assumedLoaded = false): void => {
    if (!candidate || typeof candidate !== "object") return;
    if (seen.has(candidate as object)) return;
    seen.add(candidate as object);
    if (Array.isArray(candidate)) {
      candidate.forEach(item => visit(item, fromLoadedProgramInfo));
      return;
    }
    const current = candidate as Record<string, unknown>;
    const hasProgramIdentity = typeof current.coreId === "number" &&
      typeof current.programUri === "string" &&
      typeof current.sha256 === "string" &&
      /^[a-f0-9]{64}$/i.test(current.sha256);
    const targetWritten = current.loaded === true || current.targetMemoryWritten === true || fromLoadedProgramInfo || assumedLoaded;
    if (hasProgramIdentity) {
      if (current.success === false) {
        failed += 1;
      } else if (targetWritten) {
        const item: TargetProgramMutation = {
          coreId: current.coreId as number,
          programUri: current.programUri as string,
          sha256: String(current.sha256).toLowerCase()
        };
        programs.set(`${item.coreId}:${item.sha256}`, item);
      }
    }
    for (const [key, child] of Object.entries(current)) {
      visit(child, fromLoadedProgramInfo || key === "loadedProgramInfo");
    }
  };
  visit(value, false, rootWasLoaded);
  return { programs: [...programs.values()], failed };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function randomId(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function leaseTtlMs(commandTimeoutMs: number): number {
  return commandTimeoutMs + 30000;
}

function isConfirmedSessionClose(result: Record<string, unknown>, expectedSessionId: string): boolean {
  return result.success === true && result.closed === true && result.sessionId === expectedSessionId;
}

function isReplaceableResidentSession(sessionName: string): boolean {
  const normalized = sessionName.trim().toLowerCase();
  return normalized.startsWith("launch-resident-ipc-debug")
    || normalized.startsWith("resident-attach")
    || normalized.startsWith("c2000-resident-attach");
}

function logicalCleanupEvidence(result: Record<string, unknown>, expectedSessionId: string): {
  probeLeaseReleased: boolean;
  adapterDisposed: boolean;
} | undefined {
  const error = record(result.error);
  const details = record(error.details);
  const topLevelCleanupError = record(result.cleanupError);
  const topLevelCleanupDetails = record(topLevelCleanupError.details);
  const launch = record(details.launch);
  const launchCleanupError = record(launch.cleanupError);
  const launchCleanupDetails = record(launchCleanupError.details);
  const candidates = [
    { value: result, details },
    { value: topLevelCleanupError, details: topLevelCleanupDetails },
    { value: launch, details: launchCleanupDetails },
    { value: launchCleanupError, details: launchCleanupDetails }
  ];
  for (const candidate of candidates) {
    const cleanup = record(candidate.value.cleanup ?? candidate.details.cleanup);
    const sessionId = typeof candidate.value.sessionId === "string"
      ? candidate.value.sessionId
      : typeof candidate.details.sessionId === "string" ? candidate.details.sessionId : undefined;
    if (sessionId !== expectedSessionId || cleanup.logicalSessionRemoved !== true || cleanup.probeLeaseReleased !== true) {
      continue;
    }
    return {
      probeLeaseReleased: true,
      adapterDisposed: cleanup.adapterDisposed === true
    };
  }
  return undefined;
}

function failedLaunchCleanupEnabled(toolName: string, input: unknown): boolean {
  if (toolName !== "c2000_launchAndRunIpcAcceptance" && toolName !== "c2000_launchResidentIpcDebug" && !toolName.startsWith("c2000_launchMulticoreDebug")) {
    return false;
  }
  const values = record(input);
  // An ephemeral launch has no durable recovery handle, so it is always
  // finalized on failure.  Only an explicitly interactive caller may opt out
  // to retain a session for deliberate manual recovery.
  return values.sessionMode !== "interactive" || values.cleanupOnFailure !== false;
}

function launchSessionIdFromResult(result: Record<string, unknown>): string | undefined {
  if (typeof result.sessionId === "string") return result.sessionId;
  const error = record(result.error);
  const details = record(error.details);
  const launch = record(details.launch);
  return typeof launch.sessionId === "string" ? launch.sessionId : undefined;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function boardRegistrationError(details: Record<string, unknown>): DebugMcpError {
  return new DebugMcpError(
    "ProbeBindingMissing",
    "No matching board is registered with c2000-debugd",
    {
      ...details,
      nextTool: "c2000_registerBoard",
      remediation: "Register a board with its debug-probe serial-bound ccxml, then retry the original launch with that boardId.",
      standardCoreIds: { cpu1: 0, cpu2: 2 }
    }
  );
}
