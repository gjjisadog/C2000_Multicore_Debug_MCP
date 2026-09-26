import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { MockDebugAdapter } from "../src/adapters/MockDebugAdapter.js";
import type { AdapterSession } from "../src/adapters/types.js";
import { DebugSessionManager } from "../src/debug/DebugSessionManager.js";
import { LoadedProgramRegistry } from "../src/debug/LoadedProgramRegistry.js";
import type { CoreId, ResetTargetState, ResetType } from "../src/debug/types.js";
import { createToolHandlers } from "../src/mcp/toolHandlers.js";
import { DebugWorkflowService, resolvePairedFlashContract } from "../src/workflows/DebugWorkflowService.js";
import { F28P65X_PAIRED_FLASH_STARTUP, isPairedFlashPreset, ipcStartupPreset, resolveIpcStartupPreset } from "../src/workflows/startupProfiles.js";

const coreMap = [{ coreId: 0, coreName: "C28xx_CPU1" }, { coreId: 2, coreName: "C28xx_CPU2" }];

/**
 * Records the target-operation order. Flash preparation is recorded with the
 * owner and target core so a wrong routing cannot pass as a correct sequence.
 */
class PairedFlashAdapter extends MockDebugAdapter {
  events: string[] = [];
  resetRequests: Array<{ coreId: CoreId; resetType: ResetType }> = [];

  override async connect(session: AdapterSession, coreId: CoreId) {
    this.events.push(`connect:${coreId}`);
    await super.connect(session, coreId);
  }
  override async halt(session: AdapterSession, coreId: CoreId) {
    this.events.push(`halt:${coreId}`);
    await super.halt(session, coreId);
  }
  override async run(session: AdapterSession, coreId: CoreId) {
    this.events.push(`run:${coreId}`);
    await super.run(session, coreId);
  }
  override async reset(session: AdapterSession, coreId: CoreId, resetType: ResetType): Promise<ResetTargetState> {
    this.events.push(`reset:${coreId}:${resetType}`);
    this.resetRequests.push({ coreId, resetType });
    await super.reset(session, coreId, resetType);
    const state = await this.getState(session, coreId);
    return {
      ...state,
      reset: {
        requestedResetType: resetType,
        effectiveResetType: resetType,
        resetName: resetType === "system" ? "System Reset" : resetType === "cpu" ? "CPU Reset" : "Program Restart",
        mechanism: resetType === "restart" ? "target.restart" : resetType === "default" ? "target.reset" : "ResetType.issueReset",
        completion: "halt-observed"
      }
    };
  }
  override async loadProgram(session: AdapterSession, coreId: CoreId, uri: string) {
    this.events.push(`load:${coreId}`);
    await super.loadProgram(session, coreId, uri);
  }
  async prepareFlashLoad(
    _session: AdapterSession,
    ownerCoreId: CoreId,
    targetCoreId: CoreId,
    flashBanks: number[]
  ): Promise<{ flashLoadEvidence: Record<string, unknown> }> {
    this.events.push(`prepareFlashLoad:${ownerCoreId}->${targetCoreId}:[${flashBanks.join(",")}]`);
    return {
      flashLoadEvidence: {
        device: "F28P65x",
        ownerCoreId,
        targetCoreId,
        requestedFlashBanks: flashBanks,
        readOnly: true,
        atomic: false,
        snapshots: []
      }
    };
  }
}

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const FLASH_CPU1_MAP = [
  "MEMORY CONFIGURATION",
  "  FLASH_BANK0           00080000   00020000  00001000  0001f000  RWIX"
].join("\n");
const FLASH_CPU2_MAP = [
  "MEMORY CONFIGURATION",
  "  FLASH_BANK3           000e0002   0001fffe  00000872  0001f78c  RWIX"
].join("\n");
const RAM_CPU2_MAP = [
  "MEMORY CONFIGURATION",
  "  RAMLS0                00008000   00000800  00000010  000007f0  RWIX"
].join("\n");

async function fixture(options: { cpu2Map?: string; cpu1Map?: string } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "c2000-paired-flash-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const paths = {
    cpu1OutPath: path.join(dir, "cpu1.out"), cpu2OutPath: path.join(dir, "cpu2.out"),
    cpu1MapPath: path.join(dir, "cpu1.map"), cpu2MapPath: path.join(dir, "cpu2.map")
  };
  await writeFile(paths.cpu1OutPath, "cpu1-image");
  await writeFile(paths.cpu2OutPath, "cpu2-image");
  await writeFile(paths.cpu1MapPath, options.cpu1Map ?? FLASH_CPU1_MAP);
  await writeFile(paths.cpu2MapPath, options.cpu2Map ?? FLASH_CPU2_MAP);
  const adapter = new PairedFlashAdapter({ expressionValues: { "ipc.ready": { value: "1" } } });
  const manager = new DebugSessionManager(adapter, new LoadedProgramRegistry());
  const handlers = createToolHandlers(manager);
  const created = await handlers.createDebugSession({ sessionName: "paired-flash", coreMap });
  cleanups.push(() => manager.closeDebugSession(created.sessionId));
  await handlers.connectCores({ sessionId: created.sessionId, coreIds: [0, 2] });
  adapter.events = [];
  const input = {
    sessionId: created.sessionId, cpu1CoreId: 0, cpu2CoreId: 2, device: "F28P65x", ...paths,
    startupPreset: "f28p65x-paired-flash" as const,
    ipcReadyExpressions: [{ coreId: 0, expression: "ipc.ready", expected: 1 }],
    timeoutMs: 20, intervalMs: 1
  };
  return { adapter, handlers, manager, input };
}

describe("F28P65x paired Flash programming contract", () => {
  test("stops after both Flash writes when product power cycling is selected", async () => {
    const { adapter, handlers, input } = await fixture();
    const result = await handlers.runIpcAcceptance({ ...input, stopAfterFlashPreparation: true });

    expect(result).toMatchObject({
      success: true,
      status: "flash_prepared",
      ipcAcceptance: "NOT_RUN",
      coldStartVerified: false,
      flashProgramming: { performed: true }
    });
    expect(adapter.events).toContain("load:0");
    expect(adapter.events).toContain("load:2");
    expect(adapter.events.some(event => event.startsWith("run:"))).toBe(false);
  });

  test("programs both images with every application core halted, then starts them", async () => {
    const { adapter, handlers, input } = await fixture();
    const result = await handlers.runIpcAcceptance(input);

    expect(result.success).toBe(true);
    expect(adapter.events).toEqual([
      "halt:0", "halt:2",
      "reset:0:cpu", "reset:2:cpu",
      "load:0",
      "halt:0",
      "prepareFlashLoad:0->2:[3]",
      "load:2",
      "halt:0", "halt:2",
      "run:0", "run:2"
    ]);
    expect(result.flashProgramming).toMatchObject({
      stage: "paired-flash",
      performed: true,
      mode: "cpu1-then-cpu2",
      preset: "f28p65x-paired-flash",
      ownerCoreId: 0,
      targetCoreId: 2,
      flashBanks: [3],
      applicationCoresStartedDuringFlash: false
    });
    expect(result.flashProgramming.ownerStateAfterCpu1Load).toMatchObject({ coreId: 0, state: "Halted" });
    expect(result.performedSteps).toContain("beginPairedFlashProgramming");
    expect(result.performedSteps).toContain("confirmHaltedOwnerDuringPairedFlash");
    expect(result.performedSteps).toContain("completePairedFlashProgramming");
  });

  test("never starts an application core between the two Flash loads", async () => {
    const { adapter, handlers, input } = await fixture();
    await handlers.runIpcAcceptance(input);

    const cpu1Load = adapter.events.indexOf("load:0");
    const cpu2Load = adapter.events.indexOf("load:2");
    expect(cpu1Load).toBeGreaterThanOrEqual(0);
    expect(cpu2Load).toBeGreaterThan(cpu1Load);
    const flashProgrammingWindow = adapter.events.slice(cpu1Load, cpu2Load + 1);
    expect(flashProgrammingWindow.filter(event => event.startsWith("run:"))).toEqual([]);
    // The owner is re-confirmed halted between its own load and the target's.
    expect(flashProgrammingWindow).toEqual([
      "load:0", "halt:0", "prepareFlashLoad:0->2:[3]", "load:2"
    ]);
  });

  test("keeps the requested reset type for both cores and never substitutes a fallback", async () => {
    const { adapter, handlers, input } = await fixture();
    const result = await handlers.runIpcAcceptance(input);

    expect(adapter.resetRequests).toEqual([
      { coreId: 0, resetType: "cpu" },
      { coreId: 2, resetType: "cpu" }
    ]);
    expect(result.reset.results).toEqual([
      expect.objectContaining({ coreId: 0, success: true, state: "Halted" }),
      expect.objectContaining({ coreId: 2, success: true, state: "Halted" })
    ]);
    expect(result.startupContract.loadMode).toBe("cpu1-then-cpu2");
  });

  test("rejects the historical CPU1-pre-run load sequence for a CPU2 Flash image before any target access", async () => {
    const { adapter, handlers, input } = await fixture();
    const result = await handlers.runIpcAcceptance({
      ...input,
      startupPreset: undefined,
      loadSequence: { mode: "cpu1-run-before-cpu2", cpu1SettleMs: 0 }
    });

    expect(result).toMatchObject({
      success: false,
      error: expect.objectContaining({
        code: "StartupContractInvalid",
        details: expect.objectContaining({
          diagnosisCode: "PAIRED_FLASH_REQUIRES_HALTED_OWNER",
          loadMode: "cpu1-run-before-cpu2",
          cpu2FlashBanks: [3],
          requiredLoadMode: "cpu1-then-cpu2",
          targetMemoryWritten: false
        })
      })
    });
    expect(adapter.events).toEqual([]);
  });

  test("keeps the historical CPU1-pre-run sequence available for a CPU2 RAM image", async () => {
    const { adapter, handlers, input } = await fixture({ cpu2Map: RAM_CPU2_MAP });
    const result = await handlers.runIpcAcceptance({
      ...input,
      startupPreset: undefined,
      loadSequence: { mode: "cpu1-run-before-cpu2", cpu1SettleMs: 1 },
      runSequence: { runCpu1First: true, runCpu2: false, settleMs: 0 }
    });

    expect(result.success).toBe(true);
    const cpu1Load = adapter.events.indexOf("load:0");
    const cpu1Run = adapter.events.indexOf("run:0");
    const cpu2Load = adapter.events.indexOf("load:2");
    expect(cpu1Load).toBeGreaterThanOrEqual(0);
    expect(cpu1Run).toBeGreaterThan(cpu1Load);
    expect(cpu2Load).toBeGreaterThan(cpu1Run);
    expect(adapter.events.some(event => event.startsWith("prepareFlashLoad:"))).toBe(false);
    expect(result.flashProgramming).toMatchObject({
      performed: false,
      contractSource: "none",
      flashBanks: [],
      reason: "no CPU2 Flash image was found in the CPU2 linker map"
    });
  });

  test("reports no Flash boundary for a symbols-only acceptance", async () => {
    const { adapter, handlers, input } = await fixture();
    const result = await handlers.runIpcAcceptance({ ...input, programPreparation: "symbols-only" });

    expect(result.flashProgramming).toMatchObject({
      performed: false,
      reason: "symbols-only preparation does not program Flash",
      contractSource: "startup-preset",
      flashBanks: [3]
    });
    expect(adapter.events.some(event => event.startsWith("load:"))).toBe(false);
    expect(adapter.events.some(event => event.startsWith("prepareFlashLoad:"))).toBe(false);
  });

  test("resident debug shortcut loads symbols and never enters the Flash programming path", async () => {
    const { adapter, handlers, input } = await fixture();
    const result = await handlers.runResidentIpcDebug({
      ...input,
      runMode: "debugger_runs_both",
      timeoutMs: 20,
      intervalMs: 1
    });

    expect(result).toMatchObject({
      success: true,
      workflow: "c2000_runResidentIpcDebug",
      programPreparation: "symbols-only",
      targetFlashVerified: false,
      residentDebug: {
        programPreparation: "symbols-only",
        targetMemoryWritten: false,
        targetFlashVerified: false,
        flashProgramming: false
      }
    });
    expect(adapter.events.some(event => event.startsWith("load:"))).toBe(false);
    expect(adapter.events.some(event => event.startsWith("prepareFlashLoad:"))).toBe(false);
  });

  test("resident debug reuses the session image pair and inferred maps", async () => {
    const { adapter, handlers, input } = await fixture();
    await handlers.loadSymbols({
      sessionId: input.sessionId,
      coreId: input.cpu1CoreId,
      programUri: input.cpu1OutPath
    });
    await handlers.loadSymbols({
      sessionId: input.sessionId,
      coreId: input.cpu2CoreId,
      programUri: input.cpu2OutPath
    });
    adapter.events = [];

    const result = await handlers.runResidentIpcDebug({
      sessionId: input.sessionId,
      cpu1CoreId: input.cpu1CoreId,
      cpu2CoreId: input.cpu2CoreId,
      runMode: "debugger_runs_both",
      ipcReadyExpressions: input.ipcReadyExpressions,
      timeoutMs: 20,
      intervalMs: 1
    });

    expect(result).toMatchObject({
      success: true,
      workflow: "c2000_runResidentIpcDebug",
      artifactPreflight: {
        normalizedPaths: {
          cpu1OutPath: input.cpu1OutPath,
          cpu2OutPath: input.cpu2OutPath,
          cpu1MapPath: input.cpu1MapPath,
          cpu2MapPath: input.cpu2MapPath
        }
      }
    });
    expect(adapter.events.some(event => event.startsWith("prepareFlashLoad:"))).toBe(false);
  });

  test("no-session resident debug creates and connects both cores before loading symbols", async () => {
    const { adapter, handlers, input, manager } = await fixture();
    const result = await handlers.launchResidentIpcDebug({
      ...input,
      sessionId: undefined,
      startupPreset: undefined,
      runMode: "debugger_runs_both",
      timeoutMs: 20,
      intervalMs: 1
    } as any);

    expect(result).toMatchObject({
      success: true,
      workflow: "c2000_launchResidentIpcDebug",
      sessionMode: "interactive",
      residentDebug: {
        programPreparation: "symbols-only",
        targetMemoryWritten: false,
        targetFlashVerified: false,
        flashProgramming: false,
        residentIdentityPolicy: "operator-confirmed"
      },
      launch: {
        connectedCoreIds: [0, 2]
      }
    });
    expect(result.launch?.created?.sessionId).toEqual(expect.any(String));
    expect(adapter.events.filter(event => event.startsWith("connect:"))).toEqual(["connect:0", "connect:2"]);
    expect(adapter.events.some(event => event.startsWith("load:"))).toBe(false);
    expect(adapter.events.some(event => event.startsWith("prepareFlashLoad:"))).toBe(false);

    await manager.closeDebugSession(result.launch.created.sessionId);
  });

  test("the paired Flash preset pins programming but leaves post-program startup selectable", () => {
    expect(isPairedFlashPreset("f28p65x-paired-flash")).toBe(true);
    expect(isPairedFlashPreset("hybrid30k-dk9-owner-first")).toBe(false);
    expect(isPairedFlashPreset(undefined)).toBe(false);

    const resolved = resolveIpcStartupPreset({ startupPreset: "f28p65x-paired-flash", timeoutMs: 1000 });
    expect(resolved).toMatchObject({
      ...F28P65X_PAIRED_FLASH_STARTUP,
      startupPreset: "f28p65x-paired-flash",
      timeoutMs: 1000
    });
    expect(resolved.loadSequence).toEqual({ mode: "cpu1-then-cpu2", cpu1SettleMs: 250 });
    expect(ipcStartupPreset("f28p65x-paired-flash")).toEqual(F28P65X_PAIRED_FLASH_STARTUP);

    const firmwareOwned = resolveIpcStartupPreset({
      startupPreset: "f28p65x-paired-flash",
      resetType: "default",
      loadSequence: { mode: "cpu1-then-cpu2" },
      runSequence: { runMode: "cpu1_boots_cpu2" }
    });
    expect(firmwareOwned).toMatchObject({
      resetType: "cpu",
      loadSequence: { mode: "cpu1-then-cpu2", cpu1SettleMs: 250 },
      runSequence: { runMode: "cpu1_boots_cpu2" }
    });

    expect(() => resolveIpcStartupPreset({
      startupPreset: "f28p65x-paired-flash",
      resetType: "system"
    })).toThrowError(/conflicts with explicit resetType/);

    expect(() => resolveIpcStartupPreset({
      startupPreset: "f28p65x-paired-flash",
      loadSequence: { mode: "cpu1-run-before-cpu2", cpu1SettleMs: 250 }
    })).toThrowError(/conflicts with explicit loadSequence/);
    // The historical preset still resolves and still selects the CPU1-pre-run mode.
    expect(resolveIpcStartupPreset({ startupPreset: "hybrid30k-dk9-owner-first" }))
      .toMatchObject({ loadSequence: { mode: "cpu1-run-before-cpu2", cpu1SettleMs: 250 } });
    expect(isPairedFlashPreset("hybrid30k-dk9-owner-first")).toBe(false);
  });

  test("resolves the Flash boundary from the linker map when no preset is selected", () => {
    expect(resolvePairedFlashContract({
      startupPreset: null,
      loadMode: "cpu1-then-cpu2",
      ownerCoreId: 0,
      targetCoreId: 2,
      cpu2FlashBanks: [3, 3, 4]
    })).toEqual({
      required: true,
      preset: null,
      source: "cpu2-linker-map",
      ownerCoreId: 0,
      targetCoreId: 2,
      flashBanks: [3, 4]
    });
    expect(resolvePairedFlashContract({
      startupPreset: null,
      loadMode: "cpu1-then-cpu2",
      ownerCoreId: 0,
      targetCoreId: 2,
      cpu2FlashBanks: []
    })).toMatchObject({ required: false, source: "none", flashBanks: [] });
    expect(resolvePairedFlashContract({
      startupPreset: "f28p65x-paired-flash",
      loadMode: "cpu1-then-cpu2",
      ownerCoreId: 0,
      targetCoreId: 2,
      cpu2FlashBanks: []
    })).toMatchObject({ required: true, source: "startup-preset" });
    expect(() => resolvePairedFlashContract({
      startupPreset: null,
      loadMode: "cpu1-run-before-cpu2",
      ownerCoreId: 0,
      targetCoreId: 2,
      cpu2FlashBanks: [3]
    })).toThrowError(/cannot use loadSequence.mode cpu1-run-before-cpu2/);
  });

  test("the same logical session cannot be reused for a second paired Flash stage", async () => {
    const { adapter, manager, input } = await fixture();
    const service = new DebugWorkflowService(manager, undefined as never);
    expect(service).toBeDefined();

    await manager.beginPairedFlashProgramming(input.sessionId, {
      ownerCoreId: 0, targetCoreId: 2, flashBanks: [3]
    });
    await expect(manager.beginPairedFlashProgramming(input.sessionId, {
      ownerCoreId: 0, targetCoreId: 2, flashBanks: [3]
    })).rejects.toMatchObject({ code: "FlashProgrammingWindowActive" });
    await manager.endPairedFlashProgramming(input.sessionId, { success: true });
    expect(adapter.events).toEqual([]);
  });
});
