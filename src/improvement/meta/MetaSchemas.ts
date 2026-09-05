import { z } from "zod";
import {
  PROPOSAL_CATEGORIES,
  PROPOSAL_FINAL_OUTCOMES,
  PROPOSAL_RISK_LEVELS,
  PROPOSAL_STATUSES
} from "../ProposalSchemas.js";

const boundedText = (max: number) => z.string().trim().min(1).max(max);
const boundedId = z.string().regex(/^[A-Za-z0-9._:/-]{1,256}$/);
const boundedHash = z.string().regex(/^[0-9a-f]{16,64}$/i);

export const META_RECOMMENDATION_CATEGORIES = [
  "proposal-policy",
  "validation-policy",
  "hardware-policy",
  "tool-surface-policy",
  "capability-policy",
  "skill-policy",
  "implementation-policy",
  "review-policy",
  "evaluation-policy"
] as const;

export const META_RECOMMENDATION_STATUSES = [
  "draft",
  "ready-for-review",
  "accepted",
  "rejected",
  "deferred",
  "converted-to-proposal",
  "superseded"
] as const;

export const META_HISTORY_STATUSES = ["READY", "INSUFFICIENT_META_HISTORY"] as const;

export const improvementHistoryRecordSchema = z.object({
  proposalId: boundedId,
  proposalStatus: z.enum(PROPOSAL_STATUSES).optional(),
  category: z.enum(PROPOSAL_CATEGORIES),
  target: boundedText(192),
  risk: z.enum(PROPOSAL_RISK_LEVELS),
  generatedBy: boundedText(64),
  detector: boundedText(128).optional(),
  evidenceSampleCount: z.number().int().nonnegative(),
  proposalConfidence: z.number().finite().min(0).max(1).optional(),
  implementationMode: boundedText(32),
  implementationRunCount: z.number().int().nonnegative(),
  agentAttemptCount: z.number().int().nonnegative(),
  revisionCount: z.number().int().nonnegative(),
  localValidationVerdict: boundedText(64).optional(),
  validationStages: z.array(z.object({
    stage: boundedText(128),
    status: z.enum(["passed", "failed", "not-run"]),
    durationMs: z.number().int().nonnegative().optional()
  })).max(128).optional(),
  preMergeValidationPassed: z.boolean().optional(),
  hardwareRequired: z.boolean().optional(),
  hardwareValidationVerdict: z.enum(["passed", "failed", "inconclusive"]).optional(),
  reviewPassedBeforeMerge: z.boolean().optional(),
  prReviewRounds: z.number().int().nonnegative().optional(),
  merged: z.boolean(),
  mergedAt: z.string().datetime().optional(),
  finalOutcome: z.enum(PROPOSAL_FINAL_OUTCOMES).optional(),
  postMergeEffect: z.record(z.number().finite()).optional(),
  rollbackRecommended: z.boolean().optional(),
  validationEscape: z.boolean().default(false),
  timeToCandidateMs: z.number().finite().nonnegative().optional(),
  timeToMergeMs: z.number().finite().nonnegative().optional(),
  timeToFinalEvaluationMs: z.number().finite().nonnegative().optional(),
  policyRegime: boundedText(128).default("legacy"),
  engineeringPolicyHash: boundedHash.optional(),
  toolUsageCount: z.number().int().nonnegative().optional(),
  schemaCostBytes: z.number().int().nonnegative().optional(),
  workflowCovered: z.boolean().optional(),
  capabilityName: boundedText(128).optional(),
  provider: boundedText(128).optional(),
  evaluationId: boundedId.optional()
});
export type ImprovementHistoryRecord = z.infer<typeof improvementHistoryRecordSchema>;

export const metaRateMetricSchema = z.object({
  numerator: z.number().int().nonnegative(),
  denominator: z.number().int().nonnegative(),
  rate: z.number().finite().min(0).max(1)
});
export type MetaRateMetric = z.infer<typeof metaRateMetricSchema>;

export const metaBurdenMetricSchema = z.object({
  total: z.number().int().nonnegative(),
  recordsWithBurden: z.number().int().nonnegative(),
  average: z.number().finite().nonnegative(),
  median: z.number().finite().nonnegative(),
  p95: z.number().finite().nonnegative()
});
export type MetaBurdenMetric = z.infer<typeof metaBurdenMetricSchema>;

export const outcomeDistributionSchema = z.object({
  "verified-improvement": z.number().int().nonnegative(),
  "no-observable-benefit": z.number().int().nonnegative(),
  "verified-regression": z.number().int().nonnegative(),
  inconclusive: z.number().int().nonnegative(),
  "rolled-back": z.number().int().nonnegative(),
  superseded: z.number().int().nonnegative()
});
export type OutcomeDistribution = z.infer<typeof outcomeDistributionSchema>;

export const metaAggregateMetricsSchema = z.object({
  sampleSize: z.number().int().nonnegative(),
  evaluatedImprovements: z.number().int().nonnegative(),
  readyForReview: z.number().int().nonnegative(),
  approved: z.number().int().nonnegative(),
  implemented: z.number().int().nonnegative(),
  candidateReady: z.number().int().nonnegative(),
  merged: z.number().int().nonnegative(),
  proposalYield: metaRateMetricSchema,
  implementationYield: metaRateMetricSchema,
  mergeYield: metaRateMetricSchema,
  verifiedImprovementYield: metaRateMetricSchema,
  regressionRate: metaRateMetricSchema,
  neutralRate: metaRateMetricSchema,
  inconclusiveRate: metaRateMetricSchema,
  rollbackRecommendationRate: metaRateMetricSchema,
  validationEscapeRate: metaRateMetricSchema,
  revisionBurden: metaBurdenMetricSchema,
  agentRepairBurden: metaBurdenMetricSchema,
  outcomeDistribution: outcomeDistributionSchema,
  medianTimeToCandidateMs: z.number().finite().nonnegative().nullable(),
  medianTimeToMergeMs: z.number().finite().nonnegative().nullable(),
  medianTimeToFinalEvaluationMs: z.number().finite().nonnegative().nullable()
});
export type MetaAggregateMetrics = z.infer<typeof metaAggregateMetricsSchema>;

export const metaGroupAggregateSchema = z.object({
  key: boundedText(192),
  metrics: metaAggregateMetricsSchema
});
export type MetaGroupAggregate = z.infer<typeof metaGroupAggregateSchema>;

export const validationStageMetricSchema = z.object({
  stage: boundedText(128),
  sampleSize: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  notRun: z.number().int().nonnegative(),
  preMergeFailureRate: metaRateMetricSchema,
  postMergeRegressionsAfterPass: z.number().int().nonnegative(),
  predictiveValue: metaRateMetricSchema,
  totalDurationMs: z.number().int().nonnegative(),
  medianDurationMs: z.number().finite().nonnegative().nullable(),
  p95DurationMs: z.number().finite().nonnegative().nullable()
});
export type ValidationStageMetric = z.infer<typeof validationStageMetricSchema>;

export const validationPredictiveValueSchema = z.object({
  preMergeValidated: z.number().int().nonnegative(),
  postMergeRegressionsAfterValidation: z.number().int().nonnegative(),
  predictiveValue: metaRateMetricSchema,
  validationEscapeCount: z.number().int().nonnegative(),
  reviewEscapeCount: z.number().int().nonnegative(),
  stageMetrics: z.array(validationStageMetricSchema).max(64).default([])
});
export type ValidationPredictiveValue = z.infer<typeof validationPredictiveValueSchema>;

export const hardwareGateEffectivenessSchema = z.object({
  hardwareRequired: z.number().int().nonnegative(),
  hardwareFailedBeforeMerge: z.number().int().nonnegative(),
  hardwareCaughtRegressionBeforeMerge: z.number().int().nonnegative(),
  hardwarePassed: z.number().int().nonnegative(),
  postMergeRegressionAfterHardwarePass: z.number().int().nonnegative(),
  predictiveValue: metaRateMetricSchema,
  hardwareNotRequiredFailures: z.number().int().nonnegative().default(0),
  postMergeRegressionAfterHardwareFailure: z.number().int().nonnegative().default(0)
});
export type HardwareGateEffectiveness = z.infer<typeof hardwareGateEffectivenessSchema>;

export const policyEvidenceSchema = z.object({
  sampleSize: z.number().int().nonnegative(),
  timeWindow: z.object({
    from: z.string().datetime().nullable(),
    to: z.string().datetime().nullable()
  }),
  proposalCategory: z.string().max(64),
  currentPolicyRegime: boundedText(128),
  finalOutcomeDistribution: outcomeDistributionSchema,
  validationEscapeCount: z.number().int().nonnegative(),
  effectSize: z.number().finite(),
  relevantProposalIds: z.array(boundedId).max(64),
  relevantEvaluationIds: z.array(boundedId).max(64),
  confounders: z.array(z.string().max(512)).max(64)
});
export type PolicyEvidence = z.infer<typeof policyEvidenceSchema>;

export const engineeringPolicyRecommendationSchema = z.object({
  recommendationId: boundedId,
  fingerprint: boundedHash,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  lastObservedAt: z.string().datetime(),
  category: z.enum(META_RECOMMENDATION_CATEGORIES),
  target: boundedText(192),
  title: boundedText(256),
  summary: boundedText(2048),
  evidence: policyEvidenceSchema,
  currentPolicy: z.unknown(),
  recommendedPolicyChange: z.unknown(),
  expectedEffect: z.array(boundedText(1024)).min(1).max(32),
  risks: z.array(boundedText(1024)).min(1).max(32),
  confidence: z.number().finite().min(0).max(1),
  sampleSize: z.number().int().nonnegative(),
  policyRegime: boundedText(128),
  engineeringPolicyHash: boundedHash,
  detector: boundedText(128),
  status: z.enum(META_RECOMMENDATION_STATUSES),
  automaticExecutionAllowed: z.literal(false),
  reviewedAt: z.string().datetime().optional(),
  reviewedBy: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/).optional(),
  reviewReason: z.string().trim().max(2048).optional(),
  convertedProposalId: boundedId.optional()
});
export type EngineeringPolicyRecommendation = z.infer<typeof engineeringPolicyRecommendationSchema>;

export const engineeringPolicySnapshotSchema = z.object({
  snapshotId: boundedId,
  policyRegime: boundedText(128),
  engineeringPolicyHash: boundedHash,
  capturedAt: z.string().datetime(),
  policy: z.record(z.unknown()),
  legacy: z.boolean().default(false)
});
export type EngineeringPolicySnapshot = z.infer<typeof engineeringPolicySnapshotSchema>;

export const crossImprovementSnapshotSchema = z.object({
  snapshotId: boundedId,
  generatedAt: z.string().datetime(),
  from: z.string().datetime().nullable(),
  to: z.string().datetime().nullable(),
  policyRegime: boundedText(128),
  engineeringPolicyHash: boundedHash,
  historyStatus: z.enum(META_HISTORY_STATUSES),
  sampleSize: z.number().int().nonnegative(),
  evaluatedSampleSize: z.number().int().nonnegative(),
  metrics: metaAggregateMetricsSchema,
  byCategory: z.array(metaGroupAggregateSchema).max(64),
  byRisk: z.array(metaGroupAggregateSchema).max(16),
  byGenerator: z.array(metaGroupAggregateSchema).max(32),
  byDetector: z.array(metaGroupAggregateSchema).max(64),
  byPolicyRegime: z.array(metaGroupAggregateSchema).max(64),
  byProvider: z.array(metaGroupAggregateSchema).max(32).default([]),
  confidenceCalibration: z.array(metaGroupAggregateSchema).max(8),
  evidenceSampleOutcome: z.array(metaGroupAggregateSchema).max(16),
  validationPredictiveValue: validationPredictiveValueSchema,
  hardwareGateEffectiveness: hardwareGateEffectivenessSchema,
  validationStageEffectiveness: z.array(validationStageMetricSchema).max(64).default([]),
  toolSurfaceEffectiveness: metaAggregateMetricsSchema,
  capabilityEffectiveness: metaAggregateMetricsSchema,
  workflowEffectiveness: metaAggregateMetricsSchema,
  confounders: z.array(z.string().max(512)).max(64)
});
export type CrossImprovementSnapshot = z.infer<typeof crossImprovementSnapshotSchema>;

export type MetaRecommendationCategory = typeof META_RECOMMENDATION_CATEGORIES[number];
export type MetaRecommendationStatus = typeof META_RECOMMENDATION_STATUSES[number];
export type MetaHistoryStatus = typeof META_HISTORY_STATUSES[number];
