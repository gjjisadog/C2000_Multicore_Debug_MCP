import { z } from "zod";
import {
  artifactCompletenessSchema,
  evidenceClassificationSchema
} from "../artifacts/ArtifactSchemas.js";

/** Version the persisted verification contract independently from job artifacts. */
export const VERIFICATION_SCHEMA_VERSION = 1 as const;

export const verificationStatusSchema = z.enum([
  "PASSED",
  "FAILED",
  "BLOCKED",
  "UNSUPPORTED",
  "ERROR"
]);

export const verificationCheckStatusSchema = z.enum([
  "PASSED",
  "FAILED",
  "SKIPPED",
  "UNSUPPORTED",
  "BLOCKED"
]);

export const verificationSeveritySchema = z.enum(["INFO", "WARNING", "ERROR", "CRITICAL"]);
export const verifierTypeSchema = z.enum(["build", "map", "regression", "review", "suite"]);

export const verificationSubjectSchema = z.object({
  kind: z.string().min(1),
  id: z.string().min(1),
  name: z.string().min(1).optional(),
  path: z.string().min(1).nullable().optional()
});

/** Optional correlation fields let an eval answer which skill produced evidence. */
export const verificationIdentitySchema = z.object({
  project: z.string().min(1).optional(),
  projectIdentity: z.string().min(1).optional(),
  target: z.string().min(1).optional(),
  configuration: z.string().min(1).optional(),
  device: z.string().min(1).optional(),
  ccsVersion: z.string().min(1).nullable().optional(),
  compilerVersion: z.string().min(1).nullable().optional(),
  abi: z.string().min(1).nullable().optional(),
  commitSha: z.string().min(1).nullable().optional(),
  sourceIdentity: z.string().min(1).nullable().optional(),
  taskId: z.string().min(1).nullable().optional(),
  skillName: z.string().min(1).nullable().optional(),
  skillVersion: z.string().min(1).nullable().optional(),
  agent: z.string().min(1).nullable().optional(),
  model: z.string().min(1).nullable().optional()
}).catchall(z.unknown());

export const verificationCheckSchema = z.object({
  id: z.string().min(1),
  category: z.string().min(1),
  status: verificationCheckStatusSchema,
  severity: verificationSeveritySchema,
  message: z.string().min(1),
  expected: z.unknown().optional(),
  actual: z.unknown().optional(),
  source: z.string().min(1).optional(),
  evidence: z.unknown().optional(),
  file: z.string().min(1).optional(),
  line: z.number().int().positive().optional()
});

export const verificationMetricSchema = z.object({
  name: z.string().min(1),
  unit: z.string(),
  value: z.number().finite().nullable(),
  source: z.string().min(1).optional(),
  baselineValue: z.number().finite().nullable().optional(),
  expected: z.number().finite().nullable().optional()
});

export const verificationArtifactSchema = z.object({
  path: z.string().min(1),
  artifactType: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  size: z.number().int().nonnegative(),
  mtimeMs: z.number().finite().nonnegative().optional(),
  completeness: artifactCompletenessSchema,
  role: z.string().min(1).optional(),
  sourcePath: z.string().min(1).optional()
});

export const verificationCompletenessSchema = z.object({
  status: artifactCompletenessSchema,
  reason: z.string().min(1).nullable(),
  requiredArtifacts: z.array(z.string().min(1)),
  presentArtifacts: z.array(z.string().min(1))
});

export const hardGateFailureSchema = z.object({
  verifier: verifierTypeSchema,
  check: z.string().min(1),
  severity: verificationSeveritySchema,
  message: z.string().min(1),
  evidence: z.unknown().optional()
});

export const verificationSummarySchema = z.object({
  message: z.string().min(1),
  errors: z.number().int().nonnegative(),
  warnings: z.number().int().nonnegative(),
  checks: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  blocked: z.number().int().nonnegative(),
  unsupported: z.number().int().nonnegative(),
  decision: z.enum(["PASS", "REJECT", "BLOCK", "REQUIRES_REVIEW"]).optional()
});

export const verificationResultSchema = z.object({
  schemaVersion: z.literal(VERIFICATION_SCHEMA_VERSION),
  verificationId: z.string().regex(/^[A-Za-z0-9._/-]+$/),
  verifierType: verifierTypeSchema,
  jobId: z.string().min(1).nullable().optional(),
  parentVerificationId: z.string().regex(/^[A-Za-z0-9._/-]+$/).nullable().optional(),
  status: verificationStatusSchema,
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime(),
  subject: verificationSubjectSchema,
  identity: verificationIdentitySchema,
  inputs: z.record(z.unknown()),
  checks: z.array(verificationCheckSchema),
  metrics: z.array(verificationMetricSchema),
  diagnostics: z.array(z.object({
    code: z.string().min(1),
    severity: verificationSeveritySchema,
    message: z.string().min(1),
    source: z.string().min(1).optional(),
    details: z.record(z.unknown()).optional()
  })),
  artifacts: z.array(verificationArtifactSchema),
  evidenceClassification: evidenceClassificationSchema,
  completeness: verificationCompletenessSchema,
  hardGateFailures: z.array(hardGateFailureSchema),
  summary: verificationSummarySchema,
  children: z.array(z.object({
    verificationId: z.string().regex(/^[A-Za-z0-9._/-]+$/),
    verifierType: verifierTypeSchema,
    status: verificationStatusSchema,
    resultPath: z.string().min(1)
  })).optional(),
  details: z.record(z.unknown()).optional()
});

/**
 * A verification manifest is deliberately a bridge around the existing
 * ArtifactRepository/JobArtifactSnapshotService. It is not a second target
 * job engine or a replacement for the canonical job manifest.
 */
export const verificationArtifactManifestSchema = z.object({
  schemaVersion: z.literal(VERIFICATION_SCHEMA_VERSION),
  kind: z.literal("verification-artifact-manifest"),
  verificationId: z.string().regex(/^[A-Za-z0-9._/-]+$/),
  verifierType: verifierTypeSchema,
  jobId: z.string().min(1).nullable().optional(),
  resultPath: z.string().min(1),
  verificationPath: z.string().min(1),
  artifacts: z.array(verificationArtifactSchema),
  completeness: verificationCompletenessSchema,
  createdAt: z.string().datetime()
});

export const verificationIndexSchema = z.object({
  schemaVersion: z.literal(VERIFICATION_SCHEMA_VERSION),
  entries: z.record(z.object({
    resultPath: z.string().min(1),
    manifestPath: z.string().min(1),
    verifierType: verifierTypeSchema,
    jobId: z.string().min(1).nullable().optional(),
    updatedAt: z.string().datetime()
  }))
});

export type VerificationStatus = z.infer<typeof verificationStatusSchema>;
export type VerificationCheckStatus = z.infer<typeof verificationCheckStatusSchema>;
export type VerificationSeverity = z.infer<typeof verificationSeveritySchema>;
export type VerifierType = z.infer<typeof verifierTypeSchema>;
export type VerificationSubject = z.infer<typeof verificationSubjectSchema>;
export type VerificationIdentity = z.infer<typeof verificationIdentitySchema>;
export type VerificationCheck = z.infer<typeof verificationCheckSchema>;
export type VerificationMetric = z.infer<typeof verificationMetricSchema>;
export type VerificationArtifact = z.infer<typeof verificationArtifactSchema>;
export type VerificationCompleteness = z.infer<typeof verificationCompletenessSchema>;
export type HardGateFailure = z.infer<typeof hardGateFailureSchema>;
export type VerificationSummary = z.infer<typeof verificationSummarySchema>;
export type VerificationResult = z.infer<typeof verificationResultSchema>;
export type VerificationArtifactManifest = z.infer<typeof verificationArtifactManifestSchema>;
export type VerificationIndex = z.infer<typeof verificationIndexSchema>;
