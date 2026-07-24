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

describe("atomic board group leases", () => {
  test("acquires both boards and advances fencing generations", async () => {
    const fixture = await makeFixture();
    const first = fixture.registry.leases.acquireGroup({ boardIds: ["board-b", "board-a"], ownerJobId: "job-1", ttlMs: 1000 });
    expect(first.map(item => item.lease.boardId)).toEqual(["board-a", "board-b"]);
    expect(first.map(item => item.context.fencingToken)).toEqual([1, 1]);
    first.forEach(item => fixture.registry.leases.release(item.lease.leaseId, item.leaseToken));
    const second = fixture.registry.leases.acquireGroup({ boardIds: ["board-a", "board-b"], ownerJobId: "job-2", ttlMs: 1000 });
    expect(second.map(item => item.context.fencingToken)).toEqual([2, 2]);
    fixture.store.close();
  });

  test("rolls back the whole group when the second board is occupied", async () => {
    const fixture = await makeFixture();
    fixture.registry.leases.acquire({ boardId: "board-b", ownerJobId: "blocker", ttlMs: 1000 });
    expect(() => fixture.registry.leases.acquireGroup({ boardIds: ["board-a", "board-b"], ownerJobId: "pair", ttlMs: 1000 })).toThrowError(expect.objectContaining({ code: "BoardLeased" }));
    expect(fixture.registry.leases.active("board-a")).toBeUndefined();
    expect(fixture.registry.get("board-a").currentLeaseId).toBeUndefined();
    expect(fixture.registry.leases.active("board-b")?.ownerJobId).toBe("blocker");
    fixture.store.close();
  });

  test("rejects duplicate group members before writing", async () => {
    const fixture = await makeFixture();
    expect(() => fixture.registry.leases.acquireGroup({ boardIds: ["board-a", "board-a"], ownerJobId: "pair", ttlMs: 1000 })).toThrow();
    expect(fixture.registry.leases.active("board-a")).toBeUndefined();
    fixture.store.close();
  });
});

async function makeFixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "c2000-group-lease-"));
  directories.push(directory);
  const store = await SqliteStore.open(path.join(directory, "test.sqlite"));
  const registry = new BoardRegistry(new BoardRepository(store), new EventRepository(store), store, new LeaseRepository(store));
  for (const boardId of ["board-a", "board-b"]) {
    registry.register({ boardId, probeSerial: `XDS-${boardId}`, device: "F28P65x", ccxmlPath: `${boardId}.ccxml`, tags: [] });
    registry.setWorker(boardId, `worker-${boardId}`);
  }
  return { store, registry };
}
