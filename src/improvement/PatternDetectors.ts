import { createHash } from "node:crypto";
import {
  c2000ToolDefinitions,
  type ToolDefinition
} from "../mcp/tools.js";
import type { OutcomeEvent, OutcomeFailureClass, AnalyticsWindow } from "../analytics/OutcomeSchemas.js";
import {
  MIN_PATTERN_RATIO,
  MIN_PROPOSAL_MATCHING_RUNS,
  proposalFingerprint
} from "./ProposalPolicy.js";
import {
  proposalEvidenceSchema,
  type ExpectedBenefit,
  type ImprovementProposal,
  type ProposalCategory,
  type ProposalFinding,
  type ProposalRisk,
  type ValidationPlan
} from "./ProposalSchemas.js";

const ASSOCIATION_WINDOW_MS = 30 * 60 * 1000;
const SAFE_READ_EFFECTS = new Set(["host-read", "target-read"]);
const MAX_SURFACE_PROMOTION_SCHEMA_BYTES = 4096;

export interface DetectorContext {
  events: readonly OutcomeEvent[];
  window: AnalyticsWindow;
  from: string;
  to: string;
  nowMs: number;
  minMatchingRuns?: number;
  minPatternRatio?: number;
}

export interface DetectorResult {
  detector: string;
  findings: ProposalFinding[];
  insufficientEvidenceCount: number;
}

export interface ProposalDetector {
  readonly name: string;
  detect(context: DetectorContext): DetectorResult;
}

export class WorkflowEscalationDetector implements ProposalDetector {
  readonly name = "WorkflowEscalationDetector";

  detect(context: DetectorContext): DetectorResult {
    const workflowEvents = context.events.filter(event => event.kind === "workflow_run");
    const findings: ProposalFinding[] = [];
    let insufficientEvidenceCount = 0;
    for (const [workflow, rows] of groupBy(workflowEvents, event => event.name)) {
      const failures = rows.filter(isFailure);
      if (failures.length === 0) continue;
      const capabilityNames = new Set<string>();
      for (const failure of failures) {
        for (const open of matchingCapabilityOpens(failure, workflow, context.events)) {
          capabilityNames.add(open.escalationTo ?? open.name);
        }
      }
      for (const capability of Array.from(capabilityNames).sort()) {
        const cases = failures.flatMap(failure => {
          const open = matchingCapabilityOpens(failure, workflow, context.events)
            .find(candidate => (candidate.escalationTo ?? candidate.name) === capability);
          if (!open) return [];
          return [{ failure, open }];
        });
        if (cases.length === 0) continue;
        const successful = cases.filter(item => continuationSucceeded(item.failure, item.open, workflow, rows, context.events));
        const evidence = evidenceFor({
          context,
          matchingRuns: failures.length,
          affectedRuns: cases.length,
          successAfterEscalation: successful.length,
          failureAfterEscalation: cases.length - successful.length,
          supportingCapabilities: [capability],
          supportingTools: continuationTools(cases, workflow, context.events),
          contextValues: { workflow, capability, failureClass: dominantFailureClass(failures) },
          rootCause: rootCauseFor([...failures, ...cases.map(item => item.open)], successful.length > 0)
        });
        const sufficient = isSufficient(evidence, context);
        if (!sufficient) insufficientEvidenceCount += 1;
        findings.push(workflowGapFinding(workflow, capability, evidence));
      }
    }
    return { detector: this.name, findings, insufficientEvidenceCount };
  }
}

export class ToolSurfaceUsageDetector implements ProposalDetector {
  readonly name = "ToolSurfaceUsageDetector";

  detect(context: DetectorContext): DetectorResult {
    const toolEvents = context.events.filter(event => event.kind === "tool_invocation");
    const advancedRows = toolEvents.filter(event => metadataString(event, "exposure") === "advanced");
    const findings: ProposalFinding[] = [];
    let insufficientEvidenceCount = 0;
    const totalAdvanced = Math.max(1, advancedRows.length);
    for (const [tool, rows] of groupBy(advancedRows, event => event.name)) {
      const definition = definitionFor(tool);
      if (!definition
        || definition.role !== "primary"
        || definition.family === "observability"
        || definition.capability?.startsWith("observability.")
        || !isReadOnlyDefinition(definition, rows)) continue;
      const schemaCostBytes = estimatedSchemaCost(definition);
      if (schemaCostBytes > MAX_SURFACE_PROMOTION_SCHEMA_BYTES) continue;
      const ratio = rows.length / totalAdvanced;
      if (rows.length < (context.minMatchingRuns ?? MIN_PROPOSAL_MATCHING_RUNS)) {
        insufficientEvidenceCount += 1;
        continue;
      }
      if (ratio < (context.minPatternRatio ?? MIN_PATTERN_RATIO)) continue;
      const evidence = evidenceFor({
        context,
        matchingRuns: rows.length,
        affectedRuns: rows.length,
        successAfterEscalation: rows.filter(event => event.outcome === "success").length,
        failureAfterEscalation: rows.filter(isFailure).length,
        supportingTools: [tool],
        contextValues: { tool, effects: definition.effects.join(","), schemaCostBytes: String(schemaCostBytes) },
        rootCause: rootCauseFor(rows, true),
        schemaCostBytes
      });
      findings.push({
        detector: this.name,
        fingerprint: proposalFingerprint(["surface-promotion", tool]),
        category: "tool-surface",
        target: tool,
        title: `Consider promoting ${tool} to the default agent surface`,
        summary: `${tool} is a read-only advanced tool with a stable usage pattern and may be a low-ambiguity task aid for ordinary agents.`,
        evidence,
        proposedChange: {
          kind: "surface-promotion",
          target: tool,
          description: `Evaluate moving ${tool} from advanced exposure to default agent exposure; do not change its effects or safety classification.`,
          allowedAreas: ["src/mcp/tools.ts", "tests/toolSurface.test.ts", "skills/c2000-multicore-debug/SKILL.md"],
          forbiddenAreas: ["target mutation", "Safety Profile semantics", "compatibility aliases"],
          changeScope: "small",
          implementationMode: "auto-eligible",
          fromExposure: "advanced",
          toExposure: "default",
          suggestedTools: [tool]
        },
        expectedBenefit: {
          summary: "Reduce unnecessary capability escalation for a frequently needed read-only diagnostic.",
          metrics: [
            { name: "capabilityEscalationRate", direction: "decrease", rationale: "The tool can be selected without opening its advanced capability." },
            { name: "agentSelectionSuccess", direction: "increase", rationale: "The tool is available at the task-oriented surface." }
          ]
        },
        risks: [{ level: "low", description: "The default schema grows and a read primitive may become more tempting than a workflow.", mitigation: "Recheck agent budget, schema bytes, descriptions, and workflow guidance before approval." }],
        validationPlan: surfaceValidationPlan(tool),
        confidence: confidenceFor(evidence, 0.08),
        generatedBy: "analytics-pattern"
      });
    }

    const defaultRows = toolEvents.filter(event => metadataString(event, "exposure") === "default");
    const totalToolEvents = Math.max(1, toolEvents.length);
    for (const [tool, rows] of groupBy(defaultRows, event => event.name)) {
      if (rows.length < (context.minMatchingRuns ?? MIN_PROPOSAL_MATCHING_RUNS)) continue;
      const coveredByWorkflow = rows.map(event => metadataString(event, "coveredByWorkflow")).find(Boolean);
      if (!coveredByWorkflow || rows.length / totalToolEvents > 0.01) continue;
      const definition = definitionFor(tool);
      if (!definition || definition.role === "workflow" || !definition.annotations.readOnlyHint) continue;
      const evidence = evidenceFor({
        context,
        matchingRuns: rows.length,
        affectedRuns: rows.length,
        successAfterEscalation: rows.filter(event => event.outcome === "success").length,
        failureAfterEscalation: rows.filter(isFailure).length,
        supportingTools: [tool],
        contextValues: { tool, coveredByWorkflow },
        rootCause: rootCauseFor(rows, true),
        schemaCostBytes: estimatedSchemaCost(definition)
      });
      findings.push({
        detector: this.name,
        fingerprint: proposalFingerprint(["surface-demotion", tool, coveredByWorkflow]),
        category: "tool-surface",
        target: tool,
        title: `Consider moving ${tool} out of the default agent surface`,
        summary: `${tool} has low observed usage and is explicitly reported as covered by ${coveredByWorkflow}.`,
        evidence,
        proposedChange: {
          kind: "surface-demotion",
          target: tool,
          description: `Evaluate moving ${tool} from default exposure to advanced exposure while preserving the covering workflow.`,
          allowedAreas: ["src/mcp/tools.ts", "tests/toolSurface.test.ts", "skills/c2000-multicore-debug/SKILL.md"],
          forbiddenAreas: ["target mutation", "Safety Profile semantics", "workflow semantics"],
          changeScope: "small",
          implementationMode: "auto-eligible",
          fromExposure: "default",
          toExposure: "advanced",
          suggestedTools: [tool]
        },
        expectedBenefit: {
          summary: "Reduce default schema cost for a low-use tool already covered by a task workflow.",
          metrics: [
            { name: "agentToolCount", direction: "decrease", rationale: "The low-use primitive moves to advanced." },
            { name: "agentToolSchemaBytes", direction: "decrease", rationale: "Its schema no longer loads in the default surface." }
          ]
        },
        risks: [{ level: "medium", description: "A hidden tool may be needed for an uncommon but legitimate task.", mitigation: "Verify workflow and Skill routing coverage and add an explicit regression route." }],
        validationPlan: surfaceValidationPlan(tool),
        confidence: confidenceFor(evidence, 0.05),
        generatedBy: "analytics-pattern"
      });
    }
    return { detector: this.name, findings, insufficientEvidenceCount };
  }
}

export class CapabilityUsageDetector implements ProposalDetector {
  readonly name = "CapabilityUsageDetector";

  detect(context: DetectorContext): DetectorResult {
    const opens = context.events.filter(event => event.kind === "capability_open");
    const invocations = context.events.filter(event => event.kind === "tool_invocation");
    const findings: ProposalFinding[] = [];
    let insufficientEvidenceCount = 0;
    for (const [capability, rows] of groupBy(opens, event => event.name)) {
      const memberTools = c2000ToolDefinitions.filter(definition => definition.capability === capability);
      if (memberTools.length < 2) continue;
      const memberEvents = invocations.filter(event => metadataString(event, "capability") === capability);
      const dominant = Array.from(groupBy(memberEvents, event => event.name).entries())
        .sort((left, right) => right[1].length - left[1].length || left[0].localeCompare(right[0]))[0];
      if (!dominant) continue;
      const ratio = dominant[1].length / Math.max(1, memberEvents.length);
      if (rows.length < (context.minMatchingRuns ?? MIN_PROPOSAL_MATCHING_RUNS) || ratio < 0.8) {
        if (rows.length > 0 && ratio >= 0.8) insufficientEvidenceCount += 1;
        continue;
      }
      const dominantDefinition = definitionFor(dominant[0]);
      const evidence = evidenceFor({
        context,
        matchingRuns: rows.length,
        affectedRuns: dominant[1].length,
        successAfterEscalation: dominant[1].filter(event => event.outcome === "success").length,
        failureAfterEscalation: dominant[1].filter(isFailure).length,
        supportingCapabilities: [capability],
        supportingTools: [dominant[0]],
        contextValues: { capability, dominantTool: dominant[0], dominantRatio: ratio.toFixed(3) },
        rootCause: rootCauseFor([...rows, ...memberEvents], true),
        schemaCostBytes: dominantDefinition ? estimatedSchemaCost(dominantDefinition) : undefined
      });
      findings.push({
        detector: this.name,
        fingerprint: proposalFingerprint(["capability-review", capability, dominant[0]]),
        category: "capability",
        target: capability,
        title: `Review whether ${capability} is broader than its observed use`,
        summary: `${capability} sessions predominantly use ${dominant[0]}; review the capability boundary without creating tool-level grants.`,
        evidence,
        proposedChange: {
          kind: "capability-review",
          target: capability,
          description: `Review whether ${capability} can expose a smaller semantically complete read-only subset without weakening Safety Profile checks or fragmenting the capability into tool-level grants.`,
          allowedAreas: ["src/mcp/capabilities.ts", "src/mcp/tools.ts", "tests/capabilities.test.ts"],
          forbiddenAreas: ["tool-level capability grants", "Safety Profile semantics", "target mutation bypass"],
          changeScope: "medium",
          implementationMode: "auto-eligible",
          suggestedTools: [dominant[0]]
        },
        expectedBenefit: {
          summary: "Reduce capability ambiguity while retaining a bounded semantic group.",
          metrics: [
            { name: "capabilityMemberUtilization", direction: "increase", rationale: "The group better matches the task that requested it." },
            { name: "unusedCapabilityTools", direction: "decrease", rationale: "Frequently unused members can be reviewed without deleting backend capability." }
          ]
        },
        risks: [{ level: "medium", description: "An overly narrow capability could make a legitimate manual debug flow incomplete.", mitigation: "Keep semantic groups intact unless safety and usage differences are material; validate all membership and safety matrices." }],
        validationPlan: capabilityValidationPlan(capability),
        confidence: confidenceFor(evidence, 0.04),
        generatedBy: "analytics-pattern"
      });
    }
    return { detector: this.name, findings, insufficientEvidenceCount };
  }
}

export class SkillRoutingDetector implements ProposalDetector {
  readonly name = "SkillRoutingDetector";

  detect(context: DetectorContext): DetectorResult {
    const failures = context.events.filter(event => event.kind === "workflow_run" && isFailure(event));
    const groups = new Map<string, OutcomeEvent[]>();
    for (const failure of failures) {
      const fallback = context.events
        .filter(event => event.timestamp > failure.timestamp && Date.parse(event.timestamp) - Date.parse(failure.timestamp) <= ASSOCIATION_WINDOW_MS)
        .filter(event => sameCorrelation(failure, event) || metadataBoolean(event, "routingFallback"))
        .find(event => (event.kind === "capability_open" || event.kind === "tool_invocation") && metadataBoolean(event, "routingFallback"));
      if (!fallback) continue;
      const key = `${failure.name}:${fallback.name}`;
      groups.set(key, [...(groups.get(key) ?? []), failure]);
    }
    const findings: ProposalFinding[] = [];
    let insufficientEvidenceCount = 0;
    for (const [key, rows] of groups) {
      const [workflow, route] = key.split(":", 2);
      const evidence = evidenceFor({
        context,
        matchingRuns: rows.length,
        affectedRuns: rows.length,
        successAfterEscalation: rows.length,
        failureAfterEscalation: 0,
        supportingTools: [route],
        contextValues: { workflow, route },
        rootCause: rootCauseFor(rows, true)
      });
      if (!isSufficient(evidence, context)) insufficientEvidenceCount += 1;
      findings.push({
        detector: this.name,
        fingerprint: proposalFingerprint(["skill-routing", workflow, route]),
        category: "skill",
        target: workflow || "workflow-routing",
        title: `Route ${workflow} failures to the task workflow before advanced escalation`,
        summary: `Historical routing data shows ${route} being selected after ${workflow} failures; improve the Skill route before opening advanced controls.`,
        evidence,
        proposedChange: {
          kind: "skill-routing",
          target: workflow || "workflow-routing",
          description: `Move the recommended task-level route for ${workflow} ahead of ${route}; keep capability escalation as the fallback when workflow evidence is insufficient.`,
          allowedAreas: ["skills/c2000-multicore-debug/SKILL.md", ".skills/c2000-multicore-debug/SKILL.md", "tests/skillRouting.test.ts"],
          forbiddenAreas: ["automatic capability opening", "Safety Profile semantics", "direct CCS/daemon bypass"],
          changeScope: "small",
          implementationMode: "auto-eligible",
          suggestedTools: [route]
        },
        expectedBenefit: {
          summary: "Reduce premature advanced escalation and shorten the normal task route.",
          metrics: [
            { name: "prematureCapabilityOpenRate", direction: "decrease", rationale: "The Skill recommends the workflow first." },
            { name: "workflowFirstSelectionRate", direction: "increase", rationale: "Common failures follow the task-level route." }
          ]
        },
        risks: [{ level: "low", description: "Skill guidance could over-prefer a workflow when a manual task is explicitly requested.", mitigation: "Keep the explicit manual-debug exception and run routing regression cases." }],
        validationPlan: skillValidationPlan(workflow || "workflow-routing"),
        confidence: confidenceFor(evidence, 0.02),
        generatedBy: "analytics-pattern"
      });
    }
    return { detector: this.name, findings, insufficientEvidenceCount };
  }
}

export class TestCoverageDetector implements ProposalDetector {
  readonly name = "TestCoverageDetector";

  detect(context: DetectorContext): DetectorResult {
    const missing = context.events.filter(event => isFailure(event) && (metadataBoolean(event, "regressionTestMissing") || metadataString(event, "testCoverage") === "missing"));
    const findings: ProposalFinding[] = [];
    let insufficientEvidenceCount = 0;
    for (const [failureClass, rows] of groupBy(missing, event => event.failureClass ?? "unknown")) {
      const evidence = evidenceFor({
        context,
        matchingRuns: rows.length,
        affectedRuns: rows.length,
        successAfterEscalation: 0,
        failureAfterEscalation: rows.length,
        contextValues: { failureClass },
        rootCause: rootCauseFor(rows, rows.length >= (context.minMatchingRuns ?? MIN_PROPOSAL_MATCHING_RUNS))
      });
      if (!isSufficient(evidence, context)) insufficientEvidenceCount += 1;
      findings.push({
        detector: this.name,
        fingerprint: proposalFingerprint(["test-coverage", failureClass]),
        category: "test-coverage",
        target: `failure-${failureClass}`,
        title: `Add regression coverage for ${failureClass} failures`,
        summary: `Repeated ${failureClass} failures are marked as lacking a corresponding regression test.`,
        evidence,
        proposedChange: {
          kind: "test-coverage",
          target: `failure-${failureClass}`,
          description: `Add a deterministic regression fixture for ${failureClass}; do not change production safety or target behavior merely to make the test pass.`,
          allowedAreas: ["tests", "tests/improvement-fixtures"],
          forbiddenAreas: ["DebugSessionManager semantics", "target safety behavior", "firmware source"],
          changeScope: "small",
          implementationMode: "auto-eligible",
          suggestedTools: []
        },
        expectedBenefit: {
          summary: "Make a recurring production failure class replayable before future changes are accepted.",
          metrics: [{ name: "failureClassCoverage", direction: "increase", rationale: "A deterministic fixture exists for the observed class." }]
        },
        risks: [{ level: "low", description: "A weak fixture can give false confidence.", mitigation: "Require a fixture that reproduces the classified failure without sensitive project data." }],
        validationPlan: testCoverageValidationPlan(failureClass),
        confidence: confidenceFor(evidence, 0.03),
        generatedBy: "analytics-pattern"
      });
    }
    return { detector: this.name, findings, insufficientEvidenceCount };
  }
}

export class PerformanceOutlierDetector implements ProposalDetector {
  readonly name = "PerformanceOutlierDetector";

  detect(context: DetectorContext): DetectorResult {
    const workflows = context.events.filter(event => event.kind === "workflow_run" && typeof event.durationMs === "number");
    const findings: ProposalFinding[] = [];
    let insufficientEvidenceCount = 0;
    for (const [workflow, rows] of groupBy(workflows, event => event.name)) {
      if (rows.length < (context.minMatchingRuns ?? MIN_PROPOSAL_MATCHING_RUNS)) continue;
      const durations = rows.map(row => row.durationMs!).sort((left, right) => left - right);
      const median = percentile(durations, 0.5);
      const p95 = percentile(durations, 0.95);
      if (median <= 0 || p95 < median * 3 || p95 - median < 1000) continue;
      const outliers = rows.filter(row => (row.durationMs ?? 0) >= p95);
      const stage = topMetadataLabel(outliers, "stage") ?? topEventLabel(outliers.map(row => row.stage));
      const evidence = evidenceFor({
        context,
        matchingRuns: rows.length,
        affectedRuns: outliers.length,
        successAfterEscalation: rows.filter(event => event.outcome === "success").length,
        failureAfterEscalation: rows.filter(isFailure).length,
        contextValues: { workflow, ...(stage ? { stage } : {}), medianMs: String(Math.round(median)), p95Ms: String(Math.round(p95)) },
        rootCause: rootCauseFor(rows, true)
      });
      if (!isSufficient(evidence, context)) insufficientEvidenceCount += 1;
      findings.push({
        detector: this.name,
        fingerprint: proposalFingerprint(["performance", workflow, stage ?? "workflow"]),
        category: "performance",
        target: workflow,
        title: `Investigate the ${workflow} p95 latency outlier`,
        summary: `${workflow} has a deterministic p95 duration materially above its median${stage ? ` near stage ${stage}` : ""}.`,
        evidence,
        proposedChange: {
          kind: "performance",
          target: workflow,
          description: `Profile the ${workflow} stage breakdown and reduce the outlier without changing target sequencing, lease fencing, or safety behavior.`,
          allowedAreas: ["src/workflows", "src/analytics", "tests"],
          forbiddenAreas: ["target sequencing", "Flash reload protection", "Board Lease/Fencing"],
          changeScope: "medium",
          implementationMode: "auto-eligible",
          suggestedTools: []
        },
        expectedBenefit: {
          summary: "Reduce tail latency while preserving the workflow contract.",
          metrics: [
            { name: "workflowP95Ms", direction: "decrease", rationale: "The observed tail outlier is the improvement target." },
            { name: "workflowMedianMs", direction: "preserve", rationale: "The optimization must not trade normal latency for an unexplained regression." }
          ]
        },
        risks: [{ level: "medium", description: "Latency changes can accidentally shorten required target waits.", mitigation: "Use replay/mock evidence and retain all explicit CPU1/CPU2 sequencing and timeout guards." }],
        validationPlan: performanceValidationPlan(workflow),
        confidence: confidenceFor(evidence, 0.01),
        generatedBy: "analytics-pattern"
      });
    }
    return { detector: this.name, findings, insufficientEvidenceCount };
  }
}

export class FailureGuidanceDetector implements ProposalDetector {
  readonly name = "FailureGuidanceDetector";

  detect(context: DetectorContext): DetectorResult {
    const failures = context.events.filter(event => isFailure(event) && event.errorCode);
    const findings: ProposalFinding[] = [];
    let insufficientEvidenceCount = 0;
    for (const [errorCode, rows] of groupBy(failures, event => event.errorCode!)) {
      const retryCount = Math.max(...rows.map(row => metadataNumber(row, "retryCount") ?? 0));
      if (retryCount < 2) continue;
      const evidence = evidenceFor({
        context,
        matchingRuns: rows.length,
        affectedRuns: rows.length,
        successAfterEscalation: 0,
        failureAfterEscalation: rows.length,
        contextValues: { errorCode, retryCount: String(retryCount) },
        rootCause: rootCauseFor(rows, rows.length >= (context.minMatchingRuns ?? MIN_PROPOSAL_MATCHING_RUNS))
      });
      if (!isSufficient(evidence, context)) insufficientEvidenceCount += 1;
      findings.push({
        detector: this.name,
        fingerprint: proposalFingerprint(["error-guidance", errorCode]),
        category: "diagnostics",
        target: errorCode,
        title: `Improve next-action guidance for ${errorCode}`,
        summary: `${errorCode} is repeatedly retried before a successful route is selected; make the structured error remediation more direct.`,
        evidence,
        proposedChange: {
          kind: "error-guidance",
          target: errorCode,
          description: `Add deterministic nextAction guidance for ${errorCode}; do not change the underlying safety or target operation.`,
          allowedAreas: ["src/utils", "src/mcp", "tests"],
          forbiddenAreas: ["Safety Profile semantics", "target operation semantics", "direct MCP bypass"],
          changeScope: "small",
          implementationMode: "auto-eligible",
          suggestedTools: []
        },
        expectedBenefit: {
          summary: "Reduce repeated failed calls before the correct remediation is chosen.",
          metrics: [{ name: "retriesBeforeResolution", direction: "decrease", rationale: "Structured guidance should shorten the recovery path." }]
        },
        risks: [{ level: "low", description: "Incorrect remediation text can send an agent down the wrong path.", mitigation: "Use only deterministic, policy-approved next actions and add negative guidance tests." }],
        validationPlan: errorGuidanceValidationPlan(errorCode),
        confidence: confidenceFor(evidence, 0.02),
        generatedBy: "analytics-pattern"
      });
    }
    return { detector: this.name, findings, insufficientEvidenceCount };
  }
}

export const DEFAULT_PROPOSAL_DETECTORS: readonly ProposalDetector[] = [
  new WorkflowEscalationDetector(),
  new ToolSurfaceUsageDetector(),
  new CapabilityUsageDetector(),
  new SkillRoutingDetector(),
  new TestCoverageDetector(),
  new PerformanceOutlierDetector(),
  new FailureGuidanceDetector()
];

function workflowGapFinding(workflow: string, capability: string, evidence: ReturnType<typeof proposalEvidenceSchema.parse>): ProposalFinding {
  const failureClass = evidence.context.failureClass ?? "unknown";
  return {
    detector: "WorkflowEscalationDetector",
    fingerprint: proposalFingerprint(["workflow-gap", workflow, capability, failureClass]),
    category: "workflow",
    target: workflow,
    title: `Evaluate richer evidence in ${workflow}`,
    summary: `${workflow} frequently fails unresolved and is followed by ${capability}; the subsequent diagnostic path provides evidence that may belong in the workflow result.`,
    evidence,
    proposedChange: {
      kind: "workflow-gap",
      target: workflow,
      description: `Evaluate folding the observed read-only diagnostic evidence into ${workflow}; preserve target sequencing, lease fencing, and all existing safety checks.`,
      allowedAreas: ["src/workflows", "src/mcp", "tests"],
      forbiddenAreas: ["DebugSessionManager semantics", "target mutation", "firmware source", "direct CCS/daemon bypass"],
      changeScope: "medium",
      implementationMode: "auto-eligible",
      suggestedTools: evidence.supportingTools
    },
    expectedBenefit: {
      summary: "Reduce unresolved workflow outcomes and avoid unnecessary manual capability escalation.",
      metrics: [
        { name: "workflowUnresolvedRate", direction: "decrease", rationale: "The workflow returns the evidence most often needed after failure." },
        { name: "manualCapabilityEscalationRate", direction: "decrease", rationale: "Common read-only follow-up evidence is available in the task result." },
        { name: "workflowEvidenceCompleteness", direction: "increase", rationale: "The diagnostic result contains the observed evidence path." }
      ]
    },
    risks: [{ level: "medium", description: "Adding evidence can increase workflow duration or target hold time.", mitigation: "Use bounded read-only operations, mock replay, and explicit latency/target-sequencing regression checks." }],
    validationPlan: workflowValidationPlan(workflow),
    confidence: confidenceFor(evidence, 0.05),
    generatedBy: "static-and-analytics"
  };
}

function workflowValidationPlan(workflow: string): ValidationPlan {
  return {
    existingTests: [`workflow:${workflow}`, "tests/toolSafety.test.ts", "tests/toolSurface.test.ts", "tests/capabilities.test.ts"],
    newRegressionTestRequired: true,
    mockValidation: true,
    hardwareRequired: false,
    replayFixtures: ["boot-handoff-failure", "ipc-timeout"],
    beforeAfterMetrics: ["workflowUnresolvedRate", "manualCapabilityEscalationRate", "workflowEvidenceCompleteness", "workflowDurationMs"],
    rollbackCondition: "Revert if existing workflow tests fail, protected sequencing changes, target mutation increases, or evidence does not improve on the same replay fixture.",
    acceptanceCriteria: ["Existing workflow semantics remain unchanged.", "The same fixture produces richer structured evidence.", "No new target mutation is introduced."]
  };
}

function surfaceValidationPlan(tool: string): ValidationPlan {
  return {
    existingTests: ["tests/toolSurface.test.ts", "tests/toolSafety.test.ts", "tests/tools.test.ts"],
    newRegressionTestRequired: true,
    mockValidation: true,
    hardwareRequired: false,
    replayFixtures: [],
    beforeAfterMetrics: ["agentToolCount", "agentToolSchemaBytes", `usage:${tool}`],
    rollbackCondition: "Revert if the surface budget, safety matrix, workflow routing, or compatibility aliases regress.",
    acceptanceCriteria: ["Safety is unchanged.", "Agent budget remains within its gate.", "Compatibility surface remains complete."]
  };
}

function capabilityValidationPlan(capability: string): ValidationPlan {
  return {
    existingTests: ["tests/capabilities.test.ts", "tests/toolSurface.test.ts", "tests/toolSafety.test.ts"],
    newRegressionTestRequired: true,
    mockValidation: true,
    hardwareRequired: false,
    replayFixtures: [],
    beforeAfterMetrics: [`capability:${capability}`, "capabilityMemberUtilization"],
    rollbackCondition: "Revert if any member becomes inaccessible on the intended safety profile or a workflow loses a required capability.",
    acceptanceCriteria: ["Capability remains a semantic group.", "Safety filtering still runs before membership filtering.", "No target backend is removed."]
  };
}

function skillValidationPlan(target: string): ValidationPlan {
  return {
    existingTests: ["tests/skillSync.test.ts", "tests/skillPromotionGate.test.ts", "tests/capabilities.test.ts"],
    newRegressionTestRequired: true,
    mockValidation: true,
    hardwareRequired: false,
    replayFixtures: ["cpu2-boot-task", "ipc-acceptance-task", "manual-profiling-task"],
    beforeAfterMetrics: ["workflowFirstSelectionRate", "prematureCapabilityOpenRate"],
    rollbackCondition: `Revert if ${target} routing stops preferring the task workflow or manual profiling guidance is lost.`,
    acceptanceCriteria: ["Skill remains synchronized.", "Workflow-first routing is explicit.", "No shell/CCS/daemon bypass is suggested."]
  };
}

function testCoverageValidationPlan(failureClass: string): ValidationPlan {
  return {
    existingTests: ["npm test", `failure-class:${failureClass}`],
    newRegressionTestRequired: true,
    mockValidation: true,
    hardwareRequired: false,
    replayFixtures: [`${failureClass}-failure`],
    beforeAfterMetrics: ["failureClassCoverage"],
    rollbackCondition: "Revert if the fixture is non-deterministic, sensitive, or requires changing production behavior to pass.",
    acceptanceCriteria: ["Fixture is deterministic and offline.", "Production semantics are unchanged.", "The failure class is asserted explicitly."]
  };
}

function performanceValidationPlan(workflow: string): ValidationPlan {
  return {
    existingTests: [`workflow:${workflow}`, "tests/trace.test.ts", "tests/outcomeAnalytics.test.ts"],
    newRegressionTestRequired: true,
    mockValidation: true,
    hardwareRequired: false,
    replayFixtures: ["performance-outlier-replay"],
    beforeAfterMetrics: ["workflowP95Ms", "workflowMedianMs", "targetHoldTimeMs"],
    rollbackCondition: "Revert if p95 does not improve, target hold time increases, or any timeout/ordering guard changes.",
    acceptanceCriteria: ["Before and after use the same replay fixture.", "Tail latency improves without changing target sequencing.", "All relevant tests pass."]
  };
}

function errorGuidanceValidationPlan(errorCode: string): ValidationPlan {
  return {
    existingTests: ["tests/tools.test.ts", "tests/toolSafety.test.ts", `error:${errorCode}`],
    newRegressionTestRequired: true,
    mockValidation: true,
    hardwareRequired: false,
    replayFixtures: [],
    beforeAfterMetrics: ["retriesBeforeResolution"],
    rollbackCondition: "Revert if the nextAction is ambiguous, unsafe, or inconsistent with the existing structured error code.",
    acceptanceCriteria: ["Guidance is deterministic.", "No safety relaxation is suggested.", "Negative bypass guidance is tested."]
  };
}

function evidenceFor(input: {
  context: DetectorContext;
  matchingRuns: number;
  affectedRuns: number;
  successAfterEscalation: number;
  failureAfterEscalation: number;
  supportingTools?: string[];
  supportingCapabilities?: string[];
  contextValues?: Record<string, string | undefined>;
  rootCause: "likely-mcp-deficiency" | "likely-firmware-deficiency" | "environment-issue" | "insufficient-evidence";
  schemaCostBytes?: number;
}) {
  const matchingRuns = Math.max(0, input.matchingRuns);
  const affectedRuns = Math.max(0, Math.min(matchingRuns, input.affectedRuns));
  const evidence = {
    matchingRuns,
    affectedRuns,
    successAfterEscalation: Math.max(0, Math.min(affectedRuns, input.successAfterEscalation)),
    failureAfterEscalation: Math.max(0, Math.min(affectedRuns, input.failureAfterEscalation)),
    sampleWindow: input.context.window,
    patternRatio: matchingRuns === 0 ? 0 : affectedRuns / matchingRuns,
    failureRate: matchingRuns === 0 ? 0 : Math.min(1, input.failureAfterEscalation / matchingRuns),
    sufficient: matchingRuns >= (input.context.minMatchingRuns ?? MIN_PROPOSAL_MATCHING_RUNS)
      && (matchingRuns === 0 ? false : affectedRuns / matchingRuns >= (input.context.minPatternRatio ?? MIN_PATTERN_RATIO)),
    minimumMatchingRuns: input.context.minMatchingRuns ?? MIN_PROPOSAL_MATCHING_RUNS,
    minimumPatternRatio: input.context.minPatternRatio ?? MIN_PATTERN_RATIO,
    supportingTools: safeLabels(input.supportingTools ?? []),
    supportingCapabilities: safeLabels(input.supportingCapabilities ?? []),
    context: Object.fromEntries(Object.entries(input.contextValues ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
    rootCause: input.rootCause,
    rootCauseReason: rootCauseReason(input.rootCause),
    ...(input.schemaCostBytes === undefined ? {} : { schemaCostBytes: input.schemaCostBytes }),
    observedAt: new Date(input.context.nowMs).toISOString()
  };
  return proposalEvidenceSchema.parse(evidence);
}

function isSufficient(evidence: ReturnType<typeof proposalEvidenceSchema.parse>, context: DetectorContext): boolean {
  return evidence.matchingRuns >= (context.minMatchingRuns ?? MIN_PROPOSAL_MATCHING_RUNS)
    && evidence.patternRatio >= (context.minPatternRatio ?? MIN_PATTERN_RATIO);
}

function rootCauseFor(events: readonly OutcomeEvent[], continuationSucceeded: boolean): "likely-mcp-deficiency" | "likely-firmware-deficiency" | "environment-issue" | "insufficient-evidence" {
  const explicit = events.map(event => {
    const metadata = event.metadata as Record<string, unknown>;
    return metadata.rootCause ?? metadata.rootCauseClassification ?? metadata.owner;
  }).find(value => typeof value === "string");
  if (typeof explicit === "string") {
    const normalized = explicit.toLowerCase();
    if (normalized.includes("firmware")) return "likely-firmware-deficiency";
    if (normalized.includes("environment") || normalized.includes("probe") || normalized.includes("infrastructure")) return "environment-issue";
    if (normalized.includes("insufficient")) return "insufficient-evidence";
  }
  if (events.some(event => metadataBoolean(event, "firmwareOwned") || metadataBoolean(event, "firmwareLikely"))) return "likely-firmware-deficiency";
  if (events.some(event => ["environment", "probe", "worker", "board-lease", "filesystem"].includes(event.failureClass ?? ""))) return "environment-issue";
  return continuationSucceeded ? "likely-mcp-deficiency" : "insufficient-evidence";
}

function rootCauseReason(rootCause: string): string {
  if (rootCause === "likely-firmware-deficiency") return "Structured evidence marks the recurring failure as firmware-owned; no MCP code change should be generated.";
  if (rootCause === "environment-issue") return "Structured evidence points to probe, worker, lease, filesystem, or other environment ownership.";
  if (rootCause === "insufficient-evidence") return "The observed pattern is retained as a draft until sample and ratio thresholds are met.";
  return "A repeated MCP workflow, routing, diagnostics, or surface pattern is plausibly contributing to the observed outcome.";
}

function matchingCapabilityOpens(failure: OutcomeEvent, workflow: string, events: readonly OutcomeEvent[]): OutcomeEvent[] {
  return events
    .filter(event => event.kind === "capability_open")
    .filter(event => Date.parse(event.timestamp) > Date.parse(failure.timestamp))
    .filter(event => Date.parse(event.timestamp) - Date.parse(failure.timestamp) <= ASSOCIATION_WINDOW_MS)
    .filter(event => event.escalationFrom === workflow || metadataString(event, "openedFrom.workflow") === workflow || sameCorrelation(failure, event));
}

function continuationSucceeded(failure: OutcomeEvent, open: OutcomeEvent, workflow: string, workflowRows: readonly OutcomeEvent[], allEvents: readonly OutcomeEvent[]): boolean {
  return workflowRows.some(event => event.name === workflow
    && event.kind === "workflow_run"
    && event.outcome === "success"
    && Date.parse(event.timestamp) > Date.parse(open.timestamp)
    && Date.parse(event.timestamp) - Date.parse(open.timestamp) <= ASSOCIATION_WINDOW_MS
    && (sameCorrelation(failure, event) || sameCorrelation(open, event) || (!failure.jobId && !failure.sessionId && !event.jobId && !event.sessionId)))
    || allEvents.some(event => event.kind === "tool_invocation"
      && event.outcome === "success"
      && Date.parse(event.timestamp) > Date.parse(open.timestamp)
      && Date.parse(event.timestamp) - Date.parse(open.timestamp) <= ASSOCIATION_WINDOW_MS
      && (sameCorrelation(open, event) || (metadataString(event, "workflow") === workflow)));
}

function continuationTools(cases: Array<{ failure: OutcomeEvent; open: OutcomeEvent }>, workflow: string, events: readonly OutcomeEvent[]): string[] {
  return safeLabels(events
    .filter(event => event.kind === "tool_invocation")
    .filter(event => cases.some(item => Date.parse(event.timestamp) > Date.parse(item.open.timestamp)
      && Date.parse(event.timestamp) - Date.parse(item.open.timestamp) <= ASSOCIATION_WINDOW_MS
      && (sameCorrelation(item.open, event) || metadataString(event, "workflow") === workflow)))
    .map(event => event.name));
}

function sameCorrelation(left: OutcomeEvent, right: OutcomeEvent): boolean {
  if (left.jobId && right.jobId) return left.jobId === right.jobId;
  if (left.sessionId && right.sessionId) return left.sessionId === right.sessionId;
  return false;
}

function definitionFor(tool: string): ToolDefinition | undefined {
  return c2000ToolDefinitions.find(definition => definition.name === tool);
}

function isReadOnlyDefinition(definition: ToolDefinition, events: readonly OutcomeEvent[]): boolean {
  const effects = events.map(event => metadataArray(event, "effects")).find(value => value.length > 0) ?? definition.effects;
  return definition.annotations.readOnlyHint && effects.every(effect => SAFE_READ_EFFECTS.has(effect));
}

function estimatedSchemaCost(definition: ToolDefinition): number {
  return Buffer.byteLength(JSON.stringify({
    name: definition.name,
    title: definition.title,
    description: definition.description,
    effects: definition.effects,
    annotations: definition.annotations,
    approvalClass: definition.approvalClass,
    capability: definition.capability
  }), "utf8");
}

function isFailure(event: OutcomeEvent): boolean {
  const verdict = metadataString(event, "domainVerdict")?.toLowerCase();
  return event.outcome !== "success" || verdict === "failed" || verdict === "unresolved" || verdict === "blocked";
}

function dominantFailureClass(events: readonly OutcomeEvent[]): string {
  return topEventLabel(events.map(event => event.failureClass)) ?? "unknown";
}

function topMetadataLabel(events: readonly OutcomeEvent[], key: string): string | undefined {
  return topEventLabel(events.map(event => metadataString(event, key)));
}

function topEventLabel(values: readonly (string | undefined)[]): string | undefined {
  const counts = new Map<string, number>();
  for (const value of values) if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  return Array.from(counts.entries()).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0];
}

function confidenceFor(evidence: ReturnType<typeof proposalEvidenceSchema.parse>, bonus: number): number {
  const successRatio = evidence.affectedRuns === 0 ? 0 : evidence.successAfterEscalation / evidence.affectedRuns;
  return Math.min(0.95, Math.max(0.05, 0.45 + evidence.patternRatio * 0.25 + successRatio * 0.2 + bonus));
}

function percentile(values: readonly number[], quantile: number): number {
  if (values.length === 0) return 0;
  const position = (values.length - 1) * quantile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return values[lower]!;
  return values[lower]! + (values[upper]! - values[lower]!) * (position - lower);
}

function groupBy<T>(values: readonly T[], key: (value: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const group = key(value);
    groups.set(group, [...(groups.get(group) ?? []), value]);
  }
  return groups;
}

function metadataString(event: OutcomeEvent, key: string): string | undefined {
  const values = event.metadata as Record<string, unknown>;
  if (key.includes(".")) {
    const [first, second] = key.split(".", 2);
    const nested = values[first];
    return nested && typeof nested === "object" && typeof (nested as Record<string, unknown>)[second!] === "string"
      ? String((nested as Record<string, unknown>)[second!])
      : undefined;
  }
  const value = values[key];
  return typeof value === "string" ? value : undefined;
}

function metadataArray(event: OutcomeEvent, key: string): string[] {
  const value = (event.metadata as Record<string, unknown>)[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function metadataBoolean(event: OutcomeEvent, key: string): boolean {
  const value = (event.metadata as Record<string, unknown>)[key];
  return value === true || value === "true";
}

function metadataNumber(event: OutcomeEvent, key: string): number | undefined {
  const value = (event.metadata as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : typeof value === "string" && Number.isFinite(Number(value)) ? Number(value) : undefined;
}

function safeLabels(values: readonly string[]): string[] {
  return Array.from(new Set(values.filter(value => /^[A-Za-z0-9._:/-]{1,192}$/.test(value)))).slice(0, 64);
}
