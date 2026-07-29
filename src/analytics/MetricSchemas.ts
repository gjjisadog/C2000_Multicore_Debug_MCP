import { z } from "zod";
import { evidenceClassificationSchema } from "../artifacts/ArtifactSchemas.js";

export const METRIC_SCHEMA_VERSION = 1 as const;
export const BASELINE_SCHEMA_VERSION = 1 as const;

export const metricSourceSchema = z.object({
  kind: z.enum(["variables", "dlog", "erad", "can", "job-events", "artifact"]),
  path: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  selector: z.string().min(1),
  evidenceLevel: evidenceClassificationSchema
});

export const deterministicStatisticsSchema = z.object({
  count: z.number().int().nonnegative(),
  min: z.number().finite().nullable(),
  max: z.number().finite().nullable(),
  mean: z.number().finite().nullable(),
  p50: z.number().finite().nullable(),
  p95: z.number().finite().nullable(),
  p99: z.number().finite().nullable(),
  stddev: z.number().finite().nonnegative().nullable(),
  missCount: z.number().int().nonnegative(),
  overflowCount: z.number().int().nonnegative(),
  invalidCount: z.number().int().nonnegative()
});

export const runMetricSchema = z.object({
  name: z.string().min(1),
  unit: z.string(),
  statistics: deterministicStatisticsSchema,
  rawSamples: z.array(z.number().finite()),
  sources: z.array(metricSourceSchema).min(1)
});

export const runMetricsDocumentSchema = z.object({
  schemaVersion: z.literal(METRIC_SCHEMA_VERSION),
  jobId: z.string().min(1),
  generatedAt: z.string().datetime(),
  percentileMethod: z.literal("linear-r7"),
  standardDeviation: z.literal("population"),
  evidenceLevel: evidenceClassificationSchema,
  metrics: z.array(runMetricSchema)
});

const metricRuleBase = z.object({ metric: z.string().min(1) });
export const baselineRuleSchema = z.discriminatedUnion("rule", [
  metricRuleBase.extend({ rule: z.literal("upper-bound"), limit: z.number().finite() }),
  metricRuleBase.extend({ rule: z.literal("lower-bound"), limit: z.number().finite() }),
  metricRuleBase.extend({ rule: z.literal("absolute-difference"), limit: z.number().finite().nonnegative() }),
  metricRuleBase.extend({ rule: z.literal("relative-increase"), limitPercent: z.number().finite().nonnegative() }),
  metricRuleBase.extend({ rule: z.literal("p95-upper-bound"), limit: z.number().finite() }),
  metricRuleBase.extend({ rule: z.literal("p99-upper-bound"), limit: z.number().finite() })
]);

export const createRunBaselineSchema = z.object({
  jobId: z.string().min(1),
  baselineName: z.string().min(1).max(128).optional(),
  rules: z.array(baselineRuleSchema).default([])
});

export const compareRunWithBaselineSchema = z.object({
  jobId: z.string().min(1),
  baselineId: z.string().min(1),
  rules: z.array(baselineRuleSchema).optional(),
  allowCompatibleComparison: z.boolean().default(false)
});

export const baselineIdentitySchema = z.object({
  device: z.array(z.string().min(1)).min(1),
  boardProfiles: z.array(z.object({
    device: z.string().min(1),
    tags: z.array(z.string())
  })).min(1),
  firmwareSha256: z.string().regex(/^[a-f0-9]{64}$/),
  cpu1OutSha256: z.array(z.string().regex(/^[a-f0-9]{64}$/)),
  cpu2OutSha256: z.array(z.string().regex(/^[a-f0-9]{64}$/)),
  testPlanId: z.string().min(1),
  testPlanVersion: z.number().int().positive(),
  metricSchemaVersion: z.literal(METRIC_SCHEMA_VERSION),
  toolVersion: z.string().min(1),
  evidenceLevel: evidenceClassificationSchema
});

export const runBaselineSchema = z.object({
  schemaVersion: z.literal(BASELINE_SCHEMA_VERSION),
  baselineId: z.string().min(1),
  baselineName: z.string().min(1).nullable(),
  createdAt: z.string().datetime(),
  sourceJobId: z.string().min(1),
  sourceMetricsPath: z.string().min(1),
  sourceMetricsSha256: z.string().regex(/^[a-f0-9]{64}$/),
  identity: baselineIdentitySchema,
  rules: z.array(baselineRuleSchema),
  metrics: z.array(runMetricSchema.omit({ rawSamples: true }))
});

export const baselineComparisonSchema = z.object({
  schemaVersion: z.literal(BASELINE_SCHEMA_VERSION),
  comparisonId: z.string().min(1),
  baselineId: z.string().min(1),
  baselineSourceJobId: z.string().min(1),
  runJobId: z.string().min(1),
  comparedAt: z.string().datetime(),
  compatibility: z.object({
    status: z.enum(["EXACT", "OVERRIDDEN", "INCOMPATIBLE"]),
    mismatches: z.array(z.string()),
    overrideRequested: z.boolean()
  }),
  overallStatus: z.enum(["PASSED", "FAILED", "NOT_COMPARABLE"]),
  results: z.array(z.object({
    metric: z.string(),
    rule: z.string(),
    status: z.enum(["PASSED", "FAILED", "MISSING"]),
    baselineValue: z.number().finite().nullable(),
    actualValue: z.number().finite().nullable(),
    limit: z.number().finite().nullable(),
    message: z.string()
  })),
  baselinePath: z.string().min(1),
  runMetricsPath: z.string().min(1)
});

export type DeterministicStatistics = z.infer<typeof deterministicStatisticsSchema>;
export type RunMetric = z.infer<typeof runMetricSchema>;
export type RunMetricsDocument = z.infer<typeof runMetricsDocumentSchema>;
export type BaselineRule = z.infer<typeof baselineRuleSchema>;
export type RunBaseline = z.infer<typeof runBaselineSchema>;
export type BaselineComparison = z.infer<typeof baselineComparisonSchema>;
