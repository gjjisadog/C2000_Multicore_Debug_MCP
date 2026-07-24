import { describe, expect, test } from "vitest";
import { CanGroupReconciler } from "../src/can/CanGroupReconciler.js";
import { testPlanSchema } from "../src/jobs/TestPlanSchema.js";

describe("CAN group reconciliation", () => {
  test("requires manual intervention for an interrupted fault/reset flow and preserves peer evidence", () => {
    const plan = testPlanSchema.parse({
      planVersion: 1, name: "interrupted-fault", boardIds: ["board-a", "board-b"],
      can: { groupId: "group-fault", profile: { adapter: "mock", directions: [
        { sourceBoardId: "board-a", targetBoardId: "board-b", frames: [{ id: 1, data: [] }] },
        { sourceBoardId: "board-b", targetBoardId: "board-a", frames: [{ id: 2, data: [] }] }
      ] }, execution: { mode: "fault_campaign", campaignId: "campaign-fault", iterations: 1, matrixCases: [], failFast: false, health: { maxConsecutiveFailures: 0, maxFailureRate: 0 }, resetOrRejoinRequested: true } },
      steps: [{ type: "canAcceptance" }]
    });
    const result = new CanGroupReconciler().reconcile(plan, {
      groupId: "group-fault", groupType: "CAN_PAIR", name: "fault", jobId: "job-fault", status: "RECOVERING", topology: {}, failurePolicy: {}, metadata: {}, members: [
        { boardId: "board-a", role: "PRIMARY", index: 0, status: "PASSED", leaseId: "lease-a", sessionId: "stale-a", heartbeatSnapshot: { last: "healthy" } },
        { boardId: "board-b", role: "SECONDARY", index: 1, status: "FAILED", leaseId: "lease-b", heartbeatSnapshot: {} }
      ], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z"
    }, []);
    expect(result).toEqual(expect.objectContaining({ decision: "MANUAL_REQUIRED", evidence: expect.objectContaining({ members: expect.arrayContaining([expect.objectContaining({ boardId: "board-a", status: "PASSED", leaseId: "lease-a" })]) }) }));
  });
});
