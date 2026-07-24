import { describe, expect, test } from "vitest";
import { StepRegistry } from "../src/jobs/StepRegistry.js";
import { materializeArtifactsByBoard, testPlanSchema } from "../src/jobs/TestPlanSchema.js";

describe("per-board CAN firmware selection", () => {
  test("prefers artifactsByBoard, falls back to artifactsByRole, and persists resolved assignments", async () => {
    const plan = testPlanSchema.parse({
      planVersion: 1,
      name: "heterogeneous-can-firmware",
      boardIds: ["board-a", "board-b"],
      artifacts: { cpu1OutPath: "shared-cpu1.out", cpu2OutPath: "shared-cpu2.out" },
      artifactsByBoard: {
        "board-a": { cpu1OutPath: "board-a-cpu1.out", cpu2OutPath: "board-a-cpu2.out" }
      },
      artifactsByRole: {
        SECONDARY: { cpu1OutPath: "board-b-cpu1.out", cpu2OutPath: "board-b-cpu2.out" }
      },
      can: {
        profile: {
          adapter: "mock",
          roles: [{ role: "PRIMARY", boardId: "board-a" }, { role: "SECONDARY", boardId: "board-b" }],
          directions: [
            { sourceBoardId: "board-a", targetBoardId: "board-b", frames: [{ id: 1, data: [] }] },
            { sourceBoardId: "board-b", targetBoardId: "board-a", frames: [{ id: 2, data: [] }] }
          ]
        }
      },
      steps: [{ type: "launchMulticore" }, { type: "canAcceptance" }]
    });
    const resolved = materializeArtifactsByBoard(plan, ["board-a", "board-b"]);
    expect(resolved.artifactsByBoard).toEqual(expect.objectContaining({
      "board-a": expect.objectContaining({ cpu1OutPath: "board-a-cpu1.out" }),
      "board-b": expect.objectContaining({ cpu1OutPath: "board-b-cpu1.out" })
    }));

    const calls: Array<Record<string, unknown>> = [];
    const registry = new StepRegistry({ invokeTool: async (_name, input) => {
      calls.push(input as Record<string, unknown>);
      return { success: true };
    } });
    for (const boardId of ["board-a", "board-b"]) {
      await registry.execute({ jobId: "run-artifacts", boardId, plan: resolved, step: resolved.steps[0]! });
    }
    expect(calls.map(call => (call.cores as Array<Record<string, unknown>>).map(core => core.programUri))).toEqual([
      ["board-a-cpu1.out", "board-a-cpu2.out"],
      ["board-b-cpu1.out", "board-b-cpu2.out"]
    ]);
  });
});
