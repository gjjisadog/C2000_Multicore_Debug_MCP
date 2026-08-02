import { describe, expect, test } from "vitest";
import { StepRegistry } from "../src/jobs/StepRegistry.js";
import { DURABLE_PLAN_LIMITS, parsePersistedTestPlan, testPlanSchema } from "../src/jobs/TestPlanSchema.js";
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
  test("durable step schema fails closed on unknown fields and missing or unsupported core identity", () => {
    const base = { planVersion: 1, name: "strict", boardIds: ["board-a"], steps: [] as unknown[] };
    expect(testPlanSchema.safeParse({ ...base, steps: [{ type: "assignExpressions", assignments: [{ expression: "g_x", value: 1 }] }] }).success).toBe(false);
    expect(testPlanSchema.safeParse({ ...base, steps: [{ type: "launchMulticore", loadProgrms: false }] }).success).toBe(false);
    expect(testPlanSchema.safeParse({ ...base, steps: [{ type: "launchMulticore" }, { type: "captureExpressions", reads: [{ coreId: 1, expressions: ["g_x"] }] }] }).success).toBe(false);
    expect(testPlanSchema.safeParse({ ...base, steps: [{ type: "captureExpressions", reads: [{ coreId: 0, expressions: ["g_x"] }] }] }).success).toBe(false);
    expect(() => parsePersistedTestPlan({ ...base, steps: [{ type: "assignExpressions", assignments: [{ coreId: 0, expression: "g_x", value: 1 }], misspelled: true }] })).toThrow();
  });

  test("rejects collection, string, and expanded evidence budgets at the schema boundary", () => {
    const base = { planVersion: 1, name: "limits", boardIds: ["board-a"] };
    expect(testPlanSchema.safeParse({ ...base, steps: Array.from({ length: DURABLE_PLAN_LIMITS.maxSteps + 1 }, () => ({ type: "preflight" })) }).success).toBe(false);
    expect(testPlanSchema.safeParse({ ...base, steps: [
      { type: "launchMulticore", loadPrograms: false },
      { type: "assignExpressions", assignments: Array.from({ length: DURABLE_PLAN_LIMITS.maxAssignments + 1 }, () => ({ coreId: 0, expression: "g_x", value: 1 })) }
    ] }).success).toBe(false);
    expect(testPlanSchema.safeParse({ ...base, steps: [
      { type: "launchMulticore", loadPrograms: false },
      { type: "captureExpressions", reads: [{ coreId: 0, expressions: ["x".repeat(DURABLE_PLAN_LIMITS.maxExpressionLength + 1)] }] }
    ] }).success).toBe(false);
    expect(testPlanSchema.safeParse({ ...base, steps: [
      { type: "launchMulticore", loadPrograms: false },
      { type: "captureExpressions", sampleCount: 100, reads: [{ coreId: 0, expressions: Array.from({ length: 101 }, (_, index) => `g_x${index}`) }] }
    ] }).success).toBe(false);
    expect(testPlanSchema.safeParse({ ...base, steps: [
      { type: "launchMulticore", loadPrograms: false },
      ...Array.from({ length: 3 }, () => ({ type: "captureExpressions", sampleCount: 100, reads: [{ coreId: 0, expressions: Array.from({ length: 70 }, (_, index) => `g_x${index}`) }] }))
    ] }).success).toBe(false);

    const ipc = (overrides: Record<string, unknown>) => ({
      ...base,
      steps: [{ type: "launchMulticore", loadPrograms: false }, {
        type: "runIpcAcceptance",
        ipcReadyExpressions: [{ coreId: 0, expression: "g_ready", expected: 1 }],
        ...overrides
      }]
    });
    expect(testPlanSchema.safeParse(ipc({ timeoutMs: 100_000_000 })).success).toBe(false);
    expect(testPlanSchema.safeParse(ipc({ intervalMs: 100_000 })).success).toBe(false);
    expect(testPlanSchema.safeParse(ipc({ loadSequence: { mode: "cpu1-run-before-cpu2", cpu1SettleMs: 100_000 } })).success).toBe(false);
    expect(testPlanSchema.safeParse(ipc({ ipcReadyExpressions: Array.from({ length: DURABLE_PLAN_LIMITS.maxConditions + 1 }, (_, index) => ({ coreId: 0, expression: `g_ready${index}`, expected: 1 })) })).success).toBe(false);
    expect(testPlanSchema.safeParse(ipc({ ipcReadyExpressions: [{ coreId: 0, expression: "x".repeat(DURABLE_PLAN_LIMITS.maxExpressionLength + 1), expected: 1 }] })).success).toBe(false);
    expect(testPlanSchema.safeParse(ipc({ ipcReadyExpressions: [{ label: "x".repeat(DURABLE_PLAN_LIMITS.maxLabelLength + 1), coreId: 0, expression: "g_ready", expected: 1 }] })).success).toBe(false);
    expect(testPlanSchema.safeParse(ipc({ ipcReadyExpressions: [{ coreId: 0, expression: "g_ready", expected: "x".repeat(DURABLE_PLAN_LIMITS.maxExpressionLength + 1) }] })).success).toBe(false);
    expect(testPlanSchema.safeParse(ipc({
      timeoutMs: DURABLE_PLAN_LIMITS.maxTimeoutMs,
      intervalMs: DURABLE_PLAN_LIMITS.maxIntervalMs,
      loadSequence: { mode: "cpu1-run-before-cpu2", cpu1SettleMs: DURABLE_PLAN_LIMITS.maxSettleMs },
      ipcReadyExpressions: Array.from({ length: DURABLE_PLAN_LIMITS.maxConditions }, (_, index) => ({ coreId: 0, expression: `g_ready${index}`, expected: 1 }))
    })).success).toBe(true);

    expect(testPlanSchema.safeParse({
      ...base,
      steps: [
        { type: "launchMulticore", loadPrograms: false },
        ...Array.from({ length: 79 }, (_, stepIndex) => ({
          type: "runIpcAcceptance",
          ipcReadyExpressions: Array.from({ length: DURABLE_PLAN_LIMITS.maxConditions }, (_, conditionIndex) => ({ coreId: 0, expression: `g_${stepIndex}_${conditionIndex}`, expected: 1 }))
        }))
      ]
    }).success).toBe(false);
  });

  test("bounds retry attempts and allows only declared durable step policy keys", () => {
    const base = { planVersion: 1, name: "retry-limits", boardIds: ["board-a"], steps: [{ type: "preflight" }] };
    expect(testPlanSchema.safeParse({ ...base, retryPolicy: { preflight: 1_000_000_000 } }).success).toBe(false);
    expect(testPlanSchema.safeParse({ ...base, retryPolicy: { preflight: { maxAttempts: 1_000_000_000 } } }).success).toBe(false);
    expect(testPlanSchema.safeParse({ ...base, retryPolicy: { typoStep: 2 } }).success).toBe(false);
    expect(testPlanSchema.safeParse({
      ...base,
      retryPolicy: Object.fromEntries(Array.from({ length: DURABLE_PLAN_LIMITS.maxRetryPolicyEntries + 1 }, (_, index) => [`unknown-${index}`, 1]))
    }).success).toBe(false);

    const numericBoundary = testPlanSchema.parse({ ...base, retryPolicy: { preflight: DURABLE_PLAN_LIMITS.maxAttempts } });
    const structuredBoundary = testPlanSchema.parse({ ...base, retryPolicy: { preflight: { maxAttempts: DURABLE_PLAN_LIMITS.maxAttempts } } });
    expect(numericBoundary.retryPolicy.preflight).toBe(DURABLE_PLAN_LIMITS.maxAttempts);
    expect(structuredBoundary.retryPolicy.preflight).toEqual(expect.objectContaining({ maxAttempts: DURABLE_PLAN_LIMITS.maxAttempts }));

    const compatible = testPlanSchema.parse({
      ...base,
      steps: [{ type: "preflight" }, { type: "delay", delayMs: 0 }],
      retryPolicy: { preflight: 0, delay: { maxAttempts: 1 } }
    });
    expect(compatible.retryPolicy).toEqual(expect.objectContaining({ preflight: 0, delay: expect.objectContaining({ maxAttempts: 1 }) }));
  });

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
        loadPrograms: false,
        loadSequence: { mode: "cpu1-then-cpu2", cpu1SettleMs: 250 },
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

  test("executes mutation, capture, wait, and reset recovery in one fenced current-session sequence", async () => {
    const invoker = new RecordingToolInvoker();
    const registry = new StepRegistry(invoker);
    const plan = testPlanSchema.parse({
      planVersion: 1,
      name: "hybrid-safety-a-e",
      boardIds: ["board-a"],
      artifacts: { cpu1OutPath: "/fw/cpu1.out", cpu2OutPath: "/fw/cpu2.out" },
      steps: [
        { type: "launchMulticore", loadPrograms: false },
        { type: "assignExpressions", assignments: [{ coreId: 0, expression: "g_cmd", value: 1 }] },
        { type: "injectFaults", faults: [{ label: "ocp", coreId: 2, expression: "g_fault", value: true }] },
        { type: "captureExpressions", label: "window", reads: [{ coreId: 0, expressions: ["g_state"] }], sampleCount: 2, intervalMs: 0 },
        { type: "waitForExpressions", conditions: [{ coreId: 2, expression: "g_safe", expected: 1 }], timeoutMs: 500 },
        { type: "resetReconnectCapture", coreIds: [0, 2], reload: "symbols", reads: [{ coreId: 0, expressions: ["g_state"] }, { coreId: 2, expressions: ["g_safe"] }] }
      ]
    });
    const leaseContext = {
      leaseId: "lease-a", leaseToken: "secret", fencingToken: 7, leaseGeneration: 3,
      ownerJobId: "job-a", boardId: "board-a", probeSerial: "XDS-A", workerInstanceId: "worker-a"
    };
    for (const step of plan.steps.slice(1)) {
      await registry.execute({ jobId: "job-a", boardId: "board-a", sessionId: "dbg-current", leaseContext, plan, step });
    }
    expect(invoker.calls.map(call => call.toolName)).toEqual([
      "c2000_assignExpressions", "c2000_injectFaults",
      "c2000_evaluateMany", "c2000_evaluateMany", "c2000_waitForExpressionSet",
      "c2000_resetCores", "c2000_connectCores", "c2000_loadSymbols", "c2000_loadSymbols",
      "c2000_evaluateMany", "c2000_evaluateMany"
    ]);
    expect(invoker.calls.every(call => call.input.sessionId === "dbg-current")).toBe(true);
    expect(invoker.calls.every(call => call.input.__leaseContext === leaseContext)).toBe(true);
    expect(invoker.calls.find(call => call.toolName === "c2000_resetCores")?.input).toEqual(expect.objectContaining({ coreIds: [0, 2], resetType: "cpu" }));
    expect(invoker.calls.filter(call => call.toolName === "c2000_loadSymbols").map(call => call.input.coreId)).toEqual([0, 2]);
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
