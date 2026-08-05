import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { BoardRegistry } from "../src/boards/BoardRegistry.js";
import type { BoardWorkerSupervisor } from "../src/boards/BoardWorkerSupervisor.js";
import { DaemonToolRouter } from "../src/daemon/DaemonToolRouter.js";
import type { C2000ToolInvoker } from "../src/mcp/tools.js";
import { BoardRepository } from "../src/storage/repositories/BoardRepository.js";
import { EventRepository } from "../src/storage/repositories/EventRepository.js";
import { LeaseRepository } from "../src/storage/repositories/LeaseRepository.js";
import { SessionRepository } from "../src/storage/repositories/SessionRepository.js";
import { SqliteStore } from "../src/storage/SqliteStore.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe("daemon tool router interactive session lifecycle", () => {
  test("does not persist a launch session that the worker already cleaned up", async () => {
    const fixture = await makeFixture();
    const router = new DaemonToolRouter(fixture.local, fixture.registry, fixture.workers, fixture.sessions);
    fixture.workers.invokeBoard = async () => ({ success: false, sessionId: "dbg-cleaned", cleanedUp: true });

    const result = await router.invokeTool("c2000_launchMulticoreDebug", {
      boardId: "board-a",
      cores: [{ coreId: 0, coreName: "C28xx_CPU1", load: false }]
    });

    expect(result).toEqual(expect.objectContaining({ success: false, sessionId: "dbg-cleaned", cleanedUp: true }));
    expect(fixture.sessions.get("dbg-cleaned")).toBeUndefined();
    expect(fixture.registry.leases.active("board-a")).toBeUndefined();
    fixture.store.close();
  });

  test("persists a failed interactive acceptance session so close releases its lease", async () => {
    const fixture = await makeFixture();
    const router = new DaemonToolRouter(
      fixture.local,
      fixture.registry,
      fixture.workers,
      fixture.sessions
    );

    const launched = await router.invokeTool("c2000_launchAndRunIpcAcceptance", {
      boardId: "board-a",
      sessionMode: "interactive",
      sessionName: "failed-interactive",
      cpu1CoreId: 0,
      cpu2CoreId: 2,
    });

    expect(launched).toEqual(
      expect.objectContaining({ success: false, sessionId: "dbg-failed" })
    );
    expect(fixture.sessions.get("dbg-failed")).toEqual(
      expect.objectContaining({ status: "OPEN", boardId: "board-a" })
    );
    expect(fixture.registry.leases.active("board-a")).toBeDefined();

    await expect(
      router.invokeTool("c2000_closeDebugSession", {
        sessionId: "dbg-failed",
      })
    ).resolves.toEqual(
      expect.objectContaining({
        success: true,
        sessionId: "dbg-failed",
        closed: true,
      })
    );
    expect(fixture.sessions.get("dbg-failed")?.status).toBe("CLOSED");
    expect(fixture.registry.leases.active("board-a")).toBeUndefined();
    expect(fixture.registry.get("board-a").currentLeaseId).toBeUndefined();
    fixture.store.close();
  });

  test("does not persist or retain a lease for an ephemeral result", async () => {
    const fixture = await makeFixture();
    const router = new DaemonToolRouter(
      fixture.local,
      fixture.registry,
      fixture.workers,
      fixture.sessions
    );

    await router.invokeTool("c2000_launchAndRunIpcAcceptance", {
      boardId: "board-a",
      sessionMode: "ephemeral",
      cpu1CoreId: 0,
      cpu2CoreId: 2,
    });

    expect(fixture.sessions.get("dbg-failed")).toBeUndefined();
    expect(fixture.registry.leases.active("board-a")).toBeUndefined();
    expect(fixture.registry.get("board-a").currentLeaseId).toBeUndefined();
    fixture.store.close();
  });

  test.each([
    ["closed false", { success: true, sessionId: "dbg-failed", closed: false }],
    ["missing closed", { success: true, sessionId: "dbg-failed" }],
    ["missing success", { sessionId: "dbg-failed", closed: true }],
    ["identity mismatch", { success: true, sessionId: "dbg-other", closed: true }]
  ] as const)("keeps daemon session OPEN when close confirmation has %s", async (_label, closeResult) => {
    const fixture = await makeFixture();
    const router = new DaemonToolRouter(fixture.local, fixture.registry, fixture.workers, fixture.sessions);
    await router.invokeTool("c2000_launchAndRunIpcAcceptance", {
      boardId: "board-a",
      sessionMode: "interactive",
      sessionName: "recoverable-close",
      cpu1CoreId: 0,
      cpu2CoreId: 2
    });
    fixture.workers.invokeBoard = async () => ({ ...closeResult });
    await expect(router.invokeTool("c2000_closeDebugSession", { sessionId: "dbg-failed" })).resolves.toEqual(closeResult);
    expect(fixture.sessions.get("dbg-failed")).toEqual(expect.objectContaining({ status: "OPEN" }));
    expect(fixture.sessions.get("dbg-failed")?.closedAt).toBeUndefined();
    expect(fixture.registry.leases.active("board-a")).toBeDefined();
    fixture.store.close();
  });
});

async function makeFixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "c2000-router-"));
  directories.push(directory);
  const store = await SqliteStore.open(path.join(directory, "test.sqlite"));
  const registry = new BoardRegistry(
    new BoardRepository(store),
    new EventRepository(store),
    store,
    new LeaseRepository(store)
  );
  registry.register({
    boardId: "board-a",
    probeSerial: "CL650001",
    device: "F28P65x",
    ccxmlPath: "board-a.ccxml",
    tags: [],
  });
  registry.setWorker("board-a", "worker-1");
  const sessions = new SessionRepository(store);
  const local: C2000ToolInvoker = {
    async invokeTool() {
      throw new Error("unexpected local route");
    },
  };
    const workers = {
      async startBoard() {
        return { workerInstanceId: "worker-1" };
      },
      async ensureWorker() {
        return { workerInstanceId: "worker-1", workerGeneration: 1 };
      },
      currentWorker() {
        return { workerInstanceId: "worker-1", workerGeneration: 1 };
      },
    commandTimeoutMs() {
      return 1000;
    },
    async invokeBoard(
      _boardId: string,
      toolName: string
    ): Promise<Record<string, unknown>> {
      if (toolName === "c2000_closeDebugSession") {
        return {
          success: true,
          sessionId: "dbg-failed",
          closed: true,
        };
      }
      return {
        success: false,
        sessionId: "dbg-failed",
      };
    },
  } as unknown as BoardWorkerSupervisor;
  return { store, registry, sessions, local, workers };
}
