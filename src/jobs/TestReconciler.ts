import type { TestPlan } from "./TestPlanSchema.js";

export type ReconcileDecision = "RESUME" | "RESTART_BOARD_FLOW" | "MARK_PASSED" | "MARK_FAILED" | "QUARANTINE" | "MANUAL_REQUIRED";

export interface ReconcileResult {
  decision: ReconcileDecision;
  reason: string;
  evidence: Record<string, unknown>;
  nextStepIndex: number;
}

/**
 * Conservative metadata-only recovery policy. It deliberately never claims to
 * restore a DSS DebugSession or reconcile live target state after daemon loss.
 */
export class TestReconciler {
  reconcile(plan: TestPlan, input: { boardId: string; sessionId?: string; interruptedStepType?: string; interruptedIdempotencyClass?: string }): ReconcileResult {
    const evidence = recoveryEvidence(input);
    if (input.interruptedIdempotencyClass === "NON_IDEMPOTENT" || input.interruptedStepType === "reset" || input.interruptedStepType === "flash") {
      return { decision: "MANUAL_REQUIRED", reason: "Non-idempotent target control cannot be proven safe after interruption", evidence, nextStepIndex: 0 };
    }
    if (plan.recoveryPolicy === "safe_restart_board") {
      return { decision: "RESTART_BOARD_FLOW", reason: "RAM debug plan permits a new session from a known board-level safety boundary; no live target session is restored", evidence, nextStepIndex: 0 };
    }
    return { decision: "MANUAL_REQUIRED", reason: "Recovery policy does not authorize replay of target-changing steps", evidence, nextStepIndex: 0 };
  }
}

function recoveryEvidence(input: { boardId: string; sessionId?: string; interruptedStepType?: string; interruptedIdempotencyClass?: string }): Record<string, unknown> {
  return {
    boardId: input.boardId,
    interruptedStepType: input.interruptedStepType,
    interruptedIdempotencyClass: input.interruptedIdempotencyClass,
    sessionPersisted: Boolean(input.sessionId),
    reconciliationMode: "PERSISTED_METADATA_ONLY",
    persistedSessionIsNotTrusted: true,
    debugSessionRestored: false,
    hardwareStateReconciled: false,
    unverifiedHardwareState: ["xds110-owner", "cpu1-cpu2-state", "program-counter", "loaded-elf-hash", "fault-hook-readback", "can-adapter-session"]
  };
}
