import path from "node:path";
import { describe, expect, test } from "vitest";
import { CcsScriptingAdapter } from "../src/adapters/CcsScriptingAdapter.js";
import type { CcsBridgeCreateSessionOptions, CcsScriptingBridge, CcsScriptingCommand } from "../src/adapters/CcsScriptingBridge.js";

const coreMap = [
  { coreId: 0, coreName: "C28xx_CPU1", corePattern: "C28xx_CPU1" },
  { coreId: 2, coreName: "C28xx_CPU2", corePattern: "C28xx_CPU2" }
];

const ccxmlPath = "/Applications/ti/C2000Ware_26_01_00_00_STS/device_support/f28p65x/common/targetConfigs/TMS320F28P650DK9.ccxml";

class RecordingBridge implements CcsScriptingBridge {
  readonly sessions: CcsBridgeCreateSessionOptions[] = [];
  readonly commands: CcsScriptingCommand[] = [];
  readonly disposedSessions: string[] = [];

  async createSession(options: CcsBridgeCreateSessionOptions) {
    this.sessions.push(options);
  }

  async disposeSession(adapterSessionId: string) {
    this.disposedSessions.push(adapterSessionId);
  }

  async execute(command: CcsScriptingCommand): Promise<Record<string, unknown>> {
    this.commands.push(command);
    const identity = { coreId: command.coreId, coreName: command.coreName };
    if (command.operation === "getState") {
      return { ...identity, connected: true, state: "Halted", pc: "0x00C4E1" };
    }
    if (command.operation === "readPc") {
      return { ...identity, pc: "0x00C4E1" };
    }
    if (command.operation === "evaluateExpression") {
      return { ...identity, expression: command.expression, success: true, value: "3", type: "uint16_t", address: "0x0000A844" };
    }
    if (command.operation === "assignExpression") {
      return { ...identity, expression: command.expression, assignedValue: command.valueExpression, success: true };
    }
    if (command.operation === "resolveAddress") {
      return { ...identity, success: true, address: command.address, pc: command.address, partial: true };
    }
    return identity;
  }
}

describe("CcsScriptingAdapter", () => {
  test("registers a logical CCS session with the bridge before core commands are executed", async () => {
    const bridge = new RecordingBridge();
    const adapter = new CcsScriptingAdapter({}, bridge);
    const session = await adapter.createSession({ sessionName: "persistent", ccxmlPath, coreMap });

    await adapter.run(session, 0);

    expect(bridge.sessions).toEqual([
      expect.objectContaining({
        adapterSessionId: session.adapterSessionId,
        sessionName: "persistent",
        ccxmlPath,
        coreMap
      })
    ]);
    expect(bridge.commands[0]).toEqual(expect.objectContaining({
      adapterSessionId: session.adapterSessionId,
      operation: "run",
      coreId: 0,
      coreName: "C28xx_CPU1"
    }));
  });

  test("resolves a relative CCXML path before launching the DSS bridge", async () => {
    const bridge = new RecordingBridge();
    const adapter = new CcsScriptingAdapter({}, bridge);
    const relativeCcxmlPath = "examples/targetConfigs/board-a.ccxml";

    const session = await adapter.createSession({ sessionName: "relative-ccxml", ccxmlPath: relativeCcxmlPath, coreMap });

    expect(session.ccxmlPath).toBe(path.resolve(relativeCcxmlPath));
    expect(bridge.sessions[0]?.ccxmlPath).toBe(path.resolve(relativeCcxmlPath));
  });

  test("rebuilds the physical DSS session before CPU1 program loads", async () => {
    const bridge = new RecordingBridge();
    const adapter = new CcsScriptingAdapter({}, bridge);
    const session = await adapter.createSession({ sessionName: "cpu1-flash-refresh", ccxmlPath, coreMap });

    const refreshed = await adapter.refreshSessionForProgramLoad(session, 0);

    expect(refreshed.adapterSessionId).not.toBe(session.adapterSessionId);
    expect(bridge.disposedSessions).toEqual([session.adapterSessionId]);
    expect(bridge.sessions).toHaveLength(2);
    expect(bridge.sessions[1]).toEqual(expect.objectContaining({
      adapterSessionId: refreshed.adapterSessionId,
      sessionName: session.sessionName,
      ccxmlPath,
      coreMap
    }));
  });

  test("keeps the current DSS session for CPU2 program loads", async () => {
    const bridge = new RecordingBridge();
    const adapter = new CcsScriptingAdapter({}, bridge);
    const session = await adapter.createSession({ sessionName: "cpu2-flash-load", ccxmlPath, coreMap });

    await expect(adapter.refreshSessionForProgramLoad(session, 2)).resolves.toBe(session);
    expect(bridge.disposedSessions).toEqual([]);
    expect(bridge.sessions).toHaveLength(1);
  });

  test("sends per-core connect, run, halt, reset and load commands through the bridge", async () => {
    const bridge = new RecordingBridge();
    const adapter = new CcsScriptingAdapter({ ccsInstallPath: "/Applications/ti/ccs2100/ccs" }, bridge);
    const session = await adapter.createSession({
      sessionName: "real-f28p65x",
      ccxmlPath,
      coreMap
    });

    await adapter.connect(session, 0);
    await adapter.run(session, 2);
    await adapter.halt(session, 0);
    await adapter.reset(session, 2, "cpu");
    await adapter.loadProgram(session, 0, "/tmp/cpu1.out");
    await adapter.loadSymbols(session, 2, "/tmp/cpu2.out");
    await adapter.prepareFlashLoad(session, 2, [3, 4]);
    await adapter.writeMemory(session, 0, "DATA", 0x0005F444, 0x10, 32);
    await adapter.assignExpression(session, 2, "g_ulHybrid30kIpcPass", "0");

    expect(bridge.commands.map(command => ({
      operation: command.operation,
      coreId: command.coreId,
      coreName: command.coreName,
      corePattern: command.corePattern
    }))).toEqual([
      { operation: "connect", coreId: 0, coreName: "C28xx_CPU1", corePattern: "C28xx_CPU1" },
      { operation: "run", coreId: 2, coreName: "C28xx_CPU2", corePattern: "C28xx_CPU2" },
      { operation: "halt", coreId: 0, coreName: "C28xx_CPU1", corePattern: "C28xx_CPU1" },
      { operation: "reset", coreId: 2, coreName: "C28xx_CPU2", corePattern: "C28xx_CPU2" },
      { operation: "loadProgram", coreId: 0, coreName: "C28xx_CPU1", corePattern: "C28xx_CPU1" },
      { operation: "loadSymbols", coreId: 2, coreName: "C28xx_CPU2", corePattern: "C28xx_CPU2" },
      { operation: "prepareFlashLoad", coreId: 2, coreName: "C28xx_CPU2", corePattern: "C28xx_CPU2" },
      { operation: "writeMemory", coreId: 0, coreName: "C28xx_CPU1", corePattern: "C28xx_CPU1" },
      { operation: "assignExpression", coreId: 2, coreName: "C28xx_CPU2", corePattern: "C28xx_CPU2" }
    ]);
    expect(bridge.commands.find(command => command.operation === "prepareFlashLoad")?.flashBanks).toEqual([3, 4]);
    expect(bridge.commands.at(-2)).toEqual(expect.objectContaining({
      page: "DATA",
      address: 0x0005F444,
      value: 0x10,
      typeSize: 32
    }));
    expect(bridge.commands.at(-1)).toEqual(expect.objectContaining({
      expression: "g_ulHybrid30kIpcPass",
      valueExpression: "0"
    }));
  });

  test("returns state, PC, expression and address results for the requested core", async () => {
    const bridge = new RecordingBridge();
    const adapter = new CcsScriptingAdapter({}, bridge);
    const session = await adapter.createSession({ sessionName: "diag", ccxmlPath, coreMap });

    await expect(adapter.getState(session, 0)).resolves.toEqual({
      coreId: 0,
      coreName: "C28xx_CPU1",
      connected: true,
      state: "Halted",
      pc: "0x00C4E1"
    });
    await expect(adapter.readPc(session, 2)).resolves.toBe("0x00C4E1");
    await expect(adapter.evaluateExpression(session, 0, "g_emHybrid30kCpu1Stage")).resolves.toEqual(
      expect.objectContaining({ expression: "g_emHybrid30kCpu1Stage", success: true, value: "3" })
    );
    await expect(adapter.resolveAddress(session, 2, "0x00C4E1")).resolves.toEqual(
      expect.objectContaining({
        success: false,
        address: "0x00C4E1",
        partial: true,
        error: expect.objectContaining({ code: "AddressResolveFailed" })
      })
    );
  });

  test("propagates errors-only diagnostics for high-frequency bounded expression batches", async () => {
    const bridge = new RecordingBridge();
    const adapter = new CcsScriptingAdapter({}, bridge);
    const session = await adapter.createSession({ sessionName: "quiet-batch", ccxmlPath, coreMap });

    await adapter.evaluateExpressions(
      session,
      0,
      ["g_stCtrl.uiState"],
      1000,
      { diagnostics: "errors-only" }
    );

    expect(bridge.commands.at(-1)).toEqual(expect.objectContaining({
      operation: "evaluateExpressions",
      coreId: 0,
      coreName: "C28xx_CPU1",
      expressions: ["g_stCtrl.uiState"],
      diagnostics: "errors-only",
      timeoutMs: 1000
    }));
  });

  test("reads PC from persistent DSS expression value responses", async () => {
    class PersistentPcBridge extends RecordingBridge {
      override async execute(command: CcsScriptingCommand): Promise<Record<string, unknown>> {
        this.commands.push(command);
        if (command.operation === "readPc") {
          return { coreId: command.coreId, coreName: command.coreName, expression: "PC", success: true, value: "0x00C4E1" };
        }
        return super.execute(command);
      }
    }
    const bridge = new PersistentPcBridge();
    const adapter = new CcsScriptingAdapter({}, bridge);
    const session = await adapter.createSession({ sessionName: "persistent-pc", ccxmlPath, coreMap });

    await expect(adapter.readPc(session, 2)).resolves.toBe("0x00C4E1");
  });

  test("preserves Disconnected state reported by the CCS bridge", async () => {
    class DisconnectedStateBridge extends RecordingBridge {
      override async execute(command: CcsScriptingCommand): Promise<Record<string, unknown>> {
        this.commands.push(command);
        if (command.operation === "getState") {
          return { coreId: command.coreId, coreName: command.coreName, connected: false, state: "Disconnected", pc: "0x0" };
        }
        return super.execute(command);
      }
    }
    const bridge = new DisconnectedStateBridge();
    const adapter = new CcsScriptingAdapter({}, bridge);
    const session = await adapter.createSession({ sessionName: "disconnected-state", ccxmlPath, coreMap });

    await expect(adapter.getState(session, 0)).resolves.toEqual({
      coreId: 0,
      coreName: "C28xx_CPU1",
      connected: false,
      state: "Disconnected",
      pc: "0x0"
    });
  });

  test("rejects bridge responses that identify a different core than requested", async () => {
    class MismatchedCoreBridge extends RecordingBridge {
      override async execute(command: CcsScriptingCommand): Promise<Record<string, unknown>> {
        this.commands.push(command);
        return { coreId: 2, coreName: "C28xx_CPU2", success: true };
      }
    }
    const bridge = new MismatchedCoreBridge();
    const adapter = new CcsScriptingAdapter({}, bridge);
    const session = await adapter.createSession({ sessionName: "mismatch", ccxmlPath, coreMap });

    await expect(adapter.run(session, 0)).rejects.toMatchObject({
      code: "CoreIdentityMismatch"
    });
  });

  test("rejects bridge responses with a non-number coreId identity", async () => {
    class NonNumberCoreIdBridge extends RecordingBridge {
      override async execute(command: CcsScriptingCommand): Promise<Record<string, unknown>> {
        this.commands.push(command);
        return { coreId: "0", coreName: "C28xx_CPU1", success: true };
      }
    }
    const bridge = new NonNumberCoreIdBridge();
    const adapter = new CcsScriptingAdapter({}, bridge);
    const session = await adapter.createSession({ sessionName: "non-number-core-id", ccxmlPath, coreMap });

    await expect(adapter.run(session, 0)).rejects.toMatchObject({
      code: "CoreIdentityMismatch",
      details: expect.objectContaining({
        requestedCoreId: 0,
        responseCoreId: "0"
      })
    });
  });

  test("rejects bridge responses that omit requested core identity", async () => {
    class MissingCoreIdentityBridge extends RecordingBridge {
      override async execute(command: CcsScriptingCommand): Promise<Record<string, unknown>> {
        this.commands.push(command);
        return { success: true };
      }
    }
    const bridge = new MissingCoreIdentityBridge();
    const adapter = new CcsScriptingAdapter({}, bridge);
    const session = await adapter.createSession({ sessionName: "missing-core-identity", ccxmlPath, coreMap });

    await expect(adapter.run(session, 0)).rejects.toMatchObject({
      code: "CoreIdentityMissing",
      details: expect.objectContaining({
        requestedCoreId: 0,
        requestedCoreName: "C28xx_CPU1"
      })
    });
  });

  test("disposes the bridge session for a logical CCS adapter session", async () => {
    const bridge = new RecordingBridge();
    const adapter = new CcsScriptingAdapter({}, bridge);
    const session = await adapter.createSession({ sessionName: "dispose", ccxmlPath, coreMap });

    await adapter.disposeSession(session);

    expect(bridge.disposedSessions).toEqual([session.adapterSessionId]);
  });
});
