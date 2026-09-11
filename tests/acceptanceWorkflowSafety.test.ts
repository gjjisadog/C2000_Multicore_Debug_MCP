import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { MockDebugAdapter } from "../src/adapters/MockDebugAdapter.js";
import type { AdapterSession } from "../src/adapters/types.js";
import type { CoreId, EvaluateResult } from "../src/debug/types.js";
import { DebugSessionManager } from "../src/debug/DebugSessionManager.js";
import { LoadedProgramRegistry } from "../src/debug/LoadedProgramRegistry.js";
import { createToolHandlers } from "../src/mcp/toolHandlers.js";

const coreMap = [
  { coreId: 0, coreName: "C28xx_CPU1" },
  { coreId: 2, coreName: "C28xx_CPU2" }
];

const temporaryDirectories: string[] = [];
const openSessions: Array<{ manager: DebugSessionManager; sessionId: string }> = [];

class ExpressionRecordingAdapter extends MockDebugAdapter {
  readonly expressionCores: CoreId[] = [];

  override async evaluateExpressions(session: AdapterSession, coreId: CoreId, expressions: string[]): Promise<EvaluateResult[]> {
    this.expressionCores.push(coreId);
    return super.evaluateExpressions(session, coreId, expressions);
  }
}

afterEach(async () => {
  for (const { manager, sessionId } of openSessions.splice(0).reverse()) {
    try { await manager.closeDebugSession(sessionId); } catch { /* The workflow may already have closed it. */ }
  }
  for (const directory of temporaryDirectories.splice(0).reverse()) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function launchInput(directory: string, includeEntrySection = false) {
  const paths = {
    cpu1OutPath: path.join(directory, "cpu1.out"),
    cpu2OutPath: path.join(directory, "cpu2.out"),
    cpu1MapPath: path.join(directory, "cpu1.map"),
    cpu2MapPath: path.join(directory, "cpu2.map")
  };
  await writeFile(paths.cpu1OutPath, "cpu1-image");
  await writeFile(paths.cpu2OutPath, "cpu2-image");
  await writeFile(paths.cpu1MapPath, includeEntrySection
    ? "MEMORY CONFIGURATION\n  RAMLS0  00008000 00000800 00000000 00000800 RWIX\nSECTION ALLOCATION MAP\n.text      0    00008000    00000100\n"
    : "MEMORY CONFIGURATION\n  RAMLS0  00008000 00000800 00000000 00000800 RWIX\n");
  await writeFile(paths.cpu2MapPath, "MEMORY CONFIGURATION\n  RAMGS4  00018000 00002000 00000000 00002000 RWIX\n");
  return {
    device: "F28P65x",
    cpu1CoreId: 0,
    cpu2CoreId: 2,
    ...paths,
    resetType: "cpu" as const,
    runSequence: { runMode: "cpu1_boots_cpu2" as const, runCpu1First: true, runCpu2: false, settleMs: 0 },
    timeoutMs: 20,
    intervalMs: 1,
    applicationEntryTimeoutMs: 5
  };
}

describe("launch acceptance cleanup and entry gate", () => {
  test("cleans a failed interactive launch by default and returns the cleanup evidence", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "c2000-launch-cleanup-"));
    temporaryDirectories.push(directory);
    const manager = new DebugSessionManager(new MockDebugAdapter(), new LoadedProgramRegistry());
    const handlers = createToolHandlers(manager);

    const result = await handlers.launchAndRunIpcAcceptance({
      ...(await launchInput(directory)),
      sessionMode: "interactive"
    });

    expect(result).toEqual(expect.objectContaining({
      success: false,
      cleanedUp: true,
      sessionId: expect.stringMatching(/^dbg-/),
      error: expect.objectContaining({
        code: "PostLaunchCheckFailed",
        details: expect.objectContaining({
          cause: expect.objectContaining({ code: "ApplicationEntryNotConfigured" }),
          launch: expect.objectContaining({ cleanedUp: true }),
          cleanup: expect.objectContaining({ sessionClosed: true, probeLeaseReleased: true })
        })
      })
    }));

    await expect(manager.getSessionTopology(result.sessionId)).rejects.toMatchObject({ code: "SessionNotFound" });
  });

  test("can explicitly preserve an interactive failed launch for recovery", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "c2000-launch-preserve-"));
    temporaryDirectories.push(directory);
    const manager = new DebugSessionManager(new MockDebugAdapter(), new LoadedProgramRegistry());
    const handlers = createToolHandlers(manager);

    const result = await handlers.launchAndRunIpcAcceptance({
      ...(await launchInput(directory)),
      sessionMode: "interactive",
      cleanupOnFailure: false
    });
    openSessions.push({ manager, sessionId: result.sessionId });

    expect(result).toEqual(expect.objectContaining({
      success: false,
      cleanedUp: false,
      sessionId: expect.stringMatching(/^dbg-/),
      error: expect.objectContaining({
        details: expect.objectContaining({
          launch: expect.objectContaining({ preservedForRecovery: true, cleanedUp: false }),
          cleanup: expect.objectContaining({ sessionClosed: false })
        })
      })
    }));
    await expect(manager.getSessionTopology(result.sessionId)).resolves.toEqual(expect.objectContaining({ sessionId: result.sessionId }));
  });

  test("does not reconnect or poll CPU2 when CPU1 never reaches application code", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "c2000-entry-gate-"));
    temporaryDirectories.push(directory);
    const adapter = new ExpressionRecordingAdapter();
    const manager = new DebugSessionManager(adapter, new LoadedProgramRegistry());
    const handlers = createToolHandlers(manager);
    const created = await handlers.createDebugSession({ sessionName: "entry-gate", coreMap });
    openSessions.push({ manager, sessionId: created.sessionId });
    await handlers.connectCores({ sessionId: created.sessionId, coreIds: [0, 2] });
    const input = await launchInput(directory, true);

    const result = await handlers.runIpcAcceptance({
      ...input,
      sessionId: created.sessionId,
      ipcReadyExpressions: [{ coreId: 0, expression: "ipc.ready", expected: 1 }]
    });

    expect(result).toEqual(expect.objectContaining({
      success: false,
      error: expect.objectContaining({
        code: "ApplicationEntryNotReached",
        details: expect.objectContaining({
          diagnosisCode: "APPLICATION_ENTRY_NOT_REACHED",
          ipcReadySkipped: true,
          startupEvidence: expect.objectContaining({
            targetAccessPolicy: "cpu1-only-after-cpu2-disconnect",
            cpu2: expect.objectContaining({ targetOperationsSuppressed: true })
          })
        })
      })
    }));
    expect(adapter.expressionCores).not.toContain(2);
    await expect(manager.getTargetState(created.sessionId, 2)).resolves.toEqual(expect.objectContaining({
      coreId: 2,
      connected: false,
      state: "Disconnected"
    }));
  });
});
