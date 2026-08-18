import { randomUUID } from "node:crypto";
import type { C2000ToolInvoker } from "../mcp/tools.js";
import { BoardRegistry } from "../boards/BoardRegistry.js";
import { EventRepository } from "../storage/repositories/EventRepository.js";
import { ArtifactRepository } from "../storage/repositories/ArtifactRepository.js";
import { TestRunRepository, type TestRunBoardRecord, type TestRunRecord, type TestStepRecord } from "../storage/repositories/TestRunRepository.js";
import { DebugMcpError, StructuredToolError, toStructuredError } from "../utils/errors.js";
import { DURABLE_PLAN_LIMITS, idempotencyForStep, materializeArtifactsByBoard, parsePersistedTestPlan, testPlanSchema, type TestPlan, type TestPlanStep } from "./TestPlanSchema.js";
import { StepRegistry } from "./StepRegistry.js";
import { TestScheduler } from "./TestScheduler.js";
import { TestReconciler } from "./TestReconciler.js";
import { CanAcceptanceService } from "../can/CanAcceptanceService.js";
import { CanTestResultRepository } from "../storage/repositories/CanTestResultRepository.js";
import { BoardGroupRepository } from "../storage/repositories/BoardGroupRepository.js";
import { CanCampaignRepository } from "../storage/repositories/CanCampaignRepository.js";
import { BoardGroupBarrierRepository } from "../storage/repositories/BoardGroupBarrierRepository.js";
import { BoardGroupReconcileDecisionRepository } from "../storage/repositories/BoardGroupReconcileDecisionRepository.js";
import { CanGroupReconciler } from "../can/CanGroupReconciler.js";
import { BoardExecutionSemaphore, type BoardExecutionPermit, type BoardExecutionSnapshot } from "./BoardExecutionSemaphore.js";
import type { LeasedBoard } from "../boards/BoardLeaseManager.js";
import type { BoardWorkerRoute } from "../boards/BoardWorkerSupervisor.js";
import { conditionForStep, conditionMatches, decideRetry, retryPolicyFor } from "./JobSemantics.js";
import { classifyDebugFailure } from "../debug/DebugFailureClassifier.js";
import { portableDurableEvidenceFromSteps, type JobArtifactSnapshotService } from "../artifacts/JobArtifactSnapshotService.js";
import type { FilesystemPolicy } from "../security/pathPolicy.js";

export class TestJobEngine {
  private readonly scheduler: TestScheduler;
  private readonly steps: StepRegistry;
  private readonly reconciler = new TestReconciler();
  private readonly canGroupReconciler = new CanGroupReconciler();
  private readonly boardPermits: BoardExecutionSemaphore;
  private readonly executing = new Set<string>();
  private readonly scheduledTasks = new Set<Promise<void>>();
  private readonly abortControllers = new Map<string, AbortController>();
  private stopping = false;

  constructor(private readonly options: {
    registry: BoardRegistry;
    runs: TestRunRepository;
    events: EventRepository;
    artifacts: ArtifactRepository;
    tools: C2000ToolInvoker;
    /** Resolve the live supervisor route before a durable lease is acquired or a target step runs. */
    ensureBoardWorker: (boardId: string) => Promise<BoardWorkerRoute>;
    maxActiveJobs?: number;
    maxParallelBoards: number;
    agingThresholdMs?: number;
    starvationTimeoutMs?: number;
    canAcceptance?: CanAcceptanceService;
    canResults?: CanTestResultRepository;
    boardGroups?: BoardGroupRepository;
    canCampaigns?: CanCampaignRepository;
    groupBarriers?: BoardGroupBarrierRepository;
    groupReconcileDecisions?: BoardGroupReconcileDecisionRepository;
    artifactSnapshots?: JobArtifactSnapshotService;
    failureBundles?: { collectForJob(jobId: string, reason?: string): Promise<void> };
    filesystem?: FilesystemPolicy;
  }) {
    this.scheduler = new TestScheduler(Math.max(1, options.maxActiveJobs ?? 16));
    this.boardPermits = new BoardExecutionSemaphore(Math.max(1, options.maxParallelBoards), {
      agingThresholdMs: options.agingThresholdMs,
      starvationTimeoutMs: options.starvationTimeoutMs,
      onStarvation: waiter => options.events.append({ level: "warn", sourceType: "scheduler", sourceId: waiter.jobId, jobId: waiter.jobId, eventType: "BOARD_PERMIT_STARVATION", payload: waiter })
    });
    this.steps = new StepRegistry(options.tools, options.canAcceptance, options.filesystem);
  }

  start(): void {
    for (const run of this.options.runs.listUnfinished()) {
      let plan: TestPlan;
      try {
        plan = parsePersistedTestPlan(run.plan);
      } catch (error) {
        const structured = { ...toStructuredError(error) };
        this.options.runs.updateStatus(run.jobId, "NEEDS_MANUAL_INTERVENTION", {
          finishedAt: new Date().toISOString(),
          error: { code: "PersistedPlanMigrationFailed", message: "Persisted plan could not be migrated safely", details: { cause: structured } }
        });
        this.options.events.append({ level: "error", sourceType: "job", sourceId: run.jobId, jobId: run.jobId, eventType: "JOB_PERSISTED_PLAN_MIGRATION_FAILED", payload: { error: structured } });
        void this.exportTerminalEvidence(run.jobId, "NEEDS_MANUAL_INTERVENTION");
        continue;
      }
      if (run.status === "RECOVERING") {
        const groupDecision = plan.can && this.options.boardGroups && this.options.groupBarriers
          ? this.reconcileCanGroup(run.jobId, plan)
          : undefined;
        if (groupDecision?.decision === "MARK_PASSED") {
          this.options.runs.updateStatus(run.jobId, "PASSED", { finishedAt: new Date().toISOString(), resultSummary: { recoveredFromGroupEvidence: true } });
          void this.exportTerminalEvidence(run.jobId, "PASSED");
          continue;
        }
        if (groupDecision && groupDecision.decision !== "RESTART_GROUP_FROM_SAFE_BOUNDARY") {
          this.options.runs.updateStatus(run.jobId, "NEEDS_MANUAL_INTERVENTION", { finishedAt: new Date().toISOString(), error: { code: "CanGroupManualRecoveryRequired", reason: groupDecision.reason, evidence: groupDecision.evidence } });
          void this.exportTerminalEvidence(run.jobId, "NEEDS_MANUAL_INTERVENTION");
          continue;
        }
        const interrupted = this.options.runs.steps(run.jobId).find(step => step.status === "INTERRUPTED" || step.status === "RUNNING");
        const decision = this.reconciler.reconcile(plan, {
          boardId: "all",
          interruptedStepType: interrupted?.stepType,
          interruptedIdempotencyClass: interrupted?.idempotencyClass
        });
        this.options.events.append({ level: "warn", sourceType: "job", sourceId: run.jobId, jobId: run.jobId, eventType: "JOB_RECONCILE_DECISION", payload: { ...decision } });
        if (decision.decision !== "RESTART_BOARD_FLOW") {
          this.options.runs.updateStatus(run.jobId, "NEEDS_MANUAL_INTERVENTION", { finishedAt: new Date().toISOString(), error: { code: "ManualRecoveryRequired", reason: decision.reason, evidence: decision.evidence } });
          this.options.events.append({ level: "error", sourceType: "job", sourceId: run.jobId, jobId: run.jobId, eventType: "JOB_RECONCILE_MANUAL_REQUIRED", payload: { ...decision } });
          void this.exportTerminalEvidence(run.jobId, "NEEDS_MANUAL_INTERVENTION");
          continue;
        }
        const releasedLeases = this.releaseRecoveredJobLeases(run.jobId);
        this.options.runs.resetForBoardFlowRestart(run.jobId);
        this.options.events.append({ level: "info", sourceType: "job", sourceId: run.jobId, jobId: run.jobId, eventType: "JOB_RESTARTED_FROM_SAFE_BOUNDARY", payload: { nextStepIndex: decision.nextStepIndex, releasedRecoveredLeases: releasedLeases, recoveryEvidence: decision.evidence } });
      }
      this.schedule(run.jobId);
    }
  }

  /** Stop admitting queued work and wait for currently executing checkpoints to settle before SQLite closes. */
  async stop(): Promise<void> {
    this.beginStop();
    await Promise.allSettled([...this.scheduledTasks]);
    await this.boardPermits.stop();
  }

  /** Stop new checkpoint transitions immediately; used before daemon state is marked RECOVERING. */
  beginStop(): void {
    if (this.stopping) return;
    this.stopping = true;
    this.scheduler.stop();
  }

  submit(planInput: unknown): Record<string, unknown> {
    const submittedPlan = testPlanSchema.parse(planInput);
    const boards = this.selectBoards(submittedPlan);
    const jobId = `run-${randomUUID()}`;
    const selectedBoardIds = boards.map(board => board.boardId);
    const plan: TestPlan = materializeArtifactsByBoard(submittedPlan.can
      ? {
        ...submittedPlan,
        parallelism: Math.max(2, submittedPlan.parallelism ?? 2),
        can: {
          ...submittedPlan.can,
          groupId: `can-group-${jobId}`,
          execution: { ...submittedPlan.can.execution, campaignId: `can-campaign-${jobId}` }
        }
      }
      : submittedPlan, selectedBoardIds);
    if (plan.can) {
      if (boards.length !== 2) throw new DebugMcpError("CanProfileInvalid", "CAN acceptance requires exactly two selected boards", { selectedBoardIds: boards.map(board => board.boardId) });
      if (boards.length > this.boardPermits.limit) {
        throw new DebugMcpError("InsufficientBoardConcurrency", "CAN pair cannot fit within the configured global board concurrency", {
          requiredBoards: boards.length,
          configuredMaxParallelBoards: this.boardPermits.limit,
          boardIds: selectedBoardIds.slice().sort()
        });
      }
      if (!this.options.canAcceptance) throw new DebugMcpError("CanAdapterUnavailable", "CAN acceptance service is not configured");
    }
    const submittedAt = new Date().toISOString();
    const boardRuns: TestRunBoardRecord[] = boards.map(board => ({ jobId, boardId: board.boardId, probeSerial: board.probeSerial, status: "QUEUED", currentStepIndex: 0 }));
    const steps: TestStepRecord[] = boardRuns.flatMap(board => plan.steps.map((step, stepIndex) => ({
      stepRunId: `step-${randomUUID()}`, jobId, boardId: board.boardId, stepIndex, stepType: step.type, input: step, status: "PENDING", attempt: 0, idempotencyClass: idempotencyForStep(step.type)
    })));
    const run: TestRunRecord = {
      jobId, planName: plan.name, planVersion: plan.planVersion, plan: plan as unknown as Record<string, unknown>, status: "QUEUED", progressCurrent: 0, progressTotal: steps.length, submittedAt, cancelRequested: false, failurePolicy: plan.failurePolicy as unknown as Record<string, unknown>
    };
    // The group has no FK to a run; create it first so a queued job can never
    // start without its durable physical topology declaration.
    if (plan.can) this.options.canAcceptance!.prepare(jobId, plan, boards.map(board => board.boardId));
    this.options.runs.create(run, boardRuns, steps);
    if (plan.can) this.options.canAcceptance!.initializeCampaign(jobId, plan);
    this.options.events.append({ level: "info", sourceType: "job", sourceId: jobId, jobId, eventType: "JOB_SUBMITTED", payload: { planName: plan.name, selectedBoards: boardRuns.map(board => board.boardId) } });
    this.schedule(jobId);
    return { success: true, jobId, status: "QUEUED", submittedAt, selectedBoards: boardRuns.map(board => ({ boardId: board.boardId, probeSerial: board.probeSerial })) };
  }

  get(jobId: string, options: { includeSteps?: boolean; includeEvents?: boolean } = {}): Record<string, unknown> {
    const run = this.options.runs.get(jobId);
    if (!run) throw new DebugMcpError("SessionNotFound", `Test run not found: ${jobId}`, { jobId });
    const boards = this.options.runs.boards(jobId);
    return {
      success: true,
      jobId,
      planName: run.planName,
      status: run.status,
      progress: { current: run.progressCurrent, total: run.progressTotal },
      boards,
      passedBoards: boards.filter(board => board.status === "PASSED").length,
      failedBoards: boards.filter(board => board.status === "FAILED").length,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      resultSummary: run.resultSummary,
      lastError: run.error,
      artifacts: this.options.artifacts.list(jobId),
      ...(run.plan.can && typeof (run.plan.can as Record<string, unknown>).groupId === "string" ? {
        can: {
          group: this.options.boardGroups?.require(String((run.plan.can as Record<string, unknown>).groupId)),
          results: this.options.canResults?.list(jobId) ?? [],
          ...(this.options.canCampaigns?.getByJob(jobId) ? {
            campaign: this.options.canCampaigns.getByJob(jobId),
            cases: this.options.canCampaigns.cases(this.options.canCampaigns.getByJob(jobId)!.campaignId)
          } : {})
        }
      } : {}),
      ...(options.includeSteps ? { steps: this.options.runs.steps(jobId) } : {}),
      ...(options.includeEvents ? { events: this.options.events.list({ jobId }) } : {})
    };
  }

  list(status?: string[]): Record<string, unknown> {
    return { success: true, runs: this.options.runs.list(status).map(run => ({ jobId: run.jobId, planName: run.planName, status: run.status, submittedAt: run.submittedAt, startedAt: run.startedAt, finishedAt: run.finishedAt, progress: { current: run.progressCurrent, total: run.progressTotal } })) };
  }

  cancel(jobId: string): Record<string, unknown> {
    if (!this.options.runs.get(jobId)) throw new DebugMcpError("SessionNotFound", `Test run not found: ${jobId}`, { jobId });
    this.options.runs.requestCancel(jobId);
    this.abortControllers.get(jobId)?.abort(new DOMException(`Test run ${jobId} cancelled`, "AbortError"));
    this.options.events.append({ level: "info", sourceType: "job", sourceId: jobId, jobId, eventType: "JOB_CANCEL_REQUESTED", payload: {} });
    return { success: true, jobId, status: "CANCEL_REQUESTED" };
  }

  boardConcurrencySnapshot(): BoardExecutionSnapshot {
    return this.boardPermits.snapshot();
  }

  private schedule(jobId: string): void {
    if (this.stopping || this.executing.has(jobId)) return;
    this.executing.add(jobId);
    const scheduled = this.scheduler.schedule(async () => {
      try { await this.execute(jobId); } finally { this.executing.delete(jobId); }
    });
    this.scheduledTasks.add(scheduled);
    void scheduled.catch(() => undefined).finally(() => this.scheduledTasks.delete(scheduled));
  }

  private async execute(jobId: string): Promise<void> {
    if (this.stopping) return;
    const run = this.options.runs.get(jobId);
    if (!run) return;
    const plan = parsePersistedTestPlan(run.plan);
    const abortController = new AbortController();
    this.abortControllers.set(jobId, abortController);
    if (run.cancelRequested) abortController.abort(new DOMException(`Test run ${jobId} cancelled`, "AbortError"));
    this.options.runs.updateStatus(jobId, "RUNNING", { startedAt: run.startedAt ?? new Date().toISOString() });
    const boards = this.options.runs.boards(jobId);
    let groupPermits: BoardExecutionPermit[] | undefined;
    let groupLeases: LeasedBoard[] | undefined;
    let outcomes: Array<{ success: boolean; cancelled: boolean }>;
    try {
      if (plan.can) {
        groupPermits = await this.boardPermits.acquireGroup(boards.map(board => board.boardId), jobId, plan.priority === "REGRESSION" ? "ACCEPTANCE" : plan.priority);
        groupLeases = await this.acquireGroupLeases(jobId, boards.map(board => board.boardId));
      }
      const permitsByBoard = new Map(groupPermits?.map(permit => [permit.boardId, permit]));
      const leasesByBoard = new Map(groupLeases?.map(lease => [lease.lease.boardId, lease]));
      outcomes = await mapWithConcurrency(
        boards,
        Math.min(this.options.maxParallelBoards, plan.parallelism ?? this.options.maxParallelBoards),
        board => this.executeBoard(jobId, plan, board, permitsByBoard.get(board.boardId), leasesByBoard.get(board.boardId))
      );
    } catch (error) {
      const structured = { ...toStructuredError(error) };
      outcomes = boards.map(board => {
        this.options.runs.updateBoard({ ...board, status: "FAILED", finishedAt: new Date().toISOString(), error: structured });
        return { success: false, cancelled: false };
      });
      this.options.events.append({ level: "error", sourceType: "job", sourceId: jobId, jobId, eventType: "JOB_GROUP_RESOURCE_FAILED", payload: { error: structured } });
    } finally {
      for (const lease of [...(groupLeases ?? [])].reverse()) {
        try { this.options.registry.leases.release(lease.lease.leaseId, lease.leaseToken); } catch { /* durable expiry/reconcile remains authoritative */ }
      }
      for (const permit of groupPermits ?? []) permit.release();
      this.abortControllers.delete(jobId);
    }
    // Graceful daemon shutdown leaves the durable run in RUNNING; DebugDaemon
    // converts it to RECOVERING only after all in-flight DB users have settled.
    if (this.stopping) return;
    const failed = outcomes.filter(outcome => !outcome.success);
    const cancelled = outcomes.every(outcome => outcome.cancelled);
    const status = cancelled ? "CANCELLED" : failed.length === 0 ? "PASSED" : plan.failurePolicy.continueHealthyBoards && failed.length < outcomes.length ? "PARTIAL" : "FAILED";
    this.options.runs.updateStatus(jobId, status, {
      finishedAt: new Date().toISOString(),
      resultSummary: { totalBoards: outcomes.length, passedBoards: outcomes.filter(outcome => outcome.success).length, failedBoards: failed.length, cancelledBoards: outcomes.filter(outcome => outcome.cancelled).length }
    });
    this.options.events.append({ level: status === "PASSED" ? "info" : "warn", sourceType: "job", sourceId: jobId, jobId, eventType: "JOB_FINISHED", payload: { status } });
    await this.exportTerminalEvidence(jobId, status);
  }

  private async exportTerminalEvidence(jobId: string, status: string): Promise<void> {
    await this.options.artifactSnapshots?.exportJob(jobId).catch(() => undefined);
    if (status !== "PASSED") {
      await this.options.failureBundles?.collectForJob(jobId, `JOB_${status}`).catch(error => {
        this.options.events.append({
          level: "warn",
          sourceType: "failure-bundle",
          sourceId: jobId,
          jobId,
          eventType: "FAILURE_BUNDLE_COLLECTION_FAILED",
          payload: { error: toStructuredError(error), originalJobStatus: status }
        });
      });
    }
  }

  /**
   * Bind a durable lease to the worker selected by the live supervisor. The
   * persisted board row is only a record of state; it is not a routing source.
   * A single pre-command retry is safe because no target command has been
   * submitted and the first lease is released before a new context is made.
   */
  private async acquireBoardLease(jobId: string, boardId: string): Promise<LeasedBoard> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const route = await this.options.ensureBoardWorker(boardId);
      let lease: LeasedBoard | undefined;
      try {
        lease = this.options.registry.leases.acquire({
          boardId,
          ownerJobId: jobId,
          workerInstanceId: route.workerInstanceId,
          ttlMs: 30000
        });
        const verifiedRoute = await this.options.ensureBoardWorker(boardId);
        if (verifiedRoute.workerInstanceId !== route.workerInstanceId) {
          throw leaseWorkerRouteMismatch(boardId, verifiedRoute, route, "lease-acquire");
        }
        return lease;
      } catch (error) {
        if (lease) this.releaseLease(lease);
        if (attempt === 0 && isWorkerRouteMismatch(error)) continue;
        throw error;
      }
    }
    throw new DebugMcpError("LeaseWorkerMismatch", "Live worker route changed while acquiring the board lease", {
      boardId,
      stage: "lease-acquire",
      targetAccessAttempted: false
    });
  }

  /** Acquire a CAN group lease from one consistent live route snapshot. */
  private async acquireGroupLeases(jobId: string, boardIds: string[]): Promise<LeasedBoard[]> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const routes = await this.resolveWorkerRoutes(boardIds);
      let leases: LeasedBoard[] | undefined;
      try {
        leases = this.options.registry.leases.acquireGroup({
          boardIds,
          ownerJobId: jobId,
          workerInstanceIds: Object.fromEntries([...routes].map(([boardId, route]) => [boardId, route.workerInstanceId])),
          ttlMs: 30000
        });
        const verifiedRoutes = await this.resolveWorkerRoutes(boardIds);
        for (const boardId of boardIds) {
          const route = routes.get(boardId)!;
          const verifiedRoute = verifiedRoutes.get(boardId)!;
          if (verifiedRoute.workerInstanceId !== route.workerInstanceId) {
            throw leaseWorkerRouteMismatch(boardId, verifiedRoute, route, "lease-acquire");
          }
        }
        return leases;
      } catch (error) {
        for (const lease of leases ?? []) this.releaseLease(lease);
        if (attempt === 0 && isWorkerRouteMismatch(error)) continue;
        throw error;
      }
    }
    throw new DebugMcpError("LeaseWorkerMismatch", "Live worker routes changed while acquiring the CAN board group lease", {
      boardIds,
      stage: "lease-acquire",
      targetAccessAttempted: false
    });
  }

  private async resolveWorkerRoutes(boardIds: string[]): Promise<Map<string, BoardWorkerRoute>> {
    const entries = await Promise.all(boardIds.map(async boardId => [boardId, await this.options.ensureBoardWorker(boardId)] as const));
    return new Map(entries);
  }

  private async assertCurrentWorkerRoute(boardId: string, lease: LeasedBoard): Promise<void> {
    const route = await this.options.ensureBoardWorker(boardId);
    if (route.workerInstanceId !== lease.context.workerInstanceId) {
      throw leaseWorkerRouteMismatch(boardId, route, {
        workerInstanceId: lease.context.workerInstanceId,
        workerGeneration: undefined
      }, "pre-step");
    }
  }

  private releaseLease(lease: LeasedBoard): void {
    try {
      this.options.registry.leases.release(lease.lease.leaseId, lease.leaseToken);
    } catch {
      // Expiry/recovery remains authoritative if the lease was already fenced.
    }
  }

  private async executeBoard(jobId: string, plan: TestPlan, board: TestRunBoardRecord, groupPermit?: BoardExecutionPermit, groupLease?: LeasedBoard): Promise<{ success: boolean; cancelled: boolean }> {
    const permit = groupPermit ?? await this.boardPermits.acquire(board.boardId, jobId);
    const boardStart = new Date().toISOString();
    let current = { ...board, status: "RUNNING", startedAt: boardStart };
    this.options.runs.updateBoard(current);
    let lease = groupLease;
    try {
      lease ??= await this.acquireBoardLease(jobId, board.boardId);
    } catch (error) {
      const leaseError = { ...toStructuredError(error) };
      this.options.runs.updateBoard({ ...current, status: "FAILED", finishedAt: new Date().toISOString(), error: leaseError });
      this.options.events.append({ level: "error", sourceType: "job", sourceId: jobId, jobId, boardId: board.boardId, eventType: "JOB_BOARD_LEASE_FAILED", payload: { error: leaseError } });
      if (!groupPermit) permit.release();
      return { success: false, cancelled: false };
    }
    let sessionId = current.sessionId;
    let sessionOpen = Boolean(sessionId);
    let failed = false;
    let cancelled = false;
    let renewalFailures = 0;
    let leaseLost = false;
    let lastError: Record<string, unknown> | undefined;
    const renew = setInterval(() => {
      try {
        this.options.registry.leases.renew(lease.lease.leaseId, lease.leaseToken, 30000);
        renewalFailures = 0;
      } catch (error) {
        renewalFailures += 1;
        const structured = toStructuredError(error);
        this.options.events.append({
          level: renewalFailures >= 3 ? "error" : "warn",
          sourceType: "lease",
          sourceId: lease.lease.leaseId,
          jobId,
          boardId: board.boardId,
          eventType: renewalFailures === 1 ? "LEASE_RENEWAL_FAILED" : "LEASE_RENEWAL_RETRY_FAILED",
          payload: { consecutiveFailures: renewalFailures, error: structured }
        });
        if (renewalFailures >= 3 && !leaseLost) {
          leaseLost = true;
          failed = true;
          lastError = {
            code: "LeaseRenewalFailed",
            message: "Lease renewal failed repeatedly; no further target commands will be submitted",
            details: { leaseId: lease.lease.leaseId, consecutiveFailures: renewalFailures }
          };
          try { this.options.registry.leases.invalidate(lease.lease.leaseId, lease.leaseToken, "renewal-failure-threshold"); } catch { /* original renewal evidence is authoritative */ }
        }
      }
    }, 10000);
    renew.unref();
    try {
      const steps = this.options.runs.steps(jobId, board.boardId);
      for (const step of steps) {
        if (this.stopping) break;
        if (leaseLost) {
          this.options.runs.updateStep({ ...step, status: "SKIPPED", finishedAt: new Date().toISOString(), error: lastError });
          continue;
        }
        const freshRun = this.options.runs.get(jobId);
        if (freshRun?.cancelRequested || this.abortControllers.get(jobId)?.signal.aborted) cancelled = true;
        const plannedStep = plan.steps[step.stepIndex]!;
        const condition = conditionForStep(plannedStep);
        const previousOutcome = failed || cancelled ? "failure" : "success";
        if (!conditionMatches(condition, previousOutcome)) {
          this.options.runs.updateStep({
            ...step,
            status: "SKIPPED",
            finishedAt: new Date().toISOString(),
            output: { reason: "CONDITION_NOT_MATCHED", condition, previousOutcome }
          });
          continue;
        }
        current = { ...current, currentStepIndex: step.stepIndex };
        this.options.runs.updateBoard(current);
        const policy = retryPolicyFor(plan, step.stepType);
        for (let attempt = step.attempt + 1; attempt <= policy.maxAttempts; attempt += 1) {
          const attemptStartedAt = new Date().toISOString();
          const running = { ...step, status: "RUNNING", attempt, startedAt: attemptStartedAt } as TestStepRecord;
          this.options.runs.updateStep(running);
          try {
            if (stepRequiresLiveWorkerRoute(plannedStep.type)) {
              await this.assertCurrentWorkerRoute(board.boardId, lease);
            }
            if (plannedStep.type === "launchMulticore" && sessionOpen) {
              throw new DebugMcpError("SessionAlreadyOpen", "launchMulticore cannot replace the active fenced board-flow session", { sessionId });
            }
            const activeSignal = condition === "always" || (cancelled && condition === "failure") ? undefined : this.abortControllers.get(jobId)?.signal;
            const executionContext = {
              jobId,
              boardId: board.boardId,
              sessionId,
              leaseId: lease.lease.leaseId,
              leaseContext: lease.context,
              probeSerial: board.probeSerial,
              plan,
              step: plannedStep,
              signal: activeSignal
            };
            const safetyGuardChecks: Record<string, unknown>[] = [];
            if (sessionOpen && sessionId && guardBeforeStep(plannedStep)) {
              safetyGuardChecks.push(await this.steps.assertSafetyGuards(executionContext, sessionId, "before-step"));
            }
            let output = await this.steps.execute(executionContext);
            if (plannedStep.type === "launchMulticore" && output.success === false) {
              if (output.cleanedUp !== true && typeof output.sessionId === "string") {
                sessionId = output.sessionId;
                sessionOpen = true;
                current = { ...current, sessionId };
                this.options.runs.updateBoard(current);
              }
              throw structuredToolFailure(output, step.stepType);
            }
            if (plannedStep.type !== "cleanup" && typeof output.sessionId === "string") {
              if (plannedStep.type !== "launchMulticore" && sessionId && output.sessionId !== sessionId) {
                throw new DebugMcpError("SessionIdentityMismatch", "Durable step returned a session other than the current fenced board-flow session", {
                  stepType: plannedStep.type,
                  expectedSessionId: sessionId,
                  returnedSessionId: output.sessionId
                });
              }
              sessionId = output.sessionId;
              if (plannedStep.type === "launchMulticore" && output.cleanedUp !== true) sessionOpen = true;
              current = { ...current, sessionId };
              this.options.runs.updateBoard(current);
            }
            if (sessionOpen && sessionId && guardAfterStep(plannedStep)) {
              safetyGuardChecks.push(await this.steps.assertSafetyGuards({ ...executionContext, sessionId }, sessionId, "after-step"));
            }
            if (safetyGuardChecks.length > 0) {
              const internalChecks = Array.isArray(output.safetyGuardChecks) ? output.safetyGuardChecks : [];
              output = { ...output, safetyGuardChecks: [...safetyGuardChecks, ...internalChecks] };
            }
            this.assertStepOutputWithinLimits(jobId, step.stepRunId, step.stepType, output);
            if (output.success === false) throw new DebugMcpError("BatchOperationFailed", `Job step ${step.stepType} returned failure`, { output });
            if (plannedStep.type === "cleanup") {
              if (sessionOpen && sessionId) {
                assertConfirmedSessionClose(output, sessionId, "Explicit durable cleanup did not confirm closure of the active fenced board-flow session");
              }
              sessionOpen = false;
              sessionId = undefined;
              current = { ...current, sessionId: undefined };
              this.options.runs.updateBoard(current);
            }
            const finishedAt = new Date().toISOString();
            this.options.runs.addStepAttempt({ step, attemptIndex: attempt, startedAt: attemptStartedAt, finishedAt, status: "PASSED", retryDecision: { retry: false, reason: "PASSED" }, backoffMs: 0 });
            this.options.runs.updateStep({ ...running, status: "PASSED", finishedAt, output });
            break;
          } catch (error) {
            const structured = { ...toStructuredError(error) };
            const optimization = classifyDebugFailure(structured);
            const structuredWithOptimization = { ...structured, optimization };
            if (isAbortError(error)) cancelled = true;
            if (failedSafetyIsolation(structuredWithOptimization)) {
              try {
                this.options.registry.transition(board.boardId, "QUARANTINED", {
                  code: "DurableSafetyIsolationFailed",
                  message: "A durable safety halt could not be confirmed while the fenced lease was held",
                  jobId,
                  stepType: step.stepType,
                  error: structuredWithOptimization
                });
              } catch { /* original fenced halt failure remains authoritative */ }
            }
            const retryDecision = decideRetry({ step, attempt, policy, errorCode: structuredWithOptimization.code });
            let reconcileEvidence: Record<string, unknown> | undefined;
            if (retryDecision.retry && retryDecision.requiresReconcile) {
              reconcileEvidence = await this.reconcileBeforeRetry(sessionId, lease.context);
              if (reconcileEvidence.safeToRetry !== true) {
                retryDecision.retry = false;
                retryDecision.reason = "RECONCILE_REJECTED";
              }
            }
            const finishedAt = new Date().toISOString();
            this.options.runs.addStepAttempt({ step, attemptIndex: attempt, startedAt: attemptStartedAt, finishedAt, status: "FAILED", error: structuredWithOptimization, retryDecision, backoffMs: retryDecision.backoffMs, reconcileEvidence });
            if (retryDecision.retry && !cancelled) {
              this.options.events.append({ level: "warn", sourceType: "job", sourceId: jobId, jobId, boardId: board.boardId, eventType: "JOB_STEP_RETRY", payload: { stepType: step.stepType, attempt, error: structuredWithOptimization, retryDecision, reconcileEvidence } });
              await abortableBackoff(retryDecision.backoffMs, this.abortControllers.get(jobId)?.signal);
              continue;
            }
            failed = !cancelled;
            lastError = structuredWithOptimization;
            this.options.runs.updateStep({ ...running, status: "FAILED", finishedAt, error: lastError, output: { retryDecision, reconcileEvidence, optimization } });
            this.options.events.append({ level: cancelled ? "warn" : "error", sourceType: "job", sourceId: jobId, jobId, boardId: board.boardId, eventType: cancelled ? "JOB_STEP_CANCELLED" : "JOB_STEP_FAILED", payload: { stepType: step.stepType, error: lastError, optimization } });
            break;
          }
        }
      }
    } catch (error) {
      failed = true;
      lastError = { ...toStructuredError(error) };
    } finally {
      clearInterval(renew);
      if (sessionId && sessionOpen) {
        const closingSessionId = sessionId;
        try {
          const cleanup = await this.options.tools.invokeTool("c2000_closeDebugSession", {
            sessionId: closingSessionId,
            __leaseContext: lease.context
          });
          assertConfirmedSessionClose(cleanup, closingSessionId, "Durable job finalizer did not confirm closure of the active fenced board-flow session");
          sessionOpen = false;
          sessionId = undefined;
          current = { ...current, sessionId: undefined };
          this.options.runs.updateBoard(current);
          this.options.events.append({ level: "info", sourceType: "job", sourceId: jobId, jobId, boardId: board.boardId, eventType: "JOB_SESSION_CLOSED", payload: { sessionId: closingSessionId } });
        } catch (error) {
          failed = true;
          cancelled = false;
          lastError = { ...toStructuredError(error) };
          try {
            this.options.registry.transition(board.boardId, "QUARANTINED", {
              code: "JobSessionCleanupFailed",
              message: "Job session could not be closed while its fenced lease was still held; board ownership requires operator recovery",
              jobId,
              sessionId,
              cleanupError: lastError
            });
          } catch (quarantineError) {
            lastError = {
              code: "JobSessionCleanupAndQuarantineFailed",
              message: "Session cleanup failed and board quarantine could not be persisted",
              details: { sessionId, cleanupError: lastError, quarantineError: toStructuredError(quarantineError) }
            };
          }
          this.options.events.append({ level: "error", sourceType: "job", sourceId: jobId, jobId, boardId: board.boardId, eventType: "JOB_SESSION_CLEANUP_FAILED", payload: { sessionId, error: lastError } });
        }
      }
      if (!groupLease) {
        try { this.options.registry.leases.release(lease.lease.leaseId, lease.leaseToken); } catch { /* lease expiry will be reconciled */ }
      }
      const status = cancelled ? "CANCELLED" : failed ? "FAILED" : "PASSED";
      current = { ...current, status, sessionId, finishedAt: new Date().toISOString(), ...(lastError ? { error: lastError } : {}) };
      this.options.runs.updateBoard(current);
      if (!groupPermit) permit.release();
    }
    return { success: !failed && !cancelled, cancelled };
  }

  private assertStepOutputWithinLimits(jobId: string, stepRunId: string, stepType: string, output: Record<string, unknown>): void {
    const outputBytes = jsonBytes(output);
    if (outputBytes > DURABLE_PLAN_LIMITS.maxStepOutputBytes) {
      throw new DebugMcpError("EvidenceLimitExceeded", "Durable step output exceeds the per-step persistence limit", {
        stepType, outputBytes, maxStepOutputBytes: DURABLE_PLAN_LIMITS.maxStepOutputBytes
      });
    }
    const existingBytes = this.options.runs.steps(jobId)
      .filter(candidate => candidate.stepRunId !== stepRunId && candidate.output)
      .reduce((total, candidate) => total + jsonBytes(candidate.output!), 0);
    if (existingBytes + outputBytes > DURABLE_PLAN_LIMITS.maxJobEvidenceBytes) {
      throw new DebugMcpError("EvidenceLimitExceeded", "Durable job outputs exceed the cross-board aggregate persistence limit", {
        stepType, existingBytes, outputBytes, maxJobEvidenceBytes: DURABLE_PLAN_LIMITS.maxJobEvidenceBytes
      });
    }
    const candidateSteps = this.options.runs.steps(jobId).map(candidate =>
      candidate.stepRunId === stepRunId ? { ...candidate, output } : candidate
    );
    const portableEvidenceBytes = jsonBytes(portableDurableEvidenceFromSteps(candidateSteps));
    if (portableEvidenceBytes > DURABLE_PLAN_LIMITS.maxJobEvidenceBytes) {
      throw new DebugMcpError("EvidenceLimitExceeded", "Durable job evidence would exceed the terminal portable-artifact limit", {
        stepType, portableEvidenceBytes, maxJobEvidenceBytes: DURABLE_PLAN_LIMITS.maxJobEvidenceBytes
      });
    }
  }

  private async reconcileBeforeRetry(sessionId: string | undefined, leaseContext: LeasedBoard["context"]): Promise<Record<string, unknown>> {
    if (!sessionId) return { mode: "READ_ONLY", safeToRetry: true, reason: "No debug session exists yet" };
    try {
      const snapshot = await this.options.tools.invokeTool("c2000_getMulticoreSnapshot", { sessionId, __leaseContext: leaseContext });
      return { mode: "READ_ONLY", safeToRetry: snapshot.success === true, snapshot };
    } catch (error) {
      return { mode: "READ_ONLY", safeToRetry: false, error: toStructuredError(error) };
    }
  }

  private selectBoards(plan: TestPlan) {
    const selector = plan.boardSelector;
    const boardIds = plan.boardIds ?? selector?.boardIds;
    const boards = boardIds
      ? boardIds.map(boardId => this.options.registry.get(boardId))
      : this.options.registry.list({ tags: selector?.tags });
    const selected = selector?.count ? boards.slice(0, selector.count) : boards;
    if (selected.length === 0) throw new DebugMcpError("ProbeNotConnected", "No registered board matches the submitted test plan", { boardIds, tags: selector?.tags });
    return selected;
  }

  private releaseRecoveredJobLeases(jobId: string): string[] {
    return this.options.runs.boards(jobId)
      .filter(board => this.options.registry.leases.releaseForRecoveredJob(board.boardId, jobId))
      .map(board => board.boardId);
  }

  private reconcileCanGroup(jobId: string, plan: TestPlan) {
    const group = this.options.boardGroups?.getByJob(jobId);
    if (!group || !this.options.groupBarriers) return undefined;
    const decision = this.canGroupReconciler.reconcile(plan, group, this.options.groupBarriers.list(group.groupId));
    this.options.groupReconcileDecisions?.add({ groupId: group.groupId, jobId, decision: decision.decision, reason: decision.reason, evidence: decision.evidence });
    this.options.events.append({ level: decision.decision === "RESTART_GROUP_FROM_SAFE_BOUNDARY" ? "warn" : "error", sourceType: "can-group", sourceId: group.groupId, jobId, eventType: "CAN_GROUP_RECONCILE_DECISION", payload: { ...decision } });
    if (decision.decision === "RESTART_GROUP_FROM_SAFE_BOUNDARY" && !this.options.boardGroups!.isTerminal(group.status)) {
      this.options.boardGroups!.transition(group.groupId, "RECOVERING", { reason: decision.reason });
    }
    return decision;
  }
}

function jsonBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch (error) {
    throw new DebugMcpError("EvidenceSerializationFailed", "Durable step output is not JSON serializable", { error: toStructuredError(error) });
  }
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const worker = async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await work(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => worker()));
  return results;
}

function isAbortError(error: unknown): boolean {
  return (error instanceof DOMException && error.name === "AbortError")
    || (error instanceof Error && error.name === "AbortError");
}

function guardBeforeStep(step: TestPlanStep): boolean {
  return guardAfterStep(step) && step.type !== "reconnectAfterTargetReset";
}

function guardAfterStep(step: TestPlanStep): boolean {
  // A connect-only launch has no loaded symbols. Evaluating firmware safety
  // expressions here creates a false failure (`identifier not found`) before
  // the first load/run step has made those expressions readable.
  if (step.type === "launchMulticore" && !step.loadPrograms) return false;
  return step.type !== "cleanup" && step.type !== "restorePrograms";
}

function stepRequiresLiveWorkerRoute(stepType: TestPlanStep["type"]): boolean {
  return stepType !== "preflight" && stepType !== "delay";
}

function leaseWorkerRouteMismatch(
  boardId: string,
  expected: BoardWorkerRoute,
  received: { workerInstanceId: string; workerGeneration?: number },
  stage: "lease-acquire" | "pre-step"
): DebugMcpError {
  return new DebugMcpError("LeaseWorkerMismatch", "Durable lease is not bound to the live worker route", {
    boardId,
    expectedWorkerInstanceId: expected.workerInstanceId,
    receivedWorkerInstanceId: received.workerInstanceId,
    expectedWorkerGeneration: expected.workerGeneration,
    ...(received.workerGeneration === undefined ? {} : { receivedWorkerGeneration: received.workerGeneration }),
    stage,
    targetAccessAttempted: false
  });
}

function isWorkerRouteMismatch(error: unknown): boolean {
  return error instanceof DebugMcpError
    && error.code === "LeaseWorkerMismatch"
    && error.details.stage === "lease-acquire";
}

function failedSafetyIsolation(error: Record<string, unknown>): boolean {
  const details = error.details;
  if (!details || typeof details !== "object" || Array.isArray(details)) return false;
  const isolation = error.code === "SafetyGuardViolation"
    ? (details as Record<string, unknown>).halt
    : error.code === "RestoreProgramsFailed" ? (details as Record<string, unknown>).isolation : undefined;
  return Boolean(isolation && typeof isolation === "object" && !Array.isArray(isolation) && (isolation as Record<string, unknown>).success !== true);
}

function structuredToolFailure(output: Record<string, unknown>, stepType: string): StructuredToolError {
  const error = output.error;
  if (error && typeof error === "object" && !Array.isArray(error)) {
    const record = error as Record<string, unknown>;
    if (typeof record.code === "string") {
      return new StructuredToolError({
        code: record.code,
        message: typeof record.message === "string" ? record.message : `Job step ${stepType} failed (${record.code})`,
        ...(record.details && typeof record.details === "object" && !Array.isArray(record.details)
          ? { details: record.details as Record<string, unknown> }
          : {})
      });
    }
  }
  return new StructuredToolError({ code: "BatchOperationFailed", message: `Job step ${stepType} returned failure`, details: { output } });
}

function assertConfirmedSessionClose(output: Record<string, unknown>, expectedSessionId: string, message: string): void {
  if (output.success !== true || output.closed !== true || output.sessionId !== expectedSessionId) {
    throw new DebugMcpError("WorkflowCleanupFailed", message, { expectedSessionId, output });
  }
}

function abortableBackoff(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    signal?.throwIfAborted();
    return Promise.resolve();
  }
  if (!signal) return new Promise(resolve => setTimeout(resolve, ms));
  signal.throwIfAborted();
  const activeSignal = signal;
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, ms);
    const abort = () => {
      clearTimeout(timer);
      activeSignal.removeEventListener("abort", abort);
      reject(activeSignal.reason ?? new DOMException("Operation aborted", "AbortError"));
    };
    function done() {
      activeSignal.removeEventListener("abort", abort);
      resolve();
    }
    activeSignal.addEventListener("abort", abort, { once: true });
  });
}
