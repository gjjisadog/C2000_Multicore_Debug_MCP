import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Logger } from "../../utils/logger.js";
import { DebugMcpError } from "../../utils/errors.js";
import type { ImprovementProposalStore } from "../ProposalRepository.js";
import type { ImprovementProposal } from "../ProposalSchemas.js";
import type { ImprovementProposalService } from "../ImprovementProposalService.js";
import type { ImprovementImplementationRunStore } from "../implementation/ImplementationRunRepository.js";
import type { ImprovementImplementationRun, ImplementationArtifact } from "../implementation/ImplementationSchemas.js";
import {
  improvementPullRequestSchema,
  sha256Json,
  type HardwareEvidence,
  type ImprovementPullRequest,
  type ImprovementPullRequestStatus,
  type MergeRecommendation,
  type ReviewEvidence,
  type ReviewPolicyConfig
} from "./ReviewSchemas.js";
import { CandidatePublishService, type CandidatePublishResult } from "./CandidatePublishService.js";
import { CandidateReviewService } from "./CandidateReviewService.js";
import {
  type ImprovementCodeReviewProvider,
  type ProviderPullRequest
} from "./GitHubReviewProvider.js";
import { ReviewEvidenceService } from "./ReviewEvidenceService.js";
import { MergeRecommendationService } from "./MergeRecommendationService.js";
import type { ImprovementPullRequestStore, ImprovementReviewEvidenceStore, MergeRecommendationStore } from "./ReviewRepositories.js";
import type { RevisionProposalService } from "../revision/RevisionProposalService.js";
import type { ImprovementRevisionProposal } from "../revision/RevisionSchemas.js";

export const IMPROVEMENT_PR_BODY_START = "<!-- c2000-improvement:start -->";
export const IMPROVEMENT_PR_BODY_END = "<!-- c2000-improvement:end -->";

export interface ImprovementPullRequestServiceOptions {
  runs: ImprovementImplementationRunStore;
  proposals: ImprovementProposalStore;
  proposalService?: ImprovementProposalService;
  pullRequests: ImprovementPullRequestStore;
  evidence: ImprovementReviewEvidenceStore;
  recommendations: MergeRecommendationStore;
  candidateReview: CandidateReviewService;
  candidatePublish: CandidatePublishService;
  provider: ImprovementCodeReviewProvider;
  review: ReviewPolicyConfig;
  artifactRoot: string;
  now?: () => number;
  logger?: Pick<Logger, "info" | "warn" | "error">;
  revisionService?: RevisionProposalService;
  /** Called after an externally observed merge has been durably recorded. */
  onMerged?: (pullRequest: ImprovementPullRequest) => void | Promise<void>;
}

export interface PublishImprovementCandidateInput {
  implementationRunId: string;
}

export interface GetImprovementPullRequestInput {
  implementationRunId?: string;
  pullRequestId?: string;
  pullRequestNumber?: number;
}

export interface RefreshImprovementReviewEvidenceInput extends GetImprovementPullRequestInput {
  hardwareEvidence?: HardwareEvidence;
}

export interface PublishRevisionCandidateInput {
  revisionProposalId: string;
}

/**
 * Coordinates candidate publication and external review evidence. GitHub is
 * treated as an evidence source, not an authority to merge code.
 */
export class ImprovementPullRequestService {
  private readonly now: () => number;
  private readonly artifactRoot: string;
  private readonly evidenceService = new ReviewEvidenceService();
  private readonly recommendationService = new MergeRecommendationService();

  constructor(private readonly options: ImprovementPullRequestServiceOptions) {
    this.now = options.now ?? (() => Date.now());
    this.artifactRoot = path.resolve(options.artifactRoot);
  }

  async publish(input: PublishImprovementCandidateInput | string): Promise<Record<string, unknown>> {
    const implementationRunId = typeof input === "string" ? input : input.implementationRunId;
    const run = this.requireRun(implementationRunId);
    const proposal = this.requireProposal(run.proposalId);
    const candidateReview = await this.options.candidateReview.assertPublishable(implementationRunId);
    let remote: ProviderPullRequest | undefined;
    try {
      const published = await this.options.candidatePublish.publish(implementationRunId);
      remote = await this.options.provider.findOpenPullRequest(run.branchName, this.options.review.baseBranch);
      const created = !remote;
      if (remote) this.assertRemoteMatches(remote, run, proposal, candidateReview.candidateSha);
      const existing = this.options.pullRequests.findByImplementationRun(run.runId);
      const generatedBody = renderImprovementPullRequestBody({
        proposal,
        run,
        candidateReview,
        artifactRoot: this.artifactRoot,
        hardwareRequired: proposal.validationPlan.hardwareRequired,
        ...(existing?.revisionHistory ? { revisionHistory: existing.revisionHistory } : {})
      });
      const bodyHash = sha256Json(generatedBody);
      if (!remote) {
        remote = await this.options.provider.createPullRequest({
          title: `improve(${safeText(proposal.target, 96)}): ${safeText(proposal.title, 256)}`,
          body: generatedBody,
          branch: run.branchName,
          baseBranch: this.options.review.baseBranch,
          draft: true
        });
        this.assertRemoteMatches(remote, run, proposal, candidateReview.candidateSha);
      } else if (mergeGeneratedBody(remote.body, generatedBody) !== remote.body) {
        remote = await this.options.provider.updatePullRequest(remote.number, {
          body: mergeGeneratedBody(remote.body, generatedBody)
        });
        this.assertRemoteMatches(remote, run, proposal, candidateReview.candidateSha);
      }
      const stored = this.storePullRequest(remote, run, proposal, bodyHash, statusForRemote(remote));
      this.markProposalLifecycle(proposal.proposalId, "pr-open");
      return {
        pullRequest: publicPullRequest(stored),
        publication: published,
        created,
        draft: remote.draft,
        requiresHumanReview: true,
        requiresHumanMerge: true,
        pushesAutomatically: false,
        mergesAutomatically: false
      };
    } catch (error) {
      // The branch may already be safely published. A later retry is
      // idempotent; no force-push or automatic PR recovery is attempted.
      this.recordPublishFailure(run, proposal, candidateReview);
      this.options.logger?.warn("c2000 improvement candidate PR publication failed", {
        runId: run.runId,
        proposalId: proposal.proposalId,
        candidateSha: candidateReview.candidateSha,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /** Fast-forwards the existing PR branch with a validated C(n+1) revision. */
  async publishRevision(input: PublishRevisionCandidateInput | string): Promise<Record<string, unknown>> {
    if (!this.options.revisionService) throw new DebugMcpError("ImprovementImplementationUnavailable", "Review revision service is not configured in this runtime");
    const revisionProposalId = typeof input === "string" ? input : input.revisionProposalId;
    const context = await this.options.revisionService.prepareForPublication(revisionProposalId);
    const revision = context.revision;
    const run = this.requireRunForRevision(revision);
    const proposal = context.originalProposal;
    const candidateReview = await this.options.candidateReview.assertPublishable(run.runId);
    const published = await this.options.candidatePublish.publishRevision(run.runId, context.pullRequest.branch, revision.baseCandidateSha);
    const remote = await this.options.provider.getPullRequest(context.pullRequest.number!);
    this.assertRemoteMatches(remote, run, proposal, candidateReview.candidateSha, context.pullRequest.branch);
    const revisionHistory = appendRevisionHistory(context.pullRequest.revisionHistory, revision, run, candidateReview, new Date(this.now()).toISOString());
    const generatedBody = renderImprovementPullRequestBody({
      proposal,
      run,
      candidateReview,
      artifactRoot: this.artifactRoot,
      hardwareRequired: proposal.validationPlan.hardwareRequired,
      revisionHistory
    });
    const generatedBodyHash = sha256Json(generatedBody);
    const mergedBody = mergeGeneratedBody(remote.body, generatedBody);
    const updatedRemote = mergedBody !== remote.body && remote.state === "open"
      ? await this.options.provider.updatePullRequest(remote.number, { body: mergedBody })
      : remote;
    this.assertRemoteMatches(updatedRemote, run, proposal, candidateReview.candidateSha, context.pullRequest.branch);
    const stored = improvementPullRequestSchema.parse({
      ...context.pullRequest,
      candidateSha: candidateReview.candidateSha,
      currentImplementationRunId: run.runId,
      currentBaseSha: updatedRemote.baseSha,
      currentHeadSha: updatedRemote.headSha,
      updatedAt: new Date(this.now()).toISOString(),
      // A reviewer-requested change remains an active human gate until a
      // later review explicitly clears it. Publishing C(n+1) is not a review
      // resolution and must not silently turn that state back to "open".
      status: context.pullRequest.status === "changes-requested" ? "changes-requested" : statusForRemote(updatedRemote),
      generatedBodyHash,
      revisionHistory
    });
    this.options.pullRequests.upsert(stored);
    this.options.revisionService.markCandidateReady(revisionProposalId, run.runId, candidateReview.candidateSha);
    return {
      pullRequest: publicPullRequest(stored),
      publication: published,
      revisionProposal: revision,
      created: false,
      draft: updatedRemote.draft,
      requiresHumanReview: true,
      requiresHumanMerge: true,
      pushesAutomatically: false,
      mergesAutomatically: false
    };
  }

  get(input: GetImprovementPullRequestInput): Record<string, unknown> {
    const record = this.resolveStoredPullRequest(input);
    const evidence = this.options.evidence.getLatest(record.pullRequestId, record.candidateSha);
    const recommendation = this.options.recommendations.getLatest(record.pullRequestId, record.candidateSha);
    return {
      pullRequest: publicPullRequest(record),
      ...(evidence ? { reviewEvidence: evidence } : {}),
      ...(recommendation ? { mergeRecommendation: recommendation } : {}),
      refreshRequired: !evidence || !recommendation
    };
  }

  async refresh(input: RefreshImprovementReviewEvidenceInput): Promise<Record<string, unknown>> {
    const stored = this.resolveStoredPullRequest(input);
    if (!stored.number) throw new DebugMcpError("PullRequestInvalidState", "The improvement candidate has no external pull request number", { pullRequestId: stored.pullRequestId });
    const run = this.requireRun(stored.currentImplementationRunId ?? stored.implementationRunId);
    const proposal = this.requireProposal(stored.proposalId);
    const remote = await this.options.provider.getPullRequest(stored.number);
    // Refresh is an evidence operation. If a human or another process added
    // an unvalidated commit to the PR branch, retain that fact as stale head
    // evidence so MergeRecommendation can return NEEDS_REVALIDATION instead
    // of hiding the drift behind an early exception.
    this.assertRemoteBinding(remote, run, proposal, stored.branch);
    const checks = await this.options.provider.listChecks(stored.candidateSha);
    const reviews = await this.options.provider.listReviews(stored.number);
    const candidateReview = await this.options.candidateReview.review(run.runId);
    const evidence = this.evidenceService.collect({
      pullRequest: stored,
      providerPullRequest: remote,
      candidateReview,
      candidateBaselineSha: run.baselineSha,
      expectedProviderBaseSha: stored.currentBaseSha ?? stored.originalBaseSha ?? remote.baseSha,
      checks,
      reviews,
      policy: this.options.review,
      hardwareRequired: proposal.validationPlan.hardwareRequired,
      ...(input.hardwareEvidence ? { hardwareEvidence: input.hardwareEvidence } : {}),
      now: this.now
    });
    this.options.evidence.upsert(evidence);
    // Evaluate against the just-read remote lifecycle and base/head identity,
    // not the previous local snapshot. A closed or externally merged PR must
    // never receive a merge recommendation because its evidence happens to be
    // otherwise green.
    const recommendationTarget = improvementPullRequestSchema.parse({
      ...stored,
      status: statusForRemote(remote),
      draft: remote.draft,
      currentBaseSha: remote.baseSha,
      currentHeadSha: remote.headSha,
      ...(remote.mergedSha ? { mergedCommitSha: remote.mergedSha } : {}),
      ...(remote.mergedAt ? { mergedAt: remote.mergedAt } : {})
    });
    const recommendation = this.recommendationService.evaluate({ pullRequest: recommendationTarget, proposal, evidence, now: this.now });
    this.options.recommendations.upsert(recommendation);
    const generatedBody = renderImprovementPullRequestBody({
      proposal,
      run,
      candidateReview,
      evidence,
      recommendation,
      artifactRoot: this.artifactRoot,
      hardwareRequired: proposal.validationPlan.hardwareRequired,
      revisionHistory: stored.revisionHistory
    });
    const generatedBodyHash = sha256Json(generatedBody);
    let refreshedRemote = remote;
    if (mergeGeneratedBody(remote.body, generatedBody) !== remote.body && remote.state === "open") {
      refreshedRemote = await this.options.provider.updatePullRequest(remote.number, { body: mergeGeneratedBody(remote.body, generatedBody) });
      this.assertRemoteBinding(refreshedRemote, run, proposal, stored.branch);
    }
    const updated = this.storePullRequest(refreshedRemote, run, proposal, generatedBodyHash, statusForEvidence(refreshedRemote, evidence, recommendation));
    if (refreshedRemote.merged) {
      this.markProposalLifecycle(proposal.proposalId, "merged");
      try {
        await this.options.onMerged?.(updated);
      } catch (error) {
        // Post-merge evaluation is an isolated governance side effect. A
        // provider refresh must remain usable even if its optional evaluator
        // cannot create metadata for a legacy or incomplete record.
        this.options.logger?.warn("c2000 post-merge evaluation creation failed", {
          pullRequestId: updated.pullRequestId,
          proposalId: updated.proposalId,
          mergedCommitSha: updated.mergedCommitSha,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    else if (refreshedRemote.state === "closed") this.markProposalLifecycle(proposal.proposalId, "closed-without-merge");
    else if (recommendation.verdict === "MERGE_RECOMMENDED") this.markProposalLifecycle(proposal.proposalId, "merge-recommended");
    return {
      pullRequest: publicPullRequest(updated),
      reviewEvidence: evidence,
      mergeRecommendation: recommendation,
      externalState: {
        state: refreshedRemote.state,
        merged: refreshedRemote.merged,
        headSha: refreshedRemote.headSha,
        baseSha: refreshedRemote.baseSha
      }
    };
  }

  getMergeRecommendation(input: GetImprovementPullRequestInput): Record<string, unknown> {
    const record = this.resolveStoredPullRequest(input);
    const recommendation = this.options.recommendations.getLatest(record.pullRequestId, record.candidateSha);
    return {
      pullRequestId: record.pullRequestId,
      pullRequestNumber: record.number,
      candidateSha: record.candidateSha,
      recommendation: recommendation ?? null,
      refreshRequired: !recommendation
    };
  }

  private storePullRequest(remote: ProviderPullRequest, run: ImprovementImplementationRun, proposal: ImprovementProposal, generatedBodyHash: string, status: ImprovementPullRequestStatus): ImprovementPullRequest {
    const existing = this.options.pullRequests.findByImplementationRun(run.runId);
    const candidateSha = run.candidateCommitSha ?? existing?.candidateSha;
    const baselineSha = existing?.baselineSha ?? run.baselineSha;
    if (!candidateSha) throw new DebugMcpError("CandidateNotReady", "The implementation run has no candidate commit SHA", { runId: run.runId });
    const stored = improvementPullRequestSchema.parse({
      pullRequestId: existing?.pullRequestId ?? `pr-${randomUUID()}`,
      proposalId: existing?.proposalId ?? proposal.proposalId,
      // The PR remains anchored to the original implementation run; the
      // current run is tracked separately so C(n+1) refreshes do not rewrite
      // the PR's branch or original baseline identity.
      implementationRunId: existing?.implementationRunId ?? run.runId,
      currentImplementationRunId: run.runId,
      repository: existing?.repository ?? this.options.review.repository,
      branch: existing?.branch ?? run.branchName,
      baseBranch: existing?.baseBranch ?? this.options.review.baseBranch,
      candidateSha,
      baselineSha,
      number: remote.number,
      url: remote.url,
      title: remote.title || `improve(${safeText(proposal.target, 96)}): ${safeText(proposal.title, 256)}`,
      status,
      draft: remote.draft,
      createdAt: existing?.createdAt ?? new Date(this.now()).toISOString(),
      updatedAt: new Date(this.now()).toISOString(),
      originalBaseSha: existing?.originalBaseSha ?? remote.baseSha,
      currentBaseSha: remote.baseSha,
      currentHeadSha: remote.headSha,
      ...(remote.mergedSha ? { mergedCommitSha: remote.mergedSha } : {}),
      ...(remote.mergedAt ? { mergedAt: remote.mergedAt } : {}),
      generatedBodyHash,
      humanBodyPreserved: true,
      revisionHistory: existing?.revisionHistory ?? [{
        runId: run.runId,
        candidateSha,
        category: proposal.category,
        summary: safeText(proposal.summary, 512),
        feedbackIds: [],
        ...(run.validationResult?.verdict ? { validationVerdict: run.validationResult.verdict } : {}),
        recordedAt: new Date(this.now()).toISOString()
      }]
    });
    this.options.pullRequests.upsert(stored);
    return stored;
  }

  private resolveStoredPullRequest(input: GetImprovementPullRequestInput): ImprovementPullRequest {
    const record = input.implementationRunId
      ? this.options.pullRequests.findByImplementationRun(input.implementationRunId)
      : input.pullRequestId
        ? this.options.pullRequests.get(input.pullRequestId)
        : input.pullRequestNumber !== undefined
          ? this.options.pullRequests.findByNumber(this.options.review.repository, input.pullRequestNumber)
          : undefined;
    if (!record) throw new DebugMcpError("PullRequestNotFound", "Improvement pull request record was not found", {
      implementationRunId: input.implementationRunId,
      pullRequestId: input.pullRequestId,
      pullRequestNumber: input.pullRequestNumber
    });
    return record;
  }

  private requireRun(runId: string): ImprovementImplementationRun {
    const run = this.options.runs.get(runId);
    if (!run) throw new DebugMcpError("ImprovementRunNotFound", `Improvement implementation run not found: ${runId}`, { runId });
    return run;
  }

  private requireProposal(proposalId: string): ImprovementProposal {
    const proposal = this.options.proposals.get(proposalId);
    if (!proposal) throw new DebugMcpError("ProposalNotFound", `Improvement Proposal not found: ${proposalId}`, { proposalId });
    return proposal;
  }

  private assertRemoteMatches(remote: ProviderPullRequest, run: ImprovementImplementationRun, proposal: ImprovementProposal, candidateSha: string, expectedBranch = run.branchName): void {
    this.assertRemoteBinding(remote, run, proposal, expectedBranch);
    if (remote.headSha.toLowerCase() !== candidateSha.toLowerCase()) {
      throw new DebugMcpError("CandidateHeadChanged", "External pull request HEAD no longer matches the validated candidate SHA", {
        proposalId: proposal.proposalId,
        runId: run.runId,
        candidateSha,
        externalHeadSha: remote.headSha,
        pullRequestNumber: remote.number
      });
    }
  }

  private assertRemoteBinding(remote: ProviderPullRequest, run: ImprovementImplementationRun, proposal: ImprovementProposal, expectedBranch = run.branchName): void {
    if (remote.repository !== this.options.review.repository || remote.branch !== expectedBranch || remote.baseBranch !== this.options.review.baseBranch) {
      throw new DebugMcpError("PullRequestInvalidState", "External pull request is not bound to the configured candidate repository/branch/base", {
        proposalId: proposal.proposalId,
        runId: run.runId,
        expectedRepository: this.options.review.repository,
        expectedBranch,
        expectedBaseBranch: this.options.review.baseBranch
      });
    }
  }

  private markProposalLifecycle(proposalId: string, status: "pr-open" | "merge-recommended" | "merged" | "closed-without-merge"): void {
    if (!this.options.proposalService) return;
    try {
      this.options.proposalService.markReviewLifecycle(proposalId, status);
    } catch (error) {
      this.options.logger?.warn("c2000 improvement proposal review lifecycle update skipped", { proposalId, status, error: String(error) });
    }
  }

  private recordPublishFailure(
    run: ImprovementImplementationRun,
    proposal: ImprovementProposal,
    candidateReview: { baselineSha: string; candidateSha: string; branch: string; currentBaseSha: string }
  ): void {
    const existing = this.options.pullRequests.findByImplementationRun(run.runId);
    const timestamp = new Date(this.now()).toISOString();
    if (existing) {
      this.options.pullRequests.upsert({ ...existing, status: "publish-failed", updatedAt: timestamp });
      return;
    }
    this.options.pullRequests.upsert(improvementPullRequestSchema.parse({
      pullRequestId: `pr-${randomUUID()}`,
      proposalId: proposal.proposalId,
      implementationRunId: run.runId,
      repository: this.options.review.repository,
      branch: candidateReview.branch,
      baseBranch: this.options.review.baseBranch,
      candidateSha: candidateReview.candidateSha,
      baselineSha: candidateReview.baselineSha,
      title: `improve(${safeText(proposal.target, 96)}): ${safeText(proposal.title, 256)}`,
      status: "publish-failed",
      draft: true,
      createdAt: timestamp,
      updatedAt: timestamp,
      originalBaseSha: candidateReview.baselineSha,
      currentBaseSha: candidateReview.currentBaseSha,
      currentHeadSha: candidateReview.candidateSha,
      generatedBodyHash: sha256Json({ runId: run.runId, candidateSha: candidateReview.candidateSha, status: "publish-failed" }),
      humanBodyPreserved: true
    }));
  }

  private requireRunForRevision(revision: ImprovementRevisionProposal): ImprovementImplementationRun {
    const run = this.options.runs.list({ proposalId: revision.originalProposalId, limit: 500 }).find(item => item.revisionProposalId === revision.revisionProposalId && item.status === "candidate-ready");
    if (!run) throw new DebugMcpError("CandidateNotReady", "No validated candidate run exists for the approved review revision", { revisionProposalId: revision.revisionProposalId });
    return run;
  }
}

function appendRevisionHistory(
  current: ImprovementPullRequest["revisionHistory"],
  revision: ImprovementRevisionProposal,
  run: ImprovementImplementationRun,
  candidateReview: { candidateSha: string },
  recordedAt: string
): ImprovementPullRequest["revisionHistory"] {
  return [...current, {
    runId: run.runId,
    revisionProposalId: revision.revisionProposalId,
    candidateSha: candidateReview.candidateSha,
    parentCandidateSha: revision.baseCandidateSha,
    category: revision.category,
    summary: revision.summary.slice(0, 512),
    feedbackIds: revision.feedbackIds,
    ...(run.validationResult?.verdict ? { validationVerdict: run.validationResult.verdict } : {}),
    recordedAt
  }].slice(-32);
}

export function renderImprovementPullRequestBody(input: {
  proposal: ImprovementProposal;
  run: ImprovementImplementationRun;
  candidateReview: { baselineSha: string; candidateSha: string; branch: string; changedFiles: string[]; validationPassed: boolean; baseDrift: { classification: string } };
  evidence?: ReviewEvidence;
  recommendation?: MergeRecommendation;
  artifactRoot: string;
  hardwareRequired: boolean;
  revisionHistory?: ImprovementPullRequest["revisionHistory"];
}): string {
  const { proposal, run, candidateReview, evidence, recommendation } = input;
  const artifacts = (run.artifacts ?? []).map(artifact => formatArtifact(artifact, input.artifactRoot)).filter(Boolean);
  const validation = run.validationResult;
  const body = [
    IMPROVEMENT_PR_BODY_START,
    "## C2000 Controlled Improvement Candidate",
    "",
    `- Proposal ID: ${safeText(proposal.proposalId, 128)}`,
    `- Implementation Run ID: ${safeText(run.runId, 128)}`,
    `- Baseline SHA: ${candidateReview.baselineSha}`,
    `- Candidate SHA: ${candidateReview.candidateSha}`,
    `- Candidate branch: ${safeText(candidateReview.branch, 256)}`,
    "",
    "## Problem and proposed change",
    "",
    safeText(proposal.summary, 2048),
    "",
    "## Evidence",
    "",
    `- Observed ${proposal.evidence.matchingRuns} matching run(s) across ${safeText(proposal.evidence.sampleWindow, 32)}; affected runs: ${proposal.evidence.affectedRuns}.`,
    `- Root-cause classification: ${safeText(proposal.evidence.rootCause, 64)}.`,
    `- Evidence sufficiency: ${proposal.evidence.sufficient ? "sufficient" : "insufficient"}; pattern ratio: ${proposal.evidence.patternRatio}; failure rate: ${proposal.evidence.failureRate}.`,
    "",
    `- Target: ${safeText(proposal.target, 192)}`,
    `- Change: ${safeText(proposal.proposedChange.description, 2048)}`,
    `- Scope: ${safeText(proposal.proposedChange.changeScope, 32)}`,
    "",
    "## Changed files",
    ...(candidateReview.changedFiles.length > 0 ? candidateReview.changedFiles.map(file => `- ${safeRelativePath(file)}`) : ["- none"]),
    "",
    "## Protected invariants",
    "",
    "- CPU1 remains coreId 0 and CPU2 remains coreId 2.",
    "- CPU2 boot handoff ordering, RAM ownership, and Flash reload protection remain fail-closed.",
    "- Daemon/worker leases, persistence, CAN, DLOG, ERAD, Variable Stream, and Trace semantics are not rewritten by this review pipeline.",
    "",
    "## Validation summary",
    "",
    `- Candidate validation: ${candidateReview.validationPassed ? "passed" : "not passing"}`,
    `- Validation verdict: ${validation?.verdict ?? "unknown"}`,
    "### Focused tests",
    ...((validation?.tests ?? []).length > 0 ? (validation?.tests ?? []).map(test => `- ${safeText(test.name, 256)}: ${test.status}`) : ["- none recorded"]),
    "### Regression tests",
    ...((run.validationCommands ?? []).filter(command => /regression/i.test(command.stage) || /regression/i.test(command.name)).map(command => `- ${safeText(command.name, 256)}: ${command.status}`)),
    `- Before/after metrics: ${proposal.validationPlan.beforeAfterMetrics.length > 0 ? proposal.validationPlan.beforeAfterMetrics.map(metric => safeText(metric, 192)).join(", ") : "none declared"}`,
    `- Recorded metric delta: ${formatMetricDelta(validation?.metricDelta)}`,
    `- Base drift at publication: ${safeText(candidateReview.baseDrift.classification, 64)}`,
    "",
    "## Hardware validation",
    "",
    `- Hardware evidence: ${input.hardwareRequired ? evidence?.hardware.status ?? "required / not supplied" : "not required"}`,
    ...(evidence ? [
      `- Required CI evidence: ${evidence.ci.status}`,
      `- Human review evidence: ${evidence.reviews.status}`,
      `- Candidate head evidence: ${evidence.head.status}`
    ] : []),
    "",
    "## Artifacts",
    ...(artifacts.length > 0 ? artifacts.map(value => `- ${value}`) : ["- bounded artifacts are not available"]),
    "",
    "## Risks and automation boundary",
    ...proposal.risks.map(risk => `- ${safeText(risk.level, 32)}: ${safeText(risk.description, 1024)} Mitigation: ${safeText(risk.mitigation, 1024)}`),
    "- This candidate was produced by the controlled improvement pipeline from an explicitly approved proposal and independently validated before PR creation.",
    "- This PR is created as a draft by default.",
    "- No automatic merge is permitted.",
    "- CI, hardware evidence, and human review are evidence gates; none authorizes an automatic merge.",
    `- Current merge recommendation: ${recommendation?.verdict ?? "refresh required"}. Human merge remains required.`,
    ...(input.revisionHistory && input.revisionHistory.length > 0 ? [
      "",
      "## Revision History",
      "",
      ...input.revisionHistory.map(entry => {
        const feedback = entry.feedbackIds.length > 0
          ? ` [feedback: ${entry.feedbackIds.map(id => safeText(id, 128)).join(", ")}]`
          : "";
        return `- ${safeText(entry.runId, 128)}${entry.revisionProposalId ? ` / ${safeText(entry.revisionProposalId, 256)}` : ""}${feedback}: ${safeText(entry.category ?? "initial", 64)} — ${safeText(entry.summary ?? "candidate", 512)} (${entry.candidateSha.slice(0, 12)})`;
      })
    ] : []),
    "",
    IMPROVEMENT_PR_BODY_END
  ];
  return `${body.join("\n")}\n`;
}

export function mergeGeneratedBody(existing: string, generated: string): string {
  const start = existing.indexOf(IMPROVEMENT_PR_BODY_START);
  const end = existing.indexOf(IMPROVEMENT_PR_BODY_END);
  if (start < 0 || end < start) {
    return existing.trim() ? `${existing.trim()}\n\n${generated}` : generated;
  }
  const before = existing.slice(0, start).replace(/\s+$/, "");
  const after = existing.slice(end + IMPROVEMENT_PR_BODY_END.length).replace(/^\s+/, "");
  return [before, generated.trim(), after].filter(Boolean).join("\n\n") + "\n";
}

function statusForRemote(remote: ProviderPullRequest): ImprovementPullRequestStatus {
  if (remote.merged) return "merged-externally";
  if (remote.state === "closed") return "closed";
  return "open";
}

function statusForEvidence(remote: ProviderPullRequest, evidence: ReviewEvidence, recommendation: MergeRecommendation): ImprovementPullRequestStatus {
  if (remote.merged) return "merged-externally";
  if (remote.state === "closed") return "closed";
  if (evidence.reviews.changesRequested) return "changes-requested";
  if (recommendation.verdict === "MERGE_RECOMMENDED") return "merge-recommended";
  if (recommendation.verdict === "DO_NOT_MERGE") return evidence.reviews.status === "fail" ? "changes-requested" : "blocked";
  if (recommendation.verdict === "NEEDS_REVALIDATION") return "blocked";
  if (evidence.hardware.status === "missing" || evidence.hardware.status === "pending") return "hardware-required";
  if (evidence.reviews.status === "missing") return "review-required";
  if (evidence.ci.status === "pending" || evidence.ci.status === "missing") return "checks-running";
  return "blocked";
}

function publicPullRequest(value: ImprovementPullRequest): Record<string, unknown> {
  return { ...value };
}

function formatArtifact(artifact: ImplementationArtifact, artifactRoot: string): string | undefined {
  const relative = path.relative(path.resolve(artifactRoot), path.resolve(artifact.path)).replace(/\\/g, "/");
  if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  return `${relative} (${artifact.sha256}, ${artifact.bytes} bytes)`;
}

function safeRelativePath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "");
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized) || normalized.startsWith("../")) return "<redacted-path>";
  return safeText(normalized, 512);
}

function safeText(value: string, max: number): string {
  return value
    .replace(/[\r\n]+/g, " ")
    .replace(/(?:[A-Za-z]:\\|\\\\|\/home\/|\/Users\/|\/根\/)[^\s`)]*/gi, "<redacted-path>")
    .replace(/(?:ghp_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]+/g, "<redacted-secret>")
    .slice(0, max)
    .trim() || "(not provided)";
}

function formatMetricDelta(value: Record<string, number> | undefined): string {
  const entries = Object.entries(value ?? {});
  if (entries.length === 0) return "none recorded";
  return entries.slice(0, 32).map(([name, delta]) => `${safeText(name, 192)}=${delta}`).join(", ");
}
