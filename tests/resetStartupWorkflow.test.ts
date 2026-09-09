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
  private handedOff = false;

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
      ? "MEMORY CONFIGURATION\n  RAMLS0  00008000 00000800 00000010 000007f0 RWIX\n"
      : "host-only dummy image");
  }
  const adapter = new StartupAdapter({ expressionValues: { "ipc.ready": { value: "1" } } });
  const manager = new DebugSessionManager(adapter, new LoadedProgramRegistry());
  const handlers = createToolHandlers(manager);
  const created = await handlers.createDebugSession({ sessionName: "reset-contract", coreMap });
  cleanups.push(() => manager.closeDebugSession(created.sessionId));
  await handlers.connectCores({ sessionId: created.sessionId, coreIds: [0, 2] });
  adapter.events = [];
  const input = {
    sessionId: created.sessionId, cpu1CoreId: 0, cpu2CoreId: 2, device: "F28P65x", ...paths,
    resetType: "cpu" as const, ramOwnershipPolicy: "skip" as const,
    runSequence: { runMode: "cpu1_boots_cpu2" as const, runCpu1First: true, runCpu2: false, settleMs: 0 },
    ipcReadyExpressions: [{ coreId: 0, expression: "ipc.ready", expected: 1 }], timeoutMs: 20, intervalMs: 1
  };
  return { adapter, handlers, input };
}

describe("post-load reset and firmware-owned handoff", () => {
  test.each([undefined, "system", "restart"] as const)("IPC loads use CPU1-only post-load reset (%s)", async type => {
    const { adapter, handlers, input } = await fixture();
    const result = await handlers.runIpcAcceptance({ ...input, postLoadResetType: type });
    expect(result.success).toBe(true);
    expect(adapter.events).toEqual([
      "reset:0:cpu", "reset:2:cpu", "load:0", "load:2",
      "prepare:2", "disconnect:2", `reset:0:${type ?? "restart"}`, "run:0", "connect:2"
    ]);
    expect(result.performedSteps).toContain("resetCpu1AfterLoad");
    expect(result.effectsApplied).toContain("debugger-gel-unload");
  });

  test("symbols-only does not acquire an implicit extra reset", async () => {
    const { adapter, handlers, input } = await fixture();
    const result = await handlers.runIpcAcceptance({ ...input, programPreparation: "symbols-only" });
    expect(result.success).toBe(true);
    expect(adapter.events).toEqual([
      "reset:0:cpu", "reset:2:cpu", "prepare:2", "disconnect:2", "run:0", "connect:2"
    ]);
    expect(result.postLoadReset).toBeUndefined();
  });

  test("postLoadResetType is rejected for debugger-owned startup before target mutation", async () => {
    const { adapter, handlers, input } = await fixture();
    await expect(handlers.runIpcAcceptance({
      ...input, postLoadResetType: "system",
      runSequence: { runMode: "debugger_runs_both", runCpu1First: true, runCpu2: true, settleMs: 0 }
    })).resolves.toMatchObject({ success: false, error: { code: "StartupContractInvalid" } });
    expect(adapter.events).toEqual([]);
  });

  test.each(["ipc", "reload"])("%s handoff preparation failure stops before disconnect/run", async mode => {
    const { adapter, handlers, input } = await fixture();
    adapter.fail = "prepare";
    const result = mode === "ipc" ? handlers.runIpcAcceptance(input) : handlers.runReloadAndDiagnose({
      ...input, postLoadBoot: { resetType: "system", releaseCpu2BeforeCpu1: true, runCpu1: true, runCpu2: false, cpu1SettleMs: 0 }
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
      ...input, postLoadBoot: { resetType: "system", releaseCpu2BeforeCpu1: true, runCpu1: true, runCpu2: false, cpu1SettleMs: 0 }
    });
    await expect(result).resolves.toMatchObject({
      success: false, error: { details: { workflowStage: "post-load-cpu1-reset" } }
    });
    expect(adapter.events).toContain("disconnect:2");
    expect(adapter.events.some(event => /^(run|connect):/.test(event))).toBe(false);
    expect(adapter.events.filter(event => event.startsWith("reset:2:"))).toEqual(["reset:2:cpu"]);
  });
});
