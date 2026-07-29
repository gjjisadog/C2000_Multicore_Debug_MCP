import { z } from "zod";

export const ERAD_SCHEMA_VERSION = 1 as const;
export const ERAD_INTERNAL_TOOL = "__c2000_erad";

export const eradModeSchema = z.enum(["cycle-count", "event-count"]);
export const eradSysclkSourceSchema = z.enum(["firmware-variable", "board-profile", "user-config", "unknown"]);

export const eradIdentitySchema = z.object({
  boardId: z.string().min(1),
  sessionId: z.string().min(1),
  coreId: z.number().int().nonnegative()
});

export const eradResourceSelectionSchema = z.object({
  startBusComparator: z.number().int().min(1).max(8),
  endBusComparator: z.number().int().min(1).max(8),
  maxCounter: z.number().int().min(1).max(4),
  cumulativeCounter: z.number().int().min(1).max(4),
  eventCounter: z.number().int().min(1).max(4)
}).superRefine((value, context) => {
  if (value.startBusComparator === value.endBusComparator) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "start and end bus comparators must be distinct" });
  }
  if (new Set([value.maxCounter, value.cumulativeCounter, value.eventCounter]).size !== 3) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "max, cumulative, and event counters must be distinct" });
  }
});

export const getEradCapabilitiesSchema = eradIdentitySchema;

export const configureEradProfileSchema = eradIdentitySchema.extend({
  profileName: z.string().min(1).max(128).regex(/^[A-Za-z_][A-Za-z0-9_.-]*$/),
  startSymbol: z.string().min(1).max(512),
  endSymbol: z.string().min(1).max(512),
  mode: eradModeSchema,
  durationMs: z.number().int().min(1).max(600_000),
  timeoutMs: z.number().int().min(1).max(600_000).optional(),
  resources: eradResourceSelectionSchema.optional(),
  allowOverwrite: z.boolean().default(false),
  sysclkHz: z.number().int().positive().max(1_000_000_000).optional(),
  sysclkSource: eradSysclkSourceSchema.default("unknown")
});

export const eradProfileIdentitySchema = eradIdentitySchema.extend({
  profileId: z.string().min(1)
});

export const startEradProfileSchema = eradProfileIdentitySchema;
export const stopEradProfileSchema = eradProfileIdentitySchema.extend({
  disposition: z.enum(["stop", "cancel"]).default("stop")
});
export const readEradProfileSchema = eradProfileIdentitySchema;
export const exportEradProfileSchema = eradProfileIdentitySchema;

export const eradCapabilitiesSchema = z.object({
  schemaVersion: z.literal(ERAD_SCHEMA_VERSION),
  supported: z.boolean(),
  device: z.string(),
  supportedDevices: z.array(z.string()),
  addressUnitBits: z.literal(16),
  registerPage: z.literal("DATA"),
  busComparatorCount: z.number().int().nonnegative(),
  counterCount: z.number().int().nonnegative(),
  supportsPcRange: z.boolean(),
  supportsCycleCount: z.boolean(),
  supportsEventCount: z.boolean(),
  supportsMaxCycles: z.boolean(),
  supportsMinCycles: z.boolean(),
  supportsClaTaskTiming: z.literal(false),
  supportsInterruptNesting: z.literal(false),
  supportsCrossCoreSynchronization: z.literal(false),
  supportsIpcSingleCycleLatency: z.literal(false),
  ownership: z.enum(["NO_OWNER", "APPLICATION", "DEBUGGER", "UNKNOWN"]),
  occupiedBusComparators: z.array(z.number().int().min(1).max(8)),
  occupiedCounters: z.array(z.number().int().min(1).max(4)),
  reason: z.string().nullable()
});

export const eradProfileResultSchema = z.object({
  schemaVersion: z.literal(ERAD_SCHEMA_VERSION),
  profileId: z.string().min(1),
  boardId: z.string().min(1),
  sessionId: z.string().min(1),
  adapterSessionId: z.string().min(1),
  workerInstanceId: z.string().min(1),
  workerGeneration: z.number().int().positive(),
  coreId: z.number().int().nonnegative(),
  coreName: z.string().min(1),
  device: z.string().min(1),
  profileName: z.string().min(1),
  mode: eradModeSchema,
  resources: eradResourceSelectionSchema,
  startSymbol: z.string().min(1),
  startAddress: z.string().regex(/^0x[0-9a-f]+$/i),
  endSymbol: z.string().min(1),
  endAddress: z.string().regex(/^0x[0-9a-f]+$/i),
  sysclkHz: z.number().int().positive().nullable(),
  sysclkSource: eradSysclkSourceSchema,
  count: z.number().int().nonnegative().nullable(),
  totalCycles: z.number().int().nonnegative().nullable(),
  minCycles: z.number().int().nonnegative().nullable(),
  minCyclesSource: z.literal("unavailable-on-f28p65x-erad"),
  maxCycles: z.number().int().nonnegative().nullable(),
  meanCycles: z.number().nonnegative().nullable(),
  minSeconds: z.number().nonnegative().nullable(),
  maxSeconds: z.number().nonnegative().nullable(),
  meanSeconds: z.number().nonnegative().nullable(),
  overflowCount: z.number().int().nonnegative(),
  overflowResources: z.array(z.string()),
  observationDurationMs: z.number().nonnegative(),
  completeness: z.enum(["COMPLETE", "INCOMPLETE"]),
  incompleteReason: z.string().nullable(),
  restoreStatus: z.enum(["NOT_REQUIRED", "RESTORED", "FAILED", "INVALIDATED"]),
  firmwareHashes: z.object({
    outSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    mapSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    source: z.enum(["session-snapshot", "unavailable"])
  }),
  evidenceClassification: z.enum(["MOCK", "HARDWARE_TARGET"])
});

export const internalEradCommandSchema = z.object({
  operation: z.enum(["capabilities", "resolve", "configure", "start", "stop-read-restore", "restore"]),
  sessionId: z.string().min(1),
  coreId: z.number().int().nonnegative(),
  device: z.string().min(1),
  profileId: z.string().optional(),
  startSymbol: z.string().optional(),
  endSymbol: z.string().optional(),
  startAddress: z.number().int().nonnegative().optional(),
  endAddress: z.number().int().nonnegative().optional(),
  resources: eradResourceSelectionSchema.optional(),
  allowOverwrite: z.boolean().optional(),
  savedConfiguration: z.record(z.unknown()).optional()
});

export type EradConfigureRequest = z.infer<typeof configureEradProfileSchema>;
export type EradResourceSelection = z.infer<typeof eradResourceSelectionSchema>;
export type EradCapabilities = z.infer<typeof eradCapabilitiesSchema>;
export type EradProfileResult = z.infer<typeof eradProfileResultSchema>;
