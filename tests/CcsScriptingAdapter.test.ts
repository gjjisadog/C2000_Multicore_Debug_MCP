import path from "node:path";
import { describe, expect, test } from "vitest";
import { CcsScriptingAdapter } from "../src/adapters/CcsScriptingAdapter.js";
import type { CcsBridgeCreateSessionOptions, CcsScriptingBridge, CcsScriptingCommand } from "../src/adapters/CcsScriptingBridge.js";
import { createApplicationEntryPlan, waitForApplicationEntry } from "../src/debug/applicationEntry.js";
import { DebugMcpError } from "../src/utils/errors.js";

const coreMap = [
  { coreId: 0, coreName: "C28xx_CPU1", corePattern: "C28xx_CPU1" },
  { coreId: 2, coreName: "C28xx_CPU2", corePattern: "C28xx_CPU2" }
];

const ccxmlPath = "/Applications/ti/C2000Ware_26_01_00_00_STS/device_support/f28p65x/common/targetConfigs/TMS320F28P650DK9.ccxml";

class RecordingBridge implements CcsScriptingBridge {
  readonly supportsFirmwareHandoff = true;
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
    const identity = {
      coreId: command.coreId,
      coreName: command.coreName,
      ...(command.targetCoreId === undefined ? {} : { targetCoreId: command.targetCoreId })
    };
    if (command.operation === "reset") {
      return {
        ...identity, requestedResetType: command.resetType, effectiveResetType: command.resetType,
        resetName: "CPU Reset", mechanism: "ResetType.issueReset", completion: "halt-observed"
      };
    }
    if (command.operation === "prepareFirmwareHandoff") {
      return { ...identity, gelInitializationDisabled: true };
    }
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
  test.each(["pc", "value"] as const)("normalizes decimal DSS %s before application-entry comparison", async field => {
    const bridge = new RecordingBridge();
    const adapter = new CcsScriptingAdapter({}, bridge);
    const session = await adapter.createSession({ sessionName: "decimal-pc", ccxmlPath, coreMap });
    for (const [raw, address] of [["524288", 0x80000], ["552561", 0x86e71],
      ["945691", 0xe6e1b], ["65624", 0x10058], [945691, 0xe6e1b]] as const) {
      bridge.execute = async command => ({ coreId: command.coreId, coreName: command.coreName, [field]: raw });
      const pc = await adapter.readPc(session, 0);
      expect(pc).toBe(`0x${address.toString(16).padStart(8, "0")}`);
      const entry = await waitForApplicationEntry({
        async getMulticoreSnapshot() {
          return { cores: [{ coreId: 0, coreName: "C28xx_CPU1", name: "C28xx_CPU1",
            connected: true, state: "Halted", pc }] };
        }
      }, {
        sessionId: "decimal-pc", plan: createApplicationEntryPlan({ coreId: 0, explicitAddress: address }),
        timeoutMs: 20, intervalMs: 1
      });
      expect(entry.reached).toBe(true);
      expect(entry.samples[0].pcValue).toBe(address);
    }
  });

  test.each([undefined, "", "not-a-pc", "0x", "-1", "1.5", "9007199254740992"])(
    "rejects unavailable or invalid PC %s instead of fabricating zero", async pc => {
      const bridge = new RecordingBridge();
      bridge.execute = async command => ({ coreId: command.coreId, coreName: command.coreName, pc });
      const adapter = new CcsScriptingAdapter({}, bridge);
      const session = await adapter.createSession({ sessionName: "invalid-pc", ccxmlPath, coreMap });
      await expect(adapter.readPc(session, 2)).rejects.toMatchObject({ code: "AddressResolveFailed" });
    }
  );

  test("returns optional load snapshots without adding commands or changing symbol-only loads", async () => {
    const bridge = new RecordingBridge();
    const evidence = { readOnly: true, atomic: false, snapshots: [{ phase: "load:after" }] };
    bridge.execute = async command => {
      bridge.commands.push(command);
      return { coreId: command.coreId, coreName: command.coreName, flashLoadEvidence: evidence };
    };
    const adapter = new CcsScriptingAdapter({}, bridge);
    const session = await adapter.createSession({ sessionName: "flash-state", ccxmlPath, coreMap });
    await expect(adapter.loadProgram(session, 2, "/tmp/cpu2.out")).resolves.toEqual({
      flashLoadEvidence: evidence });
    await expect(adapter.loadSymbols(session, 2, "/tmp/cpu2.out")).resolves.toBeUndefined();
    expect(bridge.commands.map(c => c.operation)).toEqual(["loadProgram", "loadSymbols"]);
  });

  test("returns matching reset evidence and rejects absent or mismatched evidence", async () => {
    const bridge = new RecordingBridge();
    const adapter = new CcsScriptingAdapter({}, bridge);
    const session = await adapter.createSession({ sessionName: "reset-proof", ccxmlPath, coreMap });
    await expect(adapter.reset(session, 2, "cpu")).resolves.toMatchObject({
      requestedResetType: "cpu", effectiveResetType: "cpu", completion: "halt-observed"
    });
    for (const evidence of [{}, {
      requestedResetType: "system", effectiveResetType: "cpu", resetName: "CPU Reset",
      mechanism: "target.reset", completion: "halt-observed"
    }]) {
      bridge.execute = async command => ({ coreId: command.coreId, coreName: command.coreName, ...evidence });
      await expect(adapter.reset(session, 0, "system")).rejects.toMatchObject({ code: "DssCommandFailed" });
    }
  });

  test.each([0, 2])("handoff on core %s requires persistent GEL suppression evidence", async coreId => {
    const bridge = new RecordingBridge();
    const adapter = new CcsScriptingAdapter({}, bridge);
    const session = await adapter.createSession({ sessionName: "handoff-proof", ccxmlPath, coreMap });
    await adapter.prepareFirmwareHandoff(session, coreId);
    expect(bridge.commands).toEqual([expect.objectContaining({ operation: "prepareFirmwareHandoff", coreId })]);
    bridge.execute = async command => ({ coreId: command.coreId, coreName: command.coreName });
    await expect(adapter.prepareFirmwareHandoff(session, coreId)).rejects.toMatchObject({ code: "DssCommandFailed" });
    const statelessAdapter = new CcsScriptingAdapter({}, { execute: bridge.execute });
    await expect(statelessAdapter.prepareFirmwareHandoff(session, coreId)).rejects.toMatchObject({ code: "AdapterNotAvailable" });
  });

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
    await adapter.prepareFlashLoad(session, 0, 2, [3, 4]);
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
      { operation: "prepareFlashLoad", coreId: 0, coreName: "C28xx_CPU1", corePattern: "C28xx_CPU1" },
      { operation: "writeMemory", coreId: 0, coreName: "C28xx_CPU1", corePattern: "C28xx_CPU1" },
      { operation: "assignExpression", coreId: 2, coreName: "C28xx_CPU2", corePattern: "C28xx_CPU2" }
    ]);
    // Flash preparation executes on the owner channel; the target core travels
    // as an explicit field so the prepared bank mapping is never inferred.
    expect(bridge.commands.find(command => command.operation === "prepareFlashLoad")).toEqual(
      expect.objectContaining({
        operation: "prepareFlashLoad",
        coreId: 0,
        coreName: "C28xx_CPU1",
        targetCoreId: 2,
        flashBanks: [3, 4]
      })
    );
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

  test("returns status without PC and keeps PC reading as an explicit operation", async () => {
    const bridge = new RecordingBridge();
    const adapter = new CcsScriptingAdapter({}, bridge);
    const session = await adapter.createSession({ sessionName: "diag", ccxmlPath, coreMap });

    await expect(adapter.getState(session, 0)).resolves.toEqual({
      coreId: 0,
      coreName: "C28xx_CPU1",
      connected: true,
      state: "Halted"
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
      state: "Disconnected"
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

  test("budgets Flash preparation with the Flash-operation timeout, never the state-read timeout", async () => {
    const bridge = new RecordingBridge();
    const adapter = new CcsScriptingAdapter({ timeouts: { stateReadMs: 5000, flashPrepareMs: 120000 } }, bridge);
    const session = await adapter.createSession({ sessionName: "flash-timeout-budget", ccxmlPath, coreMap });

    await adapter.prepareFlashLoad(session, 0, 2, [3]);
    await adapter.getState(session, 2);

    expect(bridge.commands.find(command => command.operation === "prepareFlashLoad")?.timeoutMs).toBe(120000);
    expect(bridge.commands.find(command => command.operation === "getState")?.timeoutMs).toBe(5000);
  });

  test("defaults Flash preparation to a dedicated budget and honours an explicit override", async () => {
    const defaultBridge = new RecordingBridge();
    const defaultAdapter = new CcsScriptingAdapter({}, defaultBridge);
    const defaultSession = await defaultAdapter.createSession({ sessionName: "flash-timeout-default", ccxmlPath, coreMap });
    await defaultAdapter.prepareFlashLoad(defaultSession, 0, 2, [3]);
    expect(defaultBridge.commands[0]?.timeoutMs).toBe(120000);
    expect(defaultBridge.commands[0]?.timeoutMs).not.toBe(5000);

    const overridingBridge = new RecordingBridge();
    const overridingAdapter = new CcsScriptingAdapter({ timeouts: { flashPrepareMs: 200000 } }, overridingBridge);
    const overridingSession = await overridingAdapter.createSession({ sessionName: "flash-timeout-override", ccxmlPath, coreMap });
    await overridingAdapter.prepareFlashLoad(overridingSession, 0, 2, [3]);
    expect(overridingBridge.commands[0]?.timeoutMs).toBe(200000);
  });

  test("rejects a Flash preparation that names the same core as owner and target", async () => {
    const bridge = new RecordingBridge();
    const adapter = new CcsScriptingAdapter({}, bridge);
    const session = await adapter.createSession({ sessionName: "flash-self-prepare", ccxmlPath, coreMap });

    await expect(adapter.prepareFlashLoad(session, 2, 2, [3])).rejects.toMatchObject({
      code: "FlashLoadPreparationUnsupported",
      details: expect.objectContaining({ ownerCoreId: 2, targetCoreId: 2 })
    });
    expect(bridge.commands).toEqual([]);
  });

  test("requires the Flash preparation response to confirm the requested target core", async () => {
    class UnconfirmedTargetBridge extends RecordingBridge {
      override async execute(command: CcsScriptingCommand): Promise<Record<string, unknown>> {
        this.commands.push(command);
        return { coreId: command.coreId, coreName: command.coreName, configured: true };
      }
    }
    const bridge = new UnconfirmedTargetBridge();
    const adapter = new CcsScriptingAdapter({}, bridge);
    const session = await adapter.createSession({ sessionName: "flash-target-confirmation", ccxmlPath, coreMap });

    await expect(adapter.prepareFlashLoad(session, 0, 2, [3])).rejects.toMatchObject({
      code: "CoreIdentityMismatch",
      details: expect.objectContaining({ ownerCoreId: 0, targetCoreId: 2 })
    });
  });

  test("returns Flash evidence from the owner-routed preparation", async () => {
    const bridge = new RecordingBridge();
    const evidence = { device: "F28P65x", readOnly: true, ownerCoreId: 0, targetCoreId: 2, snapshots: [] };
    bridge.execute = async command => {
      bridge.commands.push(command);
      return {
        coreId: command.coreId,
        coreName: command.coreName,
        targetCoreId: command.targetCoreId,
        flashLoadEvidence: evidence
      };
    };
    const adapter = new CcsScriptingAdapter({}, bridge);
    const session = await adapter.createSession({ sessionName: "flash-prepare-evidence", ccxmlPath, coreMap });

    await expect(adapter.prepareFlashLoad(session, 0, 2, [3])).resolves.toEqual({ flashLoadEvidence: evidence });
  });

  test("classifies a DSS deadline during Flash preparation as a stage-specific timeout", async () => {
    class TimingOutBridge extends RecordingBridge {
      override async execute(command: CcsScriptingCommand): Promise<Record<string, unknown>> {
        this.commands.push(command);
        if (command.operation === "prepareFlashLoad") {
          throw new DebugMcpError("PersistentChannelReconnectFailed", "DSS channel reconnect failed", {
            firstError: "DssCommandTimeout: Timed out waiting for DSS response",
            secondError: "DssCommandTimeout: Timed out waiting for DSS response"
          });
        }
        return super.execute(command);
      }
    }
    const bridge = new TimingOutBridge();
    const adapter = new CcsScriptingAdapter({ timeouts: { flashPrepareMs: 120000 } }, bridge);
    const session = await adapter.createSession({ sessionName: "flash-prepare-timeout", ccxmlPath, coreMap });

    await expect(adapter.prepareFlashLoad(session, 0, 2, [3, 4])).rejects.toMatchObject({
      code: "FlashPreparationTimeout",
      details: expect.objectContaining({
        stage: "prepare-flash",
        ownerCoreId: 0,
        targetCoreId: 2,
        flashBanks: [3, 4],
        timeoutMs: 120000,
        targetMemoryWritten: false
      })
    });
  });

  test("preserves a non-timeout Flash preparation failure so DSS Flash evidence survives", async () => {
    class BoundaryFailingBridge extends RecordingBridge {
      override async execute(command: CcsScriptingCommand): Promise<Record<string, unknown>> {
        this.commands.push(command);
        if (command.operation === "prepareFlashLoad") {
          throw new DebugMcpError("DssCommandFailed", "F28P65x Flash boundary validation failed", {
            response: {
              flashLoadEvidence: { device: "F28P65x", failureClass: "bank_mapping_boundary_mismatch" }
            }
          });
        }
        return super.execute(command);
      }
    }
    const bridge = new BoundaryFailingBridge();
    const adapter = new CcsScriptingAdapter({}, bridge);
    const session = await adapter.createSession({ sessionName: "flash-prepare-boundary", ccxmlPath, coreMap });

    await expect(adapter.prepareFlashLoad(session, 0, 2, [3])).rejects.toMatchObject({
      code: "DssCommandFailed",
      details: {
        response: { flashLoadEvidence: expect.objectContaining({ device: "F28P65x" }) }
      }
    });
  });
});
