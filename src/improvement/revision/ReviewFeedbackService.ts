import { createHash } from "node:crypto";
import type { Logger } from "../../utils/logger.js";
import { DebugMcpError } from "../../utils/errors.js";
import type { ImprovementPullRequestStore } from "../review/ReviewRepositories.js";
import type { ImprovementCodeReviewProvider, ProviderPullRequest, ProviderReviewFeedback } from "../review/GitHubReviewProvider.js";
import { ImprovementArtifactWriter } from "../implementation/ImplementationArtifacts.js";
import { classifyReviewFeedback, feedbackFingerprint, reviewFeedbackIdentity } from "./ReviewFeedbackClassifier.js";
import {
  improvementReviewFeedbackSchema,
  type ImprovementReviewFeedback,
  type ReviewFeedbackClass,
  type ReviewFeedbackStatus
} from "./RevisionSchemas.js";
import type { ImprovementReviewFeedbackStore, ReviewFeedbackQuery } from "./RevisionRepositories.js";

export interface ReviewFeedbackSelector {
  pullRequestId?: string;
  pullRequestNumber?: number;
  implementationRunId?: string;
}

export interface ReviewFeedbackServiceOptions {
  feedback: ImprovementReviewFeedbackStore;
  pullRequests: ImprovementPullRequestStore;
  provider: ImprovementCodeReviewProvider;
  now?: () => number;
  logger?: Pick<Logger, "info" | "warn">;
  artifactRoot?: string;
  onEvidenceChanged?: (feedbackIds: readonly string[], reason: string) => void;
  recordAnalytics?: (event: {
    action: "refresh" | "linked" | "evidence-changed";
    pullRequestId: string;
    feedbackCount: number;
    actionableCount: number;
    malformedCount?: number;
    classificationCounts?: Record<string, number>;
    statusCounts?: Record<string, number>;
  }) => void;
}

/** Synchronizes remote review evidence without granting it instruction authority. */
export class ReviewFeedbackService {
  private readonly now: () => number;
  private readonly artifactWriter?: ImprovementArtifactWriter;

  constructor(private readonly options: ReviewFeedbackServiceOptions) {
    this.now = options.now ?? (() => Date.now());
    this.artifactWriter = options.artifactRoot ? new ImprovementArtifactWriter(options.artifactRoot) : undefined;
  }

  async refresh(selector: ReviewFeedbackSelector): Promise<Record<string, unknown>> {
    const stored = this.resolvePullRequest(selector);
    if (!stored.number) {
      throw new DebugMcpError("PullRequestInvalidState", "The improvement pull request has no external number", { pullRequestId: stored.pullRequestId });
    }
    const remote = await this.options.provider.getPullRequest(stored.number);
    this.assertRefreshable(remote, stored.pullRequestId);
    if (!this.options.provider.listReviewFeedback) {
      throw new DebugMcpError("ReviewFeedbackUnavailable", "The configured review provider does not expose review feedback synchronization", {
        pullRequestId: stored.pullRequestId,
        pullRequestNumber: stored.number
      });
    }
    const remoteItems = await this.options.provider.listReviewFeedback(stored.number);
    const previous = new Map(this.options.feedback.listByPullRequest(stored.pullRequestId).map(item => [item.feedbackId, item]));
    const seen = new Set<string>();
    const normalized: ImprovementReviewFeedback[] = [];
    const evidenceChanged = new Set<string>();
    let malformedCount = 0;
    for (const item of remoteItems.slice(0, 500)) {
      let next: ImprovementReviewFeedback;
      try {
        next = this.normalize(item, stored.pullRequestId, stored.number, stored.candidateSha, previous);
      } catch (error) {
        malformedCount += 1;
        this.options.logger?.warn("c2000 review feedback record rejected", {
          pullRequestId: stored.pullRequestId,
          feedbackSource: item.source,
          feedbackId: item.commentId ?? item.reviewId ?? item.threadId ?? "unknown",
          errorCode: error instanceof DebugMcpError ? error.code : "ReviewFeedbackMalformed"
        });
        continue;
      }
      const existingFingerprint = Array.from(previous.values()).find(existing =>
        existing.pullRequestId === next.pullRequestId && existing.fingerprint === next.fingerprint
      );
      // A provider id is transport metadata, not the dedupe identity. Reuse
      // the persisted id when an equivalent PR feedback record arrives under
      // a different review/comment id.
      if (existingFingerprint && existingFingerprint.feedbackId !== next.feedbackId) {
        next = {
          ...next,
          feedbackId: existingFingerprint.feedbackId,
          ...(["revision-proposed", "revision-approved", "addressed-by-candidate", "reviewer-confirmed"].includes(existingFingerprint.status)
            ? { status: existingFingerprint.status }
            : {})
        };
      }
      seen.add(next.feedbackId);
      this.options.feedback.upsert(next);
      normalized.push(next);
      const old = previous.get(next.feedbackId);
      if (old && (
        old.rawTextHash.toLowerCase() !== next.rawTextHash.toLowerCase()
        || (next.status === "resolved" && old.status !== "resolved")
        || (next.status === "superseded" && ["revision-proposed", "revision-approved", "addressed-by-candidate", "reviewer-confirmed"].includes(old.status))
      )) {
        evidenceChanged.add(next.feedbackId);
      }
    }
    // GitHub endpoints are fetched as complete bounded pages. Missing active
    // records are retained as superseded audit history, never deleted.
    for (const old of previous.values()) {
      if (seen.has(old.feedbackId) || ["resolved", "superseded", "rejected"].includes(old.status)) continue;
      this.options.feedback.upsert({ ...old, status: "superseded", updatedAt: new Date(this.now()).toISOString(), reason: "Feedback was no longer returned by the provider refresh." });
      evidenceChanged.add(old.feedbackId);
    }
    if (evidenceChanged.size > 0) {
      this.options.onEvidenceChanged?.([...evidenceChanged], "Review feedback was edited, resolved, or removed after it was linked to a revision.");
      this.options.recordAnalytics?.({ action: "evidence-changed", pullRequestId: stored.pullRequestId, feedbackCount: normalized.length, actionableCount: 0, malformedCount });
    }
    const allFeedback = this.options.feedback.listByPullRequest(stored.pullRequestId);
    const actionableCount = normalized.filter(item => item.status === "actionable" || item.status === "classified").length;
    const classificationCounts = countLabels(normalized.map(item => item.classification));
    const statusCounts = countLabels(allFeedback.map(item => item.status));
    this.options.recordAnalytics?.({ action: "refresh", pullRequestId: stored.pullRequestId, feedbackCount: normalized.length, actionableCount, malformedCount, classificationCounts, statusCounts });
    this.options.logger?.info("c2000 review feedback refreshed", { pullRequestId: stored.pullRequestId, pullRequestNumber: stored.number, feedbackCount: normalized.length, actionableCount, malformedCount, evidenceChangedCount: evidenceChanged.size, untrusted: true });
    const artifact = await this.writeFeedbackArtifact(stored.pullRequestId, stored.number, allFeedback, { classificationCounts, statusCounts, malformedCount });
    return {
      pullRequestId: stored.pullRequestId,
      pullRequestNumber: stored.number,
      feedback: normalized,
      counts: {
        total: normalized.length,
        actionable: actionableCount,
        questions: normalized.filter(item => item.classification === "question").length,
        nonActionable: normalized.filter(item => item.classification === "non-actionable").length,
        potentiallyMalicious: normalized.filter(item => item.classification === "potentially-malicious").length,
        malformed: malformedCount,
        evidenceChanged: evidenceChanged.size
      },
      ...(artifact ? { artifact } : {}),
      untrusted: true,
      trustedAsInstruction: false,
      refreshedAt: new Date(this.now()).toISOString()
    };
  }

  list(query: ReviewFeedbackQuery = {}): Record<string, unknown> {
    const feedback = this.options.feedback.list(query);
    return {
      feedback,
      count: feedback.length,
      untrusted: true,
      trustedAsInstruction: false
    };
  }

  get(feedbackId: string): ImprovementReviewFeedback {
    const value = this.options.feedback.get(feedbackId);
    if (!value) throw new DebugMcpError("ReviewFeedbackNotFound", `Review feedback was not found: ${feedbackId}`, { feedbackId });
    return value;
  }

  assertStable(feedbackIds: readonly string[], expectedHashes: readonly string[]): void {
    if (feedbackIds.length !== expectedHashes.length || feedbackIds.length === 0) {
      throw new DebugMcpError("RevisionEvidenceChanged", "Revision evidence identifiers and hashes are incomplete", { feedbackIds, expectedHashes });
    }
    const changed: Array<Record<string, unknown>> = [];
    feedbackIds.forEach((feedbackId, index) => {
      const value = this.options.feedback.get(feedbackId);
      if (!value) {
        changed.push({ feedbackId, reason: "missing" });
        return;
      }
      if (value.rawTextHash.toLowerCase() !== expectedHashes[index]!.toLowerCase()) changed.push({ feedbackId, reason: "rawTextHashChanged", expectedHash: expectedHashes[index], actualHash: value.rawTextHash });
      if (["superseded", "resolved", "rejected"].includes(value.status)) changed.push({ feedbackId, reason: `status:${value.status}` });
      if (value.trustedAsInstruction !== false) changed.push({ feedbackId, reason: "trustedAsInstruction must remain false" });
    });
    if (changed.length > 0) {
      throw new DebugMcpError("RevisionEvidenceChanged", "Review feedback changed after the revision evidence was approved; reconfirmation is required", {
        feedbackIds,
        changes: changed.slice(0, 64),
        actionRequired: "Refresh review feedback and review a new revision proposal; do not silently continue or cancel the revision."
      });
    }
  }

  markLinked(feedbackIds: readonly string[], status: ReviewFeedbackStatus): ImprovementReviewFeedback[] {
    const linked: ImprovementReviewFeedback[] = [];
    for (const feedbackId of feedbackIds) {
      const current = this.options.feedback.get(feedbackId);
      if (!current) continue;
      const next = improvementReviewFeedbackSchema.parse({ ...current, status, updatedAt: new Date(this.now()).toISOString() });
      this.options.feedback.upsert(next);
      linked.push(next);
    }
    if (linked.length > 0) this.options.recordAnalytics?.({ action: "linked", pullRequestId: linked[0]!.pullRequestId, feedbackCount: linked.length, actionableCount: linked.filter(item => item.status === "actionable").length, statusCounts: countLabels(linked.map(item => item.status)) });
    return linked;
  }

  resolvePullRequest(selector: ReviewFeedbackSelector) {
    const record = selector.pullRequestId
      ? this.options.pullRequests.get(selector.pullRequestId)
      : selector.pullRequestNumber !== undefined
        ? this.options.pullRequests.list(500).find(item => item.number === selector.pullRequestNumber)
        : selector.implementationRunId
          ? this.options.pullRequests.findByImplementationRun(selector.implementationRunId)
          : undefined;
    if (!record) throw new DebugMcpError("PullRequestNotFound", "Improvement pull request record was not found", { selector });
    return record;
  }

  private normalize(value: ProviderReviewFeedback, pullRequestId: string, pullRequestNumber: number, currentCandidateSha: string, previous: Map<string, ImprovementReviewFeedback>): ImprovementReviewFeedback {
    const classified = classifyReviewFeedback(value);
    const identity = { ...value, pullRequestId };
    const feedbackId = `feedback-${createHash("sha256").update(reviewFeedbackIdentity(identity), "utf8").digest("hex").slice(0, 48)}`;
    const classification: ReviewFeedbackClass = classified.classification;
    const fingerprint = feedbackFingerprint({
      pullRequestId,
      source: value.source,
      ...(value.threadId ? { threadId: value.threadId } : {}),
      ...(value.commentId !== undefined ? { commentId: value.commentId } : {}),
      ...(value.reviewId !== undefined ? { reviewId: value.reviewId } : {}),
      ...(value.path ? { path: value.path } : {}),
      ...(value.line !== undefined ? { line: value.line } : {}),
      rawTextHash: classified.rawTextHash,
      classification
    });
    const old = previous.get(feedbackId);
    const candidateMismatch = Boolean(value.candidateSha && value.candidateSha.toLowerCase() !== currentCandidateSha.toLowerCase());
    const status: ReviewFeedbackStatus = candidateMismatch
      ? "superseded"
      : value.resolved
      ? "resolved"
      : old && old.rawTextHash === classified.rawTextHash && ["revision-proposed", "revision-approved", "addressed-by-candidate", "reviewer-confirmed"].includes(old.status)
        ? old.status
        : classified.actionable ? "actionable" : "non-actionable";
    return improvementReviewFeedbackSchema.parse({
      feedbackId,
      pullRequestId,
      pullRequestNumber,
      ...(value.reviewId ? { reviewId: value.reviewId } : {}),
      ...(value.threadId ? { threadId: value.threadId } : {}),
      ...(value.commentId ? { commentId: value.commentId } : {}),
      author: classified.feedback.author,
      authorType: classified.feedback.authorType,
      createdAt: value.createdAt,
      ...(value.updatedAt ? { updatedAt: value.updatedAt } : {}),
      source: value.source,
      disposition: value.disposition,
      ...(classified.feedback.path ? { path: classified.feedback.path } : {}),
      ...(value.line ? { line: value.line } : {}),
      ...(value.candidateSha ? { candidateSha: value.candidateSha } : {}),
      rawTextHash: classified.rawTextHash,
      ...(classified.feedback.sanitizedText ? { sanitizedText: classified.feedback.sanitizedText } : {}),
      normalizedSummary: classified.feedback.normalizedSummary,
      fingerprint,
      classification,
      status,
      ...(candidateMismatch
        ? { reason: `Feedback is bound to candidate ${value.candidateSha}; current candidate is ${currentCandidateSha}.` }
        : classified.feedback.reason ? { reason: classified.feedback.reason } : {}),
      trustedAsInstruction: false
    });
  }

  private assertRefreshable(remote: ProviderPullRequest, pullRequestId: string): void {
    if (remote.merged) throw new DebugMcpError("RevisionNotAllowedAfterMerge", "Review feedback cannot create a revision after the pull request is merged", { pullRequestId, pullRequestNumber: remote.number });
    if (remote.state !== "open") throw new DebugMcpError("PullRequestClosed", "Review feedback refresh requires an open pull request", { pullRequestId, pullRequestNumber: remote.number, state: remote.state });
  }

  private async writeFeedbackArtifact(
    pullRequestId: string,
    pullRequestNumber: number,
    feedback: readonly ImprovementReviewFeedback[],
    counts: { classificationCounts: Record<string, number>; statusCounts: Record<string, number>; malformedCount: number }
  ) {
    if (!this.artifactWriter) return undefined;
    const runId = `review-${pullRequestId.replace(/[^A-Za-z0-9._:-]/g, "-").slice(0, 128)}`;
    try {
      return await this.artifactWriter.writeJson(runId, "revision-feedback", "revision-feedback.json", {
        pullRequestId,
        pullRequestNumber,
        generatedAt: new Date(this.now()).toISOString(),
        untrusted: true,
        trustedAsInstruction: false,
        counts,
        feedback: feedback.slice(0, 500)
      });
    } catch (error) {
      this.options.logger?.warn("c2000 review feedback artifact write failed", { pullRequestId, error: String(error) });
      return undefined;
    }
  }
}

function countLabels(values: readonly (string | undefined)[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    if (!value) continue;
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}
