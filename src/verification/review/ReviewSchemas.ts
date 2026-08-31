import { z } from "zod";

export const REVIEW_SCHEMA_VERSION = 1 as const;

export const reviewRuleSeveritySchema = z.enum(["INFO", "WARNING", "ERROR", "CRITICAL"]);
export const reviewPatternRuleSchema = z.object({
  id: z.string().min(1).optional(),
  pattern: z.string().min(1),
  flags: z.string().regex(/^[dgimsuvy]*$/).default("m"),
  severity: reviewRuleSeveritySchema.default("CRITICAL"),
  message: z.string().min(1).optional()
});

export const requiredCompanionRuleSchema = z.object({
  trigger: z.string().min(1),
  files: z.array(z.string().min(1)).min(1)
});

export const reviewRulesSchema = z.object({
  forbiddenPaths: z.array(z.string().min(1)).default([]),
  generatedPaths: z.array(z.string().min(1)).default([]),
  highFrequencyPaths: z.array(z.string().min(1)).default([]),
  forbiddenPatterns: z.array(reviewPatternRuleSchema).default([]),
  requiredCompanionFiles: z.array(requiredCompanionRuleSchema).default([]),
  maxChangedLines: z.number().int().positive().nullable().default(null),
  realtimePaths: z.array(z.object({ hook: z.string().min(1), path: z.string().min(1) })).default([]),
  linkerPaths: z.array(z.string().min(1)).default(["**/*.cmd", "**/*.ld", "**/*.lds"]),
  interfacePaths: z.array(z.string().min(1)).default([]),
  ipcPaths: z.array(z.string().min(1)).default([])
});

export const reviewEvidenceSchema = z.object({
  realtimeReviewId: z.string().min(1).optional(),
  mapVerificationId: z.string().min(1).optional(),
  interfaceReviewId: z.string().min(1).optional(),
  ipcReviewId: z.string().min(1).optional()
});

export const reviewVerificationInputSchema = z.object({
  diffText: z.string().max(16 * 1024 * 1024).optional(),
  diffPath: z.string().min(1).optional(),
  changedFiles: z.array(z.string().min(1)).optional(),
  repositoryPath: z.string().min(1).optional(),
  rules: reviewRulesSchema.default({}),
  evidence: reviewEvidenceSchema.default({}),
  jobId: z.string().min(1).optional(),
  outputDir: z.string().min(1).optional(),
  verificationId: z.string().regex(/^[A-Za-z0-9._/-]+$/).optional(),
  parentVerificationId: z.string().regex(/^[A-Za-z0-9._/-]+$/).nullable().optional()
}).refine(value => value.diffText !== undefined || value.diffPath !== undefined || (value.changedFiles?.length ?? 0) > 0, {
  message: "review requires diffText, diffPath, or changedFiles",
  path: ["diffText"]
});

export const reviewResultSchema = z.object({
  schemaVersion: z.literal(REVIEW_SCHEMA_VERSION),
  status: z.enum(["PASSED", "FAILED", "BLOCKED", "UNSUPPORTED", "ERROR"]),
  changedFiles: z.array(z.string().min(1)),
  changedLines: z.object({ added: z.number().int().nonnegative(), removed: z.number().int().nonnegative(), total: z.number().int().nonnegative() }),
  counts: z.object({ checks: z.number().int().nonnegative(), passed: z.number().int().nonnegative(), failed: z.number().int().nonnegative(), blocked: z.number().int().nonnegative(), skipped: z.number().int().nonnegative() }),
  checks: z.array(z.object({
    id: z.string().min(1),
    status: z.enum(["PASSED", "FAILED", "SKIPPED", "BLOCKED", "UNSUPPORTED"]),
    severity: reviewRuleSeveritySchema,
    message: z.string().min(1),
    file: z.string().min(1).optional(),
    line: z.number().int().positive().optional(),
    evidence: z.unknown().optional()
  })),
  requirements: z.array(z.object({ id: z.string().min(1), required: z.boolean(), satisfied: z.boolean(), evidenceId: z.string().min(1).nullable() })),
  decision: z.enum(["PASS", "REJECT", "REQUIRES_REVIEW", "BLOCK"]),
  durationMs: z.number().int().nonnegative()
});

export type ReviewRuleSeverity = z.infer<typeof reviewRuleSeveritySchema>;
export type ReviewRules = z.infer<typeof reviewRulesSchema>;
export type ReviewEvidence = z.infer<typeof reviewEvidenceSchema>;
export type ReviewVerificationInput = z.infer<typeof reviewVerificationInputSchema>;
export type ReviewResult = z.infer<typeof reviewResultSchema>;
