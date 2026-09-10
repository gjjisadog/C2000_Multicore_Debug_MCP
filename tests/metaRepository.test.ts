import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { SqliteStore } from "../src/storage/SqliteStore.js";
import { aggregateImprovementHistory } from "../src/improvement/meta/CrossImprovementAnalyticsService.js";
import {
  CrossImprovementSnapshotRepository,
  EngineeringPolicyRecommendationRepository,
  EngineeringPolicySnapshotRepository
} from "../src/improvement/meta/MetaRepositories.js";
import {
  crossImprovementSnapshotSchema,
  engineeringPolicyRecommendationSchema
} from "../src/improvement/meta/MetaSchemas.js";
import { currentEngineeringPolicySnapshot } from "../src/improvement/meta/PolicySnapshotService.js";

const NOW = "2026-09-05T00:00:00.000Z";
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe("Round10 meta repositories", () => {
  test("persist policy recommendations and aggregate snapshots without a raw history table", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "c2000-meta-repository-test-"));
    directories.push(directory);
    const databasePath = path.join(directory, "c2000-debugd.sqlite");
    const policy = currentEngineeringPolicySnapshot({ capturedAt: NOW });
    const recommendation = engineeringPolicyRecommendationSchema.parse({
      recommendationId: "meta-repository-test",
      fingerprint: "b".repeat(64),
      createdAt: NOW,
      updatedAt: NOW,
      lastObservedAt: NOW,
      category: "validation-policy",
      target: "validation.replay",
      title: "Require replay evidence",
      summary: "Replay evidence is warranted for a repeatedly escaping class.",
      evidence: {
        sampleSize: 10,
        timeWindow: { from: null, to: NOW },
        proposalCategory: "test-coverage",
        currentPolicyRegime: policy.policyRegime,
        finalOutcomeDistribution: {
          "verified-improvement": 0,
          "no-observable-benefit": 0,
          "verified-regression": 2,
          inconclusive: 0,
          "rolled-back": 0,
          superseded: 0
        },
        validationEscapeCount: 2,
        effectSize: 0.2,
        relevantProposalIds: ["proposal-1"],
        relevantEvaluationIds: ["evaluation-1"],
        confounders: ["Runtime identity is retained as evidence."]
      },
      currentPolicy: { postMergeReplayRequired: false },
      recommendedPolicyChange: { postMergeReplayRequired: true },
      expectedEffect: ["Reduce validation escapes."],
      risks: ["Replay costs additional validation time."],
      confidence: 0.7,
      sampleSize: 10,
      policyRegime: policy.policyRegime,
      engineeringPolicyHash: policy.engineeringPolicyHash,
      detector: "ValidationEscapeDetector",
      status: "ready-for-review",
      automaticExecutionAllowed: false
    });
    const metrics = aggregateImprovementHistory([]);
    const snapshot = crossImprovementSnapshotSchema.parse({
      snapshotId: "meta-snapshot-test",
      generatedAt: NOW,
      from: null,
      to: NOW,
      policyRegime: policy.policyRegime,
      engineeringPolicyHash: policy.engineeringPolicyHash,
      historyStatus: "INSUFFICIENT_META_HISTORY",
      sampleSize: 0,
      evaluatedSampleSize: 0,
      metrics,
      byCategory: [],
      byRisk: [],
      byGenerator: [],
      byDetector: [],
      byPolicyRegime: [],
      confidenceCalibration: [],
      evidenceSampleOutcome: [],
      validationPredictiveValue: {
        preMergeValidated: 0,
        postMergeRegressionsAfterValidation: 0,
        predictiveValue: { numerator: 0, denominator: 0, rate: 0 },
        validationEscapeCount: 0,
        reviewEscapeCount: 0
      },
      hardwareGateEffectiveness: {
        hardwareRequired: 0,
        hardwareFailedBeforeMerge: 0,
        hardwareCaughtRegressionBeforeMerge: 0,
        hardwarePassed: 0,
        postMergeRegressionAfterHardwarePass: 0,
        predictiveValue: { numerator: 0, denominator: 0, rate: 0 }
      },
      toolSurfaceEffectiveness: metrics,
      capabilityEffectiveness: metrics,
      workflowEffectiveness: metrics,
      confounders: ["No completed post-merge sample exists."]
    });

    const first = await SqliteStore.open(databasePath);
    new EngineeringPolicyRecommendationRepository(first).upsert(recommendation);
    new EngineeringPolicySnapshotRepository(first).upsert(policy);
    new CrossImprovementSnapshotRepository(first).append(snapshot);
    first.close();

    const second = await SqliteStore.open(databasePath);
    expect(new EngineeringPolicyRecommendationRepository(second).get(recommendation.recommendationId)).toEqual(recommendation);
    expect(new EngineeringPolicySnapshotRepository(second).get(policy.snapshotId)).toEqual(policy);
    expect(new CrossImprovementSnapshotRepository(second).get(snapshot.snapshotId)).toEqual(snapshot);
    const tables = second.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").map(row => row.name);
    expect(tables).toEqual(expect.arrayContaining([
      "engineering_policy_recommendations",
      "engineering_policy_snapshots",
      "cross_improvement_snapshots"
    ]));
    expect(tables).not.toContain("meta_learning_records");
    second.close();
  });
});
