import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { BoardRepository } from "../src/storage/repositories/BoardRepository.js";
import { BoardGroupBarrierRepository } from "../src/storage/repositories/BoardGroupBarrierRepository.js";
import { BoardGroupRepository } from "../src/storage/repositories/BoardGroupRepository.js";
import { TestRunRepository } from "../src/storage/repositories/TestRunRepository.js";
import { SqliteStore } from "../src/storage/SqliteStore.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

describe("durable board-group barriers", () => {
  test("persists member runtime evidence and lets a later store instance satisfy the same barrier", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "c2000-group-barrier-"));
    directories.push(directory);
    const databasePath = path.join(directory, "debugd.sqlite");
    const first = await SqliteStore.open(databasePath);
    const boards = new BoardRepository(first);
    for (const boardId of ["board-a", "board-b"]) {
      boards.upsert({ boardId, probeSerial: `XDS-${boardId}`, device: "F28P65x", ccxmlPath: `${boardId}.ccxml`, tags: ["can"] });
    }
    const groups = new BoardGroupRepository(first);
    new TestRunRepository(first).create(
      { jobId: "job-persisted", planName: "barrier fixture", planVersion: 1, plan: {}, status: "RUNNING", progressCurrent: 0, progressTotal: 0, submittedAt: new Date().toISOString(), cancelRequested: false, failurePolicy: {} },
      [], []
    );
    const group = groups.createCanGroup({
      groupId: "group-persisted", jobId: "job-persisted", name: "persisted group", boardIds: ["board-a", "board-b"],
      members: [{ boardId: "board-a", role: "PRIMARY", nodeId: 1 }, { boardId: "board-b", role: "SECONDARY", nodeId: 2 }]
    });
    expect(group.status).toBe("ALLOCATING");
    groups.transition(group.groupId, "STARTING");
    groups.updateMember(group.groupId, "board-a", { status: "RESERVED", leaseId: "lease-a", sessionId: "session-a", heartbeatSnapshot: { worker: "alive" } });
    const firstBarriers = new BoardGroupBarrierRepository(first);
    const barrier = firstBarriers.begin({ groupId: group.groupId, jobId: "job-persisted", name: "ALL_RESERVED", expectedMembers: ["board-a", "board-b"], timeoutMs: 10_000 });
    expect(firstBarriers.arrive({ barrierId: barrier.barrierId, boardId: "board-a", details: { leaseId: "lease-a" } }).status).toBe("WAITING");
    first.close();

    const second = await SqliteStore.open(databasePath);
    const secondBarriers = new BoardGroupBarrierRepository(second);
    const restored = secondBarriers.latest(group.groupId, "ALL_RESERVED");
    expect(restored).toEqual(expect.objectContaining({ barrierId: barrier.barrierId, status: "WAITING", arrivedMembers: { "board-a": { leaseId: "lease-a" } } }));
    expect(secondBarriers.arrive({ barrierId: barrier.barrierId, boardId: "board-b", details: { leaseId: "lease-b" } }).status).toBe("SATISFIED");
    const restoredGroup = new BoardGroupRepository(second).require(group.groupId);
    expect(restoredGroup.members).toEqual(expect.arrayContaining([expect.objectContaining({ boardId: "board-a", status: "RESERVED", leaseId: "lease-a", sessionId: "session-a" })]));
    second.close();
  });

  test("rejects a second stateful group for the same physical board", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "c2000-group-exclusive-"));
    directories.push(directory);
    const store = await SqliteStore.open(path.join(directory, "debugd.sqlite"));
    const boards = new BoardRepository(store);
    for (const boardId of ["board-a", "board-b", "board-c"]) boards.upsert({ boardId, probeSerial: `XDS-${boardId}`, device: "F28P65x", ccxmlPath: `${boardId}.ccxml`, tags: [] });
    const groups = new BoardGroupRepository(store);
    groups.createCanGroup({ groupId: "group-one", jobId: "job-one", name: "one", boardIds: ["board-a", "board-b"] });
    expect(() => groups.createCanGroup({ groupId: "group-two", jobId: "job-two", name: "two", boardIds: ["board-a", "board-c"] })).toThrow(/already participating/);
    store.close();
  });
});
