import { describe, expect, test } from "vitest";
import { StepRegistry } from "../src/jobs/StepRegistry.js";
import { testPlanSchema } from "../src/jobs/TestPlanSchema.js";
import { submitMultiBoardIpcAcceptanceSchema } from "../src/mcp/toolSchemas.js";
import type { C2000ToolInvoker } from "../src/mcp/tools.js";

class RecordingToolInvoker implements C2000ToolInvoker {
  readonly calls: Array<{ toolName: string; input: Record<string, unknown> }> = [];

  async invokeTool(toolName: string, input: unknown): Promise<Record<string, unknown>> {
    this.calls.push({ toolName, input: input as Record<string, unknown> });
    return { success: true, sessionId: "dbg-job" };
  }
}

describe("StepRegistry", () => {
  test("durable IPC acceptance creates one connect-only session and forwards staged load parameters", async () => {
    const invoker = new RecordingToolInvoker();
    const registry = new StepRegistry(invoker);
    const plan = testPlanSchema.parse({
      planVersion: 1,
      name: "durable-ipc",
      boardIds: ["board-a"],
      artifacts: {
        cpu1OutPath: "/firmware/cpu1.out",
        cpu2OutPath: "/firmware/cpu2.out",
        cpu1MapPath: "/firmware/cpu1.map",
        cpu2MapPath: "/firmware/cpu2.map"
      },
      steps: [
        { type: "launchMulticore", loadPrograms: false },
        {
          type: "runIpcAcceptance",
          loadPolicy: "if-changed",
          loadSequence: { mode: "cpu1-run-before-cpu2", cpu1SettleMs: 500 },
          ipcReadyExpressions: [{ label: "ti-ipc-demo-pass", coreId: 0, expression: "pass", expected: 1 }]
        }
      ]
    });

    await registry.execute({
      jobId: "job-a",
      boardId: "board-a",
      plan,
      step: plan.steps[0]
    });
    expect(invoker.calls[0]).toEqual({
      toolName: "c2000_launchMulticoreDebug",
      input: expect.objectContaining({
        boardId: "board-a",
        cores: [
          expect.objectContaining({ coreId: 0, connect: true, load: false, haltAtEntry: true }),
          expect.objectContaining({ coreId: 2, connect: true, load: false, haltAtEntry: true })
        ]
      })
    });
    expect(invoker.calls[0].input.cores).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ programUri: expect.any(String) })
    ]));

    await registry.execute({
      jobId: "job-a",
      boardId: "board-a",
      sessionId: "dbg-job",
      plan,
      step: plan.steps[1]
    });
    expect(invoker.calls[1]).toEqual({
      toolName: "c2000_runIpcAcceptance",
      input: expect.objectContaining({
        sessionId: "dbg-job",
        cpu1OutPath: "/firmware/cpu1.out",
        cpu2OutPath: "/firmware/cpu2.out",
        loadPolicy: "if-changed",
        loadSequence: { mode: "cpu1-run-before-cpu2", cpu1SettleMs: 500 },
        ipcReadyExpressions: [{ label: "ti-ipc-demo-pass", coreId: 0, expression: "pass", expected: 1 }]
      })
    });
  });

  test("durable IPC submission accepts explicit firmware-specific readiness expressions", () => {
    const parsed = submitMultiBoardIpcAcceptanceSchema.parse({
      boardIds: ["board-a"],
      artifacts: {
        cpu1OutPath: "/firmware/cpu1.out",
        cpu2OutPath: "/firmware/cpu2.out"
      },
      ipcReadyExpressions: [{ label: "ti-ipc-demo-pass", coreId: 0, expression: "pass", expected: 1 }]
    });

    expect(parsed.ipcReadyExpressions).toEqual([
      { label: "ti-ipc-demo-pass", coreId: 0, expression: "pass", expected: 1 }
    ]);
  });
});
