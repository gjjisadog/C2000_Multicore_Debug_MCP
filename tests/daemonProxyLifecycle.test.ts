import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { C2000McpConfig } from "../src/config/config.schema.js";
import { DebugDaemon } from "../src/daemon/DebugDaemon.js";
import { discoverDaemon } from "../src/proxy/DaemonDiscovery.js";
import { McpDaemonClient } from "../src/proxy/McpDaemonClient.js";
import { SqliteStore } from "../src/storage/SqliteStore.js";
import { SessionRepository } from "../src/storage/repositories/SessionRepository.js";
import { WorkerRepository } from "../src/storage/repositories/WorkerRepository.js";

const runtimeDirs: string[] = [];

afterEach(async () => {
  await Promise.all(runtimeDirs.splice(0).map(runtimeDir => rm(runtimeDir, { recursive: true, force: true })));
});

describe("daemon / proxy lifecycle", () => {
  test("confirmed worker shutdown closes its persisted debug sessions", async () => {
    const runtimeDir = await mkdtemp(path.join(os.tmpdir(), "c2000-debugd-shutdown-"));
    runtimeDirs.push(runtimeDir);
    const daemon = new DebugDaemon(configFor(runtimeDir));
    let sessionId: string;
    try {
      await daemon.start();
      const client = new McpDaemonClient((await discoverDaemon(configFor(runtimeDir))).client);
      const created = await client.invokeTool("c2000_createDebugSession", { sessionName: "shutdown-reconcile" });
      expect(created.success).toBe(true);
      sessionId = String(created.sessionId);
      await client.close();
    } finally {
      await daemon.stop();
    }
    const store = await SqliteStore.open(path.join(runtimeDir, "debugd.sqlite"));
    try {
      expect(new SessionRepository(store).get(sessionId!)).toMatchObject({ status: "CLOSED", closedAt: expect.any(String) });
    } finally {
      store.close();
    }
  });

  test("explicit recovery retires a stale session only after external ownership confirmation", async () => {
    const runtimeDir = await mkdtemp(path.join(os.tmpdir(), "c2000-debugd-stale-session-"));
    runtimeDirs.push(runtimeDir);
    const daemon = new DebugDaemon(configFor(runtimeDir));
    try {
      await daemon.start();
      const store = await SqliteStore.open(path.join(runtimeDir, "debugd.sqlite"));
      try {
        new WorkerRepository(store).upsert({
          workerInstanceId: "worker-old", boardId: "board-a", pid: 2147483647,
          processStartTime: "2026-01-01T00:00:00.000Z", daemonInstanceId: "daemon-old",
          status: "STOPPED", startedAt: "2026-01-01T00:00:00.000Z", ownedDssProcesses: []
        });
        new SessionRepository(store).upsert({
          sessionId: "dbg-old", boardId: "board-a", workerInstanceId: "worker-old",
          sessionName: "launch-resident-ipc-debug", coreMap: [], status: "OPEN",
          createdAt: "2026-01-01T00:00:00.000Z"
        });
      } finally {
        store.close();
      }
      const client = new McpDaemonClient((await discoverDaemon(configFor(runtimeDir))).client);
      try {
        const dryRun = await client.invokeTool("c2000_recoverBoard", { boardId: "board-a", reconcileStaleSessions: true });
        expect(dryRun).toMatchObject({
          success: true, action: "RESTART_WORKER_AND_RECONCILE_STALE_SESSIONS",
          staleSessions: [expect.objectContaining({ sessionId: "dbg-old", eligible: true })]
        });
        const denied = await client.invokeTool("c2000_recoverBoard", { boardId: "board-a", dryRun: false, reconcileStaleSessions: true });
        expect(denied).toMatchObject({ success: false, error: { code: "ProbeRecoveryBlocked" } });
        const recovered = await client.invokeTool("c2000_recoverBoard", {
          boardId: "board-a", dryRun: false, reconcileStaleSessions: true, confirmNoExternalDebugOwner: true
        });
        expect(recovered).toMatchObject({ success: true, abandonedSessionIds: ["dbg-old"] });
      } finally {
        await client.close();
      }
      const verify = await SqliteStore.open(path.join(runtimeDir, "debugd.sqlite"));
      try {
        expect(new SessionRepository(verify).get("dbg-old")).toMatchObject({
          status: "ABANDONED", closedAt: expect.any(String),
          lastSnapshot: { staleSessionReconciliation: expect.objectContaining({ adapterCleanupVerified: false }) }
        });
      } finally {
        verify.close();
      }
    } finally {
      await daemon.stop();
    }
  });

  test("a proxy client may close and reconnect without disposing daemon-owned sessions", async () => {
    const runtimeDir = await mkdtemp(path.join(os.tmpdir(), "c2000-debugd-test-"));
    runtimeDirs.push(runtimeDir);
    const daemon = new DebugDaemon(configFor(runtimeDir));
    try {
      const started = await daemon.start();
      const first = new McpDaemonClient((await discoverDaemon(configFor(runtimeDir))).client);
      const health = await first.invokeTool("c2000_getDaemonHealth", {});
      expect(health).toEqual(expect.objectContaining({
        success: true,
        daemon: expect.objectContaining({ instanceId: started.instanceId, pid: process.pid, databaseReady: true }),
        workers: { total: 1, healthy: 1, unhealthy: 0 }
      }));
      expect(await first.invokeTool("c2000_listBoards", { tags: ["F28P65x"] })).toEqual(expect.objectContaining({
        success: true,
        boards: [expect.objectContaining({ boardId: "board-a", probeSerial: "CL650001" })]
      }));

      const created = await first.invokeTool("c2000_createDebugSession", { sessionName: "survives-proxy" });
      expect(created.success).toBe(true);
      const sessionId = String(created.sessionId);
      expect(await first.invokeTool("c2000_recoverBoard", { boardId: "board-a" })).toEqual(expect.objectContaining({
        success: true,
        dryRun: true,
        action: "BLOCKED_ACTIVE_BOARD_LEASE",
        blocked: expect.objectContaining({ code: "ActiveBoardLease", ownerJobId: expect.any(String) })
      }));
      expect(await first.invokeTool("c2000_recoverBoard", { boardId: "board-a", dryRun: false })).toEqual(expect.objectContaining({
        success: false,
        error: expect.objectContaining({
          code: "ProbeRecoveryBlocked",
          details: expect.objectContaining({ boardId: "board-a", blockedBy: expect.objectContaining({ code: "ActiveBoardLease" }) })
        })
      }));
      await first.close();

      const second = new McpDaemonClient((await discoverDaemon(configFor(runtimeDir))).client);
      const cores = await second.invokeTool("c2000_listCores", { sessionId });
      expect(cores).toEqual(expect.objectContaining({
        success: true,
        sessionId,
        cores: expect.arrayContaining([expect.objectContaining({ coreId: 0 }), expect.objectContaining({ coreId: 2 })])
      }));
      await second.close();
    } finally {
      await daemon.stop();
    }
  });

  test("board recovery defaults to a non-destructive daemon-worker dry run", async () => {
    const runtimeDir = await mkdtemp(path.join(os.tmpdir(), "c2000-debugd-recovery-"));
    runtimeDirs.push(runtimeDir);
    const daemon = new DebugDaemon(configFor(runtimeDir));
    try {
      await daemon.start();
      const client = new McpDaemonClient((await discoverDaemon(configFor(runtimeDir))).client);
      expect(await client.invokeTool("c2000_recoverBoard", { boardId: "board-a" })).toEqual(expect.objectContaining({
        success: true, dryRun: true, boardId: "board-a", action: "RESTART_DAEMON_OWNED_WORKER_ONLY", externalProcessTermination: false
      }));
      await client.close();
    } finally {
      await daemon.stop();
    }
  });

  test("registers an unconfigured board and launches the safe workflow through its worker", async () => {
    const runtimeDir = await mkdtemp(path.join(os.tmpdir(), "c2000-debugd-register-"));
    runtimeDirs.push(runtimeDir);
    const config = configFor(runtimeDir);
    config.boards = [];
    const ccxmlPath = path.join(runtimeDir, "board-b.ccxml");
    await writeFile(
      ccxmlPath,
      '<property Type="stringfield" Value="CL650002" id="-- Enter the serial number"/>\n'
    );
    const daemon = new DebugDaemon(config);
    try {
      await daemon.start();
      const client = new McpDaemonClient((await discoverDaemon(config)).client);
      const before = await client.invokeTool("c2000_getDaemonHealth", {});
      expect(before).toEqual(expect.objectContaining({
        boards: expect.objectContaining({
          registered: 0,
          registrationRequired: true,
          nextTool: "c2000_registerBoard"
        })
      }));
      await expect(client.invokeTool("c2000_launchMulticoreDebugSafe", {
        boardId: "board-b",
        cores: [{ coreId: 0, coreName: "C28xx_CPU1", load: false }]
      })).rejects.toEqual(expect.objectContaining({
        code: "ProbeBindingMissing",
        details: expect.objectContaining({
          nextTool: "c2000_registerBoard",
          standardCoreIds: { cpu1: 0, cpu2: 2 }
        })
      }));

      const registration = await client.invokeTool("c2000_registerBoard", {
        boardId: "board-b",
        probeSerial: "CL650002",
        ccxmlPath,
        tags: ["F28P65x"]
      });
      expect(registration).toEqual(expect.objectContaining({
        success: true,
        workerStarted: true,
        action: "REGISTERED",
        board: expect.objectContaining({
          boardId: "board-b",
          probeSerial: "CL650002",
          status: "READY"
        })
      }));

      const launched = await client.invokeTool("c2000_launchMulticoreDebugSafe", {
        boardId: "board-b",
        sessionName: "registered-safe-launch",
        cores: [
          { coreId: 0, coreName: "C28xx_CPU1", connect: true, load: false, haltAtEntry: true },
          { coreId: 2, coreName: "C28xx_CPU2", connect: true, load: false, haltAtEntry: true }
        ]
      });
      expect(launched).toEqual(expect.objectContaining({
        success: true,
        boardId: "board-b",
        probeSerial: "CL650002",
        workerInstanceId: expect.any(String),
        sessionId: expect.any(String)
      }));
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
    scheduler: { maxParallelBoards: 4, pollIntervalMs: 250 },
    boards: [{ boardId: "board-a", probeSerial: "CL650001", device: "F28P65x", ccxmlPath: "board-a.ccxml", tags: ["F28P65x"] }]
  };
}
