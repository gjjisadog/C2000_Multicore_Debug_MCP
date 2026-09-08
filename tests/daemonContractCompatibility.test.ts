import { access, mkdtemp, rm } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { C2000McpConfig } from "../src/config/config.schema.js";
import { DebugDaemon } from "../src/daemon/DebugDaemon.js";
import { DaemonRpcServer } from "../src/daemon/DaemonRpcServer.js";
import { daemonRuntimePaths, writeDaemonInstance } from "../src/daemon/DaemonInstanceFile.js";
import { discoverDaemon } from "../src/proxy/DaemonDiscovery.js";
import { McpDaemonClient } from "../src/proxy/McpDaemonClient.js";
import { compareRuntimeContract, runtimeContractIdentity } from "../src/contracts/RuntimeContract.js";

const runtimeDirs: string[] = [];

afterEach(async () => {
  await Promise.all(runtimeDirs.splice(0).map(runtimeDir => rm(runtimeDir, { recursive: true, force: true })));
});

describe("frontend / daemon contract compatibility", () => {
  test("recognizes a missing contract as incompatible and the shared identity as compatible", () => {
    expect(compareRuntimeContract(undefined)).toEqual(expect.objectContaining({
      compatible: false,
      mismatches: expect.arrayContaining(["durableTestPlanVersion", "runIpcAcceptanceVersion"])
    }));
    expect(compareRuntimeContract(runtimeContractIdentity())).toEqual({
      compatible: true,
      expected: runtimeContractIdentity(),
      actual: runtimeContractIdentity(),
      mismatches: []
    });
  });

  test("rejects a live legacy daemon before any tool call and preserves its maintenance metadata", async () => {
    const runtimeDir = await mkdtemp(path.join(os.tmpdir(), "c2000-debugd-legacy-contract-"));
    runtimeDirs.push(runtimeDir);
    const instanceId = randomUUID();
    const authToken = randomBytes(32).toString("base64url");
    const rpc = new DaemonRpcServer({
      authToken,
      port: 0,
      toolInvoker: { async invokeTool() { return { success: true }; } },
      health: () => ({ daemon: { instanceId, pid: process.pid } })
    });
    try {
      const endpoint = await rpc.listen();
      const paths = daemonRuntimePaths(runtimeDir);
      await writeDaemonInstance(paths, {
        instanceId,
        pid: process.pid,
        startedAt: new Date().toISOString(),
        host: "127.0.0.1",
        port: endpoint.port,
        authTokenFile: path.join(runtimeDir, "token.txt"),
        databasePath: path.join(runtimeDir, "debugd.sqlite"),
        version: "0.7.0"
      }, authToken);
      await expect(discoverDaemon(configFor(runtimeDir))).rejects.toMatchObject({ code: "DaemonContractMismatch" });
      await expect(access(paths.instanceFile)).resolves.toBeUndefined();
    } finally {
      await rpc.close();
    }
  });

  test.each([
    ["omitted", undefined],
    ["explicit false", false]
  ] as const)("passes the safe Flash authorization default through frontend and daemon validation (%s)", async (_label, authorization) => {
    const runtimeDir = await mkdtemp(path.join(os.tmpdir(), "c2000-debugd-contract-"));
    runtimeDirs.push(runtimeDir);
    const config = configFor(runtimeDir);
    const daemon = new DebugDaemon(config);
    try {
      await daemon.start();
      const discovered = await discoverDaemon(config);
      expect(discovered.health).toEqual(expect.objectContaining({ contracts: runtimeContractIdentity() }));
      const client = new McpDaemonClient(discovered.client);
      const ipcStep: Record<string, unknown> = {
        type: "runIpcAcceptance",
        timeoutMs: 10,
        intervalMs: 1,
        ipcReadyExpressions: [{ coreId: 0, expression: "ipc.ready", expected: 1 }]
      };
      if (authorization !== undefined) ipcStep.allowDestructiveFlashReload = authorization;
      const submitted = await client.invokeTool("c2000_submitTestPlan", {
        plan: {
          planVersion: 1,
          name: `contract-${_label}`,
          boardIds: ["board-a"],
          steps: [
            { type: "launchMulticore", loadPrograms: false },
            { type: "delay", delayMs: 10_000 },
            ipcStep
          ],
          failurePolicy: { continueHealthyBoards: false, quarantineFailedBoard: true, collectDebugBundle: false }
        }
      });
      const run = await client.invokeTool("c2000_getTestRun", {
        jobId: String(submitted.jobId),
        includeSteps: true
      });
      const ipcPersistedStep = (run.steps as Array<Record<string, unknown>>).find(step => step.stepType === "runIpcAcceptance");
      expect(ipcPersistedStep?.input).toEqual(expect.objectContaining({ allowDestructiveFlashReload: false }));
      await client.invokeTool("c2000_cancelTestRun", { jobId: String(submitted.jobId) });
      await client.close();
    } finally {
      await daemon.stop();
    }
  });
});

function configFor(runtimeDir: string): C2000McpConfig {
  return {
    adapter: "mock",
    ccs: { scriptingMode: "mock" },
    target: {
      name: "F28P65x",
      coreMap: [
        { coreId: 0, coreName: "C28xx_CPU1", corePattern: "C28xx_CPU1" },
        { coreId: 2, coreName: "C28xx_CPU2", corePattern: "C28xx_CPU2" }
      ]
    },
    diagnostics: {},
    logging: { level: "error" },
    daemon: { enabled: true, host: "127.0.0.1", port: 0, runtimeDir, autoStart: false, startupTimeoutMs: 1000 },
    storage: { sqlitePath: path.join(runtimeDir, "debugd.sqlite"), wal: true },
    workers: {
      heartbeatIntervalMs: 1000,
      heartbeatTimeoutMs: 5000,
      defaultCommandTimeoutMs: 15000,
      restartLimit: 5,
      restartWindowMs: 60000
    },
    scheduler: { maxParallelBoards: 2, pollIntervalMs: 10 },
    boards: [{ boardId: "board-a", probeSerial: "CL650001", device: "F28P65x", ccxmlPath: "board-a.ccxml", tags: ["F28P65x"] }]
  };
}
