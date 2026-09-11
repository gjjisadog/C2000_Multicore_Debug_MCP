import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { MockDebugAdapter } from "../src/adapters/MockDebugAdapter.js";
import type { AdapterSession } from "../src/adapters/types.js";
import { DebugSessionManager } from "../src/debug/DebugSessionManager.js";
import { LoadedProgramRegistry } from "../src/debug/LoadedProgramRegistry.js";
import type { CoreId, ResetType } from "../src/debug/types.js";
import { createToolHandlers } from "../src/mcp/toolHandlers.js";
import { DebugMcpError } from "../src/utils/errors.js";

const coreMap = [{ coreId: 0, coreName: "C28xx_CPU1" }, { coreId: 2, coreName: "C28xx_CPU2" }];

class StartupAdapter extends MockDebugAdapter {
  events: string[] = [];
  fail?: "prepare" | "post-load-reset";
  stayInBootRom = false;
  private handedOff = false;
  private applicationStarted = false;

  override async prepareFirmwareHandoff(session: AdapterSession, coreId: CoreId) {
    this.events.push(`prepare:${coreId}`);
    if (this.fail === "prepare") throw new DebugMcpError("DssCommandFailed", "GEL unload failed");
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
  override async readPc(session: AdapterSession, coreId: CoreId) {
    if (coreId === 0) return this.applicationStarted ? "0x00080000" : "0x003FB445";
    return super.readPc(session, coreId);
  }
  override async loadProgram(session: AdapterSession, coreId: CoreId, uri: string) {
    this.events.push(`load:${coreId}`);
    await super.loadProgram(session, coreId, uri);
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
  return { adapter, handlers, input };
}

describe("post-load reset and firmware-owned handoff", () => {
  test.each([undefined, "cpu", "restart"] as const)("IPC loads use CPU1-only post-load reset (%s)", async type => {
    const { adapter, handlers, input } = await fixture();
    const result = await handlers.runIpcAcceptance({ ...input, postLoadResetType: type });
    expect(result.success).toBe(true);
    expect(adapter.events).toEqual([
      "load:0", "load:2",
      "prepare:2", "disconnect:2", `reset:0:${type ?? "restart"}`, "run:0", "connect:2"
    ]);
    expect(result.performedSteps).toContain("resetCpu1AfterLoad");
    expect(result.effectsApplied).toContain("debugger-gel-unload");
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
