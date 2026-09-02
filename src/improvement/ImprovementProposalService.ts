import { randomUUID } from "node:crypto";
import type { Logger } from "../utils/logger.js";
import { DebugMcpError } from "../utils/errors.js";
import type { OutcomeEventStore } from "../analytics/OutcomeEventRepository.js";
import { ANALYTICS_WINDOWS, type AnalyticsWindow, type OutcomeEvent } from "../analytics/OutcomeSchemas.js";
import {
  DEFAULT_PROPOSAL_DETECTORS,
  type DetectorContext,
  type ProposalDetector
} from "./PatternDetectors.js";
import {
  MAX_PROPOSALS_PER_GENERATION,
  MIN_PATTERN_RATIO,
  MIN_PROPOSAL_MATCHING_RUNS,
  assessProposal,
  inProposalCooldown,
  materiallyChanged,
  type ProposalPolicyAssessment
} from "./ProposalPolicy.js";
import type { ImprovementProposalStore, ProposalListQuery } from "./ProposalRepository.js";
import { buildImplementationPrompt } from "./ImplementationPromptBuilder.js";
import {
  improvementProposalSchema,
  proposalValidationResultSchema,
  type ImprovementProposal,
  type ProposalCategory,
  type ProposalFinding,
  type ProposalReviewDecision,
  type ProposalValidationResult,
  type ProposalStatus,
  type ProposalSummary
} from "./ProposalSchemas.js";

const DEFAULT_PROPOSAL_WINDOW: AnalyticsWindow = "30d";
const MAX_EVENT_QUERY = 50_000;
const SHA_PATTERN = /^[0-9a-f]{7,64}$/i;

export interface ImprovementProposalServiceOptions {
  events: OutcomeEventStore;
  proposals: ImprovementProposalStore;
  currentBaselineSha?: string | (() => string | undefined);
  now?: () => number;
  detectors?: readonly ProposalDetector[];
  minMatchingRuns?: number;
  minPatternRatio?: number;
  logger?: Pick<Logger, "warn" | "error">;
}

export interface GenerateImprovementProposalsInput {
  window?: AnalyticsWindow;
  baselineSha?: string;
}

export interface ListImprovementProposalsInput {
  status?: ProposalStatus;
  category?: ProposalCategory;
  target?: string;
  minConfidence?: number;
  limit?: number;
}

export interface ReviewImprovementProposalInput {
  proposalId: string;
  decision: ProposalReviewDecision;
  reviewReason: string;
  reviewer?: string;
}

export interface RecordProposalValidationInput {
  proposalId: string;
  result: ProposalValidationResult;
}

/** Evidence-bound Proposal lifecycle. It never edits source code or executes a proposal. */
export class ImprovementProposalService {
  private readonly now: () => number;
  private readonly detectors: readonly ProposalDetector[];
  private readonly minMatchingRuns: number;
  private readonly minPatternRatio: number;

  constructor(private readonly options: ImprovementProposalServiceOptions) {
    this.now = options.now ?? (() => Date.now());
    this.detectors = options.detectors ?? DEFAULT_PROPOSAL_DETECTORS;
    this.minMatchingRuns = Math.max(1, Math.min(10_000, Math.trunc(options.minMatchingRuns ?? MIN_PROPOSAL_MATCHING_RUNS)));
    this.minPatternRatio = Math.max(0, Math.min(1, options.minPatternRatio ?? MIN_PATTERN_RATIO));
  }

  generate(input: GenerateImprovementProposalsInput = {}): Record<string, unknown> {
    const window = normalizeWindow(input.window);
    const nowMs = this.now();
    const { from, to } = windowBounds(window, nowMs);
    let events: OutcomeEvent[];
    try {
      events = this.options.events.list({ from, to, limit: MAX_EVENT_QUERY });
    } catch (error) {
      this.options.logger?.warn("c2000 improvement analytics unavailable", { error: String(error) });
      throw new DebugMcpError("ImprovementAnalyticsUnavailable", "Improvement proposals require readable Outcome Analytics data", {
        window,
        from,
        to,
        analyticsAvailable: false
      });
    }
    const baselineSha = this.resolveBaselineSha(input.baselineSha);
    const context: DetectorContext = {
      events,
      window,
      from,
      to,
      nowMs,
      minMatchingRuns: this.minMatchingRuns,
      minPatternRatio: this.minPatternRatio
    };
    const detectorResults = this.detectors.map(detector => detector.detect(context));
    const findings = detectorResults.flatMap(result => result.findings);
    const insufficientFromDetectors = detectorResults.reduce((total, result) => total + result.insufficientEvidenceCount, 0);
    const counters = {
      generated: 0,
      updated: 0,
      deduplicated: 0,
      insufficientEvidence: insufficientFromDetectors,
      firmwareLikelySuppressed: 0,
      environmentLikelySuppressed: 0,
      protectedInvariantSuppressed: 0
    };
    const generated: ImprovementProposal[] = [];
    const seen = new Set<string>();
    for (const rawFinding of findings.slice(0, MAX_PROPOSALS_PER_GENERATION)) {
      if (seen.has(rawFinding.fingerprint)) {
        counters.deduplicated += 1;
        continue;
      }
      seen.add(rawFinding.fingerprint);
      const finding = normalizeFindingEvidence(rawFinding, context);
      const assessment = assessProposal(finding);
      if (!assessment.allowed) {
        if (assessment.rootCause === "likely-firmware-deficiency") counters.firmwareLikelySuppressed += 1;
        else if (assessment.rootCause === "environment-issue") counters.environmentLikelySuppressed += 1;
        else if (assessment.reason?.includes("Protected invariant")) counters.protectedInvariantSuppressed += 1;
        continue;
      }
      const existing = this.options.proposals.findByFingerprint(finding.fingerprint);
      if (existing && existing.status === "rejected" && !materiallyChanged(existing, finding)) {
        counters.deduplicated += 1;
        continue;
      }
      const proposal = this.upsertFinding(finding, assessment, existing, baselineSha, nowMs);
      generated.push(proposal);
      if (existing) {
        counters.updated += 1;
        if (inProposalCooldown(existing, nowMs)) counters.deduplicated += 1;
      } else {
        counters.generated += 1;
      }
    }
    const proposalSummaries = generated.map(toSummary);
    return {
      analyticsAvailable: true,
      window,
      from,
      to,
      generatedAt: new Date(nowMs).toISOString(),
      baselineSha,
      detectors: this.detectors.map(detector => detector.name),
      thresholds: {
        minMatchingRuns: this.minMatchingRuns,
        minPatternRatio: this.minPatternRatio
      },
      counts: {
        ...counters,
        generatedProposals: counters.generated,
        updatedProposals: counters.updated,
        deduplicatedPatterns: counters.deduplicated,
        insufficientEvidence: counters.insufficientEvidence,
        firmwareLikelySuppressed: counters.firmwareLikelySuppressed,
        environmentLikelySuppressed: counters.environmentLikelySuppressed,
        protectedInvariantSuppressed: counters.protectedInvariantSuppressed
      },
      proposals: proposalSummaries,
      status: proposalSummaries.length > 0 ? "PROPOSALS_GENERATED" : "NO_PRODUCTION_IMPROVEMENT_PROPOSALS_YET"
    };
  }

  list(input: ListImprovementProposalsInput = {}): Record<string, unknown> {
    const query: ProposalListQuery = {
      ...(input.category ? { category: input.category } : {}),
      ...(input.target ? { target: input.target } : {}),
      ...(input.minConfidence === undefined ? {} : { minConfidence: input.minConfidence }),
      limit: input.limit
    };
    const proposals = input.status
      ? this.options.proposals.list({ ...query, status: input.status })
      : [...this.options.proposals.list({ ...query, status: "ready-for-review" }), ...this.options.proposals.list({ ...query, status: "approved" })]
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.proposalId.localeCompare(right.proposalId))
        .slice(0, Math.max(1, Math.min(500, Math.trunc(input.limit ?? 100))));
    return {
      proposals: proposals.map(toSummary),
      count: proposals.length,
      defaultStatuses: input.status ? undefined : ["ready-for-review", "approved"]
    };
  }

  get(proposalId: string): Record<string, unknown> {
    const proposal = this.requireProposal(proposalId);
    return { proposal, mergeCandidate: isMergeCandidate(proposal) };
  }

  review(input: ReviewImprovementProposalInput): Record<string, unknown> {
    const proposal = this.requireProposal(input.proposalId);
    const reason = input.reviewReason.trim();
    if (!reason) {
      throw new DebugMcpError("ProposalReviewReasonRequired", "A reviewReason is required for every Proposal decision", { proposalId: input.proposalId });
    }
    if (input.decision === "approve" && proposal.status !== "ready-for-review" && proposal.status !== "deferred") {
      throw new DebugMcpError("ProposalNotReadyForReview", `Proposal ${proposal.proposalId} is not ready for approval`, {
        proposalId: proposal.proposalId,
        status: proposal.status,
        requiredStatus: "ready-for-review"
      });
    }
    if (input.decision === "approve" && !proposal.baselineSha) {
      throw new DebugMcpError("BaselineUnavailable", "An approved Proposal must be bound to a baseline SHA", {
        proposalId: proposal.proposalId,
        actionRequired: "Regenerate the Proposal with baselineSha or configure C2000_MCP_BASELINE_SHA."
      });
    }
    if (input.decision !== "approve" && ["implementing", "validated", "superseded"].includes(proposal.status)) {
      throw new DebugMcpError("ProposalInvalidState", `Proposal ${proposal.proposalId} cannot be reviewed from ${proposal.status}`, {
        proposalId: proposal.proposalId,
        status: proposal.status
      });
    }
    const status: ProposalStatus = input.decision === "approve" ? "approved" : input.decision === "reject" ? "rejected" : "deferred";
    const reviewedAt = new Date(this.now()).toISOString();
    const reviewed = improvementProposalSchema.parse({
      ...proposal,
      status,
      updatedAt: reviewedAt,
      reviewReason: reason,
      reviewedAt,
      reviewedBy: normalizeReviewer(input.reviewer)
    });
    this.options.proposals.upsert(reviewed);
    return {
      proposal: reviewed,
      decision: input.decision,
      approvedForImplementation: status === "approved",
      mergeCandidate: false,
      executesAutomatically: false
    };
  }

  /** Mark an approved Proposal as being implemented in an isolated candidate. */
  beginImplementation(proposalId: string, baselineSha?: string): Record<string, unknown> {
    const proposal = this.requireProposal(proposalId);
    if (proposal.status !== "approved") {
      throw new DebugMcpError("ProposalInvalidState", `Proposal ${proposal.proposalId} cannot enter implementation from ${proposal.status}`, {
        proposalId: proposal.proposalId,
        status: proposal.status,
        requiredStatus: "approved"
      });
    }
    this.assertCurrentBaseline(proposal, baselineSha);
    const implementing = improvementProposalSchema.parse({
      ...proposal,
      status: "implementing",
      updatedAt: new Date(this.now()).toISOString()
    });
    this.options.proposals.upsert(implementing);
    return { proposal: implementing, mergeCandidate: false, executesAutomatically: false };
  }

  /**
   * Record an externally executed candidate validation. This is intentionally
   * a service API rather than an MCP mutation tool: code changes and their
   * validation remain outside the MCP server's authority.
   */
  recordValidation(input: RecordProposalValidationInput): Record<string, unknown> {
    const proposal = this.requireProposal(input.proposalId);
    if (proposal.status !== "approved" && proposal.status !== "implementing") {
      throw new DebugMcpError("ProposalInvalidState", `Proposal ${proposal.proposalId} cannot accept validation from ${proposal.status}`, {
        proposalId: proposal.proposalId,
        status: proposal.status,
        requiredStatuses: ["approved", "implementing"]
      });
    }
    const result = proposalValidationResultSchema.parse(input.result);
    if (!proposal.baselineSha) {
      throw new DebugMcpError("BaselineUnavailable", "Validation requires a Proposal baseline SHA", {
        proposalId: proposal.proposalId
      });
    }
    const currentBaseline = this.resolveBaselineSha();
    if (!currentBaseline) {
      throw new DebugMcpError("BaselineUnavailable", "Validation requires the current baseline SHA", {
        proposalId: proposal.proposalId,
        actionRequired: "Configure C2000_MCP_BASELINE_SHA before recording validation."
      });
    }
    if (currentBaseline !== proposal.baselineSha || result.baseline !== proposal.baselineSha) {
      throw new DebugMcpError("BaselineDrift", "Validation baseline does not match the approved Proposal baseline", {
        proposalId: proposal.proposalId,
        proposalBaseline: proposal.baselineSha,
        currentBaseline,
        validationBaseline: result.baseline,
        actionRequired: "Re-evaluate the Proposal against the current baseline."
      });
    }
    const status: ProposalStatus = result.verdict === "regressed"
      ? "failed"
      : validationCanBeAccepted(result)
        ? "validated"
        : "implementing";
    const validated = improvementProposalSchema.parse({
      ...proposal,
      status,
      validationResult: result,
      updatedAt: new Date(this.now()).toISOString()
    });
    this.options.proposals.upsert(validated);
    return {
      proposal: validated,
      validationResult: result,
      mergeCandidate: isMergeCandidate(validated),
      executesAutomatically: false,
      requiresHumanMerge: true
    };
  }

  exportImplementationPrompt(proposalId: string): Record<string, unknown> {
    const proposal = this.requireProposal(proposalId);
    if (proposal.status !== "approved") {
      throw new DebugMcpError("ProposalNotApproved", `Proposal ${proposal.proposalId} must be approved before an implementation prompt can be exported`, {
        proposalId: proposal.proposalId,
        status: proposal.status,
        requiredStatus: "approved"
      });
    }
    if (proposal.proposedChange.implementationMode !== "auto-eligible") {
      throw new DebugMcpError("ImplementationPromptNotAllowed", `Proposal ${proposal.proposalId} is manual-only and requires architecture review`, {
        proposalId: proposal.proposalId,
        implementationMode: proposal.proposedChange.implementationMode,
        risk: proposal.risks[0]?.level ?? "high"
      });
    }
    const baselineSha = this.assertCurrentBaseline(proposal);
    const artifact = buildImplementationPrompt(proposal, baselineSha);
    return {
      proposalId: proposal.proposalId,
      baselineSha,
      artifactType: "text/markdown",
      prompt: artifact.prompt,
      sha256: artifact.sha256,
      executesAutomatically: false,
      requiresIsolatedWorktree: true,
      requiresHumanMerge: true
    };
  }

  private assertCurrentBaseline(proposal: ImprovementProposal, explicitBaseline?: string): string {
    if (!proposal.baselineSha) {
      throw new DebugMcpError("BaselineUnavailable", "An approved Proposal must be bound to a baseline SHA", {
        proposalId: proposal.proposalId
      });
    }
    const currentBaseline = this.resolveBaselineSha(explicitBaseline);
    if (!currentBaseline) {
      throw new DebugMcpError("BaselineUnavailable", "The current baseline SHA is unavailable", {
        proposalId: proposal.proposalId,
        actionRequired: "Configure C2000_MCP_BASELINE_SHA or pass the current baseline SHA."
      });
    }
    if (proposal.baselineSha !== currentBaseline) {
      throw new DebugMcpError("BaselineDrift", "The approved Proposal baseline does not match the current configured baseline", {
        proposalId: proposal.proposalId,
        proposalBaseline: proposal.baselineSha,
        currentBaseline,
        actionRequired: "Re-evaluate the approved Proposal against the current master."
      });
    }
    return currentBaseline;
  }

  private upsertFinding(
    finding: ProposalFinding,
    assessment: ProposalPolicyAssessment,
    existing: ImprovementProposal | undefined,
    baselineSha: string | undefined,
    nowMs: number
  ): ImprovementProposal {
    const timestamp = new Date(nowMs).toISOString();
    const status: ProposalStatus = existing && ["approved", "implementing", "validated", "superseded"].includes(existing.status)
      ? existing.status
      : finding.evidence.sufficient ? "ready-for-review" : "draft";
    const proposal = improvementProposalSchema.parse({
      proposalId: existing?.proposalId ?? `imp-${finding.fingerprint}-${randomUUID().slice(0, 8)}`,
      fingerprint: finding.fingerprint,
      status,
      category: finding.category,
      target: finding.target,
      title: finding.title,
      summary: finding.summary,
      evidence: finding.evidence,
      proposedChange: {
        ...finding.proposedChange,
        implementationMode: assessment.implementationMode
      },
      expectedBenefit: finding.expectedBenefit,
      risks: finding.risks,
      validationPlan: finding.validationPlan,
      confidence: Math.max(0, Math.min(1, finding.confidence)),
      priority: assessment.priority,
      generatedBy: finding.generatedBy,
      sourceWindow: finding.evidence.sampleWindow,
      ...(existing && ["approved", "implementing", "validated", "superseded"].includes(existing.status)
        ? (existing.baselineSha ? { baselineSha: existing.baselineSha } : {})
        : baselineSha ? { baselineSha } : existing?.baselineSha ? { baselineSha: existing.baselineSha } : {}),
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
      lastObservedAt: finding.evidence.observedAt ?? timestamp,
      ...(existing?.reviewReason ? { reviewReason: existing.reviewReason } : {}),
      ...(existing?.reviewedAt ? { reviewedAt: existing.reviewedAt } : {}),
      ...(existing?.reviewedBy ? { reviewedBy: existing.reviewedBy } : {}),
      ...(existing?.validationResult ? { validationResult: existing.validationResult } : {})
    });
    this.options.proposals.upsert(proposal);
    return proposal;
  }

  private requireProposal(proposalId: string): ImprovementProposal {
    const proposal = this.options.proposals.get(proposalId);
    if (!proposal) throw new DebugMcpError("ProposalNotFound", `Improvement Proposal not found: ${proposalId}`, { proposalId });
    return proposal;
  }

  private resolveBaselineSha(explicit?: string): string | undefined {
    const configured = explicit
      ?? (typeof this.options.currentBaselineSha === "function" ? this.options.currentBaselineSha() : this.options.currentBaselineSha)
      ?? process.env.C2000_MCP_BASELINE_SHA;
    if (configured === undefined) return undefined;
    if (!SHA_PATTERN.test(configured)) {
      throw new DebugMcpError("BaselineInvalid", "Baseline SHA must be a hexadecimal git SHA", { baselineSha: configured });
    }
    return configured;
  }
}

function normalizeFindingEvidence(finding: ProposalFinding, context: DetectorContext): ProposalFinding {
  if (finding.evidence.sufficient || finding.evidence.rootCause !== "likely-mcp-deficiency") return finding;
  return {
    ...finding,
    evidence: {
      ...finding.evidence,
      rootCause: "insufficient-evidence",
      rootCauseReason: `The detector observed ${finding.evidence.matchingRuns} matching cases; at least ${context.minMatchingRuns ?? MIN_PROPOSAL_MATCHING_RUNS} and a ${(context.minPatternRatio ?? MIN_PATTERN_RATIO) * 100}% pattern ratio are required for ready-for-review.`
    }
  };
}

function normalizeWindow(window: AnalyticsWindow | undefined): AnalyticsWindow {
  return window && ANALYTICS_WINDOWS.includes(window) ? window : DEFAULT_PROPOSAL_WINDOW;
}

function windowBounds(window: AnalyticsWindow, nowMs: number): { from: string; to: string } {
  const durationMs = window === "24h"
    ? 24 * 60 * 60 * 1000
    : window === "7d"
      ? 7 * 24 * 60 * 60 * 1000
      : window === "30d"
        ? 30 * 24 * 60 * 60 * 1000
        : 90 * 24 * 60 * 60 * 1000;
  return { from: new Date(nowMs - durationMs).toISOString(), to: new Date(nowMs).toISOString() };
}

function normalizeReviewer(value: string | undefined): string {
  const normalized = value?.trim() || "human-reviewer";
  return /^[A-Za-z0-9._:-]{1,128}$/.test(normalized) ? normalized : "human-reviewer";
}

function toSummary(proposal: ImprovementProposal): ProposalSummary {
  return {
    proposalId: proposal.proposalId,
    status: proposal.status,
    category: proposal.category,
    target: proposal.target,
    title: proposal.title,
    summary: proposal.summary,
    confidence: proposal.confidence,
    priority: proposal.priority,
    rootCause: proposal.evidence.rootCause,
    evidence: {
      matchingRuns: proposal.evidence.matchingRuns,
      affectedRuns: proposal.evidence.affectedRuns,
      successAfterEscalation: proposal.evidence.successAfterEscalation,
      failureAfterEscalation: proposal.evidence.failureAfterEscalation,
      sampleWindow: proposal.evidence.sampleWindow,
      sufficient: proposal.evidence.sufficient
    },
    implementationMode: proposal.proposedChange.implementationMode,
    ...(proposal.validationResult ? { validationVerdict: proposal.validationResult.verdict } : {}),
    mergeCandidate: isMergeCandidate(proposal),
    createdAt: proposal.createdAt,
    updatedAt: proposal.updatedAt
  };
}

function validationCanBeAccepted(result: ProposalValidationResult): boolean {
  return result.implementationComplete
    && Boolean(result.candidate)
    && result.verdict !== "regressed"
    && result.verdict !== "inconclusive"
    && result.tests.length > 0
    && result.tests.every(test => test.status === "passed")
    && result.regressions.length === 0
    && result.safetyChecks.length > 0
    && result.safetyChecks.every(check => check.passed);
}

export function isMergeCandidate(proposal: ImprovementProposal): boolean {
  return proposal.status === "validated"
    && proposal.validationResult !== undefined
    && validationCanBeAccepted(proposal.validationResult)
    && proposal.validationResult.baseline === proposal.baselineSha;
}

// Keep this import-time assertion close to the service so validation results
// used by later rounds cannot silently drift from the common schema.
export { proposalValidationResultSchema };
