import type { DeterministicStatistics } from "./MetricSchemas.js";

export function deterministicStatistics(
  samples: readonly unknown[],
  counters: { missCount?: number; overflowCount?: number; invalidCount?: number } = {}
): DeterministicStatistics {
  const valid: number[] = [];
  let invalidCount = counters.invalidCount ?? 0;
  for (const sample of samples) {
    if (typeof sample === "number" && Number.isFinite(sample)) valid.push(sample);
    else invalidCount += 1;
  }
  valid.sort((left, right) => left - right);
  if (valid.length === 0) {
    return {
      count: 0, min: null, max: null, mean: null, p50: null, p95: null, p99: null, stddev: null,
      missCount: counters.missCount ?? 0,
      overflowCount: counters.overflowCount ?? 0,
      invalidCount
    };
  }
  const mean = valid.reduce((sum, value) => sum + value, 0) / valid.length;
  const variance = valid.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / valid.length;
  return {
    count: valid.length,
    min: valid[0]!,
    max: valid.at(-1)!,
    mean,
    p50: percentileR7(valid, 0.5),
    p95: percentileR7(valid, 0.95),
    p99: percentileR7(valid, 0.99),
    stddev: Math.sqrt(variance),
    missCount: counters.missCount ?? 0,
    overflowCount: counters.overflowCount ?? 0,
    invalidCount
  };
}

/** Hyndman/Fan type 7, used by NumPy's default linear percentile. */
export function percentileR7(sortedValues: readonly number[], probability: number): number | null {
  if (sortedValues.length === 0) return null;
  if (sortedValues.length === 1) return sortedValues[0]!;
  const position = (sortedValues.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const weight = position - lower;
  return sortedValues[lower]! + ((sortedValues[upper]! - sortedValues[lower]!) * weight);
}
