import type { SqliteStore } from "../../storage/SqliteStore.js";
import {
  improvementPullRequestSchema,
  mergeRecommendationSchema,
  reviewEvidenceSchema,
  type ImprovementPullRequest,
  type MergeRecommendation,
  type ReviewEvidence
} from "./ReviewSchemas.js";

export interface ImprovementPullRequestStore {
  get(pullRequestId: string): ImprovementPullRequest | undefined;
  findByImplementationRun(implementationRunId: string): ImprovementPullRequest | undefined;
  findByNumber(repository: string, number: number): ImprovementPullRequest | undefined;
  findOpenByCandidate(repository: string, branch: string, candidateSha: string): ImprovementPullRequest | undefined;
  list(limit?: number): ImprovementPullRequest[];
  upsert(value: ImprovementPullRequest): void;
}

export interface ImprovementReviewEvidenceStore {
  getLatest(pullRequestId: string, candidateSha?: string): ReviewEvidence | undefined;
  upsert(value: ReviewEvidence): void;
}

export interface MergeRecommendationStore {
  get(recommendationId: string): MergeRecommendation | undefined;
  getLatest(pullRequestId: string, candidateSha?: string): MergeRecommendation | undefined;
  upsert(value: MergeRecommendation): void;
}

interface PullRequestRow {
  pull_request_id: string;
  proposal_id: string;
  implementation_run_id: string;
  current_implementation_run_id: string | null;
  repository: string;
  branch: string;
  base_branch: string;
  candidate_sha: string;
  baseline_sha: string;
  number: number | null;
  url: string | null;
  title: string;
  status: string;
  draft: number;
  created_at: string;
  updated_at: string;
  original_base_sha: string | null;
  current_base_sha: string | null;
  current_head_sha: string | null;
  merged_commit_sha: string | null;
  merged_at: string | null;
  generated_body_hash: string;
  human_body_preserved: number;
  revision_history_json: string | null;
  record_json: string;
}

interface EvidenceRow {
  evidence_id: string;
  pull_request_id: string;
  candidate_sha: string;
  checked_at: string;
  evidence_hash: string;
  record_json: string;
}

interface RecommendationRow {
  recommendation_id: string;
  pull_request_id: string;
  candidate_sha: string;
  generated_at: string;
  evidence_hash: string;
  verdict: string;
  record_json: string;
}

export class ImprovementPullRequestRepository implements ImprovementPullRequestStore {
  constructor(private readonly store: SqliteStore) {}

  get(pullRequestId: string): ImprovementPullRequest | undefined {
    const row = this.store.get<PullRequestRow>("SELECT * FROM improvement_pull_requests WHERE pull_request_id = ?", [pullRequestId]);
    return row ? decodePullRequest(row) : undefined;
  }

  findByImplementationRun(implementationRunId: string): ImprovementPullRequest | undefined {
    const row = this.store.get<PullRequestRow>("SELECT * FROM improvement_pull_requests WHERE implementation_run_id = ? OR current_implementation_run_id = ? ORDER BY updated_at DESC LIMIT 1", [implementationRunId, implementationRunId]);
    return row ? decodePullRequest(row) : undefined;
  }

  findByNumber(repository: string, number: number): ImprovementPullRequest | undefined {
    const row = this.store.get<PullRequestRow>("SELECT * FROM improvement_pull_requests WHERE repository = ? AND number = ?", [repository, number]);
    return row ? decodePullRequest(row) : undefined;
  }

  findOpenByCandidate(repository: string, branch: string, candidateSha: string): ImprovementPullRequest | undefined {
    const row = this.store.get<PullRequestRow>(`
      SELECT * FROM improvement_pull_requests
      WHERE repository = ? AND branch = ? AND candidate_sha = ?
        AND status NOT IN ('closed', 'merged-externally')
      ORDER BY updated_at DESC LIMIT 1
    `, [repository, branch, candidateSha]);
    return row ? decodePullRequest(row) : undefined;
  }

  list(limit = 100): ImprovementPullRequest[] {
    const rows = this.store.all<PullRequestRow>("SELECT * FROM improvement_pull_requests ORDER BY updated_at DESC, pull_request_id ASC LIMIT ?", [clampLimit(limit)]);
    return rows.flatMap(row => {
      const decoded = decodePullRequest(row);
      return decoded ? [decoded] : [];
    });
  }

  upsert(value: ImprovementPullRequest): void {
    const parsed = improvementPullRequestSchema.parse(value);
    this.store.run(`
      INSERT INTO improvement_pull_requests(
        pull_request_id, proposal_id, implementation_run_id, current_implementation_run_id, repository, branch, base_branch,
        candidate_sha, baseline_sha, number, url, title, status, draft, created_at, updated_at,
        original_base_sha, current_base_sha, current_head_sha, merged_commit_sha, merged_at,
        generated_body_hash, human_body_preserved, revision_history_json, record_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(pull_request_id) DO UPDATE SET
        proposal_id = excluded.proposal_id,
        implementation_run_id = excluded.implementation_run_id,
        current_implementation_run_id = excluded.current_implementation_run_id,
        repository = excluded.repository,
        branch = excluded.branch,
        base_branch = excluded.base_branch,
        candidate_sha = excluded.candidate_sha,
        baseline_sha = excluded.baseline_sha,
        number = excluded.number,
        url = excluded.url,
        title = excluded.title,
        status = excluded.status,
        draft = excluded.draft,
        updated_at = excluded.updated_at,
        original_base_sha = excluded.original_base_sha,
        current_base_sha = excluded.current_base_sha,
        current_head_sha = excluded.current_head_sha,
        merged_commit_sha = excluded.merged_commit_sha,
        merged_at = excluded.merged_at,
        generated_body_hash = excluded.generated_body_hash,
        human_body_preserved = excluded.human_body_preserved,
        revision_history_json = excluded.revision_history_json,
        record_json = excluded.record_json
    `, [
      parsed.pullRequestId,
      parsed.proposalId,
      parsed.implementationRunId,
      parsed.currentImplementationRunId ?? null,
      parsed.repository,
      parsed.branch,
      parsed.baseBranch,
      parsed.candidateSha,
      parsed.baselineSha,
      parsed.number ?? null,
      parsed.url ?? null,
      parsed.title,
      parsed.status,
      parsed.draft ? 1 : 0,
      parsed.createdAt,
      parsed.updatedAt,
      parsed.originalBaseSha ?? null,
      parsed.currentBaseSha ?? null,
      parsed.currentHeadSha ?? null,
      parsed.mergedCommitSha ?? null,
      parsed.mergedAt ?? null,
      parsed.generatedBodyHash,
      parsed.humanBodyPreserved ? 1 : 0,
      JSON.stringify(parsed.revisionHistory),
      JSON.stringify(parsed)
    ]);
  }
}

export class ImprovementReviewEvidenceRepository implements ImprovementReviewEvidenceStore {
  constructor(private readonly store: SqliteStore) {}

  getLatest(pullRequestId: string, candidateSha?: string): ReviewEvidence | undefined {
    const row = this.store.get<EvidenceRow>(`
      SELECT * FROM improvement_review_evidence
      WHERE pull_request_id = ? ${candidateSha ? "AND candidate_sha = ?" : ""}
      ORDER BY checked_at DESC, evidence_id DESC LIMIT 1
    `, candidateSha ? [pullRequestId, candidateSha] : [pullRequestId]);
    return row ? decodeEvidence(row) : undefined;
  }

  upsert(value: ReviewEvidence): void {
    const parsed = reviewEvidenceSchema.parse(value);
    this.store.run(`
      INSERT INTO improvement_review_evidence(
        evidence_id, pull_request_id, candidate_sha, checked_at, evidence_hash, record_json
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(evidence_id) DO UPDATE SET
        pull_request_id = excluded.pull_request_id,
        candidate_sha = excluded.candidate_sha,
        checked_at = excluded.checked_at,
        evidence_hash = excluded.evidence_hash,
        record_json = excluded.record_json
    `, [parsed.evidenceId, parsed.pullRequestId, parsed.candidateSha, parsed.checkedAt, parsed.evidenceHash, JSON.stringify(parsed)]);
  }
}

export class MergeRecommendationRepository implements MergeRecommendationStore {
  constructor(private readonly store: SqliteStore) {}

  get(recommendationId: string): MergeRecommendation | undefined {
    const row = this.store.get<RecommendationRow>("SELECT * FROM merge_recommendations WHERE recommendation_id = ?", [recommendationId]);
    return row ? decodeRecommendation(row) : undefined;
  }

  getLatest(pullRequestId: string, candidateSha?: string): MergeRecommendation | undefined {
    const row = this.store.get<RecommendationRow>(`
      SELECT * FROM merge_recommendations
      WHERE pull_request_id = ? ${candidateSha ? "AND candidate_sha = ?" : ""}
      ORDER BY generated_at DESC, recommendation_id DESC LIMIT 1
    `, candidateSha ? [pullRequestId, candidateSha] : [pullRequestId]);
    return row ? decodeRecommendation(row) : undefined;
  }

  upsert(value: MergeRecommendation): void {
    const parsed = mergeRecommendationSchema.parse(value);
    this.store.run(`
      INSERT INTO merge_recommendations(
        recommendation_id, pull_request_id, candidate_sha, generated_at, evidence_hash, verdict, record_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(recommendation_id) DO UPDATE SET
        pull_request_id = excluded.pull_request_id,
        candidate_sha = excluded.candidate_sha,
        generated_at = excluded.generated_at,
        evidence_hash = excluded.evidence_hash,
        verdict = excluded.verdict,
        record_json = excluded.record_json
    `, [parsed.recommendationId, parsed.pullRequestId, parsed.candidateSha, parsed.generatedAt, parsed.evidenceHash, parsed.verdict, JSON.stringify(parsed)]);
  }
}

export class InMemoryImprovementPullRequestStore implements ImprovementPullRequestStore {
  private readonly values = new Map<string, ImprovementPullRequest>();

  get(pullRequestId: string): ImprovementPullRequest | undefined {
    const value = this.values.get(pullRequestId);
    return value ? structuredClone(value) : undefined;
  }

  findByImplementationRun(implementationRunId: string): ImprovementPullRequest | undefined {
    const value = Array.from(this.values.values()).find(item => item.implementationRunId === implementationRunId || item.currentImplementationRunId === implementationRunId);
    return value ? structuredClone(value) : undefined;
  }

  findByNumber(repository: string, number: number): ImprovementPullRequest | undefined {
    const value = Array.from(this.values.values()).find(item => item.repository === repository && item.number === number);
    return value ? structuredClone(value) : undefined;
  }

  findOpenByCandidate(repository: string, branch: string, candidateSha: string): ImprovementPullRequest | undefined {
    const value = Array.from(this.values.values()).find(item => item.repository === repository && item.branch === branch && item.candidateSha === candidateSha && !["closed", "merged-externally"].includes(item.status));
    return value ? structuredClone(value) : undefined;
  }

  list(limit = 100): ImprovementPullRequest[] {
    return Array.from(this.values.values()).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.pullRequestId.localeCompare(right.pullRequestId)).slice(0, clampLimit(limit)).map(value => structuredClone(value));
  }

  upsert(value: ImprovementPullRequest): void {
    this.values.set(value.pullRequestId, structuredClone(improvementPullRequestSchema.parse(value)));
  }
}

export class InMemoryImprovementReviewEvidenceStore implements ImprovementReviewEvidenceStore {
  private readonly values = new Map<string, ReviewEvidence>();

  getLatest(pullRequestId: string, candidateSha?: string): ReviewEvidence | undefined {
    const values = Array.from(this.values.values()).filter(value => value.pullRequestId === pullRequestId && (!candidateSha || value.candidateSha === candidateSha)).sort((left, right) => right.checkedAt.localeCompare(left.checkedAt) || right.evidenceId.localeCompare(left.evidenceId));
    return values[0] ? structuredClone(values[0]) : undefined;
  }

  upsert(value: ReviewEvidence): void {
    this.values.set(value.evidenceId, structuredClone(reviewEvidenceSchema.parse(value)));
  }
}

export class InMemoryMergeRecommendationStore implements MergeRecommendationStore {
  private readonly values = new Map<string, MergeRecommendation>();

  get(recommendationId: string): MergeRecommendation | undefined {
    const value = this.values.get(recommendationId);
    return value ? structuredClone(value) : undefined;
  }

  getLatest(pullRequestId: string, candidateSha?: string): MergeRecommendation | undefined {
    const values = Array.from(this.values.values()).filter(value => value.pullRequestId === pullRequestId && (!candidateSha || value.candidateSha === candidateSha)).sort((left, right) => right.generatedAt.localeCompare(left.generatedAt) || right.recommendationId.localeCompare(left.recommendationId));
    return values[0] ? structuredClone(values[0]) : undefined;
  }

  upsert(value: MergeRecommendation): void {
    this.values.set(value.recommendationId, structuredClone(mergeRecommendationSchema.parse(value)));
  }
}

function decodePullRequest(row: PullRequestRow): ImprovementPullRequest | undefined {
  try {
    const parsed = improvementPullRequestSchema.safeParse(JSON.parse(row.record_json));
    if (parsed.success) return parsed.data;
    const fallback = improvementPullRequestSchema.safeParse({
      pullRequestId: row.pull_request_id,
      proposalId: row.proposal_id,
      implementationRunId: row.implementation_run_id,
      ...(row.current_implementation_run_id ? { currentImplementationRunId: row.current_implementation_run_id } : {}),
      repository: row.repository,
      branch: row.branch,
      baseBranch: row.base_branch,
      candidateSha: row.candidate_sha,
      baselineSha: row.baseline_sha,
      ...(row.number === null ? {} : { number: row.number }),
      ...(row.url ? { url: row.url } : {}),
      title: row.title,
      status: row.status,
      draft: row.draft === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.original_base_sha ? { originalBaseSha: row.original_base_sha } : {}),
      ...(row.current_base_sha ? { currentBaseSha: row.current_base_sha } : {}),
      ...(row.current_head_sha ? { currentHeadSha: row.current_head_sha } : {}),
      ...(row.merged_commit_sha ? { mergedCommitSha: row.merged_commit_sha } : {}),
      ...(row.merged_at ? { mergedAt: row.merged_at } : {}),
      generatedBodyHash: row.generated_body_hash,
      humanBodyPreserved: row.human_body_preserved === 1,
      revisionHistory: row.revision_history_json ? JSON.parse(row.revision_history_json) : []
    });
    return fallback.success ? fallback.data : undefined;
  } catch {
    return undefined;
  }
}

function decodeEvidence(row: EvidenceRow): ReviewEvidence | undefined {
  try {
    const parsed = reviewEvidenceSchema.safeParse(JSON.parse(row.record_json));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function decodeRecommendation(row: RecommendationRow): MergeRecommendation | undefined {
  try {
    const parsed = mergeRecommendationSchema.safeParse(JSON.parse(row.record_json));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function clampLimit(value: number): number {
  return Math.max(1, Math.min(500, Math.trunc(value)));
}
