import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { BoardLeaseContext } from "../src/boards/types.js";
import { portableDurableEvidenceFromSteps } from "../src/artifacts/JobArtifactSnapshotService.js";
import { StepRegistry } from "../src/jobs/StepRegistry.js";
import { idempotencyForStep, parsePersistedTestPlan, testPlanSchema, type TestPlan } from "../src/jobs/TestPlanSchema.js";
import type { C2000ToolInvoker } from "../src/mcp/tools.js";
import type { TestStepRecord } from "../src/storage/repositories/TestRunRepository.js";
import { sha256File } from "../src/utils/fileHash.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

class ScriptedInvoker implements C2000ToolInvoker {
  readonly calls: Array<{ toolName: string; input: Record<string, unknown> }> = [];
  constructor(private readonly respond: (toolName: string, input: Record<string, unknown>) => Record<string, unknown> | Promise<Record<string, unknown>>) {}
  async invokeTool(toolName: string, input: unknown): Promise<Record<string, unknown>> {
    const record = input as Record<string, unknown>;
    this.calls.push({ toolName, input: record });
    return this.respond(toolName, record);
  }
}

const leaseContext: BoardLeaseContext = {
  leaseId: "lease-a", leaseToken: "secret-a", fencingToken: 7, leaseGeneration: 3,
  ownerJobId: "job-a", boardId: "board-a", probeSerial: "XDS-A", workerInstanceId: "worker-a"
};

describe("durable board-validation safety steps", () => {
  test("keeps run non-idempotent, halt safely retryable, and rejects malformed core/reset/restore contracts", () => {
    expect(idempotencyForStep("runCores")).toBe("NON_IDEMPOTENT");
    expect(idempotencyForStep("haltCores")).toBe("SAFE_RETRY");
    expect(idempotencyForStep("reconnectAfterTargetReset")).toBe("NON_IDEMPOTENT");
    expect(idempotencyForStep("restorePrograms")).toBe("NON_IDEMPOTENT");
    const base = { planVersion: 1, name: "strict-board-validation", boardIds: ["board-a"] };
    expect(testPlanSchema.safeParse({ ...base, steps: [{ type: "launchMulticore", loadPrograms: false }, { type: "runCores", coreIds: [1] }] }).success).toBe(false);
    expect(testPlanSchema.safeParse({ ...base, steps: [{ type: "launchMulticore", loadPrograms: false }, { type: "haltCores", coreIds: [0, 0] }] }).success).toBe(false);
    expect(testPlanSchema.safeParse({ ...base, steps: [{ type: "reconnectAfterTargetReset", coreIds: [0], timeoutMs: 10, resetCauseReads: [{ coreId: 0, expressions: ["resetCause"] }] }] }).success).toBe(false);
    expect(testPlanSchema.safeParse({ ...base, steps: [{ type: "launchMulticore", loadPrograms: false }, { type: "reconnectAfterTargetReset", coreIds: [0], timeoutMs: 10_001, intervalMs: 1, reloadSymbols: false, resetCauseReads: [{ coreId: 0, expressions: ["resetCause"] }] }] }).success).toBe(false);
    expect(testPlanSchema.safeParse({ ...base, safetyGuards: { conditions: [{ coreId: 0, expression: "safe", expected: 1 }] }, steps: [{ type: "delay", delayMs: 0 }] }).success).toBe(false);
    expect(testPlanSchema.safeParse({ ...base, safetyGuards: { conditions: [{ coreId: 0, expression: "safe", expected: 1 }], intervalMs: 1 }, steps: [{ type: "launchMulticore", loadPrograms: false }, { type: "delay", delayMs: 10_000 }] }).success).toBe(false);
    expect(testPlanSchema.safeParse({ ...base, safetyGuards: { conditions: [{ coreId: 0, expression: "safe", expected: 1 }] }, steps: [{ type: "launchMulticore", loadPrograms: false }, { type: "runCores", coreIds: [0] }] }).success).toBe(false);
    expect(testPlanSchema.safeParse({ ...base, steps: [{ type: "launchMulticore", loadPrograms: false }, { type: "restorePrograms", artifacts: {} }] }).success).toBe(false);
    expect(() => parsePersistedTestPlan({
      ...base,
      safetyGuards: { conditions: [{ coreId: 0, expression: "safe", operator: "not-equal", expected: 1 }] },
      steps: [{ type: "launchMulticore", loadPrograms: false }]
    })).toThrow();
  });

  test("runs and halts explicit cores through the same fenced session", async () => {
    const invoker = new ScriptedInvoker((_toolName, input) => ({ success: true, sessionId: input.sessionId, results: [] }));
    const registry = new StepRegistry(invoker);
    const plan = parsePlan([
      { type: "launchMulticore", loadPrograms: false },
      { type: "runCores", coreIds: [0], monitorMs: 0 },
      { type: "haltCores", coreIds: [0, 2] }
    ]);
    await registry.execute(context(plan, plan.steps[1]!));
    await registry.execute(context(plan, plan.steps[2]!));
    expect(invoker.calls.map(call => call.toolName)).toEqual(["c2000_runCores", "c2000_haltCores"]);
    expect(invoker.calls.map(call => call.input)).toEqual([
      expect.objectContaining({ sessionId: "dbg-current", coreIds: [0], __leaseContext: leaseContext }),
      expect.objectContaining({ sessionId: "dbg-current", coreIds: [0, 2], __leaseContext: leaseContext })
    ]);
  });

  test("reconnects only after an observed disconnect, reloads symbols, captures cause, and optionally runs CPU1 first", async () => {
    const root = await temporaryRoot();
    const cpu1OutPath = path.join(root, "cpu1.out");
    const cpu2OutPath = path.join(root, "cpu2.out");
    await Promise.all([writeFile(cpu1OutPath, "cpu1"), writeFile(cpu2OutPath, "cpu2")]);
    let snapshots = 0;
    const invoker = new ScriptedInvoker((toolName, input) => {
      if (toolName === "c2000_getMulticoreSnapshot") {
        snapshots += 1;
        return { success: true, sessionId: input.sessionId, cores: [{ coreId: 0, connected: snapshots === 1, state: snapshots === 1 ? "Halted" : "Disconnected" }, { coreId: 2, connected: true, state: "Halted" }] };
      }
      if (toolName === "c2000_evaluateMany") return { success: true, sessionId: input.sessionId, results: (input.expressions as string[]).map(expression => ({ expression, success: true, value: 3 })) };
      return { success: true, sessionId: input.sessionId, results: [] };
    });
    const registry = new StepRegistry(invoker, undefined, { allowedReadRoots: [root], allowedWriteRoots: [] });
    const plan = testPlanSchema.parse({
      planVersion: 1, name: "external-reset", boardIds: ["board-a"],
      artifacts: { cpu1OutPath, cpu2OutPath },
      steps: [
        { type: "launchMulticore", loadPrograms: false },
        {
          type: "reconnectAfterTargetReset", coreIds: [0, 2], timeoutMs: 50, intervalMs: 1,
          resetCauseReads: [{ coreId: 0, expressions: ["resetCause"] }],
          runAfterReconnect: { runCpu1: true, cpu1SettleMs: 0, runCpu2: true }
        }
      ]
    });
    const result = await registry.execute(context(plan, plan.steps[1]!));
    expect(result).toEqual(expect.objectContaining({ success: true, resetObservation: expect.objectContaining({ mode: "target-disconnected" }) }));
    expect(invoker.calls.map(call => call.toolName)).toEqual([
      "c2000_getMulticoreSnapshot", "c2000_getMulticoreSnapshot", "c2000_connectCores", "c2000_loadSymbols", "c2000_loadSymbols",
      "c2000_evaluateMany", "c2000_runCores", "c2000_runCores"
    ]);
    expect(invoker.calls.map(call => call.toolName)).not.toEqual(expect.arrayContaining(["c2000_resetCores", "c2000_loadPrograms", "c2000_loadProgram"]));
    expect(invoker.calls.every(call => call.input.__leaseContext === leaseContext)).toBe(true);
    expect(invoker.calls.filter(call => call.toolName === "c2000_runCores").map(call => call.input.coreIds)).toEqual([[0], [2]]);
  });

  test("fails closed when no real disconnect or matching reset evidence is observed", async () => {
    const invoker = new ScriptedInvoker((toolName, input) => {
      if (toolName === "c2000_getMulticoreSnapshot") return { success: true, sessionId: input.sessionId, cores: [{ coreId: 0, connected: true, state: "Halted" }] };
      if (toolName === "c2000_evaluateMany") return { success: true, results: [{ expression: "resetCause", success: true, value: 0 }] };
      return { success: true, sessionId: input.sessionId };
    });
    const registry = new StepRegistry(invoker);
    const plan = parsePlan([
      { type: "launchMulticore", loadPrograms: false },
      {
        type: "reconnectAfterTargetReset", coreIds: [0], timeoutMs: 2, intervalMs: 1, reloadSymbols: false,
        resetEvidence: [{ freshness: "transition-to-expected", coreId: 0, expression: "resetCause", expected: 3 }],
        resetCauseReads: [{ coreId: 0, expressions: ["resetCause"] }]
      }
    ]);
    await expect(registry.execute(context(plan, plan.steps[1]!))).rejects.toMatchObject({ code: "TargetResetNotObserved" });
    expect(invoker.calls.map(call => call.toolName)).not.toEqual(expect.arrayContaining(["c2000_connectCores", "c2000_loadSymbols", "c2000_resetCores", "c2000_loadPrograms", "c2000_runCores"]));
  });

  test("accepts explicit firmware reset-cause evidence when the adapter never reports disconnect", async () => {
    let resetEvidenceReads = 0;
    const invoker = new ScriptedInvoker((toolName, input) => {
      if (toolName === "c2000_getMulticoreSnapshot") return { success: true, sessionId: input.sessionId, cores: [{ coreId: 0, connected: true, state: "Halted" }] };
      if (toolName === "c2000_evaluateMany") {
        const expressions = input.expressions as string[];
        return { success: true, results: expressions.map(expression => ({
          expression,
          success: true,
          value: expression === "resetLatch" ? ++resetEvidenceReads + 3 : 9
        })) };
      }
      return { success: true, sessionId: input.sessionId, results: [] };
    });
    const registry = new StepRegistry(invoker);
    const plan = parsePlan([
      { type: "launchMulticore", loadPrograms: false },
      {
        type: "reconnectAfterTargetReset", coreIds: [0], timeoutMs: 10, intervalMs: 1, reloadSymbols: false,
        resetEvidence: [{ freshness: "transition-to-expected", coreId: 0, expression: "resetLatch", operator: "eq", expected: 5 }],
        resetCauseReads: [{ coreId: 0, expressions: ["resetCause"] }]
      }
    ]);
    await expect(registry.execute(context(plan, plan.steps[1]!))).resolves.toEqual(expect.objectContaining({
      resetObservation: expect.objectContaining({ mode: "explicit-reset-expression" })
    }));
    expect(invoker.calls.map(call => call.toolName)).toEqual([
      "c2000_getMulticoreSnapshot", "c2000_evaluateMany", "c2000_getMulticoreSnapshot", "c2000_evaluateMany", "c2000_connectCores", "c2000_evaluateMany"
    ]);
  });

  test("rejects a stale reset latch and unreadable reset evidence", async () => {
    const plan = parsePlan([
      { type: "launchMulticore", loadPrograms: false },
      {
        type: "reconnectAfterTargetReset", coreIds: [0], timeoutMs: 2, intervalMs: 1, reloadSymbols: false,
        resetEvidence: [{ freshness: "transition-to-expected", coreId: 0, expression: "resetLatch", expected: 5 }],
        resetCauseReads: [{ coreId: 0, expressions: ["resetCause"] }]
      }
    ]);
    const stale = new ScriptedInvoker((toolName, input) => toolName === "c2000_getMulticoreSnapshot"
      ? { success: true, cores: [{ coreId: 0, connected: true, state: "Halted" }, { coreId: 2, connected: false, state: "Disconnected" }] }
      : { success: true, results: (input.expressions as string[]).map(expression => ({ expression, success: true, value: 5 })) });
    await expect(new StepRegistry(stale).execute(context(plan, plan.steps[1]!))).rejects.toMatchObject({ code: "TargetResetNotObserved" });

    const unreadable = new ScriptedInvoker((toolName) => toolName === "c2000_getMulticoreSnapshot"
      ? { success: true, cores: [{ coreId: 0, connected: true, state: "Halted" }] }
      : { success: true, results: [{ expression: "resetLatch", success: false, error: { code: "ExpressionEvaluateFailed" } }] });
    await expect(new StepRegistry(unreadable).execute(context(plan, plan.steps[1]!))).rejects.toMatchObject({ code: "ResetEvidenceReadFailed" });
  });

  test.each(["all", "partial"] as const)("fails reset-cause capture when %s expression reads fail", async failureMode => {
    let snapshots = 0;
    const invoker = new ScriptedInvoker((toolName, input) => {
      if (toolName === "c2000_getMulticoreSnapshot") {
        snapshots += 1;
        return { success: true, cores: [{ coreId: 0, connected: snapshots === 1, state: snapshots === 1 ? "Halted" : "Disconnected" }] };
      }
      if (toolName === "c2000_evaluateMany") {
        if (failureMode === "all") return { success: false, error: { code: "ExpressionEvaluateFailed", message: "target unavailable" } };
        return { success: true, results: [
          { expression: "causeA", success: true, value: 1 },
          { expression: "causeB", success: false, error: { code: "ExpressionEvaluateFailed" } }
        ] };
      }
      return { success: true, sessionId: input.sessionId };
    });
    const plan = parsePlan([
      { type: "launchMulticore", loadPrograms: false },
      { type: "reconnectAfterTargetReset", coreIds: [0], timeoutMs: 10, intervalMs: 1, reloadSymbols: false, resetCauseReads: [{ coreId: 0, expressions: ["causeA", "causeB"] }] }
    ]);
    await expect(new StepRegistry(invoker).execute(context(plan, plan.steps[1]!))).rejects.toMatchObject({ code: "ResetCauseReadFailed" });
  });

  test("restores verified per-core programs as halt-load-halt without running or writing PC", async () => {
    const root = await temporaryRoot();
    const files = {
      cpu1OutPath: path.join(root, "cpu1.out"), cpu1MapPath: path.join(root, "cpu1.map"),
      cpu2OutPath: path.join(root, "cpu2.out"), cpu2MapPath: path.join(root, "cpu2.map")
    };
    await Promise.all(Object.entries(files).map(([name, file]) => writeFile(file, name)));
    const hashes = {
      cpu1Out: await sha256File(files.cpu1OutPath), cpu1Map: await sha256File(files.cpu1MapPath),
      cpu2Out: await sha256File(files.cpu2OutPath), cpu2Map: await sha256File(files.cpu2MapPath)
    };
    const invoker = new ScriptedInvoker((toolName, input) => {
      if (toolName === "c2000_loadPrograms") return {
        success: true, sessionId: input.sessionId,
        results: [{ coreId: 0, success: true, loaded: true, sha256: hashes.cpu1Out }, { coreId: 2, success: true, loaded: true, sha256: hashes.cpu2Out }]
      };
      if (toolName === "c2000_haltCores") return { success: true, sessionId: input.sessionId, results: [0, 2].map(coreId => ({ coreId, success: true })) };
      return { success: true, sessionId: input.sessionId, results: [] };
    });
    const registry = new StepRegistry(invoker, undefined, { allowedReadRoots: [root], allowedWriteRoots: [] });
    const plan = restorePlan(files, hashes);
    const result = await registry.execute(context(plan, plan.steps[1]!));
    expect(result).toEqual(expect.objectContaining({ success: true, finalState: "Halted", ranCores: false, wroteProgramCounter: false }));
    expect(invoker.calls.map(call => call.toolName)).toEqual(["c2000_haltCores", "c2000_loadPrograms", "c2000_haltCores"]);
    expect(invoker.calls[1]!.input.programs).toEqual([
      expect.objectContaining({ coreId: 0, ramOwnershipPolicy: "require-map", loadPolicy: "always" }),
      expect.objectContaining({ coreId: 2, ramOwnershipPolicy: "require-map", loadPolicy: "always" })
    ]);
    expect(invoker.calls.map(call => call.toolName)).not.toEqual(expect.arrayContaining(["c2000_runCores", "c2000_resetCores"]));

    const failingInvoker = new ScriptedInvoker((toolName, input) => toolName === "c2000_loadPrograms"
      ? { success: false, sessionId: input.sessionId, error: { code: "ProgramLoadFailed" } }
      : { success: true, sessionId: input.sessionId, results: [0, 2].map(coreId => ({ coreId, success: true })) });
    const failingRegistry = new StepRegistry(failingInvoker, undefined, { allowedReadRoots: [root], allowedWriteRoots: [] });
    await expect(failingRegistry.execute(context(plan, plan.steps[1]!))).rejects.toMatchObject({ code: "RestoreProgramsFailed" });
    expect(failingInvoker.calls.map(call => call.toolName)).toEqual(["c2000_haltCores", "c2000_loadPrograms", "c2000_haltCores"]);
  });

  test("isolates restore hash, path-root, and missing-file preflight failures without loading", async () => {
    const root = await temporaryRoot();
    const files = {
      cpu1OutPath: path.join(root, "cpu1.out"), cpu1MapPath: path.join(root, "cpu1.map"),
      cpu2OutPath: path.join(root, "cpu2.out"), cpu2MapPath: path.join(root, "cpu2.map")
    };
    await Promise.all(Object.values(files).map(file => writeFile(file, "actual")));
    const wrong = "0".repeat(64);
    const invoker = new ScriptedInvoker((_toolName, input) => ({ success: true, sessionId: input.sessionId, results: [0, 2].map(coreId => ({ coreId, success: true })) }));
    const registry = new StepRegistry(invoker, undefined, { allowedReadRoots: [root], allowedWriteRoots: [] });
    const plan = restorePlan(files, { cpu1Out: wrong, cpu1Map: wrong, cpu2Out: wrong, cpu2Map: wrong });
    await expect(registry.execute(context(plan, plan.steps[1]!))).rejects.toMatchObject({ code: "RestoreProgramsFailed", details: { cause: { code: "ArtifactHashMismatch" }, isolation: { success: true } } });
    expect(invoker.calls.map(call => call.toolName)).toEqual(["c2000_haltCores"]);

    const actual = {
      cpu1Out: await sha256File(files.cpu1OutPath), cpu1Map: await sha256File(files.cpu1MapPath),
      cpu2Out: await sha256File(files.cpu2OutPath), cpu2Map: await sha256File(files.cpu2MapPath)
    };
    const otherRoot = await temporaryRoot();
    const outsideRegistry = new StepRegistry(invoker, undefined, { allowedReadRoots: [otherRoot], allowedWriteRoots: [] });
    const outsidePlan = restorePlan(files, actual);
    await expect(outsideRegistry.execute(context(outsidePlan, outsidePlan.steps[1]!))).rejects.toMatchObject({ code: "RestoreProgramsFailed", details: { cause: { code: "PathOutsideAllowedReadRoots" }, isolation: { success: true } } });

    const missingFiles = { ...files, cpu1OutPath: path.join(root, "missing.out") };
    const missingPlan = restorePlan(missingFiles, actual);
    await expect(registry.execute(context(missingPlan, missingPlan.steps[1]!))).rejects.toMatchObject({ code: "RestoreProgramsFailed" });
    expect(invoker.calls.map(call => call.toolName)).toEqual(["c2000_haltCores", "c2000_haltCores", "c2000_haltCores"]);
    expect(invoker.calls.map(call => call.toolName)).not.toContain("c2000_loadPrograms");
  });

  test("halts with the same fencing lease on first guard mismatch", async () => {
    const invoker = new ScriptedInvoker((toolName, input) => toolName === "c2000_evaluateMany"
      ? { success: true, results: [{ expression: "g_safe", success: true, value: 0 }] }
      : { success: true, sessionId: input.sessionId, results: [0, 2].map(coreId => ({ coreId, success: true })) });
    const registry = new StepRegistry(invoker);
    const plan = testPlanSchema.parse({
      planVersion: 1, name: "guarded", boardIds: ["board-a"],
      safetyGuards: { conditions: [{ coreId: 0, expression: "g_safe", operator: "eq", expected: 1 }], haltCoreIds: [0, 2], intervalMs: 1 },
      steps: [{ type: "launchMulticore", loadPrograms: false }, { type: "delay", delayMs: 1 }]
    });
    await expect(registry.assertSafetyGuards(context(plan, plan.steps[1]!), "dbg-current", "before-step")).rejects.toMatchObject({ code: "SafetyGuardViolation" });
    expect(invoker.calls.map(call => call.toolName)).toEqual(["c2000_evaluateMany", "c2000_haltCores"]);
    expect(invoker.calls[1]!.input).toEqual(expect.objectContaining({ sessionId: "dbg-current", coreIds: [0, 2], __leaseContext: leaseContext }));

    const unreadable = new ScriptedInvoker((toolName, input) => toolName === "c2000_evaluateMany"
      ? { success: false, error: { code: "ExpressionEvaluateFailed" } }
      : { success: true, sessionId: input.sessionId, results: [0, 2].map(coreId => ({ coreId, success: true })) });
    const unreadableRegistry = new StepRegistry(unreadable);
    await expect(unreadableRegistry.assertSafetyGuards(context(plan, plan.steps[1]!), "dbg-current", "wait-monitor")).rejects.toMatchObject({ code: "SafetyGuardViolation" });
    expect(unreadable.calls.map(call => call.toolName)).toEqual(["c2000_evaluateMany", "c2000_haltCores"]);
  });

  test("includes new target-control outputs in portable durable evidence", () => {
    const step = {
      stepRunId: "step-run", jobId: "job-a", boardId: "board-a", stepIndex: 1, stepType: "runCores",
      input: { type: "runCores", coreIds: [0] }, status: "PASSED", attempt: 1, idempotencyClass: "NON_IDEMPOTENT",
      output: { success: true, sessionId: "dbg-current", run: { results: [{ coreId: 0, state: "Running" }] } }
    } satisfies TestStepRecord;
    expect(portableDurableEvidenceFromSteps([step]).durableStepResults).toEqual([
      expect.objectContaining({ stepType: "runCores", output: expect.objectContaining({ success: true }) })
    ]);
  });
});

function parsePlan(steps: unknown[]): TestPlan {
  return testPlanSchema.parse({ planVersion: 1, name: "board-validation", boardIds: ["board-a"], steps });
}

function context(plan: TestPlan, step: TestPlan["steps"][number]) {
  return { jobId: "job-a", boardId: "board-a", sessionId: "dbg-current", leaseContext, plan, step };
}

function restorePlan(files: Record<string, string>, hashes: Record<string, string>): TestPlan {
  return parsePlan([
    { type: "launchMulticore", loadPrograms: false },
    {
      type: "restorePrograms", on: "always",
      artifacts: {
        cpu1: { coreId: 0, outPath: files.cpu1OutPath, mapPath: files.cpu1MapPath, outSha256: hashes.cpu1Out, mapSha256: hashes.cpu1Map },
        cpu2: { coreId: 2, outPath: files.cpu2OutPath, mapPath: files.cpu2MapPath, outSha256: hashes.cpu2Out, mapSha256: hashes.cpu2Map }
      }
    }
  ]);
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "c2000-board-validation-"));
  roots.push(root);
  return root;
}
