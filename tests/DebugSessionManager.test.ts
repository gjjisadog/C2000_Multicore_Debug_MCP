import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { MockDebugAdapter } from "../src/adapters/MockDebugAdapter.js";
import type { AdapterSession, DebugAdapter } from "../src/adapters/types.js";
import { DebugSessionManager } from "../src/debug/DebugSessionManager.js";
import { LoadedProgramRegistry } from "../src/debug/LoadedProgramRegistry.js";
import type { CoreId } from "../src/debug/types.js";
import { SessionQueue } from "../src/utils/sessionQueue.js";
import { DebugMcpError } from "../src/utils/errors.js";
import { Logger } from "../src/utils/logger.js";

const coreMap = [
  { coreId: 0, coreName: "C28xx_CPU1", corePattern: "C28xx_CPU1" },
  { coreId: 2, coreName: "C28xx_CPU2", corePattern: "C28xx_CPU2" }
];

function createManager() {
  return new DebugSessionManager(new MockDebugAdapter(), new LoadedProgramRegistry());
}

describe("DebugSessionManager", () => {
  test("successful load snapshots survive the registry, result and log after session close", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "c2000-load-state-"));
    const program = path.join(tempDir, "cpu2.out");
    const logFile = path.join(tempDir, "load.jsonl");
    await writeFile(program, "mock-only");
    const evidence = { readOnly: true, atomic: false, snapshots: [{ phase: "load:after" }] };
    const adapter: DebugAdapter = new MockDebugAdapter();
    const original = adapter.loadProgram.bind(adapter);
    adapter.loadProgram = async (...args) => {
      await original(...args);
      return { flashLoadEvidence: evidence };
    };
    const registry = new LoadedProgramRegistry();
    const manager = new DebugSessionManager(adapter, registry, new Logger("info", logFile));
    const session = await manager.createDebugSession({ sessionName: "flash-state", coreMap });
    let result;
    try {
      await manager.connectCores(session.sessionId, [0, 2]);
      result = await manager.loadProgramWithMap(session.sessionId, 2, program, undefined, "skip");
      expect(registry.get(session.sessionId, 2)).toMatchObject({ flashLoadEvidence: evidence });
    } finally { await manager.closeDebugSession(session.sessionId); }
    expect(result).toMatchObject({ flashLoadEvidence: evidence });
    const lines = (await readFile(logFile, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(lines.find(line => line.message === "program loaded").data).toMatchObject({
      sessionId: session.sessionId, coreId: 2, flashLoadEvidence: evidence });
  });

  test("batch load persists the nested DSS evidence in its log after session close", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "c2000-loader-evidence-"));
    const program = path.join(tempDir, "cpu2.out");
    const logFile = path.join(tempDir, "loader.jsonl");
    await writeFile(program, "mock-image-not-hardware");
    const evidence = { command: "loadProgram", coreId: 2,
      response: { details: { causes: [{ message: "Flash bank protected" }] },
        flashLoadEvidence: { snapshots: [{ phase: "load:failure", registers: [{ value: 0xc0 }] }] } },
      diagnostics: { stdoutTail: "Flash loader stdout", stderrTail: "Flash loader stderr" } };
    class FailingLoadAdapter extends MockDebugAdapter {
      loads = 0;
      override async loadProgram(): Promise<void> {
        this.loads++;
        throw new DebugMcpError("DssCommandFailed", "Load failed", evidence);
      }
    }
    const adapter = new FailingLoadAdapter();
    const manager = new DebugSessionManager(adapter, new LoadedProgramRegistry(),
      new Logger("error", logFile));
    const session = await manager.createDebugSession({ sessionName: "loader-evidence", coreMap });
    let result;
    try {
      await manager.connectCores(session.sessionId, [0, 2]);
      result = await manager.loadPrograms(session.sessionId, [
        { coreId: 2, programUri: program, ramOwnershipPolicy: "skip" }
      ]);
    } finally { await manager.closeDebugSession(session.sessionId); }
    const expected = { code: "ProgramLoadFailed", details: {
      coreId: 2, cause: { code: "DssCommandFailed", details: evidence }
    } };
    expect(result.results[0]).toMatchObject({ success: false, error: expected });
    const lines = (await readFile(logFile, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(lines.find(line => line.message === "program load failed").data).toMatchObject(expected);
    expect(adapter.loads).toBe(1);
  });

  test("system reset invalidates cached peer PC without reading a disconnected CPU2", async () => {
    const manager = createManager();
    const created = await manager.createDebugSession({ sessionName: "reset-pc", coreMap });
    try {
      await manager.connectCores(created.sessionId, [0, 2]);
      const before = await manager.getMulticoreSnapshot(created.sessionId, [2]);
      expect(before.cores[0].pc).toBeDefined();
      await manager.disconnectTarget(created.sessionId, 2);
      await manager.resetCore(created.sessionId, 0, "system");
      const after = await manager.getMulticoreSnapshot(created.sessionId, [2]);
      expect(after.cores[0]).toMatchObject({ coreId: 2, connected: false });
      expect(after.cores[0].pc).toBeUndefined();
    } finally {
      await manager.closeDebugSession(created.sessionId);
    }
  });

  test("creates a logical debug session and lists CPU1/CPU2 without relying on UI focus", async () => {
    const manager = createManager();

    const session = await manager.createDebugSession({
      sessionName: "hybrid30k_f28p65x_ipc",
      ccxmlPath: "D:/workspace/targetConfigs/TMS320F28P650DK9.ccxml",
      coreMap
    });

    expect(session.sessionId).toMatch(/^dbg-/);
    expect(session.startupDiagnostics).toEqual(expect.objectContaining({
      schemaVersion: 1,
      targetAccessAttempted: true,
      stages: expect.arrayContaining([
        expect.objectContaining({ stage: "dss-startup", status: "completed" }),
        expect.objectContaining({ stage: "core-state-discovery", status: "completed", targetAccessAttempted: true })
      ])
    }));
    await expect(manager.listCores(session.sessionId)).resolves.toEqual([
      expect.objectContaining({ coreId: 0, coreName: "C28xx_CPU1", connected: false, active: false }),
      expect.objectContaining({ coreId: 2, coreName: "C28xx_CPU2", connected: false, active: false })
    ]);
  });

  test("rejects duplicate core ids to preserve a stable coreId to DebugSession mapping", async () => {
    const manager = createManager();

    await expect(manager.createDebugSession({
      sessionName: "duplicate-core-id",
      coreMap: [
        { coreId: 0, coreName: "C28xx_CPU1", corePattern: "C28xx_CPU1" },
        { coreId: 0, coreName: "C28xx_CPU1_ALIAS", corePattern: "C28xx_CPU1" }
      ]
    })).rejects.toMatchObject({
      code: "DuplicateCoreId",
      details: { coreId: 0 }
    });
  });

  test("rejects duplicate core targets to avoid mapping two core ids to one DebugSession", async () => {
    const manager = createManager();

    await expect(manager.createDebugSession({
      sessionName: "duplicate-core-target",
      coreMap: [
        { coreId: 0, coreName: "C28xx_CPU1", corePattern: "C28xx_CPU1" },
        { coreId: 2, coreName: "C28xx_CPU2_ALIAS", corePattern: "C28xx_CPU1" }
      ]
    })).rejects.toMatchObject({
      code: "DuplicateCoreTarget",
      details: { coreTarget: "C28xx_CPU1" }
    });
  });

  test("returns session topology without connecting targets", async () => {
    const manager = createManager();
    const session = await manager.createDebugSession({
      sessionName: "topology",
      ccxmlPath: "/tmp/f28p65x.ccxml",
      coreMap
    });

    const topology = await manager.getSessionTopology(session.sessionId);

    expect(topology).toEqual({
      sessionId: session.sessionId,
      sessionName: "topology",
      ccxmlPath: "/tmp/f28p65x.ccxml",
      adapterName: "mock",
      effectiveAdapterType: "mock",
      adapterSessionId: expect.stringMatching(/^mock-/),
      debugSessionRoute: "sessionId -> adapterSessionId -> coreId -> DebugSession",
      cores: [
        { coreId: 0, coreName: "C28xx_CPU1", corePattern: "C28xx_CPU1", targetSelector: "C28xx_CPU1", debugSessionKey: expect.stringMatching(/^mock-.*:0$/) },
        { coreId: 2, coreName: "C28xx_CPU2", corePattern: "C28xx_CPU2", targetSelector: "C28xx_CPU2", debugSessionKey: expect.stringMatching(/^mock-.*:2$/) }
      ]
    });
  });

  test("records runtime RAM ownership register source, expected mask, and actual value", async () => {
    class OwnershipReadAdapter extends MockDebugAdapter {
      constructor(private readonly value: number) { super(); }

      override async readMemory(
        _session: AdapterSession,
        _coreId: CoreId,
        _page: string,
        _address: number,
        _typeSize: number
      ): Promise<number> {
        return this.value;
      }
    }

    const action = {
      ownerCoreId: 0,
      targetCoreId: 2,
      targetCoreName: "C28xx_CPU2",
      memoryRegion: "RAMGS3",
      gsIndex: 3,
      page: "DATA",
      address: 0x0005F444,
      value: 24,
      typeSize: 32,
      reason: "test"
    };
    const matchingManager = new DebugSessionManager(new OwnershipReadAdapter(24), new LoadedProgramRegistry());
    const matchingSession = await matchingManager.createDebugSession({ sessionName: "ownership-match", coreMap });
    await matchingManager.connectTarget(matchingSession.sessionId, 0);
    await expect(matchingManager.verifyRuntimeRamOwnership(matchingSession.sessionId, [action])).resolves.toEqual(expect.objectContaining({
      requested: true,
      supported: true,
      skipped: false,
      matched: true,
      source: "MEMCFG_GSXMSEL",
      register: "MEMCFG_GSXMSEL",
      expectedMask: 24,
      actualValue: 24,
      ownerCoreId: 0,
      targetCoreId: 2,
      address: 0x0005F444
    }));

    const mismatchManager = new DebugSessionManager(new OwnershipReadAdapter(0), new LoadedProgramRegistry());
    const mismatchSession = await mismatchManager.createDebugSession({ sessionName: "ownership-mismatch", coreMap });
    await mismatchManager.connectTarget(mismatchSession.sessionId, 0);
    await expect(mismatchManager.verifyRuntimeRamOwnership(mismatchSession.sessionId, [action])).rejects.toMatchObject({
      code: "RamOwnershipVerifyFailed",
      details: expect.objectContaining({ source: "MEMCFG_GSXMSEL", expectedMask: 24, actualValue: 0, targetCoreId: 2 })
    });
  });

  test("connects, halts, runs and snapshots an explicitly selected core", async () => {
    const manager = createManager();
    const session = await manager.createDebugSession({ sessionName: "explicit-core", coreMap });

    await manager.connectTarget(session.sessionId, 0);
    await manager.haltCore(session.sessionId, 0);
    const halted = await manager.getTargetState(session.sessionId, 0);
    expect(halted).toEqual(expect.objectContaining({ coreId: 0, connected: true, state: "Halted" }));
    expect(halted).not.toHaveProperty("pc");

    await manager.runCore(session.sessionId, 0);
    const snapshot = await manager.getMulticoreSnapshot(session.sessionId);
    expect(snapshot.cores[0]).toEqual(expect.objectContaining({ pc: "0x00000000" }));
    expect(snapshot.cores).toEqual([
      expect.objectContaining({ coreId: 0, name: "C28xx_CPU1", coreName: "C28xx_CPU1", connected: true, state: "Running" }),
      expect.objectContaining({ coreId: 2, name: "C28xx_CPU2", coreName: "C28xx_CPU2", connected: false, state: "Disconnected" })
    ]);
  });

  test("does not read PC during status queries and reports a halted run as a failed batch item", async () => {
    class TrackingHaltedRunAdapter extends MockDebugAdapter {
      pcReadCount = 0;

      override async readPc(session: AdapterSession, coreId: CoreId): Promise<string> {
        this.pcReadCount += 1;
        return super.readPc(session, coreId);
      }

      override async getState(session: AdapterSession, coreId: CoreId) {
        return { ...(await super.getState(session, coreId)), pc: "0xDEADBEEF" };
      }

      override async run(session: AdapterSession, coreId: CoreId): Promise<void> {
        await super.run(session, coreId);
        await super.halt(session, coreId);
      }
    }

    const adapter = new TrackingHaltedRunAdapter();
    const manager = new DebugSessionManager(adapter, new LoadedProgramRegistry());
    const session = await manager.createDebugSession({ sessionName: "status-and-run-contract", coreMap });

    await manager.connectTarget(session.sessionId, 2);
    const status = await manager.getTargetState(session.sessionId, 2);
    expect(status).toEqual(expect.objectContaining({
      coreId: 2,
      connected: true,
      state: "Connected"
    }));
    expect(status).not.toHaveProperty("pc");
    expect(adapter.pcReadCount).toBe(0);

    const result = await manager.runCores(session.sessionId, [2]);
    expect(result.results).toEqual([
      expect.objectContaining({
        coreId: 2,
        coreName: "C28xx_CPU2",
        connected: true,
        state: "Halted",
        success: false,
        error: expect.objectContaining({
          code: "TargetStateMismatch",
          details: expect.objectContaining({ expectedState: "Running", actualState: "Halted" })
        })
      })
    ]);
    expect(adapter.pcReadCount).toBe(0);

    const snapshot = await manager.getMulticoreSnapshot(session.sessionId, [2]);
    expect(adapter.pcReadCount).toBe(1);
    expect(snapshot.cores[0]).toEqual(expect.objectContaining({ coreId: 2, state: "Halted", pc: "0x00000000" }));
  });

  test("loads programs per core and records trustworthy file metadata", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "c2000-mcp-"));
    const cpu1Out = path.join(tempDir, "cpu1.out");
    const cpu2Out = path.join(tempDir, "cpu2.out");
    await writeFile(cpu1Out, "cpu1-image");
    await writeFile(cpu2Out, "cpu2-image");
    const manager = createManager();
    const session = await manager.createDebugSession({ sessionName: "load-two", coreMap });
    await manager.connectCores(session.sessionId, [0, 2]);

    const result = await manager.loadPrograms(session.sessionId, [
      { coreId: 0, programUri: cpu1Out },
      { coreId: 2, programUri: cpu2Out, ramOwnershipPolicy: "skip" }
    ]);

    expect(result.results).toEqual([
      expect.objectContaining({ coreId: 0, success: true, programUri: cpu1Out }),
      expect.objectContaining({ coreId: 2, success: true, programUri: cpu2Out })
    ]);
    const info = await manager.getLoadedProgramInfo(session.sessionId, 0);
    expect(info).toBeDefined();
    expect(info).toEqual(expect.objectContaining({
      coreId: 0,
      programUri: cpu1Out,
      fileSize: 10,
      symbolsLoaded: true
    }));
    expect(info!.sha256).toHaveLength(64);
  });

  test("fails a batch load closed before the first program write when a target core is disconnected", async () => {
    class CountingLoadAdapter extends MockDebugAdapter {
      loadCount = 0;

      override async loadProgram(session: AdapterSession, coreId: CoreId, programUri: string): Promise<void> {
        this.loadCount += 1;
        await super.loadProgram(session, coreId, programUri);
      }
    }

    const tempDir = await mkdtemp(path.join(tmpdir(), "c2000-mcp-load-preflight-"));
    const cpu1Out = path.join(tempDir, "cpu1.out");
    const cpu2Out = path.join(tempDir, "cpu2.out");
    await writeFile(cpu1Out, "cpu1-image");
    await writeFile(cpu2Out, "cpu2-image");
    const adapter = new CountingLoadAdapter();
    const manager = new DebugSessionManager(adapter, new LoadedProgramRegistry());
    const session = await manager.createDebugSession({ sessionName: "load-connectivity-preflight", coreMap });
    await manager.connectTarget(session.sessionId, 0);

    await expect(manager.loadPrograms(session.sessionId, [
      { coreId: 0, programUri: cpu1Out },
      { coreId: 2, programUri: cpu2Out, ramOwnershipPolicy: "skip" }
    ])).rejects.toMatchObject({
      code: "CoreNotConnected",
      details: expect.objectContaining({
        targetMemoryWritten: false,
        nextAction: "c2000_connectCores",
        connectCoreIds: [0, 2],
        failedCores: [expect.objectContaining({ coreId: 2, connected: false })]
      })
    });
    expect(adapter.loadCount).toBe(0);
  });

  test("refreshes the adapter session and reconnects cores before an actual CPU1 program load", async () => {
    class RefreshingAdapter extends MockDebugAdapter {
      readonly refreshes: Array<{ previousAdapterSessionId: string; coreId: CoreId }> = [];
      readonly connections: Array<{ adapterSessionId: string; coreId: CoreId }> = [];

      async refreshSessionForProgramLoad(session: AdapterSession, coreId: CoreId): Promise<AdapterSession> {
        if (coreId !== 0) return session;
        this.refreshes.push({ previousAdapterSessionId: session.adapterSessionId, coreId });
        return this.createSession({ sessionName: session.sessionName, ccxmlPath: session.ccxmlPath, coreMap: session.coreMap });
      }

      override async connect(session: AdapterSession, coreId: CoreId): Promise<void> {
        this.connections.push({ adapterSessionId: session.adapterSessionId, coreId });
        await super.connect(session, coreId);
      }
    }

    const tempDir = await mkdtemp(path.join(tmpdir(), "c2000-mcp-session-refresh-"));
    const cpu1Out = path.join(tempDir, "cpu1.out");
    await writeFile(cpu1Out, "cpu1-image");
    const adapter = new RefreshingAdapter();
    const manager = new DebugSessionManager(adapter, new LoadedProgramRegistry());
    const session = await manager.createDebugSession({ sessionName: "refresh-before-cpu1", coreMap });
    await manager.connectCores(session.sessionId, [0, 2]);
    const originalAdapterSessionId = (await manager.getSessionTopology(session.sessionId)).adapterSessionId;

    await manager.loadProgram(session.sessionId, 0, cpu1Out);

    const refreshedAdapterSessionId = (await manager.getSessionTopology(session.sessionId)).adapterSessionId;
    expect(refreshedAdapterSessionId).not.toBe(originalAdapterSessionId);
    expect(adapter.refreshes).toEqual([{ previousAdapterSessionId: originalAdapterSessionId, coreId: 0 }]);
    expect(adapter.connections.slice(-2)).toEqual([
      { adapterSessionId: refreshedAdapterSessionId, coreId: 0 },
      { adapterSessionId: refreshedAdapterSessionId, coreId: 2 }
    ]);
    await expect(manager.getTargetState(session.sessionId, 0)).resolves.toEqual(expect.objectContaining({ connected: true }));
    await expect(manager.getTargetState(session.sessionId, 2)).resolves.toEqual(expect.objectContaining({ connected: true }));
  });

  test("does not refresh the adapter session when if-changed skips CPU1 programming", async () => {
    class RefreshingAdapter extends MockDebugAdapter {
      refreshCount = 0;

      async refreshSessionForProgramLoad(session: AdapterSession, coreId: CoreId): Promise<AdapterSession> {
        if (coreId !== 0) return session;
        this.refreshCount += 1;
        return this.createSession({ sessionName: session.sessionName, ccxmlPath: session.ccxmlPath, coreMap: session.coreMap });
      }
    }

    const tempDir = await mkdtemp(path.join(tmpdir(), "c2000-mcp-if-changed-refresh-"));
    const cpu1Out = path.join(tempDir, "cpu1.out");
    await writeFile(cpu1Out, "cpu1-image");
    const adapter = new RefreshingAdapter();
    const manager = new DebugSessionManager(adapter, new LoadedProgramRegistry());
    const session = await manager.createDebugSession({ sessionName: "skip-refresh-when-unchanged", coreMap });
    await manager.connectTarget(session.sessionId, 0);

    await manager.loadPrograms(session.sessionId, [{ coreId: 0, programUri: cpu1Out }]);
    await manager.disconnectTarget(session.sessionId, 0);
    const skipped = await manager.loadPrograms(session.sessionId, [{ coreId: 0, programUri: cpu1Out, loadPolicy: "if-changed" }]);

    expect(adapter.refreshCount).toBe(1);
    expect(skipped.results).toEqual([expect.objectContaining({ success: true, loaded: false, skipped: true })]);
  });

  test("registry verification is explicit and never claims to verify target Flash", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "c2000-mcp-registry-verify-"));
    const cpu1Out = path.join(tempDir, "cpu1.out");
    await writeFile(cpu1Out, "cpu1-image");
    const manager = createManager();
    const session = await manager.createDebugSession({ sessionName: "registry-verify", coreMap });
    await manager.connectTarget(session.sessionId, 0);

    const missing = await manager.loadPrograms(session.sessionId, [
      { coreId: 0, programUri: cpu1Out, loadPolicy: "verify-mcp-registry" }
    ]);
    expect(missing.results).toEqual([
      expect.objectContaining({
        coreId: 0,
        success: false,
        loaded: false,
        skipped: true,
        skipReason: "mcp-registry-verification-failed",
        verificationScope: "mcp-session-loaded-program-registry",
        targetFlashVerified: false,
        deprecatedPolicyAliasUsed: false
      })
    ]);

    await manager.loadPrograms(session.sessionId, [{ coreId: 0, programUri: cpu1Out }]);
    const verified = await manager.loadPrograms(session.sessionId, [
      { coreId: 0, programUri: cpu1Out, loadPolicy: "verify-only" }
    ]);
    expect(verified.results).toEqual([
      expect.objectContaining({
        coreId: 0,
        success: true,
        loaded: false,
        skipped: true,
        skipReason: "program-unchanged",
        verificationScope: "mcp-session-loaded-program-registry",
        targetFlashVerified: false,
        deprecatedPolicyAliasUsed: true
      })
    ]);
  });

  test("requires CPU1 to be connected before writing GS ownership for CPU2 load", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "c2000-mcp-owner-"));
    const cpu2Out = path.join(tempDir, "cpu2.out");
    await writeFile(cpu2Out, "cpu2-image");
    const manager = createManager();
    const session = await manager.createDebugSession({ sessionName: "cpu2-owner-required", coreMap });
    // Connect only CPU2 so ownership write on CPU1 must fail closed.
    await manager.connectTarget(session.sessionId, 2);

    await expect(manager.loadProgramWithMap(session.sessionId, 2, cpu2Out, undefined, "explicit-fallback", [4])).rejects.toMatchObject({
      code: "OwnerCoreNotConnected",
      details: expect.objectContaining({ ownerCoreId: 0, targetCoreId: 2 })
    });
  });

  test("assigns F28P65x GS4 RAM ownership to CPU2 through CPU1 before loading CPU2 RAM programs", async () => {
    type AdapterEvent =
      | { type: "writeMemory"; coreId: CoreId; page: string; address: number; value: number; typeSize: number }
      | { type: "loadProgram"; coreId: CoreId; programUri: string };
    class RecordingOwnershipAdapter extends MockDebugAdapter {
      readonly events: AdapterEvent[] = [];

      async writeMemory(
        session: AdapterSession,
        coreId: CoreId,
        page: string,
        address: number,
        value: number,
        typeSize: number
      ): Promise<void> {
        this.events.push({ type: "writeMemory", coreId, page, address, value, typeSize });
        await this.assignExpression(session, coreId, `memory:${page}:${address}`, value);
      }

      override async loadProgram(session: AdapterSession, coreId: CoreId, programUri: string): Promise<void> {
        this.events.push({ type: "loadProgram", coreId, programUri });
        await super.loadProgram(session, coreId, programUri);
      }
    }

    const tempDir = await mkdtemp(path.join(tmpdir(), "c2000-mcp-gs4-"));
    const cpu1Out = path.join(tempDir, "cpu1.out");
    const cpu2Out = path.join(tempDir, "cpu2.out");
    await writeFile(cpu1Out, "cpu1-image");
    await writeFile(cpu2Out, "cpu2-image");
    const adapter = new RecordingOwnershipAdapter();
    const manager = new DebugSessionManager(adapter, new LoadedProgramRegistry());
    const session = await manager.createDebugSession({ sessionName: "cpu2-gs4-ownership", coreMap });
    await manager.connectCores(session.sessionId, [0, 2]);

    await manager.loadProgram(session.sessionId, 0, cpu1Out);
    await manager.loadProgramWithMap(session.sessionId, 2, cpu2Out, undefined, "explicit-fallback", [4]);

    expect(adapter.events).toEqual([
      { type: "loadProgram", coreId: 0, programUri: cpu1Out },
      { type: "writeMemory", coreId: 0, page: "DATA", address: 0x0005F444, value: 0x10, typeSize: 32 },
      { type: "loadProgram", coreId: 2, programUri: cpu2Out }
    ]);
  });

  test("OR-combines multi-GS RAM ownership into a single MEMCFG write before CPU2 load", async () => {
    type AdapterEvent =
      | { type: "writeMemory"; coreId: CoreId; page: string; address: number; value: number; typeSize: number }
      | { type: "loadProgram"; coreId: CoreId; programUri: string };
    class RecordingOwnershipAdapter extends MockDebugAdapter {
      readonly events: AdapterEvent[] = [];

      async writeMemory(
        session: AdapterSession,
        coreId: CoreId,
        page: string,
        address: number,
        value: number,
        typeSize: number
      ): Promise<void> {
        this.events.push({ type: "writeMemory", coreId, page, address, value, typeSize });
        await super.writeMemory(session, coreId, page, address, value, typeSize);
      }

      override async loadProgram(session: AdapterSession, coreId: CoreId, programUri: string): Promise<void> {
        this.events.push({ type: "loadProgram", coreId, programUri });
        await super.loadProgram(session, coreId, programUri);
      }
    }

    const tempDir = await mkdtemp(path.join(tmpdir(), "c2000-mcp-multi-gs-"));
    const cpu2Out = path.join(tempDir, "cpu2.out");
    const cpu2Map = path.join(tempDir, "cpu2.map");
    await writeFile(cpu2Out, "cpu2-image");
    await writeFile(cpu2Map, `
MEMORY CONFIGURATION

         name            origin    length      used     unused   attr    fill
----------------------  --------  ---------  --------  --------  ----  --------
  RAMGS4                00018000   00002000  00000800  00001800  RWIX
  RAMGS5                0001a000   00002000  00000400  00001c00  RWIX
`);
    const adapter = new RecordingOwnershipAdapter();
    const manager = new DebugSessionManager(adapter, new LoadedProgramRegistry());
    const session = await manager.createDebugSession({ sessionName: "cpu2-multi-gs-ownership", coreMap });
    await manager.connectCores(session.sessionId, [0, 2]);

    await manager.loadProgramWithMap(session.sessionId, 2, cpu2Out, cpu2Map);

    expect(adapter.events).toEqual([
      { type: "writeMemory", coreId: 0, page: "DATA", address: 0x0005F444, value: 0x10 | 0x20, typeSize: 32 },
      { type: "loadProgram", coreId: 2, programUri: cpu2Out }
    ]);
  });

  test("prepares CPU2 Flash banks from its linker map before loading the image", async () => {
    type AdapterEvent =
      | { type: "prepareFlashLoad"; coreId: CoreId; flashBanks: number[] }
      | { type: "loadProgram"; coreId: CoreId; programUri: string };
    class RecordingFlashAdapter extends MockDebugAdapter {
      readonly events: AdapterEvent[] = [];

      async prepareFlashLoad(_session: AdapterSession, coreId: CoreId, flashBanks: number[]): Promise<void> {
        this.events.push({ type: "prepareFlashLoad", coreId, flashBanks });
      }

      override async loadProgram(session: AdapterSession, coreId: CoreId, programUri: string): Promise<void> {
        this.events.push({ type: "loadProgram", coreId, programUri });
        await super.loadProgram(session, coreId, programUri);
      }
    }

    const tempDir = await mkdtemp(path.join(tmpdir(), "c2000-mcp-cpu2-flash-"));
    const cpu2Out = path.join(tempDir, "cpu2.out");
    const cpu2Map = path.join(tempDir, "cpu2.map");
    await writeFile(cpu2Out, "cpu2-image");
    await writeFile(cpu2Map, `
MEMORY CONFIGURATION

         name            origin    length      used     unused   attr    fill
----------------------  --------  ---------  --------  --------  ----  --------
  FLASH_BANK3           000e0002   0001fffe  00000872  0001f78c  RWIX
  FLASH_BANK4           00100000   00020000  00000001  0001ffff  RWIX
`);
    const adapter = new RecordingFlashAdapter();
    const manager = new DebugSessionManager(adapter, new LoadedProgramRegistry());
    const session = await manager.createDebugSession({ sessionName: "cpu2-flash-prepare", coreMap });
    await manager.connectCores(session.sessionId, [0, 2]);

    await manager.loadProgramWithMap(session.sessionId, 2, cpu2Out, cpu2Map);

    expect(adapter.events).toEqual([
      { type: "prepareFlashLoad", coreId: 2, flashBanks: [3, 4] },
      { type: "loadProgram", coreId: 2, programUri: cpu2Out }
    ]);
  });

  test("blocks a repeated CPU2 Flash load before erase and allows an explicit destructive reload", async () => {
    class CountingFlashAdapter extends MockDebugAdapter {
      prepareCount = 0;
      loadCount = 0;

      async prepareFlashLoad(): Promise<void> {
        this.prepareCount += 1;
      }

      override async loadProgram(session: AdapterSession, coreId: CoreId, programUri: string): Promise<void> {
        this.loadCount += 1;
        await super.loadProgram(session, coreId, programUri);
      }
    }

    const tempDir = await mkdtemp(path.join(tmpdir(), "c2000-mcp-cpu2-flash-reload-guard-"));
    const cpu1Out = path.join(tempDir, "cpu1.out");
    const cpu2Out = path.join(tempDir, "cpu2.out");
    const cpu2Map = path.join(tempDir, "cpu2.map");
    await writeFile(cpu1Out, "cpu1-image");
    await writeFile(cpu2Out, "cpu2-image");
    await writeFile(cpu2Map, [
      "MEMORY CONFIGURATION",
      "  FLASH_BANK3           000e0002   0001fffe  00000872  0001f78c  RWIX"
    ].join("\n"));
    const adapter = new CountingFlashAdapter();
    const manager = new DebugSessionManager(adapter, new LoadedProgramRegistry());
    const session = await manager.createDebugSession({ sessionName: "cpu2-flash-reload-guard", coreMap });
    await manager.connectCores(session.sessionId, [0, 2]);

    await manager.loadProgramWithMap(session.sessionId, 2, cpu2Out, cpu2Map);
    await expect(manager.loadPrograms(session.sessionId, [
      { coreId: 0, programUri: cpu1Out },
      { coreId: 2, programUri: cpu2Out, mapUri: cpu2Map }
    ])).rejects.toMatchObject({ code: "DestructiveFlashReloadBlocked" });
    expect(adapter.loadCount).toBe(1);
    await expect(manager.loadProgramWithMap(session.sessionId, 2, cpu2Out, cpu2Map)).rejects.toMatchObject({
      code: "DestructiveFlashReloadBlocked",
      details: expect.objectContaining({
        targetMemoryWritten: false,
        blocked: expect.objectContaining({ flashBanks: [3], mapEvidence: "flash" })
      })
    });
    expect(adapter.prepareCount).toBe(1);
    expect(adapter.loadCount).toBe(1);

    await manager.loadProgramWithMap(session.sessionId, 2, cpu2Out, cpu2Map, "require-map", undefined, true);
    expect(adapter.prepareCount).toBe(2);
    expect(adapter.loadCount).toBe(2);
  });

  test("rebuilds the adapter session so CPU1 can load again after CPU2 Flash preparation poisons the prior session", async () => {
    class PoisoningFlashAdapter extends MockDebugAdapter {
      private readonly flashState = new Map<string, { poisoned: boolean }>();
      refreshCount = 0;

      override async createSession(options: Parameters<MockDebugAdapter["createSession"]>[0]): Promise<AdapterSession> {
        const session = await super.createSession(options);
        this.flashState.set(session.adapterSessionId, { poisoned: false });
        return session;
      }

      async refreshSessionForProgramLoad(session: AdapterSession, coreId: CoreId): Promise<AdapterSession> {
        if (coreId !== 0) return session;
        this.refreshCount += 1;
        return this.createSession({ sessionName: session.sessionName, ccxmlPath: session.ccxmlPath, coreMap: session.coreMap });
      }

      async prepareFlashLoad(session: AdapterSession): Promise<void> {
        this.flashState.get(session.adapterSessionId)!.poisoned = true;
      }

      override async loadProgram(session: AdapterSession, coreId: CoreId, programUri: string): Promise<void> {
        if (coreId === 0 && this.flashState.get(session.adapterSessionId)?.poisoned) {
          throw new Error("Load failed");
        }
        await super.loadProgram(session, coreId, programUri);
      }
    }

    const tempDir = await mkdtemp(path.join(tmpdir(), "c2000-mcp-poisoned-flash-session-"));
    const cpu1Out = path.join(tempDir, "cpu1.out");
    const cpu2Out = path.join(tempDir, "cpu2.out");
    const cpu2Map = path.join(tempDir, "cpu2.map");
    await writeFile(cpu1Out, "cpu1-image");
    await writeFile(cpu2Out, "cpu2-image");
    await writeFile(cpu2Map, [
      "MEMORY CONFIGURATION",
      "  FLASH_BANK3           000e0002   0001fffe  00000872  0001f78c  RWIX"
    ].join("\n"));
    const adapter = new PoisoningFlashAdapter();
    const manager = new DebugSessionManager(adapter, new LoadedProgramRegistry());
    const session = await manager.createDebugSession({ sessionName: "poisoned-flash-session", coreMap });
    await manager.connectCores(session.sessionId, [0, 2]);

    const first = await manager.loadPrograms(session.sessionId, [
      { coreId: 0, programUri: cpu1Out },
      { coreId: 2, programUri: cpu2Out, mapUri: cpu2Map }
    ]);
    const second = await manager.loadPrograms(session.sessionId, [{ coreId: 0, programUri: cpu1Out }]);

    expect(first.results).toEqual([
      expect.objectContaining({ coreId: 0, success: true }),
      expect.objectContaining({ coreId: 2, success: true })
    ]);
    expect(second.results).toEqual([expect.objectContaining({ coreId: 0, success: true })]);
    expect(adapter.refreshCount).toBe(2);
  });

  test("fails closed when a CPU2 Flash map requires unsupported preparation", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "c2000-mcp-cpu2-flash-unsupported-"));
    const cpu2Out = path.join(tempDir, "cpu2.out");
    const cpu2Map = path.join(tempDir, "cpu2.map");
    await writeFile(cpu2Out, "cpu2-image");
    await writeFile(cpu2Map, `
MEMORY CONFIGURATION

         name            origin    length      used     unused   attr    fill
----------------------  --------  ---------  --------  --------  ----  --------
  FLASH_BANK3           000e0002   0001fffe  00000872  0001f78c  RWIX
`);
    const manager = createManager();
    const session = await manager.createDebugSession({ sessionName: "cpu2-flash-unsupported", coreMap });
    await manager.connectCores(session.sessionId, [0, 2]);

    await expect(manager.loadProgramWithMap(session.sessionId, 2, cpu2Out, cpu2Map)).rejects.toMatchObject({
      code: "FlashLoadPreparationUnsupported",
      details: expect.objectContaining({ flashBanks: [3] })
    });
    await expect(manager.getLoadedProgramInfo(session.sessionId, 2)).resolves.toBeUndefined();
  });

  test("resolves relative program paths against configured workspacePath", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "c2000-mcp-workspace-"));
    const programRel = "cpu1/Debug/cpu1.out";
    const programAbs = path.join(tempDir, programRel);
    await mkdir(path.dirname(programAbs), { recursive: true });
    await writeFile(programAbs, "cpu1-image");
    const manager = new DebugSessionManager(
      new MockDebugAdapter(),
      new LoadedProgramRegistry(),
      undefined,
      { defaultWorkspacePath: tempDir }
    );
    const session = await manager.createDebugSession({ sessionName: "workspace-rel", coreMap });
    await manager.connectCores(session.sessionId, [0, 2]);

    const loaded = await manager.loadProgram(session.sessionId, 0, programRel);
    const topology = await manager.getSessionTopology(session.sessionId);

    expect(loaded.programUri).toBe(programAbs);
    expect(topology.workspacePath).toBe(tempDir);
  });

  test("GS ownership write RMW preserves existing MEMCFG bits and warns on map fallback", async () => {
    type AdapterEvent =
      | { type: "writeMemory"; coreId: CoreId; page: string; address: number; value: number; typeSize: number }
      | { type: "loadProgram"; coreId: CoreId; programUri: string };
    class RecordingOwnershipAdapter extends MockDebugAdapter {
      readonly events: AdapterEvent[] = [];

      async writeMemory(
        session: AdapterSession,
        coreId: CoreId,
        page: string,
        address: number,
        value: number,
        typeSize: number
      ): Promise<void> {
        this.events.push({ type: "writeMemory", coreId, page, address, value, typeSize });
        await super.writeMemory(session, coreId, page, address, value, typeSize);
      }

      override async loadProgram(session: AdapterSession, coreId: CoreId, programUri: string): Promise<void> {
        this.events.push({ type: "loadProgram", coreId, programUri });
        await super.loadProgram(session, coreId, programUri);
      }
    }

    const tempDir = await mkdtemp(path.join(tmpdir(), "c2000-mcp-gs-rmw-"));
    const cpu2Out = path.join(tempDir, "cpu2.out");
    await writeFile(cpu2Out, "cpu2-image");
    const adapter = new RecordingOwnershipAdapter();
    const manager = new DebugSessionManager(adapter, new LoadedProgramRegistry());
    const session = await manager.createDebugSession({ sessionName: "cpu2-gs-rmw-fallback", coreMap });
    await manager.connectCores(session.sessionId, [0, 2]);

    const topology = await manager.getSessionTopology(session.sessionId);
    await adapter.writeMemory(
      {
        adapterSessionId: topology.adapterSessionId,
        sessionName: topology.sessionName,
        ccxmlPath: topology.ccxmlPath,
        coreMap
      },
      0,
      "DATA",
      0x0005F444,
      0x08,
      32
    );
    adapter.events.length = 0;

    const loaded = await manager.loadProgramWithMap(session.sessionId, 2, cpu2Out, undefined, "explicit-fallback", [4]);

    expect(loaded.warning).toContain("caller-authorized fallback GS regions");
    expect(adapter.events).toEqual([
      { type: "writeMemory", coreId: 0, page: "DATA", address: 0x0005F444, value: 0x08 | 0x10, typeSize: 32 },
      { type: "loadProgram", coreId: 2, programUri: cpu2Out }
    ]);
  });

  test("fails assignExpression when verify readback does not match the assigned value", async () => {
    class LyingAssignAdapter extends MockDebugAdapter {
      override async assignExpression(
        session: AdapterSession,
        coreId: CoreId,
        expression: string,
        value: string | number | boolean
      ) {
        // Pretend the write succeeded without updating stored state.
        void session;
        void coreId;
        void expression;
        void value;
        return { success: true, value: String(value) };
      }
    }
    const manager = new DebugSessionManager(new LyingAssignAdapter({
      expressionValues: {
        g_ulHybrid30kIpcPass: { value: "1", type: "uint32_t", address: "0x00002000" }
      }
    }), new LoadedProgramRegistry());
    const session = await manager.createDebugSession({ sessionName: "assign-verify-fail", coreMap });
    await manager.connectCores(session.sessionId, [0, 2]);

    await expect(manager.assignExpression(session.sessionId, 0, "g_ulHybrid30kIpcPass", 0)).rejects.toMatchObject({
      code: "ExpressionVerifyFailed",
      details: expect.objectContaining({
        assignedValue: "0",
        readback: expect.objectContaining({ value: "1" })
      })
    });
  });

  test("includes trusted loaded program metadata in multicore snapshots", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "c2000-mcp-snapshot-metadata-"));
    const cpu1Out = path.join(tempDir, "cpu1.out");
    const cpu2Out = path.join(tempDir, "cpu2.out");
    await writeFile(cpu1Out, "cpu1-image");
    await writeFile(cpu2Out, "cpu2-image");
    const manager = createManager();
    const session = await manager.createDebugSession({ sessionName: "snapshot-loaded-program-info", coreMap });
    await manager.connectCores(session.sessionId, [0, 2]);
    await manager.loadPrograms(session.sessionId, [
      { coreId: 0, programUri: cpu1Out },
      { coreId: 2, programUri: cpu2Out, ramOwnershipPolicy: "skip" }
    ]);

    const snapshot = await manager.getMulticoreSnapshot(session.sessionId);

    expect(snapshot.cores).toEqual([
      expect.objectContaining({
        coreId: 0,
        loadedProgram: cpu1Out,
        loadedProgramInfo: expect.objectContaining({
          coreId: 0,
          programUri: cpu1Out,
          fileSize: 10,
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          symbolsLoaded: true
        })
      }),
      expect.objectContaining({
        coreId: 2,
        loadedProgram: cpu2Out,
        loadedProgramInfo: expect.objectContaining({
          coreId: 2,
          programUri: cpu2Out,
          fileSize: 10,
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          symbolsLoaded: true
        })
      })
    ]);
  });

  test("keeps batch operation results independent when one core fails", async () => {
    const manager = createManager();
    const session = await manager.createDebugSession({ sessionName: "partial-batch", coreMap });

    const result = await manager.connectCores(session.sessionId, [0, 9]);

    expect(result.results).toEqual([
      expect.objectContaining({ coreId: 0, success: true }),
      expect.objectContaining({ coreId: 9, success: false, error: expect.objectContaining({ code: "CoreNotFound" }) })
    ]);
  });

  test("closes a debug session and removes its logical session mapping", async () => {
    const manager = createManager();
    const session = await manager.createDebugSession({ sessionName: "close-me", coreMap });

    const result = await manager.closeDebugSession(session.sessionId);

    expect(result).toEqual(expect.objectContaining({
      sessionId: session.sessionId,
      closed: true,
      cleanup: expect.objectContaining({
        startedAt: expect.any(String),
        finishedAt: expect.any(String),
        durationMs: expect.any(Number),
        adapterDisposed: true
      })
    }));
    expect(result.cleanup.durationMs).toBeGreaterThanOrEqual(0);
    await expect(manager.listCores(session.sessionId)).rejects.toMatchObject({ code: "SessionNotFound" });
  });

  test("releases the serialized queue tail after closing a debug session", async () => {
    const manager = createManager();
    const session = await manager.createDebugSession({ sessionName: "close-queue-tail", coreMap });
    const queue = (manager as unknown as { queue: SessionQueue }).queue;

    await manager.closeDebugSession(session.sessionId);
    await new Promise(resolve => setImmediate(resolve));

    expect(queue.has(session.sessionId)).toBe(false);
  });

  test("falls back to the loaded linker map when CCS cannot resolve an address", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "c2000-mcp-map-resolve-"));
    const cpu1Out = path.join(tempDir, "cpu1.out");
    const cpu1Map = path.join(tempDir, "cpu1.map");
    await writeFile(cpu1Out, "cpu1-image");
    await writeFile(cpu1Map, [
      "MEMORY CONFIGURATION",
      "  RAMD1                 0000d000   00001000  00000800  00000800  RWIX",
      "SECTION ALLOCATION MAP",
      ".text      0    0000d000    00001000",
      "GLOBAL SYMBOLS: SORTED ALPHABETICALLY BY Name",
      "       0    0000dd4e  IPC_isFlagBusyRtoL"
    ].join("\n"));
    const manager = createManager();
    const session = await manager.createDebugSession({ sessionName: "map-resolve", coreMap });
    await manager.connectTarget(session.sessionId, 0);
    await manager.loadProgramWithMap(session.sessionId, 0, cpu1Out, cpu1Map);

    await expect(manager.resolveAddress(session.sessionId, 0, "0xDD58")).resolves.toEqual(expect.objectContaining({
      success: true,
      function: "IPC_isFlagBusyRtoL",
      offset: "0xA",
      memoryRegion: "RAMD1",
      resolutionSource: "linker-map",
      partial: true
    }));
  });

  test("clears loaded program metadata when a debug session is closed", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "c2000-mcp-"));
    const cpu1Out = path.join(tempDir, "cpu1.out");
    await writeFile(cpu1Out, "cpu1-image");
    const registry = new LoadedProgramRegistry();
    const manager = new DebugSessionManager(new MockDebugAdapter(), registry);
    const session = await manager.createDebugSession({ sessionName: "close-loaded-programs", coreMap });
    await manager.connectTarget(session.sessionId, 0);
    await manager.loadProgram(session.sessionId, 0, cpu1Out);

    await manager.closeDebugSession(session.sessionId);

    expect(registry.get(session.sessionId, 0)).toBeUndefined();
  });

  test("removes the logical session mapping even when adapter disposal fails", async () => {
    class FailingDisposeAdapter extends MockDebugAdapter {
      async disposeSession(): Promise<void> {
        throw new Error("dispose failed");
      }
    }
    const manager = new DebugSessionManager(new FailingDisposeAdapter(), new LoadedProgramRegistry());
    const session = await manager.createDebugSession({ sessionName: "dispose-fails", coreMap });

    await expect(manager.closeDebugSession(session.sessionId)).rejects.toThrow("dispose failed");
    await expect(manager.listCores(session.sessionId)).rejects.toMatchObject({ code: "SessionNotFound" });
  });

  test("auto-closes an armed debug session only after it remains idle", async () => {
    class RecordingDisposeAdapter extends MockDebugAdapter {
      readonly disposed: string[] = [];

      async disposeSession(session: AdapterSession): Promise<void> {
        this.disposed.push(session.adapterSessionId);
      }
    }
    const adapter = new RecordingDisposeAdapter();
    const manager = new DebugSessionManager(adapter, new LoadedProgramRegistry());
    const session = await manager.createDebugSession({ sessionName: "idle-auto-close", coreMap });

    const policy = manager.armIdleAutoClose(session.sessionId, 20);
    expect(policy).toEqual(expect.objectContaining({ armed: true, idleTimeoutMs: 20 }));
    await expect(manager.listCores(session.sessionId)).resolves.toHaveLength(2);
    await delay(50);

    expect(adapter.disposed).toHaveLength(1);
    await expect(manager.listCores(session.sessionId)).rejects.toMatchObject({ code: "SessionNotFound" });
  });

  test("does not auto-close while a session-scoped operation is in flight and restarts idle timing afterward", async () => {
    class RecordingDisposeAdapter extends MockDebugAdapter {
      readonly disposed: string[] = [];

      async disposeSession(session: AdapterSession): Promise<void> {
        this.disposed.push(session.adapterSessionId);
      }
    }
    const adapter = new RecordingDisposeAdapter();
    const manager = new DebugSessionManager(adapter, new LoadedProgramRegistry());
    const session = await manager.createDebugSession({ sessionName: "active-auto-close", coreMap });
    manager.armIdleAutoClose(session.sessionId, 20);
    let release!: () => void;
    const active = manager.withSessionActivity(session.sessionId, () => new Promise<void>(resolve => { release = resolve; }));

    await delay(50);
    expect(adapter.disposed).toHaveLength(0);
    await expect(manager.listCores(session.sessionId)).resolves.toHaveLength(2);

    release();
    await active;
    await delay(50);
    expect(adapter.disposed).toHaveLength(1);
    await expect(manager.listCores(session.sessionId)).rejects.toMatchObject({ code: "SessionNotFound" });
  });

  test("disposes every session during global cleanup and reports individual failures", async () => {
    class PartiallyFailingDisposeAdapter extends MockDebugAdapter {
      readonly disposed: string[] = [];

      async disposeSession(session: AdapterSession): Promise<void> {
        this.disposed.push(session.adapterSessionId);
        if (this.disposed.length === 1) {
          throw new Error("first disposal failed");
        }
      }
    }
    const adapter = new PartiallyFailingDisposeAdapter();
    const manager = new DebugSessionManager(adapter, new LoadedProgramRegistry());
    const first = await manager.createDebugSession({ sessionName: "cleanup-1", coreMap });
    const second = await manager.createDebugSession({ sessionName: "cleanup-2", coreMap });

    const result = await manager.disposeAllSessions();

    expect(adapter.disposed).toHaveLength(2);
    expect(result.closedSessionIds).toEqual([second.sessionId]);
    expect(result.failures).toEqual([
      expect.objectContaining({ sessionId: first.sessionId, error: expect.objectContaining({ message: "first disposal failed" }) })
    ]);
    await expect(manager.listCores(first.sessionId)).rejects.toMatchObject({ code: "SessionNotFound" });
    await expect(manager.listCores(second.sessionId)).rejects.toMatchObject({ code: "SessionNotFound" });
    await expect(manager.disposeAllSessions()).resolves.toEqual({ closedSessionIds: [], failures: [] });
  });

  test("verifies CPU1 and CPU2 run/pause isolation with snapshots after each command", async () => {
    const manager = createManager();
    const session = await manager.createDebugSession({ sessionName: "isolation", coreMap });
    await manager.connectCores(session.sessionId, [0, 2]);
    await manager.haltCores(session.sessionId, [0, 2]);

    const result = await manager.verifyRunPauseIsolation({ sessionId: session.sessionId, settleMs: 1 });

    expect(result.sessionId).toBe(session.sessionId);
    expect(result.steps.map(step => step.label)).toEqual([
      "c2000_continue(cpu1)",
      "c2000_pause(cpu1)",
      "c2000_continue(cpu2)",
      "c2000_pause(cpu2)"
    ]);
    expect(result.steps).toEqual([
      expect.objectContaining({
        assertion: expect.objectContaining({
          targetCoreId: 0,
          expectedTargetState: "Running",
          peerCoreIds: [2],
          checkedPeerFields: ["connected", "state", "pc", "loadedProgram", "loadedProgramInfo"],
          success: true
        })
      }),
      expect.objectContaining({
        assertion: expect.objectContaining({
          targetCoreId: 0,
          expectedTargetState: "Halted",
          peerCoreIds: [2],
          checkedPeerFields: ["connected", "state", "pc", "loadedProgram", "loadedProgramInfo"],
          success: true
        })
      }),
      expect.objectContaining({
        assertion: expect.objectContaining({
          targetCoreId: 2,
          expectedTargetState: "Running",
          peerCoreIds: [0],
          checkedPeerFields: ["connected", "state", "pc", "loadedProgram", "loadedProgramInfo"],
          success: true
        })
      }),
      expect.objectContaining({
        assertion: expect.objectContaining({
          targetCoreId: 2,
          expectedTargetState: "Halted",
          peerCoreIds: [0],
          checkedPeerFields: ["connected", "state", "pc", "loadedProgram", "loadedProgramInfo"],
          success: true
        })
      })
    ]);
    expect(result.acceptanceSummary).toEqual({
      success: true,
      evidence: "c2000_verifyRunPauseIsolation",
      requiredLabels: [
        "c2000_continue(cpu1)",
        "c2000_pause(cpu1)",
        "c2000_continue(cpu2)",
        "c2000_pause(cpu2)"
      ],
      acceptanceCriteria: [
        {
          requirement: "c2000_continue({ sessionId, coreId: 0 }) only runs CPU1",
          label: "c2000_continue(cpu1)",
          targetCoreId: 0,
          peerCoreIds: [2],
          expectedTargetState: "Running"
        },
        {
          requirement: "c2000_continue({ sessionId, coreId: 2 }) only runs CPU2",
          label: "c2000_continue(cpu2)",
          targetCoreId: 2,
          peerCoreIds: [0],
          expectedTargetState: "Running"
        },
        {
          requirement: "c2000_pause({ sessionId, coreId: 0 }) only pauses CPU1",
          label: "c2000_pause(cpu1)",
          targetCoreId: 0,
          peerCoreIds: [2],
          expectedTargetState: "Halted"
        },
        {
          requirement: "c2000_pause({ sessionId, coreId: 2 }) only pauses CPU2",
          label: "c2000_pause(cpu2)",
          targetCoreId: 2,
          peerCoreIds: [0],
          expectedTargetState: "Halted"
        }
      ],
      steps: [
        expect.objectContaining({
          label: "c2000_continue(cpu1)",
          success: true,
          targetCoreId: 0,
          expectedTargetState: "Running",
          peerCoreIds: [2],
          checkedPeerFields: ["connected", "state", "pc", "loadedProgram", "loadedProgramInfo"]
        }),
        expect.objectContaining({
          label: "c2000_pause(cpu1)",
          success: true,
          targetCoreId: 0,
          expectedTargetState: "Halted",
          peerCoreIds: [2],
          checkedPeerFields: ["connected", "state", "pc", "loadedProgram", "loadedProgramInfo"]
        }),
        expect.objectContaining({
          label: "c2000_continue(cpu2)",
          success: true,
          targetCoreId: 2,
          expectedTargetState: "Running",
          peerCoreIds: [0],
          checkedPeerFields: ["connected", "state", "pc", "loadedProgram", "loadedProgramInfo"]
        }),
        expect.objectContaining({
          label: "c2000_pause(cpu2)",
          success: true,
          targetCoreId: 2,
          expectedTargetState: "Halted",
          peerCoreIds: [0],
          checkedPeerFields: ["connected", "state", "pc", "loadedProgram", "loadedProgramInfo"]
        })
      ]
    });
    expect(result.finalSnapshot.cores).toEqual([
      expect.objectContaining({ coreId: 0, state: "Halted" }),
      expect.objectContaining({ coreId: 2, state: "Halted" })
    ]);
  });

  test("returns a failed acceptance summary with snapshots when a peer core changes during isolation", async () => {
    class CoupledRunAdapter extends MockDebugAdapter {
      override async run(session: AdapterSession, coreId: CoreId): Promise<void> {
        await super.run(session, coreId);
        if (coreId === 0) {
          await super.run(session, 2);
        }
      }
    }
    const manager = new DebugSessionManager(new CoupledRunAdapter(), new LoadedProgramRegistry());
    const session = await manager.createDebugSession({ sessionName: "coupled-isolation", coreMap });
    await manager.connectCores(session.sessionId, [0, 2]);
    await manager.haltCores(session.sessionId, [0, 2]);

    const result = await manager.verifyRunPauseIsolation({ sessionId: session.sessionId, settleMs: 1 });

    expect(result.acceptanceSummary.success).toBe(false);
    expect(result.steps[0]).toEqual(expect.objectContaining({
      label: "c2000_continue(cpu1)",
      beforeSnapshot: expect.objectContaining({
        cores: expect.arrayContaining([
          expect.objectContaining({ coreId: 0, state: "Halted" }),
          expect.objectContaining({ coreId: 2, state: "Halted" })
        ])
      }),
      afterSnapshot: expect.objectContaining({
        cores: expect.arrayContaining([
          expect.objectContaining({ coreId: 0, state: "Running" }),
          expect.objectContaining({ coreId: 2, state: "Running" })
        ])
      }),
      assertion: expect.objectContaining({
        success: false,
        targetCoreId: 0,
        expectedTargetState: "Running",
        peerCoreIds: [2],
        checkedPeerFields: ["connected", "state", "pc", "loadedProgram", "loadedProgramInfo"],
        failures: expect.arrayContaining([expect.stringContaining("peer core 2 changed fields: state")])
      })
    }));
    expect(result.acceptanceSummary.steps[0]).toEqual(expect.objectContaining({
      label: "c2000_continue(cpu1)",
      success: false,
      failures: expect.arrayContaining([expect.stringContaining("peer core 2 changed fields: state")])
    }));
  });

  test("returns a failed acceptance summary with snapshots when a per-core command fails", async () => {
    class FailingRunAdapter extends MockDebugAdapter {
      override async run(session: AdapterSession, coreId: CoreId): Promise<void> {
        if (coreId === 0) {
          throw new Error("run failed on CPU1");
        }
        await super.run(session, coreId);
      }
    }
    const manager = new DebugSessionManager(new FailingRunAdapter(), new LoadedProgramRegistry());
    const session = await manager.createDebugSession({ sessionName: "command-failure-isolation", coreMap });
    await manager.connectCores(session.sessionId, [0, 2]);
    await manager.haltCores(session.sessionId, [0, 2]);

    const result = await manager.verifyRunPauseIsolation({ sessionId: session.sessionId, settleMs: 1 });

    expect(result.acceptanceSummary.success).toBe(false);
    expect(result.steps[0]).toEqual(expect.objectContaining({
      label: "c2000_continue(cpu1)",
      commandResult: expect.objectContaining({
        success: false,
        error: expect.objectContaining({
          code: "UnknownError",
          message: "run failed on CPU1"
        })
      }),
      beforeSnapshot: expect.objectContaining({
        cores: expect.arrayContaining([
          expect.objectContaining({ coreId: 0, state: "Halted" }),
          expect.objectContaining({ coreId: 2, state: "Halted" })
        ])
      }),
      afterSnapshot: expect.objectContaining({
        cores: expect.arrayContaining([
          expect.objectContaining({ coreId: 0, state: "Halted" }),
          expect.objectContaining({ coreId: 2, state: "Halted" })
        ])
      }),
      assertion: expect.objectContaining({
        success: false,
        targetCoreId: 0,
        expectedTargetState: "Running",
        peerCoreIds: [2],
        checkedPeerFields: ["connected", "state", "pc", "loadedProgram", "loadedProgramInfo"],
        failures: expect.arrayContaining([
          "command failed: run failed on CPU1",
          expect.stringContaining("target core 0 state mismatch")
        ])
      })
    }));
    expect(result.acceptanceSummary.steps[0]).toEqual(expect.objectContaining({
      label: "c2000_continue(cpu1)",
      success: false,
      commandError: {
        code: "UnknownError",
        message: "run failed on CPU1"
      }
    }));
  });

  test("assigns an expression on one explicit core without changing the peer core", async () => {
    const manager = new DebugSessionManager(new MockDebugAdapter({
      expressionValues: {
        g_ulHybrid30kIpcPass: { value: "1", type: "uint32_t", address: "0x00002000" }
      }
    }), new LoadedProgramRegistry());
    const session = await manager.createDebugSession({ sessionName: "fault-injection", coreMap });
    await manager.connectCores(session.sessionId, [0, 2]);

    const result = await manager.assignExpression(session.sessionId, 0, "g_ulHybrid30kIpcPass", 0);

    expect(result).toEqual(expect.objectContaining({
      sessionId: session.sessionId,
      coreId: 0,
      expression: "g_ulHybrid30kIpcPass",
      assignedValue: "0",
      readback: expect.objectContaining({ success: true, value: "0" })
    }));
    await expect(manager.evaluateMany(session.sessionId, 2, ["g_ulHybrid30kIpcPass"])).resolves.toEqual([
      expect.objectContaining({ expression: "g_ulHybrid30kIpcPass", success: true, value: "1" })
    ]);
  });

  test("reads fixed-width raw address expressions through the adapter memory path", async () => {
    const manager = createManager();
    const session = await manager.createDebugSession({ sessionName: "raw-address-read", coreMap });
    await manager.connectTarget(session.sessionId, 0);
    await manager.writeMemory(session.sessionId, 0, "DATA", 0x022240, 0x12345678, 32);
    await manager.writeMemory(session.sessionId, 0, "DATA", 0x022242, 0xabcd, 16);

    await expect(manager.evaluateMany(session.sessionId, 0, [
      "*(uint32_t *)0x022240",
      "*(uint16_t *)0x022242"
    ])).resolves.toEqual([
      {
        expression: "*(uint32_t *)0x022240",
        success: true,
        value: String(0x12345678),
        type: "uint32_t",
        address: "0x022240"
      },
      {
        expression: "*(uint16_t *)0x022242",
        success: true,
        value: String(0xabcd),
        type: "uint16_t",
        address: "0x022242"
      }
    ]);
  });

  test("assigns multiple expressions across explicit cores with independent per-item results", async () => {
    const manager = new DebugSessionManager(new MockDebugAdapter({
      expressionValues: {
        g_ulHybrid30kCpu1Fault: { value: "0", type: "uint32_t", address: "0x00002030" },
        g_ulHybrid30kCpu2Fault: { value: "0", type: "uint32_t", address: "0x00012030" }
      }
    }), new LoadedProgramRegistry());
    const session = await manager.createDebugSession({ sessionName: "batch-fault-injection", coreMap });
    await manager.connectCores(session.sessionId, [0, 2]);

    const result = await manager.assignExpressions(session.sessionId, [
      { coreId: 0, expression: "g_ulHybrid30kCpu1Fault", value: 1 },
      { coreId: 2, expression: "g_ulHybrid30kCpu2Fault", value: true },
      { coreId: 9, expression: "g_ulHybrid30kMissingCoreFault", value: 1 }
    ]);

    expect(result).toEqual({
      sessionId: session.sessionId,
      results: [
        expect.objectContaining({ coreId: 0, success: true, expression: "g_ulHybrid30kCpu1Fault", assignedValue: "1" }),
        expect.objectContaining({ coreId: 2, success: true, expression: "g_ulHybrid30kCpu2Fault", assignedValue: "1" }),
        expect.objectContaining({ coreId: 9, success: false, expression: "g_ulHybrid30kMissingCoreFault", error: expect.objectContaining({ code: "CoreNotFound" }) })
      ]
    });
    await expect(manager.evaluateMany(session.sessionId, 0, ["g_ulHybrid30kCpu1Fault", "g_ulHybrid30kCpu2Fault"])).resolves.toEqual([
      expect.objectContaining({ expression: "g_ulHybrid30kCpu1Fault", success: true, value: "1" }),
      expect.objectContaining({ expression: "g_ulHybrid30kCpu2Fault", success: true, value: "0" })
    ]);
    await expect(manager.evaluateMany(session.sessionId, 2, ["g_ulHybrid30kCpu1Fault", "g_ulHybrid30kCpu2Fault"])).resolves.toEqual([
      expect.objectContaining({ expression: "g_ulHybrid30kCpu1Fault", success: true, value: "0" }),
      expect.objectContaining({ expression: "g_ulHybrid30kCpu2Fault", success: true, value: "1" })
    ]);
  });

  test("injects labeled faults across explicit cores without changing peer core values", async () => {
    const manager = new DebugSessionManager(new MockDebugAdapter({
      expressionValues: {
        g_ulHybrid30kCpu1Fault: { value: "0", type: "uint32_t", address: "0x00002030" },
        g_ulHybrid30kCpu2Fault: { value: "0", type: "uint32_t", address: "0x00012030" }
      }
    }), new LoadedProgramRegistry());
    const session = await manager.createDebugSession({ sessionName: "inject-faults", coreMap });
    await manager.connectCores(session.sessionId, [0, 2]);

    const result = await manager.injectFaults(session.sessionId, [
      { label: "cpu1-trip", coreId: 0, expression: "g_ulHybrid30kCpu1Fault", value: 1 },
      { label: "cpu2-trip", coreId: 2, expression: "g_ulHybrid30kCpu2Fault", value: true }
    ]);

    expect(result).toEqual({
      sessionId: session.sessionId,
      summary: { total: 2, succeeded: 2, failed: 0 },
      results: [
        expect.objectContaining({ label: "cpu1-trip", coreId: 0, success: true, expression: "g_ulHybrid30kCpu1Fault", assignedValue: "1" }),
        expect.objectContaining({ label: "cpu2-trip", coreId: 2, success: true, expression: "g_ulHybrid30kCpu2Fault", assignedValue: "1" })
      ]
    });
    await expect(manager.evaluateMany(session.sessionId, 0, ["g_ulHybrid30kCpu1Fault", "g_ulHybrid30kCpu2Fault"])).resolves.toEqual([
      expect.objectContaining({ expression: "g_ulHybrid30kCpu1Fault", success: true, value: "1" }),
      expect.objectContaining({ expression: "g_ulHybrid30kCpu2Fault", success: true, value: "0" })
    ]);
    await expect(manager.evaluateMany(session.sessionId, 2, ["g_ulHybrid30kCpu1Fault", "g_ulHybrid30kCpu2Fault"])).resolves.toEqual([
      expect.objectContaining({ expression: "g_ulHybrid30kCpu1Fault", success: true, value: "0" }),
      expect.objectContaining({ expression: "g_ulHybrid30kCpu2Fault", success: true, value: "1" })
    ]);
  });

  test("compares expressions across explicit CPU1 and CPU2 cores for parameter synchronization", async () => {
    const manager = new DebugSessionManager(new MockDebugAdapter({
      expressionValues: {
        g_ulHybrid30kIpcPass: { value: "1", type: "uint32_t", address: "0x00002000" },
        g_ulHybrid30kCpu1ParamCrc: { value: "0x55AA", type: "uint32_t", address: "0x00002010" },
        g_ulHybrid30kCpu2ParamCrc: { value: "0x55AA", type: "uint32_t", address: "0x00012010" },
        g_ulHybrid30kCpu2FaultCount: { value: "2", type: "uint32_t", address: "0x00012020" }
      }
    }), new LoadedProgramRegistry());
    const session = await manager.createDebugSession({ sessionName: "param-sync", coreMap });
    await manager.connectCores(session.sessionId, [0, 2]);

    const result = await manager.compareExpressions(session.sessionId, [
      {
        label: "param-crc",
        left: { coreId: 0, expression: "g_ulHybrid30kCpu1ParamCrc" },
        right: { coreId: 2, expression: "g_ulHybrid30kCpu2ParamCrc" }
      },
      {
        label: "fault-count",
        left: { coreId: 0, expression: "g_ulHybrid30kIpcPass" },
        right: { coreId: 2, expression: "g_ulHybrid30kCpu2FaultCount" }
      }
    ]);

    expect(result).toEqual({
      sessionId: session.sessionId,
      matched: false,
      comparisons: [
        expect.objectContaining({
          label: "param-crc",
          matched: true,
          left: expect.objectContaining({ coreId: 0, value: "0x55AA" }),
          right: expect.objectContaining({ coreId: 2, value: "0x55AA" })
        }),
        expect.objectContaining({
          label: "fault-count",
          matched: false,
          left: expect.objectContaining({ coreId: 0, value: "1" }),
          right: expect.objectContaining({ coreId: 2, value: "2" })
        })
      ]
    });
  });
});

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
