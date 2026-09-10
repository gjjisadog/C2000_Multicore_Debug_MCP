import type {
  EngineeringPolicySnapshot
} from "./MetaSchemas.js";
import type {
  ImprovementHistoryRecord,
  MetaAggregateMetrics,
  MetaRecommendationCategory
} from "./MetaSchemas.js";

export interface MetaRecommendationFinding {
  detector: string;
  category: MetaRecommendationCategory;
  target: string;
  title: string;
  summary: string;
  currentPolicy: Record<string, unknown>;
  recommendedPolicyChange: Record<string, unknown>;
  expectedEffect: string[];
  risks: string[];
  sampleRecords: ImprovementHistoryRecord[];
  effectSize: number;
  confounders: string[];
}

export interface MetaPatternDetectorContext {
  records: ImprovementHistoryRecord[];
  metrics: MetaAggregateMetrics;
  policy: EngineeringPolicySnapshot;
  minSampleSize: number;
}

export interface MetaPatternDetector {
  name: string;
  detect(context: MetaPatternDetectorContext): MetaRecommendationFinding[];
}

export class ProposalThresholdDetector implements MetaPatternDetector {
  readonly name = "ProposalThresholdDetector";
  detect(context: MetaPatternDetectorContext): MetaRecommendationFinding[] {
    const low = context.records.filter(record => record.evidenceSampleCount >= 10 && record.evidenceSampleCount < 20 && record.finalOutcome !== undefined);
    const high = context.records.filter(record => record.evidenceSampleCount >= 30 && record.finalOutcome !== undefined);
    if (low.length < context.minSampleSize || high.length < context.minSampleSize) return [];
    const lowBad = low.filter(record => record.finalOutcome === "no-observable-benefit" || record.finalOutcome === "verified-regression").length / low.length;
    const highGood = high.filter(record => record.finalOutcome === "verified-improvement").length / high.length;
    if (lowBad < 0.6 || highGood < 0.6 || lowBad - (1 - highGood) < 0.2) return [];
    return [{
      detector: this.name,
      category: "proposal-policy",
      target: "proposal.minimumEvidenceSamples",
      title: "Consider raising the evidence threshold for low-sample proposals",
      summary: `Proposals with 10–19 evidence samples had a ${(lowBad * 100).toFixed(0)}% neutral/regression rate while proposals with 30+ samples had a ${(highGood * 100).toFixed(0)}% verified-improvement rate.`,
      currentPolicy: { minimumMatchingRuns: 10 },
      recommendedPolicyChange: { minimumMatchingRuns: 20, scope: "category-specific-first" },
      expectedEffect: ["Decrease neutral and regression rates without materially collapsing useful proposal throughput.", "Increase verified-improvement yield for evidence-rich proposals."],
      risks: ["A higher threshold can delay or suppress valuable low-frequency improvements; evaluate throughput and median evidence wait."],
      sampleRecords: [...low, ...high],
      effectSize: Math.max(0, Math.min(1, lowBad - (1 - highGood))),
      confounders: ["Evidence sample size is observational and may correlate with proposal category or runtime exposure."]
    }];
  }
}

export class ValidationEscapeDetector implements MetaPatternDetector {
  readonly name = "ValidationEscapeDetector";
  detect(context: MetaPatternDetectorContext): MetaRecommendationFinding[] {
    const escaped = context.records.filter(record => record.validationEscape);
    if (escaped.length < 2) return [];
    const mergedEvaluated = context.records.filter(record => record.merged && record.finalOutcome !== undefined).length;
    const rate = mergedEvaluated === 0 ? 0 : escaped.length / mergedEvaluated;
    return [{
      detector: this.name,
      category: "validation-policy",
      target: "validation.postMergeReplayEvidence",
      title: "Require stronger replay or post-merge evidence for escaping proposal classes",
      summary: `${escaped.length} merged change(s) passed pre-merge validation but later reached a verified regression.`,
      currentPolicy: { postMergeReplayRequired: false },
      recommendedPolicyChange: { postMergeReplayRequired: true, scope: "affected-proposal-class" },
      expectedEffect: ["Reduce validation escape rate.", "Preserve existing unit, safety, CI, and hardware gates while adding targeted replay evidence."],
      risks: ["Additional replay evidence increases validation cost and must be measured against detection value."],
      sampleRecords: escaped,
      effectSize: Math.max(0, Math.min(1, rate)),
      confounders: ["Post-merge deployment and runtime comparability may confound escape attribution."]
    }];
  }
}

export class HardwareGateDetector implements MetaPatternDetector {
  readonly name = "HardwareGateDetector";
  detect(context: MetaPatternDetectorContext): MetaRecommendationFinding[] {
    const hardwareMisses = context.records.filter(record => record.hardwareRequired === false && record.hardwareValidationVerdict === "failed");
    if (hardwareMisses.length < 2) return [];
    const category = mostCommon(hardwareMisses.map(record => record.category)) ?? "reliability";
    return [{
      detector: this.name,
      category: "hardware-policy",
      target: `hardwareRequired.${category}`,
      title: `Require hardware validation for ${category} changes`,
      summary: `${hardwareMisses.length} ${category} change(s) passed the non-hardware path but failed hardware validation.`,
      currentPolicy: { hardwareRequired: false, category },
      recommendedPolicyChange: { hardwareRequired: true, category },
      expectedEffect: ["Catch hardware-specific regressions before merge.", "Do not remove any existing host or safety validation stage."],
      risks: ["Hardware capacity and test time may reduce throughput; keep the gate scoped to the affected class."],
      sampleRecords: hardwareMisses,
      effectSize: Math.max(0, Math.min(1, hardwareMisses.length / Math.max(1, context.records.length))),
      confounders: ["Hardware failures can also reflect board, firmware, probe, or environment instability."]
    }];
  }
}

export class ToolSurfacePolicyDetector implements MetaPatternDetector {
  readonly name = "ToolSurfacePolicyDetector";
  detect(context: MetaPatternDetectorContext): MetaRecommendationFinding[] {
    const candidates = context.records.filter(record => record.category === "tool-surface" && record.workflowCovered === true && (record.toolUsageCount ?? 0) <= 5 && (record.schemaCostBytes ?? 0) >= 1024);
    if (candidates.length < 3) return [];
    const target = mostCommon(candidates.map(record => record.target));
    if (!target) return [];
    return [{
      detector: this.name,
      category: "tool-surface-policy",
      target,
      title: `Consider moving ${target} behind the Advanced surface`,
      summary: `${target} has low observed use, a large schema footprint, and an equivalent task-level workflow in the retained evidence.`,
      currentPolicy: { exposure: "default", workflowCovered: true },
      recommendedPolicyChange: { exposure: "advanced", preserveCompatibilityAlias: true },
      expectedEffect: ["Reduce default tools/list schema and tool-selection friction.", "Keep the canonical tool available on Advanced and preserve compatibility aliases."],
      risks: ["A low observed count may reflect a rare but legitimate workflow; retain an explicit capability or Advanced path."],
      sampleRecords: candidates.filter(record => record.target === target),
      effectSize: Math.min(1, (Math.max(...candidates.map(record => record.schemaCostBytes ?? 0)) / 10_000) + 0.2),
      confounders: ["Tool usage telemetry is bounded and does not prove that a tool is never needed."]
    }];
  }
}

export class CapabilityPolicyDetector implements MetaPatternDetector {
  readonly name = "CapabilityPolicyDetector";
  detect(context: MetaPatternDetectorContext): MetaRecommendationFinding[] {
    const records = context.records.filter(record => record.category === "capability" && record.capabilityName && (record.finalOutcome === "no-observable-benefit" || record.finalOutcome === "inconclusive"));
    if (records.length < context.minSampleSize) return [];
    const capability = mostCommon(records.map(record => record.capabilityName!));
    if (!capability) return [];
    return [{
      detector: this.name,
      category: "capability-policy",
      target: `capability.${capability}.guidance`,
      title: `Improve ${capability} escalation guidance before changing safety`,
      summary: `${capability} capability sessions are frequently associated with neutral or inconclusive outcomes.`,
      currentPolicy: { capability, temporaryOnly: true },
      recommendedPolicyChange: { capability, requireTaskWorkflowFirst: true, preserveTemporaryTtl: true },
      expectedEffect: ["Reduce unnecessary capability opens and abandoned escalation paths.", "Keep temporary sessions and safety filtering unchanged."],
      risks: ["Correlation does not prove the capability is unnecessary; retain Advanced access for explicit specialist tasks."],
      sampleRecords: records.filter(record => record.capabilityName === capability),
      effectSize: records.length / Math.max(1, context.records.length),
      confounders: ["Capability use is task-dependent and may be driven by missing workflow evidence."]
    }];
  }
}

export class SkillPolicyDetector implements MetaPatternDetector {
  readonly name = "SkillPolicyDetector";
  detect(context: MetaPatternDetectorContext): MetaRecommendationFinding[] {
    const records = context.records.filter(record => record.category === "skill" && (record.finalOutcome === "no-observable-benefit" || record.finalOutcome === "verified-regression"));
    if (records.length < context.minSampleSize) return [];
    return [{
      detector: this.name,
      category: "skill-policy",
      target: "skill.workflow-first-routing",
      title: "Strengthen workflow-first routing in the C2000 Skill",
      summary: `${records.length} Skill-related improvements did not produce an observable benefit or regressed after merge.`,
      currentPolicy: { workflowFirstRequired: true },
      recommendedPolicyChange: { workflowFirstRequired: true, requireCapabilityEscalationReason: true },
      expectedEffect: ["Increase task-level workflow selection and reduce unnecessary atomic chains.", "Preserve all MCP and safety boundaries."],
      risks: ["Overly prescriptive routing can make rare expert tasks harder; keep Advanced and Capability guidance explicit."],
      sampleRecords: records,
      effectSize: records.length / Math.max(1, context.records.length),
      confounders: ["Skill outcome attribution may include unrelated documentation and workflow changes."]
    }];
  }
}

export class AgentAttemptPolicyDetector implements MetaPatternDetector {
  readonly name = "AgentAttemptPolicyDetector";
  detect(context: MetaPatternDetectorContext): MetaRecommendationFinding[] {
    const records = context.records.filter(record => record.implementationRunCount > 0 && record.agentAttemptCount > 1);
    if (records.length < context.minSampleSize) return [];
    const failedRepairs = records.filter(record => record.finalOutcome === "verified-regression" || record.finalOutcome === "inconclusive").length;
    if (failedRepairs / records.length < 0.6) return [];
    return [{
      detector: this.name,
      category: "implementation-policy",
      target: "implementation.maxAgentAttempts",
      title: "Consider reducing repair attempts for this implementation class",
      summary: `Repair attempts were present in ${records.length} records and remained unsuccessful or inconclusive in ${failedRepairs}.`,
      currentPolicy: { maxAgentAttempts: 2 },
      recommendedPolicyChange: { maxAgentAttempts: 1, scope: "affected-risk-class" },
      expectedEffect: ["Reduce repeated implementation burden and bounded-agent churn.", "Keep a finite retry cap and human review path."],
      risks: ["Some low-risk failures are recoverable on a second attempt; validate throughput before changing the global cap."],
      sampleRecords: records,
      effectSize: failedRepairs / records.length,
      confounders: ["Agent attempts can be caused by validation or environment failures rather than coding quality."]
    }];
  }
}

export class ReviewBurdenDetector implements MetaPatternDetector {
  readonly name = "ReviewBurdenDetector";
  detect(context: MetaPatternDetectorContext): MetaRecommendationFinding[] {
    const records = context.records.filter(record => (record.prReviewRounds ?? 0) >= 3);
    if (records.length < context.minSampleSize) return [];
    return [{
      detector: this.name,
      category: "review-policy",
      target: "review.architectureEvidenceForHighRevisionChanges",
      title: "Add focused architecture evidence for high-revision changes",
      summary: `${records.length} improvements required at least three review/revision rounds.`,
      currentPolicy: { architectureEvidenceRequired: false },
      recommendedPolicyChange: { architectureEvidenceRequired: true, scope: "high-revision-or-governance" },
      expectedEffect: ["Reduce avoidable review revisions while retaining human review.", "Improve review evidence quality without treating comments as executable instructions."],
      risks: ["Additional review artifacts can increase authoring cost; keep the requirement scoped."],
      sampleRecords: records,
      effectSize: records.length / Math.max(1, context.records.length),
      confounders: ["Review rounds may reflect legitimate scope discovery rather than weak Proposal quality."]
    }];
  }
}

export class EvaluationPolicyDetector implements MetaPatternDetector {
  readonly name = "EvaluationPolicyDetector";
  detect(context: MetaPatternDetectorContext): MetaRecommendationFinding[] {
    const records = context.records.filter(record => record.finalOutcome === "inconclusive");
    if (records.length < context.minSampleSize || context.metrics.inconclusiveRate.rate < 0.4) return [];
    return [{
      detector: this.name,
      category: "evaluation-policy",
      target: "evaluation.minimumComparableSamples",
      title: "Increase evidence quality before closing post-merge evaluations",
      summary: `${records.length} evaluated improvements were inconclusive; the current history may not provide enough comparable samples.`,
      currentPolicy: { minimumComparableSamples: 1 },
      recommendedPolicyChange: { minimumComparableSamples: 2, preserveMinimumObservationWindow: true },
      expectedEffect: ["Decrease inconclusive evaluation rate and improve outcome attribution.", "Never shorten Critical or Hardware observation requirements."],
      risks: ["Longer observation increases time-to-final-evaluation; report the cost alongside predictive value."],
      sampleRecords: records,
      effectSize: context.metrics.inconclusiveRate.rate,
      confounders: ["Deployment identity and runtime comparability can make an evaluation inconclusive even with more samples."]
    }];
  }
}

function mostCommon(values: string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0];
}

/** Deterministic evidence patterns. They suggest policy work; they never write policy. */
export const META_PATTERN_DETECTORS: readonly MetaPatternDetector[] = [
  new ProposalThresholdDetector(),
  new ValidationEscapeDetector(),
  new HardwareGateDetector(),
  new ToolSurfacePolicyDetector(),
  new CapabilityPolicyDetector(),
  new SkillPolicyDetector(),
  new AgentAttemptPolicyDetector(),
  new ReviewBurdenDetector(),
  new EvaluationPolicyDetector()
];
