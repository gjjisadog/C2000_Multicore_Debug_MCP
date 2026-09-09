import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { InMemoryOutcomeEventStore, OutcomeEventRepository, type OutcomeEventStore } from "../src/analytics/OutcomeEventRepository.js";
import { OutcomeAnalyticsService } from "../src/analytics/OutcomeAnalyticsService.js";
import type { OutcomeEvent } from "../src/analytics/OutcomeSchemas.js";
import { SqliteStore } from "../src/storage/SqliteStore.js";
import { createC2000ToolInvoker } from "../src/mcp/tools.js";
import { DebugSessionManager } from "../src/debug/DebugSessionManager.js";
import { LoadedProgramRegistry } from "../src/debug/LoadedProgramRegistry.js";
import { MockDebugAdapter } from "../src/adapters/MockDebugAdapter.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

function createService(options: {
  profile?: "readonly" | "safe" | "full";
  surface?: "agent" | "advanced" | "compatibility";
  now?: () => number;
  repository?: OutcomeEventStore;
} = {}) {
  return new OutcomeAnalyticsService({
    repository: options.repository ?? new InMemoryOutcomeEventStore(),
    toolProfile: options.profile ?? "safe",
    toolSurfaceProfile: options.surface ?? "agent",
    now: options.now,
    logger: { warn: () => undefined, error: () => undefined }
  });
}

function event(overrides: Partial<OutcomeEvent> = {}): OutcomeEvent {
  return {
    eventId: crypto.randomUUID(),
    timestamp: "2026-09-01T00:00:00.000Z",
    kind: "workflow_run",
    name: "c2000_runBootHandoffDiagnosis",
    outcome: "success",
    durationMs: 100,
    toolProfile: "safe",
    toolSurfaceProfile: "agent",
    activeCapabilities: [],
    metadata: { role: "workflow", family: "workflow", exposure: "default" },
    ...overrides
  };
}

describe("C2000 outcome analytics", () => {
  test("redacts raw inputs, paths, values, prompts, and arbitrary metadata", () => {
    const repository = new InMemoryOutcomeEventStore();
    const service = createService({ repository });
    service.recordToolInvocation({
      toolName: "c2000_runIpcAcceptance",
      input: { ccxmlPath: "C:\\Users\\operator\\secret.ccxml", expressions: ["g_secret"], value: 1234, prompt: "private prompt" },
      result: {
        success: false,
        error: {
          code: "ExpressionWaitTimeout",
          message: "private source/value details",
          details: { path: "C:\\private\\firmware.out", source: "source.c", value: 1234, registers: [1, 2] }
        }
      },
      durationMs: 12
    });

    const serialized = JSON.stringify(repository.list());
    expect(serialized).not.toContain("Users");
    expect(serialized).not.toContain("secret.ccxml");
    expect(serialized).not.toContain("private prompt");
    expect(serialized).not.toContain("source.c");
    expect(serialized).not.toContain("1234");
    expect(repository.list()[0]).toEqual(expect.objectContaining({
      errorCode: "ExpressionWaitTimeout",
      failureClass: "ipc-timeout"
    }));
  });

  test("uses deterministic duration statistics and bounded time windows", () => {
    const now = Date.parse("2026-09-08T00:00:00.000Z");
    const repository = new InMemoryOutcomeEventStore();
    const service = createService({ repository, now: () => now });
    for (const [index, durationMs] of [100, 200, 300, 400, 500].entries()) {
      service.record(event({
        eventId: crypto.randomUUID(),
        timestamp: new Date(now - index * 60_000).toISOString(),
        durationMs,
        outcome: index === 0 ? "failure" : "success"
      }));
    }
    const result = service.getWorkflowAnalytics({ window: "24h" }) as any;
    const summary = result.workflows[0];
    expect(result.window).toBe("24h");
    expect(summary.counts).toEqual(expect.objectContaining({ success: 4, failure: 1 }));
    expect(summary.duration).toEqual(expect.objectContaining({ mean: 300, p50: 300, p95: 480 }));
  });

  test("retains bounded runtime identity metadata for legacy event attribution", () => {
    const repository = new InMemoryOutcomeEventStore();
    const service = createService({ repository });
    service.record(event({
      mcpVersion: undefined,
      mcpGitSha: undefined,
      metadata: {
        workflow: "c2000_runBootHandoffDiagnosis",
        runtimeIdentity: {
          mcpVersion: "0.7.0",
          mcpGitSha: "a".repeat(40),
          buildId: "build-round9"
        }
      }
    }));

    expect(repository.list()[0]?.metadata.runtimeIdentity).toEqual({
      mcpVersion: "0.7.0",
      mcpGitSha: "a".repeat(40),
      buildId: "build-round9"
    });
  });

  test("retains only the configured horizon and tolerates analytics storage failure", async () => {
    const now = Date.parse("2026-09-08T00:00:00.000Z");
    const repository = new InMemoryOutcomeEventStore();
    const service = createService({ repository, now: () => now });
    service.record(event({ timestamp: "2026-01-01T00:00:00.000Z" }));
    service.record(event({ timestamp: "2026-09-07T00:00:00.000Z" }));
    expect((await service.maintain()).deleted).toBe(1);
    expect(repository.list()).toHaveLength(1);

    const failing: OutcomeEventStore = {
      append: () => { throw new Error("analytics db unavailable"); },
      list: () => { throw new Error("analytics db unavailable"); },
      deleteBefore: () => { throw new Error("analytics db unavailable"); }
    };
    const isolated = createService({ repository: failing });
    expect(() => isolated.record(event())).not.toThrow();
    expect(isolated.record(event())).toBe(false);
    expect((isolated.getWorkflowAnalytics() as any).analyticsAvailable).toBe(false);
  });

  test("recommendations are deterministic, bounded by safety, and never auto-open", () => {
    const service = createService();
    const result = service.getEscalationRecommendations({
      workflow: "c2000_runBootHandoffDiagnosis",
      stage: "handoff-diagnosis",
      failureClass: "boot-handoff"
    }) as any;
    expect(result.recommendations).toEqual(expect.arrayContaining([
      expect.objectContaining({ capability: "debug.manual", safetyAllowed: true, alreadyActive: false })
    ]));
    expect(result.activeCapabilities).toEqual([]);

    const readonly = createService({ profile: "readonly" });
    const blocked = readonly.getEscalationRecommendations({ failureClass: "program-load" }) as any;
    expect(blocked.recommendations).toEqual([]);
  });

  test("can derive a recommendation from a recorded job failure and rank stage-specific rules first", () => {
    const repository = new InMemoryOutcomeEventStore();
    const service = createService({ repository });
    repository.append(event({
      eventId: crypto.randomUUID(),
      kind: "workflow_run",
      name: "c2000_runBootHandoffDiagnosis",
      outcome: "failure",
      failureClass: "boot-handoff",
      jobId: "job-42",
      metadata: { role: "workflow", family: "workflow", exposure: "default" }
    }));

    const fromJob = service.getEscalationRecommendations({ jobId: "job-42" }) as any;
    expect(fromJob.failure).toEqual(expect.objectContaining({
      failureClass: "boot-handoff",
      workflow: "c2000_runBootHandoffDiagnosis",
      jobId: "job-42"
    }));
    expect(fromJob.recommendations[0]).toEqual(expect.objectContaining({ capability: "debug.manual" }));

    const timing = service.getEscalationRecommendations({ failureClass: "expression", stage: "execution-timing" }) as any;
    expect(timing.recommendations[0]).toEqual(expect.objectContaining({ capability: "observability.erad" }));

    const dlog = service.getEscalationRecommendations({ failureClass: "dlog" }) as any;
    expect(dlog.recommendations).toEqual(expect.arrayContaining([
      expect.objectContaining({ capability: "observability.dlog" })
    ]));
  });

  test("returns a safe daemon-worker recovery path for stale lease failures", () => {
    const service = createService();
    const result = service.getEscalationRecommendations({
      failureClass: "board-lease",
      errorCode: "LeaseInvalidated",
      stage: "session-cleanup",
      boardId: "board-a"
    }) as any;
    expect(result.recommendations).toEqual([]);
    expect(result.recoveryRecommendations).toEqual([
      expect.objectContaining({
        kind: "daemon-recovery",
        tool: "c2000_recoverBoard",
        dryRunArguments: { boardId: "board-a", dryRun: true },
        restartArguments: { boardId: "board-a", dryRun: false },
        safetyAllowed: true,
        autoExecute: false,
        targetAccessAttempted: false,
        externalProcessTermination: false
      })
    ]);
  });

  test("history is used only as a bounded association and stays low-confidence below five cases", () => {
    const repository = new InMemoryOutcomeEventStore();
    const service = createService({ repository });
    for (let index = 0; index < 4; index += 1) {
      const failureAt = new Date(Date.parse("2026-09-01T00:00:00.000Z") + index * 3_600_000).toISOString();
      const openAt = new Date(Date.parse(failureAt) + 1_000).toISOString();
      repository.append(event({
        eventId: crypto.randomUUID(), timestamp: failureAt, outcome: "failure", failureClass: "boot-handoff",
        metadata: { role: "workflow", family: "workflow", exposure: "default" }
      }));
      repository.append(event({
        eventId: crypto.randomUUID(), timestamp: openAt, kind: "capability_open", name: "debug.manual", outcome: "success",
        sessionId: `cap-${index}`, escalationTo: "debug.manual",
        metadata: { openedFrom: { workflow: "c2000_runBootHandoffDiagnosis", failureClass: "boot-handoff" } }
      }));
      repository.append(event({
        eventId: crypto.randomUUID(), timestamp: new Date(Date.parse(openAt) + 2_000).toISOString(), kind: "workflow_run",
        outcome: "success", metadata: { role: "workflow", family: "workflow", exposure: "default" }
      }));
    }
    const result = service.getEscalationRecommendations({ workflow: "c2000_runBootHandoffDiagnosis", failureClass: "boot-handoff" }) as any;
    const recommendation = result.recommendations.find((item: any) => item.capability === "debug.manual");
    expect(recommendation.historicalEvidence).toEqual(expect.objectContaining({ matchingCases: 4, insufficientHistoricalSupport: true }));
    expect(recommendation.source).toBe("static-rule");
  });

  test("capability lifecycle analytics links tools and continuation outcomes without causal claims", () => {
    const repository = new InMemoryOutcomeEventStore();
    const service = createService({ repository, now: () => Date.parse("2026-09-01T00:10:00.000Z") });
    const base = Date.parse("2026-09-01T00:00:00.000Z");
    repository.append(event({
      eventId: crypto.randomUUID(), timestamp: new Date(base).toISOString(), kind: "capability_open", name: "observability.dlog", outcome: "success",
      sessionId: "cap-1", escalationTo: "observability.dlog", metadata: { openedFrom: { workflow: "c2000_runBootHandoffDiagnosis", failureClass: "boot-handoff" } }
    }));
    repository.append(event({
      eventId: crypto.randomUUID(), timestamp: new Date(base + 1_000).toISOString(), kind: "tool_invocation", name: "c2000_readDlogBuffer", outcome: "success",
      sessionId: "target-session", metadata: { capability: "observability.dlog", family: "observability", role: "primary", exposure: "advanced" }
    }));
    repository.append(event({
      eventId: crypto.randomUUID(), timestamp: new Date(base + 2_000).toISOString(), kind: "workflow_run", outcome: "success",
      jobId: "job-1", metadata: { role: "workflow", family: "workflow", exposure: "default" }
    }));
    repository.append(event({
      eventId: crypto.randomUUID(), timestamp: new Date(base + 3_000).toISOString(), kind: "capability_close", name: "observability.dlog", outcome: "success",
      sessionId: "cap-1", durationMs: 3_000, metadata: { sessionOutcome: "resolved" }
    }));

    const result = service.getCapabilityAnalytics({ capability: "observability.dlog" }) as any;
    expect(result.associationNote).toContain("not causal");
    expect(result.capabilities[0]).toEqual(expect.objectContaining({ opens: 1, closes: 1, expires: 0, unused: 0 }));
    expect(result.capabilities[0].topTools).toEqual([expect.objectContaining({ label: "c2000_readDlogBuffer", count: 1 })]);
    expect(result.capabilities[0].openedAfterWorkflowFailure).toBe(1);
    expect(result.capabilities[0].escalationPaths[0]).toEqual(expect.objectContaining({
      workflow: "c2000_runBootHandoffDiagnosis",
      failureClass: "boot-handoff",
      capability: "observability.dlog"
    }));
    expect(result.recommendationAnalytics).toEqual(expect.objectContaining({
      recommendationsGenerated: 0,
      recommendationsAccepted: 0
    }));
  });

  test("records tool/workflow outcomes while an analytics recorder failure cannot change the tool result", async () => {
    const repository = new InMemoryOutcomeEventStore();
    const service = createService({ repository });
    const manager = new DebugSessionManager(new MockDebugAdapter(), new LoadedProgramRegistry());
    try {
      const invoker = createC2000ToolInvoker(manager, { outcomeAnalytics: service });
      await expect(invoker.invokeTool("c2000_getServerHealth", {})).resolves.toEqual(expect.objectContaining({ success: true }));
      await invoker.invokeTool("c2000_runIpcAcceptance", {});
      const kinds = repository.list().map(item => item.kind);
      expect(kinds).toContain("tool_invocation");
      expect(kinds).toContain("workflow_run");

      const throwingRecorder = createC2000ToolInvoker(manager, {
        outcomeAnalytics: { recordToolInvocation: () => { throw new Error("metrics sink failed"); } }
      });
      await expect(throwingRecorder.invokeTool("c2000_getServerHealth", {})).resolves.toEqual(expect.objectContaining({ success: true }));
    } finally {
      await manager.disposeAllSessions();
    }
  });

  test("adds outcome_events through the existing SQLite migration and round-trips sanitized events", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "c2000-outcome-analytics-"));
    roots.push(directory);
    const store = await SqliteStore.open(path.join(directory, "analytics.sqlite"));
    expect(store.schemaVersion).toBe(17);
    const repository = new OutcomeEventRepository(store);
    repository.append(event({ eventId: crypto.randomUUID(), kind: "tool_invocation", name: "c2000_getServerHealth" }));
    store.run(`
      INSERT INTO outcome_events(
        event_id, timestamp, kind, name, outcome, duration_ms, stage, error_code,
        failure_class, tool_profile, tool_surface_profile, active_capabilities_json,
        board_count, core_count, job_id, session_id, escalation_from, escalation_to,
        metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [crypto.randomUUID(), "2026-09-01T00:00:01.000Z", "corrupt", "bad-row", "success", null, null, null, null, "safe", "agent", "not-json", null, null, null, null, null, null, "{}"]);
    expect(repository.list({ kinds: ["tool_invocation"] })).toHaveLength(1);
    expect(repository.list()).toHaveLength(1);
    expect(repository.deleteBefore("2020-01-01T00:00:00.000Z")).toBe(0);
    store.close();
  });
});
