import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { BoardRegistry } from "../src/boards/BoardRegistry.js";
import { BoardRepository } from "../src/storage/repositories/BoardRepository.js";
import { EventRepository } from "../src/storage/repositories/EventRepository.js";
import { LeaseRepository } from "../src/storage/repositories/LeaseRepository.js";
import { SqliteStore } from "../src/storage/SqliteStore.js";
import { DatabaseConsistencyChecker } from "../src/storage/DatabaseConsistencyChecker.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe("SQLite durable store", () => {
  test("migrates once, enables WAL, and keeps board/lease state across reopen", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "c2000-sqlite-test-"));
    directories.push(directory);
    const databasePath = path.join(directory, "c2000-debugd.sqlite");
    const first = await SqliteStore.open(databasePath, { wal: true });
    expect(first.schemaVersion).toBe(3);
    expect(first.journalMode()).toBe("wal");

    const registry = new BoardRegistry(
      new BoardRepository(first),
      new EventRepository(first),
      first,
      new LeaseRepository(first)
    );
    registry.register({ boardId: "board-a", probeSerial: "CL650001", device: "F28P65x", ccxmlPath: "board-a.ccxml", tags: ["Hybrid30K", "F28P65x"] });
    const lease = registry.leases.acquire({ boardId: "board-a", ownerJobId: "run-1", ttlMs: 1000 });
    expect(registry.list({ tags: ["Hybrid30K"] })).toEqual([
      expect.objectContaining({ boardId: "board-a", status: "AVAILABLE", leaseOwner: "run-1" })
    ]);
    first.close();

    const second = await SqliteStore.open(databasePath, { wal: true });
    expect(second.schemaVersion).toBe(3);
    const reopenedRegistry = new BoardRegistry(
      new BoardRepository(second),
      new EventRepository(second),
      second,
      new LeaseRepository(second)
    );
    expect(reopenedRegistry.leases.active("board-a")).toEqual(expect.objectContaining({
      leaseId: lease.lease.leaseId,
      ownerJobId: "run-1"
    }));
    expect(new EventRepository(second).list({ boardId: "board-a" })).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventType: "BOARD_REGISTERED" })
    ]));
    expect(new DatabaseConsistencyChecker(second).check()).toEqual(expect.objectContaining({ healthy: true, issues: [] }));
    new BoardRepository(second).setWorker("board-a", "worker-does-not-exist");
    expect(new DatabaseConsistencyChecker(second).check()).toEqual(expect.objectContaining({
      healthy: false,
      issues: expect.arrayContaining([expect.objectContaining({ code: "BOARD_WORKER_REFERENCE_STALE", entity: "board-a" })])
    }));
    second.close();
  });
});
