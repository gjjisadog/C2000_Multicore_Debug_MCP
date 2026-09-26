import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { BoardRegistry } from "../src/boards/BoardRegistry.js";
import type { BoardWorkerSupervisor } from "../src/boards/BoardWorkerSupervisor.js";
import { DaemonToolRouter } from "../src/daemon/DaemonToolRouter.js";
import type { LabPowerCycleClient } from "../src/power/BleLabPowerMcpClient.js";
import type { C2000ToolInvoker } from "../src/mcp/tools.js";
import type { SessionRepository } from "../src/storage/repositories/SessionRepository.js";
import { sha256File } from "../src/utils/fileHash.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

function fixture(options: { bleConfigured?: boolean } = {}) {
  const timeline: string[] = [];
  const events: Array<{ eventType: string; payload: Record<string, unknown> }> = [];
  const board: Record<string, any> = {
    boardId: "board-a", status: "READY", currentWorkerInstanceId: "worker-1",
    targetIdentity: { status: "UNKNOWN", generation: 0, programs: {} }
  };
  let activeLease: Record<string, any> | undefined;
  const leases = {
    acquire() {
      activeLease = { leaseId: "lease-power", boardId: "board-a", workerInstanceId: "worker-1" };
      return { lease: activeLease, leaseToken: "token", context: { ...activeLease, fencingToken: 1, workerInstanceId: "worker-1" } };
    },
    renew() { return activeLease; },
    active() { return activeLease; },
    describe() { return { status: activeLease ? "ACTIVE" : "NONE" }; },
    release() { activeLease = undefined; }
  };
  const registry = {
    leases,
    get() { return board; },
    list() { return [board]; },
    transition(_boardId: string, status: string, error?: Record<string, unknown>) {
      board.status = status; board.lastError = error; return board;
    },
    targetIdentity() { return board.targetIdentity; },
    markTargetIdentityUnknown(_boardId: string, reason: string) {
      board.targetIdentity = { status: "UNKNOWN", generation: board.targetIdentity.generation + 1, reason, programs: {}, requiresVerificationAfterPowerCycle: true };
      return board;
    },
    recordVerifiedResidentPrograms(_boardId: string, programs: Array<{ coreId: number; programUri: string; sha256: string }>) {
      board.targetIdentity = {
        status: "KNOWN", generation: board.targetIdentity.generation + 1,
        programs: Object.fromEntries(programs.map(item => [String(item.coreId), item]))
      };
      return board;
    }
  } as unknown as BoardRegistry;
  const sessionMap = new Map<string, Record<string, any>>();
  const sessions = {
    get(id: string) { return sessionMap.get(id); },
    upsert(session: Record<string, unknown>) { sessionMap.set(String(session.sessionId), { ...session }); },
    close(id: string) { const session = sessionMap.get(id)!; session.status = "CLOSED"; session.closedAt = new Date().toISOString(); },
    listByBoard(id: string) { return [...sessionMap.values()].filter(session => session.boardId === id); }
  } as unknown as SessionRepository;
  let workerHandler = async (name: string, _input: unknown): Promise<Record<string, unknown>> => {
    if (name === "c2000_createDebugSession") return { success: true, sessionId: "dbg-power", cores: [{ coreId: 0 }, { coreId: 2 }] };
    if (name === "c2000_closeDebugSession") return { success: true, sessionId: "dbg-power", closed: true };
    throw new Error(`unexpected worker call ${name}`);
  };
  const workers = {
    async ensureWorker() { return { workerInstanceId: "worker-1", workerGeneration: 1 }; },
    currentWorker() { return { workerInstanceId: "worker-1", workerGeneration: 1 }; },
    commandTimeoutMs() { return 1000; },
    async invokeBoard(_boardId: string, name: string, input: unknown) {
      timeline.push(name);
      return workerHandler(name, input);
    }
  } as unknown as BoardWorkerSupervisor;
  const local: C2000ToolInvoker = { async invokeTool() { throw new Error("unexpected local route"); } };
  const client: LabPowerCycleClient = { async powercycle(request) {
    timeline.push("ble:powercycle");
    return { device: "lab_power", status: "completed", trigger: request.reason, mode_used: "auto", off_hold_seconds: request.off_seconds, protocol_verified: true, physical_state: null };
  } };
  const router = new DaemonToolRouter(local, registry, workers, sessions, undefined, undefined, {
    runs: { listActiveForBoard() { return []; } },
    events: { append(event) { events.push(event); timeline.push(event.eventType); return "event-id"; } },
    enabled: options.bleConfigured !== false, safetyProfile: "safe",
    ...(options.bleConfigured === false ? {} : { client })
  });
  const openSession = () => router.invokeTool("c2000_createDebugSession", {
    boardId: "board-a", sessionName: "power-cycle", coreMap: [{ coreId: 0 }, { coreId: 2 }]
  });
  return { router, board, sessions, timeline, events, activeLease: () => activeLease, openSession,
    setWorkerHandler: (handler: typeof workerHandler) => { workerHandler = handler; }, client };
}

describe("power-cycle safety boundary without hardware", () => {
  test("falls back to a quarantined manual step when the optional MCP is absent", async () => {
    const f = fixture({ bleConfigured: false });
    await f.openSession();
    const result = await f.router.invokeTool("c2000_cycleBoardPower", {
      boardId: "board-a", sessionId: "dbg-power", reason: "connection_recovery", mode: "auto_or_manual",
      firstFailure: { operation: "connectCores", code: "TargetConnectFailed", message: "first failure", observedAt: new Date().toISOString() }
    });
    expect(result).toMatchObject({ status: "manual_required", powerCycle: { reason: "ble_lab_power_mcp_not_configured" } });
    expect(f.timeline).not.toContain("ble:powercycle");
    expect(f.activeLease()).toBeUndefined();
    expect(f.board.status).toBe("QUARANTINED");
  });

  test("stores the first failure before closing the fenced session and pausing for manual power", async () => {
    const f = fixture();
    await f.openSession();
    f.client.powercycle = async request => {
      f.timeline.push("ble:powercycle");
      return { device: "lab_power", status: "manual_required", trigger: request.reason, protocol_verified: false, physical_state: null };
    };
    const result = await f.router.invokeTool("c2000_cycleBoardPower", {
      boardId: "board-a", sessionId: "dbg-power", reason: "connection_recovery", mode: "auto_or_manual", offSeconds: 6,
      firstFailure: { operation: "connectCores", code: "TargetConnectFailed", message: "first failure", observedAt: new Date().toISOString() }
    });
    expect(f.timeline.indexOf("POWER_CYCLE_FIRST_FAILURE")).toBeLessThan(f.timeline.indexOf("c2000_closeDebugSession"));
    expect(f.timeline.indexOf("c2000_closeDebugSession")).toBeLessThan(f.timeline.indexOf("ble:powercycle"));
    expect(result).toMatchObject({ status: "manual_required", oldSessionClosed: true, oldLeaseReleased: true, coldStartVerified: false });
    expect(f.activeLease()).toBeUndefined();
    expect(f.board).toMatchObject({ status: "QUARANTINED", targetIdentity: { status: "UNKNOWN", requiresVerificationAfterPowerCycle: true } });
    await expect(f.router.invokeTool("c2000_confirmManualPowerCycle", {
      boardId: "board-a", requestId: result.requestId, powerRemovedAndRestored: true, observedOffSeconds: 5
    })).rejects.toMatchObject({ code: "PowerCycleConfirmationInvalid" });
    const confirmed = await f.router.invokeTool("c2000_confirmManualPowerCycle", {
      boardId: "board-a", requestId: result.requestId, powerRemovedAndRestored: true, observedOffSeconds: 6
    });
    expect(confirmed).toMatchObject({ status: "operator_confirmed", identityVerificationRequired: true, coldStartVerified: false });
    expect(f.board.status).toBe("READY");
    await expect(f.router.invokeTool("c2000_runCore", { sessionId: "dbg-power", coreId: 0 }))
      .rejects.toMatchObject({ code: "TargetImageIdentityUnknown" });
    await expect(f.router.invokeTool("c2000_launchAndRunIpcAcceptance", { boardId: "board-a", programPreparation: "symbols-only" }))
      .rejects.toMatchObject({ code: "TargetImageIdentityUnknown" });
    await expect(f.router.invokeTool("c2000_launchResidentIpcDebug", { boardId: "board-a" }))
      .rejects.toMatchObject({ code: "TargetImageIdentityUnknown" });
  });

  test("refuses a recovery request while another target command may still be in Flash", async () => {
    const f = fixture();
    await f.openSession();
    let started!: () => void;
    let finish!: () => void;
    const startedPromise = new Promise<void>(resolve => { started = resolve; });
    const held = new Promise<Record<string, unknown>>(resolve => { finish = () => resolve({ success: true, sessionId: "dbg-power", cores: [] }); });
    f.setWorkerHandler(async name => {
      if (name === "c2000_getMulticoreSnapshot") { started(); return held; }
      if (name === "c2000_closeDebugSession") return { success: true, sessionId: "dbg-power", closed: true };
      throw new Error(`unexpected worker call ${name}`);
    });
    const pending = f.router.invokeTool("c2000_getMulticoreSnapshot", { sessionId: "dbg-power" });
    await startedPromise;
    await expect(f.router.invokeTool("c2000_cycleBoardPower", {
      boardId: "board-a", sessionId: "dbg-power", reason: "connection_recovery",
      firstFailure: { operation: "connectCores", code: "TargetConnectFailed", message: "first failure", observedAt: new Date().toISOString() }
    })).rejects.toMatchObject({ code: "PowerCycleBusy" });
    expect(f.timeline).not.toContain("ble:powercycle");
    expect(f.activeLease()).toBeDefined();
    finish();
    await pending;
  });

  test("accepts both current-session writes and marker checks before calling MCP", async () => {
    const f = fixture();
    await f.openSession();
    const directory = await mkdtemp(path.join(os.tmpdir(), "c2000-power-cycle-"));
    directories.push(directory);
    const checks = await Promise.all([0, 2].map(async coreId => {
      const programUri = path.join(directory, `cpu${coreId}.out`);
      const manifestUri = path.join(directory, `cpu${coreId}.json`);
      await writeFile(programUri, `cpu${coreId}`);
      await writeFile(manifestUri, JSON.stringify({ marker: coreId }));
      return { coreId, programUri, manifestUri, programSha256: await sha256File(programUri), manifestSha256: await sha256File(manifestUri) };
    }));
    f.setWorkerHandler(async (name, input) => {
      if (name === "c2000_getLoadedProgramInfo") {
        const check = checks.find(item => item.coreId === (input as { coreId: number }).coreId)!;
        return { success: true, sessionId: "dbg-power", coreId: check.coreId, programUri: check.programUri, sha256: check.programSha256, targetMemoryWritten: true };
      }
      if (name === "c2000_verifyResidentImage") return {
        success: true, verified: true, verificationMethod: "resident-image-manifest-raw-memory",
        targetAccess: { programming: false, symbolLoad: false, reset: false, run: false, targetMemoryWrite: false },
        checks: checks.map(check => ({ ...check, marker: { matched: true } }))
      };
      if (name === "c2000_closeDebugSession") return { success: true, sessionId: "dbg-power", closed: true };
      throw new Error(`unexpected worker call ${name}`);
    });
    const result = await f.router.invokeTool("c2000_cycleBoardPower", {
      boardId: "board-a", sessionId: "dbg-power", reason: "after_flash",
      flashChecks: checks.map(({ coreId, programUri, manifestUri }) => ({ coreId, programUri, manifestUri }))
    });
    expect(f.timeline.indexOf("c2000_verifyResidentImage")).toBeLessThan(f.timeline.indexOf("c2000_closeDebugSession"));
    expect(f.timeline.indexOf("c2000_closeDebugSession")).toBeLessThan(f.timeline.indexOf("ble:powercycle"));
    expect(result).toMatchObject({ status: "completed", success: true, protocolVerified: true, physicalState: null, coldStartVerified: false, targetImageIdentity: "UNKNOWN" });
    expect(f.activeLease()).toBeUndefined();
    expect(f.board.targetIdentity).toMatchObject({ status: "UNKNOWN", requiresVerificationAfterPowerCycle: true });
  });
});
