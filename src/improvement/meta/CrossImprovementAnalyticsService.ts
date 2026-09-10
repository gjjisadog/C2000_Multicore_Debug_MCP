import { randomUUID } from "node:crypto";
import type { Logger } from "../../utils/logger.js";
import { DebugMcpError } from "../../utils/errors.js";
import type { OutcomeEvent, AnalyticsWindow } from "../../analytics/OutcomeSchemas.js";
import type { OutcomeEventStore } from "../../analytics/OutcomeEventRepository.js";
import type { ImprovementProposal, ProposalStatus } from "../ProposalSchemas.js";
import type { ImprovementProposalStore } from "../ProposalRepository.js";
import type { ImprovementImplementationRun } from "../implementation/ImplementationSchemas.js";
import type { ImprovementImplementationRunStore } from "../implementation/ImplementationRunRepository.js";
import type { ImprovementPullRequest, ReviewEvidence } from "../review/ReviewSchemas.js";
import type { ImprovementPullRequestStore, ImprovementReviewEvidenceStore } from "../review/ReviewRepositories.js";
import type { EngineeringPolicyRecommendationStore, CrossImprovementSnapshotStore, EngineeringPolicySnapshotStore } from "./MetaRepositories.js";
import type { PostMergeEvaluation, PostMergeVerdict } from "../evaluation/EvaluationSchemas.js";
import type { PostMergeEvaluationStore } from "../evaluation/EvaluationRepositories.js";
import { ImprovementProposalService, type PolicyRecommendationProposalInput } from "../ImprovementProposalService.js";
import {
  crossImprovementSnapshotSchema,
  engineeringPolicyRecommendationSchema,
  improvementHistoryRecordSchema,
  type CrossImprovementSnapshot,
  type EngineeringPolicyRecommendation,
  type EngineeringPolicySnapshot,
  type ImprovementHistoryRecord,
  type MetaAggregateMetrics,
  type MetaGroupAggregate,
  type MetaRecommendationCategory,
  type MetaRecommendationStatus,
  type OutcomeDistribution,
  type PolicyEvidence,
  type ValidationPredictiveValue,
  type HardwareGateEffectiveness,
  type ValidationStageMetric
} from "./MetaSchemas.js";
import { META_PATTERN_DETECTORS, type MetaRecommendationFinding } from "./MetaPatternDetectors.js";
import { MetaPolicyGuard, type MetaPolicyRecommendationCandidate } from "./MetaPolicyGuard.js";
import { currentEngineeringPolicySnapshot, type EngineeringPolicySnapshotInput } from "./PolicySnapshotService.js";
import { sha256Json } from "../review/ReviewSchemas.js";

/** Meta conclusions require a larger completed-improvement cohort than one ordinary Proposal pattern. */
export const MIN_META_HISTORY_SAMPLE_SIZE = 10;
export const MAX_META_HISTORY_RECORDS = 500;
export const META_POLICY_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;

export interface CrossImprovementAnalyticsOptions {
  proposals: ImprovementProposalStore;
  implementationRuns: ImprovementImplementationRunStore;
  pullRequests: ImprovementPullRequestStore;
  reviewEvidence: ImprovementReviewEvidenceStore;
  evaluations: PostMergeEvaluationStore;
  events: OutcomeEventStore;
  recommendations: EngineeringPolicyRecommendationStore;
  snapshots: CrossImprovementSnapshotStore;
  policySnapshots?: EngineeringPolicySnapshotStore;
  proposalService?: ImprovementProposalService;
  policySnapshot?: EngineeringPolicySnapshot | EngineeringPolicySnapshotInput;
  now?: () => number;
  logger?: Pick<Logger, "info" | "warn">;
}

export interface MetaAnalyticsInput {
  window?: AnalyticsWindow;
  minSampleSize?: number;
  limit?: number;
}

export interface ListEngineeringPolicyRecommendationsInput {
  status?: MetaRecommendationStatus;
  category?: MetaRecommendationCategory;
  target?: string;
  limit?: number;
}

export interface ReviewEngineeringPolicyRecommendationInput {
  recommendationId: string;
  action: "accept" | "reject" | "defer" | "convert-to-proposal";
  reason: string;
  reviewer?: string;
}

export interface CrossImprovementAnalysis {
  snapshot: CrossImprovementSnapshot;
  records: ImprovementHistoryRecord[];
}

/**
 * Round10 meta analytics is deliberately a read model over existing
 * Proposal/Run/PR/Evaluation/Event records. It retains only aggregate
 * snapshots and reviewed recommendations, never a second raw history table.
 */
export class CrossImprovementAnalyticsService {
  private readonly now: () => number;
  private readonly guard = new MetaPolicyGuard();
  private readonly minSampleSize: number;

  constructor(private readonly options: CrossImprovementAnalyticsOptions) {
    this.now = options.now ?? (() => Date.now());
    this.minSampleSize = MIN_META_HISTORY_SAMPLE_SIZE;
  }

  buildHistory(input: { window?: AnalyticsWindow; limit?: number } = {}): ImprovementHistoryRecord[] {
    const window = input.window ?? "retained";
    const nowMs = this.now();
    const bounds = windowBounds(window, nowMs);
    const limit = clampLimit(input.limit ?? MAX_META_HISTORY_RECORDS);
    let proposals: ImprovementProposal[] = [];
    let runs: ImprovementImplementationRun[] = [];
    let pullRequests: ImprovementPullRequest[] = [];
    let evaluations: PostMergeEvaluation[] = [];
    let events: OutcomeEvent[] = [];
    try { proposals = this.options.proposals.list({ limit }); } catch (error) { this.options.logger?.warn("c2000 meta proposal history unavailable", { error: String(error) }); }
    try { runs = this.options.implementationRuns.list({ limit: MAX_META_HISTORY_RECORDS }); } catch (error) { this.options.logger?.warn("c2000 meta implementation history unavailable", { error: String(error) }); }
    try { pullRequests = this.options.pullRequests.list(MAX_META_HISTORY_RECORDS); } catch (error) { this.options.logger?.warn("c2000 meta review history unavailable", { error: String(error) }); }
    try { evaluations = this.options.evaluations.list({ limit: MAX_META_HISTORY_RECORDS }); } catch (error) { this.options.logger?.warn("c2000 meta evaluation history unavailable", { error: String(error) }); }
    try {
      events = this.options.events.list({
        ...(bounds.from ? { from: bounds.from } : {}),
        to: bounds.to,
        limit: 50_000
      });
    } catch (error) {
      this.options.logger?.warn("c2000 meta outcome history unavailable", { error: String(error) });
    }

    return proposals.flatMap(proposal => {
      const record = this.historyRecord(proposal, runs, pullRequests, evaluations, events);
      if (!record || !historyObservedInWindow(proposal, record, runs, pullRequests, evaluations, events, bounds.from, bounds.to)) return [];
      return [record];
    }).slice(0, limit);
  }

  analyze(input: MetaAnalyticsInput = {}): CrossImprovementAnalysis {
    const window = input.window ?? "retained";
    const bounds = windowBounds(window, this.now());
    const records = this.buildHistory({ window, limit: input.limit });
    return this.analyzeRecords(records, bounds.from, bounds.to, input.minSampleSize);
  }

  /** Public pure aggregation entry point for deterministic tests and offline review. */
  analyzeRecords(
    records: readonly ImprovementHistoryRecord[],
    from: string | null = null,
    to = new Date(this.now()).toISOString(),
    requestedMinSampleSize?: number
  ): CrossImprovementAnalysis {
    const normalized = records.map(record => {
      try { return { ...record, validationEscape: record.validationEscape ?? false }; }
      catch { return undefined; }
    }).filter((record): record is ImprovementHistoryRecord => record !== undefined);
    const minimum = normalizeMinimum(requestedMinSampleSize ?? this.minSampleSize);
    const policy = this.policySnapshot(to);
    const metrics = aggregateImprovementHistory(normalized);
    const snapshot = this.createSnapshot(normalized, metrics, from, to, policy, minimum);
    return { snapshot, records: normalized };
  }

  scorecard(input: MetaAnalyticsInput = {}): Record<string, unknown> {
    const analysis = this.analyze(input);
    return {
      historyStatus: analysis.snapshot.historyStatus,
      realHistorySampleSize: analysis.snapshot.evaluatedSampleSize,
      historyRecordCount: analysis.snapshot.sampleSize,
      evaluatedImprovements: analysis.snapshot.metrics.evaluatedImprovements,
      policyRegime: analysis.snapshot.policyRegime,
      engineeringPolicyHash: analysis.snapshot.engineeringPolicyHash,
      metrics: analysis.snapshot.metrics,
      validationPredictiveValue: analysis.snapshot.validationPredictiveValue,
      hardwareGateEffectiveness: analysis.snapshot.hardwareGateEffectiveness,
      confidenceCalibration: analysis.snapshot.confidenceCalibration,
      evidenceSampleOutcome: analysis.snapshot.evidenceSampleOutcome,
      byCategory: analysis.snapshot.byCategory,
      byRisk: analysis.snapshot.byRisk,
      byGenerator: analysis.snapshot.byGenerator,
      byDetector: analysis.snapshot.byDetector,
      byPolicyRegime: analysis.snapshot.byPolicyRegime,
      byProvider: analysis.snapshot.byProvider,
      validationStageEffectiveness: analysis.snapshot.validationStageEffectiveness,
      snapshotId: analysis.snapshot.snapshotId,
      generatedAt: analysis.snapshot.generatedAt,
      recommendationGeneration: analysis.snapshot.historyStatus === "INSUFFICIENT_META_HISTORY"
        ? "INSUFFICIENT_META_HISTORY"
        : "available-via-c2000_generateEngineeringPolicyRecommendations"
    };
  }

  generate(input: MetaAnalyticsInput = {}): Record<string, unknown> {
    const analysis = this.analyze(input);
    this.persistSnapshot(analysis.snapshot);
    if (analysis.snapshot.historyStatus === "INSUFFICIENT_META_HISTORY") {
      return {
        status: "INSUFFICIENT_META_HISTORY",
        historyStatus: analysis.snapshot.historyStatus,
        realHistorySampleSize: analysis.snapshot.evaluatedSampleSize,
        minimumMetaHistorySampleSize: normalizeMinimum(input.minSampleSize ?? this.minSampleSize),
        recommendations: [],
        suppressedRecommendations: [],
        snapshotId: analysis.snapshot.snapshotId,
        metrics: analysis.snapshot.metrics
      };
    }

    const policy = this.policySnapshot(analysis.snapshot.to ?? new Date(this.now()).toISOString());
    const minimum = normalizeMinimum(input.minSampleSize ?? this.minSampleSize);
    const comparableRecords = comparablePolicyRecords(analysis.records, minimum);
    const context = {
      records: comparableRecords,
      metrics: aggregateImprovementHistory(comparableRecords),
      policy,
      minSampleSize: minimum
    };
    const findings = META_PATTERN_DETECTORS.flatMap(detector => detector.detect(context));
    const recommendations: EngineeringPolicyRecommendation[] = [];
    const suppressedRecommendations: Array<Record<string, unknown>> = [];
    const fingerprints = new Set<string>();
    for (const finding of findings) {
      const candidate = this.candidateForFinding(finding);
      const guardResult = this.guard.assess(candidate);
      if (!guardResult.allowed) {
        suppressedRecommendations.push({
          detector: finding.detector,
          category: finding.category,
          target: finding.target,
          reasons: guardResult.reasons,
          suppressedByProtectedPolicy: true
        });
        continue;
      }
      const result = this.upsertRecommendation(finding, analysis.snapshot, policy, fingerprints);
      if (result.recommendation) recommendations.push(result.recommendation);
      if (result.suppressed) suppressedRecommendations.push(result.suppressed);
    }
    return {
      status: "RECOMMENDATIONS_GENERATED",
      historyStatus: analysis.snapshot.historyStatus,
      realHistorySampleSize: analysis.snapshot.evaluatedSampleSize,
      snapshotId: analysis.snapshot.snapshotId,
      policyComparableSampleSize: comparableRecords.length,
      metrics: analysis.snapshot.metrics,
      recommendations,
      suppressedRecommendations,
      counts: {
        generated: recommendations.filter(item => item.createdAt === item.updatedAt).length,
        updated: recommendations.filter(item => item.createdAt !== item.updatedAt).length,
        suppressed: suppressedRecommendations.length,
        detectorsRun: META_PATTERN_DETECTORS.length
      }
    };
  }

  list(input: ListEngineeringPolicyRecommendationsInput = {}): Record<string, unknown> {
    const recommendations = this.options.recommendations.list({
      ...(input.status ? { status: input.status } : {}),
      ...(input.category ? { category: input.category } : {}),
      ...(input.target ? { target: input.target } : {}),
      limit: input.limit
    });
    return {
      recommendations: recommendations.map(recommendationSummary),
      count: recommendations.length,
      automaticExecutionAllowed: false
    };
  }

  get(recommendationId: string): Record<string, unknown> {
    const recommendation = this.options.recommendations.get(recommendationId);
    if (!recommendation) {
      throw new DebugMcpError("EngineeringPolicyRecommendationNotFound", `Engineering policy recommendation not found: ${recommendationId}`, { recommendationId });
    }
    return { recommendation, automaticExecutionAllowed: false };
  }

  review(input: ReviewEngineeringPolicyRecommendationInput): Record<string, unknown> {
    const recommendation = this.options.recommendations.get(input.recommendationId);
    if (!recommendation) {
      throw new DebugMcpError("EngineeringPolicyRecommendationNotFound", `Engineering policy recommendation not found: ${input.recommendationId}`, { recommendationId: input.recommendationId });
    }
    const reason = input.reason.trim();
    if (!reason) {
      throw new DebugMcpError("ProposalReviewReasonRequired", "A review reason is required for every policy recommendation decision", { recommendationId: input.recommendationId });
    }
    const reviewedAt = new Date(this.now()).toISOString();
    if (input.action === "convert-to-proposal") {
      if (!["ready-for-review", "accepted", "deferred"].includes(recommendation.status)) {
        throw new DebugMcpError("EngineeringPolicyRecommendationInvalidState", `Recommendation ${recommendation.recommendationId} cannot convert from ${recommendation.status}`, {
          recommendationId: recommendation.recommendationId,
          status: recommendation.status,
          requiredStatuses: ["ready-for-review", "accepted", "deferred"]
        });
      }
      if (!this.options.proposalService) {
        throw new DebugMcpError("ImprovementAnalyticsUnavailable", "Policy recommendation conversion requires the Improvement Proposal service", { recommendationId: recommendation.recommendationId });
      }
      this.guard.assertAllowed({
        category: recommendation.category,
        target: recommendation.target,
        title: recommendation.title,
        summary: recommendation.summary,
        currentPolicy: recommendation.currentPolicy,
        recommendedPolicyChange: recommendation.recommendedPolicyChange,
        expectedEffect: recommendation.expectedEffect,
        risks: recommendation.risks
      });
      const proposal = this.options.proposalService.createPolicyRecommendationProposal(toProposalInput(recommendation));
      const converted = engineeringPolicyRecommendationSchema.parse({
        ...recommendation,
        status: "converted-to-proposal",
        convertedProposalId: proposal.proposalId,
        updatedAt: reviewedAt,
        reviewedAt,
        ...(input.reviewer ? { reviewedBy: input.reviewer } : {}),
        reviewReason: reason,
        automaticExecutionAllowed: false
      });
      this.options.recommendations.upsert(converted);
      return { recommendation: converted, proposal, converted: true, executesAutomatically: false };
    }
    if (!["ready-for-review", "accepted", "deferred"].includes(recommendation.status)) {
      throw new DebugMcpError("EngineeringPolicyRecommendationInvalidState", `Recommendation ${recommendation.recommendationId} cannot be reviewed from ${recommendation.status}`, {
        recommendationId: recommendation.recommendationId,
        status: recommendation.status
      });
    }
    const status: MetaRecommendationStatus = input.action === "accept" ? "accepted" : input.action === "reject" ? "rejected" : "deferred";
    const reviewed = engineeringPolicyRecommendationSchema.parse({
      ...recommendation,
      status,
      updatedAt: reviewedAt,
      reviewedAt,
      ...(input.reviewer ? { reviewedBy: input.reviewer } : {}),
      reviewReason: reason,
      automaticExecutionAllowed: false
    });
    this.options.recommendations.upsert(reviewed);
    return { recommendation: reviewed, decision: input.action, executesAutomatically: false };
  }

  private historyRecord(
    proposal: ImprovementProposal,
    runs: ImprovementImplementationRun[],
    pullRequests: ImprovementPullRequest[],
    evaluations: PostMergeEvaluation[],
    events: OutcomeEvent[]
  ): ImprovementHistoryRecord | undefined {
    const proposalRuns = runs.filter(run => run.proposalId === proposal.proposalId);
    const pullRequest = pullRequests.find(pr => pr.proposalId === proposal.proposalId);
    const evaluation = evaluations
      .filter(item => item.proposalId === proposal.proposalId || (pullRequest ? item.pullRequestId === pullRequest.pullRequestId : false))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    const evidence = pullRequest ? safeReviewEvidence(this.options.reviewEvidence, pullRequest) : undefined;
    const relatedEvents = events.filter(event => eventMatchesProposal(event, proposal.proposalId, pullRequest?.pullRequestId));
    const context = proposal.evidence.context ?? {};
    const lastRun = [...proposalRuns].sort((left, right) => (right.finishedAt ?? right.createdAt).localeCompare(left.finishedAt ?? left.createdAt))[0];
    const validationVerdict = lastRun?.validationResult?.verdict ?? validationVerdictFromCommands(lastRun) ?? proposal.validationResult?.verdict;
    const preMergeValidationPassed = validationVerdict === "improved"
      || (validationVerdict === undefined && (lastRun?.status === "candidate-ready" || lastRun?.status === "validated"));
    const hardwareValidationVerdict = evidence?.hardwareEvidence?.verdict ?? eventHardwareVerdict(relatedEvents);
    const merged = Boolean(
      proposal.status === "merged"
      || pullRequest?.status === "merged-externally"
      || pullRequest?.mergedCommitSha
      || pullRequest?.mergedAt
    );
    const mergedAt = pullRequest?.mergedAt ?? (evaluation?.mergedAt);
    const evaluationFinalOutcome = proposal.finalOutcome ?? finalOutcomeFromEvaluation(evaluation);
    const validationEscape = Boolean(merged && preMergeValidationPassed && evaluationFinalOutcome === "verified-regression");
    const reviewRounds = (pullRequest?.revisionHistory.length ?? 0) + relatedEvents.filter(event => event.kind === "review_feedback").length;
    const revisionCount = Math.max(
      proposalRuns.filter(run => run.runKind === "revision").length,
      pullRequest?.revisionHistory.length ?? 0
    );
    const policyHash = proposal.engineeringPolicyHash ?? context.engineeringPolicyHash;
    const policyRegime = proposal.policyRegime ?? context.policyRegime ?? "legacy";
    const record = {
      proposalId: proposal.proposalId,
      proposalStatus: proposal.status,
      category: proposal.category,
      target: proposal.target,
      risk: proposal.risks[0]?.level ?? "high",
      generatedBy: proposal.generatedBy,
      ...(context.detector || context.sourceDetector ? { detector: context.detector ?? context.sourceDetector } : {}),
      evidenceSampleCount: Math.max(proposal.evidence.matchingRuns, proposal.evidence.affectedRuns),
      proposalConfidence: proposal.confidence,
      implementationMode: proposal.proposedChange.implementationMode,
      implementationRunCount: proposalRuns.length,
      agentAttemptCount: proposalRuns.reduce((sum, run) => sum + run.agentAttempts, 0),
      revisionCount,
      ...(validationVerdict ? { localValidationVerdict: validationVerdict } : {}),
      ...(lastRun?.validationCommands && lastRun.validationCommands.length > 0
        ? { validationStages: lastRun.validationCommands.map(command => ({
          stage: command.stage,
          status: command.status,
          ...(command.durationMs === undefined ? {} : { durationMs: command.durationMs })
        })) }
        : {}),
      ...(validationVerdict ? { preMergeValidationPassed } : {}),
      hardwareRequired: proposal.validationPlan.hardwareRequired,
      ...(hardwareValidationVerdict ? { hardwareValidationVerdict } : {}),
      ...(evidence?.reviews ? { reviewPassedBeforeMerge: evidence.reviews.status === "pass" && !evidence.reviews.changesRequested } : {}),
      prReviewRounds: reviewRounds,
      merged,
      ...(mergedAt ? { mergedAt } : {}),
      ...(evaluationFinalOutcome ? { finalOutcome: evaluationFinalOutcome } : {}),
      ...(evaluation ? { postMergeEffect: postMergeEffect(evaluation), evaluationId: evaluation.evaluationId } : {}),
      ...(evaluation ? { rollbackRecommended: Boolean(evaluation.rollbackRecommendationId) } : {}),
      validationEscape,
      ...(candidateTime(proposal, proposalRuns) === undefined ? {} : { timeToCandidateMs: candidateTime(proposal, proposalRuns) }),
      ...(mergedAt ? { timeToMergeMs: elapsedMs(proposal.createdAt, mergedAt) } : {}),
      ...(evaluation ? { timeToFinalEvaluationMs: elapsedMs(proposal.createdAt, evaluation.updatedAt) } : {}),
      policyRegime,
      ...(policyHash ? { engineeringPolicyHash: policyHash } : {}),
      ...(context.toolUsageCount !== undefined ? { toolUsageCount: nonnegativeInteger(context.toolUsageCount) } : {}),
      ...(proposal.evidence.schemaCostBytes !== undefined
        ? { schemaCostBytes: proposal.evidence.schemaCostBytes }
        : context.schemaCostBytes !== undefined ? { schemaCostBytes: nonnegativeInteger(context.schemaCostBytes) } : {}),
      ...(context.workflowCovered !== undefined ? { workflowCovered: context.workflowCovered === "true" } : {}),
      ...(context.capabilityName ?? context.capability ? { capabilityName: context.capabilityName ?? context.capability } : {}),
      ...(lastRun?.agentProvider || lastRun?.codingAgentResult?.provider
        ? { provider: lastRun.agentProvider ?? lastRun.codingAgentResult?.provider } : {})
    };
    try { return requireHistoryRecord(record); } catch (error) {
      this.options.logger?.warn("c2000 meta history record skipped", { proposalId: proposal.proposalId, error: String(error) });
      return undefined;
    }
  }

  private createSnapshot(
    records: ImprovementHistoryRecord[],
    metrics: MetaAggregateMetrics,
    from: string | null,
    to: string,
    policy: EngineeringPolicySnapshot,
    minSampleSize: number
  ): CrossImprovementSnapshot {
    // A meta conclusion must be grounded in a completed post-merge outcome.
    // Do not let an accidentally populated finalOutcome on an unmerged
    // Proposal satisfy the higher-order history floor.
    const evaluatedSampleSize = records.filter(record => record.merged && record.finalOutcome !== undefined).length;
    const historyStatus = evaluatedSampleSize >= minSampleSize ? "READY" as const : "INSUFFICIENT_META_HISTORY" as const;
    return crossImprovementSnapshotSchema.parse({
      snapshotId: `meta-${this.now().toString(36)}-${randomUUID().slice(0, 8)}`,
      generatedAt: new Date(this.now()).toISOString(),
      from,
      to,
      policyRegime: policy.policyRegime,
      engineeringPolicyHash: policy.engineeringPolicyHash,
      historyStatus,
      sampleSize: records.length,
      evaluatedSampleSize,
      metrics,
      byCategory: groupAggregates(records, record => record.category),
      byRisk: groupAggregates(records, record => record.risk),
      byGenerator: groupAggregates(records, record => record.generatedBy),
      byDetector: groupAggregates(records, record => record.detector ?? "unspecified"),
      byPolicyRegime: groupAggregates(records, record => record.policyRegime),
      byProvider: groupAggregates(records, record => record.provider ?? "unspecified"),
      confidenceCalibration: groupAggregates(records.filter(record => record.proposalConfidence !== undefined), record => confidenceBucket(record.proposalConfidence!)),
      evidenceSampleOutcome: groupAggregates(records, record => evidenceBucket(record.evidenceSampleCount)),
      validationPredictiveValue: validationPredictiveValue(records),
      hardwareGateEffectiveness: hardwareGateEffectiveness(records),
      validationStageEffectiveness: validationStageMetrics(records),
      toolSurfaceEffectiveness: aggregateImprovementHistory(records.filter(record => record.category === "tool-surface")),
      capabilityEffectiveness: aggregateImprovementHistory(records.filter(record => record.category === "capability")),
      workflowEffectiveness: aggregateImprovementHistory(records.filter(record => record.category === "workflow")),
      confounders: [
        "Historical associations do not establish causality.",
        ...(records.some(record => record.finalOutcome === "inconclusive") ? ["Some outcomes remain confounded by deployment, identity, or comparability."] : [])
      ]
    });
  }

  private persistSnapshot(snapshot: CrossImprovementSnapshot): void {
    try { this.options.snapshots.append(snapshot); } catch (error) { this.options.logger?.warn("c2000 meta snapshot persistence failed", { error: String(error) }); }
    try { this.options.policySnapshots?.upsert(this.policySnapshot(snapshot.generatedAt)); } catch (error) { this.options.logger?.warn("c2000 policy snapshot persistence failed", { error: String(error) }); }
  }

  private policySnapshot(capturedAt: string): EngineeringPolicySnapshot {
    const input = this.options.policySnapshot;
    if (input && "snapshotId" in input && "engineeringPolicyHash" in input) return input as EngineeringPolicySnapshot;
    return currentEngineeringPolicySnapshot({ ...(input ?? {}), capturedAt });
  }

  private candidateForFinding(finding: MetaRecommendationFinding): MetaPolicyRecommendationCandidate {
    return {
      category: finding.category,
      target: finding.target,
      title: finding.title,
      summary: finding.summary,
      currentPolicy: finding.currentPolicy,
      recommendedPolicyChange: finding.recommendedPolicyChange,
      expectedEffect: finding.expectedEffect,
      risks: finding.risks
    };
  }

  private upsertRecommendation(
    finding: MetaRecommendationFinding,
    snapshot: CrossImprovementSnapshot,
    policy: EngineeringPolicySnapshot,
    seenFingerprints: Set<string>
  ): { recommendation?: EngineeringPolicyRecommendation; suppressed?: Record<string, unknown> } {
    const fingerprint = sha256Json({
      category: finding.category,
      target: finding.target,
      currentPolicy: finding.currentPolicy,
      recommendedPolicyChange: finding.recommendedPolicyChange,
      policyRegime: policy.policyRegime,
      engineeringPolicyHash: policy.engineeringPolicyHash
    });
    if (seenFingerprints.has(fingerprint)) return {};
    seenFingerprints.add(fingerprint);
    const sampleRecords = finding.sampleRecords.slice(0, 64);
    const evidence: PolicyEvidence = {
      sampleSize: sampleRecords.length,
      timeWindow: { from: snapshot.from, to: snapshot.to },
      proposalCategory: mostCommon(sampleRecords.map(record => record.category)) ?? "mixed",
      currentPolicyRegime: policy.policyRegime,
      finalOutcomeDistribution: outcomeDistribution(sampleRecords),
      validationEscapeCount: sampleRecords.filter(record => record.validationEscape).length,
      effectSize: finding.effectSize,
      relevantProposalIds: sampleRecords.map(record => record.proposalId).slice(0, 64),
      relevantEvaluationIds: sampleRecords.flatMap(record => record.evaluationId ? [record.evaluationId] : []).slice(0, 64),
      confounders: finding.confounders.slice(0, 64)
    };
    const nowIso = new Date(this.now()).toISOString();
    const recommendationId = `meta-${fingerprint.slice(0, 28)}`;
    const existing = this.options.recommendations.findByFingerprint(fingerprint);
    if (existing && existing.status === "rejected" && !materialEvidenceChange(existing, evidence)) {
      return { suppressed: { recommendationId: existing.recommendationId, target: finding.target, reason: "Rejected recommendation has no material evidence change." } };
    }
    const sameTarget = this.options.recommendations.list({ category: finding.category, target: finding.target, limit: 500 })
      .filter(item => item.fingerprint !== fingerprint && item.policyRegime === policy.policyRegime && ["accepted", "converted-to-proposal"].includes(item.status));
    const recentOpposite = sameTarget.find(item => this.now() - Date.parse(item.updatedAt) < META_POLICY_COOLDOWN_MS);
    if (recentOpposite && !criticalSafetyException(finding)) {
      return { suppressed: { target: finding.target, category: finding.category, reason: "Policy cooldown/oscillation guard suppressed a reverse or competing recommendation.", supersededRecommendationId: recentOpposite.recommendationId } };
    }
    const recommendation = engineeringPolicyRecommendationSchema.parse({
      ...(existing ?? {
        recommendationId,
        fingerprint,
        createdAt: nowIso
      }),
      updatedAt: nowIso,
      lastObservedAt: nowIso,
      category: finding.category,
      target: finding.target,
      title: finding.title,
      summary: finding.summary,
      evidence,
      currentPolicy: finding.currentPolicy,
      recommendedPolicyChange: finding.recommendedPolicyChange,
      expectedEffect: finding.expectedEffect,
      risks: finding.risks,
      confidence: recommendationConfidence(sampleRecords.length, finding.effectSize, sampleRecords),
      sampleSize: sampleRecords.length,
      policyRegime: policy.policyRegime,
      engineeringPolicyHash: policy.engineeringPolicyHash,
      detector: finding.detector,
      status: existing?.status === "rejected" ? "ready-for-review" : existing?.status ?? "ready-for-review",
      automaticExecutionAllowed: false,
      ...(existing?.reviewedAt && existing.status !== "rejected" ? { reviewedAt: existing.reviewedAt } : {}),
      ...(existing?.reviewedBy && existing.status !== "rejected" ? { reviewedBy: existing.reviewedBy } : {}),
      ...(existing?.reviewReason && existing.status !== "rejected" ? { reviewReason: existing.reviewReason } : {}),
      ...(existing?.convertedProposalId ? { convertedProposalId: existing.convertedProposalId } : {})
    });
    this.options.recommendations.upsert(recommendation);
    return { recommendation };
  }
}

export function aggregateImprovementHistory(records: readonly ImprovementHistoryRecord[]): MetaAggregateMetrics {
  const values = [...records];
  const evaluated = values.filter(record => record.merged && record.finalOutcome !== undefined);
  const mergedEvaluated = evaluated;
  const readyForReview = values.filter(record => record.proposalStatus !== undefined && record.proposalStatus !== "draft").length;
  const approved = values.filter(record => isApprovedOrLater(record.proposalStatus)).length;
  const implemented = values.filter(record => record.implementationRunCount > 0).length;
  const candidateReady = values.filter(record => isCandidateReadyOrLater(record.proposalStatus)).length;
  const merged = values.filter(record => record.merged).length;
  const distribution = outcomeDistribution(evaluated);
  const rollbackRecommended = values.filter(record => record.merged && (record.rollbackRecommended || record.finalOutcome === "rolled-back")).length;
  return {
    sampleSize: values.length,
    evaluatedImprovements: evaluated.length,
    readyForReview,
    approved,
    implemented,
    candidateReady,
    merged,
    proposalYield: rate(approved, readyForReview),
    implementationYield: rate(candidateReady, approved),
    mergeYield: rate(merged, candidateReady),
    verifiedImprovementYield: rate(distribution["verified-improvement"], mergedEvaluated.length),
    regressionRate: rate(distribution["verified-regression"], mergedEvaluated.length),
    neutralRate: rate(distribution["no-observable-benefit"], mergedEvaluated.length),
    inconclusiveRate: rate(distribution.inconclusive, evaluated.length),
    rollbackRecommendationRate: rate(rollbackRecommended, merged || 0),
    validationEscapeRate: rate(values.filter(record => record.validationEscape && record.merged && record.finalOutcome !== undefined).length, mergedEvaluated.length),
    revisionBurden: burden(values.map(record => record.revisionCount)),
    agentRepairBurden: burden(values.map(record => Math.max(0, record.agentAttemptCount - record.implementationRunCount))),
    outcomeDistribution: distribution,
    medianTimeToCandidateMs: medianDefined(values.map(record => record.timeToCandidateMs)),
    medianTimeToMergeMs: medianDefined(values.map(record => record.timeToMergeMs)),
    medianTimeToFinalEvaluationMs: medianDefined(values.map(record => record.timeToFinalEvaluationMs))
  };
}

function validationPredictiveValue(records: readonly ImprovementHistoryRecord[]): ValidationPredictiveValue {
  const validated = records.filter(record => record.preMergeValidationPassed === true && record.merged && record.finalOutcome !== undefined);
  const regressions = validated.filter(record => record.finalOutcome === "verified-regression");
  const escapes = records.filter(record => record.validationEscape);
  const reviewEscapes = records.filter(record => record.validationEscape && record.reviewPassedBeforeMerge === true);
  return {
    preMergeValidated: validated.length,
    postMergeRegressionsAfterValidation: regressions.length,
    predictiveValue: rate(validated.length - regressions.length, validated.length),
    validationEscapeCount: escapes.length,
    reviewEscapeCount: reviewEscapes.length,
    stageMetrics: validationStageMetrics(records)
  };
}

function hardwareGateEffectiveness(records: readonly ImprovementHistoryRecord[]): HardwareGateEffectiveness {
  const required = records.filter(record => record.hardwareRequired === true);
  const notRequiredFailures = records.filter(record => record.hardwareRequired === false && record.hardwareValidationVerdict === "failed");
  const failed = required.filter(record => record.hardwareValidationVerdict === "failed");
  const passed = required.filter(record => record.hardwareValidationVerdict === "passed");
  const postMergeRegression = passed.filter(record => record.finalOutcome === "verified-regression");
  const postMergeRegressionAfterFailure = notRequiredFailures.filter(record => record.merged && record.finalOutcome === "verified-regression");
  return {
    hardwareRequired: required.length,
    hardwareFailedBeforeMerge: failed.length,
    hardwareCaughtRegressionBeforeMerge: failed.filter(record => !record.merged).length,
    hardwarePassed: passed.length,
    postMergeRegressionAfterHardwarePass: postMergeRegression.length,
    predictiveValue: rate(passed.length - postMergeRegression.length, passed.length),
    hardwareNotRequiredFailures: notRequiredFailures.length,
    postMergeRegressionAfterHardwareFailure: postMergeRegressionAfterFailure.length
  };
}

function validationStageMetrics(records: readonly ImprovementHistoryRecord[]): ValidationStageMetric[] {
  const grouped = new Map<string, Array<{ status: "passed" | "failed" | "not-run"; durationMs?: number; regressionAfterPass: boolean }>>();
  for (const record of records) {
    for (const stage of record.validationStages ?? []) {
      const values = grouped.get(stage.stage) ?? [];
      values.push({
        status: stage.status,
        ...(stage.durationMs === undefined ? {} : { durationMs: stage.durationMs }),
        regressionAfterPass: stage.status === "passed" && record.merged && record.finalOutcome === "verified-regression"
      });
      grouped.set(stage.stage, values);
    }
  }
  return [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([stage, values]) => {
    const passed = values.filter(value => value.status === "passed").length;
    const failed = values.filter(value => value.status === "failed").length;
    const notRun = values.filter(value => value.status === "not-run").length;
    const durations = values.flatMap(value => value.durationMs === undefined ? [] : [value.durationMs]);
    const regressions = values.filter(value => value.regressionAfterPass).length;
    return {
      stage,
      sampleSize: values.length,
      passed,
      failed,
      notRun,
      preMergeFailureRate: rate(failed, values.length),
      postMergeRegressionsAfterPass: regressions,
      predictiveValue: rate(passed - regressions, passed),
      totalDurationMs: durations.reduce((sum, value) => sum + value, 0),
      medianDurationMs: durations.length > 0 ? median(durations) : null,
      p95DurationMs: durations.length > 0 ? percentile(durations, 0.95) : null
    };
  });
}

function groupAggregates(records: readonly ImprovementHistoryRecord[], keyOf: (record: ImprovementHistoryRecord) => string): MetaGroupAggregate[] {
  const groups = new Map<string, ImprovementHistoryRecord[]>();
  for (const record of records) {
    const key = keyOf(record);
    const group = groups.get(key) ?? [];
    group.push(record);
    groups.set(key, group);
  }
  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, group]) => ({ key, metrics: aggregateImprovementHistory(group) }));
}

function outcomeDistribution(records: readonly ImprovementHistoryRecord[]): OutcomeDistribution {
  const result: OutcomeDistribution = {
    "verified-improvement": 0,
    "no-observable-benefit": 0,
    "verified-regression": 0,
    inconclusive: 0,
    "rolled-back": 0,
    superseded: 0
  };
  for (const record of records) if (record.finalOutcome) result[record.finalOutcome] += 1;
  return result;
}

function burden(values: number[]): { total: number; recordsWithBurden: number; average: number; median: number; p95: number } {
  const normalized = values.map(value => Math.max(0, Number.isFinite(value) ? value : 0));
  const total = normalized.reduce((sum, value) => sum + value, 0);
  const positive = normalized.filter(value => value > 0);
  return {
    total,
    recordsWithBurden: positive.length,
    average: normalized.length === 0 ? 0 : total / normalized.length,
    median: median(normalized),
    p95: percentile(normalized, 0.95)
  };
}

function rate(numerator: number, denominator: number): { numerator: number; denominator: number; rate: number } {
  const safeNumerator = Math.max(0, Math.trunc(numerator));
  const safeDenominator = Math.max(0, Math.trunc(denominator));
  return { numerator: safeNumerator, denominator: safeDenominator, rate: safeDenominator === 0 ? 0 : Math.min(1, safeNumerator / safeDenominator) };
}

function medianDefined(values: Array<number | undefined>): number | null {
  const defined = values.filter((value): value is number => value !== undefined && Number.isFinite(value));
  return defined.length === 0 ? null : median(defined);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0 ? (ordered[middle - 1] + ordered[middle]) / 2 : ordered[middle];
}

function percentile(values: number[], quantile: number): number {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.max(0, Math.ceil(ordered.length * quantile) - 1))];
}

function confidenceBucket(value: number): string { return value < 0.5 ? "low" : value < 0.8 ? "medium" : "high"; }
function evidenceBucket(value: number): string {
  if (value < 10) return "0-9";
  if (value < 20) return "10-19";
  if (value < 30) return "20-29";
  if (value < 50) return "30-49";
  return "50+";
}
function mostCommon(values: string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0];
}
function isApprovedOrLater(status: ProposalStatus | undefined): boolean {
  return status !== undefined && ["approved", "implementation-queued", "implementing", "validation-pending", "candidate-ready", "validated", "pr-open", "merge-recommended", "merged", "failed", "closed-without-merge"].includes(status);
}
function isCandidateReadyOrLater(status: ProposalStatus | undefined): boolean {
  return status !== undefined && ["candidate-ready", "validated", "pr-open", "merge-recommended", "merged"].includes(status);
}
function recommendationConfidence(sampleSize: number, effectSize: number, records: readonly ImprovementHistoryRecord[]): number {
  const sampleFactor = Math.min(1, sampleSize / 20);
  const consistency = records.length === 0 ? 0 : Math.max(0, records.filter(record => record.finalOutcome !== "inconclusive").length / records.length);
  return Math.max(0, Math.min(1, 0.25 + 0.35 * sampleFactor + 0.25 * Math.min(1, Math.abs(effectSize)) + 0.15 * consistency));
}
function recommendationSummary(recommendation: EngineeringPolicyRecommendation): Record<string, unknown> {
  return {
    recommendationId: recommendation.recommendationId,
    category: recommendation.category,
    target: recommendation.target,
    title: recommendation.title,
    summary: recommendation.summary,
    confidence: recommendation.confidence,
    sampleSize: recommendation.sampleSize,
    policyRegime: recommendation.policyRegime,
    detector: recommendation.detector,
    status: recommendation.status,
    automaticExecutionAllowed: false,
    createdAt: recommendation.createdAt,
    updatedAt: recommendation.updatedAt,
    convertedProposalId: recommendation.convertedProposalId
  };
}
function materialEvidenceChange(previous: EngineeringPolicyRecommendation, next: PolicyEvidence): boolean {
  const previousDistribution = JSON.stringify(previous.evidence.finalOutcomeDistribution);
  const nextDistribution = JSON.stringify(next.finalOutcomeDistribution);
  return next.sampleSize >= Math.max(previous.sampleSize + 2, Math.ceil(previous.sampleSize * 1.5)) || previousDistribution !== nextDistribution || next.validationEscapeCount > previous.evidence.validationEscapeCount;
}
function criticalSafetyException(finding: MetaRecommendationFinding): boolean {
  const text = `${finding.target} ${finding.title} ${finding.summary}`.toLowerCase();
  return /safety|flash|lease|fenc|target mutation|hardware/.test(text) && finding.sampleRecords.some(record => record.finalOutcome === "verified-regression");
}
function toProposalInput(recommendation: EngineeringPolicyRecommendation): PolicyRecommendationProposalInput {
  return {
    recommendationId: recommendation.recommendationId,
    category: recommendation.category,
    target: recommendation.target,
    title: recommendation.title,
    summary: recommendation.summary,
    evidence: {
      sampleSize: recommendation.evidence.sampleSize,
      currentPolicyRegime: recommendation.evidence.currentPolicyRegime,
      validationEscapeCount: recommendation.evidence.validationEscapeCount,
      effectSize: recommendation.evidence.effectSize,
      relevantProposalIds: recommendation.evidence.relevantProposalIds,
      relevantEvaluationIds: recommendation.evidence.relevantEvaluationIds,
      confounders: recommendation.evidence.confounders
    },
    currentPolicy: recommendation.currentPolicy,
    recommendedPolicyChange: recommendation.recommendedPolicyChange,
    expectedEffect: recommendation.expectedEffect,
    risks: recommendation.risks,
    confidence: recommendation.confidence,
    engineeringPolicyHash: recommendation.engineeringPolicyHash,
    policyRegime: recommendation.policyRegime
  };
}

function safeReviewEvidence(store: ImprovementReviewEvidenceStore, pullRequest: ImprovementPullRequest): ReviewEvidence | undefined {
  try { return store.getLatest(pullRequest.pullRequestId, pullRequest.candidateSha); } catch { return undefined; }
}
function eventMatchesProposal(event: OutcomeEvent, proposalId: string, pullRequestId?: string): boolean {
  const metadata = event.metadata && typeof event.metadata === "object" && !Array.isArray(event.metadata) ? event.metadata as Record<string, unknown> : {};
  return metadata.proposalId === proposalId || metadata.sourceProposalId === proposalId || (pullRequestId !== undefined && (metadata.reviewPullRequestId === pullRequestId || metadata.revisionPullRequestId === pullRequestId));
}
function eventHardwareVerdict(events: OutcomeEvent[]): "passed" | "failed" | "inconclusive" | undefined {
  for (const event of [...events].reverse()) {
    const metadata = event.metadata && typeof event.metadata === "object" && !Array.isArray(event.metadata) ? event.metadata as Record<string, unknown> : {};
    const value = metadata.hardwareVerdict ?? metadata.hardwareStatus;
    if (value === "passed" || value === "failed" || value === "inconclusive") return value;
  }
  return undefined;
}
function validationVerdictFromCommands(run: ImprovementImplementationRun | undefined): PostMergeVerdict | undefined {
  const commands = run?.validationCommands;
  if (!commands || commands.length === 0) return undefined;
  if (commands.some(command => command.status === "failed")) return "regressed";
  if (commands.every(command => command.status === "passed")) return "improved";
  return "inconclusive";
}
function finalOutcomeFromEvaluation(evaluation: PostMergeEvaluation | undefined): ImprovementHistoryRecord["finalOutcome"] | undefined {
  if (!evaluation || !["evaluated", "closed"].includes(evaluation.lifecycleStatus) || !evaluation.verdict) return undefined;
  if (evaluation.verdict === "improved") return "verified-improvement";
  if (evaluation.verdict === "neutral") return "no-observable-benefit";
  if (evaluation.verdict === "regressed") return "verified-regression";
  return "inconclusive";
}
function postMergeEffect(evaluation: PostMergeEvaluation): Record<string, number> {
  if (!evaluation.postMergeMetrics) return {};
  const baseline = new Map(evaluation.baselineMetrics.metrics.map(metric => [metric.name, metric.value]));
  const effect: Record<string, number> = {};
  for (const metric of evaluation.postMergeMetrics.metrics) {
    const before = baseline.get(metric.name);
    if (before === null || before === undefined || metric.value === null) continue;
    effect[metric.name] = metric.value - before;
  }
  return effect;
}
function candidateTime(proposal: ImprovementProposal, runs: ImprovementImplementationRun[]): number | undefined {
  const candidate = runs.find(run => Boolean(run.candidateCommitSha) || ["candidate-ready", "validated"].includes(run.status));
  return candidate ? elapsedMs(proposal.createdAt, candidate.finishedAt ?? candidate.createdAt) : undefined;
}
function elapsedMs(start: string, end: string): number | undefined {
  const value = Date.parse(end) - Date.parse(start);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}
function nonnegativeInteger(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : 0;
}
function requireHistoryRecord(value: unknown): ImprovementHistoryRecord {
  return improvementHistoryRecordSchema.parse(value);
}
function normalizeMinimum(value: number): number {
  if (!Number.isFinite(value)) return MIN_META_HISTORY_SAMPLE_SIZE;
  return Math.max(MIN_META_HISTORY_SAMPLE_SIZE, Math.min(MAX_META_HISTORY_RECORDS, Math.trunc(value)));
}
function clampLimit(value: number): number { return Math.max(1, Math.min(MAX_META_HISTORY_RECORDS, Math.trunc(value))); }

function historyObservedInWindow(
  proposal: ImprovementProposal,
  record: ImprovementHistoryRecord,
  runs: readonly ImprovementImplementationRun[],
  pullRequests: readonly ImprovementPullRequest[],
  evaluations: readonly PostMergeEvaluation[],
  events: readonly OutcomeEvent[],
  from: string | null,
  to: string
): boolean {
  if (from === null) return true;
  const pullRequest = pullRequests.find(item => item.proposalId === proposal.proposalId);
  const timestamps = [proposal.createdAt, proposal.updatedAt, proposal.lastObservedAt, record.mergedAt];
  timestamps.push(...runs
    .filter(run => run.proposalId === proposal.proposalId)
    .flatMap(run => [run.createdAt, run.startedAt, run.finishedAt]));
  timestamps.push(...evaluations
    .filter(item => item.proposalId === proposal.proposalId || (pullRequest ? item.pullRequestId === pullRequest.pullRequestId : false))
    .flatMap(item => [item.createdAt, item.updatedAt, item.mergedAt]));
  timestamps.push(...events
    .filter(event => eventMatchesProposal(event, proposal.proposalId, pullRequest?.pullRequestId))
    .map(event => event.timestamp));
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  return timestamps.some(timestamp => {
    if (!timestamp) return false;
    const value = Date.parse(timestamp);
    return Number.isFinite(value) && value >= fromMs && value <= toMs;
  });
}

/** Do not compare outcomes from different policy hashes in one detector cohort. */
function comparablePolicyRecords(records: readonly ImprovementHistoryRecord[], minimum: number): ImprovementHistoryRecord[] {
  const evaluated = records.filter(record => record.merged && record.finalOutcome !== undefined);
  const groups = new Map<string, ImprovementHistoryRecord[]>();
  for (const record of evaluated) {
    const key = `${record.policyRegime}:${record.engineeringPolicyHash ?? "legacy"}`;
    const group = groups.get(key) ?? [];
    group.push(record);
    groups.set(key, group);
  }
  if (groups.size <= 1) return [...evaluated];
  const largest = [...groups.entries()]
    .sort(([leftKey, left], [rightKey, right]) => right.length - left.length || leftKey.localeCompare(rightKey))[0];
  return largest && largest[1].length >= minimum ? [...largest[1]] : [];
}

function windowBounds(window: AnalyticsWindow, nowMs: number): { from: string | null; to: string } {
  const to = new Date(nowMs).toISOString();
  if (window === "retained") return { from: null, to };
  const duration = window === "24h" ? 24 * 60 * 60 * 1000 : window === "7d" ? 7 * 24 * 60 * 60 * 1000 : 30 * 24 * 60 * 60 * 1000;
  return { from: new Date(nowMs - duration).toISOString(), to };
}
