import { describe, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { InMemoryOutcomeEventStore } from "../src/analytics/OutcomeEventRepository.js";
import { ImprovementProposalService } from "../src/improvement/ImprovementProposalService.js";
import { InMemoryImprovementProposalStore } from "../src/improvement/ProposalRepository.js";
import { InMemoryImprovementImplementationRunStore } from "../src/improvement/implementation/ImplementationRunRepository.js";
import { InMemoryPostMergeEvaluationStore } from "../src/improvement/evaluation/EvaluationRepositories.js";
import { InMemoryImprovementPullRequestStore, InMemoryImprovementReviewEvidenceStore } from "../src/improvement/review/ReviewRepositories.js";
import {
  InMemoryCrossImprovementSnapshotStore,
  InMemoryEngineeringPolicyRecommendationStore,
  InMemoryEngineeringPolicySnapshotStore
} from "../src/improvement/meta/MetaRepositories.js";
import {
  aggregateImprovementHistory,
  CrossImprovementAnalyticsService,
  MIN_META_HISTORY_SAMPLE_SIZE
} from "../src/improvement/meta/CrossImprovementAnalyticsService.js";
import { MetaPolicyGuard } from "../src/improvement/meta/MetaPolicyGuard.js";
import { improvementProposalSchema, type ImprovementProposal } from "../src/improvement/ProposalSchemas.js";
import type { ImprovementHistoryRecord } from "../src/improvement/meta/MetaSchemas.js";

const NOW = "2026-09-05T00:00:00.000Z";
const HASH = "a".repeat(64);

describe("Round10 cross-improvement analytics", () => {
  test("aggregates lifecycle yields, outcomes, validation escapes, and burdens", () => {
    const records: ImprovementHistoryRecord[] = [
      history("a", { proposalStatus: "merged", implementationRunCount: 1, agentAttemptCount: 1, revisionCount: 0, merged: true, finalOutcome: "verified-improvement", preMergeValidationPassed: true }),
      history("b", { proposalStatus: "merged", implementationRunCount: 2, agentAttemptCount: 3, revisionCount: 2, merged: true, finalOutcome: "verified-regression", preMergeValidationPassed: true, validationEscape: true }),
      history("c", { proposalStatus: "approved", implementationRunCount: 0, agentAttemptCount: 0, revisionCount: 0, merged: false })
    ];
    const metrics = aggregateImprovementHistory(records);
    expect(metrics.proposalYield).toMatchObject({ numerator: 3, denominator: 3, rate: 1 });
    expect(metrics.implementationYield).toMatchObject({ numerator: 2, denominator: 3 });
    expect(metrics.mergeYield).toMatchObject({ numerator: 2, denominator: 2 });
    expect(metrics.verifiedImprovementYield).toMatchObject({ numerator: 1, denominator: 2, rate: 0.5 });
    expect(metrics.regressionRate).toMatchObject({ numerator: 1, denominator: 2, rate: 0.5 });
    expect(metrics.validationEscapeRate).toMatchObject({ numerator: 1, denominator: 2, rate: 0.5 });
    expect(metrics.revisionBurden.total).toBe(2);
    expect(metrics.agentRepairBurden.total).toBe(1);
  });

  test("does not fabricate policy recommendations below the meta sample floor", () => {
    const proposals = new InMemoryImprovementProposalStore();
    for (let index = 0; index < MIN_META_HISTORY_SAMPLE_SIZE - 1; index += 1) {
      proposals.upsert(makeProposal(index, { finalOutcome: "verified-improvement", evidenceSamples: 12 }));
    }
    const service = makeService(proposals);
    const result = service.generate();
    expect(result.status).toBe("INSUFFICIENT_META_HISTORY");
    expect(result.recommendations).toEqual([]);
    expect(result.realHistorySampleSize).toBe(MIN_META_HISTORY_SAMPLE_SIZE - 1);
  });

  test("does not count an unmerged final outcome as completed meta history", () => {
    const proposals = new InMemoryImprovementProposalStore();
    for (let index = 0; index < MIN_META_HISTORY_SAMPLE_SIZE; index += 1) {
      const proposal = makeProposal(index, { finalOutcome: "verified-improvement", evidenceSamples: 12 });
      proposals.upsert({ ...proposal, status: "ready-for-review" });
    }
    const result = makeService(proposals).generate();
    expect(result.status).toBe("INSUFFICIENT_META_HISTORY");
    expect(result.realHistorySampleSize).toBe(0);
    expect(result.recommendations).toEqual([]);
  });

  test("detects an evidence-threshold pattern from low and high sample cohorts", () => {
    const proposals = new InMemoryImprovementProposalStore();
    for (let index = 0; index < MIN_META_HISTORY_SAMPLE_SIZE; index += 1) {
      proposals.upsert(makeProposal(index, { finalOutcome: "no-observable-benefit", evidenceSamples: 10 + index }));
      proposals.upsert(makeProposal(index + 10, { finalOutcome: "verified-improvement", evidenceSamples: 30 + index }));
    }
    const result = makeService(proposals).generate();
    expect(result.status).toBe("RECOMMENDATIONS_GENERATED");
    expect((result.recommendations as Array<Record<string, unknown>>).some(item => item.category === "proposal-policy")).toBe(true);
  });

  test("records a validation escape and hardware-gate effectiveness without changing policy", () => {
    const records = Array.from({ length: 5 }, (_, index) => history(`escape-${index}`, {
      proposalStatus: "merged",
      implementationRunCount: 1,
      agentAttemptCount: 1,
      merged: true,
      finalOutcome: "verified-regression",
      preMergeValidationPassed: true,
      validationEscape: true,
      hardwareRequired: true,
      hardwareValidationVerdict: "passed"
    }));
    const analysis = makeService(new InMemoryImprovementProposalStore()).analyzeRecords(records);
    expect(analysis.snapshot.metrics.validationEscapeRate.rate).toBe(1);
    expect(analysis.snapshot.validationPredictiveValue.reviewEscapeCount).toBe(0);
    expect(analysis.snapshot.hardwareGateEffectiveness.postMergeRegressionAfterHardwarePass).toBe(5);
    expect(analysis.snapshot.metrics.inconclusiveRate.rate).toBe(0);
  });

  test("reports validation-stage cost and predictive value without deleting any gate", () => {
    const records = [
      history("stage-pass", { merged: true, finalOutcome: "verified-improvement", preMergeValidationPassed: true, validationStages: [
        { stage: "unit", status: "passed", durationMs: 10 },
        { stage: "hardware", status: "passed", durationMs: 100 }
      ] }),
      history("stage-escape", { merged: true, finalOutcome: "verified-regression", preMergeValidationPassed: true, validationStages: [
        { stage: "unit", status: "passed", durationMs: 20 },
        { stage: "hardware", status: "failed", durationMs: 120 }
      ] })
    ];
    const analysis = makeService(new InMemoryImprovementProposalStore()).analyzeRecords(records);
    const unit = analysis.snapshot.validationStageEffectiveness.find(stage => stage.stage === "unit");
    expect(unit).toEqual(expect.objectContaining({
      sampleSize: 2,
      passed: 2,
      totalDurationMs: 30,
      postMergeRegressionsAfterPass: 1
    }));
    expect(unit?.predictiveValue.rate).toBe(0.5);
    expect(analysis.snapshot.validationPredictiveValue.stageMetrics).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: "hardware", failed: 1, totalDurationMs: 220 })
    ]));
  });

  test("deduplicates a rejected recommendation until material evidence changes", () => {
    const proposals = new InMemoryImprovementProposalStore();
    for (let index = 0; index < MIN_META_HISTORY_SAMPLE_SIZE; index += 1) {
      proposals.upsert(makeProposal(index, { finalOutcome: "no-observable-benefit", evidenceSamples: 10 + index }));
      proposals.upsert(makeProposal(index + 10, { finalOutcome: "verified-improvement", evidenceSamples: 30 + index }));
    }
    const service = makeService(proposals);
    const first = service.generate();
    const firstRecommendation = (first.recommendations as Array<Record<string, any>>).find(item => item.category === "proposal-policy");
    expect(firstRecommendation).toBeDefined();
    const repeated = service.generate();
    expect(repeated.recommendations).toEqual(expect.arrayContaining([
      expect.objectContaining({ recommendationId: firstRecommendation!.recommendationId })
    ]));
    expect(service.list({ category: "proposal-policy" }).count).toBe(1);

    service.review({
      recommendationId: firstRecommendation!.recommendationId,
      action: "reject",
      reason: "The retained evidence is not sufficient for a policy change.",
      reviewer: "reviewer"
    });
    const rejectedRepeat = service.generate();
    expect(rejectedRepeat.recommendations).toEqual([]);
    expect(rejectedRepeat.suppressedRecommendations).toEqual(expect.arrayContaining([
      expect.objectContaining({ recommendationId: firstRecommendation!.recommendationId })
    ]));
  });

  test("separates policy regimes in the aggregate view", () => {
    const records = [
      history("v1", { policyRegime: "engineering-policy-v1", engineeringPolicyHash: HASH }),
      history("legacy", { policyRegime: "legacy", engineeringPolicyHash: undefined })
    ];
    const snapshot = makeService(new InMemoryImprovementProposalStore()).analyzeRecords(records).snapshot;
    expect(snapshot.byPolicyRegime.map(group => group.key)).toEqual(["engineering-policy-v1", "legacy"]);
  });

  test("can recommend a hardware gate from repeated non-hardware escapes", () => {
    const proposals = new InMemoryImprovementProposalStore();
    const events = new InMemoryOutcomeEventStore();
    for (let index = 0; index < MIN_META_HISTORY_SAMPLE_SIZE; index += 1) {
      proposals.upsert(makeProposal(index, {
        finalOutcome: "verified-regression",
        evidenceSamples: 25
      }));
      const fixture = proposals.get(`meta-proposal-${index}`)!;
      proposals.upsert(improvementProposalSchema.parse({
        ...fixture,
        category: "reliability",
        validationPlan: { ...fixture.validationPlan, hardwareRequired: false },
        evidence: { ...fixture.evidence, context: { ...fixture.evidence.context, detector: "boot-detector" } }
      }));
      events.append({
        eventId: randomUUID(),
        timestamp: NOW,
        kind: "workflow_run",
        name: "hardware.validation",
        outcome: "failure",
        toolProfile: "safe",
        toolSurfaceProfile: "agent",
        activeCapabilities: [],
        metadata: { proposalId: `meta-proposal-${index}`, hardwareVerdict: "failed" }
      });
    }
    const service = makeService(proposals, undefined, events);
    const generated = service.generate();
    expect(generated.recommendations).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: "hardware-policy", detector: "HardwareGateDetector" })
    ]));
  });

  test("converts only a reviewed recommendation into a ready-for-review Proposal", () => {
    const proposals = new InMemoryImprovementProposalStore();
    for (let index = 0; index < MIN_META_HISTORY_SAMPLE_SIZE; index += 1) {
      proposals.upsert(makeProposal(index, { finalOutcome: "no-observable-benefit", evidenceSamples: 10 + index }));
      proposals.upsert(makeProposal(index + 10, { finalOutcome: "verified-improvement", evidenceSamples: 30 + index }));
    }
    const proposalService = new ImprovementProposalService({ events: new InMemoryOutcomeEventStore(), proposals, now: () => Date.parse(NOW) });
    const service = makeService(proposals, proposalService);
    const generated = service.generate();
    const recommendation = (generated.recommendations as Array<Record<string, any>>).find(item => item.category === "proposal-policy");
    expect(recommendation?.status).toBe("ready-for-review");
    const converted = service.review({
      recommendationId: recommendation!.recommendationId,
      action: "convert-to-proposal",
      reason: "Reviewed the retained cohort and request a normal Proposal review.",
      reviewer: "human-reviewer"
    });
    expect((converted.proposal as ImprovementProposal).status).toBe("ready-for-review");
    expect((converted.proposal as ImprovementProposal).source).toBe("policy-recommendation");
    expect((converted.proposal as ImprovementProposal).sourceRecommendationId).toBe(recommendation!.recommendationId);
    expect((converted.proposal as ImprovementProposal).status).not.toBe("approved");
  });
});

describe("Round10 protected meta governance", () => {
  test("suppresses automatic merge, weakened approval, and unlimited agent-loop recommendations", () => {
    const result = new MetaPolicyGuard().assess({
      category: "review-policy",
      target: "merge.humanGate",
      title: "Enable automatic merge and unlimited agent retry",
      summary: "Remove human approval and bypass safety after a good historical result.",
      currentPolicy: { humanMergeRequired: true, maxAgentAttempts: 2 },
      recommendedPolicyChange: { autoMerge: true, humanMergeRequired: false, maxAgentAttempts: "unlimited" },
      expectedEffect: ["faster merges"],
      risks: ["less review"]
    });
    expect(result.allowed).toBe(false);
    expect(result.suppressedByProtectedPolicy).toBe(true);
    expect(result.reasons.length).toBeGreaterThan(1);
  });
});

function makeService(
  proposals: InMemoryImprovementProposalStore,
  proposalService?: ImprovementProposalService,
  events = new InMemoryOutcomeEventStore()
): CrossImprovementAnalyticsService {
  return new CrossImprovementAnalyticsService({
    proposals,
    implementationRuns: new InMemoryImprovementImplementationRunStore(),
    pullRequests: new InMemoryImprovementPullRequestStore(),
    reviewEvidence: new InMemoryImprovementReviewEvidenceStore(),
    evaluations: new InMemoryPostMergeEvaluationStore(),
    events,
    recommendations: new InMemoryEngineeringPolicyRecommendationStore(),
    snapshots: new InMemoryCrossImprovementSnapshotStore(),
    policySnapshots: new InMemoryEngineeringPolicySnapshotStore(),
    proposalService,
    now: () => Date.parse(NOW)
  });
}

function makeProposal(index: number, options: { finalOutcome: ImprovementProposal["finalOutcome"]; evidenceSamples: number }): ImprovementProposal {
  return improvementProposalSchema.parse({
    proposalId: `meta-proposal-${index}`,
    fingerprint: index.toString(16).padStart(16, "0"),
    status: "merged",
    category: "workflow",
    target: `workflow.target.${index}`,
    title: `Meta fixture ${index}`,
    summary: "Retained fixture for cross-improvement analytics.",
    evidence: {
      matchingRuns: options.evidenceSamples,
      affectedRuns: options.evidenceSamples,
      successAfterEscalation: 1,
      failureAfterEscalation: 0,
      sampleWindow: "retained",
      patternRatio: 0.5,
      failureRate: 0.1,
      sufficient: true,
      minimumMatchingRuns: 10,
      minimumPatternRatio: 0.2,
      supportingTools: [],
      supportingCapabilities: [],
      context: { detector: "fixture-detector", policyRegime: "engineering-policy-v1" },
      rootCause: "likely-mcp-deficiency",
      rootCauseReason: "Fixture.",
      observedAt: NOW
    },
    proposedChange: {
      kind: "workflow-gap",
      target: `workflow.target.${index}`,
      description: "Fixture change.",
      allowedAreas: ["src/workflows/**"],
      forbiddenAreas: ["src/debug/**"],
      changeScope: "small",
      implementationMode: "manual-only",
      suggestedTools: []
    },
    expectedBenefit: { summary: "Fixture benefit.", metrics: [{ name: "workflow.success", direction: "increase", rationale: "Fixture." }] },
    risks: [{ level: "low", description: "Fixture risk.", mitigation: "Fixture mitigation." }],
    validationPlan: {
      existingTests: ["tests/metaAnalytics.test.ts"],
      newRegressionTestRequired: true,
      mockValidation: true,
      hardwareRequired: false,
      replayFixtures: [],
      beforeAfterMetrics: ["workflow.success"],
      rollbackCondition: "Fixture regression.",
      acceptanceCriteria: ["Fixture passes."]
    },
    confidence: 0.7,
    priority: "P2",
    generatedBy: "analytics-pattern",
    sourceWindow: "retained",
    source: "outcome-analytics",
    policyRegime: "engineering-policy-v1",
    engineeringPolicyHash: HASH,
    finalOutcome: options.finalOutcome,
    createdAt: NOW,
    updatedAt: NOW,
    lastObservedAt: NOW
  });
}

function history(id: string, overrides: Partial<ImprovementHistoryRecord> = {}): ImprovementHistoryRecord {
  return {
    proposalId: `history-${id}`,
    proposalStatus: "merged",
    category: "workflow",
    target: `workflow.${id}`,
    risk: "low",
    generatedBy: "analytics-pattern",
    evidenceSampleCount: 20,
    proposalConfidence: 0.7,
    implementationMode: "manual-only",
    implementationRunCount: 1,
    agentAttemptCount: 1,
    revisionCount: 0,
    preMergeValidationPassed: false,
    hardwareRequired: false,
    prReviewRounds: 0,
    merged: false,
    validationEscape: false,
    policyRegime: "engineering-policy-v1",
    engineeringPolicyHash: HASH,
    ...overrides
  };
}
