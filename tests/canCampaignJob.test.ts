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

describe("durable finite CAN campaigns", () => {
  test("runs a finite fault campaign and exposes stable case checkpoints through the background job", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "c2000-can-campaign-"));
    directories.push(directory);
    const config = configFor(directory);
    const daemon = new DebugDaemon(config);
    try {
      await daemon.start();
      const client = new McpDaemonClient((await discoverDaemon(config)).client);
      const submitted = await client.invokeTool("c2000_submitCanFaultCampaign", {
        boardIds: ["board-a", "board-b"], iterations: 2, failFast: true,
        profile: {
          adapter: "mock",
          faults: [{ name: "drop-primary", kind: "drop", sourceBoardId: "board-a", targetBoardId: "board-b" }],
          directions: [
            { sourceBoardId: "board-a", targetBoardId: "board-b", expectDelivery: false, frames: [{ id: 0x411, data: [1] }] },
            { sourceBoardId: "board-b", targetBoardId: "board-a", frames: [{ id: 0x412, data: [2] }] }
          ], timeoutMs: 20, barrierTimeoutMs: 1000
        }
      });
      const jobId = String(submitted.jobId);
      const completed = await waitFor(async () => {
        const run = await client.invokeTool("c2000_getTestRun", { jobId });
        return run.status === "PASSED" ? run : undefined;
      });
      expect(completed).toEqual(expect.objectContaining({
        can: expect.objectContaining({ campaign: expect.objectContaining({ type: "FAULT_CAMPAIGN", status: "PASSED" }), cases: expect.arrayContaining([
          expect.objectContaining({ caseIndex: 0, status: "PASSED" }), expect.objectContaining({ caseIndex: 1, status: "PASSED" })
        ]) })
      }));
      const soak = await client.invokeTool("c2000_submitCanSoakTest", {
        boardIds: ["board-a", "board-b"], iterations: 2,
        profile: {
          adapter: "mock",
          directions: [
            { sourceBoardId: "board-a", targetBoardId: "board-b", frames: [{ id: 0x421, data: [3] }] },
            { sourceBoardId: "board-b", targetBoardId: "board-a", frames: [{ id: 0x422, data: [4] }] }
          ], timeoutMs: 20, barrierTimeoutMs: 1000
        }
      });
      const soakCompleted = await waitFor(async () => {
        const run = await client.invokeTool("c2000_getTestRun", { jobId: String(soak.jobId) });
        return run.status === "PASSED" ? run : undefined;
      });
      expect(soakCompleted).toEqual(expect.objectContaining({
        can: expect.objectContaining({ campaign: expect.objectContaining({ type: "SOAK", status: "PASSED" }), cases: expect.arrayContaining([
          expect.objectContaining({ caseIndex: 0, status: "PASSED" }), expect.objectContaining({ caseIndex: 1, status: "PASSED" })
        ]) })
      }));
      const matrix = await client.invokeTool("c2000_submitTestPlan", { plan: {
        planVersion: 1, name: "deterministic-can-matrix", boardIds: ["board-a", "board-b"],
        can: { profile: { adapter: "mock", directions: [
          { sourceBoardId: "board-a", targetBoardId: "board-b", frames: [{ id: 0x431, data: [5] }] },
          { sourceBoardId: "board-b", targetBoardId: "board-a", frames: [{ id: 0x432, data: [6] }] }
        ], timeoutMs: 20, barrierTimeoutMs: 1000 }, execution: {
          mode: "matrix", iterations: 1, failFast: false, health: { maxConsecutiveFailures: 0, maxFailureRate: 0 }, resetOrRejoinRequested: false,
          matrixCases: [{ name: "baseline", metadata: { rate: 1 } }, { name: "repeat", metadata: { rate: 2 } }]
        } },
        steps: [{ type: "launchMulticore" }, { type: "canAcceptance" }, { type: "cleanup" }]
      } });
      const matrixCompleted = await waitFor(async () => {
        const run = await client.invokeTool("c2000_getTestRun", { jobId: String(matrix.jobId) });
        return run.status === "PASSED" ? run : undefined;
      });
      expect(matrixCompleted).toEqual(expect.objectContaining({
        can: expect.objectContaining({ campaign: expect.objectContaining({ type: "MATRIX", status: "PASSED" }), cases: expect.arrayContaining([
          expect.objectContaining({ caseIndex: 0, status: "PASSED", caseHash: expect.stringMatching(/^[a-f0-9]{64}$/) }), expect.objectContaining({ caseIndex: 1, status: "PASSED" })
        ]) })
      }));
      await client.close();
    } finally { await daemon.stop(); }
  });
});

async function waitFor<T>(read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting for CAN campaign");
}

function configFor(directory: string): C2000McpConfig {
  return {
    adapter: "mock", ccs: { scriptingMode: "mock" }, target: { name: "F28P65x", coreMap: [{ coreId: 0, coreName: "C28xx_CPU1" }, { coreId: 2, coreName: "C28xx_CPU2" }] }, diagnostics: {}, logging: { level: "error" },
    daemon: { enabled: true, host: "127.0.0.1", port: 0, runtimeDir: directory, autoStart: false, startupTimeoutMs: 1_000 }, storage: { sqlitePath: path.join(directory, "debugd.sqlite"), wal: true }, scheduler: { maxParallelBoards: 2, pollIntervalMs: 10 },
    boards: [
      { boardId: "board-a", probeSerial: "CL651001", device: "F28P65x", ccxmlPath: "board-a.ccxml", tags: ["can"] },
      { boardId: "board-b", probeSerial: "CL651002", device: "F28P65x", ccxmlPath: "board-b.ccxml", tags: ["can"] }
    ]
  };
}
