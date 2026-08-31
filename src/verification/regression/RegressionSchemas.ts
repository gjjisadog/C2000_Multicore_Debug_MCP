import { z } from "zod";

export const REGRESSION_SCHEMA_VERSION = 1 as const;

export const regressionSuiteStatusSchema = z.enum(["PASSED", "FAILED", "SKIPPED", "BLOCKED", "UNSUPPORTED"]);
export const regressionSuiteKindSchema = z.enum(["host", "mock", "hardware"]);

export const regressionSuiteSchema = z.object({
  id: z.string().min(1),
  kind: regressionSuiteKindSchema.default("host"),
  required: z.boolean().default(true),
  timeoutMs: z.number().int().positive().max(24 * 60 * 60 * 1000).optional()
});

export const regressionPlanSchema = z.object({
  suites: z.array(z.union([z.string().min(1), regressionSuiteSchema])).min(1),
  requireHardware: z.boolean().default(false),
  defaultTimeoutMs: z.number().int().positive().max(24 * 60 * 60 * 1000).default(15 * 60 * 1000),
  workingDirectory: z.string().min(1).optional(),
  outputDir: z.string().min(1).optional(),
  jobId: z.string().min(1).optional(),
  verificationId: z.string().regex(/^[A-Za-z0-9._/-]+$/).optional(),
  parentVerificationId: z.string().regex(/^[A-Za-z0-9._/-]+$/).nullable().optional()
});

export const regressionSuiteResultSchema = z.object({
  id: z.string().min(1),
  kind: regressionSuiteKindSchema,
  required: z.boolean(),
  status: regressionSuiteStatusSchema,
  durationMs: z.number().int().nonnegative(),
  exitCode: z.number().int().nullable(),
  expected: z.unknown().optional(),
  actual: z.unknown().optional(),
  errorCode: z.string().min(1).nullable(),
  source: z.string().min(1).nullable(),
  artifacts: z.array(z.string().min(1)),
  evidenceClassification: z.enum(["MOCK", "UNKNOWN", "HARDWARE_TARGET", "HARDWARE_BUS", "MIXED"]),
  evidenceComplete: z.boolean().default(true),
  message: z.string().min(1)
});

export const regressionResultSchema = z.object({
  schemaVersion: z.literal(REGRESSION_SCHEMA_VERSION),
  status: z.enum(["PASSED", "FAILED", "BLOCKED", "UNSUPPORTED", "ERROR"]),
  total: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  blocked: z.number().int().nonnegative(),
  unsupported: z.number().int().nonnegative(),
  suites: z.array(regressionSuiteResultSchema),
  durationMs: z.number().int().nonnegative(),
  requireHardware: z.boolean()
});

export type RegressionSuiteStatus = z.infer<typeof regressionSuiteStatusSchema>;
export type RegressionSuite = z.infer<typeof regressionSuiteSchema>;
export type RegressionPlan = z.infer<typeof regressionPlanSchema>;
export type RegressionSuiteResult = z.infer<typeof regressionSuiteResultSchema>;
export type RegressionResult = z.infer<typeof regressionResultSchema>;
