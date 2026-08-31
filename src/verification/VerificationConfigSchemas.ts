import { z } from "zod";
import { mapRulesSchema } from "./map/MapSchemas.js";
import { regressionPlanSchema } from "./regression/RegressionSchemas.js";
import { reviewRulesSchema } from "./review/ReviewSchemas.js";

/** Trusted, installation-time verifier configuration. Requests select ids and rules; they do not submit commands. */
export const verificationRuleFileSchema = z.object({
  schemaVersion: z.literal(1).optional(),
  build: z.object({
    defaultProvider: z.string().min(1).optional()
  }).optional(),
  map: z.object({
    rules: mapRulesSchema.partial().optional()
  }).optional(),
  regression: z.object({
    plan: regressionPlanSchema.optional()
  }).optional(),
  review: z.object({
    rules: reviewRulesSchema.partial().optional()
  }).optional()
}).strict();

export const processBuildProviderConfigSchema = z.object({
  executablePath: z.string().min(1),
  args: z.array(z.string()).default([]),
  workingDirectory: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive().max(24 * 60 * 60 * 1000).optional(),
  environment: z.record(z.string()).optional()
});

export const verificationConfigSchema = z.object({
  artifactDirectory: z.string().min(1).optional(),
  /** Optional project-specific JSON rules, read and merged before each verification session. */
  rulesFile: z.string().min(1).optional(),
  build: z.object({
    enabled: z.boolean().default(true),
    defaultProvider: z.string().min(1).default("artifact"),
    providers: z.record(processBuildProviderConfigSchema).default({})
  }).default({}),
  map: z.object({
    enabled: z.boolean().default(true),
    rules: mapRulesSchema.default({})
  }).default({}),
  regression: z.object({
    enabled: z.boolean().default(true),
    plan: regressionPlanSchema.optional()
  }).default({}),
  review: z.object({
    enabled: z.boolean().default(true),
    rules: reviewRulesSchema.default({})
  }).default({})
});

export type ProcessBuildProviderConfig = z.infer<typeof processBuildProviderConfigSchema>;
export type VerificationConfig = z.infer<typeof verificationConfigSchema>;
export type VerificationRuleFile = z.infer<typeof verificationRuleFileSchema>;
