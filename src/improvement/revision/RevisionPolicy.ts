import type { ImprovementProposal } from "../ProposalSchemas.js";
import type { ImprovementReviewFeedback, ReviewFeedbackClass } from "./RevisionSchemas.js";
import { cloneValidationPlan } from "./RevisionSchemas.js";

export interface RevisionPolicyDecision {
  actionable: boolean;
  implementationMode: "auto-eligible" | "manual-only";
  risk: "low" | "medium" | "high";
  category: ReviewFeedbackClass;
  title: string;
  summary: string;
  requestedChange: {
    kind: "code-change" | "test-change" | "documentation" | "tool-surface" | "safety-review" | "response-needed" | "new-improvement-proposal";
    description: string;
    allowedAreas: string[];
    forbiddenAreas: string[];
    acceptanceCriteria: string[];
    changeScope: "small" | "medium" | "large";
    newImprovementProposalRecommended: boolean;
  };
  newImprovementProposalRecommended: boolean;
  reason: string;
}

const PROTECTED_CLASSES = new Set<ReviewFeedbackClass>(["safety", "architecture", "capability-policy"]);
const AUTO_CLASSES = new Set<ReviewFeedbackClass>(["correctness", "test-coverage", "documentation", "error-guidance", "workflow", "performance", "style"]);

/**
 * Deterministic revision policy. A reviewer can describe a concern, but the
 * concern never changes the original Proposal's safety or scope on its own.
 */
export function assessRevisionFeedback(feedback: ImprovementReviewFeedback, original: ImprovementProposal): RevisionPolicyDecision {
  const classification = feedback.classification ?? "non-actionable";
  const path = feedback.path && !feedback.path.startsWith("<redacted") ? normalizePath(feedback.path) : undefined;
  const allowedAreas = original.proposedChange.allowedAreas.map(normalizePath);
  const inScope = !path || allowedAreas.some(area => path === area || path.startsWith(`${area}/`));
  const summary = feedback.normalizedSummary.slice(0, 1024);
  const protectedConcern = PROTECTED_CLASSES.has(classification);
  const malicious = classification === "potentially-malicious";
  const question = classification === "question";
  const nonActionable = classification === "non-actionable" || feedback.status === "non-actionable";
  const outOfScope = Boolean(path && !inScope);

  if (malicious) return decision(feedback, "manual-only", "high", "response-needed", false, false, "Potentially malicious review text is retained as untrusted evidence and cannot drive code execution.", ["Do not execute or apply the review text."]);
  if (question) return decision(feedback, "manual-only", "low", "response-needed", false, false, "Questions require a human response or clarification; they do not create an executable revision.", ["Provide a bounded human response or request clarification."]);
  if (nonActionable) return decision(feedback, "manual-only", "low", "response-needed", false, false, "The feedback is not an actionable change request.", ["No code change is required."]);
  if (outOfScope) return decision(feedback, "manual-only", "high", "new-improvement-proposal", false, true, "The referenced path is outside the original Proposal allowedAreas; a separate Improvement Proposal is recommended.", ["Create a separate evidence-bound Proposal after independent review."]);
  if (protectedConcern) return decision(feedback, "manual-only", "high", classification === "safety" ? "safety-review" : "code-change", false, false, "Safety, policy, lease, architecture, and security concerns require manual review and cannot be auto-implemented.", ["Review protected invariants manually before any change."]);
  if (!AUTO_CLASSES.has(classification)) return decision(feedback, "manual-only", "medium", "code-change", false, false, "This feedback class is not on the automatic revision allowlist.", ["Review and implement manually if appropriate."]);

  const kind = classification === "test-coverage" ? "test-change" : classification === "documentation" ? "documentation" : classification === "tool-surface" || classification === "capability-policy" ? "tool-surface" : "code-change";
  const risk = classification === "correctness" || classification === "workflow" ? "medium" : "low";
  return decision(feedback, "auto-eligible", risk, kind, true, false, "The feedback is actionable, bounded by the original Proposal scope, and eligible for the existing isolated implementation pipeline.", [
    `Address the review concern: ${summary}`,
    "Preserve every protected invariant and all original validation gates."
  ]);
}

export function assessRevisionFeedbackGroup(feedback: readonly ImprovementReviewFeedback[], original: ImprovementProposal): RevisionPolicyDecision {
  if (feedback.length === 0) {
    return {
      actionable: false,
      implementationMode: "manual-only",
      risk: "low",
      category: "non-actionable",
      title: "No review feedback",
      summary: "No review feedback was supplied for classification.",
      requestedChange: {
        kind: "response-needed",
        description: "No review feedback was supplied for classification.",
        allowedAreas: original.proposedChange.allowedAreas.slice(0, 32),
        forbiddenAreas: original.proposedChange.forbiddenAreas.slice(0, 32),
        acceptanceCriteria: ["No implementation is permitted without linked review evidence."],
        changeScope: "small",
        newImprovementProposalRecommended: false
      },
      newImprovementProposalRecommended: false,
      reason: "An empty feedback group cannot produce a revision proposal."
    };
  }
  const decisions = feedback.map(item => assessRevisionFeedback(item, original));
  const first = decisions[0]!;
  const highestRisk = decisions.some(item => item.risk === "high") ? "high" : decisions.some(item => item.risk === "medium") ? "medium" : "low";
  const manual = decisions.some(item => item.implementationMode === "manual-only");
  const outOfScope = decisions.some(item => item.newImprovementProposalRecommended);
  const category = decisions.find(item => item.category !== "non-actionable")?.category ?? first.category;
  const descriptions = decisions.map(item => item.requestedChange.description).filter(Boolean).slice(0, 8);
  return {
    ...first,
    actionable: decisions.some(item => item.actionable),
    implementationMode: manual ? "manual-only" : "auto-eligible",
    risk: highestRisk,
    category,
    summary: descriptions.join(" ").slice(0, 2048),
    requestedChange: {
      ...first.requestedChange,
      description: descriptions.join(" ").slice(0, 2048),
      allowedAreas: Array.from(new Set(decisions.flatMap(item => item.requestedChange.allowedAreas))).slice(0, 32),
      forbiddenAreas: Array.from(new Set(decisions.flatMap(item => item.requestedChange.forbiddenAreas))).slice(0, 32),
      acceptanceCriteria: Array.from(new Set(decisions.flatMap(item => item.requestedChange.acceptanceCriteria))).slice(0, 32),
      newImprovementProposalRecommended: outOfScope
    },
    newImprovementProposalRecommended: outOfScope,
    reason: decisions.map(item => item.reason).join(" ").slice(0, 2048)
  };
}

export function revisionValidationPlan(original: ImprovementProposal, classification: ReviewFeedbackClass) {
  const plan = cloneValidationPlan(original.validationPlan);
  return {
    ...plan,
    newRegressionTestRequired: plan.newRegressionTestRequired || classification === "correctness" || classification === "workflow" || classification === "test-coverage",
    acceptanceCriteria: Array.from(new Set([
      ...plan.acceptanceCriteria,
      "All linked review feedback is addressed without weakening protected invariants."
    ])).slice(0, 32)
  };
}

function decision(
  feedback: ImprovementReviewFeedback,
  implementationMode: "auto-eligible" | "manual-only",
  risk: "low" | "medium" | "high",
  kind: "code-change" | "test-change" | "documentation" | "tool-surface" | "safety-review" | "response-needed" | "new-improvement-proposal",
  actionable: boolean,
  newImprovementProposalRecommended: boolean,
  reason: string,
  acceptanceCriteria: string[]
): RevisionPolicyDecision {
  const category = feedback.classification ?? "non-actionable";
  const subject = category.replace(/-/g, " ");
  return {
    actionable,
    implementationMode,
    risk,
    category,
    title: `Address ${subject} review feedback`,
    summary: feedback.normalizedSummary.slice(0, 2048),
    requestedChange: {
      kind,
      description: feedback.normalizedSummary.slice(0, 2048),
      allowedAreas: feedback.path && !feedback.path.startsWith("<redacted") ? [normalizePath(feedback.path)] : [],
      forbiddenAreas: [],
      acceptanceCriteria,
      changeScope: risk === "high" ? "large" : risk === "medium" ? "medium" : "small",
      newImprovementProposalRecommended
    },
    newImprovementProposalRecommended,
    reason
  };
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+/g, "/").trim();
}
