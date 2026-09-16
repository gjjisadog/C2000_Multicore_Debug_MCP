import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { MockDebugAdapter } from "../src/adapters/MockDebugAdapter.js";
import type { AdapterSession } from "../src/adapters/types.js";
import { DebugSessionManager } from "../src/debug/DebugSessionManager.js";
import { LoadedProgramRegistry } from "../src/debug/LoadedProgramRegistry.js";
import type { CoreId, ResetType, EvaluateResult } from "../src/debug/types.js";
import { createToolHandlers } from "../src/mcp/toolHandlers.js";
import { DebugMcpError } from "../src/utils/errors.js";
import { sha256File } from "../src/utils/fileHash.js";

const coreMap = [{ coreId: 0, coreName: "C28xx_CPU1" }, { coreId: 2, coreName: "C28xx_CPU2" }];

class StartupAdapter extends MockDebugAdapter {
  events: string[] = [];
  haltedCores: CoreId[] = [];
  fail?: "prepare" | "cpu1-prepare" | "post-load-reset";
  stayInBootRom = false;
  failCpu2Pc = false;
  gateFailure?: "stale" | "app-init" | "logic" | "mirror" | "unsafe" | "armed-read" | "fenced";
  gateLogic = 0;
  gateMirrorReads = 0;
  private handedOff = false;
  private applicationStarted = false;

  override async prepareFirmwareHandoff(session: AdapterSession, coreId: CoreId) {
    this.events.push(`prepare:${coreId}`);
    if (this.fail === "prepare" || (coreId === 0 && this.fail === "cpu1-prepare")) {
      throw new DebugMcpError("DssCommandFailed", "GEL unload failed");
    }
    await super.prepareFirmwareHandoff(session, coreId);
    this.handedOff = true;
  }
  override async reset(session: AdapterSession, coreId: CoreId, type: ResetType) {
    this.events.push(`reset:${coreId}:${type}`);
    if (this.handedOff && this.fail === "post-load-reset") {
      throw new DebugMcpError("DssCommandFailed", "post-load reset failed");
    }
    await super.reset(session, coreId, type);
    if (coreId === 0) this.applicationStarted = false;
  }
  override async connect(session: AdapterSession, coreId: CoreId) {
    this.events.push(`connect:${coreId}`);
    await super.connect(session, coreId);
  }
  override async disconnect(session: AdapterSession, coreId: CoreId) {
    this.events.push(`disconnect:${coreId}`);
    await super.disconnect(session, coreId);
  }
  override async run(session: AdapterSession, coreId: CoreId) {
    this.events.push(`run:${coreId}`);
    await super.run(session, coreId);
    if (coreId === 0 && !this.stayInBootRom) this.applicationStarted = true;
  }
  override async halt(session: AdapterSession, coreId: CoreId) {
    this.haltedCores.push(coreId);
    await super.halt(session, coreId);
  }
  override async readPc(session: AdapterSession, coreId: CoreId) {
    if (coreId === 0) return this.applicationStarted ? "0x00080000" : "0x003FB445";
    if (this.failCpu2Pc && this.applicationStarted) {
      throw new DebugMcpError("DssCommandFailed", "CPU2 held in reset");
    }
    return super.readPc(session, coreId);
  }
  override async loadProgram(session: AdapterSession, coreId: CoreId, uri: string) {
    this.events.push(`load:${coreId}`);
    await super.loadProgram(session, coreId, uri);
  }
  override async evaluateExpression(session: AdapterSession, coreId: CoreId, expression: string): Promise<EvaluateResult> {
    if (expression.startsWith("c2.")) {
      this.events.push(`read:${coreId}:${expression}`);
      if (this.applicationStarted && this.gateFailure === "fenced") return { expression, success: false,
        error: { code: "LeaseFencingRejected", message: "test fencing" } };
      const values: Record<string, number> = {
        "c2.abi": 48, "c2.role": 2,
        "c2.epoch": this.applicationStarted && this.gateFailure !== "stale" ? 11 : 10,
        "c2.status": this.gateFailure === "app-init" ? 0 : 32,
        "c2.logic": this.gateFailure === "logic" ? 0 : ++this.gateLogic
      };
      return { expression, success: true, value: String(values[expression]) };
    }
    if (coreId === 2 && expression === "ipc.ready") {
      this.gateMirrorReads++;
      if (this.gateFailure === "mirror" || (this.gateFailure === "armed-read" && this.gateMirrorReads > 1)) {
        return { expression, success: true, value: "0x0BAD" };
      }
      if (this.gateFailure === "unsafe") return { expression, success: true, value: "0" };
    }
    return super.evaluateExpression(session, coreId, expression);
  }
}

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "c2000-reset-contract-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const paths = {
    cpu1OutPath: path.join(dir, "cpu1.out"), cpu2OutPath: path.join(dir, "cpu2.out"),
    cpu1MapPath: path.join(dir, "cpu1.map"), cpu2MapPath: path.join(dir, "cpu2.map")
  };
  for (const file of Object.values(paths)) {
    await writeFile(file, file.endsWith(".map")
      ? "MEMORY CONFIGURATION\n  RAMLS0  00008000 00000800 00000010 000007f0 RWIX\nSECTION ALLOCATION MAP\n.text      0    00008000    00000100\n"
      : "host-only dummy image");
  }
  const adapter = new StartupAdapter({ expressionValues: {
    "ipc.ready": { value: "1" },
    "boot.mode": { value: "wait-boot" },
    "cpu1.reset": { value: "held" },
    "boot.sync": { value: "waiting" }
  } });
  const manager = new DebugSessionManager(adapter, new LoadedProgramRegistry());
  const handlers = createToolHandlers(manager);
  const created = await handlers.createDebugSession({ sessionName: "reset-contract", coreMap });
  cleanups.push(() => manager.closeDebugSession(created.sessionId));
  await handlers.connectCores({ sessionId: created.sessionId, coreIds: [0, 2] });
  adapter.events = [];
  const input = {
    sessionId: created.sessionId, cpu1CoreId: 0, cpu2CoreId: 2, device: "F28P65x", ...paths,
    resetType: "cpu" as const, ramOwnershipPolicy: "skip" as const,
    cpu1EntryAddress: "0x00080000",
    runSequence: { runMode: "cpu1_boots_cpu2" as const, runCpu1First: true, runCpu2: false, settleMs: 0 },
    ipcReadyExpressions: [{ coreId: 0, expression: "ipc.ready", expected: 1 }], timeoutMs: 20, intervalMs: 1
  };
  return { adapter, handlers, input, manager };
}

async function systemResetFixture() {
  const context = await fixture();
  const { input, manager, adapter } = context;
  await manager.loadPrograms(input.sessionId, [
    { coreId: 0, programUri: input.cpu1OutPath }, { coreId: 2, programUri: input.cpu2OutPath }
  ]);
  adapter.events = [];
  return { ...context, input: { ...input,
    programPreparation: "symbols-only" as const, loadPolicy: "verify-mcp-registry" as const,
    cpu1OutSha256: await sha256File(input.cpu1OutPath), cpu2OutSha256: await sha256File(input.cpu2OutPath),
    cpu1MapSha256: await sha256File(input.cpu1MapPath), cpu2MapSha256: await sha256File(input.cpu2MapPath),
    preStartupSafetyGuard: { haltCoreIds: [0, 2], conditions: [
      { coreId: 0, expression: "ipc.ready", expected: 1 },
      { coreId: 2, expression: "ipc.ready", expected: 1 }
    ] },
    systemResetBeforeHandoff: { authorized: true as const, postStartupConditions: [
      { coreId: 0, expression: "boot.sync", expected: "waiting" }
    ] }
  } };
}

describe("post-load reset and firmware-owned handoff", () => {
  const bootContract = { abiExpression: "c2.abi", abiVersion: 48, roleExpression: "c2.role", roleValue: 2,
    epochExpression: "c2.epoch", statusExpression: "c2.status", appInitMask: 32,
    logicAliveExpression: "c2.logic", timeoutMs: 100, intervalMs: 20 };
  test("two-phase workflow arms after committed LogicAlive and before IPC readiness", async () => {
    const { adapter, handlers, input } = await systemResetFixture();
    const result = await handlers.runIpcAcceptance({ ...input, systemResetBeforeHandoff: {
      ...input.systemResetBeforeHandoff, cpu2BootContract: bootContract
    } });
    expect(result).toMatchObject({ success: true, cpu2BootGate: { guardState: "ARMED", bootEpoch: 11 } });
    expect(adapter.events.indexOf("read:0:c2.logic")).toBeLessThan(adapter.events.indexOf("connect:2"));
    expect(result.performedSteps.indexOf("armCpu2SafetyGuard")).toBeLessThan(result.performedSteps.indexOf("waitForIpcReady"));
    expect(adapter.events).not.toContain("run:2");
  });
  test.each(["stale", "app-init", "logic", "mirror"] as const)(
    "two-phase %s failure halts and captures CPU1 before cleanup without IPC acceptance", async failure => {
      const { adapter, handlers, input } = await systemResetFixture(); adapter.gateFailure = failure;
      const result = await handlers.runIpcAcceptance({ ...input, bootSyncExpressions: ["boot.sync"],
        systemResetBeforeHandoff: { ...input.systemResetBeforeHandoff, cpu2BootContract: bootContract } });
      expect(result).toMatchObject({ success: false, error: { code: "Cpu2BootContractTimeout", details: {
        ipcReadySkipped: true, halt: { success: failure === "mirror" }, cpu2BootGate: { guardState: "DISARMED" },
        firstFaultCpu1: { phase: "after-confirmed-cpu1-halt", results: [{ success: true, value: "waiting" }] }
      } } });
      expect(adapter.haltedCores.slice(-2)).toEqual([0, 2]);
      expect(result.ipcReady).toBeUndefined();
    });
  test.each(["unsafe", "armed-read"] as const)("two-phase %s still fails safe", async failure => {
    const { adapter, handlers, input } = await systemResetFixture(); adapter.gateFailure = failure;
    const result = await handlers.runIpcAcceptance({ ...input,
      systemResetBeforeHandoff: { ...input.systemResetBeforeHandoff, cpu2BootContract: bootContract } });
    expect(result).toMatchObject({ success: false, error: { code: "SafetyGuardViolation", details: { halt: { success: true } } } });
    expect(adapter.haltedCores.slice(-2)).toEqual([0, 2]);
  });
  test("two-phase fencing failure cannot reconnect, retry, or submit a diagnostic halt", async () => {
    const { adapter, handlers, input } = await systemResetFixture(); adapter.gateFailure = "fenced";
    const result = await handlers.runIpcAcceptance({ ...input,
      systemResetBeforeHandoff: { ...input.systemResetBeforeHandoff, cpu2BootContract: bootContract } });
    expect(result).toMatchObject({ success: false, error: { code: "LeaseFencingRejected" } });
    expect(adapter.events.filter(event => event === "connect:2")).toHaveLength(0);
    expect(result.error.details.halt).toBeUndefined();
  });
  test("authorized System Reset occurs with both cores connected and no later CPU reset/run authority", async () => {
    const { adapter, handlers, input } = await systemResetFixture();
    const result = await handlers.runIpcAcceptance(input);
    expect(result.success).toBe(true);
    expect(adapter.events).toEqual([
      "prepare:2", "prepare:0", "reset:0:system", "disconnect:2", "run:0", "connect:2"
    ]);
    expect(result.postLoadReset).toMatchObject({ authorized: true, phase: "before-cpu2-disconnect",
      physicalColdStartVerified: false, affectsPeripheralAndProtectionState: true,
      before: { cores: [
        { coreId: 0, connected: true, state: "Halted" }, { coreId: 2, connected: true, state: "Halted" }
      ] }
    });
    expect(result.safetyGuardChecks.map((check: { phase: string }) => check.phase)).toEqual([
      "symbols-loaded-before-startup", "post-system-reset-startup"
    ]);
    expect(result.ipcReady.conditions).toHaveLength(1);
    expect(result.effectsApplied).toContain("target-reset");
  });

  test.each([
    { systemResetBeforeHandoff: { authorized: false, postStartupConditions: [] } },
    { postLoadResetType: "cpu" }, { postLoadResetType: "system" },
    { programPreparation: "load" }, { loadPolicy: "always" },
    { preStartupSafetyGuard: undefined }, { cpu1OutSha256: undefined },
    { runSequence: { runMode: "debugger_runs_both", runCpu1First: true, runCpu2: true } },
    { systemResetBeforeHandoff: { authorized: true, postStartupConditions: [
      { coreId: 0, expression: "clearTrip()", expected: 1 }
    ] } }
  ] as Array<Record<string, unknown>>)("rejects incomplete or contradictory System Reset authorization %j before target access", async overrides => {
    const { adapter, handlers, input } = await systemResetFixture();
    const result = await handlers.runIpcAcceptance({ ...input, ...overrides });
    expect(result.success).toBe(false);
    expect(adapter.events).toEqual([]);
    expect(adapter.haltedCores).toEqual([]);
  });

  test("symbols alone cannot establish the current-session identity required for System Reset", async () => {
    const { adapter, handlers, input, manager } = await systemResetFixture();
    const created = await handlers.createDebugSession({ sessionName: "symbols-not-identity", coreMap });
    cleanups.push(() => manager.closeDebugSession(created.sessionId));
    await handlers.connectCores({ sessionId: created.sessionId, coreIds: [0, 2] });
    adapter.events = [];
    const result = await handlers.runIpcAcceptance({ ...input, sessionId: created.sessionId });
    expect(result.success).toBe(false);
    expect(adapter.events).toEqual([]);
  });

  test.each(["prepare", "cpu1-prepare", "post-load-reset"] as const)(
    "System Reset %s failure never disconnects or runs either core", async failure => {
      const { adapter, handlers, input } = await systemResetFixture();
      adapter.fail = failure;
      const result = await handlers.runIpcAcceptance(input);
      expect(result.success).toBe(false);
      expect(adapter.events.some(event => /^(disconnect|run|connect):/.test(event))).toBe(false);
    }
  );

  test("System Reset pre-guard mismatch stops before reset", async () => {
    const { adapter, handlers, input } = await systemResetFixture();
    input.preStartupSafetyGuard.conditions[1]!.expected = 0;
    const result = await handlers.runIpcAcceptance(input);
    expect(result).toMatchObject({ success: false, error: { code: "SafetyGuardViolation" } });
    expect(adapter.events).toEqual([]);
    expect(adapter.haltedCores.slice(-2)).toEqual([0, 2]);
  });

  test("post-System Reset guard mismatch preserves reset evidence and halts without IPC acceptance", async () => {
    const { adapter, handlers, input } = await systemResetFixture();
    input.systemResetBeforeHandoff.postStartupConditions[0]!.expected = "unsafe";
    const result = await handlers.runIpcAcceptance(input);
    expect(result).toMatchObject({ success: false, error: { code: "SafetyGuardViolation", details: {
      workflowStage: "post-system-reset-safety-guard", ipcReadySkipped: true,
      evidence: { phase: "post-system-reset-startup", matched: false },
      postLoadReset: { phase: "before-cpu2-disconnect", authorized: true }
    } } });
    expect(adapter.haltedCores.slice(-2)).toEqual([0, 2]);
    expect(result.ipcReady).toBeUndefined();
  });

  test("System Reset entry failure leaves CPU2 disconnected", async () => {
    const { adapter, handlers, input } = await systemResetFixture();
    adapter.stayInBootRom = true;
    const result = await handlers.runIpcAcceptance({ ...input, applicationEntryTimeoutMs: 5 });
    expect(result).toMatchObject({ success: false, error: { code: "ApplicationEntryNotReached" } });
    expect(adapter.events.slice(adapter.events.indexOf("disconnect:2") + 1)).toEqual(["run:0"]);
  });

  test("incomplete observations fail closed even when every IPC ready condition matches", async () => {
    const { adapter, handlers, input } = await fixture();
    const result = await handlers.runIpcAcceptance({ ...input, bootSyncExpressions: ["boot.missing"] });
    expect(result.success).toBe(false);
    expect(result.error.code).toBe("ExpressionCaptureFailed");
    expect(result.error.details.firstFailureEvidence.ipcReady.matched).toBe(true);
    expect(result.error.details.firstFailureEvidence.ipcReady.diagnosticReads.complete).toBe(false);
    expect(adapter.haltedCores.slice(-2)).toEqual([0, 2]);
  });

  test.each(["boot.sync = 1", "boot.sync++", "clearTrip()", "*(unsigned int *)(ptr++)"])(
    "rejects non-read-only boot observation %s before target access", async expression => {
      const { adapter, handlers, input } = await fixture();
      const result = await handlers.runIpcAcceptance({ ...input, bootSyncExpressions: [expression] });
      expect(result.success).toBe(false);
      expect(adapter.events).toEqual([]);
    }
  );

  test("missing boot observation map symbol fails before load or startup", async () => {
    const { adapter, handlers, input } = await fixture();
    await writeFile(input.cpu1MapPath, "GLOBAL SYMBOLS: SORTED BY Symbol Address\n00008000 ipc\n");
    const result = await handlers.runIpcAcceptance({ ...input, bootSyncExpressions: ["missingWatch.firstError"] });
    expect(result.success).toBe(false);
    expect(result.error.code).toBe("ArtifactPairInvalid");
    expect(result.error.details.issues.join(" ")).toContain("missingWatch");
    expect(adapter.events).toEqual([]);
    expect(adapter.haltedCores).toEqual([]);
  });
  test("CPU1 boot observations do not become additional IPC ready conditions", async () => {
    const { handlers, input } = await fixture();
    const result = await handlers.runIpcAcceptance({
      ...input, bootSyncExpressions: ["boot.sync", "cpu1.reset"]
    });
    expect(result.success).toBe(true);
    expect(result.ipcReady.conditions).toHaveLength(1);
    expect(result.ipcReady.diagnosticReads).toMatchObject({
      coreId: 0, results: [
        { expression: "boot.sync", success: true, value: "waiting" },
        { expression: "cpu1.reset", success: true, value: "held" }
      ]
    });
  });

  test("retains CPU1 first-poll observations when CPU2 PC diagnostics fail", async () => {
    const { adapter, handlers, input } = await fixture();
    adapter.failCpu2Pc = true;
    const result = await handlers.runIpcAcceptance({
      ...input, bootSyncExpressions: ["boot.sync", "cpu1.reset"],
      ipcReadyExpressions: [{ coreId: 0, expression: "ipc.ready", expected: 2 }]
    });
    expect(result.success).toBe(false);
    const evidence = result.error.details.firstFailureEvidence;
    expect(evidence.firstFailureCode).toBe("IPC_READY_TIMEOUT");
    expect(evidence.ipcReady.firstFailure.diagnosticReads).toMatchObject({
      coreId: 0, results: [
        { expression: "boot.sync", success: true, value: "waiting" },
        { expression: "cpu1.reset", success: true, value: "held" }
      ]
    });
    expect(evidence.ipcReady.conditions).toHaveLength(1);
  });

  test.each([undefined, "cpu", "restart"] as const)("IPC loads use CPU1-only post-load reset (%s)", async type => {
    const { adapter, handlers, input } = await fixture();
    const result = await handlers.runIpcAcceptance({ ...input, postLoadResetType: type });
    expect(result.success).toBe(true);
    expect(adapter.events).toEqual([
      "load:0", "load:2",
      "prepare:2", "disconnect:2", ...(type === "cpu" ? ["prepare:0"] : []),
      `reset:0:${type ?? "restart"}`, "run:0", "connect:2"
    ]);
    expect(result.performedSteps).toContain("resetCpu1AfterLoad");
    expect(result.effectsApplied).toContain("debugger-gel-unload");
  });

  test.each(["ipc", "reload"])("%s owner CPU Reset suppresses CPU1 GEL before reset", async mode => {
    const { adapter, handlers, input } = await fixture();
    const result = mode === "ipc"
      ? await handlers.runIpcAcceptance({ ...input, postLoadResetType: "cpu" })
      : await handlers.runReloadAndDiagnose({ ...input,
        postLoadBoot: { resetType: "cpu", releaseCpu2BeforeCpu1: true, runCpu1: true,
          runCpu2: false, cpu1SettleMs: 0 }
      });
    expect(result.success).toBe(true);
    expect(result.postLoadReset.preparation).toMatchObject({ coreId: 0, gelInitializationDisabled: true });
    expect(result.performedSteps).toContain("disableCpu1ResetInitialization");
    const handoff = adapter.events.slice(adapter.events.indexOf("disconnect:2") + 1);
    expect(handoff).toEqual(["prepare:0", "reset:0:cpu", "run:0", "connect:2"]);
  });

  test.each(["ipc", "reload"])("%s CPU1 GEL suppression failure forbids owner reset/run", async mode => {
    const { adapter, handlers, input } = await fixture();
    adapter.fail = "cpu1-prepare";
    const result = mode === "ipc"
      ? await handlers.runIpcAcceptance({ ...input, postLoadResetType: "cpu" })
      : await handlers.runReloadAndDiagnose({ ...input,
        postLoadBoot: { resetType: "cpu", releaseCpu2BeforeCpu1: true, runCpu1: true,
          runCpu2: false, cpu1SettleMs: 0 }
      });
    expect(result).toMatchObject({ success: false,
      error: { code: "DssCommandFailed", details: { workflowStage: "cpu1-reset-initialization-disable" } }
    });
    const handoff = adapter.events.slice(adapter.events.indexOf("disconnect:2") + 1);
    expect(handoff).toEqual(["prepare:0"]);
  });

  test("symbols-only uses the CPU1-only reset before application-entry confirmation", async () => {
    const { adapter, handlers, input } = await fixture();
    const result = await handlers.runIpcAcceptance({ ...input, programPreparation: "symbols-only" });
    expect(result.success).toBe(true);
    expect(adapter.events).toEqual([
      "prepare:2", "disconnect:2", "reset:0:restart", "run:0", "connect:2"
    ]);
    expect(result.postLoadReset).toEqual(expect.objectContaining({ coreId: 0, state: "Halted" }));
  });

  test("rejects a system reset after CPU2 is disconnected", async () => {
    const { adapter, handlers, input } = await fixture();
    const result = await handlers.runIpcAcceptance({ ...input, postLoadResetType: "system" });
    expect(result).toEqual(expect.objectContaining({
      success: false,
      error: expect.objectContaining({ code: "Cpu1OnlyResetRequired" })
    }));
    expect(adapter.events).toEqual([]);
  });

  test("postLoadResetType is rejected for debugger-owned startup before target mutation", async () => {
    const { adapter, handlers, input } = await fixture();
    await expect(handlers.runIpcAcceptance({
      ...input, postLoadResetType: "system",
      runSequence: { runMode: "debugger_runs_both", runCpu1First: true, runCpu2: true, settleMs: 0 }
    })).resolves.toMatchObject({ success: false, error: { code: "StartupContractInvalid" } });
    expect(adapter.events).toEqual([]);
  });

  test("reports APPLICATION_ENTRY_NOT_REACHED without touching CPU2 after disconnect", async () => {
    const { adapter, handlers, input } = await fixture();
    adapter.stayInBootRom = true;
    const result = await handlers.runIpcAcceptance({
      ...input,
      applicationEntryTimeoutMs: 5,
      bootModeExpression: "boot.mode",
      cpu1ResetStateExpression: "cpu1.reset",
      bootSyncExpressions: ["boot.sync"]
    });

    expect(result).toEqual(expect.objectContaining({
      success: false,
      error: expect.objectContaining({
        code: "ApplicationEntryNotReached",
        details: expect.objectContaining({
          diagnosisCode: "APPLICATION_ENTRY_NOT_REACHED",
          ipcReadySkipped: true,
          applicationEntry: expect.objectContaining({
            reached: false,
            lastPc: "0x003FB445",
            timedOut: true
          }),
          startupEvidence: expect.objectContaining({
            cpu2: expect.objectContaining({
              connected: false,
              targetOperationsSuppressed: true
            }),
            cpu1: expect.objectContaining({
              bootMode: expect.objectContaining({ result: expect.objectContaining({ value: "wait-boot" }) }),
              resetState: expect.objectContaining({ result: expect.objectContaining({ value: "held" }) }),
              bootSync: expect.objectContaining({
                expressions: [expect.objectContaining({ expression: "boot.sync", result: expect.objectContaining({ value: "waiting" }) })]
              })
            })
          })
        })
      })
    }));
    const disconnectIndex = adapter.events.indexOf("disconnect:2");
    expect(disconnectIndex).toBeGreaterThanOrEqual(0);
    expect(adapter.events.slice(disconnectIndex + 1)).toEqual(["reset:0:restart", "run:0"]);
    expect(adapter.events.filter(event => event.startsWith("reset:2:"))).toEqual([]);
  });

  test.each(["ipc", "reload"])("%s handoff preparation failure stops before disconnect/run", async mode => {
    const { adapter, handlers, input } = await fixture();
    adapter.fail = "prepare";
    const result = mode === "ipc" ? handlers.runIpcAcceptance(input) : handlers.runReloadAndDiagnose({
      ...input, postLoadBoot: { resetType: "restart", releaseCpu2BeforeCpu1: true, runCpu1: true, runCpu2: false, cpu1SettleMs: 0 }
    });
    await expect(result).resolves.toMatchObject({
      success: false,
      error: { code: "DssCommandFailed", details: { workflowStage: "cpu2-connect-initialization-disable" } }
    });
    expect(adapter.events.at(-1)).toBe("prepare:2");
    expect(adapter.events.some(event => /^(disconnect|run|connect):/.test(event))).toBe(false);
  });

  test.each(["ipc", "reload"])("%s post-load reset failure never runs or reconnects CPU2", async mode => {
    const { adapter, handlers, input } = await fixture();
    adapter.fail = "post-load-reset";
    const result = mode === "ipc" ? handlers.runIpcAcceptance(input) : handlers.runReloadAndDiagnose({
      ...input, postLoadBoot: { resetType: "restart", releaseCpu2BeforeCpu1: true, runCpu1: true, runCpu2: false, cpu1SettleMs: 0 }
    });
    await expect(result).resolves.toMatchObject({
      success: false, error: { details: { workflowStage: "post-load-cpu1-reset" } }
    });
    expect(adapter.events).toContain("disconnect:2");
    expect(adapter.events.some(event => /^(run|connect):/.test(event))).toBe(false);
    expect(adapter.events.filter(event => event.startsWith("reset:2:"))).toEqual([]);
  });
});
