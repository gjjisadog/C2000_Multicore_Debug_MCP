import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { C2000McpConfig } from "../src/config/config.schema.js";
import { DebugDaemon } from "../src/daemon/DebugDaemon.js";
import { discoverDaemon } from "../src/proxy/DaemonDiscovery.js";
import { McpDaemonClient } from "../src/proxy/McpDaemonClient.js";
import { TestRunRepository } from "../src/storage/repositories/TestRunRepository.js";
import { SqliteStore } from "../src/storage/SqliteStore.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

describe("daemon job recovery", () => {
  test("migrates a legacy v1 RECOVERING plan and restarts without trusting its old session", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "c2000-job-recovery-"));
    directories.push(directory);
    const config = configFor(directory);
    const firstDaemon = new DebugDaemon(config);
    await firstDaemon.start();
    const first = new McpDaemonClient((await discoverDaemon(config)).client);
    const submitted = await first.invokeTool("c2000_submitTestPlan", {
      plan: {
        planVersion: 1, name: "safe-restart-delay", boardIds: ["board-a"],
        steps: [{ type: "delay", delayMs: 300 }],
        recoveryPolicy: "safe_restart_board"
      }
    });
    const jobId = String(submitted.jobId);
    await waitFor(async () => {
      const run = await first.invokeTool("c2000_getTestRun", { jobId });
      return run.status === "RUNNING" ? run : undefined;
    });
    await firstDaemon.stop();
    await first.close().catch(() => undefined);

    const store = await SqliteStore.open(config.storage!.sqlitePath);
    const runs = new TestRunRepository(store);
    const recovering = runs.get(jobId)!;
    expect(recovering.status).toBe("RECOVERING");
    store.run("UPDATE test_runs SET plan_json = ? WHERE job_id = ?", [JSON.stringify({
      ...recovering.plan,
      steps: [{ type: "delay", legacyPassthroughField: "written-by-pre-strict-v1" }]
    }), jobId]);
    store.run("UPDATE test_steps SET input_json = ? WHERE job_id = ?", [JSON.stringify({ type: "delay", legacyPassthroughField: true }), jobId]);
    store.close();

    const secondDaemon = new DebugDaemon(config);
    try {
      await secondDaemon.start();
      const second = new McpDaemonClient((await discoverDaemon(config)).client);
      const completed = await waitFor(async () => {
        const run = await second.invokeTool("c2000_getTestRun", { jobId, includeEvents: true });
        return run.status === "PASSED" ? run : undefined;
      });
      expect(completed).toEqual(expect.objectContaining({
        status: "PASSED",
        events: expect.arrayContaining([expect.objectContaining({
          eventType: "JOB_RESTARTED_FROM_SAFE_BOUNDARY",
          payload: expect.objectContaining({ recoveryEvidence: expect.objectContaining({
            reconciliationMode: "PERSISTED_METADATA_ONLY",
            hardwareStateReconciled: false,
            debugSessionRestored: false
          }) })
        })])
      }));
      await second.close();
    } finally {
      await secondDaemon.stop();
    }
  });
});

async function waitFor<T>(read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting for job state");
}

function configFor(directory: string): C2000McpConfig {
  return {
    adapter: "mock", ccs: { scriptingMode: "mock" }, target: { name: "F28P65x", coreMap: [{ coreId: 0, coreName: "C28xx_CPU1" }, { coreId: 2, coreName: "C28xx_CPU2" }] }, diagnostics: {}, logging: { level: "error" },
    daemon: { enabled: true, host: "127.0.0.1", port: 0, runtimeDir: directory, autoStart: false, startupTimeoutMs: 1000 },
    storage: { sqlitePath: path.join(directory, "debugd.sqlite"), wal: true }, scheduler: { maxParallelBoards: 1, pollIntervalMs: 10 },
    boards: [{ boardId: "board-a", probeSerial: "CL650001", device: "F28P65x", ccxmlPath: "board-a.ccxml", tags: [] }]
  };
}
