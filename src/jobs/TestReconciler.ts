import type { TestPlan } from "./TestPlanSchema.js";

export type ReconcileDecision = "RESUME" | "RESTART_BOARD_FLOW" | "MARK_PASSED" | "MARK_FAILED" | "QUARANTINE" | "MANUAL_REQUIRED";

export interface ReconcileResult {
  decision: ReconcileDecision;
  reason: string;
  evidence: Record<string, unknown>;
  nextStepIndex: number;
}

/** Conservative first-pass reconcile policy; it never assumes a persisted session is a live DSS object. */
export class TestReconciler {
  reconcile(plan: TestPlan, input: { boardId: string; sessionId?: string; interruptedStepType?: string; interruptedIdempotencyClass?: string }): ReconcileResult {
    if (input.interruptedIdempotencyClass === "NON_IDEMPOTENT" || input.interruptedStepType === "reset" || input.interruptedStepType === "flash") {
      return { decision: "MANUAL_REQUIRED", reason: "Non-idempotent target control cannot be proven safe after interruption", evidence: { boardId: input.boardId, interruptedStepType: input.interruptedStepType, interruptedIdempotencyClass: input.interruptedIdempotencyClass, sessionPersisted: Boolean(input.sessionId) }, nextStepIndex: 0 };
    }
    if (plan.recoveryPolicy === "safe_restart_board") {
      return { decision: "RESTART_BOARD_FLOW", reason: "RAM debug plan permits restart from a known board-level safety boundary", evidence: { boardId: input.boardId, persistedSessionIsNotTrusted: true }, nextStepIndex: 0 };
    }
    return { decision: "MANUAL_REQUIRED", reason: "Recovery policy does not authorize replay of target-changing steps", evidence: { boardId: input.boardId, persistedSessionIsNotTrusted: true }, nextStepIndex: 0 };
  }
}
