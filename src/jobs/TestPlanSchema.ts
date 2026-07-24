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
  "runIpcAcceptance",
  "runBootHandoffDiagnosis",
  "runReloadAndDiagnose",
  "runFullDebugBundle",
  "cleanup",
  "delay",
  "canAcceptance"
]);

export const testPlanStepSchema = z.object({
  type: jobStepTypeSchema,
  timeoutMs: z.number().int().positive().optional(),
  intervalMs: z.number().int().positive().optional(),
  delayMs: z.number().int().nonnegative().optional(),
  on: z.enum(["always", "failure", "success"]).optional()
}).passthrough();

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
  retryPolicy: z.record(z.number().int().nonnegative()).optional(),
  failurePolicy: z.object({
    continueHealthyBoards: z.boolean().default(true),
    quarantineFailedBoard: z.boolean().default(true),
    collectDebugBundle: z.boolean().default(true)
  }).default({ continueHealthyBoards: true, quarantineFailedBoard: true, collectDebugBundle: true }),
  recoveryPolicy: z.enum(["safe_restart_board", "manual_intervention_required"]).default("safe_restart_board")
}).superRefine((plan, context) => {
  if (!plan.boardIds && !plan.boardSelector?.boardIds && !plan.boardSelector?.tags) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "plan must select boards by boardIds or boardSelector" });
  }
  const hasCanStep = plan.steps.some(step => step.type === "canAcceptance");
  if (hasCanStep && !plan.can) context.addIssue({ code: z.ZodIssueCode.custom, message: "canAcceptance step requires plan.can.profile" });
  if (plan.can && !hasCanStep) context.addIssue({ code: z.ZodIssueCode.custom, message: "plan.can requires a canAcceptance step" });
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
      return "READ_ONLY";
    case "canAcceptance":
      return "RECONCILABLE";
    case "cleanup":
      return "SAFE_RETRY";
    case "launchMulticore":
    case "runIpcAcceptance":
    case "runBootHandoffDiagnosis":
    case "runReloadAndDiagnose":
      return "RECONCILABLE";
  }
}
