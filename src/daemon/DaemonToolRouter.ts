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

/** Routes board-bound tools to a single worker without changing sessionId/coreId semantics. */
export class DaemonToolRouter implements C2000ToolInvoker {
  private readonly interactiveLeases = new Map<string, LeasedBoard>();
  private variableStreams?: VariableStreamService;
  private dlog?: DlogService;
  private erad?: EradService;
  constructor(
    private readonly local: C2000ToolInvoker,
    private readonly registry: BoardRegistry,
    private readonly workers: BoardWorkerSupervisor,
    private readonly sessions: SessionRepository,
    private readonly analytics?: OutcomeAnalyticsService,
    private readonly workspacePath?: string
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
    try {
      const result = await this.invokeToolInternal(toolName, input);
      this.recordAnalytics({ toolName, input, result, durationMs: Date.now() - startedAt });
      return result;
    } catch (error) {
      this.recordAnalytics({ toolName, input, error, durationMs: Date.now() - startedAt });
      throw error;
    }
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
