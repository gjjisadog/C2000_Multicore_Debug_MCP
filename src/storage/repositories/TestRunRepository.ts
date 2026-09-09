import { SqliteStore } from "../SqliteStore.js";
import { randomUUID } from "node:crypto";
import { DebugMcpError } from "../../utils/errors.js";

const terminalStatuses = new Set(["PASSED", "FAILED", "PARTIAL", "CANCELLED", "NEEDS_MANUAL_INTERVENTION"]);

export interface TestRunRecord {
  jobId: string;
  planName: string;
  planVersion: number;
  plan: Record<string, unknown>;
  status: string;
  progressCurrent: number;
  progressTotal: number;
  submittedAt: string;
  startedAt?: string;
  finishedAt?: string;
  cancelRequested: boolean;
  failurePolicy: Record<string, unknown>;
  resultSummary?: Record<string, unknown>;
  error?: Record<string, unknown>;
}

export interface TestRunBoardRecord {
  jobId: string;
  boardId: string;
  probeSerial: string;
  status: string;
  currentStepIndex: number;
  sessionId?: string;
  startedAt?: string;
  finishedAt?: string;
  error?: Record<string, unknown>;
}

export interface TestStepRecord {
  stepRunId: string;
  jobId: string;
  boardId: string;
  stepIndex: number;
  stepType: string;
  input: Record<string, unknown>;
  status: string;
  attempt: number;
  idempotencyClass: "READ_ONLY" | "RECONCILABLE" | "SAFE_RETRY" | "NON_IDEMPOTENT";
  startedAt?: string;
  finishedAt?: string;
  output?: Record<string, unknown>;
  error?: Record<string, unknown>;
}

export class TestRunRepository {
  constructor(private readonly store: SqliteStore) {}

  create(run: TestRunRecord, boards: TestRunBoardRecord[], steps: TestStepRecord[]): void {
    this.store.transaction(() => {
      this.store.run("INSERT INTO test_runs(job_id, plan_name, plan_version, plan_json, status, progress_current, progress_total, submitted_at, started_at, finished_at, cancel_requested, failure_policy, result_summary_json, error_json) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [run.jobId, run.planName, run.planVersion, JSON.stringify(run.plan), run.status, run.progressCurrent, run.progressTotal, run.submittedAt, run.startedAt ?? null, run.finishedAt ?? null, run.cancelRequested ? 1 : 0, JSON.stringify(run.failurePolicy), run.resultSummary ? JSON.stringify(run.resultSummary) : null, run.error ? JSON.stringify(run.error) : null]);
      for (const board of boards) {
        this.store.run("INSERT INTO test_run_boards(job_id, board_id, probe_serial, status, current_step_index, session_id, started_at, finished_at, error_json) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)", [board.jobId, board.boardId, board.probeSerial, board.status, board.currentStepIndex, board.sessionId ?? null, board.startedAt ?? null, board.finishedAt ?? null, board.error ? JSON.stringify(board.error) : null]);
      }
      for (const step of steps) {
        this.store.run("INSERT INTO test_steps(step_run_id, job_id, board_id, step_index, step_type, input_json, status, attempt, idempotency_class, started_at, finished_at, output_json, error_json) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [step.stepRunId, step.jobId, step.boardId, step.stepIndex, step.stepType, JSON.stringify(step.input), step.status, step.attempt, step.idempotencyClass, step.startedAt ?? null, step.finishedAt ?? null, step.output ? JSON.stringify(step.output) : null, step.error ? JSON.stringify(step.error) : null]);
      }
    });
  }

  get(jobId: string): TestRunRecord | undefined {
    const row = this.store.get<Record<string, unknown>>("SELECT * FROM test_runs WHERE job_id = ?", [jobId]);
    return row ? mapRun(row) : undefined;
  }

  list(status?: string[]): TestRunRecord[] {
    const rows = this.store.all<Record<string, unknown>>("SELECT * FROM test_runs ORDER BY submitted_at DESC");
    return rows.map(mapRun).filter(run => !status || status.includes(run.status));
  }

  boards(jobId: string): TestRunBoardRecord[] {
    return this.store.all<Record<string, unknown>>("SELECT * FROM test_run_boards WHERE job_id = ? ORDER BY board_id", [jobId]).map(row => ({
      jobId: String(row.job_id), boardId: String(row.board_id), probeSerial: String(row.probe_serial), status: String(row.status), currentStepIndex: Number(row.current_step_index),
      ...(row.session_id ? { sessionId: String(row.session_id) } : {}), ...(row.started_at ? { startedAt: String(row.started_at) } : {}), ...(row.finished_at ? { finishedAt: String(row.finished_at) } : {}), ...(row.error_json ? { error: parseJson(String(row.error_json), {}) } : {})
    }));
  }

  steps(jobId: string, boardId?: string): TestStepRecord[] {
    return this.store.all<Record<string, unknown>>("SELECT * FROM test_steps WHERE job_id = ? AND (? IS NULL OR board_id = ?) ORDER BY board_id, step_index", [jobId, boardId ?? null, boardId ?? null]).map(mapStep);
  }

  updateStatus(jobId: string, status: string, patch: Partial<Pick<TestRunRecord, "progressCurrent" | "startedAt" | "finishedAt" | "resultSummary" | "error">> = {}, executionId?: string): void {
    this.store.transaction(() => {
      const current = this.get(jobId);
      if (!current) throw new Error(`Test run not found: ${jobId}`);
      if (executionId) this.assertExecutionOwnerInTransaction(jobId, executionId);
      const result = this.store.run(
        "UPDATE test_runs SET status = ?, progress_current = ?, started_at = ?, finished_at = ?, result_summary_json = ?, error_json = ?" + (executionId ? ", execution_owner_id = ?" : "") + " WHERE job_id = ?" + (executionId ? " AND execution_owner_id = ?" : ""),
        [
          status,
          patch.progressCurrent ?? current.progressCurrent,
          patch.startedAt ?? current.startedAt ?? null,
          patch.finishedAt ?? current.finishedAt ?? null,
          JSON.stringify(patch.resultSummary ?? current.resultSummary ?? {}),
          patch.error ? JSON.stringify(patch.error) : current.error ? JSON.stringify(current.error) : null,
          ...(executionId ? [executionId && !terminalStatuses.has(status) ? executionId : null] : []),
          jobId,
          ...(executionId ? [executionId] : [])
        ]
      );
      if (executionId && result.changes !== 1) this.throwStaleExecution(jobId, executionId);
    });
  }

  /** Atomically claims a queued/recovered run for one daemon execution. */
  claimExecution(jobId: string, executionId: string, startedAt = new Date().toISOString()): boolean {
    return this.store.transaction(() => {
      const result = this.store.run(
        "UPDATE test_runs SET execution_owner_id = ?, status = 'RUNNING', started_at = COALESCE(started_at, ?), finished_at = NULL, error_json = NULL WHERE job_id = ? AND status IN ('QUEUED', 'RECOVERING') AND execution_owner_id IS NULL",
        [executionId, startedAt, jobId]
      );
      return result.changes === 1;
    });
  }

  isExecutionOwner(jobId: string, executionId: string): boolean {
    return Boolean(this.store.get<{ execution_owner_id: string }>("SELECT execution_owner_id FROM test_runs WHERE job_id = ? AND execution_owner_id = ?", [jobId, executionId]));
  }

  assertExecutionOwner(jobId: string, executionId: string): void {
    this.store.transaction(() => this.assertExecutionOwnerInTransaction(jobId, executionId));
  }

  requestCancel(jobId: string): void {
    this.store.run("UPDATE test_runs SET cancel_requested = 1 WHERE job_id = ?", [jobId]);
  }

  updateBoard(board: TestRunBoardRecord, executionId?: string): void {
    this.store.transaction(() => {
      if (executionId) this.assertExecutionOwnerInTransaction(board.jobId, executionId);
      this.store.run("UPDATE test_run_boards SET status = ?, current_step_index = ?, session_id = ?, started_at = ?, finished_at = ?, error_json = ? WHERE job_id = ? AND board_id = ?", [board.status, board.currentStepIndex, board.sessionId ?? null, board.startedAt ?? null, board.finishedAt ?? null, board.error ? JSON.stringify(board.error) : null, board.jobId, board.boardId]);
    });
  }

  updateStep(step: TestStepRecord, executionId?: string): void {
    this.store.transaction(() => {
      if (executionId) this.assertExecutionOwnerInTransaction(step.jobId, executionId);
      this.store.run("UPDATE test_steps SET status = ?, attempt = ?, started_at = ?, finished_at = ?, output_json = ?, error_json = ? WHERE step_run_id = ?", [step.status, step.attempt, step.startedAt ?? null, step.finishedAt ?? null, step.output ? JSON.stringify(step.output) : null, step.error ? JSON.stringify(step.error) : null, step.stepRunId]);
      this.recalculateProgress(step.jobId);
    });
  }

  addStepAttempt(input: {
    step: TestStepRecord;
    attemptIndex: number;
    startedAt: string;
    finishedAt: string;
    status: "PASSED" | "FAILED";
    error?: Record<string, unknown>;
    retryDecision: Record<string, unknown>;
    backoffMs: number;
    reconcileEvidence?: Record<string, unknown>;
    executionId?: string;
  }): number {
    return this.store.transaction(() => {
      if (input.executionId) this.assertExecutionOwnerInTransaction(input.step.jobId, input.executionId);
      // `attempt` is the logical retry number for the current board-flow
      // execution. A recovered flow starts that number over, while the
      // durable attempt table must retain the previous evidence. Allocate a
      // strictly increasing persisted index to satisfy its uniqueness rule.
      const previousMax = Number(this.store.get<{ attempt_index: number }>(
        "SELECT MAX(attempt_index) AS attempt_index FROM test_step_attempts WHERE step_run_id = ?",
        [input.step.stepRunId]
      )?.attempt_index ?? 0);
      const attemptIndex = Math.max(input.attemptIndex, previousMax + 1);
      this.store.run(
        "INSERT INTO test_step_attempts(attempt_id, step_run_id, job_id, board_id, attempt_index, started_at, finished_at, status, error_json, retry_decision_json, backoff_ms, reconcile_evidence_json) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [`attempt-${randomUUID()}`, input.step.stepRunId, input.step.jobId, input.step.boardId, attemptIndex, input.startedAt, input.finishedAt, input.status, input.error ? JSON.stringify(input.error) : null, JSON.stringify(input.retryDecision), input.backoffMs, input.reconcileEvidence ? JSON.stringify(input.reconcileEvidence) : null]
      );
      return attemptIndex;
    });
  }

  stepAttempts(jobId: string): Record<string, unknown>[] {
    return this.store.all<Record<string, unknown>>("SELECT * FROM test_step_attempts WHERE job_id = ? ORDER BY board_id, step_run_id, attempt_index", [jobId]).map(row => ({
      attemptId: row.attempt_id, stepRunId: row.step_run_id, jobId: row.job_id, boardId: row.board_id, attemptIndex: row.attempt_index,
      startedAt: row.started_at, finishedAt: row.finished_at, status: row.status, backoffMs: row.backoff_ms,
      ...(row.error_json ? { error: parseJson(String(row.error_json), {}) } : {}),
      retryDecision: parseJson(String(row.retry_decision_json), {}),
      ...(row.reconcile_evidence_json ? { reconcileEvidence: parseJson(String(row.reconcile_evidence_json), {}) } : {})
    }));
  }

  recalculateProgress(jobId: string): number {
    const progress = Number(this.store.get<{ count: number }>("SELECT COUNT(*) AS count FROM test_steps WHERE job_id = ? AND status IN ('PASSED', 'FAILED', 'SKIPPED')", [jobId])?.count ?? 0);
    this.store.run("UPDATE test_runs SET progress_current = ? WHERE job_id = ?", [progress, jobId]);
    return progress;
  }

  markRecovering(): string[] {
    return this.store.transaction(() => {
      const jobs = this.store.all<{ job_id: string }>("SELECT job_id FROM test_runs WHERE status IN ('ALLOCATING', 'RUNNING', 'CANCEL_REQUESTED', 'CANCELLING')");
      for (const job of jobs) {
        // Clearing the owner is the durable hand-off fence. Any old engine
        // that reaches a persistence boundary after this point is rejected.
        this.store.run("UPDATE test_runs SET status = 'RECOVERING', execution_owner_id = NULL WHERE job_id = ?", [job.job_id]);
        this.store.run("UPDATE test_steps SET status = 'INTERRUPTED', finished_at = ? WHERE job_id = ? AND status = 'RUNNING'", [new Date().toISOString(), job.job_id]);
      }
      return jobs.map(job => job.job_id);
    });
  }

  /** Replays only from a declared whole-board safety boundary, never from a stale persisted session. */
  resetForBoardFlowRestart(jobId: string): boolean {
    return this.store.transaction(() => {
      const result = this.store.run("UPDATE test_runs SET status = 'QUEUED', started_at = NULL, finished_at = NULL, error_json = NULL, execution_owner_id = NULL WHERE job_id = ? AND status = 'RECOVERING'", [jobId]);
      if (result.changes !== 1) return false;
      this.store.run("UPDATE test_run_boards SET status = 'QUEUED', current_step_index = 0, session_id = NULL, started_at = NULL, finished_at = NULL, error_json = NULL WHERE job_id = ?", [jobId]);
      this.store.run("UPDATE test_steps SET status = 'PENDING', attempt = 0, started_at = NULL, finished_at = NULL, output_json = NULL, error_json = NULL WHERE job_id = ?", [jobId]);
      this.recalculateProgress(jobId);
      return true;
    });
  }

  listUnfinished(): TestRunRecord[] {
    return this.list(["QUEUED", "ALLOCATING", "RUNNING", "RECOVERING", "CANCEL_REQUESTED", "CANCELLING"]);
  }

  counts(): { queued: number; running: number } {
    const queued = Number(this.store.get<{ count: number }>("SELECT COUNT(*) AS count FROM test_runs WHERE status = 'QUEUED'")?.count ?? 0);
    const running = Number(this.store.get<{ count: number }>("SELECT COUNT(*) AS count FROM test_runs WHERE status IN ('RUNNING', 'RECOVERING')")?.count ?? 0);
    return { queued, running };
  }

  private assertExecutionOwnerInTransaction(jobId: string, executionId: string): void {
    const owner = this.store.get<{ execution_owner_id: string }>("SELECT execution_owner_id FROM test_runs WHERE job_id = ?", [jobId])?.execution_owner_id;
    if (owner !== executionId) this.throwStaleExecution(jobId, executionId, owner);
  }

  private throwStaleExecution(jobId: string, executionId: string, currentOwner?: string): never {
    throw new DebugMcpError("JobExecutionStale", "Durable job execution no longer owns the run", { jobId, executionId, currentOwner });
  }
}

function mapRun(row: Record<string, unknown>): TestRunRecord {
  return {
    jobId: String(row.job_id), planName: String(row.plan_name), planVersion: Number(row.plan_version), plan: parseJson(String(row.plan_json), {}), status: String(row.status), progressCurrent: Number(row.progress_current), progressTotal: Number(row.progress_total), submittedAt: String(row.submitted_at), cancelRequested: Boolean(row.cancel_requested), failurePolicy: parseJson(String(row.failure_policy), {}),
    ...(row.started_at ? { startedAt: String(row.started_at) } : {}), ...(row.finished_at ? { finishedAt: String(row.finished_at) } : {}), ...(row.result_summary_json ? { resultSummary: parseJson(String(row.result_summary_json), {}) } : {}), ...(row.error_json ? { error: parseJson(String(row.error_json), {}) } : {})
  };
}

function mapStep(row: Record<string, unknown>): TestStepRecord {
  return {
    stepRunId: String(row.step_run_id), jobId: String(row.job_id), boardId: String(row.board_id), stepIndex: Number(row.step_index), stepType: String(row.step_type), input: parseJson(String(row.input_json), {}), status: String(row.status), attempt: Number(row.attempt), idempotencyClass: String(row.idempotency_class) as TestStepRecord["idempotencyClass"],
    ...(row.started_at ? { startedAt: String(row.started_at) } : {}), ...(row.finished_at ? { finishedAt: String(row.finished_at) } : {}), ...(row.output_json ? { output: parseJson(String(row.output_json), {}) } : {}), ...(row.error_json ? { error: parseJson(String(row.error_json), {}) } : {})
  };
}

function parseJson<T>(value: string, fallback: T): T { try { return JSON.parse(value) as T; } catch { return fallback; } }
