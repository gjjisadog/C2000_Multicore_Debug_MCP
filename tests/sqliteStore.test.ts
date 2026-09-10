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
import { ImplementationRunRepository } from "../src/improvement/implementation/ImplementationRunRepository.js";
import type { ImprovementImplementationRun } from "../src/improvement/implementation/ImplementationSchemas.js";

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
    expect(first.schemaVersion).toBe(19);
    expect(first.journalMode()).toBe("wal");

    const registry = new BoardRegistry(
      new BoardRepository(first),
      new EventRepository(first),
      first,
      new LeaseRepository(first)
    );
    registry.register({ boardId: "board-a", probeSerial: "CL650001", device: "F28P65x", ccxmlPath: "board-a.ccxml", tags: ["Hybrid30K", "F28P65x"] });
    const lease = registry.leases.acquire({ boardId: "board-a", ownerJobId: "run-1", workerInstanceId: "worker-1", ttlMs: 1000 });
    expect(registry.list({ tags: ["Hybrid30K"] })).toEqual([
      expect.objectContaining({ boardId: "board-a", status: "AVAILABLE", leaseOwner: "run-1" })
    ]);
    first.close();

    const second = await SqliteStore.open(databasePath, { wal: true });
    expect(second.schemaVersion).toBe(19);
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

  test("persists implementation runs and marks active runs interrupted after restart", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "c2000-sqlite-implementation-test-"));
    directories.push(directory);
    const databasePath = path.join(directory, "c2000-debugd.sqlite");
    const createdAt = "2026-01-01T00:00:00.000Z";
    const run: ImprovementImplementationRun = {
      runId: "imp-run-sqlite-001",
      proposalId: "imp-proposal-sqlite-001",
      runKind: "initial",
      baselineSha: "0123456789abcdef0123456789abcdef01234567",
      branchName: "improve/imp-proposal-sqlite-001-run",
      worktreePath: path.join(directory, "worktree"),
      createdAt,
      status: "created",
      agentAttempts: 0,
      preImplementationStatus: {
        headSha: "0123456789abcdef0123456789abcdef01234567",
        clean: true,
        statusShort: [],
        changedFiles: [],
        capturedAt: createdAt
      }
    };

    const first = await SqliteStore.open(databasePath);
    first.run(`
      INSERT INTO improvement_proposals(
        proposal_id, fingerprint, status, category, target, title, summary,
        evidence_json, proposed_change_json, expected_benefit_json, risks_json,
        validation_json, confidence, priority, generated_by, source_window,
        created_at, updated_at, last_observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      run.proposalId,
      "0123456789abcdef01234567",
      "approved",
      "workflow",
      "sqlite.test",
      "SQLite implementation run fixture",
      "SQLite implementation run fixture",
      "{}",
      "{}",
      "{}",
      "[]",
      "{}",
      0.9,
      "P2",
      "static-rule",
      "7d",
      createdAt,
      createdAt,
      createdAt
    ]);
    const repository = new ImplementationRunRepository(first);
    repository.upsert(run);
    expect(repository.get(run.runId)).toEqual(run);
    first.close();

    const second = await SqliteStore.open(databasePath);
    const reopened = new ImplementationRunRepository(second);
    expect(reopened.findActiveByProposal(run.proposalId)).toEqual(run);
    const interrupted = reopened.markActiveInterrupted("daemon restart; automatic resume is disabled", "2026-01-01T00:01:00.000Z");
    expect(interrupted).toEqual([
      expect.objectContaining({
        runId: run.runId,
        status: "interrupted",
        failureReason: "daemon restart; automatic resume is disabled"
      })
    ]);
    expect(reopened.findActiveByProposal(run.proposalId)).toBeUndefined();
    second.close();
  });
});
