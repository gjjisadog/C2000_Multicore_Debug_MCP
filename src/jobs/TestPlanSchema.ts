import { z } from "zod";
import { canAcceptanceProfileSchema } from "../can/CanProfileSchema.js";

export const testArtifactsSchema = z.object({
  cpu1OutPath: z.string().min(1),
  cpu2OutPath: z.string().min(1),
  cpu1MapPath: z.string().min(1).optional(),
  cpu2MapPath: z.string().min(1).optional(),
  outputDir: z.string().min(1).optional()
});

/** Omitted limits mean that a finite campaign records failures without aborting early. */
export const canHealthPolicySchema = z.object({
  maxConsecutiveFailures: z.number().int().nonnegative().optional(),
  maxFailureRate: z.number().min(0).max(1).optional()
}).default({});

const canExecutionSchema = z.object({
  mode: z.enum(["acceptance", "fault_campaign", "matrix", "soak"]).default("acceptance"),
  campaignId: z.string().min(1).optional(),
  iterations: z.number().int().positive().max(10_000).default(1),
  durationMs: z.number().int().positive().max(86_400_000).optional(),
  matrixCases: z.array(z.object({ name: z.string().min(1), faults: z.array(z.unknown()).optional(), metadata: z.record(z.unknown()).default({}) })).max(1_000).default([]),
  failFast: z.boolean().default(false),
  health: canHealthPolicySchema,
  resetOrRejoinRequested: z.boolean().default(false)
}).superRefine((execution, context) => {
  if (execution.mode === "matrix" && execution.matrixCases.length === 0) context.addIssue({ code: z.ZodIssueCode.custom, message: "matrix execution requires deterministic matrixCases" });
  if (execution.mode === "soak" && !execution.durationMs && execution.iterations <= 0) context.addIssue({ code: z.ZodIssueCode.custom, message: "soak execution must be finite by durationMs or iterations" });
});

export const jobStepTypeSchema = z.enum([
  "preflight",
  "launchMulticore",
  "assignExpressions",
  "injectFaults",
  "captureExpressions",
  "waitForExpressions",
  "resetReconnectCapture",
  "runIpcAcceptance",
  "runBootHandoffDiagnosis",
  "runReloadAndDiagnose",
  "runFullDebugBundle",
  "cleanup",
  "delay",
  "canAcceptance"
]);

const onSchema = z.enum(["always", "failure", "success"]);
const coreIdSchema = z.number().int().refine(value => value === 0 || value === 2, "F28P65x durable steps require coreId 0 (CPU1) or 2 (CPU2)");
const expressionValueSchema = z.union([z.string(), z.number(), z.boolean()]);
const expressionAssignmentStepSchema = z.object({
  coreId: coreIdSchema,
  expression: z.string().min(1),
  value: expressionValueSchema,
  verify: z.boolean().default(true)
}).strict();
const expressionFaultStepSchema = expressionAssignmentStepSchema.extend({ label: z.string().min(1).optional() }).strict();
const expressionReadStepSchema = z.object({
  label: z.string().min(1).optional(),
  coreId: coreIdSchema,
  expressions: z.array(z.string().min(1)).min(1)
}).strict();
const expressionConditionStepSchema = z.object({
  label: z.string().min(1).optional(),
  coreId: coreIdSchema,
  expression: z.string().min(1),
  expected: expressionValueSchema
}).strict();
const loadSequenceStepSchema = z.object({
  mode: z.enum(["cpu1-then-cpu2", "cpu1-run-before-cpu2"]).default("cpu1-then-cpu2"),
  cpu1SettleMs: z.number().int().nonnegative().default(250)
}).strict();
const loadPolicySchema = z.enum(["always", "if-changed", "verify-mcp-registry", "verify-only"]);
const baseStep = { on: onSchema.optional() };

/**
 * Durable plans are an RPC/SQLite contract, so every step is strict and
 * discriminated. Unknown or misspelled target-control fields fail closed.
 */
export const testPlanStepSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("preflight"), ...baseStep }).strict(),
  z.object({
    type: z.literal("launchMulticore"), ...baseStep,
    loadPrograms: z.boolean().default(true),
    loadSequence: loadSequenceStepSchema.default({ mode: "cpu1-then-cpu2", cpu1SettleMs: 250 })
  }).strict(),
  z.object({ type: z.literal("assignExpressions"), ...baseStep, assignments: z.array(expressionAssignmentStepSchema).min(1) }).strict(),
  z.object({ type: z.literal("injectFaults"), ...baseStep, faults: z.array(expressionFaultStepSchema).min(1) }).strict(),
  z.object({
    type: z.literal("captureExpressions"), ...baseStep,
    label: z.string().min(1).optional(),
    reads: z.array(expressionReadStepSchema).min(1),
    sampleCount: z.number().int().positive().max(10000).default(1),
    intervalMs: z.number().int().nonnegative().default(0)
  }).strict(),
  z.object({
    type: z.literal("waitForExpressions"), ...baseStep,
    conditions: z.array(expressionConditionStepSchema).min(1),
    timeoutMs: z.number().int().positive(),
    intervalMs: z.number().int().positive().default(100)
  }).strict(),
  z.object({
    type: z.literal("resetReconnectCapture"), ...baseStep,
    coreIds: z.array(coreIdSchema).min(1).refine(values => new Set(values).size === values.length, "coreIds must be unique"),
    resetType: z.enum(["cpu", "system", "restart", "default"]).default("cpu"),
    settleMs: z.number().int().nonnegative().default(250),
    reload: z.enum(["none", "symbols", "programs"]).default("symbols"),
    loadPolicy: loadPolicySchema.default("if-changed"),
    reads: z.array(expressionReadStepSchema).min(1)
  }).strict(),
  z.object({
    type: z.literal("runIpcAcceptance"), ...baseStep,
    timeoutMs: z.number().int().positive().optional(), intervalMs: z.number().int().positive().optional(),
    loadPolicy: loadPolicySchema.optional(), loadSequence: loadSequenceStepSchema.optional(),
    ipcReadyExpressions: z.array(expressionConditionStepSchema).min(1).optional(),
    verifyRuntimeRamOwnership: z.boolean().optional()
  }).strict(),
  z.object({ type: z.literal("runBootHandoffDiagnosis"), ...baseStep }).strict(),
  z.object({ type: z.literal("runReloadAndDiagnose"), ...baseStep, timeoutMs: z.number().int().positive().optional(), intervalMs: z.number().int().positive().optional() }).strict(),
  z.object({ type: z.literal("runFullDebugBundle"), ...baseStep }).strict(),
  z.object({ type: z.literal("cleanup"), ...baseStep }).strict(),
  z.object({ type: z.literal("delay"), ...baseStep, delayMs: z.number().int().nonnegative() }).strict(),
  z.object({ type: z.literal("canAcceptance"), ...baseStep }).strict()
]);

export const stepRetryPolicySchema = z.object({
  maxAttempts: z.number().int().positive().default(1),
  backoffMs: z.number().int().nonnegative().default(0),
  maxBackoffMs: z.number().int().nonnegative().default(30000),
  jitter: z.boolean().default(false),
  retryableErrors: z.array(z.string().min(1)).default([])
});

export const testPlanSchema = z.object({
  planVersion: z.literal(1),
  name: z.string().min(1),
  boardSelector: z.object({
    boardIds: z.array(z.string().min(1)).min(1).optional(),
    tags: z.array(z.string().min(1)).min(1).optional(),
    count: z.number().int().positive().optional()
  }).optional(),
  boardIds: z.array(z.string().min(1)).min(1).optional(),
  parallelism: z.number().int().positive().optional(),
  priority: z.enum(["SAFETY_RECOVERY", "INTERACTIVE_DEBUG", "ACCEPTANCE", "REGRESSION", "SOAK"]).default("REGRESSION"),
  /** Legacy/default firmware used when no more-specific board or role artifact is supplied. */
  artifacts: testArtifactsSchema.optional(),
  /** Highest-priority firmware assignment for a physical board id. */
  artifactsByBoard: z.record(testArtifactsSchema).optional(),
  /** Firmware assignment for a CAN profile role such as PRIMARY or SECONDARY. */
  artifactsByRole: z.record(testArtifactsSchema).optional(),
  can: z.object({
    /** Assigned by the job engine before persistence; callers do not choose durable identifiers. */
    groupId: z.string().min(1).optional(),
    profile: canAcceptanceProfileSchema,
    execution: canExecutionSchema.default({ mode: "acceptance", iterations: 1, matrixCases: [], failFast: false, health: {}, resetOrRejoinRequested: false })
  }).optional(),
  steps: z.array(testPlanStepSchema).min(1),
  retryPolicy: z.record(z.union([z.number().int().nonnegative(), stepRetryPolicySchema])).default({}),
  failurePolicy: z.object({
    continueHealthyBoards: z.boolean().default(true),
    quarantineFailedBoard: z.boolean().default(true),
    collectDebugBundle: z.boolean().default(true)
  }).default({ continueHealthyBoards: true, quarantineFailedBoard: true, collectDebugBundle: true }),
  recoveryPolicy: z.enum(["safe_restart_board", "manual_intervention_required"]).default("safe_restart_board")
}).strict().superRefine((plan, context) => {
  if (!plan.boardIds && !plan.boardSelector?.boardIds && !plan.boardSelector?.tags) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "plan must select boards by boardIds or boardSelector" });
  }
  const hasCanStep = plan.steps.some(step => step.type === "canAcceptance");
  if (hasCanStep && !plan.can) context.addIssue({ code: z.ZodIssueCode.custom, message: "canAcceptance step requires plan.can.profile" });
  if (plan.can && !hasCanStep) context.addIssue({ code: z.ZodIssueCode.custom, message: "plan.can requires a canAcceptance step" });
  let hasCurrentFlowSession = false;
  for (const [stepIndex, step] of plan.steps.entries()) {
    if (step.type === "launchMulticore") {
      hasCurrentFlowSession = true;
      if (!step.loadPrograms && step.loadSequence.mode !== "cpu1-then-cpu2") {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["steps", stepIndex, "loadSequence"], message: "loadSequence cannot request CPU1 pre-run when loadPrograms=false" });
      }
      continue;
    }
    if (["assignExpressions", "injectFaults", "captureExpressions", "waitForExpressions", "resetReconnectCapture", "runIpcAcceptance", "runBootHandoffDiagnosis", "runReloadAndDiagnose", "runFullDebugBundle"].includes(step.type) && !hasCurrentFlowSession) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["steps", stepIndex], message: `${step.type} requires an earlier launchMulticore step in the same durable board flow` });
    }
    if (step.type === "resetReconnectCapture") {
      const reconnected = new Set(step.coreIds);
      for (const [readIndex, read] of step.reads.entries()) {
        if (!reconnected.has(read.coreId)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["steps", stepIndex, "reads", readIndex, "coreId"], message: "capture coreId must be included in resetReconnectCapture.coreIds" });
      }
      if (step.reload !== "none" && !plan.artifacts && !plan.artifactsByBoard && !plan.artifactsByRole) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["steps", stepIndex, "reload"], message: "resetReconnectCapture reload requires explicit plan artifacts" });
      }
    }
    if (step.type === "cleanup") hasCurrentFlowSession = false;
  }
  if (plan.artifactsByBoard && plan.boardIds) {
    const selected = new Set(plan.boardIds);
    for (const boardId of Object.keys(plan.artifactsByBoard)) {
      if (!selected.has(boardId)) context.addIssue({ code: z.ZodIssueCode.custom, message: `artifactsByBoard contains boardId not selected by plan.boardIds: ${boardId}` });
    }
  }
  if (plan.artifactsByRole && !plan.can) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "artifactsByRole requires a CAN profile with role mappings" });
  }
  if (plan.artifactsByRole && plan.can) {
    const roles = new Set(["PRIMARY", "SECONDARY", ...plan.can.profile.roles.map(role => role.role)]);
    for (const role of Object.keys(plan.artifactsByRole)) {
      if (!roles.has(role)) context.addIssue({ code: z.ZodIssueCode.custom, message: `artifactsByRole contains an undeclared CAN role: ${role}` });
    }
  }
});

export type TestPlan = z.infer<typeof testPlanSchema>;
export type TestPlanStep = z.infer<typeof testPlanStepSchema>;
export type TestArtifacts = z.infer<typeof testArtifactsSchema>;

/**
 * Select the firmware for one board. A concrete board assignment wins over a
 * role assignment, which in turn wins over the legacy shared artifacts.
 */
export function resolveArtifactsForBoard(plan: TestPlan, boardId: string): TestArtifacts | undefined {
  const role = plan.can?.profile.roles.find(item => item.boardId === boardId)?.role;
  return plan.artifactsByBoard?.[boardId]
    ?? (role ? plan.artifactsByRole?.[role] : undefined)
    ?? plan.artifacts;
}

/**
 * Materialize positional/profile role selections when the scheduler has the
 * actual selected board order. Persisting this map makes daemon recovery
 * deterministic even when selection originated from tags rather than boardIds.
 */
export function materializeArtifactsByBoard(plan: TestPlan, boardIds: readonly string[]): TestPlan {
  if (!plan.artifactsByRole) return plan;
  const assignments = { ...(plan.artifactsByBoard ?? {}) };
  for (const [index, boardId] of boardIds.entries()) {
    if (assignments[boardId]) continue;
    const role = plan.can?.profile.roles.find(item => item.boardId === boardId)?.role
      ?? plan.can?.profile.roles[index]?.role
      ?? (plan.can ? (index === 0 ? "PRIMARY" : index === 1 ? "SECONDARY" : undefined) : undefined);
    const artifacts = role ? plan.artifactsByRole[role] : undefined;
    if (artifacts) assignments[boardId] = artifacts;
  }
  return Object.keys(assignments).length > 0 ? { ...plan, artifactsByBoard: assignments } : plan;
}

export function idempotencyForStep(type: TestPlanStep["type"]): "READ_ONLY" | "RECONCILABLE" | "SAFE_RETRY" | "NON_IDEMPOTENT" {
  switch (type) {
    case "preflight":
    case "runFullDebugBundle":
    case "delay":
    case "captureExpressions":
    case "waitForExpressions":
      return "READ_ONLY";
    case "canAcceptance":
      return "RECONCILABLE";
    case "cleanup":
      return "SAFE_RETRY";
    case "assignExpressions":
    case "injectFaults":
    case "resetReconnectCapture":
      return "NON_IDEMPOTENT";
    case "launchMulticore":
    case "runIpcAcceptance":
    case "runBootHandoffDiagnosis":
    case "runReloadAndDiagnose":
      return "RECONCILABLE";
  }
}
