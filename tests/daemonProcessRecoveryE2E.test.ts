import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { loadConfig } from "../src/config/config.loader.js";
import { launchDetachedDaemon } from "../src/daemon/DaemonBootstrap.js";
import { discoverDaemon } from "../src/proxy/DaemonDiscovery.js";
import { McpDaemonClient } from "../src/proxy/McpDaemonClient.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => removeWhenUnlocked(directory)));
});

describe("detached daemon process recovery", () => {
  test("a fresh daemon process reconciles a job after the original daemon exits", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "c2000-daemon-process-recovery-"));
    directories.push(directory);
    const configPath = path.join(directory, "config.json");
    await writeFile(configPath, JSON.stringify({
      adapter: "mock",
      ccs: { scriptingMode: "mock" },
      target: { name: "F28P65x", coreMap: [{ coreId: 0, coreName: "C28xx_CPU1" }, { coreId: 2, coreName: "C28xx_CPU2" }] },
      logging: { level: "error" },
      daemon: { enabled: true, host: "127.0.0.1", port: 0, runtimeDir: path.join(directory, "runtime"), autoStart: true, startupTimeoutMs: 5_000 },
      storage: { sqlitePath: path.join(directory, "runtime", "debugd.sqlite"), wal: true },
      scheduler: { maxParallelBoards: 1, pollIntervalMs: 10 },
      boards: [{ boardId: "board-a", probeSerial: "PROCESS-RECOVERY-PROBE", device: "F28P65x", ccxmlPath: "board-a.ccxml", tags: [] }]
    }, null, 2));
    const config = await loadConfig(configPath);
    const daemonEnvironment = { C2000_MCP_CONFIG: configPath, C2000_MCP_LOG_LEVEL: "error" };
    let activePid: number | undefined;
    try {
      await launchDetachedDaemon({ cwd: directory, env: daemonEnvironment, preferSource: true });
      const first = await waitForDaemon(config);
      activePid = first.instance.pid;
      const firstClient = new McpDaemonClient(first.client);
      const submitted = await firstClient.invokeTool("c2000_submitTestPlan", {
        plan: {
          planVersion: 1,
          name: "process-safe-restart",
          boardIds: ["board-a"],
          steps: [{ type: "delay", delayMs: 1_000 }],
          recoveryPolicy: "safe_restart_board"
        }
      });
      const jobId = String(submitted.jobId);
      await waitFor(async () => {
        const run = await firstClient.invokeTool("c2000_getTestRun", { jobId });
        return run.status === "RUNNING" ? run : undefined;
      });

      await stopProcess(first.instance.pid);
      activePid = undefined;
      await launchDetachedDaemon({ cwd: directory, env: daemonEnvironment, preferSource: true });
      const second = await waitForDaemon(config);
      activePid = second.instance.pid;
      expect(second.instance.instanceId).not.toBe(first.instance.instanceId);
      const secondClient = new McpDaemonClient(second.client);
      let lastRun: Record<string, unknown> | undefined;
      const completed = await waitFor(async () => {
        const run = await secondClient.invokeTool("c2000_getTestRun", { jobId, includeEvents: true });
        lastRun = run;
        return run.status === "PASSED" ? run : undefined;
      }, 10_000).catch(error => {
        throw new Error(`${error instanceof Error ? error.message : String(error)}; last run: ${JSON.stringify(lastRun)}`);
      });
      expect(completed).toEqual(expect.objectContaining({
        status: "PASSED",
        events: expect.arrayContaining([expect.objectContaining({
          eventType: "JOB_RESTARTED_FROM_SAFE_BOUNDARY",
          payload: expect.objectContaining({ releasedRecoveredLeases: ["board-a"], recoveryEvidence: expect.objectContaining({
            reconciliationMode: "PERSISTED_METADATA_ONLY",
            hardwareStateReconciled: false,
            debugSessionRestored: false
          }) })
        })])
      }));
    } finally {
      if (activePid) await stopProcess(activePid);
    }
  }, 20_000);
});

async function waitForDaemon(config: Awaited<ReturnType<typeof loadConfig>>) {
  return waitFor(async () => discoverDaemon(config).catch(() => undefined), 10_000);
}

async function waitFor<T>(read: () => Promise<T | undefined>, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("timed out waiting for daemon process state");
}

async function stopProcess(pid: number): Promise<void> {
  try { process.kill(pid, "SIGTERM"); } catch { return; }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await new Promise(resolve => setTimeout(resolve, 50));
    } catch {
      return;
    }
  }
  throw new Error(`daemon process ${pid} did not stop`);
}

async function removeWhenUnlocked(directory: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await rm(directory, { recursive: true, force: true, maxRetries: 1, retryDelay: 50 });
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  throw new Error(`could not remove ${directory}`);
}
