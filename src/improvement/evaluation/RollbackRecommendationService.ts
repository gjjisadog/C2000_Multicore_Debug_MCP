import { randomUUID } from "node:crypto";
import type { ImprovementProposalStore } from "../ProposalRepository.js";
import { sha256Json } from "../review/ReviewSchemas.js";
import {
  improvementProposalSchema,
  type ImprovementProposal
} from "../ProposalSchemas.js";
import {
  rollbackRecommendationSchema,
  type PostMergeEvaluation,
  type RollbackRecommendation,
  type RollbackRecommendationStatus
} from "./EvaluationSchemas.js";
import type { RollbackRecommendationStore } from "./EvaluationRepositories.js";
import type { Logger } from "../../utils/logger.js";
import { DebugMcpError } from "../../utils/errors.js";

export type RollbackReviewAction = "acknowledge" | "reject" | "convert-to-proposal" | "resolve";

export interface RollbackRecommendationServiceOptions {
  recommendations: RollbackRecommendationStore;
  proposals: ImprovementProposalStore;
  now?: () => number;
  logger?: Pick<Logger, "info" | "warn">;
}

/** Governance-only rollback recommendations. It never performs rollback. */
export class RollbackRecommendationService {
  private readonly now: () => number;

  constructor(private readonly options: RollbackRecommendationServiceOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  createForEvaluation(evaluation: PostMergeEvaluation): RollbackRecommendation | undefined {
    if (evaluation.verdict !== "regressed" || evaluation.regressions.length === 0) return undefined;
    const existing = this.options.recommendations.getForEvaluation(evaluation.evaluationId);
    if (existing) return existing;
    const proposal = this.options.proposals.get(evaluation.proposalId);
    const timestamp = new Date(this.now()).toISOString();
    const severity = evaluation.regressions.some(item => item.severity === "critical") ? "critical" : evaluation.regressions.some(item => item.severity === "significant") ? "strong" : "advisory";
    const target = rollbackTarget(proposal);
    const recommendation = rollbackRecommendationSchema.parse({
      recommendationId: `rollback-${randomUUID()}`,
      evaluationId: evaluation.evaluationId,
      proposalId: evaluation.proposalId,
      mergedCommitSha: evaluation.mergedCommitSha,
      severity,
      reasons: [
        ...evaluation.regressions.map(finding => finding.evidence),
        ...evaluation.confounders.map(value => `Confounder requiring human review: ${value}`)
      ].slice(0, 64),
      affectedMetrics: evaluation.regressions.map(finding => finding.metric).slice(0, 64),
      findings: evaluation.regressions,
      target,
      action: target === "revert-improvement"
        ? "A human maintainer should assess a revert of the merged improvement against current production state; this MCP will not execute it."
        : target === "disable-feature"
          ? "A human maintainer may disable the existing feature flag after reviewing evidence; no feature flag operation is available here."
          : "Open a normal human-reviewed follow-up Proposal or manual investigation; do not infer causation from this evidence.",
      status: "open",
      rollbackSafety: target === "revert-improvement" && proposal?.category !== "tool-surface" && proposal?.category !== "capability" ? "requires-review" : "unknown",
      automaticExecutionAllowed: false,
      createdAt: timestamp,
      updatedAt: timestamp
    });
    this.options.recommendations.upsert(recommendation);
    this.options.logger?.warn("c2000 post-merge rollback recommendation opened", {
      recommendationId: recommendation.recommendationId,
      evaluationId: evaluation.evaluationId,
      severity: recommendation.severity,
      automaticExecutionAllowed: false
    });
    return recommendation;
  }

  get(recommendationId: string): RollbackRecommendation {
    const value = this.options.recommendations.get(recommendationId);
    if (!value) throw new DebugMcpError("RollbackRecommendationNotFound", `Rollback recommendation not found: ${recommendationId}`, { recommendationId });
    return value;
  }

  review(input: { recommendationId: string; action: RollbackReviewAction; reason: string; reviewer?: string }): Record<string, unknown> {
    const recommendation = this.get(input.recommendationId);
    const reason = input.reason.trim();
    if (!reason) throw new DebugMcpError("RollbackReviewReasonRequired", "A review reason is required for every rollback recommendation decision", { recommendationId: input.recommendationId });
    if (recommendation.status === "superseded") {
      throw new DebugMcpError("RollbackRecommendationStale", "This rollback recommendation was superseded by a later evaluation", { recommendationId: input.recommendationId, supersededByEvaluationId: recommendation.supersededByEvaluationId });
    }
    const reviewedAt = new Date(this.now()).toISOString();
    const status: RollbackRecommendationStatus = input.action === "acknowledge"
      ? "acknowledged"
      : input.action === "reject"
        ? "rejected"
        : "resolved";
    let convertedProposal: ImprovementProposal | undefined;
    if (input.action === "convert-to-proposal") convertedProposal = this.createFollowUpProposal(recommendation, reason, input.reviewer);
    const updated = rollbackRecommendationSchema.parse({
      ...recommendation,
      status,
      updatedAt: reviewedAt,
      reviewedAt,
      reviewedBy: normalizeReviewer(input.reviewer),
      reviewReason: reason,
      ...(convertedProposal ? { convertedProposalId: convertedProposal.proposalId } : {})
    });
    this.options.recommendations.upsert(updated);
    return {
      recommendation: updated,
      action: input.action,
      automaticExecutionAllowed: false,
      ...(convertedProposal ? { followUpProposal: convertedProposal } : {})
    };
  }

  supersedeForImprovedEvaluation(proposalId: string, evaluationId: string): void {
    this.supersedeForNonRegressedEvaluation(proposalId, evaluationId);
  }

  supersedeForNonRegressedEvaluation(proposalId: string, evaluationId: string): void {
    for (const recommendation of this.options.recommendations.list(500)) {
      if (recommendation.proposalId !== proposalId || ["rejected", "resolved", "superseded"].includes(recommendation.status)) continue;
      const updated = rollbackRecommendationSchema.parse({
        ...recommendation,
        status: "superseded",
        supersededByEvaluationId: evaluationId,
        updatedAt: new Date(this.now()).toISOString()
      });
      this.options.recommendations.upsert(updated);
    }
  }

  private createFollowUpProposal(recommendation: RollbackRecommendation, reason: string, reviewer?: string): ImprovementProposal {
    const existing = this.options.proposals.list({ category: "rollback", limit: 500 }).find(item => item.source === "post-merge-regression" && item.evidence.context.evaluationId === recommendation.evaluationId);
    if (existing) return existing;
    const original = this.options.proposals.get(recommendation.proposalId);
    const timestamp = new Date(this.now()).toISOString();
    const affectedMetrics = recommendation.affectedMetrics.length > 0 ? recommendation.affectedMetrics : ["regressionRate"];
    const proposal = improvementProposalSchema.parse({
      proposalId: `rollback-${randomUUID()}`,
      fingerprint: sha256Json({ recommendationId: recommendation.recommendationId, evaluationId: recommendation.evaluationId }),
      status: "ready-for-review",
      category: "rollback",
      target: `${original?.target ?? "merged-improvement"}/rollback`,
      title: `Investigate post-merge regression for ${original?.title ?? recommendation.proposalId}`,
      summary: `Post-merge evidence is consistent with a regression after merged commit ${recommendation.mergedCommitSha}. Human review is required; this proposal does not assert causation and does not execute a rollback. Review reason: ${reason}`.slice(0, 2048),
      evidence: {
        matchingRuns: recommendation.findings.reduce((sum, finding) => sum + finding.samples, 0),
        affectedRuns: recommendation.findings.length,
        successAfterEscalation: 0,
        failureAfterEscalation: recommendation.findings.length,
        sampleWindow: "30d",
        patternRatio: 1,
        failureRate: 1,
        sufficient: true,
        minimumMatchingRuns: 1,
        minimumPatternRatio: 0,
        supportingTools: [],
        supportingCapabilities: [],
        context: {
          evaluationId: recommendation.evaluationId,
          mergedCommitSha: recommendation.mergedCommitSha,
          recommendationId: recommendation.recommendationId
        },
        rootCause: "insufficient-evidence",
        rootCauseReason: "Post-merge evidence supports a follow-up review but does not establish causation.",
        observedAt: timestamp
      },
      proposedChange: {
        kind: "rollback",
        target: `${original?.target ?? "merged-improvement"}/rollback`,
        description: recommendation.action,
        allowedAreas: original?.proposedChange.allowedAreas ?? ["human-reviewed rollback or follow-up fix"],
        forbiddenAreas: ["automatic revert", "automatic production change", "master", "main"],
        changeScope: "medium",
        implementationMode: "manual-only",
        suggestedTools: []
      },
      expectedBenefit: {
        summary: "Restore or investigate the affected regression metrics under a human-approved follow-up.",
        metrics: affectedMetrics.slice(0, 16).map(name => ({ name, direction: "decrease" as const, rationale: "The metric was identified by a deterministic post-merge regression finding." }))
      },
      risks: [{ level: "high", description: "A rollback or follow-up change can alter production behavior and may not be safe without current deployment review.", mitigation: "Require human review, fresh validation, and the normal candidate/PR/merge gates." }],
      validationPlan: {
        existingTests: ["post-merge regression evaluation"],
        newRegressionTestRequired: true,
        mockValidation: true,
        hardwareRequired: false,
        replayFixtures: [],
        beforeAfterMetrics: affectedMetrics.slice(0, 32),
        rollbackCondition: "Only a human-approved validated change may be merged after comparable evidence confirms the regression is addressed.",
        acceptanceCriteria: ["No safety invariant regression", "Comparable post-change metrics are no worse than the frozen baseline"]
      },
      confidence: Math.min(1, Math.max(0.1, recommendation.findings.length / 10)),
      priority: recommendation.severity === "critical" ? "P0" : recommendation.severity === "strong" ? "P1" : "P2",
      generatedBy: "static-rule",
      sourceWindow: "30d",
      source: "post-merge-regression",
      baselineSha: recommendation.mergedCommitSha,
      primaryMetrics: affectedMetrics.slice(0, 16).map(name => ({
        name,
        classification: "reliability" as const,
        direction: "decrease" as const,
        required: true,
        tolerance: 0,
        meaningfulDelta: 0.01,
        unit: "",
        rationale: "Metric selected from a deterministic rollback finding.",
        source: "declared" as const
      })),
      primaryMetricsLocked: false,
      primaryMetricsSource: "declared",
      createdAt: timestamp,
      updatedAt: timestamp,
      lastObservedAt: timestamp,
      ...(reviewer ? { reviewedBy: normalizeReviewer(reviewer), reviewReason: reason, reviewedAt: timestamp } : {})
    });
    this.options.proposals.upsert(proposal);
    this.options.logger?.info("c2000 rollback recommendation converted to follow-up proposal", {
      recommendationId: recommendation.recommendationId,
      proposalId: proposal.proposalId
    });
    return proposal;
  }
}

function rollbackTarget(proposal?: ImprovementProposal): RollbackRecommendation["target"] {
  if (!proposal) return "manual-investigation";
  if (proposal.category === "tool-surface" || proposal.category === "capability" || proposal.proposedChange.kind === "surface-promotion" || proposal.proposedChange.kind === "surface-demotion") return "follow-up-fix";
  if (proposal.proposedChange.allowedAreas.some(area => /schema|package|migration|config|database/i.test(area))) return "manual-investigation";
  return "revert-improvement";
}

function normalizeReviewer(value: string | undefined): string {
  const normalized = value?.trim() || "human-reviewer";
  return /^[A-Za-z0-9._:-]{1,128}$/.test(normalized) ? normalized : "human-reviewer";
}
