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

export const readClaTaskTimingSchema = eradIdentitySchema.extend({
  taskNumber: z.number().int().min(1).max(8),
  recordSymbol: z.string().min(1).max(512)
    .regex(/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/),
  timerSource: z.string().trim().min(1).max(128).default("EPWM1.TBCTR"),
  timerHz: z.number().int().positive().max(1_000_000_000),
  timerPeriodCycles: z.number().int().min(2).max(4_294_967_296).default(65_536),
  snapshotAttempts: z.number().int().min(1).max(10).default(5)
});

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

export const claTaskTimingResultSchema = z.object({
  schemaVersion: z.literal(ERAD_SCHEMA_VERSION),
  measurementKind: z.literal("cla-task"),
  measurementSource: z.enum(["firmware-instrumented-timer", "mock-simulation"]),
  semantics: z.literal("task-entry-to-task-exit"),
  triggerLatencyIncluded: z.literal(false),
  profileName: z.string().min(1),
  recordSymbol: z.string().min(1),
  taskNumber: z.number().int().min(1).max(8),
  sequence: z.number().int().min(0).max(4_294_967_295),
  timerSource: z.string().min(1),
  timerHz: z.number().int().positive(),
  timerPeriodCycles: z.number().int().min(2).max(4_294_967_296),
  count: z.number().int().nonnegative(),
  lastCycles: z.number().int().nonnegative().nullable(),
  totalCycles: z.string().regex(/^\d+$/),
  minCycles: z.number().int().nonnegative().nullable(),
  maxCycles: z.number().int().nonnegative().nullable(),
  meanCycles: z.number().nonnegative().nullable(),
  lastSeconds: z.number().nonnegative().nullable(),
  totalSeconds: z.number().nonnegative(),
  minSeconds: z.number().nonnegative().nullable(),
  maxSeconds: z.number().nonnegative().nullable(),
  meanSeconds: z.number().nonnegative().nullable(),
  overflowCount: z.number().int().nonnegative(),
  completeness: z.enum(["COMPLETE", "INCOMPLETE"]),
  incompleteReason: z.string().nullable(),
  capturedAt: z.string().datetime(),
  firmwareHashes: z.object({
    outSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    mapSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    source: z.enum(["session-snapshot", "unavailable"])
  }),
  evidenceClassification: z.enum(["MOCK", "HARDWARE_TARGET"])
});

export const internalEradCommandSchema = z.object({
  operation: z.enum(["capabilities", "resolve", "configure", "start", "stop-read-restore", "restore", "cla-timing-read"]),
  sessionId: z.string().min(1),
  coreId: z.number().int().nonnegative(),
  device: z.string().min(1),
  profileId: z.string().optional(),
  startSymbol: z.string().optional(),
  endSymbol: z.string().optional(),
  startAddress: z.number().int().nonnegative().optional(),
  endAddress: z.number().int().nonnegative().optional(),
  recordSymbol: z.string().min(1).max(512)
    .regex(/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/).optional(),
  taskNumber: z.number().int().min(1).max(8).optional(),
  snapshotAttempts: z.number().int().min(1).max(10).optional(),
  resources: eradResourceSelectionSchema.optional(),
  allowOverwrite: z.boolean().optional(),
  savedConfiguration: z.record(z.unknown()).optional()
});

export type EradConfigureRequest = z.infer<typeof configureEradProfileSchema>;
export type EradResourceSelection = z.infer<typeof eradResourceSelectionSchema>;
export type EradCapabilities = z.infer<typeof eradCapabilitiesSchema>;
export type EradProfileResult = z.infer<typeof eradProfileResultSchema>;
export type ClaTaskTimingRequest = z.infer<typeof readClaTaskTimingSchema>;
export type ClaTaskTimingResult = z.infer<typeof claTaskTimingResultSchema>;
