import type { TestPlan } from "../jobs/TestPlanSchema.js";
import type { BoardGroupRecord } from "../storage/repositories/BoardGroupRepository.js";
import type { BoardGroupBarrierRecord } from "../storage/repositories/BoardGroupBarrierRepository.js";

export interface CanGroupReconcileResult {
  decision: "RESTART_GROUP_FROM_SAFE_BOUNDARY" | "MARK_PASSED" | "MANUAL_REQUIRED" | "QUARANTINE";
  reason: string;
  evidence: Record<string, unknown>;
}

/** Conservative group recovery: preserve member evidence and never replay a fault/reset sequence implicitly. */
export class CanGroupReconciler {
  reconcile(plan: TestPlan, group: BoardGroupRecord, barriers: BoardGroupBarrierRecord[]): CanGroupReconcileResult {
    const execution = plan.can?.execution;
    const evidence = {
      groupStatus: group.status,
      currentBarrier: group.currentBarrier,
      members: group.members.map(member => ({ boardId: member.boardId, status: member.status, sessionId: member.sessionId, leaseId: member.leaseId, error: member.error })),
      barriers: barriers.map(barrier => ({ name: barrier.name, status: barrier.status, arrivedMembers: Object.keys(barrier.arrivedMembers) }))
    };
    if (group.status === "PASSED") return { decision: "MARK_PASSED", reason: "Durable group already has terminal passed evidence", evidence };
    if (execution?.resetOrRejoinRequested || execution?.mode === "fault_campaign") {
      return { decision: "MANUAL_REQUIRED", reason: "Interrupted reset/rejoin or fault campaign is not blindly replayed; healthy-peer evidence is preserved", evidence };
    }
    if (barriers.some(barrier => barrier.status === "FAILED" || barrier.status === "TIMED_OUT")) {
      return { decision: "MANUAL_REQUIRED", reason: "A persisted group barrier failed or timed out; topology state must be inspected before retry", evidence };
    }
    return { decision: "RESTART_GROUP_FROM_SAFE_BOUNDARY", reason: "Finite acceptance/soak work may restart only from the group safety boundary; persisted sessions are not trusted", evidence };
  }
}
