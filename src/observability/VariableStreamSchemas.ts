import { z } from "zod";

export const VARIABLE_STREAM_SCHEMA_VERSION = 1 as const;
export const VARIABLE_STREAM_INTERNAL_TOOL = "__c2000_readVariableBatch";

export const variableRequestSchema = z.union([
  z.string().min(1),
  z.object({
    symbol: z.string().min(1),
    typeName: z.string().min(1),
    enumSignedness: z.enum(["signed", "unsigned"]).optional()
  })
]);

export const startVariableStreamSchema = z.object({
  boardId: z.string().min(1),
  sessionId: z.string().min(1),
  coreId: z.number().int().nonnegative(),
  variables: z.array(variableRequestSchema).min(1).max(32),
  samplePeriodMs: z.number().int().min(10).max(5000),
  durationMs: z.number().int().min(10).max(600_000),
  maxSamples: z.number().int().positive().max(100_000),
  maxArtifactBytes: z.number().int().positive().max(64 * 1024 * 1024).default(64 * 1024 * 1024)
});

export const variableStreamIdentitySchema = z.object({
  streamId: z.string().min(1),
  boardId: z.string().min(1),
  sessionId: z.string().min(1),
  coreId: z.number().int().nonnegative()
});

export const stopVariableStreamSchema = variableStreamIdentitySchema.extend({
  cancel: z.boolean().default(false)
});
export const getVariableStreamStatusSchema = variableStreamIdentitySchema;
export const exportVariableStreamSchema = variableStreamIdentitySchema;
export const readVariableSamplesSchema = variableStreamIdentitySchema.extend({
  afterSequence: z.number().int().nonnegative().default(0),
  limit: z.number().int().positive().max(1000).default(100)
});

export const internalVariableBatchSchema = z.object({
  sessionId: z.string().min(1),
  coreId: z.number().int().nonnegative(),
  expressions: z.array(z.string().min(1)).min(1).max(96),
  timeoutMs: z.number().int().min(50).max(1000)
});

export const variableMetadataSchema = z.object({
  symbol: z.string().min(1),
  resolvedAddress: z.string().regex(/^0x[0-9a-f]+$/i),
  typeName: z.string().min(1),
  byteWidth: z.union([z.literal(2), z.literal(4)]),
  addressUnits: z.union([z.literal(1), z.literal(2)]),
  addressUnitBits: z.literal(16),
  signedness: z.enum(["signed", "unsigned", "not-applicable"]),
  encoding: z.enum(["signed-integer", "unsigned-integer", "ieee754-binary32", "enum"]),
  coreId: z.number().int().nonnegative(),
  coreName: z.string().min(1)
});

export const variableReadSchema = z.object({
  status: z.enum(["OK", "ERROR"]),
  value: z.union([z.number(), z.string(), z.null()]),
  error: z.object({ code: z.string(), message: z.string() }).optional()
});

export const variableSampleSchema = z.object({
  schemaVersion: z.literal(VARIABLE_STREAM_SCHEMA_VERSION),
  streamId: z.string().min(1),
  sequence: z.number().int().positive(),
  boardId: z.string().min(1),
  sessionId: z.string().min(1),
  coreId: z.number().int().nonnegative(),
  coreName: z.string().min(1),
  timestamp: z.string().datetime(),
  monotonicTimestampNs: z.string().regex(/^\d+$/),
  pollingStartedAt: z.string().datetime(),
  pollingEndedAt: z.string().datetime(),
  readDurationMs: z.number().nonnegative(),
  actualHostIntervalMs: z.number().nonnegative().nullable(),
  targetSampleTime: z.null(),
  variables: z.record(variableReadSchema)
});

export const variableStreamStatsSchema = z.object({
  requestedSamplePeriodMs: z.number().positive(),
  actualHostIntervalMs: z.object({
    last: z.number().nonnegative().nullable(),
    min: z.number().nonnegative().nullable(),
    max: z.number().nonnegative().nullable(),
    mean: z.number().nonnegative().nullable()
  }),
  missedPollCount: z.number().int().nonnegative(),
  overrunCount: z.number().int().nonnegative(),
  readErrorCount: z.number().int().nonnegative(),
  droppedSampleCount: z.number().int().nonnegative(),
  totalSamples: z.number().int().nonnegative()
});

export type StartVariableStreamInput = z.infer<typeof startVariableStreamSchema>;
export type VariableStreamIdentity = z.infer<typeof variableStreamIdentitySchema>;
export type ReadVariableSamplesInput = z.infer<typeof readVariableSamplesSchema>;
export type VariableMetadata = z.infer<typeof variableMetadataSchema>;
export type VariableSample = z.infer<typeof variableSampleSchema>;
export type VariableStreamStats = z.infer<typeof variableStreamStatsSchema>;
