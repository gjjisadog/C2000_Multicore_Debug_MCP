import { randomUUID } from "node:crypto";
import type { OutcomeEventStore } from "../../analytics/OutcomeEventRepository.js";
import type { OutcomeEvent } from "../../analytics/OutcomeSchemas.js";
import type { ImprovementProposalStore } from "../ProposalRepository.js";
import type { ImprovementProposalService } from "../ImprovementProposalService.js";
import type { ImprovementPullRequest } from "../review/ReviewSchemas.js";
import type { Logger } from "../../utils/logger.js";
import { DebugMcpError } from "../../utils/errors.js";
import { ComparabilityService } from "./ComparabilityService.js";
import { ImprovementMetricService } from "./ImprovementMetricService.js";
import { evaluatePostMergeOutcome } from "./PostMergeEvaluationPolicy.js";
import { RollbackRecommendationService } from "./RollbackRecommendationService.js";
import {
  comparabilityReportSchema,
  postMergeEvaluationSchema,
  postMergeEvaluationSnapshotSchema,
  type EvaluationMetricDefinition,
  type PostMergeEvaluation,
  type RollbackRecommendation
} from "./EvaluationSchemas.js";
import type {
  PostMergeEvaluationListQuery,
  PostMergeEvaluationSnapshotStore,
  PostMergeEvaluationStore,
  RollbackRecommendationStore
} from "./EvaluationRepositories.js";
import { derivePrimaryMetrics } from "../ProposalSchemas.js";

export const POST_MERGE_MINIMUM_DURATION_DAYS = 7;
export const POST_MERGE_FINAL_DURATION_DAYS = 30;
export const POST_MERGE_BASELINE_WINDOW_DAYS = 30;
export const POST_MERGE_MINIMUM_SAMPLES = 20;
export const POST_MERGE_FINAL_SAMPLES = 100;

export interface PostMergeEvaluationServiceOptions {
  evaluations: PostMergeEvaluationStore;
  snapshots: PostMergeEvaluationSnapshotStore;
  rollbackRecommendations: RollbackRecommendationStore;
  events: OutcomeEventStore;
  proposals: ImprovementProposalStore;
  proposalService?: ImprovementProposalService;
  now?: () => number;
  logger?: Pick<Logger, "info" | "warn" | "error">;
}

export interface EnsureMergedPullRequestInput {
  pullRequest: ImprovementPullRequest;
}

export interface EvaluationRefreshInput {
  evaluationId: string;
  finalize?: boolean;
}

/**
 * Post-merge governance is deliberately read/record-only. It starts from
 * externally observed merge metadata and never calls git, GitHub merge APIs,
 * target control, deployment, or rollback commands.
 */
export class PostMergeEvaluationService {
  private readonly now: () => number;
  private readonly comparability = new ComparabilityService();
  private readonly metrics = new ImprovementMetricService();
  private readonly rollback: RollbackRecommendationService;

  constructor(private readonly options: PostMergeEvaluationServiceOptions) {
    this.now = options.now ?? (() => Date.now());
    this.rollback = new RollbackRecommendationService({
      recommendations: options.rollbackRecommendations,
      proposals: options.proposals,
      now: this.now,
      logger: options.logger
    });
  }

  /** Create metadata after an external human merge; evaluation is deferred. */
  ensureForMergedPullRequest(input: EnsureMergedPullRequestInput | ImprovementPullRequest): PostMergeEvaluation | undefined {
    const pullRequest = "pullRequest" in input ? input.pullRequest : input;
    if (!pullRequest.mergedCommitSha) return undefined;
    const existing = this.options.evaluations.findByPullRequest(pullRequest.pullRequestId);
    if (existing && existing.mergedCommitSha.toLowerCase() === pullRequest.mergedCommitSha.toLowerCase()) return existing;
    const proposal = this.options.proposals.get(pullRequest.proposalId);
    if (!proposal) throw new DebugMcpError("ProposalNotFound", `Improvement Proposal not found: ${pullRequest.proposalId}`, { proposalId: pullRequest.proposalId });
    const baselineSha = pullRequest.baselineSha || proposal.baselineSha;
    if (!baselineSha) throw new DebugMcpError("BaselineUnavailable", "A merged improvement requires a frozen baseline SHA", { proposalId: proposal.proposalId, pullRequestId: pullRequest.pullRequestId });
    const candidateSha = pullRequest.candidateSha;
    const mergedCommitSha = pullRequest.mergedCommitSha;
    const createdAt = new Date(this.now()).toISOString();
    const mergedAt = pullRequest.mergedAt ?? createdAt;
    const targetMetricSet = metricDefinitionsForProposal(proposal);
    const baselineEvents = this.baselineEvents(baselineSha, mergedAt);
    const baselineMetrics = this.metrics.snapshot(baselineEvents, targetMetricSet, "baseline", createdAt, {
      snapshotId: `baseline-${pullRequest.pullRequestId}-${randomUUID().slice(0, 8)}`
    });
    const mergeStatus = "metadata-confirmed" as const;
    const evaluation = postMergeEvaluationSchema.parse({
      evaluationId: `eval-${randomUUID()}`,
      proposalId: proposal.proposalId,
      pullRequestId: pullRequest.pullRequestId,
      ...(pullRequest.number === undefined ? {} : { pullRequestNumber: pullRequest.number }),
      baselineSha,
      candidateSha,
      mergedCommitSha,
      retrospectiveBaseline: true,
      mergedAt,
      createdAt,
      updatedAt: createdAt,
      lifecycleStatus: "waiting-for-deployment",
      observationWindow: {
        startedAt: mergedAt,
        minimumDurationDays: POST_MERGE_MINIMUM_DURATION_DAYS,
        finalDurationDays: POST_MERGE_FINAL_DURATION_DAYS,
        minimumComparableSamples: POST_MERGE_MINIMUM_SAMPLES,
        finalComparableSamples: POST_MERGE_FINAL_SAMPLES,
        finalAt: new Date(Date.parse(mergedAt) + POST_MERGE_FINAL_DURATION_DAYS * DAY_MS).toISOString()
      },
      targetMetricSet,
      baselineMetrics,
      comparability: emptyComparability(baselineEvents.length),
      deployment: {
        status: "not-deployed",
        matchedRuntimeEvents: 0,
        mergedShaMatched: false,
        knownReleaseContainingMerge: false,
        details: ["Evaluation metadata was created after external merge; waiting for a matching deployed runtime event."]
      },
      mergeVerification: {
        status: mergeStatus,
        candidateSha,
        mergedCommitSha,
        details: candidateSha.toLowerCase() === mergedCommitSha.toLowerCase()
          ? ["Provider metadata reports the validated candidate as the merged commit."]
          : ["The merged commit differs from the candidate SHA; squash/rebase merge identity is retained separately."]
      },
      confidence: 0,
      regressions: [],
      improvements: [],
      confounders: [],
      snapshotIds: [baselineMetrics.snapshotId],
      verdictHistory: []
    });
    this.options.evaluations.upsert(evaluation);
    const baselineSnapshot = postMergeEvaluationSnapshotSchema.parse({
      snapshotId: baselineMetrics.snapshotId,
      evaluationId: evaluation.evaluationId,
      phase: "baseline",
      capturedAt: createdAt,
      record: baselineMetrics,
      comparability: emptyComparability(baselineEvents.length)
    });
    this.options.snapshots.append(baselineSnapshot);
    this.options.logger?.info("c2000 post-merge evaluation created", {
      evaluationId: evaluation.evaluationId,
      proposalId: evaluation.proposalId,
      pullRequestId: evaluation.pullRequestId,
      candidateSha,
      mergedCommitSha,
      status: evaluation.lifecycleStatus
    });
    return evaluation;
  }

  list(query: PostMergeEvaluationListQuery = {}): Record<string, unknown> {
    return { evaluations: this.options.evaluations.list(query) };
  }

  get(evaluationId: string): Record<string, unknown> {
    const evaluation = this.requireEvaluation(evaluationId);
    const snapshots = this.options.snapshots.list(evaluationId);
    const rollback = evaluation.rollbackRecommendationId
      ? this.options.rollbackRecommendations.get(evaluation.rollbackRecommendationId)
      : this.options.rollbackRecommendations.getForEvaluation(evaluationId);
    return {
      evaluation,
      snapshots,
      rollbackRecommendation: rollback ?? null
    };
  }

  refresh(input: EvaluationRefreshInput | string): Record<string, unknown> {
    const evaluationId = typeof input === "string" ? input : input.evaluationId;
    const finalize = typeof input === "string" ? false : input.finalize === true;
    let evaluation = this.requireEvaluation(evaluationId);
    if (["invalidated", "closed"].includes(evaluation.lifecycleStatus)) return this.get(evaluationId);
    const nowMs = this.now();
    const nowIso = new Date(nowMs).toISOString();
    const baselineEvents = this.baselineEvents(evaluation.baselineSha, evaluation.mergedAt);
    const postWindow = this.options.events.list({ from: evaluation.mergedAt, to: nowIso, limit: 50_000 });
    const postEvents = postWindow.filter(event => matchesMergedRuntime(event, evaluation.mergedCommitSha));
    const knownReleaseContainingMerge = postEvents.some(event => releaseMatches(event, evaluation.mergedCommitSha) && !sameSha(runtimeSha(event), evaluation.mergedCommitSha));
    const deploymentReady = postEvents.length > 0;
    const comparison = this.comparability.compare(baselineEvents, postEvents, {
      expectedBaselineGitSha: evaluation.baselineSha,
      expectedPostMergeGitSha: knownReleaseContainingMerge ? undefined : evaluation.mergedCommitSha
    });
    const comparability = comparabilityReportSchema.parse({
      ...comparison.report,
      postMergeEventCount: postWindow.length,
      excludedPostMergeEventCount: Math.max(0, postWindow.length - postEvents.length)
    });
    const postMergeMetrics = this.metrics.snapshot(postEvents, evaluation.targetMetricSet, "post-merge", nowIso, {
      snapshotId: `post-${evaluation.evaluationId}-${randomUUID().slice(0, 8)}`,
      comparableEventCount: comparison.report.status === "comparable" ? postEvents.length : 0,
      excludedEventCount: Math.max(0, postWindow.length - postEvents.length)
    });
    const snapshot = postMergeEvaluationSnapshotSchema.parse({
      snapshotId: postMergeMetrics.snapshotId,
      evaluationId: evaluation.evaluationId,
      phase: "post-merge",
      capturedAt: nowIso,
      record: postMergeMetrics,
      comparability
    });
    this.options.snapshots.append(snapshot);

    const durationDays = Math.max(0, (nowMs - Date.parse(evaluation.mergedAt)) / DAY_MS);
    const metricComparison = this.metrics.compare(evaluation.baselineMetrics, postMergeMetrics, evaluation.targetMetricSet);
    const policy = evaluatePostMergeOutcome({
      definitions: evaluation.targetMetricSet,
      comparisons: metricComparison.comparisons,
      comparability,
      deploymentReady,
      durationDays,
      minimumDurationDays: evaluation.observationWindow.minimumDurationDays,
      comparableSamples: comparability.comparablePostMergeEventCount,
      minimumComparableSamples: evaluation.observationWindow.minimumComparableSamples,
      postMergeEvents: postEvents
    });
    const minimumEvidenceReady = deploymentReady
      && durationDays >= evaluation.observationWindow.minimumDurationDays
      && comparability.comparablePostMergeEventCount >= evaluation.observationWindow.minimumComparableSamples;
    // A normal refresh can produce an interim verdict once the minimum
    // evidence gate is met. Explicit finalization is stricter: it requires
    // either the final time window or the final comparable-sample budget.
    const finalEvidenceReady = deploymentReady
      && (durationDays >= evaluation.observationWindow.finalDurationDays
        || (finalize && comparability.comparablePostMergeEventCount >= evaluation.observationWindow.finalComparableSamples));
    const criticalRegression = policy.verdict === "regressed"
      && policy.regressions.some(finding => finding.severity === "critical");
    const finalEvaluationReady = finalEvidenceReady && (comparability.status === "comparable" || criticalRegression);
    const interimEvaluationReady = criticalRegression || (minimumEvidenceReady && comparability.status === "comparable");
    const lifecycleStatus = !deploymentReady
      ? "waiting-for-deployment"
      : criticalRegression && !finalEvaluationReady
        ? "monitoring"
        : comparability.status === "not-comparable"
          ? "insufficient-data"
          : !interimEvaluationReady
            ? "collecting"
        : !finalEvaluationReady
              ? "ready"
              : policy.verdict === "inconclusive"
                ? "insufficient-data"
                : "evaluated";
    const verdict = ["monitoring", "ready", "evaluated", "insufficient-data"].includes(lifecycleStatus) ? policy.verdict : undefined;
    const verdictHistory = verdict && (evaluation.verdictHistory.at(-1)?.verdict !== verdict || evaluation.verdictHistory.at(-1)?.recordedAt !== nowIso)
      ? [...evaluation.verdictHistory, { verdict, confidence: policy.confidence, recordedAt: nowIso, reason: policy.rationale.join(" ").slice(0, 1024) }].slice(-64)
      : evaluation.verdictHistory;
    evaluation = postMergeEvaluationSchema.parse({
      ...evaluation,
      updatedAt: nowIso,
      lifecycleStatus,
      postMergeMetrics,
      comparability,
      deployment: {
        status: deploymentReady ? "deployed" : "not-deployed",
        matchedRuntimeEvents: postEvents.length,
        mergedShaMatched: postEvents.some(event => sameSha(runtimeSha(event), evaluation.mergedCommitSha)),
        knownReleaseContainingMerge,
        details: deploymentReady ? ["Post-merge runtime evidence matched the merged commit or a declared containing release."] : ["No runtime event matched the merged commit or a declared containing release."]
      },
      ...(verdict ? { verdict } : { verdict: undefined }),
      confidence: verdict ? policy.confidence : 0,
      regressions: verdict ? policy.regressions : [],
      improvements: verdict ? policy.improvements : [],
      confounders: [...new Set([...evaluation.confounders, ...policy.confounders])].slice(0, 64),
      snapshotIds: [...evaluation.snapshotIds, snapshot.snapshotId].slice(-128),
      verdictHistory
    });
    this.options.evaluations.upsert(evaluation);

    let rollbackRecommendation: RollbackRecommendation | undefined;
    if (evaluation.verdict === "regressed") rollbackRecommendation = this.rollback.createForEvaluation(evaluation);
    if (evaluation.verdict === "improved" || evaluation.verdict === "neutral") this.rollback.supersedeForNonRegressedEvaluation(evaluation.proposalId, evaluation.evaluationId);
    if (rollbackRecommendation) {
      evaluation = postMergeEvaluationSchema.parse({ ...evaluation, rollbackRecommendationId: rollbackRecommendation.recommendationId, updatedAt: new Date(this.now()).toISOString() });
      this.options.evaluations.upsert(evaluation);
    }
    if (evaluation.verdict && finalEvaluationReady) this.updateProposalOutcome(evaluation);
    return {
      evaluation,
      snapshot,
      ...(rollbackRecommendation ? { rollbackRecommendation } : {}),
      policy: { rationale: policy.rationale, evaluated: lifecycleStatus === "evaluated" || lifecycleStatus === "insufficient-data" }
    };
  }

  reviewRollbackRecommendation(input: { recommendationId: string; action: "acknowledge" | "reject" | "convert-to-proposal" | "resolve"; reason: string; reviewer?: string }): Record<string, unknown> {
    return this.rollback.review(input);
  }

  getRollbackRecommendation(recommendationId: string): Record<string, unknown> {
    return { recommendation: this.rollback.get(recommendationId) };
  }

  getRollbackRecommendationForEvaluation(evaluationId: string): Record<string, unknown> {
    const recommendation = this.options.rollbackRecommendations.getForEvaluation(evaluationId);
    if (!recommendation) throw new DebugMcpError("RollbackRecommendationNotFound", `No rollback recommendation exists for evaluation ${evaluationId}`, { evaluationId });
    return { recommendation };
  }

  hasActiveCriticalRegression(): boolean {
    return this.options.rollbackRecommendations.list(500).some(item => item.severity === "critical" && ["open", "acknowledged"].includes(item.status));
  }

  private baselineEvents(baselineSha: string, mergedAt: string): OutcomeEvent[] {
    // Do not constrain the store query to the top-level SHA: older or
    // externally-ingested events may carry the deployed commit in metadata
    // (releaseContainsSha/deployedCommitSha). The final predicate remains
    // fail-closed and accepts only an explicit baseline identity.
    const mergedAtMs = Date.parse(mergedAt);
    const baselineStart = new Date(mergedAtMs - POST_MERGE_BASELINE_WINDOW_DAYS * DAY_MS).toISOString();
    const recent = this.options.events.list({ from: baselineStart, to: mergedAt, limit: 50_000 })
      .filter(event => Date.parse(event.timestamp) < mergedAtMs && matchesBaselineRuntime(event, baselineSha));
    if (recent.length >= POST_MERGE_MINIMUM_SAMPLES) return recent;

    // A sparse 30-day window may expand to retained history, but only to
    // recover enough explicitly identified samples. This keeps the default
    // window narrow without inventing a verdict when the retained history is
    // still insufficient.
    const retained = this.options.events.list({ to: mergedAt, limit: 50_000 });
    return retained.filter(event => Date.parse(event.timestamp) < mergedAtMs && matchesBaselineRuntime(event, baselineSha));
  }

  private requireEvaluation(evaluationId: string): PostMergeEvaluation {
    const value = this.options.evaluations.get(evaluationId);
    if (!value) throw new DebugMcpError("PostMergeEvaluationNotFound", `Post-merge evaluation not found: ${evaluationId}`, { evaluationId });
    return value;
  }

  private updateProposalOutcome(evaluation: PostMergeEvaluation): void {
    const proposal = this.options.proposals.get(evaluation.proposalId);
    if (!proposal || !this.options.proposalService) return;
    const finalOutcome = evaluation.verdict === "improved"
      ? "verified-improvement"
      : evaluation.verdict === "neutral"
        ? "no-observable-benefit"
        : evaluation.verdict === "regressed"
          ? "verified-regression"
          : "inconclusive";
    try {
      this.options.proposalService.setFinalOutcome(evaluation.proposalId, finalOutcome);
    } catch (error) {
      // Evaluation remains durable even when a legacy Proposal cannot accept
      // the optional final-outcome update.
      this.options.logger?.warn("c2000 proposal final outcome update skipped", { proposalId: evaluation.proposalId, finalOutcome, error: String(error) });
    }
  }
}

function metricDefinitionsForProposal(proposal: Parameters<typeof derivePrimaryMetrics>[0]): EvaluationMetricDefinition[] {
  return derivePrimaryMetrics(proposal).map(metric => ({
    name: metric.name,
    classification: metric.classification,
    direction: metric.direction,
    required: metric.required,
    tolerance: metric.tolerance,
    meaningfulDelta: metric.meaningfulDelta,
    unit: metric.unit,
    rationale: metric.rationale,
    source: metric.source
  }));
}

function matchesBaselineRuntime(event: OutcomeEvent, baselineSha: string): boolean {
  return sameSha(runtimeSha(event), baselineSha)
    || sameSha(metadataSha(event, "deployedCommitSha"), baselineSha)
    || sameSha(metadataSha(event, "releaseContainsSha"), baselineSha);
}

function matchesMergedRuntime(event: OutcomeEvent, mergedSha: string): boolean {
  return sameSha(runtimeSha(event), mergedSha) || releaseMatches(event, mergedSha);
}

function releaseMatches(event: OutcomeEvent, mergedSha: string): boolean {
  return sameSha(metadataSha(event, "releaseContainsSha"), mergedSha)
    || sameSha(metadataSha(event, "deployedCommitSha"), mergedSha);
}

function runtimeSha(event: OutcomeEvent): string | undefined {
  if (event.mcpGitSha) return event.mcpGitSha;
  const runtimeIdentity = event.metadata?.runtimeIdentity;
  if (!runtimeIdentity || typeof runtimeIdentity !== "object" || Array.isArray(runtimeIdentity)) return undefined;
  const value = (runtimeIdentity as Record<string, unknown>).mcpGitSha;
  return typeof value === "string" ? value : undefined;
}

function metadataSha(event: OutcomeEvent, key: "releaseContainsSha" | "deployedCommitSha"): string | undefined {
  const value = event.metadata?.[key];
  return typeof value === "string" ? value : undefined;
}

function sameSha(value: string | undefined, expected: string): boolean {
  return typeof value === "string" && value.toLowerCase() === expected.toLowerCase();
}

function emptyComparability(eventCount: number) {
  return comparabilityReportSchema.parse({
    status: "unknown",
    dimensions: [],
    reasons: ["Post-merge data has not been collected yet."],
    confounders: [],
    baselineEventCount: eventCount,
    postMergeEventCount: 0,
    comparableBaselineEventCount: 0,
    comparablePostMergeEventCount: 0,
    excludedPostMergeEventCount: 0
  });
}

const DAY_MS = 24 * 60 * 60 * 1000;
