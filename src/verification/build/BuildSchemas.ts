import { z } from "zod";
import { verificationIdentitySchema } from "../VerificationSchemas.js";

export const BUILD_SCHEMA_VERSION = 1 as const;

export const buildStatusSchema = z.enum(["PASSED", "FAILED", "BLOCKED", "UNSUPPORTED", "ERROR"]);
export const buildStageSchema = z.enum(["inspect", "preflight", "compile", "link", "post-link", "unknown"]);
export const buildErrorCategorySchema = z.enum([
  "COMPILE_ERROR",
  "LINK_ERROR",
  "ABI_MISMATCH",
  "UNRESOLVED_SYMBOL",
  "MULTIPLE_DEFINITION",
  "SECTION_OVERFLOW",
  "MEMORY_PLACEMENT",
  "MISSING_FILE",
  "TOOLCHAIN_NOT_FOUND",
  "PROJECT_CONFIG_ERROR",
  "TIMEOUT",
  "UNKNOWN"
]);

export const buildDiagnosticSchema = z.object({
  tool: z.string().min(1),
  code: z.string().min(1).nullable(),
  category: buildErrorCategorySchema,
  message: z.string().min(1),
  file: z.string().min(1).nullable(),
  line: z.number().int().positive().nullable(),
  column: z.number().int().positive().nullable(),
  raw: z.string().min(1)
});

export const buildArtifactSchema = z.object({
  path: z.string().min(1),
  kind: z.enum(["out", "map", "log", "other"]),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  size: z.number().int().nonnegative(),
  mtimeMs: z.number().finite().nonnegative(),
  buildId: z.string().min(1).optional()
});

export const buildArtifactSetSchema = z.object({
  out: buildArtifactSchema.nullable(),
  map: buildArtifactSchema.nullable(),
  log: buildArtifactSchema.nullable()
});

export const buildIdentitySchema = verificationIdentitySchema.extend({
  project: z.string().min(1).nullable().optional(),
  target: z.string().min(1),
  configuration: z.string().min(1),
  device: z.string().min(1).nullable().optional(),
  ccsVersion: z.string().min(1).nullable().optional(),
  compilerVersion: z.string().min(1).nullable().optional(),
  abi: z.string().min(1).nullable().optional(),
  gitCommit: z.string().min(1).nullable().optional(),
  toolVersion: z.string().min(1),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime()
});

export const buildResultSchema = z.object({
  schemaVersion: z.literal(BUILD_SCHEMA_VERSION),
  status: buildStatusSchema,
  stage: buildStageSchema,
  target: z.string().min(1),
  configuration: z.string().min(1),
  errors: z.array(buildDiagnosticSchema),
  warnings: z.array(buildDiagnosticSchema),
  counts: z.object({ errors: z.number().int().nonnegative(), warnings: z.number().int().nonnegative() }),
  artifacts: buildArtifactSetSchema,
  durationMs: z.number().int().nonnegative(),
  identity: buildIdentitySchema,
  providerId: z.string().min(1),
  logComplete: z.boolean()
});

export const buildVerificationInputSchema = z.object({
  projectPath: z.string().min(1).optional(),
  project: z.string().min(1).optional(),
  target: z.string().min(1).default("F28P65x"),
  configuration: z.string().min(1).default("FLASH"),
  providerId: z.string().min(1).default("artifact"),
  buildLogPath: z.string().min(1).optional(),
  buildLogText: z.string().max(8 * 1024 * 1024).optional(),
  outPath: z.string().min(1).optional(),
  mapPath: z.string().min(1).optional(),
  ccsVersion: z.string().min(1).nullable().optional(),
  compilerVersion: z.string().min(1).nullable().optional(),
  abi: z.string().min(1).nullable().optional(),
  device: z.string().min(1).nullable().optional(),
  gitCommit: z.string().min(1).nullable().optional(),
  sourceIdentity: z.string().min(1).nullable().optional(),
  jobId: z.string().min(1).optional(),
  outputDir: z.string().min(1).optional(),
  verificationId: z.string().regex(/^[A-Za-z0-9._/-]+$/).optional(),
  parentVerificationId: z.string().regex(/^[A-Za-z0-9._/-]+$/).nullable().optional()
}).refine(value => Boolean(value.buildLogPath || value.buildLogText || value.providerId !== "artifact"), {
  message: "artifact build verification requires buildLogPath or buildLogText",
  path: ["buildLogPath"]
});

export type BuildStatus = z.infer<typeof buildStatusSchema>;
export type BuildStage = z.infer<typeof buildStageSchema>;
export type BuildErrorCategory = z.infer<typeof buildErrorCategorySchema>;
export type BuildDiagnostic = z.infer<typeof buildDiagnosticSchema>;
export type BuildArtifact = z.infer<typeof buildArtifactSchema>;
export type BuildResult = z.infer<typeof buildResultSchema>;
export type BuildVerificationInput = z.infer<typeof buildVerificationInputSchema>;
