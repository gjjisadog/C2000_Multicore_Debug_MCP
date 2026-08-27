import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { StepRegistry } from "../src/jobs/StepRegistry.js";
import { DURABLE_PLAN_LIMITS, parsePersistedTestPlan, testPlanSchema } from "../src/jobs/TestPlanSchema.js";
import { submitMultiBoardIpcAcceptanceSchema, workflowRunSequenceSchema } from "../src/mcp/toolSchemas.js";
import type { C2000ToolInvoker } from "../src/mcp/tools.js";
import { sha256File } from "../src/utils/fileHash.js";

class RecordingToolInvoker implements C2000ToolInvoker {
  readonly calls: Array<{ toolName: string; input: Record<string, unknown> }> = [];
  readonly failedExpressions = new Set<string>();
  readonly failedAssignments = new Set<string>();

  async invokeTool(toolName: string, input: unknown): Promise<Record<string, unknown>> {
    const record = input as Record<string, unknown>;
    this.calls.push({ toolName, input: record });
    if (toolName === "c2000_assignExpression" && this.failedAssignments.has(String(record.expression))) {
      return { success: false, error: { code: "ExpressionVerifyFailed", message: "simulated assignment failure" } };
    }
    if (toolName === "c2000_evaluateMany") {
      const expressions = Array.isArray(record.expressions)
        ? record.expressions.filter((expression): expression is string => typeof expression === "string")
        : [];
      return {
        success: true,
        sessionId: "dbg-job",
        coreId: record.coreId,
        results: expressions.map(expression => this.failedExpressions.has(expression)
          ? { expression, success: false, error: { code: "ExpressionEvaluationFailed", message: "simulated unreadable expression" } }
          : { expression, success: true, value: "1" })
      };
    }
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
          startupPreset: "hybrid30k-dk9-owner-first",
          resetType: "cpu",
          loadPolicy: "if-changed",
          loadSequence: { mode: "cpu1-run-before-cpu2", cpu1SettleMs: 250 },
          runSequence: { runMode: "debugger_runs_both", runCpu1First: true, runCpu2: true, settleMs: 500 },
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
        startupPreset: "hybrid30k-dk9-owner-first",
        resetType: "cpu",
        loadSequence: { mode: "cpu1-run-before-cpu2", cpu1SettleMs: 250 },
        runSequence: { runMode: "debugger_runs_both", runCpu1First: true, runCpu2: true, settleMs: 500 },
        ipcReadyExpressions: [{ label: "ti-ipc-demo-pass", coreId: 0, expression: "pass", expected: 1 }]
      })
    });
  });

  test("runMode supplies explicit run defaults and rejects contradictory legacy flags", () => {
    expect(workflowRunSequenceSchema.parse({ runMode: "cpu2_pre_running" })).toEqual({
      runMode: "cpu2_pre_running",
      runCpu1First: false,
      runCpu2: true,
      settleMs: 0
    });
    expect(workflowRunSequenceSchema.safeParse({
      runMode: "cpu2_pre_running",
      runCpu1First: true,
      runCpu2: true
    }).success).toBe(false);
    expect(testPlanSchema.safeParse({
      planVersion: 1,
      name: "contradictory-startup",
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
          runMode: "cpu2_pre_running",
          loadSequence: { mode: "cpu1-run-before-cpu2", cpu1SettleMs: 0 },
          ipcReadyExpressions: [{ coreId: 0, expression: "g_ready", expected: 1 }]
        }
      ]
    }).success).toBe(false);
    expect(testPlanSchema.safeParse({
      planVersion: 1,
      name: "cpu1-release-after-cpu2-load",
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
          runMode: "cpu1_boots_cpu2",
          loadSequence: { mode: "cpu1-run-before-cpu2", cpu1SettleMs: 0 },
          ipcReadyExpressions: [{ coreId: 0, expression: "g_ready", expected: 1 }]
        }
      ]
    }).success).toBe(false);
  });

  test("fails closed instead of silently converting a load-enabled launch into connect-only", async () => {
    const invoker = new RecordingToolInvoker();
    const registry = new StepRegistry(invoker);
    const plan = testPlanSchema.parse({
      planVersion: 1,
      name: "missing-launch-artifacts",
      boardIds: ["board-a"],
      steps: [{ type: "launchMulticore" }]
    });

    await expect(registry.execute({
      jobId: "job-a",
      boardId: "board-a",
      plan,
      step: plan.steps[0]!
    })).rejects.toMatchObject({ code: "LaunchArtifactsMissing" });
    expect(invoker.calls).toEqual([]);
  });

  test("checks declared launch artifact hashes before invoking the target", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "c2000-durable-launch-hash-"));
    try {
      const cpu1OutPath = path.join(root, "Hybrid30K_CPU1_DK9_RUNTIME_ACCEPTANCE_RAM.out");
      const cpu2OutPath = path.join(root, "Hybrid30K_CPU2_DK9_CE_PRELOADED_VALIDATION_RAM.out");
      await writeFile(cpu1OutPath, "cpu1-fresh");
      await writeFile(cpu2OutPath, "cpu2-fresh");
      const hashes = { cpu1: await sha256File(cpu1OutPath), cpu2: await sha256File(cpu2OutPath) };
      const invoker = new RecordingToolInvoker();
      const registry = new StepRegistry(invoker, undefined, { allowedReadRoots: [root], allowedWriteRoots: [] });
      const plan = testPlanSchema.parse({
        planVersion: 1,
        name: "declared-launch-hashes",
        boardIds: ["board-a"],
        artifacts: {
          cpu1OutPath,
          cpu2OutPath,
          cpu1OutSha256: hashes.cpu1,
          cpu2OutSha256: hashes.cpu2
        },
        steps: [{ type: "launchMulticore", loadPrograms: true }]
      });

      const output = await registry.execute({ jobId: "job-a", boardId: "board-a", plan, step: plan.steps[0]! });
      expect(output.artifactPreflight).toEqual(expect.objectContaining({ checked: true, mode: "declared-sha256" }));
      expect(invoker.calls).toHaveLength(1);

      await writeFile(cpu2OutPath, "cpu2-swapped");
      await expect(registry.execute({ jobId: "job-a", boardId: "board-a", plan, step: plan.steps[0]! })).rejects.toMatchObject({ code: "ArtifactHashMismatch" });
      expect(invoker.calls).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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
        { type: "assignExpressions", assignments: [
          { coreId: 0, expression: "g_payload", value: 1 },
          { coreId: 0, expression: "g_nonce", value: 2 }
        ] },
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
      "c2000_assignExpression", "c2000_assignExpression", "c2000_injectFaults",
      "c2000_evaluateMany", "c2000_evaluateMany", "c2000_waitForExpressionSet",
      "c2000_resetCores", "c2000_connectCores", "c2000_loadSymbols", "c2000_loadSymbols",
      "c2000_evaluateMany", "c2000_evaluateMany"
    ]);
    expect(invoker.calls.every(call => call.input.sessionId === "dbg-current")).toBe(true);
    expect(invoker.calls.every(call => call.input.__leaseContext === leaseContext)).toBe(true);
    expect(invoker.calls.find(call => call.toolName === "c2000_resetCores")?.input).toEqual(expect.objectContaining({ coreIds: [0, 2], resetType: "cpu" }));
    expect(invoker.calls.filter(call => call.toolName === "c2000_loadSymbols").map(call => call.input.coreId)).toEqual([0, 2]);
  });

  test("stops ordered durable assignments before the final nonce when a payload write fails", async () => {
    const invoker = new RecordingToolInvoker();
    invoker.failedAssignments.add("g_payload_b");
    const registry = new StepRegistry(invoker);
    const plan = testPlanSchema.parse({
      planVersion: 1,
      name: "mailbox-fail-fast",
      boardIds: ["board-a"],
      steps: [
        { type: "launchMulticore", loadPrograms: false },
        { type: "assignExpressions", assignments: [
          { coreId: 0, expression: "g_payload_a", value: 1 },
          { coreId: 0, expression: "g_payload_b", value: 2 },
          { coreId: 0, expression: "g_nonce", value: 3 }
        ] }
      ]
    });

    await expect(registry.execute({
      jobId: "job-a",
      boardId: "board-a",
      sessionId: "dbg-current",
      leaseContext: {
        leaseId: "lease-a", leaseToken: "secret", fencingToken: 7, leaseGeneration: 3,
        ownerJobId: "job-a", boardId: "board-a", probeSerial: "XDS-A", workerInstanceId: "worker-a"
      },
      plan,
      step: plan.steps[1]!
    })).rejects.toMatchObject({ code: "BatchOperationFailed" });

    expect(invoker.calls.map(call => call.input.expression)).toEqual(["g_payload_a", "g_payload_b"]);
  });

  test("fails closed when one captured expression is unreadable", async () => {
    const invoker = new RecordingToolInvoker();
    invoker.failedExpressions.add("g_unreadable");
    const registry = new StepRegistry(invoker);
    const plan = testPlanSchema.parse({
      planVersion: 1,
      name: "capture-fail-closed",
      boardIds: ["board-a"],
      steps: [
        { type: "launchMulticore", loadPrograms: false },
        { type: "captureExpressions", reads: [{ coreId: 0, expressions: ["g_ok", "g_unreadable"] }] }
      ]
    });

    await expect(registry.execute({
      jobId: "job-a",
      boardId: "board-a",
      sessionId: "dbg-job",
      leaseContext: {
        leaseId: "lease-a", leaseToken: "secret", fencingToken: 7, leaseGeneration: 3,
        ownerJobId: "job-a", boardId: "board-a", probeSerial: "XDS-A", workerInstanceId: "worker-a"
      },
      plan,
      step: plan.steps[1]!
    })).rejects.toMatchObject({
      code: "ExpressionCaptureFailed",
      details: {
        sampleIndex: 0,
        failures: [expect.objectContaining({ coreId: 0, expression: "g_unreadable" })]
      }
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
    expect(parsed).toEqual(expect.objectContaining({
      resetType: "cpu",
      loadSequence: { mode: "cpu1-run-before-cpu2", cpu1SettleMs: 250 },
      runSequence: { runMode: "debugger_runs_both", runCpu1First: true, runCpu2: true, settleMs: 500 }
    }));
  });

  test("durable IPC persists validated startup defaults and rejects conflicting presets or excessive polling", () => {
    const build = (step: Record<string, unknown>) => ({
      planVersion: 1 as const,
      name: "startup-contract",
      boardIds: ["board-a"],
      steps: [{ type: "launchMulticore", loadPrograms: false }, { type: "runIpcAcceptance", ...step }]
    });
    const parsed = testPlanSchema.parse(build({}));
    expect(parsed.steps[1]).toEqual(expect.objectContaining({
      resetType: "cpu",
      loadSequence: { mode: "cpu1-run-before-cpu2", cpu1SettleMs: 250 },
      runSequence: { runMode: "debugger_runs_both", runCpu1First: true, runCpu2: true, settleMs: 500 },
      timeoutMs: 10000,
      intervalMs: 100
    }));
    expect(testPlanSchema.safeParse(build({
      startupPreset: "hybrid30k-dk9-owner-first",
      runSequence: { runCpu1First: true, runCpu2: true, settleMs: 33 }
    })).success).toBe(false);
    expect(testPlanSchema.safeParse(build({ timeoutMs: 10001, intervalMs: 1 })).success).toBe(false);
  });

  test("durable launch persists the explicit owner-first startup contract and rejects conflicts", () => {
    const base = {
      planVersion: 1 as const,
      name: "durable-owner-first-launch",
      boardIds: ["board-a"],
      artifacts: {
        cpu1OutPath: "/firmware/cpu1.out",
        cpu1MapPath: "/firmware/cpu1.map",
        cpu2OutPath: "/firmware/cpu2.out",
        cpu2MapPath: "/firmware/cpu2.map"
      }
    };
    const startup = {
      startupPreset: "hybrid30k-dk9-owner-first",
      resetType: "cpu",
      loadSequence: { mode: "cpu1-run-before-cpu2", cpu1SettleMs: 250 },
      runSequence: { runMode: "debugger_runs_both", runCpu1First: true, runCpu2: true, settleMs: 500 }
    };
    const plan = testPlanSchema.parse({
      ...base,
      steps: [{ type: "launchMulticore", loadPrograms: true, ...startup }]
    });
    expect(plan.steps[0]).toEqual(expect.objectContaining({ type: "launchMulticore", loadPrograms: true, ...startup }));
    expect(parsePersistedTestPlan({ ...base, steps: [{ type: "launchMulticore", loadPrograms: true, ...startup }] }).steps[0])
      .toEqual(expect.objectContaining(startup));

    expect(testPlanSchema.safeParse({
      ...base,
      steps: [{ type: "launchMulticore", loadPrograms: true, ...startup, resetType: "system" }]
    }).success).toBe(false);
    expect(testPlanSchema.safeParse({
      ...base,
      steps: [{ type: "launchMulticore", loadPrograms: true, ...startup, loadSequence: { mode: "cpu1-then-cpu2", cpu1SettleMs: 250 } }]
    }).success).toBe(false);
  });

  test("durable launch forwards owner-first fields and requires a CPU2 linker map", async () => {
    const invoker = new RecordingToolInvoker();
    const registry = new StepRegistry(invoker);
    const plan = testPlanSchema.parse({
      planVersion: 1,
      name: "durable-owner-first-forwarding",
      boardIds: ["board-a"],
      artifacts: {
        cpu1OutPath: "/firmware/cpu1.out",
        cpu1MapPath: "/firmware/cpu1.map",
        cpu2OutPath: "/firmware/cpu2.out",
        cpu2MapPath: "/firmware/cpu2.map"
      },
      steps: [{
        type: "launchMulticore",
        loadPrograms: true,
        startupPreset: "hybrid30k-dk9-owner-first",
        resetType: "cpu",
        loadSequence: { mode: "cpu1-run-before-cpu2", cpu1SettleMs: 250 },
        runSequence: { runMode: "debugger_runs_both", runCpu1First: true, runCpu2: true, settleMs: 500 }
      }]
    });

    await registry.execute({ jobId: "job-owner-first", boardId: "board-a", plan, step: plan.steps[0] });
    expect(invoker.calls[0]).toEqual({
      toolName: "c2000_launchMulticoreDebug",
      input: expect.objectContaining({
        autoCloseOnComplete: false,
        startupPreset: "hybrid30k-dk9-owner-first",
        resetType: "cpu",
        loadSequence: { mode: "cpu1-run-before-cpu2", cpu1SettleMs: 250 },
        runSequence: { runMode: "debugger_runs_both", runCpu1First: true, runCpu2: true, settleMs: 500 },
        cores: expect.arrayContaining([
          expect.objectContaining({ coreId: 0, mapUri: "/firmware/cpu1.map" }),
          expect.objectContaining({ coreId: 2, mapUri: "/firmware/cpu2.map", ramOwnershipPolicy: "require-map" })
        ])
      })
    });
  });
});
