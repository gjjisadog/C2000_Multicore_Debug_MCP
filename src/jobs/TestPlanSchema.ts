import { z } from "zod";
import { canAcceptanceProfileSchema } from "../can/CanProfileSchema.js";
import { HYBRID30K_DK9_OWNER_FIRST_STARTUP, IPC_STARTUP_PRESET_NAMES } from "../workflows/startupProfiles.js";
import { workflowStartupContractIssues } from "../debug/startupContract.js";
import { allowDestructiveFlashReloadSchema } from "../contracts/FlashReloadContract.js";

export const testArtifactsSchema = z.object({
  cpu1OutPath: z.string().min(1).max(4096),
  cpu2OutPath: z.string().min(1).max(4096),
  cpu1MapPath: z.string().min(1).max(4096).optional(),
  cpu2MapPath: z.string().min(1).max(4096).optional(),
  cpu1OutSha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
  cpu2OutSha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
  cpu1MapSha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
  cpu2MapSha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
  outputDir: z.string().min(1).max(4096).optional()
});

export const DURABLE_PLAN_LIMITS = {
  maxSteps: 128,
  maxAssignments: 256,
  maxFaults: 256,
  maxReads: 64,
  maxExpressionsPerRead: 128,
  maxConditions: 256,
  maxSamples: 1000,
  maxEvidenceValuesPerStep: 10000,
  maxEvidenceValuesPerPlan: 20000,
  maxExpressionLength: 512,
  maxLabelLength: 128,
  maxTimeoutMs: 86_400_000,
  maxIntervalMs: 60_000,
  maxSettleMs: 60_000,
  maxAttempts: 10,
  maxRetryPolicyEntries: 18,
  maxGuardPolls: 10_000,
  maxGuardEvidenceSnapshots: 100,
  maxStepOutputBytes: 2 * 1024 * 1024,
  maxJobEvidenceBytes: 8 * 1024 * 1024
} as const;

/** Omitted limits mean that a finite campaign records failures without aborting early. */
export const canHealthPolicySchema = z.object({
  maxConsecutiveFailures: z.number().int().nonnegative().optional(),
  maxFailureRate: z.number().min(0).max(1).optional()
}).default({});

const canExecutionSchema = z.object({
  mode: z.enum(["acceptance", "fault_campaign", "matrix", "soak"]).default("acceptance"),
  campaignId: z.string().min(1).optional(),
  iterations: z.number().int().positive().max(10_000).default(1),
  durationMs: z.number().int().positive().max(DURABLE_PLAN_LIMITS.maxTimeoutMs).optional(),
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
  "runCores",
  "haltCores",
  "reconnectAfterTargetReset",
  "restorePrograms",
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
const expressionValueSchema = z.union([z.string().max(DURABLE_PLAN_LIMITS.maxExpressionLength), z.number(), z.boolean()]);
const expressionSchema = z.string().min(1).max(DURABLE_PLAN_LIMITS.maxExpressionLength);
const labelSchema = z.string().min(1).max(DURABLE_PLAN_LIMITS.maxLabelLength);
const expressionAssignmentStepSchema = z.object({
  coreId: coreIdSchema,
  expression: expressionSchema,
  value: expressionValueSchema,
  verify: z.boolean().default(true),
  verification: z.enum(["readback", "write-only"]).optional()
}).strict();
const expressionFaultStepSchema = expressionAssignmentStepSchema.extend({ label: labelSchema.optional() }).strict();
const expressionReadStepSchema = z.object({
  label: labelSchema.optional(),
  coreId: coreIdSchema,
  expressions: z.array(expressionSchema).min(1).max(DURABLE_PLAN_LIMITS.maxExpressionsPerRead)
}).strict();
const expressionConditionStepSchema = z.object({
  label: labelSchema.optional(),
  coreId: coreIdSchema,
  expression: expressionSchema,
  expected: expressionValueSchema
}).strict();
const safetyConditionStepSchema = expressionConditionStepSchema.extend({ operator: z.literal("eq").default("eq") }).strict();
const resetEvidenceStepSchema = z.discriminatedUnion("freshness", [
  expressionConditionStepSchema.extend({
    freshness: z.literal("transition-to-expected"),
    operator: z.literal("eq").default("eq")
  }).strict(),
  z.object({
    freshness: z.literal("monotonic-increase"),
    label: labelSchema.optional(),
    coreId: coreIdSchema,
    expression: expressionSchema,
    minimumDelta: z.number().positive().default(1)
  }).strict(),
  z.object({
    freshness: z.literal("value-change"),
    label: labelSchema.optional(),
    coreId: coreIdSchema,
    expression: expressionSchema
  }).strict()
]);
const coreIdsSchema = z.array(coreIdSchema).min(1).max(2)
  .refine(values => new Set(values).size === values.length, "coreIds must be unique");
const restoreArtifactSchema = (coreId: 0 | 2) => z.object({
  coreId: z.literal(coreId),
  outPath: z.string().min(1).max(4096),
  mapPath: z.string().min(1).max(4096),
  outSha256: z.string().regex(/^[a-f0-9]{64}$/i),
  mapSha256: z.string().regex(/^[a-f0-9]{64}$/i)
}).strict();
const loadSequenceStepSchema = z.object({
  mode: z.enum(["cpu1-then-cpu2", "cpu1-run-before-cpu2"]).default("cpu1-then-cpu2"),
  cpu1SettleMs: z.number().int().nonnegative().max(DURABLE_PLAN_LIMITS.maxSettleMs).default(250)
}).strict();
const runModeStepSchema = z.enum(["cpu1_boots_cpu2", "debugger_runs_both", "cpu2_pre_running"]);
const runSequenceStepSchema = z.object({
  runMode: runModeStepSchema.optional(),
  runCpu1First: z.boolean().optional(),
  runCpu2: z.boolean().optional(),
  settleMs: z.number().int().nonnegative().max(DURABLE_PLAN_LIMITS.maxSettleMs).default(500),
  releaseCpu2BeforeCpu1: z.boolean().optional()
}).strict().superRefine((sequence, context) => {
  if (!sequence.runMode) return;
  const expected = {
    cpu1_boots_cpu2: { runCpu1First: true, runCpu2: false },
    debugger_runs_both: { runCpu1First: true, runCpu2: true },
    cpu2_pre_running: { runCpu1First: false, runCpu2: true }
  }[sequence.runMode];
  if (sequence.runCpu1First !== undefined && sequence.runCpu1First !== expected.runCpu1First) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["runCpu1First"], message: `runMode ${sequence.runMode} requires runCpu1First=${expected.runCpu1First}` });
  }
  if (sequence.runCpu2 !== undefined && sequence.runCpu2 !== expected.runCpu2) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["runCpu2"], message: `runMode ${sequence.runMode} requires runCpu2=${expected.runCpu2}` });
  }
  if (sequence.releaseCpu2BeforeCpu1 && sequence.runMode && sequence.runMode !== "cpu1_boots_cpu2") {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["releaseCpu2BeforeCpu1"], message: "releaseCpu2BeforeCpu1 requires runMode=cpu1_boots_cpu2" });
  }
}).transform(sequence => ({
  ...sequence,
  runCpu1First: sequence.runCpu1First ?? (sequence.runMode !== "cpu2_pre_running"),
  runCpu2: sequence.runCpu2 ?? (sequence.runMode !== "cpu1_boots_cpu2")
})).default(HYBRID30K_DK9_OWNER_FIRST_STARTUP.runSequence);
const loadPolicySchema = z.enum(["always", "if-changed", "verify-mcp-registry", "verify-only"]);
const programPreparationSchema = z.enum(["load", "symbols-only"]).default("load");
const addressValueSchema = z.union([z.string().min(1), z.number().int().nonnegative()]);
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
    startupPreset: z.enum(IPC_STARTUP_PRESET_NAMES).optional(),
    resetType: z.enum(["cpu", "system", "restart", "default"]).optional(),
    loadSequence: loadSequenceStepSchema.default({ mode: "cpu1-then-cpu2", cpu1SettleMs: 250 }),
    runSequence: runSequenceStepSchema.optional()
  }).strict(),
  z.object({ type: z.literal("assignExpressions"), ...baseStep, assignments: z.array(expressionAssignmentStepSchema).min(1).max(DURABLE_PLAN_LIMITS.maxAssignments) }).strict(),
  z.object({ type: z.literal("injectFaults"), ...baseStep, faults: z.array(expressionFaultStepSchema).min(1).max(DURABLE_PLAN_LIMITS.maxFaults) }).strict(),
  z.object({
    type: z.literal("captureExpressions"), ...baseStep,
    label: labelSchema.optional(),
    reads: z.array(expressionReadStepSchema).min(1).max(DURABLE_PLAN_LIMITS.maxReads),
    sampleCount: z.number().int().positive().max(DURABLE_PLAN_LIMITS.maxSamples).default(1),
    intervalMs: z.number().int().nonnegative().max(DURABLE_PLAN_LIMITS.maxIntervalMs).default(0)
  }).strict(),
  z.object({
    type: z.literal("waitForExpressions"), ...baseStep,
    conditions: z.array(expressionConditionStepSchema).min(1).max(DURABLE_PLAN_LIMITS.maxConditions),
    timeoutMs: z.number().int().positive().max(DURABLE_PLAN_LIMITS.maxTimeoutMs),
    intervalMs: z.number().int().positive().max(DURABLE_PLAN_LIMITS.maxIntervalMs).default(100)
  }).strict(),
  z.object({
    type: z.literal("runCores"), ...baseStep,
    coreIds: coreIdsSchema,
    monitorMs: z.number().int().nonnegative().max(DURABLE_PLAN_LIMITS.maxTimeoutMs).default(0),
    intervalMs: z.number().int().positive().max(DURABLE_PLAN_LIMITS.maxIntervalMs).default(100)
  }).strict(),
  z.object({ type: z.literal("haltCores"), ...baseStep, coreIds: coreIdsSchema }).strict(),
  z.object({
    type: z.literal("reconnectAfterTargetReset"), ...baseStep,
    coreIds: coreIdsSchema,
    timeoutMs: z.number().int().positive().max(DURABLE_PLAN_LIMITS.maxTimeoutMs),
    intervalMs: z.number().int().positive().max(DURABLE_PLAN_LIMITS.maxIntervalMs).default(100),
    resetEvidence: z.array(resetEvidenceStepSchema).min(1).max(DURABLE_PLAN_LIMITS.maxConditions).optional(),
    resetCauseReads: z.array(expressionReadStepSchema).min(1).max(DURABLE_PLAN_LIMITS.maxReads),
    reloadSymbols: z.boolean().default(true),
    runAfterReconnect: z.object({
      runCpu1: z.literal(true),
      cpu1SettleMs: z.number().int().nonnegative().max(DURABLE_PLAN_LIMITS.maxSettleMs).default(0),
      runCpu2: z.boolean().default(false)
    }).strict().optional()
  }).strict(),
  z.object({
    type: z.literal("restorePrograms"), on: z.literal("always"),
    allowDestructiveFlashReload: allowDestructiveFlashReloadSchema,
    artifacts: z.object({ cpu1: restoreArtifactSchema(0), cpu2: restoreArtifactSchema(2) }).strict()
  }).strict(),
  z.object({
    type: z.literal("resetReconnectCapture"), ...baseStep,
    coreIds: coreIdsSchema,
    resetType: z.enum(["cpu", "system", "restart", "default"]).default("cpu"),
    settleMs: z.number().int().nonnegative().max(DURABLE_PLAN_LIMITS.maxSettleMs).default(250),
    reload: z.enum(["none", "symbols", "programs"]).default("symbols"),
    loadPolicy: loadPolicySchema.default("if-changed"),
    allowDestructiveFlashReload: allowDestructiveFlashReloadSchema,
    reads: z.array(expressionReadStepSchema).min(1).max(DURABLE_PLAN_LIMITS.maxReads)
  }).strict(),
  z.object({
    type: z.literal("runIpcAcceptance"), ...baseStep,
    timeoutMs: z.number().int().positive().max(DURABLE_PLAN_LIMITS.maxTimeoutMs).default(10000),
    intervalMs: z.number().int().positive().max(DURABLE_PLAN_LIMITS.maxIntervalMs).default(100),
    startupPreset: z.enum(IPC_STARTUP_PRESET_NAMES).optional(),
    resetType: z.enum(["cpu", "system", "restart", "default"]).default(HYBRID30K_DK9_OWNER_FIRST_STARTUP.resetType),
    programPreparation: programPreparationSchema,
    loadPolicy: loadPolicySchema.default("always"),
    allowDestructiveFlashReload: allowDestructiveFlashReloadSchema,
    loadSequence: loadSequenceStepSchema.default(HYBRID30K_DK9_OWNER_FIRST_STARTUP.loadSequence),
    runSequence: runSequenceStepSchema.default(HYBRID30K_DK9_OWNER_FIRST_STARTUP.runSequence),
    runMode: runModeStepSchema.optional(),
    cpu1EntryAddress: addressValueSchema.optional(),
    applicationEntryTimeoutMs: z.number().int().positive().max(10_000).default(2_000),
    bootModeExpression: z.string().min(1).optional(),
    cpu1ResetStateExpression: z.string().min(1).optional(),
    bootSyncExpressions: z.array(z.string().min(1)).min(1).max(DURABLE_PLAN_LIMITS.maxReads).optional(),
    ipcReadyExpressions: z.array(expressionConditionStepSchema).min(1).max(DURABLE_PLAN_LIMITS.maxConditions).optional(),
    verifyRuntimeRamOwnership: z.boolean().optional()
  }).strict(),
  z.object({
    type: z.literal("runBootHandoffDiagnosis"), ...baseStep,
    verifyRuntimeRamOwnership: z.boolean().default(false),
    expectedPostLoadHalt: z.boolean().default(false)
  }).strict(),
  z.object({
    type: z.literal("runReloadAndDiagnose"), ...baseStep,
    timeoutMs: z.number().int().positive().max(DURABLE_PLAN_LIMITS.maxTimeoutMs).optional(),
    intervalMs: z.number().int().positive().max(DURABLE_PLAN_LIMITS.maxIntervalMs).optional(),
    allowDestructiveFlashReload: allowDestructiveFlashReloadSchema
  }).strict(),
  z.object({ type: z.literal("runFullDebugBundle"), ...baseStep }).strict(),
  z.object({ type: z.literal("cleanup"), ...baseStep }).strict(),
  z.object({ type: z.literal("delay"), ...baseStep, delayMs: z.number().int().nonnegative().max(DURABLE_PLAN_LIMITS.maxTimeoutMs) }).strict(),
  z.object({ type: z.literal("canAcceptance"), ...baseStep }).strict()
]);

export const stepRetryPolicySchema = z.object({
  maxAttempts: z.number().int().positive().max(DURABLE_PLAN_LIMITS.maxAttempts).default(1),
  backoffMs: z.number().int().nonnegative().max(DURABLE_PLAN_LIMITS.maxTimeoutMs).default(0),
  maxBackoffMs: z.number().int().nonnegative().max(DURABLE_PLAN_LIMITS.maxTimeoutMs).default(30000),
  jitter: z.boolean().default(false),
  retryableErrors: z.array(z.string().min(1).max(128)).max(64).default([])
}).strict();

const durableStepTypes = new Set(jobStepTypeSchema.options);
const retryPolicySchema = z.record(z.union([
  // Preserve the legacy shorthand: zero means one total attempt (no retry).
  z.number().int().nonnegative().max(DURABLE_PLAN_LIMITS.maxAttempts),
  stepRetryPolicySchema
])).superRefine((policy, context) => {
  const keys = Object.keys(policy);
  if (keys.length > DURABLE_PLAN_LIMITS.maxRetryPolicyEntries) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: `retryPolicy has ${keys.length} entries; maximum is ${DURABLE_PLAN_LIMITS.maxRetryPolicyEntries}` });
  }
  for (const key of keys) {
    if (!durableStepTypes.has(key as z.infer<typeof jobStepTypeSchema>)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: `retryPolicy key must be a declared durable step type: ${key}` });
    }
  }
});

export const testPlanSchema = z.object({
  planVersion: z.literal(1),
  name: z.string().min(1).max(128),
  boardSelector: z.object({
    boardIds: z.array(z.string().min(1).max(128)).min(1).max(8).optional(),
    tags: z.array(z.string().min(1).max(128)).min(1).max(32).optional(),
    count: z.number().int().positive().max(8).optional()
  }).optional(),
  boardIds: z.array(z.string().min(1).max(128)).min(1).max(8).optional(),
  parallelism: z.number().int().positive().max(8).optional(),
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
  safetyGuards: z.object({
    conditions: z.array(safetyConditionStepSchema).min(1).max(DURABLE_PLAN_LIMITS.maxConditions),
    haltCoreIds: coreIdsSchema.default([0, 2]),
    intervalMs: z.number().int().positive().max(DURABLE_PLAN_LIMITS.maxIntervalMs).default(100)
  }).strict().optional(),
  steps: z.array(testPlanStepSchema).min(1).max(DURABLE_PLAN_LIMITS.maxSteps),
  retryPolicy: retryPolicySchema.default({}),
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
  if (plan.safetyGuards && !plan.steps.some(step => step.type === "launchMulticore")) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["safetyGuards"], message: "safetyGuards require a launchMulticore step because guards are evaluated only in the current board-flow session" });
  }
  const hasCanStep = plan.steps.some(step => step.type === "canAcceptance");
  if (hasCanStep && !plan.can) context.addIssue({ code: z.ZodIssueCode.custom, message: "canAcceptance step requires plan.can.profile" });
  if (plan.can && !hasCanStep) context.addIssue({ code: z.ZodIssueCode.custom, message: "plan.can requires a canAcceptance step" });
  let hasCurrentFlowSession = false;
  for (const [stepIndex, step] of plan.steps.entries()) {
    if (step.type === "launchMulticore") {
      if (hasCurrentFlowSession) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["steps", stepIndex], message: "launchMulticore cannot replace an active durable board-flow session; cleanup must close it first" });
      }
      hasCurrentFlowSession = true;
      if (!step.loadPrograms && step.loadSequence.mode !== "cpu1-then-cpu2") {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["steps", stepIndex, "loadSequence"], message: "loadSequence cannot request CPU1 pre-run when loadPrograms=false" });
      }
      if (step.startupPreset === "hybrid30k-dk9-owner-first") {
        if (step.resetType !== HYBRID30K_DK9_OWNER_FIRST_STARTUP.resetType
          || JSON.stringify(step.loadSequence) !== JSON.stringify(HYBRID30K_DK9_OWNER_FIRST_STARTUP.loadSequence)
          || (step.runSequence !== undefined && JSON.stringify(step.runSequence) !== JSON.stringify(HYBRID30K_DK9_OWNER_FIRST_STARTUP.runSequence))) {
          context.addIssue({ code: z.ZodIssueCode.custom, path: ["steps", stepIndex, "startupPreset"], message: "hybrid30k-dk9-owner-first parameters must remain cpu / owner-first 250ms / debugger-runs-both 500ms" });
        }
      }
      continue;
    }
    if (step.type === "runIpcAcceptance" && step.loadSequence && (step.runMode || step.runSequence?.releaseCpu2BeforeCpu1)) {
      const runCpu1First = step.runMode ? step.runMode !== "cpu2_pre_running" : step.runSequence?.runCpu1First ?? true;
      const runCpu2 = step.runMode ? step.runMode !== "cpu1_boots_cpu2" : step.runSequence?.runCpu2 ?? false;
      for (const issue of workflowStartupContractIssues({
        loadMode: step.loadSequence.mode,
        runMode: step.runMode,
        runCpu1First,
        runCpu2,
        releaseCpu2BeforeCpu1: step.runSequence?.releaseCpu2BeforeCpu1
      })) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["steps", stepIndex, "loadSequence", "mode"], message: issue });
      }
    }
    if (["assignExpressions", "injectFaults", "captureExpressions", "waitForExpressions", "runCores", "haltCores", "reconnectAfterTargetReset", "restorePrograms", "resetReconnectCapture", "runIpcAcceptance", "runBootHandoffDiagnosis", "runReloadAndDiagnose", "runFullDebugBundle"].includes(step.type) && !hasCurrentFlowSession) {
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
    if (step.type === "reconnectAfterTargetReset") {
      const reconnected = new Set(step.coreIds);
      for (const [evidenceIndex, evidence] of (step.resetEvidence ?? []).entries()) {
        if (!reconnected.has(evidence.coreId)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["steps", stepIndex, "resetEvidence", evidenceIndex, "coreId"], message: "resetEvidence coreId must be included in reconnectAfterTargetReset.coreIds" });
      }
      for (const [readIndex, read] of step.resetCauseReads.entries()) {
        if (!reconnected.has(read.coreId)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["steps", stepIndex, "resetCauseReads", readIndex, "coreId"], message: "resetCauseReads coreId must be included in reconnectAfterTargetReset.coreIds" });
      }
      if (step.runAfterReconnect && !reconnected.has(0)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["steps", stepIndex, "runAfterReconnect"], message: "runAfterReconnect requires CPU1 coreId 0 in reconnectAfterTargetReset.coreIds" });
      }
      if (step.runAfterReconnect?.runCpu2 && !reconnected.has(2)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["steps", stepIndex, "runAfterReconnect", "runCpu2"], message: "runAfterReconnect.runCpu2 requires CPU2 coreId 2 in reconnectAfterTargetReset.coreIds" });
      }
    }
    const evidenceValues = evidenceValueCount(step, plan.safetyGuards?.intervalMs);
    const guardedEvidenceValues = evidenceValues + guardEvidenceValueCount(plan, step);
    if (guardedEvidenceValues > DURABLE_PLAN_LIMITS.maxEvidenceValuesPerStep) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["steps", stepIndex], message: `step expands to ${guardedEvidenceValues} evidence values; maximum is ${DURABLE_PLAN_LIMITS.maxEvidenceValuesPerStep}` });
    }
    if (step.type === "reconnectAfterTargetReset" && Math.ceil(step.timeoutMs / Math.min(step.intervalMs, plan.safetyGuards?.intervalMs ?? step.intervalMs)) > DURABLE_PLAN_LIMITS.maxGuardPolls) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["steps", stepIndex], message: `reconnect polling exceeds ${DURABLE_PLAN_LIMITS.maxGuardPolls} bounded iterations` });
    }
    if ((step.type === "waitForExpressions" || step.type === "runIpcAcceptance") && Math.ceil(step.timeoutMs / step.intervalMs) > DURABLE_PLAN_LIMITS.maxGuardPolls) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["steps", stepIndex], message: `${step.type} polling exceeds ${DURABLE_PLAN_LIMITS.maxGuardPolls} bounded iterations` });
    }
    if (step.type === "runIpcAcceptance" && step.startupPreset === "hybrid30k-dk9-owner-first") {
      if (step.resetType !== HYBRID30K_DK9_OWNER_FIRST_STARTUP.resetType
        || JSON.stringify(step.loadSequence) !== JSON.stringify(HYBRID30K_DK9_OWNER_FIRST_STARTUP.loadSequence)
        || JSON.stringify(step.runSequence) !== JSON.stringify(HYBRID30K_DK9_OWNER_FIRST_STARTUP.runSequence)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["steps", stepIndex, "startupPreset"], message: "hybrid30k-dk9-owner-first parameters must remain cpu / owner-first 250ms / debugger-runs-both 500ms" });
      }
    }
    if (plan.safetyGuards && step.type === "runCores" && step.monitorMs === 0) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["steps", stepIndex, "monitorMs"], message: "guarded runCores requires a positive bounded monitorMs" });
    }
    if (step.type === "cleanup" && (step.on === undefined || step.on === "always")) hasCurrentFlowSession = false;
  }
  const totalEvidenceIncludingGuards = plan.steps.reduce((total, step) => total + evidenceValueCount(step, plan.safetyGuards?.intervalMs) + guardEvidenceValueCount(plan, step), 0);
  if (totalEvidenceIncludingGuards > DURABLE_PLAN_LIMITS.maxEvidenceValuesPerPlan) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["steps"], message: `plan expands to ${totalEvidenceIncludingGuards} evidence values; maximum is ${DURABLE_PLAN_LIMITS.maxEvidenceValuesPerPlan}` });
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

const LEGACY_STEP_TYPES = new Set(["preflight", "launchMulticore", "runIpcAcceptance", "runBootHandoffDiagnosis", "runReloadAndDiagnose", "runFullDebugBundle", "cleanup", "delay", "canAcceptance"]);

/** Parse trusted SQLite plans written by the pre-strict v1 schema. New target-control steps and safety guards never use this compatibility path. */
export function parsePersistedTestPlan(input: unknown): TestPlan {
  const strict = testPlanSchema.safeParse(input);
  if (strict.success) return strict.data;
  if (!isRecord(input) || input.planVersion !== 1 || !Array.isArray(input.steps)) return testPlanSchema.parse(input);
  if ("safetyGuards" in input) return testPlanSchema.parse(input);
  if (!input.steps.every(step => isRecord(step) && typeof step.type === "string" && LEGACY_STEP_TYPES.has(step.type))) {
    return testPlanSchema.parse(input);
  }
  const topLevelKeys = ["planVersion", "name", "boardSelector", "boardIds", "parallelism", "priority", "artifacts", "artifactsByBoard", "artifactsByRole", "can", "steps", "retryPolicy", "failurePolicy", "recoveryPolicy"];
  const migrated = Object.fromEntries(topLevelKeys.flatMap(key => key in input ? [[key, input[key]]] : [])) as Record<string, unknown>;
  migrated.steps = input.steps.map(migrateLegacyStep);
  return testPlanSchema.parse(migrated);
}

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
    case "runCores":
    case "reconnectAfterTargetReset":
    case "restorePrograms":
    case "resetReconnectCapture":
      return "NON_IDEMPOTENT";
    case "haltCores":
      return "SAFE_RETRY";
    case "launchMulticore":
    case "runIpcAcceptance":
    case "runBootHandoffDiagnosis":
    case "runReloadAndDiagnose":
      return "RECONCILABLE";
  }
}

function evidenceValueCount(step: TestPlanStep, guardIntervalMs?: number): number {
  switch (step.type) {
    case "assignExpressions": return step.assignments.length;
    case "injectFaults": return step.faults.length;
    case "captureExpressions": return step.sampleCount * step.reads.reduce((total, read) => total + read.expressions.length, 0);
    case "waitForExpressions": return step.conditions.length;
    case "resetReconnectCapture": return step.reads.reduce((total, read) => total + read.expressions.length, 0);
    case "reconnectAfterTargetReset": return ((reconnectPollCount(step, guardIntervalMs) + 1) * (step.resetEvidence?.length ?? 0))
      + step.resetCauseReads.reduce((total, read) => total + read.expressions.length, 0);
    case "runIpcAcceptance": return step.ipcReadyExpressions?.length ?? 0;
    default: return 0;
  }
}

function guardEvidenceValueCount(plan: Pick<TestPlan, "safetyGuards">, step: TestPlanStep): number {
  const guardCount = plan.safetyGuards?.conditions.length ?? 0;
  if (guardCount === 0 || step.type === "cleanup" || step.type === "restorePrograms") return 0;
  let monitoredPolls = 0;
  if (step.type === "delay") monitoredPolls = Math.ceil(step.delayMs / plan.safetyGuards!.intervalMs);
  if (step.type === "waitForExpressions") monitoredPolls = Math.ceil(step.timeoutMs / step.intervalMs);
  if (step.type === "runCores") monitoredPolls = Math.ceil(step.monitorMs / step.intervalMs);
  if (step.type === "reconnectAfterTargetReset") {
    const reconnectPolls = reconnectPollCount(step, plan.safetyGuards!.intervalMs);
    const resetBoundaryChecks = step.resetEvidence ? 3 : 2;
    const runChecks = step.runAfterReconnect
      ? 1 + Math.ceil(step.runAfterReconnect.cpu1SettleMs / plan.safetyGuards!.intervalMs) + (step.runAfterReconnect.runCpu2 ? 1 : 0)
      : 0;
    return (reconnectPolls + resetBoundaryChecks + runChecks) * guardCount;
  }
  return (2 + monitoredPolls) * guardCount;
}

function reconnectPollCount(step: Extract<TestPlanStep, { type: "reconnectAfterTargetReset" }>, guardIntervalMs?: number): number {
  return Math.ceil(step.timeoutMs / Math.min(step.intervalMs, guardIntervalMs ?? step.intervalMs));
}

function migrateLegacyStep(value: unknown): Record<string, unknown> {
  const step = value as Record<string, unknown>;
  const migrated: Record<string, unknown> = { type: step.type };
  if (step.on === "always" || step.on === "failure" || step.on === "success") migrated.on = step.on;
  switch (step.type) {
    case "launchMulticore":
      if (typeof step.loadPrograms === "boolean") migrated.loadPrograms = step.loadPrograms;
      if (isRecord(step.loadSequence)) migrated.loadSequence = step.loadSequence;
      for (const key of ["startupPreset", "resetType", "runSequence"]) if (key in step) migrated[key] = step[key];
      break;
    case "runIpcAcceptance":
      for (const key of ["timeoutMs", "intervalMs", "startupPreset", "resetType", "programPreparation", "loadPolicy", "allowDestructiveFlashReload", "loadSequence", "runSequence", "runMode", "ipcReadyExpressions", "verifyRuntimeRamOwnership"]) {
        if (key in step) migrated[key] = step[key];
      }
      break;
    case "runReloadAndDiagnose":
      for (const key of ["timeoutMs", "intervalMs", "allowDestructiveFlashReload"]) if (key in step) migrated[key] = step[key];
      break;
    case "runBootHandoffDiagnosis":
      for (const key of ["verifyRuntimeRamOwnership", "expectedPostLoadHalt"]) if (key in step) migrated[key] = step[key];
      break;
    case "delay":
      migrated.delayMs = typeof step.delayMs === "number" && Number.isFinite(step.delayMs) && step.delayMs >= 0 ? step.delayMs : 0;
      break;
  }
  return migrated;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
