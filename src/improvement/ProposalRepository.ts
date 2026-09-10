import type { SqliteStore } from "../storage/SqliteStore.js";
import {
  improvementProposalSchema,
  type ImprovementProposal,
  type ProposalCategory,
  type ProposalStatus
} from "./ProposalSchemas.js";

export interface ProposalListQuery {
  status?: ProposalStatus;
  category?: ProposalCategory;
  target?: string;
  minConfidence?: number;
  limit?: number;
}

export interface ImprovementProposalStore {
  get(proposalId: string): ImprovementProposal | undefined;
  findByFingerprint(fingerprint: string): ImprovementProposal | undefined;
  list(query?: ProposalListQuery): ImprovementProposal[];
  upsert(proposal: ImprovementProposal): void;
}

interface ImprovementProposalRow {
  proposal_id: string;
  fingerprint: string;
  status: string;
  category: string;
  target: string;
  title: string;
  summary: string;
  evidence_json: string;
  proposed_change_json: string;
  expected_benefit_json: string;
  risks_json: string;
  validation_json: string;
  validation_result_json: string | null;
  confidence: number;
  priority: string;
  generated_by: string;
  source_window: string;
  proposal_source: string | null;
  policy_regime: string | null;
  engineering_policy_hash: string | null;
  source_recommendation_id: string | null;
  baseline_sha: string | null;
  primary_metrics_json: string | null;
  primary_metrics_locked: number | null;
  primary_metrics_locked_at: string | null;
  primary_metrics_source: string | null;
  final_outcome: string | null;
  created_at: string;
  updated_at: string;
  last_observed_at: string;
  review_reason: string | null;
  reviewed_at: string | null;
  reviewed_by: string | null;
}

/** SQLite-backed, history-preserving Proposal store. Corrupt rows are ignored. */
export class ProposalRepository implements ImprovementProposalStore {
  constructor(private readonly store: SqliteStore) {}

  get(proposalId: string): ImprovementProposal | undefined {
    const row = this.store.get<ImprovementProposalRow>(
      "SELECT * FROM improvement_proposals WHERE proposal_id = ?",
      [proposalId]
    );
    return row ? decodeProposal(row) : undefined;
  }

  findByFingerprint(fingerprint: string): ImprovementProposal | undefined {
    const row = this.store.get<ImprovementProposalRow>(
      "SELECT * FROM improvement_proposals WHERE fingerprint = ?",
      [fingerprint]
    );
    return row ? decodeProposal(row) : undefined;
  }

  list(query: ProposalListQuery = {}): ImprovementProposal[] {
    const clauses: string[] = [];
    const parameters: unknown[] = [];
    if (query.status) {
      clauses.push("status = ?");
      parameters.push(query.status);
    }
    if (query.category) {
      clauses.push("category = ?");
      parameters.push(query.category);
    }
    if (query.target) {
      clauses.push("target = ?");
      parameters.push(query.target);
    }
    if (query.minConfidence !== undefined) {
      clauses.push("confidence >= ?");
      parameters.push(query.minConfidence);
    }
    const limit = Math.max(1, Math.min(500, Math.trunc(query.limit ?? 100)));
    const rows = this.store.all<ImprovementProposalRow>(`
      SELECT * FROM improvement_proposals
      ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY CASE status
        WHEN 'ready-for-review' THEN 0
        WHEN 'approved' THEN 1
        WHEN 'implementation-queued' THEN 2
        WHEN 'implementing' THEN 3
        WHEN 'validation-pending' THEN 4
        WHEN 'candidate-ready' THEN 5
        WHEN 'draft' THEN 6
        WHEN 'deferred' THEN 7
        ELSE 8
      END, updated_at DESC, proposal_id ASC
      LIMIT ?
    `, [...parameters, limit]);
    return rows.flatMap(row => {
      const decoded = decodeProposal(row);
      return decoded ? [decoded] : [];
    });
  }

  upsert(proposal: ImprovementProposal): void {
    const parsed = improvementProposalSchema.parse(proposal);
    this.store.run(`
      INSERT INTO improvement_proposals(
        proposal_id, fingerprint, status, category, target, title, summary,
        evidence_json, proposed_change_json, expected_benefit_json, risks_json,
        validation_json, validation_result_json, confidence, priority, generated_by, source_window,
        proposal_source, policy_regime, engineering_policy_hash, source_recommendation_id,
        baseline_sha, primary_metrics_json, primary_metrics_locked,
        primary_metrics_locked_at, primary_metrics_source, final_outcome,
        created_at, updated_at, last_observed_at, review_reason, reviewed_at, reviewed_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(proposal_id) DO UPDATE SET
        fingerprint = excluded.fingerprint,
        status = excluded.status,
        category = excluded.category,
        target = excluded.target,
        title = excluded.title,
        summary = excluded.summary,
        evidence_json = excluded.evidence_json,
        proposed_change_json = excluded.proposed_change_json,
        expected_benefit_json = excluded.expected_benefit_json,
        risks_json = excluded.risks_json,
        validation_json = excluded.validation_json,
        validation_result_json = excluded.validation_result_json,
        confidence = excluded.confidence,
        priority = excluded.priority,
        generated_by = excluded.generated_by,
        source_window = excluded.source_window,
        proposal_source = excluded.proposal_source,
        policy_regime = excluded.policy_regime,
        engineering_policy_hash = excluded.engineering_policy_hash,
        source_recommendation_id = excluded.source_recommendation_id,
        baseline_sha = excluded.baseline_sha,
        primary_metrics_json = excluded.primary_metrics_json,
        primary_metrics_locked = excluded.primary_metrics_locked,
        primary_metrics_locked_at = excluded.primary_metrics_locked_at,
        primary_metrics_source = excluded.primary_metrics_source,
        final_outcome = excluded.final_outcome,
        updated_at = excluded.updated_at,
        last_observed_at = excluded.last_observed_at,
        review_reason = excluded.review_reason,
        reviewed_at = excluded.reviewed_at,
        reviewed_by = excluded.reviewed_by
    `, [
      parsed.proposalId,
      parsed.fingerprint,
      parsed.status,
      parsed.category,
      parsed.target,
      parsed.title,
      parsed.summary,
      JSON.stringify(parsed.evidence),
      JSON.stringify(parsed.proposedChange),
      JSON.stringify(parsed.expectedBenefit),
      JSON.stringify(parsed.risks),
      JSON.stringify(parsed.validationPlan),
      parsed.validationResult ? JSON.stringify(parsed.validationResult) : null,
      parsed.confidence,
      parsed.priority,
      parsed.generatedBy,
      parsed.sourceWindow,
      parsed.source,
      parsed.policyRegime ?? null,
      parsed.engineeringPolicyHash ?? null,
      parsed.sourceRecommendationId ?? null,
      parsed.baselineSha ?? null,
      JSON.stringify(parsed.primaryMetrics),
      parsed.primaryMetricsLocked ? 1 : 0,
      parsed.primaryMetricsLockedAt ?? null,
      parsed.primaryMetricsSource,
      parsed.finalOutcome ?? null,
      parsed.createdAt,
      parsed.updatedAt,
      parsed.lastObservedAt,
      parsed.reviewReason ?? null,
      parsed.reviewedAt ?? null,
      parsed.reviewedBy ?? null
    ]);
  }
}

/** Deterministic in-memory store used by standalone runtimes and tests. */
export class InMemoryImprovementProposalStore implements ImprovementProposalStore {
  private readonly proposals = new Map<string, ImprovementProposal>();

  get(proposalId: string): ImprovementProposal | undefined {
    const proposal = this.proposals.get(proposalId);
    return proposal ? structuredClone(proposal) : undefined;
  }

  findByFingerprint(fingerprint: string): ImprovementProposal | undefined {
    const proposal = Array.from(this.proposals.values()).find(item => item.fingerprint === fingerprint);
    return proposal ? structuredClone(proposal) : undefined;
  }

  list(query: ProposalListQuery = {}): ImprovementProposal[] {
    return Array.from(this.proposals.values())
      .filter(item => !query.status || item.status === query.status)
      .filter(item => !query.category || item.category === query.category)
      .filter(item => !query.target || item.target === query.target)
      .filter(item => query.minConfidence === undefined || item.confidence >= query.minConfidence)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.proposalId.localeCompare(right.proposalId))
      .slice(0, Math.max(1, Math.min(500, Math.trunc(query.limit ?? 100))))
      .map(item => structuredClone(item));
  }

  upsert(proposal: ImprovementProposal): void {
    this.proposals.set(proposal.proposalId, structuredClone(improvementProposalSchema.parse(proposal)));
  }
}

function decodeProposal(row: ImprovementProposalRow): ImprovementProposal | undefined {
  try {
    const parsed = improvementProposalSchema.safeParse({
      proposalId: row.proposal_id,
      fingerprint: row.fingerprint,
      status: row.status,
      category: row.category,
      target: row.target,
      title: row.title,
      summary: row.summary,
      evidence: JSON.parse(row.evidence_json),
      proposedChange: JSON.parse(row.proposed_change_json),
      expectedBenefit: JSON.parse(row.expected_benefit_json),
      risks: JSON.parse(row.risks_json),
      validationPlan: JSON.parse(row.validation_json),
      ...(row.validation_result_json ? { validationResult: JSON.parse(row.validation_result_json) } : {}),
      confidence: row.confidence,
      priority: row.priority,
      generatedBy: row.generated_by,
      sourceWindow: row.source_window,
      source: row.proposal_source ?? "outcome-analytics",
      ...(row.policy_regime ? { policyRegime: row.policy_regime } : {}),
      ...(row.engineering_policy_hash ? { engineeringPolicyHash: row.engineering_policy_hash } : {}),
      ...(row.source_recommendation_id ? { sourceRecommendationId: row.source_recommendation_id } : {}),
      ...(row.baseline_sha ? { baselineSha: row.baseline_sha } : {}),
      primaryMetrics: row.primary_metrics_json ? JSON.parse(row.primary_metrics_json) : [],
      primaryMetricsLocked: row.primary_metrics_locked === 1,
      ...(row.primary_metrics_locked_at ? { primaryMetricsLockedAt: row.primary_metrics_locked_at } : {}),
      primaryMetricsSource: row.primary_metrics_source ?? "declared",
      ...(row.final_outcome ? { finalOutcome: row.final_outcome } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastObservedAt: row.last_observed_at,
      ...(row.review_reason ? { reviewReason: row.review_reason } : {}),
      ...(row.reviewed_at ? { reviewedAt: row.reviewed_at } : {}),
      ...(row.reviewed_by ? { reviewedBy: row.reviewed_by } : {})
    });
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
