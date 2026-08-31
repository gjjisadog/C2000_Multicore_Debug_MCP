import { z } from "zod";

export const MAP_SCHEMA_VERSION = 1 as const;

export const mapRegionSchema = z.object({
  name: z.string().min(1),
  origin: z.number().int().nonnegative(),
  length: z.number().int().nonnegative(),
  used: z.number().int().nonnegative(),
  unused: z.number().int().nonnegative(),
  page: z.number().int().nonnegative().nullable(),
  utilizationPct: z.number().finite().nonnegative()
});

export const mapSectionSchema = z.object({
  name: z.string().min(1),
  size: z.number().int().nonnegative(),
  loadAddress: z.number().int().nonnegative().nullable(),
  runAddress: z.number().int().nonnegative().nullable(),
  region: z.string().min(1).nullable(),
  page: z.number().int().nonnegative().nullable()
});

export const mapRulesSchema = z.object({
  maxRegionUtilization: z.record(z.number().finite().min(0).max(100)).default({}),
  requireSections: z.array(z.string().min(1)).default([]),
  forbiddenPlacements: z.array(z.union([
    z.string().min(1),
    z.object({ section: z.string().min(1), region: z.string().min(1).optional() })
  ])).default([]),
  maxSectionGrowthPercent: z.record(z.number().finite().nonnegative()).default({})
});

export const mapParseDocumentSchema = z.object({
  schemaVersion: z.literal(MAP_SCHEMA_VERSION),
  format: z.enum(["TI_EABI", "TI_COFF", "UNKNOWN"]),
  complete: z.boolean(),
  memoryTablePresent: z.boolean(),
  sectionTablePresent: z.boolean(),
  errors: z.array(z.string().min(1)),
  warnings: z.array(z.string().min(1)),
  regions: z.array(mapRegionSchema),
  sections: z.array(mapSectionSchema)
});

export const mapArtifactExpectationSchema = z.object({
  path: z.string().min(1).optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  mtimeMs: z.number().finite().nonnegative().optional(),
  buildId: z.string().min(1).optional()
});

export const mapVerificationInputSchema = z.object({
  mapPath: z.string().min(1).optional(),
  mapText: z.string().max(16 * 1024 * 1024).optional(),
  rules: mapRulesSchema.default({}),
  baselineMapPath: z.string().min(1).optional(),
  expectedArtifact: mapArtifactExpectationSchema.optional(),
  expectedBuildId: z.string().min(1).optional(),
  jobId: z.string().min(1).optional(),
  outputDir: z.string().min(1).optional(),
  verificationId: z.string().regex(/^[A-Za-z0-9._/-]+$/).optional(),
  parentVerificationId: z.string().regex(/^[A-Za-z0-9._/-]+$/).nullable().optional(),
  subjectId: z.string().min(1).optional(),
  required: z.boolean().default(true)
}).refine(value => Boolean(value.mapPath || value.mapText), {
  message: "map verification requires mapPath or mapText",
  path: ["mapPath"]
});

export const mapMetricSchema = z.object({
  name: z.string().min(1),
  unit: z.string(),
  value: z.number().finite().nullable(),
  region: z.string().min(1).optional(),
  section: z.string().min(1).optional()
});

export const mapResultSchema = z.object({
  schemaVersion: z.literal(MAP_SCHEMA_VERSION),
  status: z.enum(["PASSED", "FAILED", "BLOCKED", "UNSUPPORTED", "ERROR"]),
  mapPath: z.string().min(1).nullable(),
  artifact: mapArtifactExpectationSchema.nullable(),
  parse: mapParseDocumentSchema,
  metrics: z.array(mapMetricSchema),
  hardGateFailures: z.array(z.object({
    check: z.string().min(1),
    message: z.string().min(1),
    actual: z.unknown().optional(),
    expected: z.unknown().optional()
  })),
  durationMs: z.number().int().nonnegative()
});

export type MapRegion = z.infer<typeof mapRegionSchema>;
export type MapSection = z.infer<typeof mapSectionSchema>;
export type MapRules = z.infer<typeof mapRulesSchema>;
export type MapParseDocument = z.infer<typeof mapParseDocumentSchema>;
export type MapArtifactExpectation = z.infer<typeof mapArtifactExpectationSchema>;
export type MapVerificationInput = z.infer<typeof mapVerificationInputSchema>;
export type MapMetric = z.infer<typeof mapMetricSchema>;
export type MapResult = z.infer<typeof mapResultSchema>;
