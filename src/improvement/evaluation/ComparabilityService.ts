import type { OutcomeEvent } from "../../analytics/OutcomeSchemas.js";
import {
  comparabilityReportSchema,
  type ComparabilityDimension,
  type ComparabilityReport
} from "./EvaluationSchemas.js";

export const COMPARABILITY_DIMENSIONS = [
  "workflow",
  "adapterMode",
  "boardCount",
  "evidenceMode",
  "firmwareIdentity",
  "testPlanIdentity",
  "toolProfile",
  "surfaceProfile",
  "relevantCapabilities",
  "osRuntime",
  "mcpVersion",
  "mcpGitSha"
] as const;

export type ComparabilityDimensionName = typeof COMPARABILITY_DIMENSIONS[number];
export type ComparisonContext = Record<ComparabilityDimensionName, string | null>;

export interface ComparableEventSet {
  events: OutcomeEvent[];
  context: ComparisonContext | null;
  mixedDimensions: ComparabilityDimensionName[];
}

/**
 * Fail-closed context comparison for post-merge attribution. Probe serials
 * and other physical identifiers are deliberately not part of this context:
 * they are useful for operations, not public improvement statistics.
 */
export class ComparabilityService {
  contextForEvent(event: OutcomeEvent): ComparisonContext {
    const metadata = event.metadata ?? {};
    const workflow = stringValue(metadata.workflow)
      ?? (event.kind === "workflow_run" ? event.name : stringValue(metadata.workflowName))
      ?? (event.name.startsWith("c2000_") ? event.name : null);
    const evidenceMode = stringValue(metadata.hardwareMode)
      ?? stringValue(metadata.evidenceLevel)
      ?? (event.name.toLowerCase().includes("mock") ? "mock" : null);
    return {
      workflow,
      adapterMode: stringValue(metadata.adapterMode),
      boardCount: event.boardCount === undefined ? null : String(event.boardCount),
      evidenceMode,
      firmwareIdentity: stringValue(metadata.firmwareIdentity),
      testPlanIdentity: stringValue(metadata.testPlanIdentity),
      toolProfile: event.toolProfile,
      surfaceProfile: event.toolSurfaceProfile,
      // An empty capability set is an explicit, comparable state. Treating it
      // as unknown would make ordinary agent-surface events fail closed even
      // when both sides intentionally used no temporary capability.
      relevantCapabilities: event.activeCapabilities.length > 0 ? [...event.activeCapabilities].sort().join(",") : "none",
      osRuntime: stringValue(metadata.osRuntime),
      mcpVersion: event.mcpVersion ?? stringValue((metadata.runtimeIdentity as Record<string, unknown> | undefined)?.mcpVersion),
      mcpGitSha: event.mcpGitSha
        ?? stringValue(metadata.deployedCommitSha)
        ?? stringValue(metadata.releaseContainsSha)
        ?? stringValue((metadata.runtimeIdentity as Record<string, unknown> | undefined)?.mcpGitSha)
    };
  }

  summarize(events: readonly OutcomeEvent[]): ComparableEventSet {
    if (events.length === 0) return { events: [], context: null, mixedDimensions: [] };
    const contexts = events.map(event => this.contextForEvent(event));
    const reference = contexts[0]!;
    const mixedDimensions = COMPARABILITY_DIMENSIONS.filter(name => new Set(contexts.map(context => context[name])).size > 1);
    return {
      events: [...events],
      context: mixedDimensions.length === 0 ? reference : null,
      mixedDimensions
    };
  }

  filterToContext(events: readonly OutcomeEvent[], context: ComparisonContext): OutcomeEvent[] {
    return events.filter(event => sameContext(this.contextForEvent(event), context));
  }

  compare(
    baselineEvents: readonly OutcomeEvent[],
    postMergeEvents: readonly OutcomeEvent[],
    options: { expectedBaselineGitSha?: string; expectedPostMergeGitSha?: string } = {}
  ): { report: ComparabilityReport; baseline: ComparableEventSet; postMerge: ComparableEventSet } {
    const baseline = this.summarize(baselineEvents);
    const postMerge = this.summarize(postMergeEvents);
    const dimensions: ComparabilityDimension[] = [];
    const reasons: string[] = [];
    const confounders: string[] = [];

    for (const name of COMPARABILITY_DIMENSIONS) {
      const baselineValue = baseline.context?.[name] ?? null;
      const currentValue = postMerge.context?.[name] ?? null;
      let comparable = baseline.context !== null && postMerge.context !== null;
      let reason = comparable ? "matched" : "at least one side is mixed or empty";
      if (baseline.mixedDimensions.includes(name) || postMerge.mixedDimensions.includes(name)) {
        comparable = false;
        reason = "dimension contains multiple identities";
      } else if (baselineValue === null || currentValue === null) {
        comparable = false;
        reason = "dimension is unknown";
      } else if (name === "mcpGitSha") {
        // The SHA is expected to change across a merged code change. What is
        // unsafe is an unknown or internally mixed runtime, not a baseline vs
        // candidate SHA difference.
        comparable = true;
        reason = "baseline and post-merge runtime identities are recorded separately";
      } else if (baselineValue !== currentValue) {
        comparable = false;
        reason = "identity mismatch";
      }
      if (name === "mcpVersion" && baselineValue !== currentValue) {
        comparable = false;
        reason = "runtime version mismatch";
      }
      if (name === "mcpGitSha" && options.expectedBaselineGitSha && options.expectedPostMergeGitSha) {
        const baselineMatches = sameSha(baselineValue, options.expectedBaselineGitSha);
        const postMatches = sameSha(currentValue, options.expectedPostMergeGitSha);
        comparable = comparable && baselineMatches && postMatches;
        if (!baselineMatches || !postMatches) reason = "runtime SHA does not match the expected baseline or merged commit";
      }
      if (!comparable) {
        reasons.push(`${name}: ${reason}`);
        if (name === "evidenceMode" || name === "firmwareIdentity" || name === "testPlanIdentity" || name === "mcpVersion" || name === "mcpGitSha") {
          confounders.push(`${name}: ${reason}`);
        }
      }
      dimensions.push({ name, baseline: baselineValue, current: currentValue, comparable, reason });
    }

    const status = baselineEvents.length === 0 || postMergeEvents.length === 0
      ? "unknown"
      : dimensions.every(dimension => dimension.comparable)
        ? "comparable"
        : "not-comparable";
    if (baseline.mixedDimensions.length > 0) reasons.push(`baseline has mixed dimensions: ${baseline.mixedDimensions.join(", ")}`);
    if (postMerge.mixedDimensions.length > 0) reasons.push(`post-merge data has mixed dimensions: ${postMerge.mixedDimensions.join(", ")}`);
    return {
      report: comparabilityReportSchema.parse({
        status,
        score: dimensions.length === 0
          ? 0
          : dimensions.filter(dimension => dimension.comparable).length / dimensions.length,
        dimensions,
        reasons,
        confounders,
        baselineEventCount: baselineEvents.length,
        postMergeEventCount: postMergeEvents.length,
        comparableBaselineEventCount: status === "comparable" ? baseline.events.length : 0,
        comparablePostMergeEventCount: status === "comparable" ? postMerge.events.length : 0,
        excludedPostMergeEventCount: Math.max(0, postMergeEvents.length - postMerge.events.length)
      }),
      baseline,
      postMerge
    };
  }
}

function sameContext(left: ComparisonContext, right: ComparisonContext): boolean {
  return COMPARABILITY_DIMENSIONS.every(name => name === "mcpGitSha" || left[name] === right[name]);
}

function sameSha(value: string | null, expected: string): boolean {
  return value !== null && value.toLowerCase() === expected.toLowerCase();
}

function stringValue(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  return value.trim().slice(0, 512);
}
