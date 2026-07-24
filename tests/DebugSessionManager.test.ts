import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { MockDebugAdapter } from "../src/adapters/MockDebugAdapter.js";
import type { AdapterSession } from "../src/adapters/types.js";
import { DebugSessionManager } from "../src/debug/DebugSessionManager.js";
import { LoadedProgramRegistry } from "../src/debug/LoadedProgramRegistry.js";
import type { CoreId } from "../src/debug/types.js";
import { SessionQueue } from "../src/utils/sessionQueue.js";

const coreMap = [
  { coreId: 0, coreName: "C28xx_CPU1", corePattern: "C28xx_CPU1" },
  { coreId: 2, coreName: "C28xx_CPU2", corePattern: "C28xx_CPU2" }
];

function createManager() {
  return new DebugSessionManager(new MockDebugAdapter(), new LoadedProgramRegistry());
}

describe("DebugSessionManager", () => {
  test("creates a logical debug session and lists CPU1/CPU2 without relying on UI focus", async () => {
    const manager = createManager();

    const session = await manager.createDebugSession({
      sessionName: "hybrid30k_f28p65x_ipc",
      ccxmlPath: "D:/workspace/targetConfigs/TMS320F28P650DK9.ccxml",
      coreMap
    });

    expect(session.sessionId).toMatch(/^dbg-/);
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
      adapterSessionId: expect.stringMatching(/^mock-/),
      debugSessionRoute: "sessionId -> adapterSessionId -> coreId -> DebugSession",
      cores: [
        { coreId: 0, coreName: "C28xx_CPU1", corePattern: "C28xx_CPU1", targetSelector: "C28xx_CPU1", debugSessionKey: expect.stringMatching(/^mock-.*:0$/) },
        { coreId: 2, coreName: "C28xx_CPU2", corePattern: "C28xx_CPU2", targetSelector: "C28xx_CPU2", debugSessionKey: expect.stringMatching(/^mock-.*:2$/) }
      ]
    });
  });

  test("connects, halts, runs and snapshots an explicitly selected core", async () => {
    const manager = createManager();
    const session = await manager.createDebugSession({ sessionName: "explicit-core", coreMap });

    await manager.connectTarget(session.sessionId, 0);
    await manager.haltCore(session.sessionId, 0);
    const halted = await manager.getTargetState(session.sessionId, 0);
    expect(halted).toEqual(expect.objectContaining({ coreId: 0, connected: true, state: "Halted", pc: "0x00000000" }));

    await manager.runCore(session.sessionId, 0);
    const snapshot = await manager.getMulticoreSnapshot(session.sessionId);
    expect(snapshot.cores).toEqual([
      expect.objectContaining({ coreId: 0, name: "C28xx_CPU1", coreName: "C28xx_CPU1", connected: true, state: "Running" }),
      expect.objectContaining({ coreId: 2, name: "C28xx_CPU2", coreName: "C28xx_CPU2", connected: false, state: "Disconnected" })
    ]);
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
