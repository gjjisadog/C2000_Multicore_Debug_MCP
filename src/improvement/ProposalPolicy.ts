import { createHash } from "node:crypto";
import type { ProposalFinding, ProposalRootCause, ImprovementProposal, ProposalPriority, ProposalRiskLevel } from "./ProposalSchemas.js";

export const MIN_PROPOSAL_MATCHING_RUNS = 10;
export const MIN_PATTERN_RATIO = 0.20;
export const PROPOSAL_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_PROPOSALS_PER_GENERATION = 50;

export const PROTECTED_INVARIANTS = [
  "CPU1 coreId remains 0 and CPU2 coreId remains 2",
  "Safety Profile remains the highest target-permission boundary",
  "Flash reload protection remains fail-closed before destructive programming",
  "loadSymbols remains symbol-only and never becomes a programming path",
  "cpu1-run-before-cpu2 and cpu1_boots_cpu2 sequencing semantics remain unchanged",
  "Board Lease and fencing remain mandatory for board-bound target access",
  "target mutation remains explicitly classified and approved",
  "compatibility aliases remain compatibility-only"
] as const;

export interface ProposalPolicyAssessment {
  allowed: boolean;
  rootCause: ProposalRootCause;
  implementationMode: "auto-eligible" | "manual-only";
  risk: ProposalRiskLevel;
  priority: ProposalPriority;
  reason?: string;
}

/**
 * Policy is deliberately independent from detector heuristics. It prevents
 * evidence patterns from becoming proposals when the likely owner is firmware
 * or the environment, and protects target/safety semantics from promotion.
 */
export function assessProposal(finding: ProposalFinding): ProposalPolicyAssessment {
  const rootCause = finding.evidence.rootCause;
  const text = [
    finding.target,
    finding.title,
    finding.summary,
    finding.proposedChange.description
  ].join(" ").toLowerCase();
  const protectedMatch = protectedChangeMatch(text);
  const dangerousPromotion = finding.proposedChange.kind === "surface-promotion"
    && (finding.proposedChange.toExposure === "default" || text.includes("agent"))
    && !isReadOnlyFinding(finding);

  if (protectedMatch || dangerousPromotion) {
    return {
      allowed: false,
      rootCause,
      implementationMode: "manual-only",
      risk: "high",
      priority: "P3",
      reason: protectedMatch
        ? `Protected invariant matched: ${protectedMatch}`
        : "A non-read-only capability cannot be promoted to the default agent surface."
    };
  }
  if (rootCause === "likely-firmware-deficiency") {
    return { allowed: false, rootCause, implementationMode: "manual-only", risk: "high", priority: "P3", reason: "The evidence points to a firmware-owned problem, not an MCP change." };
  }
  if (rootCause === "environment-issue") {
    return { allowed: false, rootCause, implementationMode: "manual-only", risk: "medium", priority: "P3", reason: "The evidence points to an environment or infrastructure problem." };
  }
  if (rootCause === "insufficient-evidence") {
    return { allowed: true, rootCause, implementationMode: "manual-only", risk: "medium", priority: "P3", reason: "The pattern is retained as a draft until the evidence threshold is met." };
  }

  const risk = riskForFinding(finding);
  const implementationMode = risk === "high" || finding.proposedChange.changeScope === "large" ? "manual-only" : "auto-eligible";
  return {
    allowed: true,
    rootCause,
    implementationMode,
    risk,
    priority: priorityForFinding(finding, risk)
  };
}

export function isReadOnlyFinding(finding: ProposalFinding): boolean {
  const effects = finding.evidence.context.effects?.split(",").filter(Boolean) ?? [];
  return effects.length === 0 || effects.every(effect => effect === "host-read" || effect === "target-read");
}

export function priorityForFinding(finding: ProposalFinding, risk = riskForFinding(finding)): ProposalPriority {
  const frequency = Math.min(1, finding.evidence.patternRatio);
  const impact = finding.category === "reliability" || finding.category === "workflow" ? 1 : finding.category === "diagnostics" || finding.category === "test-coverage" ? 0.8 : 0.6;
  const riskWeight = risk === "low" ? 1 : risk === "medium" ? 2 : 4;
  const score = impact * Math.max(0, Math.min(1, finding.confidence)) * frequency / riskWeight;
  // P0 is reserved for high-confidence reliability/safety concerns. A high
  // frequency usability or workflow suggestion must not acquire emergency
  // priority merely because it has a large sample.
  const text = [finding.target, finding.title, finding.summary, finding.proposedChange.description].join(" ");
  const p0Eligible = risk !== "high"
    && finding.confidence >= 0.8
    && (finding.category === "reliability" || /\b(safety|security)\b/i.test(text));
  if (score >= 0.5 && p0Eligible) return "P0";
  if (score >= 0.5) return "P1";
  if (score >= 0.25) return "P1";
  if (score >= 0.10) return "P2";
  return "P3";
}

export function riskForFinding(finding: ProposalFinding): ProposalRiskLevel {
  if (finding.proposedChange.kind === "surface-promotion" && !isReadOnlyFinding(finding)) return "high";
  if (finding.category === "workflow" || finding.category === "diagnostics" || finding.category === "test-coverage") return "medium";
  if (finding.category === "performance" || finding.category === "skill" || finding.category === "documentation") return "low";
  return finding.proposedChange.changeScope === "large" ? "high" : "medium";
}

export function proposalFingerprint(parts: readonly string[]): string {
  return createHash("sha256").update(parts.map(value => value.trim().toLowerCase()).join("\u001f")).digest("hex").slice(0, 24);
}

export function materiallyChanged(previous: ImprovementProposal, current: ProposalFinding): boolean {
  const oldEvidence = previous.evidence;
  const newEvidence = current.evidence;
  return newEvidence.matchingRuns >= Math.max(oldEvidence.matchingRuns + 1, oldEvidence.matchingRuns * 3)
    || newEvidence.patternRatio - oldEvidence.patternRatio >= 0.15
    || newEvidence.failureRate - oldEvidence.failureRate >= 0.15
    || current.confidence - previous.confidence >= 0.15;
}

export function inProposalCooldown(previous: ImprovementProposal, nowMs: number): boolean {
  return nowMs - Date.parse(previous.updatedAt) < PROPOSAL_COOLDOWN_MS;
}

export function protectedChangeMatch(text: string): string | undefined {
  const normalized = text.replace(/\s+/g, " ");
  const actionPattern = /\b(weaken|bypass|relax|remove|disable|promote|allow)\b/gi;
  const protectedPattern = /\b(safety|approvalclass|approval class|fault-injection|memory-write|memory write|target-memory-write|target memory write|target mutation|flash|coreid|cpu1|cpu2|board lease|fencing|authentication)\b/i;
  for (const match of normalized.matchAll(actionPattern)) {
    const index = match.index ?? 0;
    const action = match[0] ?? "";
    const before = normalized.slice(Math.max(0, index - 96), index);
    const after = normalized.slice(index + action.length, index + action.length + 96);
    // Proposals routinely say "without weakening Safety" in their
    // mitigation text. Treat those preservation statements as safe while
    // still rejecting an unqualified request to weaken a protected boundary.
    if (protectedPattern.test(after) && !negatedProtectedAction(before)) return "protected safety/security policy";
    if (protectedPattern.test(before) && !negatedProtectedAction(before)) return "protected safety/security policy";
  }
  return undefined;
}

function negatedProtectedAction(before: string): boolean {
  return /\b(without|never|not|do not|does not|must not|should not|preserve|preserving|retain|retaining|avoid)\b[^.!?]{0,40}$/i.test(before);
}
