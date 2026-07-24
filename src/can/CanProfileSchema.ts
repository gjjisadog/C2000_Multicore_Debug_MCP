import { z } from "zod";

const endpointSchema = z.object({
  boardId: z.string().min(1).optional(),
  role: z.string().min(1).optional(),
  coreId: z.number().int(),
  expression: z.string().min(1)
}).superRefine((value, context) => {
  if (!value.boardId && !value.role) context.addIssue({ code: z.ZodIssueCode.custom, message: "Endpoint requires boardId or role" });
});

const canFrameSchema = z.object({
  id: z.number().int().min(0).max(0x1fffffff),
  data: z.array(z.number().int().min(0).max(0xff)).max(8),
  extended: z.boolean().default(false)
});

const canDirectionSchema = z.object({
  sourceBoardId: z.string().min(1),
  targetBoardId: z.string().min(1),
  frames: z.array(canFrameSchema).min(1),
  /** A false expectation is used for intentional-loss fault tests. */
  expectDelivery: z.boolean().default(true)
});

export const canFaultScenarioSchema = z.object({
  name: z.string().min(1),
  kind: z.enum(["drop", "delay", "jitter", "duplicate", "bus_off", "node_leave", "node_rejoin", "crc_error"]),
  sourceBoardId: z.string().min(1).optional(),
  targetBoardId: z.string().min(1).optional(),
  everyNth: z.number().int().positive().optional(),
  delayMs: z.number().int().nonnegative().optional(),
  jitterMs: z.number().int().nonnegative().optional()
});

const observationValueSchema = z.union([z.string(), z.number(), z.boolean()]);
const canObservationSchema = z.object({
  boardId: z.string().min(1),
  coreId: z.number().int(),
  expressions: z.array(z.object({
    expression: z.string().min(1),
    expected: observationValueSchema.optional()
  })).min(1)
});

export const crossBoardComparisonSchema = z.object({
  name: z.string().min(1),
  left: endpointSchema,
  right: endpointSchema.optional(),
  operator: z.enum(["EQUAL", "NOT_EQUAL", "GREATER_THAN", "GREATER_THAN_OR_EQUAL", "LESS_THAN", "LESS_THAN_OR_EQUAL", "WITHIN", "MONOTONIC", "DELTA", "BOOLEAN"]),
  expected: observationValueSchema.optional(),
  tolerance: z.number().nonnegative().optional(),
  sampleCount: z.number().int().positive().max(100).default(1),
  intervalMs: z.number().int().nonnegative().max(60_000).default(0)
}).superRefine((value, context) => {
  if (!["BOOLEAN", "MONOTONIC"].includes(value.operator) && !value.right) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: `${value.operator} comparison requires a right endpoint` });
  }
  if (value.operator === "BOOLEAN" && value.expected === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "BOOLEAN comparison requires expected" });
  }
});

const safetyGateSchema = z.object({
  name: z.string().min(1),
  endpoint: endpointSchema,
  expected: observationValueSchema,
  description: z.string().min(1).optional()
});

const canTestHookSchema = z.object({
  name: z.string().min(1),
  kind: z.enum(["pause_communication", "resume_communication", "trigger_traffic", "reset_rejoin"]),
  endpoint: endpointSchema,
  setExpression: z.string().min(1).optional(),
  setValue: observationValueSchema.optional(),
  readbackExpression: z.string().min(1).optional(),
  clearExpression: z.string().min(1).optional(),
  clearValue: observationValueSchema.optional()
});

const evidenceFeatureSchema = z.object({ enabled: z.boolean().default(false), required: z.boolean().default(false) });

const profileRoleSchema = z.object({
  role: z.string().min(1),
  boardId: z.string().min(1).optional(),
  nodeId: z.number().int().nonnegative().optional(),
  channel: z.string().min(1).optional()
});

export const canAcceptanceProfileSchema = z.object({
  /** Stable logical profile identity; inline legacy input is still registered and hashed. */
  profileId: z.string().min(1).default("inline-can-acceptance"),
  version: z.number().int().positive().default(1),
  /** Hardware is the safe default: it fails closed until a physical adapter is configured. */
  adapter: z.enum(["hardware", "mock"]).default("hardware"),
  bus: z.object({ name: z.string().min(1).default("can0"), channel: z.string().min(1).optional(), nominalBitrate: z.number().int().positive().optional() }).default({ name: "can0" }),
  roles: z.array(profileRoleSchema).max(2).default([]),
  directions: z.array(canDirectionSchema).min(2),
  faults: z.array(canFaultScenarioSchema).default([]),
  observations: z.array(canObservationSchema).default([]),
  comparisons: z.array(crossBoardComparisonSchema).default([]),
  safety: z.object({ required: z.boolean().default(false), gates: z.array(safetyGateSchema).default([]) }).default({ required: false, gates: [] }),
  testHooks: z.array(canTestHookSchema).default([]),
  evidence: z.object({
    sequence: evidenceFeatureSchema.default({ enabled: false, required: false }),
    crc: evidenceFeatureSchema.default({ enabled: false, required: false }),
    heartbeat: evidenceFeatureSchema.default({ enabled: false, required: false }),
    timeout: evidenceFeatureSchema.default({ enabled: true, required: false })
  }).default({ sequence: { enabled: false, required: false }, crc: { enabled: false, required: false }, heartbeat: { enabled: false, required: false }, timeout: { enabled: true, required: false } }),
  requireIndependentBusVerification: z.boolean().default(false),
  autoRunCores: z.boolean().default(true),
  runCoreIds: z.array(z.number().int()).min(1).default([0, 2]),
  barrierTimeoutMs: z.number().int().positive().default(15000),
  timeoutMs: z.number().int().positive().default(5000)
}).superRefine((profile, context) => {
  if (profile.roles.length > 0 && new Set(profile.roles.map(role => role.role)).size !== profile.roles.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "CAN profile roles must be unique" });
  }
  if (profile.safety.required && profile.safety.gates.length === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "A safety-required CAN profile must declare read-only safety gates" });
  }
  if (profile.version >= 2 && profile.safety.gates.length === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "CAN profile version 2+ must declare safety gates; variable names remain profile-defined" });
  }
});

export type CanAcceptanceProfile = z.infer<typeof canAcceptanceProfileSchema>;
export type CanFaultScenario = z.infer<typeof canFaultScenarioSchema>;
export type CrossBoardComparison = z.infer<typeof crossBoardComparisonSchema>;
export type CanEndpoint = z.infer<typeof endpointSchema>;
