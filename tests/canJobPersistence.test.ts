import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { C2000McpConfig } from "../src/config/config.schema.js";
import { DebugDaemon } from "../src/daemon/DebugDaemon.js";
import { discoverDaemon } from "../src/proxy/DaemonDiscovery.js";
import { McpDaemonClient } from "../src/proxy/McpDaemonClient.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

describe("durable two-board CAN job", () => {
  test("submits immediately and publishes persisted pair evidence after the proxy reconnects", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "c2000-can-job-"));
    directories.push(directory);
    const config = configFor(directory);
    const daemon = new DebugDaemon(config);
    try {
      await daemon.start();
      const first = new McpDaemonClient((await discoverDaemon(config)).client);
      const submitted = await first.invokeTool("c2000_submitMultiBoardCanAcceptance", {
        name: "mock-pair-e2e",
        boardIds: ["board-a", "board-b"],
        profile: {
          adapter: "mock",
          directions: [
            { sourceBoardId: "board-a", targetBoardId: "board-b", frames: [{ id: 0x121, data: [1] }] },
            { sourceBoardId: "board-b", targetBoardId: "board-a", frames: [{ id: 0x122, data: [2] }] }
          ],
          timeoutMs: 50,
          barrierTimeoutMs: 1000
        }
      });
      expect(submitted).toEqual(expect.objectContaining({ success: true, status: "QUEUED", jobId: expect.stringMatching(/^run-/) }));
      const jobId = String(submitted.jobId);
      await first.close();

      const second = new McpDaemonClient((await discoverDaemon(config)).client);
      const completed = await waitFor(async () => {
        const run = await second.invokeTool("c2000_getTestRun", { jobId, includeSteps: true, includeEvents: true });
        return run.status === "PASSED" ? run : undefined;
      });
      expect(completed).toEqual(expect.objectContaining({
        success: true, jobId, status: "PASSED",
        can: expect.objectContaining({
          group: expect.objectContaining({ groupType: "CAN_PAIR", status: "READY", members: expect.arrayContaining([expect.objectContaining({ boardId: "board-a" }), expect.objectContaining({ boardId: "board-b" })]) }),
          results: expect.arrayContaining([expect.objectContaining({ phase: "DIRECTION", status: "PASSED" })])
        })
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
  throw new Error("timed out waiting for CAN job completion");
}

function configFor(directory: string): C2000McpConfig {
  return {
    adapter: "mock", ccs: { scriptingMode: "mock" }, target: { name: "F28P65x", coreMap: [{ coreId: 0, coreName: "C28xx_CPU1" }, { coreId: 2, coreName: "C28xx_CPU2" }] }, diagnostics: {}, logging: { level: "error" },
    daemon: { enabled: true, host: "127.0.0.1", port: 0, runtimeDir: directory, autoStart: false, startupTimeoutMs: 1000 },
    storage: { sqlitePath: path.join(directory, "debugd.sqlite"), wal: true }, scheduler: { maxParallelBoards: 2, pollIntervalMs: 10 },
    boards: [
      { boardId: "board-a", probeSerial: "CL650001", device: "F28P65x", ccxmlPath: "board-a.ccxml", tags: ["can"] },
      { boardId: "board-b", probeSerial: "CL650002", device: "F28P65x", ccxmlPath: "board-b.ccxml", tags: ["can"] }
    ]
  };
}
