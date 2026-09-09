import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { C2000McpConfig } from "../src/config/config.schema.js";
import { DebugDaemon } from "../src/daemon/DebugDaemon.js";
import { discoverDaemon } from "../src/proxy/DaemonDiscovery.js";
import { McpDaemonClient } from "../src/proxy/McpDaemonClient.js";
import { SqliteStore } from "../src/storage/SqliteStore.js";
import { SessionRepository } from "../src/storage/repositories/SessionRepository.js";
import { LeaseRepository } from "../src/storage/repositories/LeaseRepository.js";
import { TestRunRepository, type TestRunBoardRecord, type TestRunRecord, type TestStepRecord } from "../src/storage/repositories/TestRunRepository.js";
import { BoardRepository } from "../src/storage/repositories/BoardRepository.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe("durable background test jobs", () => {
  test("restarts a board flow with fresh logical attempts while retaining prior attempt evidence", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "c2000-job-attempt-recovery-"));
    directories.push(directory);
    const store = await SqliteStore.open(path.join(directory, "state.sqlite"));
    const runs = new TestRunRepository(store);
    new BoardRepository(store).upsert({ boardId: "board-a", probeSerial: "A", device: "F28P65x", ccxmlPath: "board-a.ccxml", tags: [] });
    const jobId = "run-attempt-recovery";
    const run: TestRunRecord = {
      jobId, planName: "attempt-recovery", planVersion: 1, plan: { steps: [{ type: "delay", delayMs: 1 }] },
      status: "RECOVERING", progressCurrent: 0, progressTotal: 1, submittedAt: new Date().toISOString(), cancelRequested: false, failurePolicy: {}
    };
    const board: TestRunBoardRecord = { jobId, boardId: "board-a", probeSerial: "A", status: "RUNNING", currentStepIndex: 0 };
    const step: TestStepRecord = { stepRunId: "step-attempt-recovery", jobId, boardId: "board-a", stepIndex: 0, stepType: "delay", input: { type: "delay", delayMs: 1 }, status: "PENDING", attempt: 0, idempotencyClass: "READ_ONLY" };
    runs.create(run, [board], [step]);
    const first = runs.steps(jobId)[0]!;
    runs.addStepAttempt({ step: first, attemptIndex: 1, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), status: "FAILED", retryDecision: { retry: false }, backoffMs: 0 });
    runs.updateStep({ ...first, status: "FAILED", attempt: 1, finishedAt: new Date().toISOString(), error: { code: "SessionNotFound" } });

    runs.resetForBoardFlowRestart(jobId);
    const restarted = runs.steps(jobId)[0]!;
    expect(restarted).toEqual(expect.objectContaining({ status: "PENDING", attempt: 0 }));
    expect(() => runs.addStepAttempt({ step: restarted, attemptIndex: 1, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), status: "PASSED", retryDecision: { retry: false }, backoffMs: 0 })).not.toThrow();
    expect(runs.stepAttempts(jobId).map(attempt => attempt.attemptIndex)).toEqual([1, 2]);
    store.close();
  });

  test("fences a stale daemon execution before it can persist recovery results", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "c2000-job-execution-fence-"));
    directories.push(directory);
    const store = await SqliteStore.open(path.join(directory, "state.sqlite"));
    const runs = new TestRunRepository(store);
    new BoardRepository(store).upsert({ boardId: "board-a", probeSerial: "A", device: "F28P65x", ccxmlPath: "board-a.ccxml", tags: [] });
    const jobId = "run-execution-fence";
    runs.create(
      { jobId, planName: "execution-fence", planVersion: 1, plan: { steps: [{ type: "delay", delayMs: 1 }] }, status: "QUEUED", progressCurrent: 0, progressTotal: 1, submittedAt: new Date().toISOString(), cancelRequested: false, failurePolicy: {} },
      [{ jobId, boardId: "board-a", probeSerial: "A", status: "QUEUED", currentStepIndex: 0 }],
      [{ stepRunId: "step-execution-fence", jobId, boardId: "board-a", stepIndex: 0, stepType: "delay", input: { type: "delay", delayMs: 1 }, status: "PENDING", attempt: 0, idempotencyClass: "READ_ONLY" }]
    );

    expect(runs.claimExecution(jobId, "exec-old")).toBe(true);
    expect(runs.markRecovering()).toEqual([jobId]);
    expect(runs.resetForBoardFlowRestart(jobId)).toBe(true);
    expect(runs.claimExecution(jobId, "exec-new")).toBe(true);

    const staleStep = runs.steps(jobId)[0]!;
    expect(() => runs.addStepAttempt({
      step: staleStep,
      attemptIndex: 1,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      status: "FAILED",
      retryDecision: { retry: false },
      backoffMs: 0,
      executionId: "exec-old"
    })).toThrow("no longer owns");
    expect(() => runs.updateStep({ ...staleStep, status: "FAILED", attempt: 1 }, "exec-old")).toThrow("no longer owns");
    expect(() => runs.updateBoard({ ...runs.boards(jobId)[0]!, status: "FAILED" }, "exec-old")).toThrow("no longer owns");
    expect(() => runs.updateStatus(jobId, "FAILED", {}, "exec-old")).toThrow("no longer owns");

    expect(runs.addStepAttempt({
      step: staleStep,
      attemptIndex: 1,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      status: "PASSED",
      retryDecision: { retry: false },
      backoffMs: 0,
      executionId: "exec-new"
    })).toBe(1);
    expect(runs.stepAttempts(jobId)).toHaveLength(1);
    store.close();
  });

  test("closes the current job session before releasing its board lease even without an explicit cleanup step", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "c2000-job-cleanup-"));
    directories.push(directory);
    const config = configFor(directory);
    const daemon = new DebugDaemon(config);
    try {
      await daemon.start();
      const client = new McpDaemonClient((await discoverDaemon(config)).client);
      const submitted = await client.invokeTool("c2000_submitTestPlan", {
        plan: {
          planVersion: 1,
          name: "implicit-finally-cleanup",
          boardIds: ["board-a"],
          steps: [{ type: "launchMulticore", loadPrograms: false }],
          failurePolicy: { continueHealthyBoards: false, quarantineFailedBoard: true, collectDebugBundle: false }
        }
      });
      const completed = await waitFor(async () => {
        const run = await client.invokeTool("c2000_getTestRun", { jobId: String(submitted.jobId), includeSteps: true });
        return run.status === "PASSED" ? run : undefined;
      });
      expect((completed.boards as Array<Record<string, unknown>>)[0]!.sessionId).toBeUndefined();
      await client.close();
    } finally {
      await daemon.stop();
    }

    const store = await SqliteStore.open(config.storage!.sqlitePath);
    expect(new SessionRepository(store).listByBoard("board-a")).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionId: expect.stringMatching(/^dbg-/), status: "CLOSED", closedAt: expect.any(String) })
    ]));
    expect(new LeaseRepository(store).activeForBoard("board-a")).toBeUndefined();
    store.close();
  });

  test("a submitted job continues after proxy client close and is readable through the same jobId", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "c2000-job-test-"));
    directories.push(directory);
    const config = configFor(directory);
    const daemon = new DebugDaemon(config);
    try {
      await daemon.start();
      const first = new McpDaemonClient((await discoverDaemon(config)).client);
      const submitted = await first.invokeTool("c2000_submitTestPlan", {
        plan: {
          planVersion: 1,
          name: "proxy-independent-delay",
          boardIds: ["board-a"],
          steps: [{ type: "delay", delayMs: 150 }, { type: "cleanup" }],
          failurePolicy: { continueHealthyBoards: true, quarantineFailedBoard: true, collectDebugBundle: false },
          recoveryPolicy: "safe_restart_board"
        }
      });
      expect(submitted).toEqual(expect.objectContaining({ success: true, status: "QUEUED", jobId: expect.stringMatching(/^run-/) }));
      const jobId = String(submitted.jobId);
      await first.close();

      const second = new McpDaemonClient((await discoverDaemon(config)).client);
      const waited = await second.invokeTool("c2000_getTestRun", { jobId, includeSteps: true, waitForTerminalMs: 1_000 });
      expect(waited).toEqual(expect.objectContaining({
        status: "PASSED",
        wait: expect.objectContaining({ requestedMs: 1_000, terminal: true, timedOut: false })
      }));
      const completed = await second.invokeTool("c2000_getTestRun", { jobId, includeSteps: true, includeEvents: true });
      expect(completed).toEqual(expect.objectContaining({
        success: true,
        jobId,
        status: "PASSED",
        progress: { current: 2, total: 2 },
        boards: [expect.objectContaining({ boardId: "board-a", status: "PASSED" })],
        steps: [expect.objectContaining({ status: "PASSED" }), expect.objectContaining({ status: "PASSED" })]
      }));
      await second.close();
    } finally {
      await daemon.stop();
    }
  });
});

async function waitFor<T>(read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting for durable job completion");
}

function configFor(directory: string): C2000McpConfig {
  return {
    adapter: "mock", ccs: { scriptingMode: "mock" }, target: { name: "F28P65x", coreMap: [{ coreId: 0, coreName: "C28xx_CPU1" }, { coreId: 2, coreName: "C28xx_CPU2" }] }, diagnostics: {}, logging: { level: "error" },
    daemon: { enabled: true, host: "127.0.0.1", port: 0, runtimeDir: directory, autoStart: false, startupTimeoutMs: 1000 },
    storage: { sqlitePath: path.join(directory, "debugd.sqlite"), wal: true }, scheduler: { maxParallelBoards: 2, pollIntervalMs: 10 },
    boards: [{ boardId: "board-a", probeSerial: "CL650001", device: "F28P65x", ccxmlPath: "board-a.ccxml", tags: ["F28P65x"] }]
  };
}
