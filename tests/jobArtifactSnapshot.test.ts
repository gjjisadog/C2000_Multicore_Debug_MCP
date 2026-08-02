import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { AtomicArtifactWriter } from "../src/artifacts/AtomicArtifactWriter.js";
import { JobArtifactSnapshotService } from "../src/artifacts/JobArtifactSnapshotService.js";
import {
  artifactEventSchema,
  artifactManifestSchema,
  artifactResultSchema
} from "../src/artifacts/ArtifactSchemas.js";
import type { C2000McpConfig } from "../src/config/config.schema.js";
import { SqliteStore } from "../src/storage/SqliteStore.js";
import { ArtifactExportRepository } from "../src/storage/repositories/ArtifactExportRepository.js";
import { ArtifactRepository } from "../src/storage/repositories/ArtifactRepository.js";
import { BoardRepository } from "../src/storage/repositories/BoardRepository.js";
import { EventRepository } from "../src/storage/repositories/EventRepository.js";
import { SessionRepository } from "../src/storage/repositories/SessionRepository.js";
import { TestRunRepository } from "../src/storage/repositories/TestRunRepository.js";
import { WorkerRepository } from "../src/storage/repositories/WorkerRepository.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("standard job artifact snapshot", () => {
  it("validates manifest and emits the standard directory without empty future files", async () => {
    const fixture = await createFixture();
    await fixture.service.exportJob(fixture.jobId);
    const files = (await readdir(fixture.jobDirectory)).sort();
    expect(files).toEqual(["attachments", "events.jsonl", "manifest.json", "result.json", "summary.md", "target-state.jsonl"]);
    expect(artifactManifestSchema.parse(await readJson(path.join(fixture.jobDirectory, "manifest.json"))).schemaVersion).toBe(1);
    fixture.store.close();
  });

  it("validates the machine-only result schema", async () => {
    const fixture = await createFixture();
    await fixture.service.exportJob(fixture.jobId);
    expect(artifactResultSchema.parse(await readJson(path.join(fixture.jobDirectory, "result.json"))).overallStatus).toBe("PASSED");
    fixture.store.close();
  });

  it("atomically publishes custom expression snapshots and commits their hash in the manifest", async () => {
    const fixture = await createFixture();
    const step = fixture.runs.steps(fixture.jobId)[0]!;
    fixture.runs.updateStep({
      ...step,
      output: {
        success: true,
        expressionSnapshots: [{
          label: "hybrid-a-e",
          sampleIndex: 0,
          capturedAt: "2026-07-29T00:00:01.500Z",
          captures: [{ coreId: 0, expressions: ["g_safe"], evaluated: { success: true, results: [{ value: 1 }] } }]
        }]
      }
    });

    await fixture.service.exportJob(fixture.jobId);
    const manifest = artifactManifestSchema.parse(await readJson(path.join(fixture.jobDirectory, "manifest.json")));
    const result = artifactResultSchema.parse(await readJson(path.join(fixture.jobDirectory, "result.json")));
    const snapshots = await readJson(path.join(fixture.jobDirectory, "expression-snapshots.json")) as Record<string, unknown>;
    expect(result.expressionSnapshotCount).toBe(1);
    expect(snapshots.snapshots).toEqual([expect.objectContaining({ boardId: "board-a", stepIndex: 0, label: "hybrid-a-e" })]);
    expect(manifest.generatedFiles).toEqual(expect.arrayContaining([expect.objectContaining({
      path: "expression-snapshots.json",
      artifactType: "evidence:expression-snapshots",
      completeness: "COMPLETE",
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/)
    })]));
    expect((await readdir(fixture.jobDirectory)).some(file => file.endsWith(".tmp"))).toBe(false);
    fixture.store.close();
  });

  it("commits durable mutation results in the manifest without duplicating capture windows", async () => {
    const fixture = await createFixture();
    fixture.store.run("UPDATE test_steps SET step_type = ?, input_json = ?, output_json = ? WHERE job_id = ?", [
      "assignExpressions",
      JSON.stringify({ type: "assignExpressions", assignments: [{ coreId: 0, expression: "g_cmd", value: 1, verify: true }] }),
      JSON.stringify({ success: true, results: [{ coreId: 0, coreName: "C28xx_CPU1", success: true, readback: 1 }] }),
      fixture.jobId
    ]);
    await fixture.service.exportJob(fixture.jobId);
    const manifest = artifactManifestSchema.parse(await readJson(path.join(fixture.jobDirectory, "manifest.json")));
    expect(manifest.durableStepResults).toEqual([expect.objectContaining({
      boardId: "board-a",
      stepType: "assignExpressions",
      status: "PASSED",
      input: expect.objectContaining({ assignments: [expect.objectContaining({ coreId: 0 })] }),
      output: expect.objectContaining({ results: [expect.objectContaining({ coreId: 0, readback: 1 })] })
    })]);
    fixture.store.close();
  });

  it("restores the previous expression snapshot together with its manifest when commit publication fails", async () => {
    const fixture = await createFixture();
    const step = fixture.runs.steps(fixture.jobId)[0]!;
    fixture.runs.updateStep({ ...step, output: { success: true, expressionSnapshots: [{ capturedAt: "2026-07-29T00:00:01.500Z", sampleIndex: 0, captures: [{ coreId: 0, value: 1 }] }] } });
    await fixture.service.exportJob(fixture.jobId);
    const manifestPath = path.join(fixture.jobDirectory, "manifest.json");
    const snapshotsPath = path.join(fixture.jobDirectory, "expression-snapshots.json");
    const before = { manifest: await readFile(manifestPath, "utf8"), snapshots: await readFile(snapshotsPath, "utf8") };
    fixture.runs.updateStep({ ...step, output: { success: true, expressionSnapshots: [{ capturedAt: "2026-07-29T00:00:01.600Z", sampleIndex: 0, captures: [{ coreId: 0, value: 2 }] }] } });
    class FailingManifestWriter extends AtomicArtifactWriter {
      override async writeText(filePath: string, content: string): Promise<void> {
        if (filePath.endsWith("manifest.json")) throw new Error("injected manifest commit failure");
        return super.writeText(filePath, content);
      }
    }
    await expect(fixture.makeService(new FailingManifestWriter()).exportJob(fixture.jobId)).rejects.toThrow("injected manifest commit failure");
    expect(await readFile(manifestPath, "utf8")).toBe(before.manifest);
    expect(await readFile(snapshotsPath, "utf8")).toBe(before.snapshots);
    fixture.store.close();
  });

  it("persists strictly increasing event sequence", async () => {
    const fixture = await createFixture();
    fixture.events.append({ level: "info", sourceType: "job", sourceId: fixture.jobId, jobId: fixture.jobId, boardId: "board-a", eventType: "SECOND", payload: {} });
    await fixture.service.exportJob(fixture.jobId);
    const events = await readJsonLines(path.join(fixture.jobDirectory, "events.jsonl"));
    const parsed = events.map(event => artifactEventSchema.parse(event));
    expect(parsed.map(event => event.sequence)).toEqual([1, 2]);
    fixture.store.close();
  });

  it("persists valid nondecreasing monotonic timestamps", async () => {
    const fixture = await createFixture();
    fixture.events.append({ level: "info", sourceType: "job", sourceId: fixture.jobId, jobId: fixture.jobId, eventType: "SECOND", payload: {} });
    await fixture.service.exportJob(fixture.jobId);
    const parsed = (await readJsonLines(path.join(fixture.jobDirectory, "events.jsonl"))).map(event => artifactEventSchema.parse(event));
    expect(parsed.every(event => /^\d+$/.test(event.monotonicTimestampNs))).toBe(true);
    expect(BigInt(parsed[1]!.monotonicTimestampNs)).toBeGreaterThanOrEqual(BigInt(parsed[0]!.monotonicTimestampNs));
    fixture.store.close();
  });

  it("publishes atomic files without partial JSON lines", async () => {
    const root = await temporaryRoot();
    const writer = new AtomicArtifactWriter();
    const filePath = path.join(root, "events.jsonl");
    await writer.writeJsonLines(filePath, [{ sequence: 1 }, { sequence: 2 }]);
    expect((await readFile(filePath, "utf8")).endsWith("\n")).toBe(true);
    expect((await readdir(root)).some(file => file.endsWith(".tmp"))).toBe(false);
  });

  it("marks a cancelled job artifact as incomplete", async () => {
    const fixture = await createFixture("CANCELLED");
    await fixture.service.exportJob(fixture.jobId);
    const manifest = artifactManifestSchema.parse(await readJson(path.join(fixture.jobDirectory, "manifest.json")));
    const result = artifactResultSchema.parse(await readJson(path.join(fixture.jobDirectory, "result.json")));
    expect(manifest.completeness).toEqual({ status: "INCOMPLETE", reason: "JOB_CANCELLED" });
    expect(result).toMatchObject({ cancelled: true, incompleteReason: "JOB_CANCELLED" });
    fixture.store.close();
  });

  it("marks declared firmware with an unavailable hash as incomplete", async () => {
    const fixture = await createFixture();
    await rm(path.join(fixture.root, "cpu1.out"));
    await fixture.service.exportJob(fixture.jobId);
    const manifest = artifactManifestSchema.parse(await readJson(path.join(fixture.jobDirectory, "manifest.json")));
    const result = artifactResultSchema.parse(await readJson(path.join(fixture.jobDirectory, "result.json")));
    expect(manifest.completeness).toEqual({ status: "INCOMPLETE", reason: "PROGRAM_OR_MAP_HASH_UNAVAILABLE" });
    expect(result.incompleteReason).toBe("PROGRAM_OR_MAP_HASH_UNAVAILABLE");
    fixture.store.close();
  });

  it("recognizes and regenerates a missing commit marker after daemon restart", async () => {
    const fixture = await createFixture();
    await fixture.service.exportJob(fixture.jobId);
    await rm(path.join(fixture.jobDirectory, "manifest.json"));
    const restarted = fixture.makeService();
    await restarted.recoverExisting();
    expect(artifactManifestSchema.safeParse(await readJson(path.join(fixture.jobDirectory, "manifest.json"))).success).toBe(true);
    fixture.store.close();
  });

  it("is byte-idempotent when the SQLite facts have not changed", async () => {
    const fixture = await createFixture();
    await fixture.service.exportJob(fixture.jobId);
    const before = await snapshotBytes(fixture.jobDirectory);
    await fixture.service.exportJob(fixture.jobId);
    expect(await snapshotBytes(fixture.jobDirectory)).toEqual(before);
    fixture.store.close();
  });

  it("preserves generated observability file declarations when the base snapshot is regenerated", async () => {
    const fixture = await createFixture();
    await fixture.service.exportJob(fixture.jobId);
    const manifestPath = path.join(fixture.jobDirectory, "manifest.json");
    const manifest = await readJson(manifestPath) as Record<string, unknown>;
    await writeFile(manifestPath, `${JSON.stringify({
      ...manifest,
      generatedFiles: [{
        path: "trace.json",
        artifactType: "observability:trace",
        sha256: "a".repeat(64),
        size: 42,
        completeness: "COMPLETE"
      }]
    }, null, 2)}\n`);
    await fixture.service.exportJob(fixture.jobId);
    expect(artifactManifestSchema.parse(await readJson(manifestPath)).generatedFiles).toEqual([
      expect.objectContaining({ path: "trace.json", artifactType: "observability:trace" })
    ]);
    fixture.store.close();
  });

  it("records artifact failure without changing the original job result", async () => {
    const fixture = await createFixture();
    class FailingWriter extends AtomicArtifactWriter {
      override async writeText(): Promise<void> {
        throw new Error("injected artifact failure");
      }
    }
    const failing = fixture.makeService(new FailingWriter());
    await expect(failing.exportJob(fixture.jobId)).rejects.toThrow("injected artifact failure");
    expect(fixture.runs.get(fixture.jobId)?.status).toBe("PASSED");
    expect(fixture.exports.get(fixture.jobId)).toMatchObject({ status: "FAILED", completeness: "ARTIFACT_FAILED" });
    fixture.store.close();
  });

  it("redacts sensitive event fields from portable artifacts", async () => {
    const fixture = await createFixture();
    fixture.events.append({
      level: "error",
      sourceType: "daemon",
      sourceId: "daemon-a",
      jobId: fixture.jobId,
      eventType: "SECRET_TEST",
      payload: { daemonRpcToken: "do-not-export", nested: { githubToken: "also-secret", useful: 7 } }
    });
    await fixture.service.exportJob(fixture.jobId);
    const text = await readFile(path.join(fixture.jobDirectory, "events.jsonl"), "utf8");
    expect(text).not.toContain("do-not-export");
    expect(text).not.toContain("also-secret");
    expect(text).toContain("\"useful\":7");
    fixture.store.close();
  });

  it("never classifies Mock adapter evidence as real hardware", async () => {
    const fixture = await createFixture("PASSED", "mock");
    await fixture.service.exportJob(fixture.jobId);
    const manifest = artifactManifestSchema.parse(await readJson(path.join(fixture.jobDirectory, "manifest.json")));
    const result = artifactResultSchema.parse(await readJson(path.join(fixture.jobDirectory, "result.json")));
    expect(manifest.evidenceLevel).toBe("MOCK");
    expect(result.evidenceClassification).toBe("MOCK");
    fixture.store.close();
  });

  it("migrates a version-5 database additively and backfills legacy event ordering", async () => {
    const root = await temporaryRoot();
    const databasePath = path.join(root, "legacy-v5.sqlite");
    const legacy = new Database(databasePath);
    legacy.exec(`
      CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations(version, applied_at) VALUES(5, '2026-07-29T00:00:00.000Z');
      CREATE TABLE test_runs(job_id TEXT PRIMARY KEY);
      INSERT INTO test_runs(job_id) VALUES('legacy-job');
      CREATE TABLE workers (
        worker_instance_id TEXT PRIMARY KEY, board_id TEXT NOT NULL, pid INTEGER NOT NULL,
        process_start_time TEXT NOT NULL, daemon_instance_id TEXT NOT NULL, status TEXT NOT NULL,
        started_at TEXT NOT NULL, last_heartbeat_at TEXT, current_command_id TEXT,
        owned_dss_processes_json TEXT NOT NULL, last_error_json TEXT
      );
      CREATE TABLE events (
        event_id TEXT PRIMARY KEY, timestamp TEXT NOT NULL, level TEXT NOT NULL,
        source_type TEXT NOT NULL, source_id TEXT NOT NULL, job_id TEXT, board_id TEXT,
        worker_instance_id TEXT, event_type TEXT NOT NULL, payload_json TEXT NOT NULL
      );
      INSERT INTO events VALUES(
        'legacy-event', '2026-07-29T00:00:01.000Z', 'info', 'job', 'legacy-job',
        'legacy-job', NULL, NULL, 'LEGACY_EVENT', '{}'
      );
    `);
    legacy.close();
    const migrated = await SqliteStore.open(databasePath);
    expect(migrated.schemaVersion).toBe(8);
    const event = new EventRepository(migrated).list({ jobId: "legacy-job", ascending: true })[0]!;
    expect(event).toMatchObject({ sequence: 1, monotonicTimestampNs: "1" });
    expect(migrated.all<{ name: string }>("PRAGMA table_info(workers)").map(column => column.name)).toContain("worker_generation");
    migrated.close();
  });

  it("exports old jobs without requiring newly introduced input fields", async () => {
    const fixture = await createFixture();
    expect(fixture.store.schemaVersion).toBe(8);
    const legacyEvent = fixture.events.list({ jobId: fixture.jobId, ascending: true })[0]!;
    expect(legacyEvent.sequence).toBe(1);
    await fixture.service.exportJob(fixture.jobId);
    expect(fixture.exports.get(fixture.jobId)?.status).toBe("EXPORTED");
    fixture.store.close();
  });
});

async function createFixture(status = "PASSED", adapter: "mock" | "ccs" = "ccs") {
  const root = await temporaryRoot();
  const store = await SqliteStore.open(path.join(root, "runtime.sqlite"));
  const boards = new BoardRepository(store);
  const runs = new TestRunRepository(store);
  const sessions = new SessionRepository(store);
  const workers = new WorkerRepository(store);
  const events = new EventRepository(store);
  const artifacts = new ArtifactRepository(store);
  const exports = new ArtifactExportRepository(store);
  const out1 = path.join(root, "cpu1.out");
  const out2 = path.join(root, "cpu2.out");
  const map1 = path.join(root, "cpu1.map");
  const map2 = path.join(root, "cpu2.map");
  await Promise.all([
    writeFile(out1, "cpu1"),
    writeFile(out2, "cpu2"),
    writeFile(map1, "map1"),
    writeFile(map2, "map2")
  ]);
  boards.upsert({ boardId: "board-a", probeSerial: "XDS110-A", device: "F28P65x", ccxmlPath: path.join(root, "board.ccxml"), tags: ["hil"] });
  workers.upsert({
    workerInstanceId: "worker-a",
    boardId: "board-a",
    pid: 123,
    processStartTime: "2026-07-29T00:00:00.000Z",
    daemonInstanceId: "daemon-a",
    workerGeneration: 3,
    status: "READY",
    startedAt: "2026-07-29T00:00:00.000Z",
    ownedDssProcesses: []
  });
  const jobId = "run-artifact-test";
  const startedAt = "2026-07-29T00:00:01.000Z";
  const finishedAt = "2026-07-29T00:00:02.000Z";
  const plan = {
    planVersion: 1 as const,
    name: "artifact-contract-test",
    boardIds: ["board-a"],
    artifacts: { cpu1OutPath: out1, cpu2OutPath: out2, cpu1MapPath: map1, cpu2MapPath: map2 },
    priority: "REGRESSION" as const,
    steps: [{ type: "preflight" as const }],
    retryPolicy: {},
    failurePolicy: { continueHealthyBoards: true, quarantineFailedBoard: true, collectDebugBundle: true },
    recoveryPolicy: "safe_restart_board" as const
  };
  runs.create({
    jobId,
    planName: plan.name,
    planVersion: 1,
    plan,
    status,
    progressCurrent: 1,
    progressTotal: 1,
    submittedAt: startedAt,
    startedAt,
    finishedAt,
    cancelRequested: status === "CANCELLED",
    failurePolicy: plan.failurePolicy,
    resultSummary: { totalBoards: 1, passedBoards: status === "PASSED" ? 1 : 0 }
  }, [{
    jobId,
    boardId: "board-a",
    probeSerial: "XDS110-A",
    status,
    currentStepIndex: 0,
    sessionId: "session-a",
    startedAt,
    finishedAt
  }], [{
    stepRunId: "step-a",
    jobId,
    boardId: "board-a",
    stepIndex: 0,
    stepType: "preflight",
    input: { type: "preflight" },
    status: status === "PASSED" ? "PASSED" : "SKIPPED",
    attempt: 1,
    idempotencyClass: "READ_ONLY",
    startedAt,
    finishedAt,
    output: { success: true }
  }]);
  sessions.upsert({
    sessionId: "session-a",
    boardId: "board-a",
    workerInstanceId: "worker-a",
    sessionName: "explicit-session",
    adapterSessionId: "adapter-session-a",
    coreMap: [{ coreId: 0, coreName: "C28xx_CPU1" }, { coreId: 2, coreName: "C28xx_CPU2" }],
    status: "CLOSED",
    createdAt: startedAt,
    closedAt: finishedAt,
    lastSnapshot: { cores: [{ coreId: 0, coreName: "C28xx_CPU1", state: "SUSPENDED" }, { coreId: 2, coreName: "C28xx_CPU2", state: "SUSPENDED" }] }
  });
  events.append({ level: "info", sourceType: "job", sourceId: jobId, jobId, boardId: "board-a", workerInstanceId: "worker-a", workerGeneration: 3, eventType: "JOB_FINISHED", timestamp: finishedAt, payload: { status } });
  const config = testConfig(adapter);
  const rootDirectory = path.join(root, "artifacts");
  const makeService = (writer?: AtomicArtifactWriter) => new JobArtifactSnapshotService({
    rootDirectory,
    config,
    runs,
    boards,
    sessions,
    workers,
    events,
    artifacts,
    exports,
    writer
  });
  return {
    root,
    store,
    runs,
    events,
    exports,
    jobId,
    jobDirectory: path.join(rootDirectory, jobId),
    service: makeService(),
    makeService
  };
}

function testConfig(adapter: "mock" | "ccs"): C2000McpConfig {
  return {
    toolProfile: "safe",
    adapter,
    ccs: { scriptingMode: adapter, timeouts: {} },
    target: {
      name: "F28P65x",
      coreMap: [
        { coreId: 0, coreName: "C28xx_CPU1" },
        { coreId: 2, coreName: "C28xx_CPU2" }
      ]
    },
    diagnostics: {},
    logging: { level: "info" },
    filesystem: { allowedReadRoots: [], allowedWriteRoots: [] },
    debugProbe: { queueDir: "runtime/debug-probe-queue", queueTimeoutMs: 600000, recoveryPolicy: "owned-and-stale", multiBoardEnabled: false }
  };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "c2000-artifacts-"));
  roots.push(root);
  return root;
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function readJsonLines(filePath: string): Promise<unknown[]> {
  return (await readFile(filePath, "utf8")).trim().split("\n").map(line => JSON.parse(line));
}

async function snapshotBytes(directory: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const file of ["manifest.json", "result.json", "events.jsonl", "target-state.jsonl", "summary.md"]) {
    result[file] = await readFile(path.join(directory, file), "utf8");
  }
  return result;
}
