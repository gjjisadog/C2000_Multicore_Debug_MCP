import type { SqliteStore } from "../../storage/SqliteStore.js";
import {
  improvementReviewFeedbackSchema,
  improvementRevisionProposalSchema,
  type ImprovementReviewFeedback,
  type ImprovementRevisionProposal,
  type ReviewFeedbackClass,
  type ReviewFeedbackStatus,
  type RevisionProposalStatus
} from "./RevisionSchemas.js";

export interface ReviewFeedbackQuery {
  pullRequestId?: string;
  pullRequestNumber?: number;
  status?: ReviewFeedbackStatus;
  classification?: ReviewFeedbackClass;
  limit?: number;
}

export interface ImprovementReviewFeedbackStore {
  get(feedbackId: string): ImprovementReviewFeedback | undefined;
  list(query?: ReviewFeedbackQuery): ImprovementReviewFeedback[];
  listByPullRequest(pullRequestId: string): ImprovementReviewFeedback[];
  upsert(value: ImprovementReviewFeedback): void;
}

export interface RevisionProposalQuery {
  originalProposalId?: string;
  pullRequestId?: string;
  status?: RevisionProposalStatus;
  limit?: number;
}

export interface ImprovementRevisionProposalStore {
  get(revisionProposalId: string): ImprovementRevisionProposal | undefined;
  getByFingerprint(fingerprint: string): ImprovementRevisionProposal | undefined;
  list(query?: RevisionProposalQuery): ImprovementRevisionProposal[];
  upsert(value: ImprovementRevisionProposal): void;
}

interface FeedbackRow {
  feedback_id: string;
  pull_request_id: string;
  pull_request_number: number | null;
  review_id: number | null;
  thread_id: string | null;
  comment_id: number | null;
  author: string;
  author_type: string;
  created_at: string;
  updated_at: string | null;
  source: string;
  disposition: string;
  path: string | null;
  line: number | null;
  candidate_sha: string | null;
  raw_text_hash: string;
  sanitized_text: string | null;
  normalized_summary: string;
  fingerprint: string;
  classification: string | null;
  status: string;
  reason: string | null;
  trusted_as_instruction: number;
  record_json: string;
}

interface RevisionRow {
  revision_proposal_id: string;
  fingerprint: string;
  original_proposal_id: string;
  implementation_run_id: string;
  pull_request_id: string;
  pull_request_number: number | null;
  base_candidate_sha: string;
  feedback_ids_json: string;
  feedback_hashes_json: string;
  revision_number: number;
  created_at: string;
  updated_at: string;
  status: string;
  category: string;
  title: string;
  summary: string;
  requested_change_json: string;
  risk: string;
  validation_plan_json: string;
  implementation_mode: string;
  review_reason: string | null;
  reviewed_at: string | null;
  reviewed_by: string | null;
  new_improvement_proposal_recommended: number;
  untrusted_feedback: number;
  record_json: string;
}

export class ImprovementReviewFeedbackRepository implements ImprovementReviewFeedbackStore {
  constructor(private readonly store: SqliteStore) {}

  get(feedbackId: string): ImprovementReviewFeedback | undefined {
    const row = this.store.get<FeedbackRow>("SELECT * FROM review_feedback WHERE feedback_id = ?", [feedbackId]);
    return row ? decodeFeedback(row) : undefined;
  }

  list(query: ReviewFeedbackQuery = {}): ImprovementReviewFeedback[] {
    const clauses: string[] = [];
    const parameters: unknown[] = [];
    if (query.pullRequestId) { clauses.push("pull_request_id = ?"); parameters.push(query.pullRequestId); }
    if (query.pullRequestNumber !== undefined) { clauses.push("pull_request_number = ?"); parameters.push(query.pullRequestNumber); }
    if (query.status) { clauses.push("status = ?"); parameters.push(query.status); }
    if (query.classification) { clauses.push("classification = ?"); parameters.push(query.classification); }
    const limit = clampLimit(query.limit);
    const rows = this.store.all<FeedbackRow>(`
      SELECT * FROM review_feedback
      ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY created_at ASC, feedback_id ASC LIMIT ?
    `, [...parameters, limit]);
    return rows.flatMap(row => { const decoded = decodeFeedback(row); return decoded ? [decoded] : []; });
  }

  listByPullRequest(pullRequestId: string): ImprovementReviewFeedback[] {
    return this.list({ pullRequestId, limit: 500 });
  }

  upsert(value: ImprovementReviewFeedback): void {
    const parsed = improvementReviewFeedbackSchema.parse(value);
    // The provider identity normally keeps the same feedbackId across a
    // refresh. Keep the database's PR+fingerprint uniqueness invariant as a
    // second dedupe boundary for providers that return the same evidence with
    // a different transport id.
    const duplicate = this.store.get<Pick<FeedbackRow, "feedback_id">>(
      "SELECT feedback_id FROM review_feedback WHERE pull_request_id = ? AND fingerprint = ?",
      [parsed.pullRequestId, parsed.fingerprint]
    );
    const stored = duplicate && duplicate.feedback_id !== parsed.feedbackId
      ? { ...parsed, feedbackId: duplicate.feedback_id }
      : parsed;
    this.store.run(`
      INSERT INTO review_feedback(
        feedback_id, pull_request_id, pull_request_number, review_id, thread_id, comment_id,
        author, author_type, created_at, updated_at, source, disposition, path, line,
        candidate_sha, raw_text_hash, sanitized_text, normalized_summary, fingerprint,
        classification, status, reason, trusted_as_instruction, record_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(feedback_id) DO UPDATE SET
        pull_request_id = excluded.pull_request_id,
        pull_request_number = excluded.pull_request_number,
        review_id = excluded.review_id,
        thread_id = excluded.thread_id,
        comment_id = excluded.comment_id,
        author = excluded.author,
        author_type = excluded.author_type,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        source = excluded.source,
        disposition = excluded.disposition,
        path = excluded.path,
        line = excluded.line,
        candidate_sha = excluded.candidate_sha,
        raw_text_hash = excluded.raw_text_hash,
        sanitized_text = excluded.sanitized_text,
        normalized_summary = excluded.normalized_summary,
        fingerprint = excluded.fingerprint,
        classification = excluded.classification,
        status = excluded.status,
        reason = excluded.reason,
        trusted_as_instruction = excluded.trusted_as_instruction,
        record_json = excluded.record_json
    `, [
      stored.feedbackId, stored.pullRequestId, stored.pullRequestNumber ?? null, stored.reviewId ?? null,
      stored.threadId ?? null, stored.commentId ?? null, stored.author, stored.authorType, stored.createdAt,
      stored.updatedAt ?? null, stored.source, stored.disposition, stored.path ?? null, stored.line ?? null,
      stored.candidateSha ?? null, stored.rawTextHash, stored.sanitizedText ?? null, stored.normalizedSummary,
      stored.fingerprint, stored.classification ?? null, stored.status, stored.reason ?? null,
      stored.trustedAsInstruction ? 1 : 0, JSON.stringify(stored)
    ]);
  }
}

export class ImprovementRevisionProposalRepository implements ImprovementRevisionProposalStore {
  constructor(private readonly store: SqliteStore) {}

  get(revisionProposalId: string): ImprovementRevisionProposal | undefined {
    const row = this.store.get<RevisionRow>("SELECT * FROM revision_proposals WHERE revision_proposal_id = ?", [revisionProposalId]);
    return row ? decodeRevision(row) : undefined;
  }

  getByFingerprint(fingerprint: string): ImprovementRevisionProposal | undefined {
    const row = this.store.get<RevisionRow>("SELECT * FROM revision_proposals WHERE fingerprint = ?", [fingerprint]);
    return row ? decodeRevision(row) : undefined;
  }

  list(query: RevisionProposalQuery = {}): ImprovementRevisionProposal[] {
    const clauses: string[] = [];
    const parameters: unknown[] = [];
    if (query.originalProposalId) { clauses.push("original_proposal_id = ?"); parameters.push(query.originalProposalId); }
    if (query.pullRequestId) { clauses.push("pull_request_id = ?"); parameters.push(query.pullRequestId); }
    if (query.status) { clauses.push("status = ?"); parameters.push(query.status); }
    const rows = this.store.all<RevisionRow>(`
      SELECT * FROM revision_proposals
      ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY created_at ASC, revision_proposal_id ASC LIMIT ?
    `, [...parameters, clampLimit(query.limit)]);
    return rows.flatMap(row => { const decoded = decodeRevision(row); return decoded ? [decoded] : []; });
  }

  upsert(value: ImprovementRevisionProposal): void {
    const parsed = improvementRevisionProposalSchema.parse(value);
    this.store.run(`
      INSERT INTO revision_proposals(
        revision_proposal_id, fingerprint, original_proposal_id, implementation_run_id,
        pull_request_id, pull_request_number, base_candidate_sha, feedback_ids_json,
        feedback_hashes_json, revision_number, created_at, updated_at, status, category,
        title, summary, requested_change_json, risk, validation_plan_json, implementation_mode,
        review_reason, reviewed_at, reviewed_by, new_improvement_proposal_recommended,
        untrusted_feedback, record_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(revision_proposal_id) DO UPDATE SET
        fingerprint = excluded.fingerprint,
        original_proposal_id = excluded.original_proposal_id,
        implementation_run_id = excluded.implementation_run_id,
        pull_request_id = excluded.pull_request_id,
        pull_request_number = excluded.pull_request_number,
        base_candidate_sha = excluded.base_candidate_sha,
        feedback_ids_json = excluded.feedback_ids_json,
        feedback_hashes_json = excluded.feedback_hashes_json,
        revision_number = excluded.revision_number,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        status = excluded.status,
        category = excluded.category,
        title = excluded.title,
        summary = excluded.summary,
        requested_change_json = excluded.requested_change_json,
        risk = excluded.risk,
        validation_plan_json = excluded.validation_plan_json,
        implementation_mode = excluded.implementation_mode,
        review_reason = excluded.review_reason,
        reviewed_at = excluded.reviewed_at,
        reviewed_by = excluded.reviewed_by,
        new_improvement_proposal_recommended = excluded.new_improvement_proposal_recommended,
        untrusted_feedback = excluded.untrusted_feedback,
        record_json = excluded.record_json
    `, [
      parsed.revisionProposalId, parsed.fingerprint, parsed.originalProposalId, parsed.implementationRunId,
      parsed.pullRequestId, parsed.pullRequestNumber ?? null, parsed.baseCandidateSha,
      JSON.stringify(parsed.feedbackIds), JSON.stringify(parsed.feedbackHashes), parsed.revisionNumber,
      parsed.createdAt, parsed.updatedAt, parsed.status, parsed.category, parsed.title, parsed.summary,
      JSON.stringify(parsed.requestedChange), parsed.risk, JSON.stringify(parsed.validationPlan),
      parsed.implementationMode, parsed.reviewReason ?? null, parsed.reviewedAt ?? null, parsed.reviewedBy ?? null,
      parsed.newImprovementProposalRecommended ? 1 : 0, parsed.untrustedFeedback ? 1 : 0, JSON.stringify(parsed)
    ]);
  }
}

export class InMemoryImprovementReviewFeedbackStore implements ImprovementReviewFeedbackStore {
  private readonly values = new Map<string, ImprovementReviewFeedback>();
  get(feedbackId: string): ImprovementReviewFeedback | undefined { const value = this.values.get(feedbackId); return value ? structuredClone(value) : undefined; }
  list(query: ReviewFeedbackQuery = {}): ImprovementReviewFeedback[] {
    return Array.from(this.values.values())
      .filter(value => !query.pullRequestId || value.pullRequestId === query.pullRequestId)
      .filter(value => query.pullRequestNumber === undefined || value.pullRequestNumber === query.pullRequestNumber)
      .filter(value => !query.status || value.status === query.status)
      .filter(value => !query.classification || value.classification === query.classification)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.feedbackId.localeCompare(right.feedbackId))
      .slice(0, clampLimit(query.limit)).map(value => structuredClone(value));
  }
  listByPullRequest(pullRequestId: string): ImprovementReviewFeedback[] { return this.list({ pullRequestId, limit: 500 }); }
  upsert(value: ImprovementReviewFeedback): void {
    const parsed = improvementReviewFeedbackSchema.parse(value);
    const duplicate = Array.from(this.values.values()).find(item =>
      item.pullRequestId === parsed.pullRequestId
      && item.fingerprint === parsed.fingerprint
      && item.feedbackId !== parsed.feedbackId
    );
    const stored = duplicate ? { ...parsed, feedbackId: duplicate.feedbackId } : parsed;
    this.values.set(stored.feedbackId, structuredClone(stored));
  }
}

export class InMemoryImprovementRevisionProposalStore implements ImprovementRevisionProposalStore {
  private readonly values = new Map<string, ImprovementRevisionProposal>();
  get(revisionProposalId: string): ImprovementRevisionProposal | undefined { const value = this.values.get(revisionProposalId); return value ? structuredClone(value) : undefined; }
  getByFingerprint(fingerprint: string): ImprovementRevisionProposal | undefined { const value = Array.from(this.values.values()).find(item => item.fingerprint === fingerprint); return value ? structuredClone(value) : undefined; }
  list(query: RevisionProposalQuery = {}): ImprovementRevisionProposal[] {
    return Array.from(this.values.values())
      .filter(value => !query.originalProposalId || value.originalProposalId === query.originalProposalId)
      .filter(value => !query.pullRequestId || value.pullRequestId === query.pullRequestId)
      .filter(value => !query.status || value.status === query.status)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.revisionProposalId.localeCompare(right.revisionProposalId))
      .slice(0, clampLimit(query.limit)).map(value => structuredClone(value));
  }
  upsert(value: ImprovementRevisionProposal): void { this.values.set(value.revisionProposalId, structuredClone(improvementRevisionProposalSchema.parse(value))); }
}

function decodeFeedback(row: FeedbackRow): ImprovementReviewFeedback | undefined {
  try {
    const parsed = improvementReviewFeedbackSchema.safeParse(JSON.parse(row.record_json));
    if (parsed.success) return parsed.data;
    return improvementReviewFeedbackSchema.parse({
      feedbackId: row.feedback_id,
      pullRequestId: row.pull_request_id,
      ...(row.pull_request_number === null ? {} : { pullRequestNumber: row.pull_request_number }),
      ...(row.review_id === null ? {} : { reviewId: row.review_id }),
      ...(row.thread_id ? { threadId: row.thread_id } : {}),
      ...(row.comment_id === null ? {} : { commentId: row.comment_id }),
      author: row.author,
      authorType: row.author_type,
      createdAt: row.created_at,
      ...(row.updated_at ? { updatedAt: row.updated_at } : {}),
      source: row.source,
      disposition: row.disposition,
      ...(row.path ? { path: row.path } : {}),
      ...(row.line === null ? {} : { line: row.line }),
      ...(row.candidate_sha ? { candidateSha: row.candidate_sha } : {}),
      rawTextHash: row.raw_text_hash,
      ...(row.sanitized_text ? { sanitizedText: row.sanitized_text } : {}),
      normalizedSummary: row.normalized_summary,
      fingerprint: row.fingerprint,
      ...(row.classification ? { classification: row.classification } : {}),
      status: row.status,
      ...(row.reason ? { reason: row.reason } : {}),
      trustedAsInstruction: row.trusted_as_instruction === 1
    });
  } catch { return undefined; }
}

function decodeRevision(row: RevisionRow): ImprovementRevisionProposal | undefined {
  try {
    const parsed = improvementRevisionProposalSchema.safeParse(JSON.parse(row.record_json));
    if (parsed.success) return parsed.data;
    return improvementRevisionProposalSchema.parse({
      revisionProposalId: row.revision_proposal_id,
      fingerprint: row.fingerprint,
      originalProposalId: row.original_proposal_id,
      implementationRunId: row.implementation_run_id,
      pullRequestId: row.pull_request_id,
      ...(row.pull_request_number === null ? {} : { pullRequestNumber: row.pull_request_number }),
      baseCandidateSha: row.base_candidate_sha,
      feedbackIds: JSON.parse(row.feedback_ids_json),
      feedbackHashes: JSON.parse(row.feedback_hashes_json),
      revisionNumber: row.revision_number,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      status: row.status,
      category: row.category,
      title: row.title,
      summary: row.summary,
      requestedChange: JSON.parse(row.requested_change_json),
      risk: row.risk,
      validationPlan: JSON.parse(row.validation_plan_json),
      implementationMode: row.implementation_mode,
      ...(row.review_reason ? { reviewReason: row.review_reason } : {}),
      ...(row.reviewed_at ? { reviewedAt: row.reviewed_at } : {}),
      ...(row.reviewed_by ? { reviewedBy: row.reviewed_by } : {}),
      newImprovementProposalRecommended: row.new_improvement_proposal_recommended === 1,
      untrustedFeedback: row.untrusted_feedback === 1
    });
  } catch { return undefined; }
}

function clampLimit(value: number | undefined): number { return Math.max(1, Math.min(500, Math.trunc(value ?? 100))); }
