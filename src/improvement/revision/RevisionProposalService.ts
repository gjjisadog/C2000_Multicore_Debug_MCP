import { randomUUID } from "node:crypto";
import type { Logger } from "../../utils/logger.js";
import { DebugMcpError } from "../../utils/errors.js";
import type { ImprovementProposalStore } from "../ProposalRepository.js";
import { improvementProposalSchema, type ImprovementProposal } from "../ProposalSchemas.js";
import type { ImprovementImplementationRunStore } from "../implementation/ImplementationRunRepository.js";
import type { ImprovementImplementationRun } from "../implementation/ImplementationSchemas.js";
import type { ImprovementPullRequestStore } from "../review/ReviewRepositories.js";
import type { ImprovementCodeReviewProvider } from "../review/GitHubReviewProvider.js";
import type { ImprovementPullRequest } from "../review/ReviewSchemas.js";
import type { ImprovementReviewFeedbackStore, ImprovementRevisionProposalStore } from "./RevisionRepositories.js";
import {
  improvementRevisionProposalSchema,
  revisionProposalReviewDecisionSchema,
  type ImprovementReviewFeedback,
  type ImprovementRevisionProposal,
  type RevisionProposalReviewDecision
} from "./RevisionSchemas.js";
import { assessRevisionFeedbackGroup, revisionValidationPlan } from "./RevisionPolicy.js";
import type { ReviewFeedbackService } from "./ReviewFeedbackService.js";
import { sha256Json } from "../review/ReviewSchemas.js";

export const MAX_AUTOMATED_REVISION_ROUNDS = 3;

export interface RevisionImplementationContext {
  revision: ImprovementRevisionProposal;
  originalProposal: ImprovementProposal;
  executionProposal: ImprovementProposal;
  baseCandidateSha: string;
  parentCandidateSha: string;
  pullRequest: ImprovementPullRequest;
  branchName: string;
}

export interface RevisionImplementationGate {
  prepareForImplementation(revisionProposalId: string): Promise<RevisionImplementationContext>;
  assertEvidenceStable(revisionProposalId: string): void;
  markImplementing(revisionProposalId: string, runId: string): void;
  markValidationPending(revisionProposalId: string, runId: string): void;
  markCandidateRejected(revisionProposalId: string, reason: string): void;
  markCandidateReady(revisionProposalId: string, runId: string, candidateSha: string): void;
  markFailed(revisionProposalId: string, reason: string): void;
  getFeedback(revisionProposalId: string): ImprovementReviewFeedback[];
  getExecutionProposal(revisionProposalId: string): ImprovementProposal;
}

export interface RevisionProposalServiceOptions {
  feedback: ReviewFeedbackService;
  feedbackStore: ImprovementReviewFeedbackStore;
  revisions: ImprovementRevisionProposalStore;
  pullRequests: ImprovementPullRequestStore;
  proposals: ImprovementProposalStore;
  runs: ImprovementImplementationRunStore;
  provider: ImprovementCodeReviewProvider;
  repository?: string;
  maxAutomatedRevisionRounds?: number;
  now?: () => number;
  logger?: Pick<Logger, "info" | "warn">;
  recordAnalytics?: (event: {
    action: "generated" | "approved" | "rejected" | "deferred" | "candidate-ready" | "evidence-changed";
    revisionProposalId: string;
    pullRequestId?: string;
    category: string;
    status?: string;
    outcome: string;
    revisionNumber?: number;
    feedbackCount?: number;
    implementationMode?: "auto-eligible" | "manual-only";
    newImprovementProposalRecommended?: boolean;
  }) => void;
}

/** Human-gated policy and state machine for a review-driven candidate revision. */
export class RevisionProposalService implements RevisionImplementationGate {
  private readonly now: () => number;
  private readonly maxAutomatedRevisionRounds: number;

  constructor(private readonly options: RevisionProposalServiceOptions) {
    this.now = options.now ?? (() => Date.now());
    this.maxAutomatedRevisionRounds = Math.max(1, Math.min(MAX_AUTOMATED_REVISION_ROUNDS, Math.trunc(options.maxAutomatedRevisionRounds ?? MAX_AUTOMATED_REVISION_ROUNDS)));
  }

  async generate(selector: { pullRequestId?: string; pullRequestNumber?: number; implementationRunId?: string }): Promise<Record<string, unknown>> {
    const pullRequest = this.resolvePullRequest(selector);
    const remote = await this.remoteFor(pullRequest);
    this.assertOpen(remote, pullRequest.pullRequestId);
    this.assertRemoteBinding(remote, pullRequest);
    if (remote.headSha.toLowerCase() !== pullRequest.candidateSha.toLowerCase()) {
      throw new DebugMcpError("RevisionRemoteDrift", "The pull request head changed before revision proposals were generated", {
        pullRequestId: pullRequest.pullRequestId,
        expectedCandidateSha: pullRequest.candidateSha,
        remoteHeadSha: remote.headSha
      });
    }
    const original = this.requireOriginal(pullRequest.proposalId);
    const run = this.requireRun(pullRequest.currentImplementationRunId ?? pullRequest.implementationRunId);
    const feedback = this.options.feedbackStore.listByPullRequest(pullRequest.pullRequestId)
      .filter(item => ["actionable", "classified", "revision-proposed"].includes(item.status) && item.trustedAsInstruction === false && item.classification !== "non-actionable");
    const groups = groupFeedback(feedback);
    const generated: ImprovementRevisionProposal[] = [];
    const recommendations: Array<Record<string, unknown>> = [];
    for (const group of groups) {
      const decision = assessRevisionFeedbackGroup(group, original);
      const hashes = group.map(item => item.rawTextHash);
      const fingerprint = sha256Json({
        originalProposalId: original.proposalId,
        pullRequestId: pullRequest.pullRequestId,
        baseCandidateSha: pullRequest.candidateSha,
        feedbackIds: group.map(item => item.feedbackId).sort(),
        feedbackHashes: [...hashes].sort()
      });
      const existing = this.options.revisions.getByFingerprint(fingerprint);
      if (existing) {
        generated.push(existing);
        continue;
      }
      this.markEvidenceChangedForEditedFeedback(pullRequest.pullRequestId, group);
      const revisionNumber = this.nextRevisionNumber(original.proposalId);
      if (revisionNumber > this.maxAutomatedRevisionRounds) {
        throw new DebugMcpError("AutomatedRevisionLimitReached", `Automated revision limit reached at ${this.maxAutomatedRevisionRounds} rounds`, {
          originalProposalId: original.proposalId,
          pullRequestId: pullRequest.pullRequestId,
          revisionNumber,
          maxAutomatedRevisionRounds: this.maxAutomatedRevisionRounds
        });
      }
      const revision = improvementRevisionProposalSchema.parse({
        revisionProposalId: `revision-${randomUUID()}`,
        fingerprint,
        originalProposalId: original.proposalId,
        implementationRunId: run.runId,
        pullRequestId: pullRequest.pullRequestId,
        ...(pullRequest.number ? { pullRequestNumber: pullRequest.number } : {}),
        baseCandidateSha: pullRequest.candidateSha,
        feedbackIds: group.map(item => item.feedbackId),
        feedbackHashes: hashes,
        revisionNumber,
        createdAt: new Date(this.now()).toISOString(),
        updatedAt: new Date(this.now()).toISOString(),
        status: "ready-for-review",
        category: decision.category,
        title: decision.title,
        summary: decision.summary || "Address bounded review feedback.",
        requestedChange: decision.requestedChange,
        risk: decision.risk,
        validationPlan: revisionValidationPlan(original, decision.category),
        implementationMode: decision.implementationMode,
        newImprovementProposalRecommended: decision.newImprovementProposalRecommended,
        untrustedFeedback: true
      });
      this.options.revisions.upsert(revision);
      this.options.feedback.markLinked(revision.feedbackIds, "revision-proposed");
      generated.push(revision);
      this.options.recordAnalytics?.({
        action: "generated",
        revisionProposalId: revision.revisionProposalId,
        pullRequestId: revision.pullRequestId,
        category: revision.category,
        status: revision.status,
        outcome: revision.implementationMode,
        revisionNumber: revision.revisionNumber,
        feedbackCount: revision.feedbackIds.length,
        implementationMode: revision.implementationMode,
        newImprovementProposalRecommended: revision.newImprovementProposalRecommended
      });
      if (revision.newImprovementProposalRecommended) recommendations.push({ type: "New Improvement Proposal Recommended", revisionProposalId: revision.revisionProposalId, reason: decision.reason });
    }
    this.options.logger?.info("c2000 revision proposals generated", { pullRequestId: pullRequest.pullRequestId, revisionCount: generated.length, untrustedFeedback: true });
    return {
      pullRequestId: pullRequest.pullRequestId,
      pullRequestNumber: pullRequest.number,
      baseCandidateSha: pullRequest.candidateSha,
      revisionProposals: generated,
      recommendations,
      originalProposalImmutable: true,
      untrustedFeedback: true
    };
  }

  list(query: { originalProposalId?: string; pullRequestId?: string; status?: ImprovementRevisionProposal["status"]; limit?: number } = {}): Record<string, unknown> {
    const values = this.options.revisions.list(query);
    return { revisionProposals: values, count: values.length, originalProposalImmutable: true, untrustedFeedback: true };
  }

  get(revisionProposalId: string): ImprovementRevisionProposal {
    const revision = this.options.revisions.get(revisionProposalId);
    if (!revision) throw new DebugMcpError("RevisionProposalNotFound", `Revision Proposal not found: ${revisionProposalId}`, { revisionProposalId });
    return revision;
  }

  review(input: { revisionProposalId: string; decision: RevisionProposalReviewDecision; reviewReason: string; reviewer?: string }): Record<string, unknown> {
    const parsedDecision = revisionProposalReviewDecisionSchema.parse(input.decision);
    const reason = input.reviewReason.trim();
    if (!reason) throw new DebugMcpError("ProposalReviewReasonRequired", "Revision Proposal review requires a non-empty reason", { revisionProposalId: input.revisionProposalId });
    const current = this.get(input.revisionProposalId);
    if (!["ready-for-review", "deferred"].includes(current.status)) throw new DebugMcpError("RevisionProposalInvalidState", `Revision Proposal ${current.revisionProposalId} cannot be reviewed from ${current.status}`, { revisionProposalId: current.revisionProposalId, status: current.status });
    try {
      this.options.feedback.assertStable(current.feedbackIds, current.feedbackHashes);
    } catch (error) {
      this.options.revisions.upsert({ ...current, status: "evidence-changed", updatedAt: new Date(this.now()).toISOString() });
      throw error;
    }
    const status = parsedDecision === "approve" ? "approved" : parsedDecision === "reject" ? "rejected" : "deferred";
    const next = improvementRevisionProposalSchema.parse({
      ...current,
      status,
      updatedAt: new Date(this.now()).toISOString(),
      reviewReason: reason.slice(0, 2048),
      reviewedAt: new Date(this.now()).toISOString(),
      ...(input.reviewer ? { reviewedBy: input.reviewer } : {})
    });
    this.options.revisions.upsert(next);
    this.options.feedback.markLinked(next.feedbackIds, parsedDecision === "approve" ? "revision-approved" : parsedDecision === "reject" ? "rejected" : "classified");
    this.options.recordAnalytics?.({
      action: parsedDecision === "approve" ? "approved" : parsedDecision === "reject" ? "rejected" : "deferred",
      revisionProposalId: next.revisionProposalId,
      pullRequestId: next.pullRequestId,
      category: next.category,
      status: next.status,
      outcome: next.status,
      revisionNumber: next.revisionNumber,
      feedbackCount: next.feedbackIds.length,
      implementationMode: next.implementationMode,
      newImprovementProposalRecommended: next.newImprovementProposalRecommended
    });
    return { revisionProposal: next, originalProposalUnchanged: true, humanGate: true, untrustedFeedback: true };
  }

  async prepareForImplementation(revisionProposalId: string): Promise<RevisionImplementationContext> {
    const revision = this.get(revisionProposalId);
    if (revision.status !== "approved") throw new DebugMcpError("RevisionApprovalRequired", `Revision Proposal ${revisionProposalId} must be approved before implementation`, { revisionProposalId, status: revision.status });
    if (revision.implementationMode !== "auto-eligible" || revision.newImprovementProposalRecommended) throw new DebugMcpError("ImplementationNotAllowed", "This review feedback requires manual handling or a separate Improvement Proposal", { revisionProposalId, implementationMode: revision.implementationMode, newImprovementProposalRecommended: revision.newImprovementProposalRecommended });
    if (revision.revisionNumber > this.maxAutomatedRevisionRounds) throw new DebugMcpError("AutomatedRevisionLimitReached", `Automated revision limit reached at ${this.maxAutomatedRevisionRounds} rounds`, { revisionProposalId, revisionNumber: revision.revisionNumber, maxAutomatedRevisionRounds: this.maxAutomatedRevisionRounds });
    const pullRequest = this.options.pullRequests.get(revision.pullRequestId);
    if (!pullRequest) throw new DebugMcpError("PullRequestNotFound", "The revision pull request record was not found", { revisionProposalId, pullRequestId: revision.pullRequestId });
    const remote = await this.remoteFor(pullRequest);
    this.assertOpen(remote, pullRequest.pullRequestId);
    this.assertRemoteBinding(remote, pullRequest);
    if (remote.headSha.toLowerCase() !== revision.baseCandidateSha.toLowerCase()) throw new DebugMcpError("RevisionRemoteDrift", "The remote PR head no longer matches the revision base candidate", { revisionProposalId, baseCandidateSha: revision.baseCandidateSha, remoteHeadSha: remote.headSha });
    this.assertEvidenceStable(revision.revisionProposalId);
    const originalProposal = this.requireOriginal(revision.originalProposalId);
    const executionProposal = this.buildExecutionProposal(originalProposal, revision);
    return { revision, originalProposal, executionProposal, baseCandidateSha: revision.baseCandidateSha, parentCandidateSha: revision.baseCandidateSha, pullRequest, branchName: pullRequest.branch };
  }

  async prepareForPublication(revisionProposalId: string): Promise<RevisionImplementationContext> {
    const revision = this.get(revisionProposalId);
    if (revision.status !== "candidate-ready") throw new DebugMcpError("CandidateNotReady", `Revision Proposal ${revisionProposalId} is not candidate-ready`, { revisionProposalId, status: revision.status });
    const pullRequest = this.options.pullRequests.get(revision.pullRequestId);
    if (!pullRequest) throw new DebugMcpError("PullRequestNotFound", "The revision pull request record was not found", { revisionProposalId, pullRequestId: revision.pullRequestId });
    const remote = await this.remoteFor(pullRequest);
    this.assertOpen(remote, pullRequest.pullRequestId);
    this.assertRemoteBinding(remote, pullRequest);
    if (remote.headSha.toLowerCase() !== revision.baseCandidateSha.toLowerCase()) throw new DebugMcpError("RevisionRemoteDrift", "The remote PR head changed after revision validation", { revisionProposalId, baseCandidateSha: revision.baseCandidateSha, remoteHeadSha: remote.headSha });
    this.assertEvidenceStable(revision.revisionProposalId);
    const originalProposal = this.requireOriginal(revision.originalProposalId);
    const executionProposal = this.buildExecutionProposal(originalProposal, revision);
    return { revision, originalProposal, executionProposal, baseCandidateSha: revision.baseCandidateSha, parentCandidateSha: revision.baseCandidateSha, pullRequest, branchName: pullRequest.branch };
  }

  markImplementing(revisionProposalId: string, _runId: string): void { this.updateStatus(revisionProposalId, "implementing"); }
  markValidationPending(revisionProposalId: string, _runId: string): void { this.updateStatus(revisionProposalId, "validation-pending"); }
  markCandidateRejected(revisionProposalId: string, reason: string): void { this.updateStatus(revisionProposalId, "rejected", reason); }
  markFailed(revisionProposalId: string, reason: string): void {
    // An evidence change is a reconfirmation gate, not an implementation
    // rejection. Preserve that state when a stale queued run notices it.
    if (this.get(revisionProposalId).status === "evidence-changed") return;
    this.updateStatus(revisionProposalId, "rejected", reason);
  }
  markCandidateReady(revisionProposalId: string, _runId: string, candidateSha: string): void {
    const current = this.get(revisionProposalId);
    const next = improvementRevisionProposalSchema.parse({ ...current, status: "candidate-ready", updatedAt: new Date(this.now()).toISOString(), reviewReason: `Candidate ${candidateSha} addresses the approved review revision.` });
    this.options.revisions.upsert(next);
    this.options.feedback.markLinked(next.feedbackIds, "addressed-by-candidate");
    this.options.recordAnalytics?.({
      action: "candidate-ready",
      revisionProposalId,
      pullRequestId: next.pullRequestId,
      category: next.category,
      status: next.status,
      outcome: "candidate-ready",
      revisionNumber: next.revisionNumber,
      feedbackCount: next.feedbackIds.length,
      implementationMode: next.implementationMode,
      newImprovementProposalRecommended: next.newImprovementProposalRecommended
    });
  }

  getFeedback(revisionProposalId: string): ImprovementReviewFeedback[] {
    const revision = this.get(revisionProposalId);
    return revision.feedbackIds.map(feedbackId => this.options.feedback.get(feedbackId)).filter((value): value is ImprovementReviewFeedback => Boolean(value));
  }

  getExecutionProposal(revisionProposalId: string): ImprovementProposal {
    const revision = this.get(revisionProposalId);
    return this.buildExecutionProposal(this.requireOriginal(revision.originalProposalId), revision);
  }

  assertEvidenceStable(revisionProposalId: string): void {
    const revision = this.get(revisionProposalId);
    try {
      this.options.feedback.assertStable(revision.feedbackIds, revision.feedbackHashes);
    } catch (error) {
      if (error instanceof DebugMcpError && error.code === "RevisionEvidenceChanged") {
        this.updateStatus(revisionProposalId, "evidence-changed", error.message);
      }
      throw error;
    }
  }

  /** Invalidate every revision that depends on changed, resolved, or deleted review evidence. */
  markEvidenceChangedByFeedback(feedbackIds: readonly string[], reason: string): ImprovementRevisionProposal[] {
    const ids = new Set(feedbackIds);
    if (ids.size === 0) return [];
    const changed: ImprovementRevisionProposal[] = [];
    for (const current of this.options.revisions.list({ limit: 500 })) {
      if (!["ready-for-review", "approved", "implementing", "validation-pending", "validated", "candidate-ready"].includes(current.status)) continue;
      if (!current.feedbackIds.some(feedbackId => ids.has(feedbackId))) continue;
      const next = improvementRevisionProposalSchema.parse({
        ...current,
        status: "evidence-changed",
        updatedAt: new Date(this.now()).toISOString(),
        reviewReason: reason.slice(0, 2048)
      });
      this.options.revisions.upsert(next);
      changed.push(next);
      this.options.recordAnalytics?.({
        action: "evidence-changed",
        revisionProposalId: next.revisionProposalId,
        pullRequestId: next.pullRequestId,
        category: next.category,
        status: next.status,
        outcome: "evidence-changed",
        revisionNumber: next.revisionNumber,
        feedbackCount: next.feedbackIds.length,
        implementationMode: next.implementationMode,
        newImprovementProposalRecommended: next.newImprovementProposalRecommended
      });
    }
    return changed;
  }

  private updateStatus(revisionProposalId: string, status: ImprovementRevisionProposal["status"], reason?: string): void {
    const current = this.get(revisionProposalId);
    this.options.revisions.upsert(improvementRevisionProposalSchema.parse({ ...current, status, updatedAt: new Date(this.now()).toISOString(), ...(reason ? { reviewReason: reason.slice(0, 2048) } : {}) }));
  }

  private buildExecutionProposal(original: ImprovementProposal, revision: ImprovementRevisionProposal): ImprovementProposal {
    const requestedKind = revision.requestedChange.kind === "test-change" ? "test-coverage" : revision.requestedChange.kind === "documentation" ? "skill-routing" : revision.requestedChange.kind === "tool-surface" ? "surface-demotion" : original.proposedChange.kind;
    const allowedAreas = revision.requestedChange.allowedAreas.length > 0 ? revision.requestedChange.allowedAreas : original.proposedChange.allowedAreas;
    const forbiddenAreas = Array.from(new Set([...original.proposedChange.forbiddenAreas, ...revision.requestedChange.forbiddenAreas]));
    return improvementProposalSchema.parse({
      ...original,
      status: "approved",
      title: revision.title,
      summary: revision.summary,
      updatedAt: new Date(this.now()).toISOString(),
      proposedChange: {
        ...original.proposedChange,
        kind: requestedKind,
        description: revision.requestedChange.description,
        allowedAreas,
        forbiddenAreas,
        changeScope: revision.requestedChange.changeScope,
        implementationMode: revision.implementationMode
      },
      validationPlan: revision.validationPlan
    });
  }

  private resolvePullRequest(selector: { pullRequestId?: string; pullRequestNumber?: number; implementationRunId?: string }): ImprovementPullRequest {
    const record = selector.pullRequestId
      ? this.options.pullRequests.get(selector.pullRequestId)
      : selector.implementationRunId
        ? this.options.pullRequests.findByImplementationRun(selector.implementationRunId)
        : this.options.pullRequests.list(500).find(item => item.number === selector.pullRequestNumber);
    if (!record) throw new DebugMcpError("PullRequestNotFound", "Improvement pull request record was not found", { selector });
    return record;
  }

  private async remoteFor(pullRequest: ImprovementPullRequest) {
    if (!pullRequest.number) throw new DebugMcpError("PullRequestInvalidState", "The improvement pull request has no external number", { pullRequestId: pullRequest.pullRequestId });
    return this.options.provider.getPullRequest(pullRequest.number);
  }

  private assertOpen(remote: { state: "open" | "closed"; merged: boolean }, pullRequestId: string): void {
    if (remote.merged) throw new DebugMcpError("RevisionNotAllowedAfterMerge", "A merged pull request cannot receive an automated revision", { pullRequestId });
    if (remote.state !== "open") throw new DebugMcpError("PullRequestClosed", "A closed pull request cannot receive an automated revision", { pullRequestId, state: remote.state });
  }

  private requireOriginal(proposalId: string): ImprovementProposal {
    const proposal = this.options.proposals.get(proposalId);
    if (!proposal) throw new DebugMcpError("ProposalNotFound", `Improvement Proposal not found: ${proposalId}`, { proposalId });
    return proposal;
  }

  private requireRun(runId: string): ImprovementImplementationRun {
    const run = this.options.runs.get(runId);
    if (!run) throw new DebugMcpError("ImprovementRunNotFound", `Improvement implementation run not found: ${runId}`, { runId });
    return run;
  }

  private nextRevisionNumber(originalProposalId: string): number {
    return Math.max(0, ...this.options.revisions.list({ originalProposalId, limit: 500 }).map(value => value.revisionNumber)) + 1;
  }

  private markEvidenceChangedForEditedFeedback(pullRequestId: string, group: readonly { feedbackId: string; rawTextHash: string }[]): void {
    const ids = new Set(group.map(item => item.feedbackId));
    const changedIds: string[] = [];
    for (const current of this.options.revisions.list({ pullRequestId, limit: 500 })) {
      const changed = current.feedbackIds.some((id, index) => ids.has(id) && current.feedbackHashes[index] !== group.find(item => item.feedbackId === id)?.rawTextHash);
      if (changed) changedIds.push(...current.feedbackIds.filter(id => ids.has(id)));
    }
    this.markEvidenceChangedByFeedback(changedIds, "Review feedback was edited after it was linked to this revision.");
  }

  private assertRemoteBinding(remote: { repository: string; branch: string; baseBranch: string }, pullRequest: ImprovementPullRequest): void {
    const expectedRepository = this.options.repository ?? pullRequest.repository;
    if (remote.repository !== expectedRepository || remote.branch !== pullRequest.branch || remote.baseBranch !== pullRequest.baseBranch) {
      throw new DebugMcpError("RevisionRemoteDrift", "The remote pull request is no longer bound to the recorded candidate repository, branch, and base", {
        pullRequestId: pullRequest.pullRequestId,
        expectedRepository,
        expectedBranch: pullRequest.branch,
        expectedBaseBranch: pullRequest.baseBranch
      });
    }
  }
}

function groupFeedback(values: readonly import("./RevisionSchemas.js").ImprovementReviewFeedback[]): import("./RevisionSchemas.js").ImprovementReviewFeedback[][] {
  const groups = new Map<string, import("./RevisionSchemas.js").ImprovementReviewFeedback[]>();
  for (const value of values) {
    const key = `${value.classification ?? "unknown"}:${value.path ?? "<pr>"}`;
    const current = groups.get(key) ?? [];
    current.push(value);
    groups.set(key, current);
  }
  return Array.from(groups.values());
}
