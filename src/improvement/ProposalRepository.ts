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
  baseline_sha: string | null;
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
        WHEN 'draft' THEN 2
        WHEN 'deferred' THEN 3
        ELSE 4
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
        baseline_sha, created_at, updated_at, last_observed_at, review_reason,
        reviewed_at, reviewed_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        baseline_sha = excluded.baseline_sha,
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
      parsed.baselineSha ?? null,
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
      ...(row.baseline_sha ? { baselineSha: row.baseline_sha } : {}),
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
