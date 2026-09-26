import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { TestRunRepository } from "../src/storage/repositories/TestRunRepository.js";
import { SqliteStore } from "../src/storage/SqliteStore.js";
import { sha256File } from "../src/utils/fileHash.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe("optional board power-cycle coordination", () => {
  test("persists the first connection failure, closes the old lease, and pauses for manual confirmation", async () => {
    const fixture = await makeFixture();
    const calls: string[] = [];
    fixture.workers.invokeBoard = async (_boardId, toolName) => {
      calls.push(toolName);
      if (toolName === "c2000_createDebugSession") return { success: true, sessionId: "dbg-power", cores: [{ coreId: 0 }, { coreId: 2 }] };
      if (toolName === "c2000_closeDebugSession") return { success: true, sessionId: "dbg-power", closed: true };
      throw new Error(`unexpected worker tool ${toolName}`);
    };
    const events = new EventRepository(fixture.store);
    const router = new DaemonToolRouter(fixture.local, fixture.registry, fixture.workers, fixture.sessions, undefined, undefined, {
      runs: new TestRunRepository(fixture.store), events, enabled: true, safetyProfile: "safe",
      client: { async powercycle(request) {
        calls.push(`ble:${request.reason}:${request.mode}`);
        return { device: "lab_power", status: "manual_required", trigger: request.reason, protocol_verified: false, physical_state: null };
      } }
    });
    await router.invokeTool("c2000_createDebugSession", { boardId: "board-a", sessionName: "power-recovery", coreMap: [{ coreId: 0 }, { coreId: 2 }] });
    const result = await router.invokeTool("c2000_cycleBoardPower", {
      boardId: "board-a", sessionId: "dbg-power", reason: "connection_recovery", mode: "manual",
      firstFailure: { operation: "connectCores", code: "TargetConnectFailed", message: "first failure", observedAt: new Date().toISOString() }
    });

    expect(result).toMatchObject({ status: "manual_required", success: false, oldSessionClosed: true, oldLeaseReleased: true, coldStartVerified: false });
    expect(calls).toEqual(["c2000_createDebugSession", "c2000_closeDebugSession", "ble:connection_recovery:manual"]);
    expect(events.list({ boardId: "board-a" }).map(event => event.eventType)).toContain("POWER_CYCLE_FIRST_FAILURE");
    expect(fixture.sessions.get("dbg-power")?.status).toBe("CLOSED");
    expect(fixture.registry.leases.active("board-a")).toBeUndefined();
    expect(fixture.registry.get("board-a").status).toBe("QUARANTINED");
    expect(fixture.registry.targetIdentity("board-a")).toMatchObject({ status: "UNKNOWN", requiresVerificationAfterPowerCycle: true });

    const confirmed = await router.invokeTool("c2000_confirmManualPowerCycle", {
      boardId: "board-a", requestId: result.requestId, powerRemovedAndRestored: true, observedOffSeconds: 5
    });
    expect(confirmed).toMatchObject({ status: "operator_confirmed", coldStartVerified: false, identityVerificationRequired: true });
    expect(fixture.registry.get("board-a").status).toBe("READY");
    await expect(router.invokeTool("c2000_launchResidentIpcDebug", { boardId: "board-a" }))
      .rejects.toMatchObject({ code: "TargetImageIdentityUnknown" });
    fixture.store.close();
  });

  test("refuses after_flash before both current-session writes are verified", async () => {
    const fixture = await makeFixture();
    const programPaths = [path.join(fixture.directory, "cpu1.out"), path.join(fixture.directory, "cpu2.out")];
    await Promise.all(programPaths.map((file, index) => writeFile(file, `cpu${index + 1}`)));
    const calls: string[] = [];
    fixture.workers.invokeBoard = async (_boardId, toolName, input) => {
      calls.push(toolName);
      if (toolName === "c2000_createDebugSession") return { success: true, sessionId: "dbg-flash", cores: [{ coreId: 0 }, { coreId: 2 }] };
      if (toolName === "c2000_getLoadedProgramInfo") return {
        success: true, sessionId: "dbg-flash", coreId: (input as { coreId: number }).coreId,
        programUri: programPaths[0], targetMemoryWritten: false
      };
      throw new Error(`unexpected worker tool ${toolName}`);
    };
    const router = new DaemonToolRouter(fixture.local, fixture.registry, fixture.workers, fixture.sessions, undefined, undefined, {
      runs: new TestRunRepository(fixture.store), events: new EventRepository(fixture.store), enabled: true, safetyProfile: "safe",
      client: { async powercycle() { throw new Error("BLE must not be called"); } }
    });
    await router.invokeTool("c2000_createDebugSession", { boardId: "board-a", coreMap: [{ coreId: 0 }, { coreId: 2 }] });
    await expect(router.invokeTool("c2000_cycleBoardPower", {
      boardId: "board-a", sessionId: "dbg-flash", reason: "after_flash",
      flashChecks: [
        { coreId: 0, programUri: programPaths[0], manifestUri: path.join(fixture.directory, "cpu1.json") },
        { coreId: 2, programUri: programPaths[1], manifestUri: path.join(fixture.directory, "cpu2.json") }
      ]
    })).rejects.toMatchObject({ code: "PowerCycleFlashIncomplete" });
    expect(calls).toEqual(["c2000_createDebugSession", "c2000_getLoadedProgramInfo"]);
    expect(fixture.sessions.get("dbg-flash")?.status).toBe("OPEN");
    expect(fixture.registry.leases.active("board-a")).toBeDefined();
    fixture.store.close();
  });

  test("calls the BLE MCP only after both manifest checks and confirmed session cleanup", async () => {
    const fixture = await makeFixture();
    const checks = await Promise.all([0, 2].map(async coreId => {
      const programUri = path.join(fixture.directory, `cpu${coreId}.out`);
      const manifestUri = path.join(fixture.directory, `cpu${coreId}.json`);
      await writeFile(programUri, `cpu${coreId}-flash-image`);
      await writeFile(manifestUri, JSON.stringify({ format: "c2000-resident-image-manifest", version: 1 }));
      return { coreId, programUri, manifestUri, programSha256: await sha256File(programUri), manifestSha256: await sha256File(manifestUri) };
    }));
    const calls: string[] = [];
    fixture.workers.invokeBoard = async (_boardId, toolName, input) => {
      calls.push(toolName);
      if (toolName === "c2000_createDebugSession") return { success: true, sessionId: "dbg-verified", cores: [{ coreId: 0 }, { coreId: 2 }] };
      if (toolName === "c2000_getLoadedProgramInfo") {
        const check = checks.find(item => item.coreId === (input as { coreId: number }).coreId)!;
        return { success: true, sessionId: "dbg-verified", coreId: check.coreId, programUri: check.programUri, sha256: check.programSha256, targetMemoryWritten: true };
      }
      if (toolName === "c2000_verifyResidentImage") return {
        success: true, verified: true, verificationMethod: "resident-image-manifest-raw-memory",
        targetAccess: { programming: false, symbolLoad: false, reset: false, run: false, targetMemoryWrite: false },
        checks: checks.map(check => ({ ...check, marker: { matched: true } }))
      };
      if (toolName === "c2000_closeDebugSession") return { success: true, sessionId: "dbg-verified", closed: true };
      throw new Error(`unexpected worker tool ${toolName}`);
    };
    const router = new DaemonToolRouter(fixture.local, fixture.registry, fixture.workers, fixture.sessions, undefined, undefined, {
      runs: new TestRunRepository(fixture.store), events: new EventRepository(fixture.store), enabled: true, safetyProfile: "safe",
      client: { async powercycle(request) {
        calls.push("ble-powercycle");
        expect(request).toMatchObject({ device: "lab_power", off_seconds: 5, reason: "after_flash", mode: "auto_or_manual" });
        expect(fixture.registry.leases.active("board-a")).toBeUndefined();
        return { device: "lab_power", status: "completed", trigger: "after_flash", mode_used: "auto", off_hold_seconds: 5.1, protocol_verified: true, physical_state: null };
      } }
    });
    await router.invokeTool("c2000_createDebugSession", { boardId: "board-a", coreMap: [{ coreId: 0 }, { coreId: 2 }] });
    const result = await router.invokeTool("c2000_cycleBoardPower", {
      boardId: "board-a", sessionId: "dbg-verified", reason: "after_flash",
      flashChecks: checks.map(({ coreId, programUri, manifestUri }) => ({ coreId, programUri, manifestUri }))
    });
    expect(calls).toEqual(["c2000_createDebugSession", "c2000_getLoadedProgramInfo", "c2000_getLoadedProgramInfo", "c2000_verifyResidentImage", "c2000_closeDebugSession", "ble-powercycle"]);
    expect(result).toMatchObject({ status: "completed", success: true, protocolVerified: true, physicalState: null, coldStartVerified: false, targetImageIdentity: "UNKNOWN" });
    expect(fixture.registry.targetIdentity("board-a")).toMatchObject({ status: "UNKNOWN", requiresVerificationAfterPowerCycle: true });
    fixture.store.close();
  });
});

describe("daemon tool router interactive session lifecycle", () => {
  test("preserves resident image identity across a new MCP lease", async () => {
    const fixture = await makeFixture();
    const programPath = path.join(fixture.directory, "cpu1.out");
    await writeFile(programPath, "cpu1-image-v1");
    const programSha256 = await sha256File(programPath);
    fixture.sessions.upsert({
      sessionId: "dbg-image",
      boardId: "board-a",
      workerInstanceId: "worker-1",
      sessionName: "image-identity",
      coreMap: [{ coreId: 0, coreName: "C28xx_CPU1" }],
      status: "OPEN",
      createdAt: new Date().toISOString()
    });
    fixture.registry.recordTargetPrograms("board-a", [{
      coreId: 0,
      programUri: programPath,
      sha256: programSha256
    }]);
    const lease = fixture.registry.leases.acquire({
      boardId: "board-a",
      ownerJobId: "new-observer",
      workerInstanceId: "worker-1",
      ttlMs: 60_000
    });
    expect(fixture.registry.targetIdentity("board-a")).toEqual(expect.objectContaining({
      status: "KNOWN",
      programs: { "0": expect.objectContaining({ coreId: 0, sha256: programSha256 }) }
    }));

    const router = new DaemonToolRouter(fixture.local, fixture.registry, fixture.workers, fixture.sessions);
    fixture.workers.invokeBoard = async () => ({ success: true, sessionId: "dbg-image", coreId: 0 });
    await expect(router.invokeTool("c2000_loadSymbols", {
      sessionId: "dbg-image",
      coreId: 0,
      programUri: programPath
    })).resolves.toEqual(expect.objectContaining({ success: true, coreId: 0 }));

    // A real target-side uncertainty event still fails closed under the
    // require-known policy; the lease itself is not such an event.
    fixture.registry.markTargetIdentityUnknown("board-a", "external-target-access");
    await expect(router.invokeTool("c2000_runResidentIpcDebug", {
      sessionId: "dbg-image",
      cpu1CoreId: 0,
      cpu2CoreId: 2,
      cpu1OutPath: programPath,
      cpu2OutPath: programPath,
      cpu1MapPath: path.join(fixture.directory, "cpu1.map"),
      cpu2MapPath: path.join(fixture.directory, "cpu2.map"),
      residentIdentityPolicy: "require-known"
    })).rejects.toMatchObject({ code: "TargetImageIdentityUnknown" });
    await expect(router.invokeTool("c2000_launchResidentIpcDebug", {
      boardId: "board-a",
      __leaseContext: lease.context,
      cpu1CoreId: 0,
      cpu2CoreId: 2,
      cpu1OutPath: programPath,
      cpu2OutPath: programPath,
      cpu1MapPath: path.join(fixture.directory, "cpu1.map"),
      cpu2MapPath: path.join(fixture.directory, "cpu2.map"),
      residentIdentityPolicy: "require-known"
    })).rejects.toMatchObject({ code: "TargetImageIdentityUnknown" });
    fixture.workers.invokeBoard = async () => ({ success: true, sessionId: "dbg-image", workflow: "c2000_launchResidentIpcDebug" });
    await expect(router.invokeTool("c2000_launchResidentIpcDebug", {
      boardId: "board-a",
      __leaseContext: lease.context,
      cpu1CoreId: 0,
      cpu2CoreId: 2,
      cpu1OutPath: programPath,
      cpu2OutPath: programPath,
      cpu1MapPath: path.join(fixture.directory, "cpu1.map"),
      cpu2MapPath: path.join(fixture.directory, "cpu2.map")
    })).resolves.toEqual(expect.objectContaining({ success: true, workflow: "c2000_launchResidentIpcDebug" }));

    fixture.registry.recordTargetPrograms("board-a", [{
      coreId: 0,
      programUri: programPath,
      sha256: programSha256
    }]);
    fixture.workers.invokeBoard = async () => ({ success: true, sessionId: "dbg-image", coreId: 0 });
    await expect(router.invokeTool("c2000_loadSymbols", {
      sessionId: "dbg-image",
      coreId: 0,
      programUri: programPath
    })).resolves.toEqual(expect.objectContaining({ success: true }));

    await writeFile(programPath, "cpu1-image-v2");
    await expect(router.invokeTool("c2000_loadSymbols", {
      sessionId: "dbg-image",
      coreId: 0,
      programUri: programPath
    })).rejects.toMatchObject({ code: "TargetImageMismatch" });
    fixture.registry.leases.release(lease.lease.leaseId, lease.leaseToken);
    fixture.store.close();
  });

  test("records direct single-core program loads as resident-image evidence", async () => {
    const fixture = await makeFixture();
    const programPath = path.join(fixture.directory, "cpu1.out");
    await writeFile(programPath, "cpu1-image");
    const programSha256 = await sha256File(programPath);
    fixture.sessions.upsert({
      sessionId: "dbg-load",
      boardId: "board-a",
      workerInstanceId: "worker-1",
      sessionName: "program-load",
      coreMap: [{ coreId: 0, coreName: "C28xx_CPU1" }],
      status: "OPEN",
      createdAt: new Date().toISOString()
    });
    const router = new DaemonToolRouter(fixture.local, fixture.registry, fixture.workers, fixture.sessions);
    fixture.workers.invokeBoard = async () => ({
      success: true,
      sessionId: "dbg-load",
      coreId: 0,
      programUri: programPath,
      sha256: programSha256
    });
    await router.invokeTool("c2000_loadProgram", {
      sessionId: "dbg-load",
      coreId: 0,
      programUri: programPath
    });
    expect(fixture.registry.targetIdentity("board-a")).toEqual(expect.objectContaining({
      status: "KNOWN",
      programs: { "0": expect.objectContaining({ coreId: 0, sha256: programSha256 }) }
    }));
    fixture.store.close();
  });

  test("records a complete manifest-bound resident-image verification without treating it as a program load", async () => {
    const fixture = await makeFixture();
    const programPath = path.join(fixture.directory, "cpu1.out");
    const manifestPath = path.join(fixture.directory, "cpu1.resident-image.json");
    await writeFile(programPath, "cpu1-image-v1");
    const programSha256 = await sha256File(programPath);
    await writeFile(manifestPath, JSON.stringify({
      format: "c2000-resident-image-manifest",
      version: 1,
      programSha256,
      identity: { address: "0x1000", page: "DATA", typeSize: 32, expectedValue: 0xA5A5A5A5 }
    }));
    const manifestSha256 = await sha256File(manifestPath);
    fixture.sessions.upsert({
      sessionId: "dbg-verify",
      boardId: "board-a",
      workerInstanceId: "worker-1",
      sessionName: "resident-image-verification",
      coreMap: [{ coreId: 0, coreName: "C28xx_CPU1" }],
      status: "OPEN",
      createdAt: new Date().toISOString()
    });
    fixture.workers.invokeBoard = async () => ({
      success: true,
      sessionId: "dbg-verify",
      verified: true,
      verificationMethod: "resident-image-manifest-raw-memory",
      targetAccess: {
        programming: false,
        symbolLoad: false,
        reset: false,
        run: false,
        targetMemoryWrite: false
      },
      checks: [{
        coreId: 0,
        programUri: programPath,
        manifestUri: manifestPath,
        programSha256,
        manifestSha256,
        marker: { matched: true }
      }]
    });
    const router = new DaemonToolRouter(fixture.local, fixture.registry, fixture.workers, fixture.sessions);

    await expect(router.invokeTool("c2000_verifyResidentImage", {
      sessionId: "dbg-verify",
      checks: [{ coreId: 0, programUri: programPath, manifestUri: manifestPath }]
    })).resolves.toEqual(expect.objectContaining({ success: true, verified: true }));
    expect(fixture.registry.targetIdentity("board-a")).toEqual(expect.objectContaining({
      status: "KNOWN",
      reason: "resident-image-verification",
      programs: { "0": expect.objectContaining({ coreId: 0, sha256: programSha256 }) }
    }));
    fixture.store.close();
  });

  test("lets a resident workflow establish UNKNOWN identity from inline manifest evidence", async () => {
    const fixture = await makeFixture();
    const cpu1Path = path.join(fixture.directory, "cpu1.out");
    const cpu2Path = path.join(fixture.directory, "cpu2.out");
    const cpu1ManifestPath = path.join(fixture.directory, "cpu1.resident-image.json");
    const cpu2ManifestPath = path.join(fixture.directory, "cpu2.resident-image.json");
    await writeFile(cpu1Path, "cpu1-image-v1");
    await writeFile(cpu2Path, "cpu2-image-v1");
    const cpu1Sha256 = await sha256File(cpu1Path);
    const cpu2Sha256 = await sha256File(cpu2Path);
    await writeFile(cpu1ManifestPath, JSON.stringify({
      format: "c2000-resident-image-manifest",
      version: 1,
      programSha256: cpu1Sha256,
      identity: { address: "0x1000", page: "DATA", typeSize: 32, expectedValue: 0xA5A5A5A5 }
    }));
    await writeFile(cpu2ManifestPath, JSON.stringify({
      format: "c2000-resident-image-manifest",
      version: 1,
      programSha256: cpu2Sha256,
      identity: { address: "0x1004", page: "DATA", typeSize: 32, expectedValue: 0xA5A5A5A5 }
    }));
    const cpu1ManifestSha256 = await sha256File(cpu1ManifestPath);
    const cpu2ManifestSha256 = await sha256File(cpu2ManifestPath);
    fixture.workers.invokeBoard = async () => ({
      success: true,
      workflow: "c2000_launchResidentIpcDebug",
      residentVerification: {
        success: true,
        verified: true,
        verificationMethod: "resident-image-manifest-raw-memory",
        targetAccess: {
          programming: false,
          symbolLoad: false,
          reset: false,
          run: false,
          targetMemoryWrite: false
        },
        checks: [
          { coreId: 0, programUri: cpu1Path, manifestUri: cpu1ManifestPath, programSha256: cpu1Sha256, manifestSha256: cpu1ManifestSha256, marker: { matched: true } },
          { coreId: 2, programUri: cpu2Path, manifestUri: cpu2ManifestPath, programSha256: cpu2Sha256, manifestSha256: cpu2ManifestSha256, marker: { matched: true } }
        ]
      }
    });
    const router = new DaemonToolRouter(fixture.local, fixture.registry, fixture.workers, fixture.sessions);

    await expect(router.invokeTool("c2000_launchResidentIpcDebug", {
      boardId: "board-a",
      cpu1CoreId: 0,
      cpu2CoreId: 2,
      cpu1OutPath: cpu1Path,
      cpu2OutPath: cpu2Path,
      residentImageManifests: [
        { coreId: 0, manifestUri: cpu1ManifestPath },
        { coreId: 2, manifestUri: cpu2ManifestPath }
      ]
    })).resolves.toEqual(expect.objectContaining({ success: true, workflow: "c2000_launchResidentIpcDebug" }));
    expect(fixture.registry.targetIdentity("board-a")).toEqual(expect.objectContaining({
      status: "KNOWN",
      reason: "resident-image-verification",
      programs: {
        "0": expect.objectContaining({ coreId: 0, sha256: cpu1Sha256 }),
        "2": expect.objectContaining({ coreId: 2, sha256: cpu2Sha256 })
      }
    }));
    fixture.store.close();
  });

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

  test("automatically finalizes a failed interactive acceptance session and releases its lease", async () => {
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

    expect(launched).toEqual(expect.objectContaining({
      success: false,
      sessionId: "dbg-failed",
      cleanedUp: true,
      cleanup: expect.objectContaining({ closeConfirmed: true, sessionClosed: true })
    }));
    expect(fixture.sessions.get("dbg-failed")).toBeUndefined();
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
      cleanupOnFailure: false,
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

  test("closes an older resident session before taking the next board lease", async () => {
    const fixture = await makeFixture();
    const calls: string[] = [];
    fixture.workers.invokeBoard = async (_boardId: string, toolName: string, input: unknown) => {
      calls.push(toolName);
      if (toolName === "c2000_closeDebugSession") {
        const sessionId = (input as { sessionId?: string }).sessionId;
        return { success: true, sessionId, closed: true };
      }
      return { success: true, sessionId: calls.filter(call => call === "c2000_launchResidentIpcDebug").length === 1 ? "dbg-resident-1" : "dbg-resident-2", workflow: "c2000_launchResidentIpcDebug" };
    };
    const router = new DaemonToolRouter(fixture.local, fixture.registry, fixture.workers, fixture.sessions);
    const input = {
      boardId: "board-a",
      sessionName: "launch-resident-ipc-debug",
      sessionMode: "interactive",
      cpu1CoreId: 0,
      cpu2CoreId: 2,
      cpu1OutPath: "cpu1.out",
      cpu2OutPath: "cpu2.out"
    };

    await router.invokeTool("c2000_launchResidentIpcDebug", input);
    await router.invokeTool("c2000_launchResidentIpcDebug", input);

    expect(calls).toEqual([
      "c2000_launchResidentIpcDebug",
      "c2000_closeDebugSession",
      "c2000_launchResidentIpcDebug"
    ]);
    expect(fixture.sessions.get("dbg-resident-1")).toEqual(expect.objectContaining({ status: "CLOSED" }));
    expect(fixture.sessions.get("dbg-resident-2")).toEqual(expect.objectContaining({ status: "OPEN" }));
    fixture.store.close();
  });

  test("recovers an expired resident lease through the current worker before queueing a new request", async () => {
    const fixture = await makeFixture();
    const calls: string[] = [];
    fixture.sessions.upsert({
      sessionId: "dbg-stale-resident",
      boardId: "board-a",
      workerInstanceId: "worker-1",
      sessionName: "launch-resident-ipc-debug",
      coreMap: [{ coreId: 0, coreName: "C28xx_CPU1" }, { coreId: 2, coreName: "C28xx_CPU2" }],
      status: "OPEN",
      createdAt: new Date().toISOString()
    });
    fixture.workers.invokeBoard = async (_boardId: string, toolName: string) => {
      calls.push(toolName);
      return { success: true, sessionId: "dbg-new-resident", workflow: "c2000_launchResidentIpcDebug" };
    };
    (fixture.workers as unknown as {
      closeStaleResidentSession: (boardId: string, sessionId: string, workerInstanceId: string, timeoutMs: number) => Promise<Record<string, unknown>>;
    }).closeStaleResidentSession = async (_boardId, sessionId, workerInstanceId, timeoutMs) => {
      calls.push(`stale:${sessionId}:${workerInstanceId}:${timeoutMs}`);
      return {
        success: true,
        sessionId,
        closed: true,
        recovery: { targetAccessAttempted: false, targetMemoryWritten: false, executionControlIssued: false }
      };
    };
    const router = new DaemonToolRouter(fixture.local, fixture.registry, fixture.workers, fixture.sessions);

    await expect(router.invokeTool("c2000_launchResidentIpcDebug", {
      boardId: "board-a",
      sessionName: "launch-resident-ipc-debug",
      sessionMode: "interactive",
      cpu1CoreId: 0,
      cpu2CoreId: 2,
      cpu1OutPath: "cpu1.out",
      cpu2OutPath: "cpu2.out"
    })).resolves.toEqual(expect.objectContaining({ success: true, sessionId: "dbg-new-resident" }));

    expect(calls[0]).toMatch(/^stale:dbg-stale-resident:worker-1:/);
    expect(calls[1]).toBe("c2000_launchResidentIpcDebug");
    expect(fixture.sessions.get("dbg-stale-resident")).toEqual(expect.objectContaining({ status: "CLOSED" }));
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
  return { directory, store, registry, sessions, local, workers };
}
