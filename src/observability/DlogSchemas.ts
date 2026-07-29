import { z } from "zod";

export const DLOG_SCHEMA_VERSION = 1 as const;
export const DLOG_EXPRESSION_BATCH_TOOL = "__c2000_readDlogExpressionBatch";

export const dlogElementTypeSchema = z.enum(["float32", "uint16", "int16", "uint32", "int32"]);
export const dlogLayoutSchema = z.enum(["structure-of-arrays", "array-of-structures"]);
export const dlogSampleRateSourceSchema = z.enum(["user-config", "firmware-variable", "project-config"]);

export const dlogChannelSchema = z.object({
  name: z.string().min(1).max(128).regex(/^[A-Za-z_][A-Za-z0-9_.-]*$/),
  symbol: z.string().min(1).max(512),
  type: dlogElementTypeSchema,
  unit: z.string().max(64).default("")
});

export const dlogBufferRequestSchema = z.object({
  boardId: z.string().min(1),
  sessionId: z.string().min(1),
  coreId: z.number().int().nonnegative(),
  bufferSymbol: z.string().min(1).max(512),
  stateSymbol: z.string().min(1).max(512),
  writeIndexSymbol: z.string().min(1).max(512),
  triggerIndexSymbol: z.string().min(1).max(512),
  generationSymbol: z.string().min(1).max(512).optional(),
  sampleCount: z.number().int().positive().max(65_536),
  sampleRateHz: z.number().positive().max(10_000_000),
  sampleRateSource: dlogSampleRateSourceSchema.default("user-config"),
  sampleRateSymbol: z.string().min(1).max(512).optional(),
  layout: dlogLayoutSchema,
  channels: z.array(dlogChannelSchema).min(1).max(32),
  writeIndexMeaning: z.literal("next-write").default("next-write"),
  triggerIndexMeaning: z.literal("trigger-sample").default("trigger-sample"),
  preTriggerSamples: z.number().int().nonnegative().optional(),
  postTriggerSamples: z.number().int().nonnegative().optional(),
  maxReadRetries: z.number().int().min(0).max(3).default(2),
  maxArtifactBytes: z.number().int().positive().max(64 * 1024 * 1024).default(64 * 1024 * 1024)
});

export const internalDlogExpressionBatchSchema = z.object({
  sessionId: z.string().min(1),
  coreId: z.number().int().nonnegative(),
  expressions: z.array(z.string().min(1)).min(1).max(96),
  timeoutMs: z.number().int().min(50).max(5000)
});

export const dlogChannelMetadataSchema = dlogChannelSchema.extend({
  resolvedAddress: z.string().regex(/^0x[0-9a-f]+$/i),
  elementWidthBits: z.union([z.literal(16), z.literal(32)]),
  elementWidthOctets: z.union([z.literal(2), z.literal(4)]),
  addressUnitsPerElement: z.union([z.literal(1), z.literal(2)]),
  addressUnitBits: z.literal(16),
  totalAddressUnits: z.number().int().positive(),
  totalOctets: z.number().int().positive()
});

export const dlogStatusSnapshotSchema = z.object({
  state: z.union([z.string(), z.number()]),
  writeIndex: z.number().int().nonnegative(),
  triggerIndex: z.number().int().nonnegative(),
  generation: z.union([z.string(), z.number(), z.null()]),
  sampleRateHz: z.number().positive(),
  timestamp: z.string().datetime(),
  monotonicTimestampNs: z.string().regex(/^\d+$/)
});

export const dlogDescriptorSchema = z.object({
  schemaVersion: z.literal(DLOG_SCHEMA_VERSION),
  boardId: z.string().min(1),
  sessionId: z.string().min(1),
  adapterSessionId: z.string().min(1),
  workerInstanceId: z.string().min(1),
  workerGeneration: z.number().int().positive(),
  coreId: z.number().int().nonnegative(),
  coreName: z.string().min(1),
  bufferSymbol: z.string().min(1),
  bufferAddress: z.string().regex(/^0x[0-9a-f]+$/i),
  layout: z.literal("structure-of-arrays"),
  sampleCount: z.number().int().positive(),
  sampleRateHz: z.number().positive(),
  sampleRateSource: dlogSampleRateSourceSchema,
  channels: z.array(dlogChannelMetadataSchema).min(1),
  totalReadOctets: z.number().int().positive(),
  totalReadAddressUnits: z.number().int().positive(),
  targetAddressUnitBits: z.literal(16)
});

export const dlogCaptureSchema = z.object({
  schemaVersion: z.literal(DLOG_SCHEMA_VERSION),
  captureId: z.string().min(1),
  boardId: z.string().min(1),
  sessionId: z.string().min(1),
  adapterSessionId: z.string().min(1),
  workerInstanceId: z.string().min(1),
  workerGeneration: z.number().int().positive(),
  coreId: z.number().int().nonnegative(),
  coreName: z.string().min(1),
  layout: z.literal("structure-of-arrays"),
  sampleCount: z.number().int().positive(),
  exportedSampleCount: z.number().int().positive(),
  sampleRateHz: z.number().positive(),
  sampleRateSource: dlogSampleRateSourceSchema,
  sampleTimeBasis: z.literal("configured-relative-time"),
  channelMetadata: z.array(dlogChannelMetadataSchema).min(1),
  rawIndices: z.object({
    writeIndex: z.number().int().nonnegative(),
    triggerIndex: z.number().int().nonnegative(),
    writeIndexMeaning: z.literal("next-write"),
    triggerIndexMeaning: z.literal("trigger-sample")
  }),
  normalizedOrder: z.array(z.number().int().nonnegative()).min(1),
  consistency: z.object({
    status: z.enum(["CONSISTENT", "INCONSISTENT"]),
    attempts: z.number().int().positive(),
    before: dlogStatusSnapshotSchema,
    after: dlogStatusSnapshotSchema,
    changedFields: z.array(z.enum(["state", "writeIndex", "triggerIndex", "generation", "sampleRateHz"]))
  }),
  readDurationMs: z.number().nonnegative(),
  firmwareHashes: z.object({
    outSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    mapSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    source: z.enum(["session-snapshot", "unavailable"])
  }),
  evidenceClassification: z.enum(["MOCK", "HARDWARE_TARGET"]),
  captureCompleteness: z.enum(["COMPLETE", "INCOMPLETE"]),
  incompleteReason: z.string().min(1).nullable(),
  sampleIndex: z.array(z.number().int().nonnegative()).min(1),
  relativeTimeSeconds: z.array(z.number().nonnegative()).min(1),
  channels: z.array(z.object({
    name: z.string().min(1),
    unit: z.string(),
    type: dlogElementTypeSchema,
    values: z.array(z.number())
  })).min(1)
});

export type DlogBufferRequest = z.infer<typeof dlogBufferRequestSchema>;
export type DlogDescriptor = z.infer<typeof dlogDescriptorSchema>;
export type DlogStatusSnapshot = z.infer<typeof dlogStatusSnapshotSchema>;
export type DlogCapture = z.infer<typeof dlogCaptureSchema>;
