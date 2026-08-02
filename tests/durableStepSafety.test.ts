import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { BoardRegistry } from "../src/boards/BoardRegistry.js";
import { TestJobEngine } from "../src/jobs/TestJobEngine.js";
import type { JobArtifactSnapshotService } from "../src/artifacts/JobArtifactSnapshotService.js";
import type { C2000ToolInvoker } from "../src/mcp/tools.js";
import { SqliteStore } from "../src/storage/SqliteStore.js";
import { ArtifactRepository } from "../src/storage/repositories/ArtifactRepository.js";
import { BoardRepository } from "../src/storage/repositories/BoardRepository.js";
import { EventRepository } from "../src/storage/repositories/EventRepository.js";
import { LeaseRepository } from "../src/storage/repositories/LeaseRepository.js";
import { TestRunRepository } from "../src/storage/repositories/TestRunRepository.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe("durable step cleanup and output safety", () => {
  test("retries structured cleanup failure in finally before releasing the lease", async () => {
    let closeCalls = 0;
    const fixture = await createFixture({
      async invokeTool(toolName) {
        if (toolName === "c2000_launchMulticoreDebug") return { success: true, sessionId: "dbg-current" };
        if (toolName === "c2000_closeDebugSession") {
          closeCalls += 1;
          return closeCalls === 1 ? { success: false, sessionId: "dbg-current" } : { success: true, sessionId: "dbg-current", closed: true };
        }
        throw new Error(`unexpected tool ${toolName}`);
      }
    });
    const jobId = String(fixture.engine.submit(planWithCleanup()).jobId);
    const terminal = await waitForTerminal(fixture.runs, jobId);
    expect(terminal.status).toBe("FAILED");
    expect(closeCalls).toBe(2);
    expect(fixture.registry.leases.active("board-a")).toBeUndefined();
    expect(fixture.registry.get("board-a").status).not.toBe("QUARANTINED");
    await fixture.engine.stop();
    fixture.store.close();
  });

  test("quarantines ownership-uncertain board when explicit and finally cleanup both fail", async () => {
    let closeCalls = 0;
    const fixture = await createFixture({
      async invokeTool(toolName) {
        if (toolName === "c2000_launchMulticoreDebug") return { success: true, sessionId: "dbg-current" };
        if (toolName === "c2000_closeDebugSession") {
          closeCalls += 1;
          return { success: false, sessionId: "dbg-current", error: { code: "WorkerUnavailable" } };
        }
        throw new Error(`unexpected tool ${toolName}`);
      }
    });
    const jobId = String(fixture.engine.submit(planWithCleanup()).jobId);
    const terminal = await waitForTerminal(fixture.runs, jobId);
    expect(terminal.status).toBe("FAILED");
    expect(closeCalls).toBe(2);
    expect(fixture.registry.get("board-a")).toEqual(expect.objectContaining({ status: "QUARANTINED", lastError: expect.objectContaining({ code: "JobSessionCleanupFailed", sessionId: "dbg-current" }) }));
    expect(fixture.registry.leases.active("board-a")).toBeUndefined();
    expect(fixture.events.list({ jobId })).toEqual(expect.arrayContaining([expect.objectContaining({ eventType: "JOB_SESSION_CLEANUP_FAILED" })]));
    await fixture.engine.stop();
    fixture.store.close();
  });

  test("fails closed before persisting an oversized runtime expression result", async () => {
    const fixture = await createFixture({
      async invokeTool(toolName) {
        if (toolName === "c2000_launchMulticoreDebug") return { success: true, sessionId: "dbg-current" };
        if (toolName === "c2000_evaluateMany") return { success: true, results: [{ success: true, value: "x".repeat(2 * 1024 * 1024) }] };
        if (toolName === "c2000_closeDebugSession") return { success: true, sessionId: "dbg-current", closed: true };
        throw new Error(`unexpected tool ${toolName}`);
      }
    });
    const jobId = String(fixture.engine.submit({
      planVersion: 1, name: "bounded-output", boardIds: ["board-a"],
      steps: [{ type: "launchMulticore", loadPrograms: false }, { type: "captureExpressions", reads: [{ coreId: 0, expressions: ["g_x"] }] }]
    }).jobId);
    const terminal = await waitForTerminal(fixture.runs, jobId);
    expect(terminal.status).toBe("FAILED");
    expect(fixture.runs.steps(jobId)[1]).toEqual(expect.objectContaining({ status: "FAILED", error: expect.objectContaining({ code: "EvidenceLimitExceeded" }) }));
    expect(fixture.registry.leases.active("board-a")).toBeUndefined();
    await fixture.engine.stop();
    fixture.store.close();
  });

  test("enforces the aggregate evidence budget across all boards in one job", async () => {
    const largeValue = "x".repeat(1_500_000);
    const fixture = await createFixture({
      async invokeTool(toolName) {
        if (toolName === "c2000_launchMulticoreDebug") return { success: true, sessionId: "dbg-current" };
        if (toolName === "c2000_evaluateMany") return { success: true, results: [{ success: true, value: largeValue }] };
        if (toolName === "c2000_closeDebugSession") return { success: true, sessionId: "dbg-current", closed: true };
        throw new Error(`unexpected tool ${toolName}`);
      }
    }, ["board-a", "board-b"]);
    const jobId = String(fixture.engine.submit({
      planVersion: 1,
      name: "cross-board-evidence-budget",
      boardIds: ["board-a", "board-b"],
      parallelism: 2,
      failurePolicy: { continueHealthyBoards: false, quarantineFailedBoard: false, collectDebugBundle: false },
      steps: [
        { type: "launchMulticore", loadPrograms: false },
        ...Array.from({ length: 3 }, (_, index) => ({ type: "captureExpressions", label: `capture-${index}`, reads: [{ coreId: 0, expressions: ["g_x"] }] }))
      ]
    }).jobId);
    const terminal = await waitForTerminal(fixture.runs, jobId);
    expect(terminal.status).toBe("FAILED");
    expect(fixture.runs.steps(jobId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "FAILED", error: expect.objectContaining({ code: "EvidenceLimitExceeded" }) })
    ]));
    await fixture.engine.stop();
    fixture.store.close();
  });

  test("allows a legal near-limit multi-board job to finish and export terminal evidence", async () => {
    const largeValue = "x".repeat(1_300_000);
    const exported: string[] = [];
    const fixture = await createFixture({
      async invokeTool(toolName) {
        if (toolName === "c2000_launchMulticoreDebug") return { success: true, sessionId: "dbg-current" };
        if (toolName === "c2000_evaluateMany") return { success: true, results: [{ success: true, value: largeValue }] };
        if (toolName === "c2000_closeDebugSession") return { success: true, sessionId: "dbg-current", closed: true };
        throw new Error(`unexpected tool ${toolName}`);
      }
    }, ["board-a", "board-b"], {
      async exportJob(jobId: string) {
        exported.push(jobId);
        return `/artifacts/${jobId}`;
      }
    } as JobArtifactSnapshotService);
    const jobId = String(fixture.engine.submit({
      planVersion: 1,
      name: "legal-cross-board-evidence-budget",
      boardIds: ["board-a", "board-b"],
      parallelism: 2,
      steps: [
        { type: "launchMulticore", loadPrograms: false },
        ...Array.from({ length: 3 }, (_, index) => ({ type: "captureExpressions", label: `capture-${index}`, reads: [{ coreId: 0, expressions: ["g_x"] }] }))
      ]
    }).jobId);
    const terminal = await waitForTerminal(fixture.runs, jobId);
    expect(terminal.status).toBe("PASSED");
    expect(exported).toEqual([jobId]);
    await fixture.engine.stop();
    fixture.store.close();
  });

  test("starts healthy persisted work while isolating an unmigratable legacy run", async () => {
    const fixture = await createFixture({
      async invokeTool(toolName) {
        throw new Error(`unexpected tool ${toolName}`);
      }
    });
    persistQueuedRun(fixture, "run-bad-legacy", {
      planVersion: 1,
      name: "bad-legacy",
      boardIds: ["board-a"],
      steps: [{ type: "unknown-legacy-step", passthrough: true }]
    });
    persistQueuedRun(fixture, "run-healthy", {
      planVersion: 1,
      name: "healthy",
      boardIds: ["board-a"],
      steps: [{ type: "delay", delayMs: 0 }]
    });

    fixture.engine.start();
    const bad = await waitForTerminal(fixture.runs, "run-bad-legacy");
    const healthy = await waitForTerminal(fixture.runs, "run-healthy");
    expect(bad).toEqual(expect.objectContaining({
      status: "NEEDS_MANUAL_INTERVENTION",
      error: expect.objectContaining({ code: "PersistedPlanMigrationFailed" })
    }));
    expect(healthy.status).toBe("PASSED");
    await fixture.engine.stop();
    fixture.store.close();
  });
});

function planWithCleanup() {
  return { planVersion: 1, name: "cleanup-state", boardIds: ["board-a"], steps: [{ type: "launchMulticore", loadPrograms: false }, { type: "cleanup" }] };
}

async function createFixture(tools: C2000ToolInvoker, boardIds = ["board-a"], artifactSnapshots?: JobArtifactSnapshotService) {
  const root = await mkdtemp(path.join(os.tmpdir(), "c2000-durable-safety-"));
  roots.push(root);
  const store = await SqliteStore.open(path.join(root, "runtime.sqlite"));
  const events = new EventRepository(store);
  const registry = new BoardRegistry(new BoardRepository(store), events, store, new LeaseRepository(store));
  for (const [index, boardId] of boardIds.entries()) {
    registry.register({ boardId, probeSerial: `XDS-${index}`, device: "F28P65x", ccxmlPath: `${boardId}.ccxml`, tags: [] });
    registry.setWorker(boardId, `worker-${index}`);
  }
  const runs = new TestRunRepository(store);
  const engine = new TestJobEngine({ registry, runs, events, artifacts: new ArtifactRepository(store), tools, maxParallelBoards: boardIds.length, artifactSnapshots });
  return { root, store, events, registry, runs, engine };
}

function persistQueuedRun(fixture: Awaited<ReturnType<typeof createFixture>>, jobId: string, plan: Record<string, unknown>): void {
  const steps = plan.steps as Array<Record<string, unknown>>;
  const failurePolicy = { continueHealthyBoards: true, quarantineFailedBoard: true, collectDebugBundle: false };
  fixture.runs.create({
    jobId,
    planName: String(plan.name),
    planVersion: 1,
    plan,
    status: "QUEUED",
    progressCurrent: 0,
    progressTotal: steps.length,
    submittedAt: new Date().toISOString(),
    cancelRequested: false,
    failurePolicy
  }, [{
    jobId,
    boardId: "board-a",
    probeSerial: "XDS-0",
    status: "QUEUED",
    currentStepIndex: 0
  }], steps.map((step, stepIndex) => ({
    stepRunId: `${jobId}-step-${stepIndex}`,
    jobId,
    boardId: "board-a",
    stepIndex,
    stepType: String(step.type),
    input: step,
    status: "PENDING",
    attempt: 0,
    idempotencyClass: "READ_ONLY" as const
  })));
}

async function waitForTerminal(runs: TestRunRepository, jobId: string) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const run = runs.get(jobId);
    if (run && ["PASSED", "FAILED", "PARTIAL", "CANCELLED", "NEEDS_MANUAL_INTERVENTION"].includes(run.status)) return run;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for durable job");
}
