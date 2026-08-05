import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { BoardRegistry } from "../src/boards/BoardRegistry.js";
import { BoardRepository } from "../src/storage/repositories/BoardRepository.js";
import { EventRepository } from "../src/storage/repositories/EventRepository.js";
import { LeaseRepository } from "../src/storage/repositories/LeaseRepository.js";
import { SqliteStore } from "../src/storage/SqliteStore.js";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))));

describe("lease fencing", () => {
  test("a newer lease permanently fences the previous generation", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "c2000-lease-fencing-"));
    directories.push(directory);
    const store = await SqliteStore.open(path.join(directory, "test.sqlite"));
    const registry = new BoardRegistry(new BoardRepository(store), new EventRepository(store), store, new LeaseRepository(store));
    registry.register({ boardId: "board-a", probeSerial: "CL650001", device: "F28P65x", ccxmlPath: "a.ccxml", tags: [] });
    registry.setWorker("board-a", "worker-1");

    const first = registry.leases.acquire({ boardId: "board-a", ownerJobId: "job-a", ttlMs: 1000, workerInstanceId: "worker-1" });
    expect(registry.leases.validate(first.context).fencingToken).toBe(1);
    registry.leases.release(first.lease.leaseId, first.leaseToken);
    const second = registry.leases.acquire({ boardId: "board-a", ownerJobId: "job-b", ttlMs: 1000, workerInstanceId: "worker-1" });

    expect(second.context.fencingToken).toBe(2);
    expect(() => registry.leases.validate(first.context)).toThrowError(expect.objectContaining({ code: "LeaseInvalidated" }));
    expect(registry.leases.validate(second.context).ownerJobId).toBe("job-b");
    store.close();
  });

  test("rejects owner, board, worker, and token mismatches", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "c2000-lease-identity-"));
    directories.push(directory);
    const store = await SqliteStore.open(path.join(directory, "test.sqlite"));
    const registry = new BoardRegistry(new BoardRepository(store), new EventRepository(store), store, new LeaseRepository(store));
    registry.register({ boardId: "board-a", probeSerial: "CL650001", device: "F28P65x", ccxmlPath: "a.ccxml", tags: [] });
    registry.setWorker("board-a", "worker-1");
    const leased = registry.leases.acquire({ boardId: "board-a", ownerJobId: "job-a", workerInstanceId: "worker-1", ttlMs: 1000 });

    expect(() => registry.leases.validate({ ...leased.context, ownerJobId: "job-b" })).toThrowError(expect.objectContaining({ code: "LeaseOwnerMismatch" }));
    expect(() => registry.leases.validate({ ...leased.context, boardId: "board-b" })).toThrowError(expect.objectContaining({ code: "LeaseBoardMismatch" }));
    expect(() => registry.leases.validate({ ...leased.context, workerInstanceId: "worker-2" })).toThrowError(expect.objectContaining({
      code: "LeaseWorkerMismatch",
      details: expect.objectContaining({ stage: "lease-validate", targetAccessAttempted: false, expectedWorkerInstanceId: "worker-1", receivedWorkerInstanceId: "worker-2" })
    }));
    expect(() => registry.leases.validate({ ...leased.context, leaseToken: "wrong" })).toThrowError(expect.objectContaining({ code: "LeaseFencingRejected" }));
    store.close();
  });

  test("worker restart invalidation requires the exact board and worker identity", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "c2000-lease-worker-restart-"));
    directories.push(directory);
    const store = await SqliteStore.open(path.join(directory, "test.sqlite"));
    const registry = new BoardRegistry(new BoardRepository(store), new EventRepository(store), store, new LeaseRepository(store));
    registry.register({ boardId: "board-a", probeSerial: "CL650001", device: "F28P65x", ccxmlPath: "a.ccxml", tags: [] });
    registry.setWorker("board-a", "worker-1");
    const leased = registry.leases.acquire({ boardId: "board-a", ownerJobId: "job-a", workerInstanceId: "worker-1", ttlMs: 1000 });

    expect(registry.leases.invalidateForWorkerRestart("board-a", "worker-2", "test")).toBe(false);
    expect(registry.leases.active("board-a")?.leaseId).toBe(leased.lease.leaseId);
    expect(registry.leases.invalidateForWorkerRestart("board-a", "worker-1", "test")).toBe(true);
    expect(registry.leases.active("board-a")).toBeUndefined();
    expect(registry.get("board-a").currentLeaseId).toBeUndefined();
    expect(() => registry.leases.validate(leased.context)).toThrowError(
      expect.objectContaining({ code: "LeaseInvalidated" })
    );
    store.close();
  });
});
