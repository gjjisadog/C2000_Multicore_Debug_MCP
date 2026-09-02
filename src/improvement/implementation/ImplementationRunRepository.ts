import type { SqliteStore } from "../../storage/SqliteStore.js";
import {
  improvementImplementationRunSchema,
  parseImplementationRun,
  type ImplementationRunListQuery,
  type ImplementationRunStatus,
  type ImprovementImplementationRun
} from "./ImplementationSchemas.js";

export interface ImprovementImplementationRunStore {
  get(runId: string): ImprovementImplementationRun | undefined;
  list(query?: ImplementationRunListQuery): ImprovementImplementationRun[];
  findActiveByProposal(proposalId: string): ImprovementImplementationRun | undefined;
  upsert(run: ImprovementImplementationRun): void;
  markActiveInterrupted(reason: string, nowIso: string): ImprovementImplementationRun[];
}

interface ImplementationRunRow {
  run_id: string;
  proposal_id: string;
  baseline_sha: string;
  branch_name: string;
  worktree_path: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  status: string;
  agent_attempts: number;
  agent_provider: string | null;
  agent_run_id: string | null;
  prompt_artifact_json: string | null;
  pre_implementation_status_json: string;
  post_implementation_status_json: string | null;
  validation_result_json: string | null;
  validation_commands_json: string | null;
  artifacts_json: string | null;
  candidate_commit_sha: string | null;
  failure_reason: string | null;
  coding_agent_result_json: string | null;
}

const ACTIVE_STATUSES: readonly ImplementationRunStatus[] = [
  "created",
  "agent-running",
  "agent-complete",
  "validating",
  "validation-pending",
  "validated"
];

export class ImplementationRunRepository implements ImprovementImplementationRunStore {
  constructor(private readonly store: SqliteStore) {}

  get(runId: string): ImprovementImplementationRun | undefined {
    const row = this.store.get<ImplementationRunRow>("SELECT * FROM improvement_implementation_runs WHERE run_id = ?", [runId]);
    return row ? decodeRun(row) : undefined;
  }

  list(query: ImplementationRunListQuery = {}): ImprovementImplementationRun[] {
    const clauses: string[] = [];
    const parameters: unknown[] = [];
    if (query.proposalId) {
      clauses.push("proposal_id = ?");
      parameters.push(query.proposalId);
    }
    if (query.status) {
      clauses.push("status = ?");
      parameters.push(query.status);
    }
    const limit = Math.max(1, Math.min(500, Math.trunc(query.limit ?? 100)));
    const rows = this.store.all<ImplementationRunRow>(`
      SELECT * FROM improvement_implementation_runs
      ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY created_at DESC, run_id ASC
      LIMIT ?
    `, [...parameters, limit]);
    return rows.flatMap(row => {
      const decoded = decodeRun(row);
      return decoded ? [decoded] : [];
    });
  }

  findActiveByProposal(proposalId: string): ImprovementImplementationRun | undefined {
    const placeholders = ACTIVE_STATUSES.map(() => "?").join(", ");
    const row = this.store.get<ImplementationRunRow>(`
      SELECT * FROM improvement_implementation_runs
      WHERE proposal_id = ? AND status IN (${placeholders})
      ORDER BY created_at DESC
      LIMIT 1
    `, [proposalId, ...ACTIVE_STATUSES]);
    return row ? decodeRun(row) : undefined;
  }

  upsert(run: ImprovementImplementationRun): void {
    const parsed = improvementImplementationRunSchema.parse(run);
    this.store.run(`
      INSERT INTO improvement_implementation_runs(
        run_id, proposal_id, baseline_sha, branch_name, worktree_path, created_at,
        started_at, finished_at, status, agent_attempts, agent_provider, agent_run_id,
        prompt_artifact_json, pre_implementation_status_json, post_implementation_status_json,
        validation_result_json, validation_commands_json, artifacts_json,
        candidate_commit_sha, failure_reason, coding_agent_result_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        proposal_id = excluded.proposal_id,
        baseline_sha = excluded.baseline_sha,
        branch_name = excluded.branch_name,
        worktree_path = excluded.worktree_path,
        created_at = excluded.created_at,
        started_at = excluded.started_at,
        finished_at = excluded.finished_at,
        status = excluded.status,
        agent_attempts = excluded.agent_attempts,
        agent_provider = excluded.agent_provider,
        agent_run_id = excluded.agent_run_id,
        prompt_artifact_json = excluded.prompt_artifact_json,
        pre_implementation_status_json = excluded.pre_implementation_status_json,
        post_implementation_status_json = excluded.post_implementation_status_json,
        validation_result_json = excluded.validation_result_json,
        validation_commands_json = excluded.validation_commands_json,
        artifacts_json = excluded.artifacts_json,
        candidate_commit_sha = excluded.candidate_commit_sha,
        failure_reason = excluded.failure_reason,
        coding_agent_result_json = excluded.coding_agent_result_json
    `, [
      parsed.runId,
      parsed.proposalId,
      parsed.baselineSha,
      parsed.branchName,
      parsed.worktreePath,
      parsed.createdAt,
      parsed.startedAt ?? null,
      parsed.finishedAt ?? null,
      parsed.status,
      parsed.agentAttempts,
      parsed.agentProvider ?? null,
      parsed.agentRunId ?? null,
      parsed.promptArtifact ? JSON.stringify(parsed.promptArtifact) : null,
      JSON.stringify(parsed.preImplementationStatus),
      parsed.postImplementationStatus ? JSON.stringify(parsed.postImplementationStatus) : null,
      parsed.validationResult ? JSON.stringify(parsed.validationResult) : null,
      parsed.validationCommands ? JSON.stringify(parsed.validationCommands) : null,
      parsed.artifacts ? JSON.stringify(parsed.artifacts) : null,
      parsed.candidateCommitSha ?? null,
      parsed.failureReason ?? null,
      parsed.codingAgentResult ? JSON.stringify(parsed.codingAgentResult) : null
    ]);
  }

  markActiveInterrupted(reason: string, nowIso: string): ImprovementImplementationRun[] {
    const runs = this.list();
    const interrupted: ImprovementImplementationRun[] = [];
    for (const run of runs) {
      if (!ACTIVE_STATUSES.includes(run.status)) continue;
      const next = improvementImplementationRunSchema.parse({
        ...run,
        status: "interrupted",
        finishedAt: nowIso,
        failureReason: reason
      });
      this.upsert(next);
      interrupted.push(next);
    }
    return interrupted;
  }
}

export class InMemoryImprovementImplementationRunStore implements ImprovementImplementationRunStore {
  private readonly runs = new Map<string, ImprovementImplementationRun>();

  get(runId: string): ImprovementImplementationRun | undefined {
    const run = this.runs.get(runId);
    return run ? structuredClone(run) : undefined;
  }

  list(query: ImplementationRunListQuery = {}): ImprovementImplementationRun[] {
    return Array.from(this.runs.values())
      .filter(run => !query.proposalId || run.proposalId === query.proposalId)
      .filter(run => !query.status || run.status === query.status)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.runId.localeCompare(right.runId))
      .slice(0, Math.max(1, Math.min(500, Math.trunc(query.limit ?? 100))))
      .map(run => structuredClone(run));
  }

  findActiveByProposal(proposalId: string): ImprovementImplementationRun | undefined {
    return this.list().find(run => run.proposalId === proposalId && ACTIVE_STATUSES.includes(run.status));
  }

  upsert(run: ImprovementImplementationRun): void {
    this.runs.set(run.runId, structuredClone(improvementImplementationRunSchema.parse(run)));
  }

  markActiveInterrupted(reason: string, nowIso: string): ImprovementImplementationRun[] {
    const updated: ImprovementImplementationRun[] = [];
    for (const run of this.list()) {
      if (!ACTIVE_STATUSES.includes(run.status)) continue;
      const next = improvementImplementationRunSchema.parse({ ...run, status: "interrupted", finishedAt: nowIso, failureReason: reason });
      this.upsert(next);
      updated.push(next);
    }
    return updated;
  }
}

function decodeRun(row: ImplementationRunRow): ImprovementImplementationRun | undefined {
  try {
    return parseImplementationRun({
      runId: row.run_id,
      proposalId: row.proposal_id,
      baselineSha: row.baseline_sha,
      branchName: row.branch_name,
      worktreePath: row.worktree_path,
      createdAt: row.created_at,
      ...(row.started_at ? { startedAt: row.started_at } : {}),
      ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
      status: row.status,
      agentAttempts: Number.isInteger(row.agent_attempts) ? row.agent_attempts : 0,
      ...(row.agent_provider ? { agentProvider: row.agent_provider } : {}),
      ...(row.agent_run_id ? { agentRunId: row.agent_run_id } : {}),
      ...(row.prompt_artifact_json ? { promptArtifact: JSON.parse(row.prompt_artifact_json) } : {}),
      preImplementationStatus: JSON.parse(row.pre_implementation_status_json),
      ...(row.post_implementation_status_json ? { postImplementationStatus: JSON.parse(row.post_implementation_status_json) } : {}),
      ...(row.validation_result_json ? { validationResult: JSON.parse(row.validation_result_json) } : {}),
      ...(row.validation_commands_json ? { validationCommands: JSON.parse(row.validation_commands_json) } : {}),
      ...(row.artifacts_json ? { artifacts: JSON.parse(row.artifacts_json) } : {}),
      ...(row.candidate_commit_sha ? { candidateCommitSha: row.candidate_commit_sha } : {}),
      ...(row.failure_reason ? { failureReason: row.failure_reason } : {}),
      ...(row.coding_agent_result_json ? { codingAgentResult: JSON.parse(row.coding_agent_result_json) } : {})
    });
  } catch {
    return undefined;
  }
}
