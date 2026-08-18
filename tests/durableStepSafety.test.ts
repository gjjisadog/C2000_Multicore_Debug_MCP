import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { BoardRegistry } from "../src/boards/BoardRegistry.js";
import { TestJobEngine } from "../src/jobs/TestJobEngine.js";
import type { BoardWorkerRoute } from "../src/boards/BoardWorkerSupervisor.js";
import type { JobArtifactSnapshotService } from "../src/artifacts/JobArtifactSnapshotService.js";
import type { C2000ToolInvoker } from "../src/mcp/tools.js";
import { SqliteStore } from "../src/storage/SqliteStore.js";
import { ArtifactRepository } from "../src/storage/repositories/ArtifactRepository.js";
import { BoardRepository } from "../src/storage/repositories/BoardRepository.js";
import { EventRepository } from "../src/storage/repositories/EventRepository.js";
import { LeaseRepository } from "../src/storage/repositories/LeaseRepository.js";
import { TestRunRepository } from "../src/storage/repositories/TestRunRepository.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe("durable step cleanup and output safety", () => {
  test("retries structured cleanup failure in finally before releasing the lease", async () => {
    let closeCalls = 0;
    const fixture = await createFixture({
      async invokeTool(toolName) {
        if (toolName === "c2000_launchMulticoreDebug") return { success: true, sessionId: "dbg-current" };
        if (toolName === "c2000_closeDebugSession") {
          closeCalls += 1;
          return closeCalls === 1 ? { success: false, sessionId: "dbg-current" } : { success: true, sessionId: "dbg-current", closed: true };
        }
        throw new Error(`unexpected tool ${toolName}`);
      }
    });
    const jobId = String(fixture.engine.submit(planWithCleanup()).jobId);
    const terminal = await waitForTerminal(fixture.runs, jobId);
    expect(terminal.status).toBe("FAILED");
    expect(closeCalls).toBe(2);
    expect(fixture.registry.leases.active("board-a")).toBeUndefined();
    expect(fixture.registry.get("board-a").status).not.toBe("QUARANTINED");
    await fixture.engine.stop();
    fixture.store.close();
  });

  test("quarantines ownership-uncertain board when explicit and finally cleanup both fail", async () => {
    let closeCalls = 0;
    const fixture = await createFixture({
      async invokeTool(toolName) {
        if (toolName === "c2000_launchMulticoreDebug") return { success: true, sessionId: "dbg-current" };
        if (toolName === "c2000_closeDebugSession") {
          closeCalls += 1;
          return { success: false, sessionId: "dbg-current", error: { code: "WorkerUnavailable" } };
        }
        throw new Error(`unexpected tool ${toolName}`);
      }
    });
    const jobId = String(fixture.engine.submit(planWithCleanup()).jobId);
    const terminal = await waitForTerminal(fixture.runs, jobId);
    expect(terminal.status).toBe("FAILED");
    expect(closeCalls).toBe(2);
    expect(fixture.registry.get("board-a")).toEqual(expect.objectContaining({ status: "QUARANTINED", lastError: expect.objectContaining({ code: "JobSessionCleanupFailed", sessionId: "dbg-current" }) }));
    expect(fixture.registry.leases.active("board-a")).toBeUndefined();
    expect(fixture.events.list({ jobId })).toEqual(expect.arrayContaining([expect.objectContaining({ eventType: "JOB_SESSION_CLEANUP_FAILED" })]));
    await fixture.engine.stop();
    fixture.store.close();
  });

  test("fails closed before persisting an oversized runtime expression result", async () => {
    const fixture = await createFixture({
      async invokeTool(toolName) {
        if (toolName === "c2000_launchMulticoreDebug") return { success: true, sessionId: "dbg-current" };
        if (toolName === "c2000_evaluateMany") return { success: true, results: [{ expression: "g_x", success: true, value: "x".repeat(2 * 1024 * 1024) }] };
        if (toolName === "c2000_closeDebugSession") return { success: true, sessionId: "dbg-current", closed: true };
        throw new Error(`unexpected tool ${toolName}`);
      }
    });
    const jobId = String(fixture.engine.submit({
      planVersion: 1, name: "bounded-output", boardIds: ["board-a"],
      steps: [{ type: "launchMulticore", loadPrograms: false }, { type: "captureExpressions", reads: [{ coreId: 0, expressions: ["g_x"] }] }]
    }).jobId);
    const terminal = await waitForTerminal(fixture.runs, jobId);
    expect(terminal.status).toBe("FAILED");
    expect(fixture.runs.steps(jobId)[1]).toEqual(expect.objectContaining({ status: "FAILED", error: expect.objectContaining({ code: "EvidenceLimitExceeded" }) }));
    expect(fixture.registry.leases.active("board-a")).toBeUndefined();
    await fixture.engine.stop();
    fixture.store.close();
  });

  test("fails the durable job when a capture contains an unreadable expression", async () => {
    const fixture = await createFixture({
      async invokeTool(toolName) {
        if (toolName === "c2000_launchMulticoreDebug") return { success: true, sessionId: "dbg-current" };
        if (toolName === "c2000_evaluateMany") return {
          success: true,
          results: [{ expression: "g_unreadable", success: false, error: { code: "ExpressionEvaluationFailed", message: "simulated CCS evaluator failure" } }]
        };
        if (toolName === "c2000_closeDebugSession") return { success: true, sessionId: "dbg-current", closed: true };
        throw new Error(`unexpected tool ${toolName}`);
      }
    });
    const jobId = String(fixture.engine.submit({
      planVersion: 1,
      name: "capture-expression-fail-closed",
      boardIds: ["board-a"],
      steps: [{ type: "launchMulticore", loadPrograms: false }, { type: "captureExpressions", reads: [{ coreId: 0, expressions: ["g_unreadable"] }] }]
    }).jobId);
    expect((await waitForTerminal(fixture.runs, jobId)).status).toBe("FAILED");
    expect(fixture.runs.steps(jobId)[1]).toEqual(expect.objectContaining({
      status: "FAILED",
      error: expect.objectContaining({
        code: "ExpressionCaptureFailed",
        details: expect.objectContaining({ failures: [expect.objectContaining({ expression: "g_unreadable" })] })
      })
    }));
    expect(fixture.registry.leases.active("board-a")).toBeUndefined();
    await fixture.engine.stop();
    fixture.store.close();
  });

  test("enforces the aggregate evidence budget across all boards in one job", async () => {
    const largeValue = "x".repeat(1_500_000);
    const fixture = await createFixture({
      async invokeTool(toolName) {
        if (toolName === "c2000_launchMulticoreDebug") return { success: true, sessionId: "dbg-current" };
        if (toolName === "c2000_evaluateMany") return { success: true, results: [{ expression: "g_x", success: true, value: largeValue }] };
        if (toolName === "c2000_closeDebugSession") return { success: true, sessionId: "dbg-current", closed: true };
        throw new Error(`unexpected tool ${toolName}`);
      }
    }, ["board-a", "board-b"]);
    const jobId = String(fixture.engine.submit({
      planVersion: 1,
      name: "cross-board-evidence-budget",
      boardIds: ["board-a", "board-b"],
      parallelism: 2,
      failurePolicy: { continueHealthyBoards: false, quarantineFailedBoard: false, collectDebugBundle: false },
      steps: [
        { type: "launchMulticore", loadPrograms: false },
        ...Array.from({ length: 3 }, (_, index) => ({ type: "captureExpressions", label: `capture-${index}`, reads: [{ coreId: 0, expressions: ["g_x"] }] }))
      ]
    }).jobId);
    const terminal = await waitForTerminal(fixture.runs, jobId);
    expect(terminal.status).toBe("FAILED");
    expect(fixture.runs.steps(jobId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "FAILED", error: expect.objectContaining({ code: "EvidenceLimitExceeded" }) })
    ]));
    await fixture.engine.stop();
    fixture.store.close();
  });

  test("allows a legal near-limit multi-board job to finish and export terminal evidence", async () => {
    const largeValue = "x".repeat(1_300_000);
    const exported: string[] = [];
    const fixture = await createFixture({
      async invokeTool(toolName) {
        if (toolName === "c2000_launchMulticoreDebug") return { success: true, sessionId: "dbg-current" };
        if (toolName === "c2000_evaluateMany") return { success: true, results: [{ expression: "g_x", success: true, value: largeValue }] };
        if (toolName === "c2000_closeDebugSession") return { success: true, sessionId: "dbg-current", closed: true };
        throw new Error(`unexpected tool ${toolName}`);
      }
    }, ["board-a", "board-b"], {
      async exportJob(jobId: string) {
        exported.push(jobId);
        return `/artifacts/${jobId}`;
      }
    } as JobArtifactSnapshotService);
    const jobId = String(fixture.engine.submit({
      planVersion: 1,
      name: "legal-cross-board-evidence-budget",
      boardIds: ["board-a", "board-b"],
      parallelism: 2,
      steps: [
        { type: "launchMulticore", loadPrograms: false },
        ...Array.from({ length: 3 }, (_, index) => ({ type: "captureExpressions", label: `capture-${index}`, reads: [{ coreId: 0, expressions: ["g_x"] }] }))
      ]
    }).jobId);
    const terminal = await waitForTerminal(fixture.runs, jobId);
    expect(terminal.status).toBe("PASSED");
    expect(exported).toEqual([jobId]);
    await fixture.engine.stop();
    fixture.store.close();
  });

  test("starts healthy persisted work while isolating an unmigratable legacy run", async () => {
    const fixture = await createFixture({
      async invokeTool(toolName) {
        throw new Error(`unexpected tool ${toolName}`);
      }
    });
    persistQueuedRun(fixture, "run-bad-legacy", {
      planVersion: 1,
      name: "bad-legacy",
      boardIds: ["board-a"],
      steps: [{ type: "unknown-legacy-step", passthrough: true }]
    });
    persistQueuedRun(fixture, "run-healthy", {
      planVersion: 1,
      name: "healthy",
      boardIds: ["board-a"],
      steps: [{ type: "delay", delayMs: 0 }]
    });

    fixture.engine.start();
    const bad = await waitForTerminal(fixture.runs, "run-bad-legacy");
    const healthy = await waitForTerminal(fixture.runs, "run-healthy");
    expect(bad).toEqual(expect.objectContaining({
      status: "NEEDS_MANUAL_INTERVENTION",
      error: expect.objectContaining({ code: "PersistedPlanMigrationFailed" })
    }));
    expect(healthy.status).toBe("PASSED");
    await fixture.engine.stop();
    fixture.store.close();
  });

  test("fails the job and performs a fenced halt on the first safety-guard mismatch", async () => {
    const calls: Array<{ toolName: string; input: Record<string, unknown> }> = [];
    let guardReads = 0;
    const fixture = await createFixture({
      async invokeTool(toolName, input) {
        const record = input as Record<string, unknown>;
        calls.push({ toolName, input: record });
        if (toolName === "c2000_launchMulticoreDebug") return { success: true, sessionId: "dbg-current" };
        if (toolName === "c2000_evaluateMany") {
          guardReads += 1;
          return { success: true, results: [{ expression: "g_safe", success: true, value: guardReads < 3 ? 1 : 0 }] };
        }
        if (toolName === "c2000_haltCores") return { success: true, sessionId: "dbg-current", results: [{ coreId: 0, success: true }, { coreId: 2, success: true }] };
        if (toolName === "c2000_closeDebugSession") return { success: true, sessionId: "dbg-current", closed: true };
        throw new Error(`unexpected tool ${toolName}`);
      }
    });
    const jobId = String(fixture.engine.submit({
      planVersion: 1, name: "guard-fail-closed", boardIds: ["board-a"],
      safetyGuards: { conditions: [{ coreId: 0, expression: "g_safe", operator: "eq", expected: 1 }], haltCoreIds: [0, 2], intervalMs: 1 },
      steps: [{ type: "launchMulticore", loadPrograms: false }, { type: "delay", delayMs: 2 }, { type: "cleanup" }]
    }).jobId);
    const terminal = await waitForTerminal(fixture.runs, jobId);
    expect(terminal.status).toBe("FAILED");
    expect(fixture.runs.steps(jobId)[0]).toEqual(expect.objectContaining({ status: "PASSED" }));
    expect(fixture.runs.steps(jobId)[1]).toEqual(expect.objectContaining({ status: "FAILED", error: expect.objectContaining({ code: "SafetyGuardViolation" }) }));
    const halt = calls.find(call => call.toolName === "c2000_haltCores")!;
    expect(halt.input).toEqual(expect.objectContaining({
      sessionId: "dbg-current",
      coreIds: [0, 2],
      __leaseContext: expect.objectContaining({ leaseId: expect.any(String), leaseToken: expect.any(String), fencingToken: expect.any(Number), leaseGeneration: expect.any(Number) })
    }));
    expect(calls.map(call => call.toolName)).toEqual([
      "c2000_launchMulticoreDebug", "c2000_evaluateMany", "c2000_evaluateMany", "c2000_evaluateMany", "c2000_haltCores", "c2000_closeDebugSession"
    ]);
    await fixture.engine.stop();
    fixture.store.close();
  });

  test("keeps guards active while reset target is readable, pauses on disconnect, and resumes after reconnect", async () => {
    const calls: string[] = [];
    let snapshots = 0;
    const fixture = await createFixture({
      async invokeTool(toolName, input) {
        calls.push(toolName);
        const record = input as Record<string, unknown>;
        if (toolName === "c2000_launchMulticoreDebug") return { success: true, sessionId: "dbg-current" };
        if (toolName === "c2000_getMulticoreSnapshot") {
          snapshots += 1;
          return { success: true, sessionId: "dbg-current", cores: [{ coreId: 0, connected: snapshots < 3, state: snapshots < 3 ? "Halted" : "Disconnected" }] };
        }
        if (toolName === "c2000_evaluateMany") return {
          success: true,
          results: (record.expressions as string[]).map(expression => ({ expression, success: true, value: expression === "g_safe" ? 1 : 3 }))
        };
        if (toolName === "c2000_connectCores") return { success: true, sessionId: "dbg-current", results: [] };
        if (toolName === "c2000_closeDebugSession") return { success: true, sessionId: "dbg-current", closed: true };
        throw new Error(`unexpected tool ${toolName}`);
      }
    });
    const jobId = String(fixture.engine.submit({
      planVersion: 1, name: "guarded-external-reset", boardIds: ["board-a"],
      safetyGuards: { conditions: [{ coreId: 0, expression: "g_safe", expected: 1 }], haltCoreIds: [0], intervalMs: 1 },
      steps: [
        { type: "launchMulticore", loadPrograms: false },
        { type: "reconnectAfterTargetReset", coreIds: [0], timeoutMs: 10, intervalMs: 1, reloadSymbols: false, resetCauseReads: [{ coreId: 0, expressions: ["resetCause"] }] },
        { type: "cleanup" }
      ]
    }).jobId);
    expect((await waitForTerminal(fixture.runs, jobId)).status).toBe("PASSED");
    expect(calls).toEqual([
      "c2000_launchMulticoreDebug",
      "c2000_getMulticoreSnapshot", "c2000_evaluateMany",
      "c2000_getMulticoreSnapshot", "c2000_evaluateMany", "c2000_getMulticoreSnapshot",
      "c2000_connectCores", "c2000_evaluateMany", "c2000_evaluateMany",
      "c2000_evaluateMany", "c2000_closeDebugSession"
    ]);
    await fixture.engine.stop();
    fixture.store.close();
  });

  test("preserves failed launch errors without adopting a cleaned session", async () => {
    const calls: string[] = [];
    const fixture = await createFixture({
      async invokeTool(toolName) {
        calls.push(toolName);
        if (toolName === "c2000_launchMulticoreDebug") return {
          success: false,
          sessionId: "dbg-cleaned",
          cleanedUp: true,
          error: { code: "ProgramLoadFailed", message: "CPU2 program load failed", details: { coreId: 2 } }
        };
        throw new Error(`unexpected tool ${toolName}`);
      }
    });
    const jobId = String(fixture.engine.submit({
      planVersion: 1,
      name: "cleaned-launch-failure",
      boardIds: ["board-a"],
      safetyGuards: { conditions: [{ coreId: 0, expression: "g_safe", expected: 1 }] },
      steps: [{ type: "launchMulticore", loadPrograms: false }]
    }).jobId);
    expect((await waitForTerminal(fixture.runs, jobId)).status).toBe("FAILED");
    expect(fixture.runs.steps(jobId)[0]).toEqual(expect.objectContaining({
      error: expect.objectContaining({
        code: "ProgramLoadFailed",
        message: "CPU2 program load failed",
        details: { coreId: 2 },
        optimization: expect.objectContaining({
          failureSignature: "TARGET_OPERATION_FAILED",
          automaticRetry: "never"
        })
      })
    }));
    expect(fixture.runs.boards(jobId)[0]?.sessionId).toBeUndefined();
    expect(fixture.registry.get("board-a").status).not.toBe("QUARANTINED");
    expect(calls).toEqual(["c2000_launchMulticoreDebug"]);
    await fixture.engine.stop();
    fixture.store.close();
  });

  test("adopts and closes a still-live session from a structured launch failure", async () => {
    const calls: string[] = [];
    const fixture = await createFixture({
      async invokeTool(toolName) {
        calls.push(toolName);
        if (toolName === "c2000_launchMulticoreDebug") return {
          success: false,
          sessionId: "dbg-live",
          cleanedUp: false,
          error: { code: "ProgramLoadFailed", message: "CPU2 program load failed", details: { coreId: 2 } }
        };
        if (toolName === "c2000_closeDebugSession") return { success: true, sessionId: "dbg-live", closed: true };
        throw new Error(`unexpected tool ${toolName}`);
      }
    });
    const jobId = String(fixture.engine.submit({
      planVersion: 1, name: "live-launch-failure", boardIds: ["board-a"],
      safetyGuards: { conditions: [{ coreId: 0, expression: "g_safe", expected: 1 }] },
      steps: [{ type: "launchMulticore", loadPrograms: false }]
    }).jobId);
    expect((await waitForTerminal(fixture.runs, jobId)).status).toBe("FAILED");
    expect(fixture.runs.steps(jobId)[0]).toEqual(expect.objectContaining({
      error: expect.objectContaining({
        code: "ProgramLoadFailed",
        message: "CPU2 program load failed",
        details: { coreId: 2 },
        optimization: expect.objectContaining({
          failureSignature: "TARGET_OPERATION_FAILED",
          automaticRetry: "never"
        })
      })
    }));
    expect(fixture.runs.boards(jobId)[0]?.sessionId).toBeUndefined();
    expect(calls).toEqual(["c2000_launchMulticoreDebug", "c2000_closeDebugSession"]);
    await fixture.engine.stop();
    fixture.store.close();
  });

  test("does not orphan an active session when cleanup is unconfirmed before another launch", async () => {
    const calls: string[] = [];
    let closeCalls = 0;
    const fixture = await createFixture({
      async invokeTool(toolName) {
        calls.push(toolName);
        if (toolName === "c2000_launchMulticoreDebug") return { success: true, sessionId: "dbg-old" };
        if (toolName === "c2000_closeDebugSession") {
          closeCalls += 1;
          return { success: true, sessionId: "dbg-old", closed: closeCalls > 1 };
        }
        throw new Error(`unexpected tool ${toolName}`);
      }
    });
    const jobId = String(fixture.engine.submit({
      planVersion: 1, name: "no-orphaned-session", boardIds: ["board-a"],
      steps: [
        { type: "launchMulticore", loadPrograms: false },
        { type: "cleanup" },
        { type: "launchMulticore", on: "always", loadPrograms: false }
      ]
    }).jobId);
    expect((await waitForTerminal(fixture.runs, jobId)).status).toBe("FAILED");
    expect(fixture.runs.steps(jobId)[1]).toEqual(expect.objectContaining({ error: expect.objectContaining({ code: "WorkflowCleanupFailed" }) }));
    expect(fixture.runs.steps(jobId)[2]).toEqual(expect.objectContaining({ error: expect.objectContaining({ code: "SessionAlreadyOpen" }) }));
    expect(calls).toEqual(["c2000_launchMulticoreDebug", "c2000_closeDebugSession", "c2000_closeDebugSession"]);
    expect(fixture.runs.boards(jobId)[0]?.sessionId).toBeUndefined();
    await fixture.engine.stop();
    fixture.store.close();
  });

  test.each([
    ["closed false", { success: true, sessionId: "dbg-current", closed: false }],
    ["missing closed", { success: true, sessionId: "dbg-current" }],
    ["missing success", { sessionId: "dbg-current", closed: true }],
    ["identity mismatch", { success: true, sessionId: "dbg-other", closed: true }]
  ] as const)("quarantines when explicit and final cleanup both return %s", async (_label, closeResult) => {
    let closeCalls = 0;
    const fixture = await createFixture({
      async invokeTool(toolName) {
        if (toolName === "c2000_launchMulticoreDebug") return { success: true, sessionId: "dbg-current" };
        if (toolName === "c2000_closeDebugSession") {
          closeCalls += 1;
          return { ...closeResult };
        }
        throw new Error(`unexpected tool ${toolName}`);
      }
    });
    const jobId = String(fixture.engine.submit(planWithCleanup()).jobId);
    expect((await waitForTerminal(fixture.runs, jobId)).status).toBe("FAILED");
    expect(closeCalls).toBe(2);
    expect(fixture.runs.steps(jobId)[1]).toEqual(expect.objectContaining({ error: expect.objectContaining({ code: "WorkflowCleanupFailed" }) }));
    expect(fixture.runs.boards(jobId)[0]?.sessionId).toBe("dbg-current");
    expect(fixture.registry.get("board-a")).toEqual(expect.objectContaining({ status: "QUARANTINED", lastError: expect.objectContaining({ code: "JobSessionCleanupFailed" }) }));
    expect(fixture.registry.leases.active("board-a")).toBeUndefined();
    await fixture.engine.stop();
    fixture.store.close();
  });

  test("clears a confirmed session before guarded relaunch without guarding the closed identity", async () => {
    const calls: Array<{ toolName: string; sessionId?: string }> = [];
    let launches = 0;
    const fixture = await createFixture({
      async invokeTool(toolName, input) {
        const values = input as Record<string, unknown>;
        calls.push({ toolName, ...(typeof values.sessionId === "string" ? { sessionId: values.sessionId } : {}) });
        if (toolName === "c2000_launchMulticoreDebug") {
          launches += 1;
          return { success: true, sessionId: `dbg-${launches}` };
        }
        if (toolName === "c2000_evaluateMany") return { success: true, results: [{ expression: "g_safe", success: true, value: 1 }] };
        if (toolName === "c2000_closeDebugSession") return { success: true, sessionId: values.sessionId, closed: true };
        throw new Error(`unexpected tool ${toolName}`);
      }
    });
    const jobId = String(fixture.engine.submit({
      planVersion: 1, name: "guarded-cleanup-relaunch", boardIds: ["board-a"],
      safetyGuards: { conditions: [{ coreId: 0, expression: "g_safe", expected: 1 }] },
      steps: [
        { type: "launchMulticore", loadPrograms: false },
        { type: "cleanup" },
        { type: "launchMulticore", loadPrograms: false },
        { type: "cleanup" }
      ]
    }).jobId);
    expect((await waitForTerminal(fixture.runs, jobId)).status).toBe("PASSED");
    expect(calls).toEqual([
      { toolName: "c2000_launchMulticoreDebug" },
      { toolName: "c2000_closeDebugSession", sessionId: "dbg-1" },
      { toolName: "c2000_launchMulticoreDebug" },
      { toolName: "c2000_closeDebugSession", sessionId: "dbg-2" }
    ]);
    expect(fixture.runs.steps(jobId)[1]?.output).toEqual(expect.objectContaining({ sessionId: "dbg-1", closed: true }));
    expect(fixture.runs.boards(jobId)[0]?.sessionId).toBeUndefined();
    expect(fixture.registry.get("board-a").status).not.toBe("QUARANTINED");
    await fixture.engine.stop();
    fixture.store.close();
  });

  test("quarantines when restore preflight fails and fenced halt cannot be confirmed", async () => {
    const calls: string[] = [];
    const fixture = await createFixture({
      async invokeTool(toolName) {
        calls.push(toolName);
        if (toolName === "c2000_launchMulticoreDebug") return { success: true, sessionId: "dbg-current" };
        if (toolName === "c2000_haltCores") return {
          success: true,
          results: [{ coreId: 0, success: true }, { coreId: 2, success: false, error: { code: "TargetHaltFailed", message: "halt unavailable" } }]
        };
        if (toolName === "c2000_closeDebugSession") return { success: true, sessionId: "dbg-current", closed: true };
        throw new Error(`unexpected tool ${toolName}`);
      }
    });
    const digest = "0".repeat(64);
    const jobId = String(fixture.engine.submit({
      planVersion: 1, name: "restore-preflight-isolation", boardIds: ["board-a"],
      steps: [
        { type: "launchMulticore", loadPrograms: false },
        {
          type: "restorePrograms", on: "always",
          artifacts: {
            cpu1: { coreId: 0, outPath: "/missing/cpu1.out", mapPath: "/missing/cpu1.map", outSha256: digest, mapSha256: digest },
            cpu2: { coreId: 2, outPath: "/missing/cpu2.out", mapPath: "/missing/cpu2.map", outSha256: digest, mapSha256: digest }
          }
        }
      ]
    }).jobId);
    expect((await waitForTerminal(fixture.runs, jobId)).status).toBe("FAILED");
    expect(fixture.runs.steps(jobId)[1]).toEqual(expect.objectContaining({ error: expect.objectContaining({ code: "RestoreProgramsFailed" }) }));
    expect(fixture.registry.get("board-a")).toEqual(expect.objectContaining({ status: "QUARANTINED" }));
    expect(calls).toEqual(["c2000_launchMulticoreDebug", "c2000_haltCores", "c2000_closeDebugSession"]);
    await fixture.engine.stop();
    fixture.store.close();
  });

  test("quarantines the board when a safety-guard halt cannot be confirmed", async () => {
    const fixture = await createFixture({
      async invokeTool(toolName) {
        if (toolName === "c2000_launchMulticoreDebug") return { success: true, sessionId: "dbg-current" };
        if (toolName === "c2000_evaluateMany") return { success: true, results: [{ expression: "g_safe", success: true, value: 0 }] };
        if (toolName === "c2000_haltCores") return { success: false, error: { code: "TargetHaltFailed" } };
        if (toolName === "c2000_closeDebugSession") return { success: true, sessionId: "dbg-current", closed: true };
        throw new Error(`unexpected tool ${toolName}`);
      }
    });
    const jobId = String(fixture.engine.submit({
      planVersion: 1, name: "guard-halt-failed", boardIds: ["board-a"],
      artifacts: { cpu1OutPath: "/fw/cpu1.out", cpu2OutPath: "/fw/cpu2.out", cpu2MapPath: "/fw/cpu2.map" },
      retryPolicy: { launchMulticore: 3 },
      safetyGuards: { conditions: [{ coreId: 0, expression: "g_safe", expected: 1 }], haltCoreIds: [0, 2] },
      steps: [{ type: "launchMulticore", loadPrograms: true }, { type: "cleanup" }]
    }).jobId);
    expect((await waitForTerminal(fixture.runs, jobId)).status).toBe("FAILED");
    expect(fixture.runs.stepAttempts(jobId).filter(attempt => attempt.status === "FAILED")).toEqual([
      expect.objectContaining({ attemptIndex: 1, retryDecision: expect.objectContaining({ retry: false, reason: "SAFETY_GUARD_VIOLATION" }) })
    ]);
    expect(fixture.registry.get("board-a")).toEqual(expect.objectContaining({ status: "QUARANTINED", lastError: expect.objectContaining({ code: "DurableSafetyIsolationFailed" }) }));
    await fixture.engine.stop();
    fixture.store.close();
  });

  test("binds a durable lease to the live worker route instead of the persisted board route", async () => {
    const calls: Array<{ toolName: string; workerInstanceId?: string }> = [];
    const fixture = await createFixture({
      async invokeTool(toolName, input) {
        const leaseContext = input && typeof input === "object" && !Array.isArray(input)
          ? (input as Record<string, unknown>).__leaseContext as Record<string, unknown> | undefined
          : undefined;
        calls.push({ toolName, workerInstanceId: typeof leaseContext?.workerInstanceId === "string" ? leaseContext.workerInstanceId : undefined });
        if (toolName === "c2000_launchMulticoreDebug") return { success: true, sessionId: "dbg-live-route" };
        if (toolName === "c2000_closeDebugSession") return { success: true, sessionId: "dbg-live-route", closed: true };
        throw new Error(`unexpected tool ${toolName}`);
      }
    }, ["board-a"], undefined, async (): Promise<BoardWorkerRoute> => ({ workerInstanceId: "worker-live", workerGeneration: 7 }));
    const jobId = String(fixture.engine.submit({
      planVersion: 1, name: "live-route-lease", boardIds: ["board-a"],
      steps: [{ type: "launchMulticore", loadPrograms: false }]
    }).jobId);
    expect((await waitForTerminal(fixture.runs, jobId)).status).toBe("PASSED");
    expect(calls).toEqual([{ toolName: "c2000_launchMulticoreDebug", workerInstanceId: "worker-live" }, { toolName: "c2000_closeDebugSession", workerInstanceId: "worker-live" }]);
    await fixture.engine.stop();
    fixture.store.close();
  });

  test("fails before target access when the worker route changes after lease acquisition", async () => {
    const calls: string[] = [];
    let routeCalls = 0;
    const fixture = await createFixture({
      async invokeTool(toolName) {
        calls.push(toolName);
        throw new Error(`target access should not occur: ${toolName}`);
      }
    }, ["board-a"], undefined, async (): Promise<BoardWorkerRoute> => {
      routeCalls += 1;
      return routeCalls <= 2
        ? { workerInstanceId: "worker-before", workerGeneration: 1 }
        : { workerInstanceId: "worker-after", workerGeneration: 2 };
    });
    const jobId = String(fixture.engine.submit({
      planVersion: 1, name: "route-change-before-target", boardIds: ["board-a"],
      steps: [{ type: "launchMulticore", loadPrograms: false }]
    }).jobId);
    expect((await waitForTerminal(fixture.runs, jobId)).status).toBe("FAILED");
    expect(fixture.runs.steps(jobId)[0]).toEqual(expect.objectContaining({
      status: "FAILED",
      error: expect.objectContaining({
        code: "LeaseWorkerMismatch",
        details: expect.objectContaining({
          stage: "pre-step",
          targetAccessAttempted: false,
          expectedWorkerInstanceId: "worker-after",
          receivedWorkerInstanceId: "worker-before"
        })
      })
    }));
    expect(calls).toEqual([]);
    await fixture.engine.stop();
    fixture.store.close();
  });
});

function planWithCleanup() {
  return { planVersion: 1, name: "cleanup-state", boardIds: ["board-a"], steps: [{ type: "launchMulticore", loadPrograms: false }, { type: "cleanup" }] };
}

async function createFixture(
  tools: C2000ToolInvoker,
  boardIds = ["board-a"],
  artifactSnapshots?: JobArtifactSnapshotService,
  ensureBoardWorker?: (boardId: string) => Promise<BoardWorkerRoute>
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "c2000-durable-safety-"));
  roots.push(root);
  const store = await SqliteStore.open(path.join(root, "runtime.sqlite"));
  const events = new EventRepository(store);
  const registry = new BoardRegistry(new BoardRepository(store), events, store, new LeaseRepository(store));
  for (const [index, boardId] of boardIds.entries()) {
    registry.register({ boardId, probeSerial: `XDS-${index}`, device: "F28P65x", ccxmlPath: `${boardId}.ccxml`, tags: [] });
    registry.setWorker(boardId, `worker-${index}`);
  }
  const runs = new TestRunRepository(store);
  const workerRouteResolver = ensureBoardWorker ?? (async (boardId: string): Promise<BoardWorkerRoute> => {
    const workerInstanceId = registry.get(boardId).currentWorkerInstanceId;
    if (!workerInstanceId) throw new Error(`fixture worker route missing for ${boardId}`);
    return { workerInstanceId, workerGeneration: 1 };
  });
  const engine = new TestJobEngine({ registry, runs, events, artifacts: new ArtifactRepository(store), tools, ensureBoardWorker: workerRouteResolver, maxParallelBoards: boardIds.length, artifactSnapshots });
  return { root, store, events, registry, runs, engine };
}

function persistQueuedRun(fixture: Awaited<ReturnType<typeof createFixture>>, jobId: string, plan: Record<string, unknown>): void {
  const steps = plan.steps as Array<Record<string, unknown>>;
  const failurePolicy = { continueHealthyBoards: true, quarantineFailedBoard: true, collectDebugBundle: false };
  fixture.runs.create({
    jobId,
    planName: String(plan.name),
    planVersion: 1,
    plan,
    status: "QUEUED",
    progressCurrent: 0,
    progressTotal: steps.length,
    submittedAt: new Date().toISOString(),
    cancelRequested: false,
    failurePolicy
  }, [{
    jobId,
    boardId: "board-a",
    probeSerial: "XDS-0",
    status: "QUEUED",
    currentStepIndex: 0
  }], steps.map((step, stepIndex) => ({
    stepRunId: `${jobId}-step-${stepIndex}`,
    jobId,
    boardId: "board-a",
    stepIndex,
    stepType: String(step.type),
    input: step,
    status: "PENDING",
    attempt: 0,
    idempotencyClass: "READ_ONLY" as const
  })));
}

async function waitForTerminal(runs: TestRunRepository, jobId: string) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const run = runs.get(jobId);
    if (run && ["PASSED", "FAILED", "PARTIAL", "CANCELLED", "NEEDS_MANUAL_INTERVENTION"].includes(run.status)) return run;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for durable job");
}
