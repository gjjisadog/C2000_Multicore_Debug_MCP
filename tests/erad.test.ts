import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DebugSessionManager } from "../src/debug/DebugSessionManager.js";
import type { BoardLeaseContext } from "../src/boards/types.js";
import type { BoardWorkerSupervisor } from "../src/boards/BoardWorkerSupervisor.js";
import { c2000McpConfigSchema } from "../src/config/config.schema.js";
import {
  F28p65xEradRegisterBackend,
  MockEradBackend
} from "../src/observability/EradBackend.js";
import {
  configureEradProfileSchema,
  eradProfileResultSchema,
  type EradResourceSelection
} from "../src/observability/EradSchemas.js";
import { EradService } from "../src/observability/EradService.js";
import { c2000ToolDefinitions } from "../src/mcp/tools.js";
import { SqliteStore } from "../src/storage/SqliteStore.js";
import { BoardRepository } from "../src/storage/repositories/BoardRepository.js";
import { SessionRepository } from "../src/storage/repositories/SessionRepository.js";
import { EradProfileRepository } from "../src/storage/repositories/EradProfileRepository.js";
import { DebugMcpError } from "../src/utils/errors.js";

const roots: string[] = [];
const resources: EradResourceSelection = {
  startBusComparator: 1,
  endBusComparator: 2,
  maxCounter: 1,
  cumulativeCounter: 2,
  eventCounter: 3
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("F28P65x ERAD profiling", () => {
  it("exposes six explicit-core tools and classifies configuration as target mutation", () => {
    const names = [
      "c2000_getEradCapabilities",
      "c2000_configureEradProfile",
      "c2000_startEradProfile",
      "c2000_stopEradProfile",
      "c2000_readEradProfile",
      "c2000_exportEradProfile"
    ];
    const definitions = c2000ToolDefinitions.filter(tool => names.includes(tool.name));
    expect(definitions.map(item => item.name)).toEqual(names);
    expect(definitions.every(item =>
      item.family === "observability" &&
      item.coreIdentityFields?.includes("coreId") &&
      item.responseCoreIdentityFields?.includes("coreName")
    )).toBe(true);
    expect(definitions.find(item => item.name === "c2000_configureEradProfile")?.effects)
      .toContain("target-memory-write");
  });

  it("bounds duration and validates distinct resource roles", () => {
    expect(configureEradProfileSchema.safeParse(configureInput({ durationMs: 600_001 })).success).toBe(false);
    expect(configureEradProfileSchema.safeParse(configureInput({
      resources: { ...resources, eventCounter: resources.maxCounter }
    })).success).toBe(false);
    expect(configureEradProfileSchema.safeParse(configureInput()).success).toBe(true);
  });

  it("detects F28P65x capabilities and explicitly reports no hardware minimum", async () => {
    const memory = new MemoryManager();
    const backend = new F28p65xEradRegisterBackend();
    const capabilities = await backend.capabilities(context(memory, 0, "F28P65x"));
    expect(capabilities).toMatchObject({
      supported: true,
      addressUnitBits: 16,
      registerPage: "DATA",
      busComparatorCount: 8,
      counterCount: 4,
      supportsMinCycles: false
    });
  });

  it("rejects unsupported devices before touching registers", async () => {
    const memory = new MemoryManager();
    const capabilities = await new F28p65xEradRegisterBackend()
      .capabilities(context(memory, 0, "F2837xD"));
    expect(capabilities.supported).toBe(false);
    expect(capabilities.reason).toContain("F28P65x-only");
    expect(memory.reads).toHaveLength(0);
  });

  it("rejects application ownership and occupied resources by default", async () => {
    const owner = new MemoryManager();
    owner.seed(0, 0x5e80a, 16, 1);
    const backend = new F28p65xEradRegisterBackend();
    await expect(backend.configure(context(owner), {
      startAddress: 0x1000,
      endAddress: 0x1010,
      resources,
      allowOverwrite: true
    })).rejects.toMatchObject({ code: "EradOwnershipConflict" });

    const occupied = new MemoryManager();
    occupied.seed(0, 0x5e902, 32, 0x1234);
    await expect(backend.configure(context(occupied), {
      startAddress: 0x1000,
      endAddress: 0x1010,
      resources,
      allowOverwrite: false
    })).rejects.toMatchObject({ code: "EradResourceConflict" });
  });

  it("requires explicit overwrite, saves selected configuration, and restores it", async () => {
    const memory = new MemoryManager();
    memory.seed(0, 0x5e902, 32, 0x1234);
    memory.seed(0, 0x5e80a, 16, 2);
    const backend = new F28p65xEradRegisterBackend();
    const configured = await backend.configure(context(memory), {
      startAddress: 0x2000,
      endAddress: 0x2010,
      resources,
      allowOverwrite: true
    });
    expect(configured.overwritten).toBe(true);
    expect(memory.value(0, 0x5e902, 32)).toBe(0x2000);
    expect(await backend.restore(context(memory), resources, configured.savedConfiguration)).toBe("RESTORED");
    expect(memory.value(0, 0x5e902, 32)).toBe(0x1234);
  });

  it("uses C28x DATA-page address units and keeps CPU1/CPU2 register state isolated", async () => {
    const memory = new MemoryManager();
    const backend = new F28p65xEradRegisterBackend();
    await backend.configure(context(memory, 0), {
      startAddress: 0x1000, endAddress: 0x1010, resources, allowOverwrite: false
    });
    await backend.configure(context(memory, 2), {
      startAddress: 0x3000, endAddress: 0x3010, resources, allowOverwrite: false
    });
    expect(memory.value(0, 0x5e902, 32)).toBe(0x1000);
    expect(memory.value(2, 0x5e902, 32)).toBe(0x3000);
    expect(memory.writes.every(write => write.page === "DATA")).toBe(true);
  });

  it("reads deterministic mock count/mean/max inputs and reports overflow independently", async () => {
    const backend = new MockEradBackend({
      count: 5,
      totalCycles: 550,
      maxCycles: 130,
      overflowResources: ["eventCounter"]
    });
    const configured = await backend.configure(context(new MemoryManager()), {
      startAddress: 1, endAddress: 2, resources, allowOverwrite: false
    });
    await backend.start(context(new MemoryManager()), configured.resources);
    const raw = await backend.stopAndRead(context(new MemoryManager()), configured.resources);
    expect(raw).toEqual({
      count: 5,
      totalCycles: 550,
      maxCycles: 130,
      overflowResources: ["eventCounter"]
    });
  });

  it("resolves symbols, freezes core identity, and computes deterministic statistics", async () => {
    const fixture = await createFixture();
    const configured = await fixture.service.configure(configureInput({ durationMs: 1000, sysclkHz: 200_000_000, sysclkSource: "user-config" }));
    expect(configured).toMatchObject({
      coreId: 0,
      coreName: "C28xx_CPU1",
      adapterSessionId: "adapter-a"
    });
    expect((configured.profile as any).config).toMatchObject({
      startSymbol: "CPU1_ISR_Fast",
      startAddress: "0x1000",
      endAddress: "0x1010"
    });
    await fixture.service.start(identityOf(configured));
    const stopped = await fixture.service.stop({ ...identityOf(configured), disposition: "stop" });
    const result = eradProfileResultSchema.parse((stopped.profile as any).result);
    expect(result).toMatchObject({
      count: 10,
      totalCycles: 1000,
      maxCycles: 120,
      meanCycles: 100,
      minCycles: null,
      minCyclesSource: "unavailable-on-f28p65x-erad",
      maxSeconds: 120 / 200_000_000,
      evidenceClassification: "MOCK",
      restoreStatus: "RESTORED"
    });
    fixture.close();
  });

  it("falls back to the persisted core map and records firmware hashes", async () => {
    const fixture = await createFixture({ resolveFailure: true, withMap: true });
    const configured = await fixture.service.configure(configureInput());
    expect((configured.profile as any).config).toMatchObject({
      symbolSource: "linker-map",
      startAddress: "0x2000",
      endAddress: "0x2010",
      firmwareHashes: {
        outSha256: "a".repeat(64),
        mapSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        source: "session-snapshot"
      }
    });
    fixture.close();
  });

  it("keeps cycle-to-time conversion null when SYSCLK is unknown", async () => {
    const fixture = await createFixture();
    const configured = await fixture.service.configure(configureInput({ durationMs: 1000 }));
    await fixture.service.start(identityOf(configured));
    const stopped = await fixture.service.stop(identityOf(configured));
    expect((stopped.profile as any).result).toMatchObject({
      sysclkHz: null,
      sysclkSource: "unknown",
      maxSeconds: null,
      meanSeconds: null
    });
    fixture.close();
  });

  it("supports automatic duration completion, cancel, and idempotent stop", async () => {
    const duration = await createFixture();
    const configured = await duration.service.configure(configureInput({ durationMs: 10 }));
    await duration.service.start(identityOf(configured));
    const completed = await waitForStatus(duration, String(configured.profileId), "COMPLETED");
    expect(completed.result).toBeTruthy();
    duration.close();

    const timeoutFixture = await createFixture();
    const timed = await timeoutFixture.service.configure(configureInput({ durationMs: 1000, timeoutMs: 10 }));
    await timeoutFixture.service.start(identityOf(timed));
    const timedOut = await waitForStatus(timeoutFixture, String(timed.profileId), "TIMED_OUT");
    expect(timedOut.stopReason).toBe("PROFILE_TIMEOUT");
    timeoutFixture.close();

    const cancelledFixture = await createFixture();
    const pending = await cancelledFixture.service.configure(configureInput({ durationMs: 1000 }));
    await cancelledFixture.service.start(identityOf(pending));
    const first = await cancelledFixture.service.stop({ ...identityOf(pending), disposition: "cancel" });
    const second = await cancelledFixture.service.stop({ ...identityOf(pending), disposition: "cancel" });
    expect((first.profile as any).status).toBe("CANCELLED");
    expect(second.idempotent).toBe(true);
    cancelledFixture.close();
  });

  it("fails closed on core mismatch, lease expiry, worker restart, and closed session", async () => {
    const mismatch = await createFixture({ coreMismatch: true });
    await expect(mismatch.service.configure(configureInput())).rejects.toMatchObject({ code: "CoreIdentityMismatch" });
    mismatch.close();

    const lease = await createFixture();
    const leaseConfigured = await lease.service.configure(configureInput());
    await lease.service.start(identityOf(leaseConfigured));
    lease.worker.leaseExpired = true;
    const leaseStopped = await lease.service.stop(identityOf(leaseConfigured));
    expect((leaseStopped.profile as any).status).toBe("INVALIDATED");
    lease.close();

    const restarted = await createFixture();
    const restartConfigured = await restarted.service.configure(configureInput());
    await restarted.service.start(identityOf(restartConfigured));
    restarted.worker.generation += 1;
    const restartStopped = await restarted.service.stop(identityOf(restartConfigured));
    expect((restartStopped.profile as any).status).toBe("INVALIDATED");
    restarted.close();

    const closed = await createFixture();
    const closedConfigured = await closed.service.configure(configureInput());
    await closed.service.start(identityOf(closedConfigured));
    closed.sessions.close("session-a");
    const closedStopped = await closed.service.stop(identityOf(closedConfigured));
    expect((closedStopped.profile as any).status).toBe("INVALIDATED");
    closed.close();
  });

  it("preempts and restores before reset/load-class commands", async () => {
    const fixture = await createFixture();
    const configured = await fixture.service.configure(configureInput({ durationMs: 1000 }));
    await fixture.service.start(identityOf(configured));
    await fixture.service.preemptBoard("board-a", "c2000_reset");
    const record = fixture.profiles.get(String(configured.profileId));
    expect(record).toMatchObject({ status: "CANCELLED", stopReason: "PREEMPTED_BY:c2000_reset" });
    expect(fixture.worker.restoreCalls).toBe(1);
    fixture.close();
  });

  it("marks daemon-restarted active profiles interrupted instead of recovering them as running", async () => {
    const fixture = await createFixture();
    const configured = await fixture.service.configure(configureInput());
    new EradService({
      ...fixture.serviceOptions,
      profiles: new EradProfileRepository(fixture.store)
    });
    expect(fixture.profiles.get(String(configured.profileId))?.status).toBe("INTERRUPTED");
    fixture.close();
  });

  it("exports erad.json atomically with standardized evidence and never promotes Mock to hardware", async () => {
    const fixture = await createFixture();
    const configured = await fixture.service.configure(configureInput({ durationMs: 1000 }));
    await fixture.service.start(identityOf(configured));
    await fixture.service.stop(identityOf(configured));
    const exported = await fixture.service.export(identityOf(configured));
    const directory = String(exported.artifactDirectory);
    const result = eradProfileResultSchema.parse(JSON.parse(await readFile(path.join(directory, "erad.json"), "utf8")));
    const manifest = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8"));
    const events = (await readFile(path.join(directory, "events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
    expect(result.evidenceClassification).toBe("MOCK");
    expect(manifest.evidenceLevel).toBe("MOCK");
    expect(events.map(event => event.sequence)).toEqual([1, 2, 3]);
    expect(events.every((event, index) => index === 0 ||
      BigInt(event.monotonicTimestampNs) > BigInt(events[index - 1].monotonicTimestampNs))).toBe(true);
    const first = await readFile(path.join(directory, "erad.json"), "utf8");
    await fixture.service.export(identityOf(configured));
    expect(await readFile(path.join(directory, "erad.json"), "utf8")).toBe(first);
    fixture.close();
  });
});

class MemoryManager {
  readonly reads: Array<{ coreId: number; page: string; address: number; typeSize: number }> = [];
  readonly writes: Array<{ coreId: number; page: string; address: number; value: number; typeSize: number }> = [];
  private readonly memory = new Map<string, number>();

  async readMemory(_sessionId: string, coreId: number, page: string, address: number, typeSize: number): Promise<number> {
    this.reads.push({ coreId, page, address, typeSize });
    return this.value(coreId, address, typeSize);
  }

  async writeMemory(_sessionId: string, coreId: number, page: string, address: number, value: number, typeSize: number): Promise<void> {
    this.writes.push({ coreId, page, address, value, typeSize });
    this.seed(coreId, address, typeSize, value);
  }

  seed(coreId: number, address: number, typeSize: number, value: number): void {
    this.memory.set(`${coreId}:${address}:${typeSize}`, value);
  }

  value(coreId: number, address: number, typeSize: number): number {
    return this.memory.get(`${coreId}:${address}:${typeSize}`) ?? 0;
  }
}

class FakeWorker {
  generation = 1;
  leaseExpired = false;
  restoreCalls = 0;

  constructor(private readonly options: { coreMismatch?: boolean; unsupported?: boolean; resolveFailure?: boolean } = {}) {}

  currentWorker() {
    return { workerInstanceId: "worker-a", workerGeneration: this.generation };
  }

  async invokeBoard(boardId: string, toolName: string, input: unknown) {
    return this.invoke(boardId, toolName, input);
  }

  async invokeBoardLowPriority(boardId: string, toolName: string, input: unknown) {
    return this.invoke(boardId, toolName, input);
  }

  private async invoke(boardId: string, toolName: string, input: unknown): Promise<Record<string, unknown>> {
    if (this.leaseExpired) throw Object.assign(new Error("expired"), { code: "LeaseExpired" });
    const values = input as Record<string, unknown>;
    if (toolName === "c2000_getSessionTopology") {
      return {
        success: true,
        boardId,
        probeSerial: "XDS-A",
        workerInstanceId: "worker-a",
        adapterSessionId: "adapter-a",
        cores: [{ coreId: this.options.coreMismatch ? 2 : 0, coreName: this.options.coreMismatch ? "C28xx_CPU2" : "C28xx_CPU1" }]
      };
    }
    const base = {
      success: true,
      boardId,
      probeSerial: "XDS-A",
      workerInstanceId: "worker-a",
      sessionId: values.sessionId,
      adapterSessionId: "adapter-a",
      coreId: values.coreId,
      coreName: "C28xx_CPU1"
    };
    if (values.operation === "capabilities") {
      return {
        ...base,
        capabilities: {
          schemaVersion: 1,
          supported: !this.options.unsupported,
          device: this.options.unsupported ? "F2837xD" : "F28P65x",
          supportedDevices: ["F28P65x"],
          addressUnitBits: 16,
          registerPage: "DATA",
          busComparatorCount: this.options.unsupported ? 0 : 8,
          counterCount: this.options.unsupported ? 0 : 4,
          supportsPcRange: !this.options.unsupported,
          supportsCycleCount: !this.options.unsupported,
          supportsEventCount: !this.options.unsupported,
          supportsMaxCycles: !this.options.unsupported,
          supportsMinCycles: false,
          supportsClaTaskTiming: false,
          supportsInterruptNesting: false,
          supportsCrossCoreSynchronization: false,
          supportsIpcSingleCycleLatency: false,
          ownership: this.options.unsupported ? "UNKNOWN" : "DEBUGGER",
          occupiedBusComparators: [],
          occupiedCounters: [],
          reason: this.options.unsupported ? "unsupported" : null
        }
      };
    }
    if (values.operation === "resolve") {
      if (this.options.resolveFailure) throw new DebugMcpError("EradSymbolNotFound", "symbols not loaded");
      return { ...base, startAddress: 0x1000, endAddress: 0x1010 };
    }
    if (values.operation === "configure") {
      return { ...base, resources, savedConfiguration: { required: true }, overwritten: false };
    }
    if (values.operation === "stop-read-restore") {
      this.restoreCalls += 1;
      return {
        ...base,
        raw: { count: 10, totalCycles: 1000, maxCycles: 120, overflowResources: [] },
        restoreStatus: "RESTORED"
      };
    }
    return base;
  }
}

async function createFixture(options: {
  coreMismatch?: boolean;
  unsupported?: boolean;
  resolveFailure?: boolean;
  withMap?: boolean;
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "c2000-erad-"));
  roots.push(root);
  const store = await SqliteStore.open(path.join(root, "test.sqlite"));
  const boards = new BoardRepository(store);
  boards.upsert({ boardId: "board-a", probeSerial: "XDS-A", device: "F28P65x", ccxmlPath: "mock.ccxml", tags: ["mock"] });
  const sessions = new SessionRepository(store);
  const mapUri = path.join(root, "cpu1.map");
  if (options.withMap) {
    await writeFile(mapUri, [
      "0 00002000 CPU1_ISR_Fast",
      "0 00002010 CPU1_ISR_Fast_End"
    ].join("\n"));
  }
  sessions.upsert({
    sessionId: "session-a",
    boardId: "board-a",
    workerInstanceId: "worker-a",
    sessionName: "test",
    adapterSessionId: "adapter-a",
    coreMap: [{ coreId: 0, coreName: "C28xx_CPU1" }],
    status: "OPEN",
    createdAt: new Date().toISOString(),
    ...(options.withMap ? {
      lastSnapshot: {
        loadedPrograms: [{
          coreId: 0,
          programUri: path.join(root, "cpu1.out"),
          mapUri,
          sha256: "a".repeat(64)
        }]
      }
    } : {})
  });
  const profiles = new EradProfileRepository(store);
  const worker = new FakeWorker(options);
  const lease: BoardLeaseContext = {
    boardId: "board-a",
    probeSerial: "XDS-A",
    leaseId: "lease-a",
    leaseToken: "token-a",
    leaseGeneration: 1,
    fencingToken: 1,
    workerInstanceId: "worker-a"
  };
  const config = c2000McpConfigSchema.parse({
    toolProfile: "full",
    adapter: "mock",
    ccs: { scriptingMode: "mock" },
    target: { name: "F28P65x", coreMap: [{ coreId: 0, coreName: "C28xx_CPU1" }] }
  });
  const serviceOptions = {
    rootDirectory: path.join(root, "artifacts"),
    config,
    profiles,
    boards,
    sessions,
    workers: worker as unknown as BoardWorkerSupervisor,
    leaseContext: () => {
      if (worker.leaseExpired) {
        throw new DebugMcpError("LeaseExpired", "expired");
      }
      return lease;
    }
  };
  const service = new EradService(serviceOptions);
  return {
    root,
    store,
    boards,
    sessions,
    profiles,
    worker,
    serviceOptions,
    service,
    close() { store.close(); }
  };
}

function configureInput(overrides: Record<string, unknown> = {}) {
  return {
    boardId: "board-a",
    sessionId: "session-a",
    coreId: 0,
    profileName: "cpu1_fast_isr",
    startSymbol: "CPU1_ISR_Fast",
    endSymbol: "CPU1_ISR_Fast_End",
    mode: "cycle-count",
    durationMs: 1000,
    ...overrides
  };
}

function identityOf(value: Record<string, unknown>) {
  return {
    profileId: String(value.profileId),
    boardId: String(value.boardId),
    sessionId: String(value.sessionId),
    coreId: Number(value.coreId)
  };
}

function context(memory: MemoryManager, coreId = 0, device = "F28P65x") {
  return {
    manager: memory as unknown as DebugSessionManager,
    sessionId: "session-a",
    coreId,
    device
  };
}

async function waitForStatus(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  profileId: string,
  status: string
) {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    const record = fixture.profiles.get(profileId);
    if (record?.status === status) return record;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`Profile ${profileId} did not reach ${status}`);
}
