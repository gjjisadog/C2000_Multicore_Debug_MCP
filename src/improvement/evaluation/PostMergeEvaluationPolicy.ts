import type { OutcomeEvent } from "../../analytics/OutcomeSchemas.js";
import {
  regressionFindingSchema,
  type ComparabilityReport,
  type EvaluationMetricDefinition,
  type ImprovementAttribution,
  type MetricComparison,
  type PostMergeVerdict,
  type RegressionFinding
} from "./EvaluationSchemas.js";

export interface PostMergePolicyInput {
  definitions: readonly EvaluationMetricDefinition[];
  comparisons: readonly MetricComparison[];
  comparability: ComparabilityReport;
  deploymentReady: boolean;
  durationDays: number;
  minimumDurationDays: number;
  comparableSamples: number;
  minimumComparableSamples: number;
  postMergeEvents: readonly OutcomeEvent[];
}

export interface PostMergePolicyResult {
  verdict: PostMergeVerdict;
  confidence: number;
  regressions: RegressionFinding[];
  improvements: ImprovementAttribution[];
  confounders: string[];
  rationale: string[];
}

/** Deterministic, fail-closed policy; it makes no causal claim. */
export function evaluatePostMergeOutcome(input: PostMergePolicyInput): PostMergePolicyResult {
  const byName = new Map(input.definitions.map(definition => [definition.name, definition]));
  const transientFailureCount = input.postMergeEvents.filter(event => ["failure", "timeout", "blocked"].includes(event.outcome)).length;
  const regressions = input.comparisons
    .filter(comparison => comparison.relationship === "consistent-with-regression")
    .map(comparison => regressionFindingSchema.parse({
      findingId: `finding-${comparison.name}`,
      metric: comparison.name,
      classification: comparison.classification,
      severity: isSafetyMetric(comparison.name, comparison.classification)
        ? "critical"
        : comparison.required && transientFailureCount !== 1
          ? "significant"
          : "warning",
      baselineValue: comparison.baselineValue,
      currentValue: comparison.currentValue,
      absoluteDelta: comparison.absoluteDelta,
      relativeDelta: comparison.relativeDelta,
      samples: comparison.sampleCount,
      evidence: comparison.evidence,
      related: comparison.required || isRelatedMetric(comparison.name, comparison.classification)
    }));
  const improvements = input.comparisons.map(comparison => ({
    metric: comparison.name,
    relationship: comparison.relationship,
    evidence: comparison.evidence,
    confidence: confidenceFor(input, comparison),
    related: byName.get(comparison.name)?.required ?? false
  }));
  const confounders = [...input.comparability.confounders];
  const rationale: string[] = [];
  const safetyViolation = input.postMergeEvents.some(event => event.metadata?.safetyRegression === true || event.metadata?.safetyViolation === true);
  if (safetyViolation) {
    regressions.unshift(regressionFindingSchema.parse({
      findingId: "finding-safety-invariant",
      metric: "safetyInvariant",
      classification: "safety",
      severity: "critical",
      baselineValue: 0,
      currentValue: 1,
      absoluteDelta: 1,
      relativeDelta: null,
      samples: input.postMergeEvents.length,
      evidence: "A post-merge event marked a protected safety invariant violation; this is a P0 rollback signal and is not attributed causally.",
      related: true
    }));
    rationale.push("A protected safety invariant violation is a hard regression gate.");
  }
  if (!input.deploymentReady) {
    rationale.push("No post-merge runtime matching the merged commit or a known containing release was observed.");
    return result("inconclusive", input, regressions, improvements, confounders, rationale);
  }
  if (safetyViolation) {
    // Protected invariant evidence is an early-regression exception. It can
    // produce a human-only critical recommendation before ordinary duration
    // and sample gates mature, but it still cannot execute a rollback.
    rationale.push("A protected safety invariant violation permits an immediate critical regression alert before ordinary sample maturity.");
    return result("regressed", input, regressions, improvements, confounders, rationale);
  }
  if (input.comparability.status !== "comparable") {
    rationale.push("Baseline and post-merge observations are not comparable; evaluation fails closed.");
    return result("inconclusive", input, regressions, improvements, confounders, rationale);
  }
  if (input.durationDays < input.minimumDurationDays || input.comparableSamples < input.minimumComparableSamples) {
    rationale.push(`The observation window has ${input.durationDays.toFixed(2)} day(s) and ${input.comparableSamples} comparable sample(s); more data is required.`);
    return result("inconclusive", input, regressions, improvements, confounders, rationale);
  }
  const requiredMissing = input.comparisons.some(comparison => comparison.required && comparison.relationship === "insufficient-evidence");
  if (requiredMissing) {
    rationale.push("At least one required primary metric has insufficient evidence.");
    return result("inconclusive", input, regressions, improvements, confounders, rationale);
  }
  const blockingRegression = regressions.some(finding => finding.severity !== "warning");
  if (blockingRegression) {
    rationale.push("One or more required, safety, reliability, or performance metrics moved materially in the wrong direction.");
    return result("regressed", input, regressions, improvements, confounders, rationale);
  }
  const meaningfulImprovement = input.comparisons.some(comparison => comparison.relationship === "consistent-with-benefit" && comparison.required);
  if (meaningfulImprovement) {
    rationale.push("All required metrics are non-regressed and at least one primary metric shows a meaningful directional improvement.");
    return result("improved", input, regressions, improvements, confounders, rationale);
  }
  rationale.push("Required metrics remain within tolerance, but no meaningful primary benefit is observable.");
  return result("neutral", input, regressions, improvements, confounders, rationale);
}

function result(
  verdict: PostMergeVerdict,
  input: PostMergePolicyInput,
  regressions: RegressionFinding[],
  improvements: ImprovementAttribution[],
  confounders: string[],
  rationale: string[]
): PostMergePolicyResult {
  const dataFactor = Math.min(0.35, input.comparableSamples / 1000) + Math.min(0.2, input.durationDays / 150);
  const confidence = verdict === "inconclusive" ? Math.min(0.35, 0.1 + dataFactor) : Math.min(0.99, 0.5 + dataFactor + (input.comparability.status === "comparable" ? 0.15 : 0));
  return { verdict, confidence, regressions, improvements, confounders, rationale };
}

function confidenceFor(input: PostMergePolicyInput, comparison: MetricComparison): number {
  return Math.min(0.99, 0.35 + Math.min(0.4, comparison.sampleCount / 100) + (input.comparability.status === "comparable" ? 0.15 : 0));
}

function isSafetyMetric(name: string, classification: EvaluationMetricDefinition["classification"]): boolean {
  return classification === "safety" || /safety|invariant|lease|ownership|flash/i.test(name);
}

function isRelatedMetric(name: string, classification: EvaluationMetricDefinition["classification"]): boolean {
  return classification === "reliability" || classification === "performance" || /success|failure|timeout|latency|duration/i.test(name);
}
