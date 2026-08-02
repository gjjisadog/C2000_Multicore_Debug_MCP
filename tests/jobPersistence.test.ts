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

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe("durable background test jobs", () => {
  test("closes the current job session before releasing its board lease even without an explicit cleanup step", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "c2000-job-cleanup-"));
    directories.push(directory);
    const config = configFor(directory);
    const daemon = new DebugDaemon(config);
    let sessionId = "";
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
      sessionId = String((completed.boards as Array<Record<string, unknown>>)[0]!.sessionId);
      expect(sessionId).toMatch(/^dbg-/);
      await client.close();
    } finally {
      await daemon.stop();
    }

    const store = await SqliteStore.open(config.storage!.sqlitePath);
    expect(new SessionRepository(store).get(sessionId)).toEqual(expect.objectContaining({ status: "CLOSED", closedAt: expect.any(String) }));
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
      await waitFor(async () => {
        const run = await second.invokeTool("c2000_getTestRun", { jobId, includeSteps: true });
        return run.status === "PASSED" ? run : undefined;
      });
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
