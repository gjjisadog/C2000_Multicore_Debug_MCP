import { z } from "zod";
import { canAcceptanceProfileSchema } from "../can/CanProfileSchema.js";

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
  artifacts: z.object({
    cpu1OutPath: z.string().min(1),
    cpu2OutPath: z.string().min(1),
    cpu1MapPath: z.string().min(1).optional(),
    cpu2MapPath: z.string().min(1).optional(),
    outputDir: z.string().min(1).optional()
  }).optional(),
  can: z.object({
    /** Assigned by the job engine before persistence; callers do not choose durable identifiers. */
    groupId: z.string().min(1).optional(),
    profile: canAcceptanceProfileSchema
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
});

export type TestPlan = z.infer<typeof testPlanSchema>;
export type TestPlanStep = z.infer<typeof testPlanStepSchema>;

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
