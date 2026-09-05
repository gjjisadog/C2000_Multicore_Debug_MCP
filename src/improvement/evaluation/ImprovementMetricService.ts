import { randomUUID } from "node:crypto";
import { deterministicStatistics } from "../../analytics/DeterministicStatistics.js";
import type { OutcomeEvent } from "../../analytics/OutcomeSchemas.js";
import {
  evaluationMetricSnapshotSchema,
  metricComparisonSchema,
  type EvaluationMetricDefinition,
  type EvaluationMetricSnapshot,
  type EvaluationMetricStatistics,
  type MetricComparison
} from "./EvaluationSchemas.js";

export interface MetricComparisonResult {
  comparisons: MetricComparison[];
  regressions: MetricComparison[];
  improvements: MetricComparison[];
}

/** Deterministic metric extraction from bounded Outcome Events. */
export class ImprovementMetricService {
  snapshot(
    events: readonly OutcomeEvent[],
    definitions: readonly EvaluationMetricDefinition[],
    phase: "baseline" | "post-merge",
    capturedAt: string,
    options: { snapshotId?: string; comparableEventCount?: number; excludedEventCount?: number } = {}
  ): EvaluationMetricSnapshot {
    const metrics = definitions.map(definition => this.statisticsFor(definition, events));
    return evaluationMetricSnapshotSchema.parse({
      snapshotId: options.snapshotId ?? `snapshot-${randomUUID()}`,
      phase,
      capturedAt,
      eventCount: events.length,
      comparableEventCount: options.comparableEventCount ?? events.length,
      excludedEventCount: options.excludedEventCount ?? 0,
      metrics,
      runtimeIdentities: runtimeIdentities(events)
    });
  }

  compare(baseline: EvaluationMetricSnapshot, current: EvaluationMetricSnapshot, definitions: readonly EvaluationMetricDefinition[]): MetricComparisonResult {
    const baselineByName = new Map(baseline.metrics.map(metric => [metric.name, metric]));
    const currentByName = new Map(current.metrics.map(metric => [metric.name, metric]));
    const comparisons = definitions.map(definition => {
      const left = baselineByName.get(definition.name);
      const right = currentByName.get(definition.name);
      const baselineValue = left?.value ?? null;
      const currentValue = right?.value ?? null;
      const absoluteDelta = baselineValue === null || currentValue === null ? null : currentValue - baselineValue;
      const relativeDelta = absoluteDelta === null || baselineValue === null || baselineValue === 0
        ? null
        : absoluteDelta / Math.abs(baselineValue);
      const sampleCount = right?.sampleCount ?? 0;
      let relationship: MetricComparison["relationship"];
      let evidence: string;
      if (baselineValue === null || currentValue === null || sampleCount === 0) {
        relationship = "insufficient-evidence";
        evidence = "A required baseline or post-merge metric sample is missing; no attribution is made.";
      } else {
        const directionalDelta = definition.direction === "decrease" ? -(absoluteDelta ?? 0) : absoluteDelta ?? 0;
        const withinTolerance = definition.direction === "preserve"
          ? Math.abs(absoluteDelta ?? 0) <= definition.tolerance
          : directionalDelta >= -definition.tolerance;
        const meaningful = definition.direction === "preserve"
          ? false
          : directionalDelta >= definition.meaningfulDelta;
        const materiallyWorse = definition.direction === "preserve"
          ? Math.abs(absoluteDelta ?? 0) > definition.tolerance
          : directionalDelta < -definition.tolerance;
        relationship = materiallyWorse
          ? "consistent-with-regression"
          : meaningful
            ? "consistent-with-benefit"
            : withinTolerance
              ? "no-observable-effect"
              : "consistent-with-regression";
        evidence = relationship === "consistent-with-benefit"
          ? "The post-merge metric moved in the declared direction by a meaningful amount; this is consistent with benefit, not proof of causation."
          : relationship === "consistent-with-regression"
            ? "The post-merge metric moved materially against the declared direction; this is consistent with regression, not proof of causation."
            : "The post-merge metric remained within the declared tolerance; no meaningful effect is observable.";
      }
      return metricComparisonSchema.parse({
        name: definition.name,
        classification: definition.classification,
        direction: definition.direction,
        required: definition.required,
        baselineValue,
        currentValue,
        absoluteDelta,
        relativeDelta,
        tolerance: definition.tolerance,
        meaningfulDelta: definition.meaningfulDelta,
        sampleCount,
        relationship,
        evidence
      });
    });
    return {
      comparisons,
      regressions: comparisons.filter(comparison => comparison.relationship === "consistent-with-regression"),
      improvements: comparisons.filter(comparison => comparison.relationship !== "consistent-with-regression")
    };
  }

  statisticsFor(definition: EvaluationMetricDefinition, events: readonly OutcomeEvent[]): EvaluationMetricStatistics {
    const values: number[] = [];
    for (const event of events) {
      const value = metricValue(event, definition.name);
      if (value !== undefined) values.push(value);
    }
    const statistics = deterministicStatistics(values);
    return {
      name: definition.name,
      classification: definition.classification,
      direction: definition.direction,
      required: definition.required,
      unit: definition.unit,
      statistic: statisticFor(definition.name),
      statistics,
      value: chooseValue(statistics, definition.name),
      sampleCount: values.length,
      sourceEventCount: events.length
    };
  }
}

export function metricValue(event: OutcomeEvent, metricName: string): number | undefined {
  const metadata = event.metadata ?? {};
  const records = [metadata.metrics, metadata.metricValues];
  for (const record of records) {
    if (record && typeof record === "object" && !Array.isArray(record)) {
      const value = (record as Record<string, unknown>)[metricName];
      if (typeof value === "number" && Number.isFinite(value)) return value;
    }
  }
  if (metadata.metricName === metricName && typeof metadata.metricValue === "number" && Number.isFinite(metadata.metricValue)) return metadata.metricValue;
  if (/^(?:duration|durationMs|latency|latencyMs)$/i.test(metricName) && event.durationMs !== undefined) return event.durationMs;
  if (/^(?:success|successRate|workflowSuccessRate|passRate)$/i.test(metricName)) return event.outcome === "success" ? 1 : 0;
  if (/^(?:failure|failureRate|errorRate)$/i.test(metricName)) return event.outcome === "failure" ? 1 : 0;
  if (/^(?:timeout|timeoutRate)$/i.test(metricName)) return event.outcome === "timeout" ? 1 : 0;
  if (/^(?:blocked|blockedRate)$/i.test(metricName)) return event.outcome === "blocked" ? 1 : 0;
  const direct = metadata[metricName];
  return typeof direct === "number" && Number.isFinite(direct) ? direct : undefined;
}

function statisticFor(name: string): "mean" | "p50" | "p95" | "p99" {
  if (/p99/i.test(name)) return "p99";
  if (/p95/i.test(name)) return "p95";
  if (/p50|median/i.test(name)) return "p50";
  return "mean";
}

function chooseValue(statistics: EvaluationMetricStatistics["statistics"], name: string): number | null {
  const statistic = statisticFor(name);
  return statistic === "p99" ? statistics.p99 : statistic === "p95" ? statistics.p95 : statistic === "p50" ? statistics.p50 : statistics.mean;
}

function runtimeIdentities(events: readonly OutcomeEvent[]): Array<{ mcpVersion: string; mcpGitSha: string; count: number }> {
  const counts = new Map<string, { mcpVersion: string; mcpGitSha: string; count: number }>();
  for (const event of events) {
    const runtimeIdentity = event.metadata?.runtimeIdentity;
    const runtime = runtimeIdentity && typeof runtimeIdentity === "object" && !Array.isArray(runtimeIdentity)
      ? runtimeIdentity as Record<string, unknown>
      : {};
    const mcpVersion = event.mcpVersion ?? (typeof runtime.mcpVersion === "string" ? runtime.mcpVersion : "unknown");
    const mcpGitSha = event.mcpGitSha ?? (typeof runtime.mcpGitSha === "string" ? runtime.mcpGitSha : "unknown");
    const key = `${mcpVersion}\u0000${mcpGitSha}`;
    const current = counts.get(key) ?? { mcpVersion, mcpGitSha, count: 0 };
    current.count += 1;
    counts.set(key, current);
  }
  return [...counts.values()].sort((left, right) => `${left.mcpVersion}:${left.mcpGitSha}`.localeCompare(`${right.mcpVersion}:${right.mcpGitSha}`));
}
