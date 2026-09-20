import { randomUUID } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import type { C2000McpConfig } from "../src/config/config.schema.js";
import { restartOwnedDaemon } from "../src/daemon/DaemonMaintenance.js";
import type { DebugDaemonInstance } from "../src/daemon/DaemonInstanceFile.js";
import type { DiscoveredDaemon } from "../src/proxy/DaemonDiscovery.js";
import { runtimeBuildIdentity } from "../src/runtimeInfo.js";
import { runtimeContractIdentity } from "../src/contracts/RuntimeContract.js";
import type { LocalRpcClient } from "../src/rpc/RpcServer.js";

describe("development daemon maintenance", () => {
  test("shuts down only the authenticated owner, waits for its boundary, and reconnects", async () => {
    const instance = instanceFor();
    const request = vi.fn().mockResolvedValue({ accepted: true });
    const replacement = discovered(instanceFor(), vi.fn(), true);
    let readCount = 0;
    const launch = vi.fn().mockResolvedValue(undefined);
    const result = await restartOwnedDaemon(configFor(), discovered(instance, request), {
      launch,
      rediscover: async () => replacement,
      readInstance: async () => (++readCount === 1 ? instance : undefined),
      isProcessAlive: () => false,
      isLockHeld: async () => false,
      sleep: async () => undefined,
      timeoutMs: 100
    });

    expect(request).toHaveBeenCalledWith("shutdown", {});
    expect(launch).toHaveBeenCalledOnce();
    expect(result).toBe(replacement);
  });

  test("returns DaemonMaintenanceRequired without force-killing when the old owner does not stop", async () => {
    const instance = instanceFor();
    const request = vi.fn().mockResolvedValue({ accepted: true });
    const forceKill = vi.fn();

    await expect(restartOwnedDaemon(configFor(), discovered(instance, request), {
      launch: vi.fn().mockResolvedValue(undefined),
      readInstance: async () => instance,
      isProcessAlive: () => true,
      isLockHeld: async () => true,
      sleep: async () => undefined,
      timeoutMs: 0
    })).rejects.toMatchObject({
      code: "DaemonMaintenanceRequired",
      details: expect.objectContaining({
        oldPid: instance.pid,
        instanceId: instance.instanceId,
        runtimeDir: expect.stringContaining("c2000-dev"),
        phase: "wait-for-stop"
      })
    });
    expect(request).toHaveBeenCalledWith("shutdown", {});
    expect(forceKill).not.toHaveBeenCalled();
  });
});

function discovered(instance: DebugDaemonInstance, request: ReturnType<typeof vi.fn>, compatible = false): DiscoveredDaemon {
  return {
    instance,
    client: { request } as unknown as LocalRpcClient,
    health: { daemon: { instanceId: instance.instanceId } },
    compatibility: {
      compatible,
      mismatches: compatible ? [] : ["runtime.devBuildId"],
      contract: { compatible: true, expected: runtimeContractIdentity(), actual: runtimeContractIdentity(), mismatches: [] },
      runtime: { compatible, expected: runtimeBuildIdentity(), actual: { version: runtimeBuildIdentity().version }, mismatches: compatible ? [] : ["devBuildId"] }
    }
  };
}

function instanceFor(): DebugDaemonInstance {
  return {
    instanceId: randomUUID(),
    pid: 999_991,
    startedAt: new Date().toISOString(),
    host: "127.0.0.1",
    port: 32123,
    authTokenFile: "C:/tmp/c2000-dev/debugd-token.txt",
    databasePath: "C:/tmp/c2000-dev/debugd.sqlite",
    version: runtimeBuildIdentity().version,
    contract: runtimeContractIdentity(),
    runtimeIdentity: runtimeBuildIdentity()
  };
}

function configFor(): C2000McpConfig {
  return {
    adapter: "mock",
    ccs: { scriptingMode: "mock" },
    target: { name: "F28P65x", coreMap: [{ coreId: 0, coreName: "C28xx_CPU1" }] },
    diagnostics: {},
    logging: { level: "error" },
    daemon: { enabled: true, host: "127.0.0.1", port: 0, runtimeDir: "C:/tmp/c2000-dev", autoStart: true, startupTimeoutMs: 1000 },
    storage: { sqlitePath: "C:/tmp/c2000-dev/debugd.sqlite", wal: true },
    workers: { heartbeatIntervalMs: 1000, heartbeatTimeoutMs: 5000, defaultCommandTimeoutMs: 15000, restartLimit: 5, restartWindowMs: 60000 },
    scheduler: { maxParallelBoards: 1, pollIntervalMs: 10 },
    boards: []
  };
}
