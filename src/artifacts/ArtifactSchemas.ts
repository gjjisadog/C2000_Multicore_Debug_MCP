import { z } from "zod";

export const ARTIFACT_SCHEMA_VERSION = 1 as const;

export const artifactCompletenessSchema = z.enum(["COMPLETE", "INCOMPLETE", "ARTIFACT_FAILED"]);
export const evidenceClassificationSchema = z.enum(["MOCK", "HARDWARE_TARGET", "HARDWARE_BUS", "MIXED", "UNKNOWN"]);

export const artifactCoreIdentitySchema = z.object({
  coreId: z.number().int().nonnegative(),
  coreName: z.string().min(1)
});

export const programEvidenceSchema = z.object({
  coreId: z.number().int().nonnegative(),
  coreName: z.string().min(1),
  outPath: z.string().min(1),
  outSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  mapPath: z.string().min(1).nullable(),
  mapSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable()
});

export const artifactTargetSchema = z.object({
  boardId: z.string().min(1),
  boardProfile: z.object({
    device: z.string().min(1),
    tags: z.array(z.string())
  }),
  xds110Serial: z.string().min(1),
  adapterType: z.enum(["mock", "ccs", "auto"]),
  workerGeneration: z.number().int().positive().nullable(),
  adapterSessionId: z.string().min(1).nullable(),
  sessionId: z.string().min(1).nullable(),
  cores: z.array(artifactCoreIdentitySchema),
  programs: z.array(programEvidenceSchema)
});

export const artifactManifestSchema = z.object({
  schemaVersion: z.literal(ARTIFACT_SCHEMA_VERSION),
  jobId: z.string().min(1),
  jobType: z.string().min(1),
  targets: z.array(artifactTargetSchema).min(1),
  mcpVersion: z.string().min(1),
  nodeVersion: z.string().min(1),
  operatingSystem: z.object({
    platform: z.string().min(1),
    release: z.string().min(1),
    architecture: z.string().min(1)
  }),
  ccsVersion: z.string().nullable(),
  configSummary: z.record(z.unknown()),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime(),
  evidenceLevel: evidenceClassificationSchema,
  completeness: z.object({
    status: artifactCompletenessSchema,
    reason: z.string().min(1).nullable()
  }),
  generatedFiles: z.array(z.object({
    path: z.string().min(1),
    artifactType: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    size: z.number().int().nonnegative(),
    completeness: z.enum(["COMPLETE", "INCOMPLETE", "ARTIFACT_FAILED"])
  })).optional()
});

export const artifactAssertionSchema = z.object({
  name: z.string().min(1),
  status: z.enum(["PASSED", "FAILED", "SKIPPED"]),
  message: z.string().optional()
});

export const artifactResultSchema = z.object({
  schemaVersion: z.literal(ARTIFACT_SCHEMA_VERSION),
  jobId: z.string().min(1),
  overallStatus: z.string().min(1),
  errorCode: z.string().min(1).nullable(),
  failedStep: z.object({
    boardId: z.string().min(1),
    stepIndex: z.number().int().nonnegative(),
    stepType: z.string().min(1)
  }).nullable(),
  assertions: z.array(artifactAssertionSchema),
  evidenceClassification: evidenceClassificationSchema,
  cancelled: z.boolean(),
  timedOut: z.boolean(),
  incompleteReason: z.string().min(1).nullable()
});

export const artifactEventSchema = z.object({
  schemaVersion: z.literal(ARTIFACT_SCHEMA_VERSION),
  sequence: z.number().int().positive(),
  jobId: z.string().min(1),
  eventType: z.string().min(1),
  timestamp: z.string().datetime(),
  monotonicTimestampNs: z.string().regex(/^\d+$/),
  source: z.object({
    type: z.string().min(1),
    id: z.string().min(1)
  }),
  boardId: z.string().min(1).nullable(),
  workerGeneration: z.number().int().positive().nullable(),
  adapterSessionId: z.string().min(1).nullable(),
  sessionId: z.string().min(1).nullable(),
  coreId: z.number().int().nonnegative().nullable(),
  coreName: z.string().min(1).nullable(),
  payload: z.record(z.unknown())
});

export const targetStateEventSchema = z.object({
  schemaVersion: z.literal(ARTIFACT_SCHEMA_VERSION),
  sequence: z.number().int().positive(),
  jobId: z.string().min(1),
  timestamp: z.string().datetime(),
  boardId: z.string().min(1),
  workerGeneration: z.number().int().positive().nullable(),
  adapterSessionId: z.string().min(1).nullable(),
  sessionId: z.string().min(1),
  cores: z.array(z.record(z.unknown()))
});

export type ArtifactManifest = z.infer<typeof artifactManifestSchema>;
export type ArtifactResult = z.infer<typeof artifactResultSchema>;
export type ArtifactEvent = z.infer<typeof artifactEventSchema>;
export type TargetStateEvent = z.infer<typeof targetStateEventSchema>;
