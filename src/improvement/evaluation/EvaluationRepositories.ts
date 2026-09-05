import type { SqliteStore } from "../../storage/SqliteStore.js";
import {
  postMergeEvaluationSchema,
  postMergeEvaluationSnapshotSchema,
  rollbackRecommendationSchema,
  type PostMergeEvaluation,
  type PostMergeEvaluationSnapshot,
  type RollbackRecommendation,
  type PostMergeEvaluationStatus,
  type PostMergeVerdict
} from "./EvaluationSchemas.js";

export interface PostMergeEvaluationListQuery {
  proposalId?: string;
  lifecycleStatus?: PostMergeEvaluationStatus;
  verdict?: PostMergeVerdict;
  limit?: number;
}

export interface PostMergeEvaluationStore {
  get(evaluationId: string): PostMergeEvaluation | undefined;
  findByPullRequest(pullRequestId: string): PostMergeEvaluation | undefined;
  list(query?: PostMergeEvaluationListQuery): PostMergeEvaluation[];
  upsert(value: PostMergeEvaluation): void;
}

export interface PostMergeEvaluationSnapshotStore {
  list(evaluationId: string, limit?: number): PostMergeEvaluationSnapshot[];
  append(value: PostMergeEvaluationSnapshot): void;
}

export interface RollbackRecommendationStore {
  get(recommendationId: string): RollbackRecommendation | undefined;
  getForEvaluation(evaluationId: string): RollbackRecommendation | undefined;
  list(limit?: number): RollbackRecommendation[];
  upsert(value: RollbackRecommendation): void;
}

interface EvaluationRow {
  evaluation_id: string;
  proposal_id: string;
  pull_request_id: string;
  pull_request_number: number | null;
  baseline_sha: string;
  candidate_sha: string;
  merged_commit_sha: string;
  merged_at: string;
  created_at: string;
  updated_at: string;
  lifecycle_status: string;
  verdict: string | null;
  confidence: number;
  rollback_recommendation_id: string | null;
  record_json: string;
}

interface SnapshotRow {
  snapshot_id: string;
  evaluation_id: string;
  phase: string;
  captured_at: string;
  record_json: string;
}

interface RollbackRow {
  recommendation_id: string;
  evaluation_id: string;
  proposal_id: string;
  merged_commit_sha: string;
  severity: string;
  status: string;
  created_at: string;
  updated_at: string;
  record_json: string;
}

export class PostMergeEvaluationRepository implements PostMergeEvaluationStore {
  constructor(private readonly store: SqliteStore) {}

  get(evaluationId: string): PostMergeEvaluation | undefined {
    const row = this.store.get<EvaluationRow>("SELECT * FROM post_merge_evaluations WHERE evaluation_id = ?", [evaluationId]);
    return row ? decodeEvaluation(row) : undefined;
  }

  findByPullRequest(pullRequestId: string): PostMergeEvaluation | undefined {
    const row = this.store.get<EvaluationRow>("SELECT * FROM post_merge_evaluations WHERE pull_request_id = ? ORDER BY updated_at DESC LIMIT 1", [pullRequestId]);
    return row ? decodeEvaluation(row) : undefined;
  }

  list(query: PostMergeEvaluationListQuery = {}): PostMergeEvaluation[] {
    const clauses: string[] = [];
    const parameters: unknown[] = [];
    if (query.proposalId) { clauses.push("proposal_id = ?"); parameters.push(query.proposalId); }
    if (query.lifecycleStatus) { clauses.push("lifecycle_status = ?"); parameters.push(query.lifecycleStatus); }
    if (query.verdict) { clauses.push("verdict = ?"); parameters.push(query.verdict); }
    const limit = clampLimit(query.limit);
    return this.store.all<EvaluationRow>(`
      SELECT * FROM post_merge_evaluations
      ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY updated_at DESC, evaluation_id ASC LIMIT ?
    `, [...parameters, limit]).flatMap(row => {
      const value = decodeEvaluation(row);
      return value ? [value] : [];
    });
  }

  upsert(value: PostMergeEvaluation): void {
    const parsed = postMergeEvaluationSchema.parse(value);
    this.store.run(`
      INSERT INTO post_merge_evaluations(
        evaluation_id, proposal_id, pull_request_id, pull_request_number,
        baseline_sha, candidate_sha, merged_commit_sha, merged_at, created_at,
        updated_at, lifecycle_status, verdict, confidence,
        rollback_recommendation_id, record_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(evaluation_id) DO UPDATE SET
        proposal_id = excluded.proposal_id,
        pull_request_id = excluded.pull_request_id,
        pull_request_number = excluded.pull_request_number,
        baseline_sha = excluded.baseline_sha,
        candidate_sha = excluded.candidate_sha,
        merged_commit_sha = excluded.merged_commit_sha,
        merged_at = excluded.merged_at,
        updated_at = excluded.updated_at,
        lifecycle_status = excluded.lifecycle_status,
        verdict = excluded.verdict,
        confidence = excluded.confidence,
        rollback_recommendation_id = excluded.rollback_recommendation_id,
        record_json = excluded.record_json
    `, [
      parsed.evaluationId, parsed.proposalId, parsed.pullRequestId, parsed.pullRequestNumber ?? null,
      parsed.baselineSha, parsed.candidateSha, parsed.mergedCommitSha, parsed.mergedAt,
      parsed.createdAt, parsed.updatedAt, parsed.lifecycleStatus, parsed.verdict ?? null,
      parsed.confidence, parsed.rollbackRecommendationId ?? null, JSON.stringify(parsed)
    ]);
  }
}

export class PostMergeEvaluationSnapshotRepository implements PostMergeEvaluationSnapshotStore {
  constructor(private readonly store: SqliteStore) {}

  list(evaluationId: string, limit = 128): PostMergeEvaluationSnapshot[] {
    return this.store.all<SnapshotRow>("SELECT * FROM post_merge_evaluation_snapshots WHERE evaluation_id = ? ORDER BY captured_at ASC, snapshot_id ASC LIMIT ?", [evaluationId, clampSnapshotLimit(limit)]).flatMap(row => {
      const value = decodeSnapshot(row);
      return value ? [value] : [];
    });
  }

  append(value: PostMergeEvaluationSnapshot): void {
    const parsed = postMergeEvaluationSnapshotSchema.parse(value);
    this.store.run(`
      INSERT OR REPLACE INTO post_merge_evaluation_snapshots(
        snapshot_id, evaluation_id, phase, captured_at, record_json
      ) VALUES (?, ?, ?, ?, ?)
    `, [parsed.snapshotId, parsed.evaluationId, parsed.phase, parsed.capturedAt, JSON.stringify(parsed)]);
  }
}

export class RollbackRecommendationRepository implements RollbackRecommendationStore {
  constructor(private readonly store: SqliteStore) {}

  get(recommendationId: string): RollbackRecommendation | undefined {
    const row = this.store.get<RollbackRow>("SELECT * FROM rollback_recommendations WHERE recommendation_id = ?", [recommendationId]);
    return row ? decodeRollback(row) : undefined;
  }

  getForEvaluation(evaluationId: string): RollbackRecommendation | undefined {
    const row = this.store.get<RollbackRow>("SELECT * FROM rollback_recommendations WHERE evaluation_id = ? ORDER BY updated_at DESC LIMIT 1", [evaluationId]);
    return row ? decodeRollback(row) : undefined;
  }

  list(limit = 100): RollbackRecommendation[] {
    return this.store.all<RollbackRow>("SELECT * FROM rollback_recommendations ORDER BY updated_at DESC, recommendation_id ASC LIMIT ?", [clampLimit(limit)]).flatMap(row => {
      const value = decodeRollback(row);
      return value ? [value] : [];
    });
  }

  upsert(value: RollbackRecommendation): void {
    const parsed = rollbackRecommendationSchema.parse(value);
    this.store.run(`
      INSERT INTO rollback_recommendations(
        recommendation_id, evaluation_id, proposal_id, merged_commit_sha,
        severity, status, created_at, updated_at, record_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(recommendation_id) DO UPDATE SET
        evaluation_id = excluded.evaluation_id,
        proposal_id = excluded.proposal_id,
        merged_commit_sha = excluded.merged_commit_sha,
        severity = excluded.severity,
        status = excluded.status,
        updated_at = excluded.updated_at,
        record_json = excluded.record_json
    `, [parsed.recommendationId, parsed.evaluationId, parsed.proposalId, parsed.mergedCommitSha, parsed.severity, parsed.status, parsed.createdAt, parsed.updatedAt, JSON.stringify(parsed)]);
  }
}

export class InMemoryPostMergeEvaluationStore implements PostMergeEvaluationStore {
  private readonly values = new Map<string, PostMergeEvaluation>();
  get(evaluationId: string): PostMergeEvaluation | undefined { const value = this.values.get(evaluationId); return value ? structuredClone(value) : undefined; }
  findByPullRequest(pullRequestId: string): PostMergeEvaluation | undefined {
    const value = [...this.values.values()].filter(item => item.pullRequestId === pullRequestId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    return value ? structuredClone(value) : undefined;
  }
  list(query: PostMergeEvaluationListQuery = {}): PostMergeEvaluation[] {
    return [...this.values.values()]
      .filter(item => !query.proposalId || item.proposalId === query.proposalId)
      .filter(item => !query.lifecycleStatus || item.lifecycleStatus === query.lifecycleStatus)
      .filter(item => !query.verdict || item.verdict === query.verdict)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.evaluationId.localeCompare(b.evaluationId))
      .slice(0, clampLimit(query.limit))
      .map(item => structuredClone(item));
  }
  upsert(value: PostMergeEvaluation): void { this.values.set(value.evaluationId, structuredClone(postMergeEvaluationSchema.parse(value))); }
}

export class InMemoryPostMergeEvaluationSnapshotStore implements PostMergeEvaluationSnapshotStore {
  private readonly values = new Map<string, PostMergeEvaluationSnapshot>();
  list(evaluationId: string, limit = 128): PostMergeEvaluationSnapshot[] {
    return [...this.values.values()].filter(item => item.evaluationId === evaluationId).sort((a, b) => a.capturedAt.localeCompare(b.capturedAt) || a.snapshotId.localeCompare(b.snapshotId)).slice(0, clampSnapshotLimit(limit)).map(item => structuredClone(item));
  }
  append(value: PostMergeEvaluationSnapshot): void { this.values.set(value.snapshotId, structuredClone(postMergeEvaluationSnapshotSchema.parse(value))); }
}

export class InMemoryRollbackRecommendationStore implements RollbackRecommendationStore {
  private readonly values = new Map<string, RollbackRecommendation>();
  get(recommendationId: string): RollbackRecommendation | undefined { const value = this.values.get(recommendationId); return value ? structuredClone(value) : undefined; }
  getForEvaluation(evaluationId: string): RollbackRecommendation | undefined {
    const value = [...this.values.values()].filter(item => item.evaluationId === evaluationId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    return value ? structuredClone(value) : undefined;
  }
  list(limit = 100): RollbackRecommendation[] { return [...this.values.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, clampLimit(limit)).map(item => structuredClone(item)); }
  upsert(value: RollbackRecommendation): void { this.values.set(value.recommendationId, structuredClone(rollbackRecommendationSchema.parse(value))); }
}

function decodeEvaluation(row: EvaluationRow): PostMergeEvaluation | undefined {
  try {
    const parsed = postMergeEvaluationSchema.safeParse(JSON.parse(row.record_json));
    return parsed.success ? parsed.data : undefined;
  } catch { return undefined; }
}

function decodeSnapshot(row: SnapshotRow): PostMergeEvaluationSnapshot | undefined {
  try {
    const parsed = postMergeEvaluationSnapshotSchema.safeParse(JSON.parse(row.record_json));
    return parsed.success ? parsed.data : undefined;
  } catch { return undefined; }
}

function decodeRollback(row: RollbackRow): RollbackRecommendation | undefined {
  try {
    const parsed = rollbackRecommendationSchema.safeParse(JSON.parse(row.record_json));
    return parsed.success ? parsed.data : undefined;
  } catch { return undefined; }
}

function clampLimit(value = 100): number { return Math.max(1, Math.min(500, Math.trunc(value))); }
function clampSnapshotLimit(value = 128): number { return Math.max(1, Math.min(512, Math.trunc(value))); }
