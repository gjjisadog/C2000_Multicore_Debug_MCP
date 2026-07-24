import { randomUUID } from "node:crypto";
import type { C2000ToolInvoker } from "../mcp/tools.js";
import { BoardRegistry } from "../boards/BoardRegistry.js";
import { EventRepository } from "../storage/repositories/EventRepository.js";
import { ArtifactRepository } from "../storage/repositories/ArtifactRepository.js";
import { TestRunRepository, type TestRunBoardRecord, type TestRunRecord, type TestStepRecord } from "../storage/repositories/TestRunRepository.js";
import { DebugMcpError, toStructuredError } from "../utils/errors.js";
import { idempotencyForStep, testPlanSchema, type TestPlan } from "./TestPlanSchema.js";
import { StepRegistry } from "./StepRegistry.js";
import { TestScheduler } from "./TestScheduler.js";
import { TestReconciler } from "./TestReconciler.js";
import { CanAcceptanceService } from "../can/CanAcceptanceService.js";
import { CanTestResultRepository } from "../storage/repositories/CanTestResultRepository.js";
import { BoardGroupRepository } from "../storage/repositories/BoardGroupRepository.js";

export class TestJobEngine {
  private readonly scheduler: TestScheduler;
  private readonly steps: StepRegistry;
  private readonly reconciler = new TestReconciler();
  private readonly executing = new Set<string>();
  private readonly scheduledTasks = new Set<Promise<void>>();
  private stopping = false;

  constructor(private readonly options: {
    registry: BoardRegistry;
    runs: TestRunRepository;
    events: EventRepository;
    artifacts: ArtifactRepository;
    tools: C2000ToolInvoker;
    maxParallelBoards: number;
    canAcceptance?: CanAcceptanceService;
    canResults?: CanTestResultRepository;
    boardGroups?: BoardGroupRepository;
  }) {
    this.scheduler = new TestScheduler(Math.max(1, options.maxParallelBoards));
    this.steps = new StepRegistry(options.tools, options.canAcceptance);
  }

  start(): void {
    for (const run of this.options.runs.listUnfinished()) {
      if (run.status === "RECOVERING") {
        const plan = testPlanSchema.parse(run.plan);
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
          continue;
        }
        this.options.runs.resetForBoardFlowRestart(run.jobId);
        this.options.events.append({ level: "info", sourceType: "job", sourceId: run.jobId, jobId: run.jobId, eventType: "JOB_RESTARTED_FROM_SAFE_BOUNDARY", payload: { nextStepIndex: decision.nextStepIndex } });
      }
      this.schedule(run.jobId);
    }
  }

  /** Stop admitting queued work and wait for currently executing checkpoints to settle before SQLite closes. */
  async stop(): Promise<void> {
    this.beginStop();
    await Promise.allSettled([...this.scheduledTasks]);
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
    const plan: TestPlan = submittedPlan.can
      ? { ...submittedPlan, parallelism: Math.max(2, submittedPlan.parallelism ?? 2), can: { ...submittedPlan.can, groupId: `can-group-${jobId}` } }
      : submittedPlan;
    if (plan.can) {
      if (boards.length !== 2) throw new DebugMcpError("CanProfileInvalid", "CAN acceptance requires exactly two selected boards", { selectedBoardIds: boards.map(board => board.boardId) });
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
          results: this.options.canResults?.list(jobId) ?? []
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
    this.options.events.append({ level: "info", sourceType: "job", sourceId: jobId, jobId, eventType: "JOB_CANCEL_REQUESTED", payload: {} });
    return { success: true, jobId, status: "CANCEL_REQUESTED" };
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
    const plan = testPlanSchema.parse(run.plan);
    this.options.runs.updateStatus(jobId, "RUNNING", { startedAt: run.startedAt ?? new Date().toISOString() });
    const boards = this.options.runs.boards(jobId);
    const outcomes = await mapWithConcurrency(
      boards,
      Math.min(this.options.maxParallelBoards, plan.parallelism ?? this.options.maxParallelBoards),
      board => this.executeBoard(jobId, plan, board)
    );
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
  }

  private async executeBoard(jobId: string, plan: TestPlan, board: TestRunBoardRecord): Promise<{ success: boolean; cancelled: boolean }> {
    const boardStart = new Date().toISOString();
    let current = { ...board, status: "RUNNING", startedAt: boardStart };
    this.options.runs.updateBoard(current);
    const lease = this.options.registry.leases.acquire({ boardId: board.boardId, ownerJobId: jobId, ttlMs: 30000 });
    const renew = setInterval(() => { try { this.options.registry.leases.renew(lease.lease.leaseId, lease.leaseToken, 30000); } catch { /* a later step will fail safely */ } }, 10000);
    renew.unref();
    let sessionId = current.sessionId;
    let failed = false;
    let cancelled = false;
    let lastError: Record<string, unknown> | undefined;
    try {
      const steps = this.options.runs.steps(jobId, board.boardId);
      for (const step of steps) {
        if (this.stopping) break;
        const freshRun = this.options.runs.get(jobId);
        if (freshRun?.cancelRequested) {
          cancelled = true;
          this.options.runs.updateStep({ ...step, status: "SKIPPED", finishedAt: new Date().toISOString() });
          continue;
        }
        if (failed && step.stepType !== "cleanup" && step.stepType !== "runFullDebugBundle") {
          this.options.runs.updateStep({ ...step, status: "SKIPPED", finishedAt: new Date().toISOString() });
          continue;
        }
        const running = { ...step, status: "RUNNING", attempt: step.attempt + 1, startedAt: new Date().toISOString() } as TestStepRecord;
        this.options.runs.updateStep(running);
        current = { ...current, currentStepIndex: step.stepIndex };
        this.options.runs.updateBoard(current);
        try {
          const output = await this.steps.execute({ jobId, boardId: board.boardId, sessionId, plan, step: plan.steps[step.stepIndex]! });
          if (output.success === false) throw new DebugMcpError("BatchOperationFailed", `Job step ${step.stepType} returned failure`, { output });
          if (typeof output.sessionId === "string") {
            sessionId = output.sessionId;
            current = { ...current, sessionId };
            this.options.runs.updateBoard(current);
          }
          this.options.runs.updateStep({ ...running, status: "PASSED", finishedAt: new Date().toISOString(), output });
        } catch (error) {
          failed = true;
          lastError = { ...toStructuredError(error) };
          this.options.runs.updateStep({ ...running, status: "FAILED", finishedAt: new Date().toISOString(), error: lastError });
          this.options.events.append({ level: "error", sourceType: "job", sourceId: jobId, jobId, boardId: board.boardId, eventType: "JOB_STEP_FAILED", payload: { stepType: step.stepType, error: lastError } });
        }
      }
    } catch (error) {
      failed = true;
      lastError = { ...toStructuredError(error) };
    } finally {
      clearInterval(renew);
      try { this.options.registry.leases.release(lease.lease.leaseId, lease.leaseToken); } catch { /* lease expiry will be reconciled */ }
      const status = cancelled ? "CANCELLED" : failed ? "FAILED" : "PASSED";
      current = { ...current, status, sessionId, finishedAt: new Date().toISOString(), ...(lastError ? { error: lastError } : {}) };
      this.options.runs.updateBoard(current);
    }
    return { success: !failed && !cancelled, cancelled };
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
