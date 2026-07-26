import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { BoardWorkerClient } from "../src/boards/BoardWorkerClient.js";
import { BoardWorkerSupervisor } from "../src/boards/BoardWorkerSupervisor.js";
import { BoardRegistry } from "../src/boards/BoardRegistry.js";
import type { C2000McpConfig } from "../src/config/config.schema.js";
import type { BoardWorkerLaunchOptions } from "../src/worker/BoardWorkerRuntime.js";
import type { WorkerHeartbeat } from "../src/worker/WorkerHeartbeat.js";
import { DebugMcpError } from "../src/utils/errors.js";
import { EventRepository } from "../src/storage/repositories/EventRepository.js";
import { BoardRepository } from "../src/storage/repositories/BoardRepository.js";
import { LeaseRepository } from "../src/storage/repositories/LeaseRepository.js";
import { WorkerRepository } from "../src/storage/repositories/WorkerRepository.js";
import { SqliteStore } from "../src/storage/SqliteStore.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe("board worker supervisor", () => {
  test("command timeout restarts only the affected board worker", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "c2000-worker-supervisor-"));
    directories.push(directory);
    const store = await SqliteStore.open(path.join(directory, "state.sqlite"));
    const events = new EventRepository(store);
    const registry = new BoardRegistry(new BoardRepository(store), events, store, new LeaseRepository(store));
    registry.register({ boardId: "board-a", probeSerial: "A", device: "F28P65x", ccxmlPath: "a.ccxml", tags: [] });
    registry.register({ boardId: "board-b", probeSerial: "B", device: "F28P65x", ccxmlPath: "b.ccxml", tags: [] });
    const starts = new Map<string, number>();
    const clients: FakeWorker[] = [];
    const supervisor = new BoardWorkerSupervisor({
      config: configFor(directory),
      daemonInstanceId: "daemon-test",
      registry,
      workers: new WorkerRepository(store),
      events,
      factory: (options: BoardWorkerLaunchOptions) => {
        starts.set(options.boardId, (starts.get(options.boardId) ?? 0) + 1);
        const client = new FakeWorker(options, options.boardId === "board-a");
        clients.push(client);
        return client;
      }
    });
    try {
      await supervisor.startAll();
      const leaseA = registry.leases.acquire({ boardId: "board-a", ownerJobId: "job-a", ttlMs: 1000 });
      const leaseB = registry.leases.acquire({ boardId: "board-b", ownerJobId: "job-b", ttlMs: 1000 });
      await expect(supervisor.invokeBoard("board-a", "c2000_getTargetState", { __leaseContext: leaseA.context }, 5)).rejects.toMatchObject({ code: "WorkerCommandTimeout" });
      expect(starts.get("board-a")).toBe(2);
      expect(starts.get("board-b")).toBe(1);
      await expect(supervisor.invokeBoard("board-b", "c2000_getTargetState", { __leaseContext: leaseB.context }, 5)).resolves.toEqual(expect.objectContaining({ success: true, boardId: "board-b" }));
      await expect(supervisor.invokeBoard("board-b", "c2000_launchMulticoreDebugSafe", {
        __leaseContext: leaseB.context,
        cores: [
          { coreId: 0, coreName: "C28xx_CPU1", load: true },
          { coreId: 2, coreName: "C28xx_CPU2", load: true }
        ]
      })).resolves.toEqual(expect.objectContaining({ success: true, boardId: "board-b" }));
      expect(clients.find(client => client.boardId === "board-b")?.invokedTimeouts.at(-1)).toBe(750000);
      expect(clients.filter(client => client.boardId === "board-b" && client.stopped).length).toBe(0);
      expect(events.list({ boardId: "board-a" })).toEqual(expect.arrayContaining([
        expect.objectContaining({ eventType: "WORKER_RESTARTING" })
      ]));
    } finally {
      await supervisor.stopAll();
      store.close();
    }
  });
});

class FakeWorker implements BoardWorkerClient {
  readonly processStartTime = new Date().toISOString();
  readonly workerInstanceId: string;
  readonly boardId: string;
  readonly probeSerial: string;
  readonly pid = 1000;
  lastHeartbeatAt?: number;
  onHeartbeat?: (heartbeat: WorkerHeartbeat) => void;
  stopped = false;
  readonly invokedTimeouts: number[] = [];

  constructor(options: BoardWorkerLaunchOptions, private readonly shouldTimeout: boolean) {
    this.workerInstanceId = options.workerInstanceId;
    this.boardId = options.boardId;
    this.probeSerial = options.probeSerial;
  }

  async start(): Promise<void> {
    this.lastHeartbeatAt = Date.now();
  }

  async invokeTool(_toolName: string, _input: unknown, _timeoutMs: number): Promise<Record<string, unknown>> {
    this.invokedTimeouts.push(_timeoutMs);
    if (this.shouldTimeout) {
      throw new DebugMcpError("WorkerCommandTimeout", "simulated stuck command", { boardId: this.boardId });
    }
    return { success: true, boardId: this.boardId, probeSerial: this.probeSerial, workerInstanceId: this.workerInstanceId };
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }
}

function configFor(directory: string): C2000McpConfig {
  return {
    adapter: "mock", ccs: { scriptingMode: "mock" }, target: { name: "F28P65x", coreMap: [{ coreId: 0, coreName: "C28xx_CPU1" }] }, diagnostics: {}, logging: { level: "error" },
    daemon: { enabled: true, host: "127.0.0.1", port: 0, runtimeDir: directory, autoStart: false, startupTimeoutMs: 1000 },
    workers: { heartbeatIntervalMs: 1000, heartbeatTimeoutMs: 5000, defaultCommandTimeoutMs: 5, restartLimit: 5, restartWindowMs: 60000 }
  };
}
