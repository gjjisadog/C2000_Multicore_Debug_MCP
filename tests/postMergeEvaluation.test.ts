import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, test } from "vitest";
import { InMemoryOutcomeEventStore } from "../src/analytics/OutcomeEventRepository.js";
import { outcomeEventSchema, type OutcomeEvent } from "../src/analytics/OutcomeSchemas.js";
import {
  InMemoryImprovementProposalStore,
  ProposalRepository
} from "../src/improvement/ProposalRepository.js";
import { ImprovementProposalService } from "../src/improvement/ImprovementProposalService.js";
import {
  improvementProposalSchema,
  type ImprovementProposal
} from "../src/improvement/ProposalSchemas.js";
import { improvementPullRequestSchema } from "../src/improvement/review/ReviewSchemas.js";
import {
  InMemoryPostMergeEvaluationSnapshotStore,
  InMemoryPostMergeEvaluationStore,
  InMemoryRollbackRecommendationStore
} from "../src/improvement/evaluation/EvaluationRepositories.js";
import {
  POST_MERGE_FINAL_SAMPLES,
  PostMergeEvaluationService
} from "../src/improvement/evaluation/PostMergeEvaluationService.js";
import { SqliteStore } from "../src/storage/SqliteStore.js";

const BASELINE_SHA = "a".repeat(40);
const CANDIDATE_SHA = "c".repeat(40);
const MERGED_SHA = "b".repeat(40);
const MERGED_AT = Date.parse("2026-09-01T00:00:00.000Z");
const INITIAL_NOW = Date.parse("2026-09-02T00:00:00.000Z");

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    const { rm } = await import("node:fs/promises");
    await rm(directory, { recursive: true, force: true });
  }
});

describe("post-merge evaluation governance", () => {
  test("creates deferred metadata and preserves the frozen baseline snapshot", () => {
    const fixture = makeFixture();
    appendEvents(fixture.events, BASELINE_SHA, 20, 0.8, baselineTimestamp);

    const created = fixture.service.ensureForMergedPullRequest(fixture.pullRequest);
    expect(created).toEqual(expect.objectContaining({
      candidateSha: CANDIDATE_SHA,
      mergedCommitSha: MERGED_SHA,
      retrospectiveBaseline: true,
      lifecycleStatus: "waiting-for-deployment"
    }));
    expect(created?.candidateSha).not.toBe(created?.mergedCommitSha);
    const frozenBaseline = created?.baselineMetrics.metrics[0]?.value;
    expect(frozenBaseline).toBeCloseTo(0.8);

    // A late-arriving pre-merge event must not rewrite the immutable baseline
    // snapshot captured when the evaluation was created.
    fixture.events.append(makeEvent({
      timestamp: MERGED_AT - 1_000,
      gitSha: BASELINE_SHA,
      metric: 0.1
    }));
    fixture.now = Date.parse("2026-09-03T00:00:00.000Z");
    const waiting = fixture.service.refresh(created!.evaluationId);

    expect((waiting.evaluation as { lifecycleStatus: string }).lifecycleStatus).toBe("waiting-for-deployment");
    expect((waiting.evaluation as { verdict?: string }).verdict).toBeUndefined();
    expect((waiting.evaluation as { baselineMetrics: { metrics: Array<{ value: number | null }> } }).baselineMetrics.metrics[0]?.value).toBe(frozenBaseline);
    expect(fixture.snapshots.list(created!.evaluationId)).toHaveLength(2);
  });

  test("waits for matching deployment and produces a deterministic improvement verdict", () => {
    const fixture = makeFixture();
    appendEvents(fixture.events, BASELINE_SHA, 20, 0.8, baselineTimestamp);
    const created = fixture.service.ensureForMergedPullRequest(fixture.pullRequest)!;

    appendEvents(fixture.events, MERGED_SHA, 20, 0.95, postTimestamp);
    fixture.now = Date.parse("2026-09-09T00:00:00.000Z");
    const refreshed = fixture.service.refresh(created.evaluationId);
    const evaluation = refreshed.evaluation as {
      lifecycleStatus: string;
      verdict?: string;
      comparability: { status: string };
      deployment: { mergedShaMatched: boolean };
    };

    expect(evaluation.lifecycleStatus).toBe("ready");
    expect(evaluation.verdict).toBe("improved");
    expect(evaluation.comparability.status).toBe("comparable");
    expect(evaluation.deployment.mergedShaMatched).toBe(true);
    expect(fixture.proposals.get(fixture.proposal.proposalId)?.finalOutcome).toBeUndefined();
  });

  test("matches a containing release and retains legacy metadata-only baseline identity", () => {
    const fixture = makeFixture();
    appendEvents(fixture.events, BASELINE_SHA, 20, 0.8, baselineTimestamp);
    fixture.events.append(makeEvent({
      timestamp: baselineTimestamp(20),
      metric: 0.8,
      deployedCommitSha: BASELINE_SHA
    }));
    const created = fixture.service.ensureForMergedPullRequest(fixture.pullRequest)!;

    appendEvents(fixture.events, "d".repeat(40), 20, 0.95, postTimestamp, 0, {
      releaseContainsSha: MERGED_SHA
    });
    fixture.now = Date.parse("2026-09-09T00:00:00.000Z");
    const refreshed = fixture.service.refresh(created.evaluationId);
    const evaluation = refreshed.evaluation as {
      lifecycleStatus: string;
      verdict?: string;
      baselineMetrics: { eventCount: number };
      deployment: { knownReleaseContainingMerge: boolean; mergedShaMatched: boolean };
    };

    expect(evaluation.lifecycleStatus).toBe("ready");
    expect(evaluation.verdict).toBe("improved");
    expect(evaluation.baselineMetrics.eventCount).toBe(21);
    expect(evaluation.deployment).toEqual(expect.objectContaining({
      knownReleaseContainingMerge: true,
      mergedShaMatched: false
    }));
  });

  test("matches a post-merge runtime identity carried in event metadata", () => {
    const fixture = makeFixture();
    appendEvents(fixture.events, BASELINE_SHA, 20, 0.8, baselineTimestamp);
    const created = fixture.service.ensureForMergedPullRequest(fixture.pullRequest)!;
    for (let index = 0; index < 20; index += 1) {
      fixture.events.append(makeEvent({
        timestamp: postTimestamp(index),
        metric: 0.95,
        runtimeIdentity: { mcpVersion: "0.7.0", mcpGitSha: MERGED_SHA }
      }));
    }
    fixture.now = Date.parse("2026-09-09T00:00:00.000Z");

    const refreshed = fixture.service.refresh(created.evaluationId);
    const evaluation = refreshed.evaluation as {
      lifecycleStatus: string;
      verdict?: string;
      deployment: { matchedRuntimeEvents: number; mergedShaMatched: boolean };
    };

    expect(evaluation.lifecycleStatus).toBe("ready");
    expect(evaluation.verdict).toBe("improved");
    expect(evaluation.deployment).toEqual(expect.objectContaining({
      matchedRuntimeEvents: 20,
      mergedShaMatched: true
    }));
  });

  test("requires the final observation gate when explicitly finalizing", () => {
    const fixture = makeFixture();
    appendEvents(fixture.events, BASELINE_SHA, 20, 0.8, baselineTimestamp);
    const created = fixture.service.ensureForMergedPullRequest(fixture.pullRequest)!;
    appendEvents(fixture.events, MERGED_SHA, 20, 0.95, postTimestamp);
    fixture.now = Date.parse("2026-09-09T00:00:00.000Z");

    const interim = fixture.service.refresh({ evaluationId: created.evaluationId, finalize: true });
    expect((interim.evaluation as { lifecycleStatus: string }).lifecycleStatus).toBe("ready");
    expect((interim.evaluation as { verdict?: string }).verdict).toBe("improved");

    appendEvents(fixture.events, MERGED_SHA, POST_MERGE_FINAL_SAMPLES - 20, 0.95, postTimestamp, 20);
    const final = fixture.service.refresh({ evaluationId: created.evaluationId, finalize: true });
    expect((final.evaluation as { lifecycleStatus: string; verdict?: string }).lifecycleStatus).toBe("evaluated");
    expect((final.evaluation as { verdict?: string }).verdict).toBe("improved");
    expect(fixture.proposals.get(fixture.proposal.proposalId)?.finalOutcome).toBe("verified-improvement");
  });

  test("fails closed for a non-comparable runtime and does not recommend rollback", () => {
    const fixture = makeFixture();
    appendEvents(fixture.events, BASELINE_SHA, 20, 0.8, baselineTimestamp);
    const created = fixture.service.ensureForMergedPullRequest(fixture.pullRequest)!;
    appendEvents(fixture.events, MERGED_SHA, 20, 0.95, postTimestamp, 0, { mcpVersion: "0.8.0" });
    fixture.now = Date.parse("2026-09-09T00:00:00.000Z");

    const refreshed = fixture.service.refresh(created.evaluationId);
    const evaluation = refreshed.evaluation as { lifecycleStatus: string; verdict?: string; comparability: { status: string } };
    expect(evaluation.lifecycleStatus).toBe("insufficient-data");
    expect(evaluation.verdict).toBe("inconclusive");
    expect(evaluation.comparability.status).toBe("not-comparable");
    expect(fixture.rollbacks.list()).toHaveLength(0);
  });

  test("opens a human-only critical rollback recommendation for a protected safety regression", () => {
    const fixture = makeFixture();
    appendEvents(fixture.events, BASELINE_SHA, 20, 0.8, baselineTimestamp);
    const created = fixture.service.ensureForMergedPullRequest(fixture.pullRequest)!;
    appendEvents(fixture.events, MERGED_SHA, 20, 0.5, postTimestamp, 0, { safetyViolation: true });
    fixture.now = Date.parse("2026-09-09T00:00:00.000Z");

    const refreshed = fixture.service.refresh(created.evaluationId);
    const recommendation = refreshed.rollbackRecommendation as {
      recommendationId: string;
      severity: string;
      automaticExecutionAllowed: boolean;
    };
    expect((refreshed.evaluation as { verdict?: string }).verdict).toBe("regressed");
    expect(recommendation).toEqual(expect.objectContaining({
      severity: "critical",
      automaticExecutionAllowed: false
    }));
    expect(fixture.service.hasActiveCriticalRegression()).toBe(true);

    const reviewed = fixture.service.reviewRollbackRecommendation({
      recommendationId: recommendation.recommendationId,
      action: "convert-to-proposal",
      reason: "Review the protected invariant regression with a fresh human-approved candidate.",
      reviewer: "round9-reviewer"
    });
    expect(reviewed).toEqual(expect.objectContaining({
      automaticExecutionAllowed: false,
      followUpProposal: expect.objectContaining({
        category: "rollback",
        source: "post-merge-regression",
        status: "ready-for-review"
      })
    }));
  });

  test("raises a critical safety alert before ordinary duration and sample maturity", () => {
    const fixture = makeFixture();
    appendEvents(fixture.events, BASELINE_SHA, 20, 0.8, baselineTimestamp);
    const created = fixture.service.ensureForMergedPullRequest(fixture.pullRequest)!;
    fixture.events.append(makeEvent({
      timestamp: MERGED_AT + 30 * 60 * 1000,
      gitSha: MERGED_SHA,
      metric: 0.5,
      safetyViolation: true
    }));
    fixture.now = MERGED_AT + 60 * 60 * 1000;

    const refreshed = fixture.service.refresh(created.evaluationId);
    expect((refreshed.evaluation as { lifecycleStatus: string; verdict?: string }).lifecycleStatus).toBe("monitoring");
    expect((refreshed.evaluation as { verdict?: string }).verdict).toBe("regressed");
    expect((refreshed.rollbackRecommendation as { severity: string }).severity).toBe("critical");
  });

  test("does not turn one ordinary timeout into a rollback recommendation", () => {
    const fixture = makeFixture();
    appendEvents(fixture.events, BASELINE_SHA, 20, 1, baselineTimestamp);
    const created = fixture.service.ensureForMergedPullRequest(fixture.pullRequest)!;
    appendEvents(fixture.events, MERGED_SHA, 19, 1, postTimestamp);
    fixture.events.append(makeEvent({
      timestamp: postTimestamp(19),
      gitSha: MERGED_SHA,
      metric: 0,
      outcome: "timeout"
    }));
    fixture.now = Date.parse("2026-09-09T00:00:00.000Z");

    const refreshed = fixture.service.refresh(created.evaluationId);
    expect((refreshed.evaluation as { verdict?: string }).verdict).toBe("neutral");
    expect(fixture.rollbacks.list()).toHaveLength(0);
  });

  test("round-trips primary metrics and final outcome through the SQLite migration", async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const directory = await mkdtemp(join(tmpdir(), "c2000-round9-proposal-"));
    temporaryDirectories.push(directory);
    const store = await SqliteStore.open(join(directory, "proposals.sqlite"));
    expect(store.schemaVersion).toBe(16);
    const repository = new ProposalRepository(store);
    const proposal = improvementProposalSchema.parse({
      ...makeProposal(),
      finalOutcome: "verified-improvement"
    });
    repository.upsert(proposal);
    const loaded = repository.get(proposal.proposalId)!;
    expect(loaded.source).toBe("outcome-analytics");
    expect(loaded.primaryMetricsLocked).toBe(true);
    expect(loaded.primaryMetrics[0]?.name).toBe("successRate");
    expect(loaded.finalOutcome).toBe("verified-improvement");
    store.close();
  });
});

interface Fixture {
  events: InMemoryOutcomeEventStore;
  proposals: InMemoryImprovementProposalStore;
  snapshots: InMemoryPostMergeEvaluationSnapshotStore;
  rollbacks: InMemoryRollbackRecommendationStore;
  service: PostMergeEvaluationService;
  proposal: ImprovementProposal;
  pullRequest: ReturnType<typeof improvementPullRequestSchema.parse>;
  now: number;
}

function makeFixture(): Fixture {
  const events = new InMemoryOutcomeEventStore();
  const proposals = new InMemoryImprovementProposalStore();
  const snapshots = new InMemoryPostMergeEvaluationSnapshotStore();
  const rollbacks = new InMemoryRollbackRecommendationStore();
  const proposal = makeProposal();
  proposals.upsert(proposal);
  const state = { now: INITIAL_NOW };
  const proposalService = new ImprovementProposalService({
    events,
    proposals,
    currentBaselineSha: BASELINE_SHA,
    now: () => state.now
  });
  const service = new PostMergeEvaluationService({
    evaluations: new InMemoryPostMergeEvaluationStore(),
    snapshots,
    rollbackRecommendations: rollbacks,
    events,
    proposals,
    proposalService,
    now: () => state.now
  });
  return {
    events,
    proposals,
    snapshots,
    rollbacks,
    service,
    proposal,
    pullRequest: makePullRequest(),
    get now() { return state.now; },
    set now(value: number) { state.now = value; }
  };
}

function makeProposal(): ImprovementProposal {
  const timestamp = new Date(INITIAL_NOW).toISOString();
  return improvementProposalSchema.parse({
    proposalId: "proposal-round9-eval",
    fingerprint: "1".repeat(16),
    status: "merged",
    category: "workflow",
    target: "ipc.acceptance",
    title: "Improve IPC acceptance guidance",
    summary: "A deterministic post-merge evaluation fixture.",
    evidence: {
      matchingRuns: 20,
      affectedRuns: 10,
      successAfterEscalation: 8,
      failureAfterEscalation: 2,
      sampleWindow: "7d",
      patternRatio: 0.5,
      failureRate: 0.2,
      sufficient: true,
      minimumMatchingRuns: 10,
      minimumPatternRatio: 0.2,
      supportingTools: [],
      supportingCapabilities: [],
      context: { workflow: "ipc.acceptance" },
      rootCause: "likely-mcp-deficiency",
      rootCauseReason: "The fixture represents a bounded workflow improvement."
    },
    proposedChange: {
      kind: "workflow-gap",
      target: "ipc.acceptance",
      description: "Improve the workflow guidance.",
      allowedAreas: ["src"],
      forbiddenAreas: ["master", "production"],
      changeScope: "small",
      implementationMode: "auto-eligible",
      suggestedTools: []
    },
    expectedBenefit: {
      summary: "Improve the workflow success rate.",
      metrics: [{ name: "successRate", direction: "increase", rationale: "More acceptance runs should complete successfully." }]
    },
    risks: [{ level: "low", description: "The fixture is bounded.", mitigation: "Use the existing validation gates." }],
    validationPlan: {
      existingTests: ["ipc acceptance"],
      newRegressionTestRequired: true,
      mockValidation: true,
      hardwareRequired: false,
      replayFixtures: [],
      beforeAfterMetrics: ["successRate"],
      rollbackCondition: "Any protected invariant regression.",
      acceptanceCriteria: ["Comparable success rate improves."]
    },
    confidence: 0.9,
    priority: "P1",
    generatedBy: "analytics-pattern",
    sourceWindow: "7d",
    source: "outcome-analytics",
    baselineSha: BASELINE_SHA,
    primaryMetrics: [{
      name: "successRate",
      classification: "reliability",
      direction: "increase",
      required: true,
      tolerance: 0,
      meaningfulDelta: 0.01,
      unit: "ratio",
      rationale: "More acceptance runs should complete successfully.",
      source: "declared"
    }],
    primaryMetricsLocked: true,
    primaryMetricsLockedAt: timestamp,
    primaryMetricsSource: "declared",
    createdAt: timestamp,
    updatedAt: timestamp,
    lastObservedAt: timestamp
  });
}

function makePullRequest() {
  return improvementPullRequestSchema.parse({
    pullRequestId: "pr-round9-evaluation",
    proposalId: "proposal-round9-eval",
    implementationRunId: "run-round9-evaluation",
    repository: "gjjisadog/C2000_Multicore_Debug_MCP",
    branch: "improve/round9-evaluation",
    baseBranch: "master",
    candidateSha: CANDIDATE_SHA,
    baselineSha: BASELINE_SHA,
    number: 909,
    url: "https://github.com/gjjisadog/C2000_Multicore_Debug_MCP/pull/909",
    title: "Improve IPC acceptance guidance",
    status: "merged-externally",
    draft: false,
    createdAt: new Date(INITIAL_NOW).toISOString(),
    updatedAt: new Date(INITIAL_NOW).toISOString(),
    originalBaseSha: BASELINE_SHA,
    currentBaseSha: BASELINE_SHA,
    currentHeadSha: CANDIDATE_SHA,
    mergedCommitSha: MERGED_SHA,
    mergedAt: new Date(MERGED_AT).toISOString(),
    generatedBodyHash: "d".repeat(64),
    humanBodyPreserved: true
  });
}

function appendEvents(
  store: InMemoryOutcomeEventStore,
  gitSha: string,
  count: number,
  metric: number,
  timestampForIndex: (index: number) => number,
  indexOffset = 0,
  overrides: { mcpVersion?: string; safetyViolation?: boolean; deployedCommitSha?: string; releaseContainsSha?: string; runtimeIdentity?: { mcpVersion: string; mcpGitSha: string } } = {}
): void {
  for (let index = 0; index < count; index += 1) {
    store.append(makeEvent({
      timestamp: timestampForIndex(index + indexOffset),
      gitSha,
      metric,
      ...(overrides.mcpVersion ? { mcpVersion: overrides.mcpVersion } : {}),
      ...(overrides.safetyViolation ? { safetyViolation: true } : {}),
      ...(overrides.deployedCommitSha ? { deployedCommitSha: overrides.deployedCommitSha } : {}),
      ...(overrides.releaseContainsSha ? { releaseContainsSha: overrides.releaseContainsSha } : {}),
      ...(overrides.runtimeIdentity ? { runtimeIdentity: overrides.runtimeIdentity } : {})
    }));
  }
}

function makeEvent(input: {
  timestamp: number;
  gitSha?: string;
  metric: number;
  outcome?: "success" | "failure" | "timeout";
  mcpVersion?: string;
  safetyViolation?: boolean;
  deployedCommitSha?: string;
  releaseContainsSha?: string;
  runtimeIdentity?: { mcpVersion: string; mcpGitSha: string };
}): OutcomeEvent {
  return outcomeEventSchema.parse({
    eventId: randomUUID(),
    timestamp: new Date(input.timestamp).toISOString(),
    kind: "workflow_run",
    name: "c2000_runIpcAcceptance",
    outcome: input.outcome ?? "success",
    toolProfile: "safe",
    toolSurfaceProfile: "agent",
    activeCapabilities: [],
    mcpVersion: input.mcpVersion ?? "0.7.0",
    ...(input.gitSha ? { mcpGitSha: input.gitSha } : {}),
    boardCount: 1,
    metadata: {
      workflow: "ipc.acceptance",
      adapterMode: "mock",
      hardwareMode: "mock",
      firmwareIdentity: "fw-1",
      testPlanIdentity: "plan-1",
      osRuntime: "node-22",
      metrics: { successRate: input.metric },
      ...(input.safetyViolation ? { safetyViolation: true } : {}),
      ...(input.deployedCommitSha ? { deployedCommitSha: input.deployedCommitSha } : {}),
      ...(input.releaseContainsSha ? { releaseContainsSha: input.releaseContainsSha } : {}),
      ...(input.runtimeIdentity ? { runtimeIdentity: input.runtimeIdentity } : {})
    }
  });
}

function baselineTimestamp(index: number): number {
  return Date.parse("2026-08-20T00:00:00.000Z") + index * 60_000;
}

function postTimestamp(index: number): number {
  return Date.parse("2026-09-02T00:00:00.000Z") + index * 60_000;
}
