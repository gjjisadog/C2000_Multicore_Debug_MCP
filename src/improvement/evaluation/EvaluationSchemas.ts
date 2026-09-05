import { z } from "zod";
import { deterministicStatisticsSchema } from "../../analytics/MetricSchemas.js";

const boundedText = (max: number) => z.string().trim().min(1).max(max);
const boundedName = z.string().regex(/^[A-Za-z0-9._:/-]{1,192}$/);
const shaSchema = z.string().regex(/^[0-9a-f]{7,64}$/i);

export const POST_MERGE_EVALUATION_STATUSES = [
  "created",
  "waiting-for-deployment",
  "collecting",
  "monitoring",
  "ready",
  "evaluated",
  "insufficient-data",
  "invalidated",
  "closed"
] as const;

export const POST_MERGE_VERDICTS = ["improved", "neutral", "regressed", "inconclusive"] as const;
export const COMPARABILITY_STATUSES = ["comparable", "not-comparable", "unknown"] as const;
export const EVALUATION_PHASES = ["baseline", "post-merge"] as const;
export const METRIC_CLASSIFICATIONS = [
  "workflow",
  "tool-surface",
  "capability",
  "reliability",
  "performance",
  "error-guidance",
  "review-quality",
  "test-quality",
  "safety"
] as const;
export const METRIC_DIRECTIONS = ["increase", "decrease", "preserve"] as const;
export const METRIC_RELATIONSHIPS = [
  "consistent-with-benefit",
  "consistent-with-regression",
  "no-observable-effect",
  "confounded",
  "insufficient-evidence"
] as const;
export const REGRESSION_FINDING_SEVERITIES = ["warning", "significant", "critical"] as const;
export const ROLLBACK_RECOMMENDATION_SEVERITIES = ["advisory", "strong", "critical"] as const;
export const ROLLBACK_RECOMMENDATION_STATUSES = ["open", "acknowledged", "rejected", "resolved", "superseded"] as const;
export const ROLLBACK_TARGETS = ["revert-improvement", "disable-feature", "follow-up-fix", "manual-investigation"] as const;

export const metricDefinitionSchema = z.object({
  name: boundedName,
  classification: z.enum(METRIC_CLASSIFICATIONS),
  direction: z.enum(METRIC_DIRECTIONS),
  required: z.boolean().default(true),
  tolerance: z.number().finite().nonnegative().max(1_000_000).default(0),
  meaningfulDelta: z.number().finite().nonnegative().max(1_000_000).default(0.01),
  unit: z.string().max(64).default(""),
  rationale: boundedText(512),
  source: z.enum(["declared", "retrospective"]).default("declared")
});
export type EvaluationMetricDefinition = z.infer<typeof metricDefinitionSchema>;

export const metricStatisticsSchema = z.object({
  name: boundedName,
  classification: z.enum(METRIC_CLASSIFICATIONS),
  direction: z.enum(METRIC_DIRECTIONS),
  required: z.boolean(),
  unit: z.string().max(64),
  statistic: z.enum(["mean", "p50", "p95", "p99"]),
  statistics: deterministicStatisticsSchema,
  value: z.number().finite().nullable(),
  sampleCount: z.number().int().nonnegative(),
  sourceEventCount: z.number().int().nonnegative()
});
export type EvaluationMetricStatistics = z.infer<typeof metricStatisticsSchema>;

export const metricComparisonSchema = z.object({
  name: boundedName,
  classification: z.enum(METRIC_CLASSIFICATIONS),
  direction: z.enum(METRIC_DIRECTIONS),
  required: z.boolean(),
  baselineValue: z.number().finite().nullable(),
  currentValue: z.number().finite().nullable(),
  absoluteDelta: z.number().finite().nullable(),
  relativeDelta: z.number().finite().nullable(),
  tolerance: z.number().finite().nonnegative(),
  meaningfulDelta: z.number().finite().nonnegative(),
  sampleCount: z.number().int().nonnegative(),
  relationship: z.enum(METRIC_RELATIONSHIPS),
  evidence: boundedText(1024)
});
export type MetricComparison = z.infer<typeof metricComparisonSchema>;

export const evaluationMetricSnapshotSchema = z.object({
  snapshotId: boundedText(256),
  phase: z.enum(EVALUATION_PHASES),
  capturedAt: z.string().datetime(),
  eventCount: z.number().int().nonnegative(),
  comparableEventCount: z.number().int().nonnegative(),
  excludedEventCount: z.number().int().nonnegative(),
  metrics: z.array(metricStatisticsSchema).max(64),
  runtimeIdentities: z.array(z.object({
    mcpVersion: boundedText(128),
    mcpGitSha: boundedText(128),
    count: z.number().int().positive()
  })).max(32).default([])
});
export type EvaluationMetricSnapshot = z.infer<typeof evaluationMetricSnapshotSchema>;

export const comparabilityDimensionSchema = z.object({
  name: boundedName,
  baseline: z.string().max(512).nullable(),
  current: z.string().max(512).nullable(),
  comparable: z.boolean(),
  reason: z.string().max(512)
});
export type ComparabilityDimension = z.infer<typeof comparabilityDimensionSchema>;

export const comparabilityReportSchema = z.object({
  status: z.enum(COMPARABILITY_STATUSES),
  score: z.number().finite().min(0).max(1).default(0),
  dimensions: z.array(comparabilityDimensionSchema).max(32),
  reasons: z.array(z.string().max(1024)).max(64),
  confounders: z.array(z.string().max(512)).max(64),
  baselineEventCount: z.number().int().nonnegative(),
  postMergeEventCount: z.number().int().nonnegative(),
  comparableBaselineEventCount: z.number().int().nonnegative(),
  comparablePostMergeEventCount: z.number().int().nonnegative(),
  excludedPostMergeEventCount: z.number().int().nonnegative()
});
export type ComparabilityReport = z.infer<typeof comparabilityReportSchema>;

export const regressionFindingSchema = z.object({
  findingId: boundedText(256),
  metric: boundedName,
  classification: z.enum(METRIC_CLASSIFICATIONS),
  severity: z.enum(REGRESSION_FINDING_SEVERITIES),
  baselineValue: z.number().finite().nullable(),
  currentValue: z.number().finite().nullable(),
  absoluteDelta: z.number().finite().nullable(),
  relativeDelta: z.number().finite().nullable(),
  samples: z.number().int().nonnegative(),
  evidence: boundedText(2048),
  related: z.boolean()
});
export type RegressionFinding = z.infer<typeof regressionFindingSchema>;

export const improvementAttributionSchema = z.object({
  metric: boundedName,
  relationship: z.enum(METRIC_RELATIONSHIPS),
  evidence: boundedText(1024),
  confidence: z.number().finite().min(0).max(1),
  related: z.boolean()
});
export type ImprovementAttribution = z.infer<typeof improvementAttributionSchema>;

export const evaluationObservationWindowSchema = z.object({
  startedAt: z.string().datetime(),
  minimumDurationDays: z.number().int().positive(),
  finalDurationDays: z.number().int().positive(),
  minimumComparableSamples: z.number().int().positive(),
  finalComparableSamples: z.number().int().positive(),
  finalAt: z.string().datetime()
});

export const evaluationDeploymentSchema = z.object({
  status: z.enum(["not-deployed", "deployed", "unknown"]),
  matchedRuntimeEvents: z.number().int().nonnegative(),
  mergedShaMatched: z.boolean(),
  knownReleaseContainingMerge: z.boolean().default(false),
  details: z.array(z.string().max(512)).max(32).default([])
});

export const evaluationMergeVerificationSchema = z.object({
  status: z.enum(["metadata-confirmed", "candidate-identity-mismatch", "merged-sha-missing", "unknown"]),
  candidateSha: shaSchema,
  mergedCommitSha: shaSchema,
  details: z.array(z.string().max(512)).max(32).default([])
});

export const postMergeEvaluationSchema = z.object({
  evaluationId: boundedText(256),
  proposalId: boundedText(128),
  pullRequestId: boundedText(256),
  pullRequestNumber: z.number().int().positive().optional(),
  baselineSha: shaSchema,
  candidateSha: shaSchema,
  mergedCommitSha: shaSchema,
  /** True when the baseline was reconstructed from retained pre-merge events. */
  retrospectiveBaseline: z.boolean().default(true),
  mergedAt: z.string().datetime(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  lifecycleStatus: z.enum(POST_MERGE_EVALUATION_STATUSES),
  observationWindow: evaluationObservationWindowSchema,
  targetMetricSet: z.array(metricDefinitionSchema).min(1).max(32),
  baselineMetrics: evaluationMetricSnapshotSchema,
  postMergeMetrics: evaluationMetricSnapshotSchema.optional(),
  comparability: comparabilityReportSchema,
  deployment: evaluationDeploymentSchema,
  mergeVerification: evaluationMergeVerificationSchema,
  verdict: z.enum(POST_MERGE_VERDICTS).optional(),
  confidence: z.number().finite().min(0).max(1).default(0),
  regressions: z.array(regressionFindingSchema).max(64).default([]),
  improvements: z.array(improvementAttributionSchema).max(64).default([]),
  confounders: z.array(z.string().max(1024)).max(64).default([]),
  rollbackRecommendationId: boundedText(256).optional(),
  snapshotIds: z.array(boundedText(256)).max(128).default([]),
  verdictHistory: z.array(z.object({
    verdict: z.enum(POST_MERGE_VERDICTS),
    confidence: z.number().finite().min(0).max(1),
    recordedAt: z.string().datetime(),
    reason: z.string().max(1024)
  })).max(64).default([])
});
export type PostMergeEvaluation = z.infer<typeof postMergeEvaluationSchema>;

export const postMergeEvaluationSnapshotSchema = z.object({
  snapshotId: boundedText(256),
  evaluationId: boundedText(256),
  phase: z.enum(EVALUATION_PHASES),
  capturedAt: z.string().datetime(),
  record: evaluationMetricSnapshotSchema,
  comparability: comparabilityReportSchema
});
export type PostMergeEvaluationSnapshot = z.infer<typeof postMergeEvaluationSnapshotSchema>;

export const rollbackRecommendationSchema = z.object({
  recommendationId: boundedText(256),
  evaluationId: boundedText(256),
  proposalId: boundedText(128),
  mergedCommitSha: shaSchema,
  severity: z.enum(ROLLBACK_RECOMMENDATION_SEVERITIES),
  reasons: z.array(boundedText(2048)).min(1).max(64),
  affectedMetrics: z.array(boundedName).max(64),
  findings: z.array(regressionFindingSchema).max(64),
  target: z.enum(ROLLBACK_TARGETS),
  action: boundedText(2048),
  status: z.enum(ROLLBACK_RECOMMENDATION_STATUSES),
  rollbackSafety: z.enum(["safe", "requires-review", "unsafe", "unknown"]),
  automaticExecutionAllowed: z.literal(false),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  reviewedAt: z.string().datetime().optional(),
  reviewedBy: boundedText(128).optional(),
  reviewReason: z.string().max(2048).optional(),
  convertedProposalId: boundedText(128).optional(),
  supersededByEvaluationId: boundedText(256).optional()
});
export type RollbackRecommendation = z.infer<typeof rollbackRecommendationSchema>;

export type PostMergeEvaluationStatus = typeof POST_MERGE_EVALUATION_STATUSES[number];
export type PostMergeVerdict = typeof POST_MERGE_VERDICTS[number];
export type MetricClassification = typeof METRIC_CLASSIFICATIONS[number];
export type MetricRelationship = typeof METRIC_RELATIONSHIPS[number];
export type RollbackRecommendationStatus = typeof ROLLBACK_RECOMMENDATION_STATUSES[number];
