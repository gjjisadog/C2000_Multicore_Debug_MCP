import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AtomicArtifactWriter } from "../src/artifacts/AtomicArtifactWriter.js";
import { FailureBundleService } from "../src/observability/FailureBundleService.js";
import { TraceService } from "../src/observability/TraceService.js";
import { traceDocumentSchema, type ExportTraceInput } from "../src/observability/TraceSchemas.js";
import { SqliteStore } from "../src/storage/SqliteStore.js";
import { ArtifactExportRepository } from "../src/storage/repositories/ArtifactExportRepository.js";
import { ArtifactRepository } from "../src/storage/repositories/ArtifactRepository.js";
import { BoardRepository } from "../src/storage/repositories/BoardRepository.js";
import { CanTestResultRepository } from "../src/storage/repositories/CanTestResultRepository.js";
import { EventRepository } from "../src/storage/repositories/EventRepository.js";
import { SessionRepository } from "../src/storage/repositories/SessionRepository.js";
import { TestRunRepository } from "../src/storage/repositories/TestRunRepository.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));

describe("Perfetto trace export", () => {
  it("generates a trace from SQLite", async () => {
    const fixture = await createFixture();
    const trace = await fixture.trace.build(defaultInput(fixture.jobId, "sqlite"));
    expect(trace.generatedFrom).toContain("sqlite");
    expect(trace.traceEvents.some(event => event.name === "JOB_FINISHED")).toBe(true);
    fixture.store.close();
  });

  it("regenerates a trace from completed artifacts without a SQLite job", async () => {
    const fixture = await createFixture();
    const offlineRoot = await temporaryRoot();
    const directory = path.join(offlineRoot, fixture.jobId);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "manifest.json"), "{}\n");
    await writeFile(path.join(directory, "events.jsonl"), `${JSON.stringify({
      schemaVersion: 1, sequence: 1, jobId: fixture.jobId, eventType: "OFFLINE_EVENT",
      timestamp: "2026-07-29T00:00:00.000Z", monotonicTimestampNs: "1000",
      source: { type: "job", id: fixture.jobId }, payload: {}
    })}\n`);
    const emptyStore = await SqliteStore.open(path.join(offlineRoot, "empty.sqlite"));
    const offline = makeTrace(emptyStore, offlineRoot);
    const trace = await offline.build(defaultInput(fixture.jobId, "artifacts"));
    expect(trace.generatedFrom).toEqual(["artifacts"]);
    expect(trace.traceEvents.some(event => event.name === "OFFLINE_EVENT")).toBe(true);
    emptyStore.close();
    fixture.store.close();
  });

  it("orders host events by monotonic timestamp", async () => {
    const fixture = await createFixture();
    fixture.events.append(event(fixture.jobId, "LATE", "3000"));
    fixture.events.append(event(fixture.jobId, "EARLY", "2000"));
    const trace = await fixture.trace.build(defaultInput(fixture.jobId, "sqlite"));
    const host = trace.traceEvents.filter(item => ["JOB_FINISHED", "EARLY", "LATE"].includes(item.name));
    expect(host.map(item => item.ts)).toEqual([...host.map(item => item.ts)].sort((a, b) => a - b));
    fixture.store.close();
  });

  it("includes board-scoped worker failures that have no jobId when they occur inside the job window", async () => {
    const fixture = await createFixture();
    fixture.events.append({
      level: "error",
      sourceType: "worker",
      sourceId: "worker-a",
      boardId: "board-a",
      timestamp: "2026-07-29T00:00:00.500Z",
      monotonicTimestampNs: "2500",
      eventType: "WORKER_CRASHED",
      payload: { workerGeneration: 4 }
    });
    const trace = await fixture.trace.build(defaultInput(fixture.jobId, "sqlite"));
    expect(trace.traceEvents.find(item => item.name === "WORKER_CRASHED")?.cat).toBe("board-worker");
    fixture.store.close();
  });

  it("declares independent time domains without false synchronization", async () => {
    const fixture = await createFixture();
    const trace = await fixture.trace.build(defaultInput(fixture.jobId));
    expect(trace.timeDomains.filter(domain => domain.id !== "host-monotonic").every(domain => !domain.synchronizedToHost)).toBe(true);
    expect(trace.primaryTimeDomain).toBe("host-monotonic");
    fixture.store.close();
  });

  it("places MCU samples on a sample-index track", async () => {
    const fixture = await createFixture();
    await fixture.write("variables.jsonl", `${JSON.stringify({ sequence: 7, timestamp: "2026-07-29T00:00:00.000Z", monotonicTimestampNs: "7000", targetSampleTime: null, variables: { x: { status: "OK", value: 1 } } })}\n`);
    const trace = await fixture.trace.build(defaultInput(fixture.jobId, "artifacts"));
    const sample = trace.traceEvents.find(item => item.cat === "variables")!;
    expect(sample.ts).toBe(7);
    expect(sample.args.timeDomain).toBe("mcu-sample-index");
    fixture.store.close();
  });

  it("places ERAD measurements on an unsynchronized cycle track", async () => {
    const fixture = await createFixture();
    await fixture.write("erad.json", JSON.stringify({ profileName: "isr", minCycles: 20, maxCycles: 80, completeness: "COMPLETE" }));
    const trace = await fixture.trace.build(defaultInput(fixture.jobId, "artifacts"));
    expect(trace.traceEvents.find(item => item.cat === "erad")).toMatchObject({ ts: 0, dur: 80 });
    fixture.store.close();
  });

  it("keeps all three CAN evidence stages on separate tracks", async () => {
    const fixture = await createFixture();
    for (const [phase, stage] of [["tx", "firmware-tx"], ["bus", "pcan-bus"], ["rx", "firmware-rx"]] as const) {
      fixture.can.add({ jobId: fixture.jobId, groupId: "g", phase, status: "INFO", details: { stage, sequence: 1 } });
    }
    const trace = await fixture.trace.build(defaultInput(fixture.jobId, "sqlite"));
    expect(new Set(trace.traceEvents.filter(item => item.name.startsWith("CAN ")).map(item => item.cat))).toEqual(new Set(["firmware-can-tx", "pcan-bus", "firmware-can-rx"]));
    fixture.store.close();
  });

  it("reports requested but missing sources", async () => {
    const fixture = await createFixture();
    const trace = await fixture.trace.build(defaultInput(fixture.jobId));
    expect(trace.missingSources).toEqual(expect.arrayContaining(["variables", "erad", "dlog"]));
    fixture.store.close();
  });

  it("marks a truncated JSONL artifact incomplete and ignores its partial line", async () => {
    const fixture = await createFixture();
    await fixture.write("variables.jsonl", `${JSON.stringify({ sequence: 1, variables: {} })}\n{"sequence":`);
    const trace = await fixture.trace.build(defaultInput(fixture.jobId, "artifacts"));
    expect(trace.incompleteSources).toContain("variables.jsonl");
    expect(trace.traceEvents.filter(item => item.cat === "variables")).toHaveLength(1);
    fixture.store.close();
  });

  it("propagates an incomplete source manifest without changing the job result", async () => {
    const fixture = await createFixture();
    await fixture.write("manifest.json", JSON.stringify({
      schemaVersion: 1,
      jobId: fixture.jobId,
      completeness: { status: "INCOMPLETE", reason: "JOB_CANCELLED" }
    }));
    const trace = await fixture.trace.build(defaultInput(fixture.jobId, "artifacts"));
    expect(trace.incompleteSources).toContain("manifest.json");
    expect(trace.completeness).toBe("INCOMPLETE");
    expect(fixture.runs.get(fixture.jobId)?.status).toBe("FAILED");
    fixture.store.close();
  });

  it("exports byte-idempotently and updates the manifest", async () => {
    const fixture = await createFixture();
    await fixture.trace.export(defaultInput(fixture.jobId, "sqlite"));
    const first = await readFile(path.join(fixture.directory, "trace.json"), "utf8");
    await fixture.trace.export(defaultInput(fixture.jobId, "sqlite"));
    expect(await readFile(path.join(fixture.directory, "trace.json"), "utf8")).toBe(first);
    expect(JSON.parse(await readFile(path.join(fixture.directory, "manifest.json"), "utf8")).generatedFiles).toHaveLength(1);
    fixture.store.close();
  });

  it("does not change the job result when trace export fails", async () => {
    const fixture = await createFixture();
    class FailingWriter extends AtomicArtifactWriter {
      override async writeJson(): Promise<void> { throw new Error("trace write failed"); }
    }
    const trace = makeTrace(fixture.store, fixture.root, new FailingWriter());
    await expect(trace.export(defaultInput(fixture.jobId))).rejects.toThrow("trace write failed");
    expect(fixture.runs.get(fixture.jobId)?.status).toBe("FAILED");
    fixture.store.close();
  });

  it("validates the emitted trace schema", async () => {
    const fixture = await createFixture();
    expect(traceDocumentSchema.parse(await fixture.trace.build(defaultInput(fixture.jobId))).schemaVersion).toBe(1);
    fixture.store.close();
  });
});

describe("automatic failure context bundle", () => {
  it("continues when optional collectors have no data", async () => {
    const fixture = await createFixture();
    const result = await fixture.bundles.collect({ jobId: fixture.jobId });
    expect(result.completeness).toBe("INCOMPLETE");
    expect(result.items).toEqual(expect.arrayContaining([expect.objectContaining({ name: "variables", status: "MISSING" })]));
    fixture.store.close();
  });

  it("preserves host evidence when the session is disconnected", async () => {
    const fixture = await createFixture(false);
    const result = await fixture.bundles.collect({ jobId: fixture.jobId });
    expect(result.targetAccessAttempted).toBe(false);
    expect(await readFile(path.join(fixture.directory, "failure-bundle", "recent-events.jsonl"), "utf8")).toContain("JOB_FINISHED");
    fixture.store.close();
  });

  it("uses persisted live pre-cleanup launch evidence after the session is closed", async () => {
    const fixture = await createFixture(false);
    const step = fixture.runs.steps(fixture.jobId)[0]!;
    fixture.store.run("UPDATE test_steps SET step_type = ?, input_json = ? WHERE step_run_id = ?", [
      "launchMulticore",
      JSON.stringify({ type: "launchMulticore", startupPreset: "hybrid30k-dk9-owner-first" }),
      step.stepRunId
    ]);
    fixture.runs.updateStep({
      ...step,
      output: {
        success: false,
        sessionId: "session-a",
        cleanedUp: true,
        preCleanupDiagnostics: {
          schemaVersion: 1,
          provenance: { captureSource: "live-pre-cleanup-session", capturedBeforeSessionClose: true, targetReadsOnly: true },
          targetState: [{ name: "target-state:0", status: "COLLECTED" }]
        }
      }
    });

    const result = await fixture.bundles.collect({ jobId: fixture.jobId });
    expect(result.items).toEqual(expect.arrayContaining([expect.objectContaining({ name: "pre-cleanup-launch-diagnostics", status: "COLLECTED" })]));
    const diagnostics = JSON.parse(await readFile(path.join(fixture.directory, "failure-bundle", "pre-cleanup-launch-diagnostics.json"))) as Record<string, any>;
    const sessionState = JSON.parse(await readFile(path.join(fixture.directory, "failure-bundle", "session-state.json"))) as Record<string, any>;
    const targetState = JSON.parse(await readFile(path.join(fixture.directory, "failure-bundle", "target-state.json"))) as Record<string, any>;
    expect(diagnostics).toEqual(expect.objectContaining({ provenance: expect.objectContaining({ collectorTargetAccessed: false }) }));
    expect(sessionState).toEqual(expect.objectContaining({
      available: true,
      provenance: "live-pre-cleanup-capture",
      closedSessionFallback: expect.objectContaining({ schemaVersion: 1 })
    }));
    expect(targetState).toEqual(expect.objectContaining({
      available: true,
      provenance: "live-pre-cleanup-capture",
      closedSessionFallback: expect.objectContaining({ schemaVersion: 1 })
    }));
    fixture.store.close();
  });

  it("retains worker crash evidence", async () => {
    const fixture = await createFixture();
    fixture.events.append({
      level: "error",
      sourceType: "worker",
      sourceId: "worker-a",
      boardId: "board-a",
      timestamp: "2026-07-29T00:00:00.500Z",
      monotonicTimestampNs: "9000",
      eventType: "WORKER_CRASHED",
      payload: {}
    });
    await fixture.bundles.collect({ jobId: fixture.jobId });
    expect(await readFile(path.join(fixture.directory, "failure-bundle", "recent-events.jsonl"), "utf8")).toContain("WORKER_CRASHED");
    fixture.store.close();
  });

  it("records cancellation without corrupting already collected items", async () => {
    const fixture = await createFixture();
    const controller = new AbortController();
    controller.abort(new DOMException("cancel", "AbortError"));
    const result = await fixture.bundles.collect({ jobId: fixture.jobId }, controller.signal);
    expect(result.items).toEqual(expect.arrayContaining([expect.objectContaining({ status: "CANCELLED" })]));
    expect(fixture.runs.get(fixture.jobId)?.status).toBe("FAILED");
    fixture.store.close();
  });

  it("filters tokens and home paths from bundle evidence", async () => {
    const fixture = await createFixture();
    fixture.events.append({ ...event(fixture.jobId, "SECRET", "9000"), payload: { daemonRpcToken: "never-export", githubToken: "never-either", useful: os.homedir() } });
    await fixture.bundles.collect({ jobId: fixture.jobId });
    const text = await readFile(path.join(fixture.directory, "failure-bundle", "recent-events.jsonl"), "utf8");
    expect(text).not.toContain("never-export");
    expect(text).not.toContain("never-either");
    expect(text).toContain("<home>");
    fixture.store.close();
  });

  it("keeps Mock evidence classified as Mock", async () => {
    const fixture = await createFixture();
    fixture.can.add({ jobId: fixture.jobId, groupId: "g", phase: "bus", status: "INFO", details: { evidenceClassification: "MOCK" } });
    await fixture.bundles.collect({ jobId: fixture.jobId });
    const text = await readFile(path.join(fixture.directory, "failure-bundle", "can-evidence.json"), "utf8");
    expect(text).toContain("\"MOCK\"");
    expect(text).not.toContain("HARDWARE_BUS");
    fixture.store.close();
  });
});

async function createFixture(withSession = true) {
  const root = await temporaryRoot();
  const store = await SqliteStore.open(path.join(root, "runtime.sqlite"));
  const runs = new TestRunRepository(store);
  const sessions = new SessionRepository(store);
  const events = new EventRepository(store);
  const artifacts = new ArtifactRepository(store);
  const exports = new ArtifactExportRepository(store);
  const can = new CanTestResultRepository(store);
  const jobId = "run-trace-test";
  const directory = path.join(root, jobId);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "manifest.json"), `${JSON.stringify({ schemaVersion: 1, jobId })}\n`);
  new BoardRepository(store).upsert({
    boardId: "board-a",
    probeSerial: "XDS-A",
    device: "F28P65x",
    ccxmlPath: path.join(root, "board.ccxml"),
    tags: []
  });
  runs.create({
    jobId, planName: "trace-test", planVersion: 1, plan: {}, status: "FAILED", progressCurrent: 1, progressTotal: 1,
    submittedAt: "2026-07-29T00:00:00.000Z", startedAt: "2026-07-29T00:00:00.000Z", finishedAt: "2026-07-29T00:00:01.000Z",
    cancelRequested: false, failurePolicy: {}, error: { code: "DssTimeout", message: "timeout" }
  }, [{ jobId, boardId: "board-a", probeSerial: "XDS-A", status: "FAILED", currentStepIndex: 0, ...(withSession ? { sessionId: "session-a" } : {}) }], [{
    stepRunId: "step-a", jobId, boardId: "board-a", stepIndex: 0, stepType: "preflight", input: {}, status: "FAILED", attempt: 1, idempotencyClass: "READ_ONLY"
  }]);
  store.run(
    "INSERT INTO board_groups(group_id, group_type, name, status, metadata_json, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?)",
    ["g", "CAN_PAIR", "trace-test", "COMPLETED", "{}", "2026-07-29T00:00:00.000Z", "2026-07-29T00:00:01.000Z"]
  );
  if (withSession) sessions.upsert({
    sessionId: "session-a", boardId: "board-a", sessionName: "explicit", adapterSessionId: "adapter-a",
    coreMap: [{ coreId: 0, coreName: "C28xx_CPU1" }, { coreId: 2, coreName: "C28xx_CPU2" }],
    status: "CLOSED", createdAt: "2026-07-29T00:00:00.000Z", closedAt: "2026-07-29T00:00:01.000Z",
    lastSnapshot: { cores: [{ coreId: 0, coreName: "C28xx_CPU1", state: "SUSPENDED" }] }
  });
  events.append(event(jobId, "JOB_FINISHED", "1000"));
  exports.upsert({ jobId, rootPath: directory, schemaVersion: 1, status: "EXPORTED", completeness: "COMPLETE", updatedAt: "2026-07-29T00:00:01.000Z" });
  const trace = new TraceService({ rootDirectory: root, runs, events, artifacts, exports, canResults: can });
  const bundles = new FailureBundleService({ rootDirectory: root, runs, sessions, events, artifacts, exports, canResults: can, trace });
  return {
    root, store, runs, events, can, jobId, directory, trace, bundles,
    write: async (name: string, content: string) => writeFile(path.join(directory, name), content)
  };
}

function makeTrace(store: SqliteStore, rootDirectory: string, writer?: AtomicArtifactWriter): TraceService {
  return new TraceService({
    rootDirectory,
    runs: new TestRunRepository(store),
    events: new EventRepository(store),
    artifacts: new ArtifactRepository(store),
    exports: new ArtifactExportRepository(store),
    canResults: new CanTestResultRepository(store),
    writer
  });
}

function defaultInput(jobId: string, source: "auto" | "sqlite" | "artifacts" = "auto"): ExportTraceInput {
  return {
    jobId,
    include: ["job-events", "lease-events", "worker-events", "dss-events", "target-state", "can-evidence", "variables", "erad", "dlog"],
    format: "perfetto" as const,
    source
  };
}

function event(jobId: string, eventType: string, monotonicTimestampNs: string) {
  return {
    level: "info" as const, sourceType: "job", sourceId: jobId, jobId,
    timestamp: "2026-07-29T00:00:01.000Z", monotonicTimestampNs, eventType, payload: {}
  };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "c2000-trace-"));
  roots.push(root);
  return root;
}
