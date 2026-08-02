import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { BoardRegistry } from "../src/boards/BoardRegistry.js";
import { TestJobEngine } from "../src/jobs/TestJobEngine.js";
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
});

function planWithCleanup() {
  return { planVersion: 1, name: "cleanup-state", boardIds: ["board-a"], steps: [{ type: "launchMulticore", loadPrograms: false }, { type: "cleanup" }] };
}

async function createFixture(tools: C2000ToolInvoker) {
  const root = await mkdtemp(path.join(os.tmpdir(), "c2000-durable-safety-"));
  roots.push(root);
  const store = await SqliteStore.open(path.join(root, "runtime.sqlite"));
  const events = new EventRepository(store);
  const registry = new BoardRegistry(new BoardRepository(store), events, store, new LeaseRepository(store));
  registry.register({ boardId: "board-a", probeSerial: "XDS-A", device: "F28P65x", ccxmlPath: "board-a.ccxml", tags: [] });
  registry.setWorker("board-a", "worker-a");
  const runs = new TestRunRepository(store);
  const engine = new TestJobEngine({ registry, runs, events, artifacts: new ArtifactRepository(store), tools, maxParallelBoards: 1 });
  return { root, store, events, registry, runs, engine };
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
