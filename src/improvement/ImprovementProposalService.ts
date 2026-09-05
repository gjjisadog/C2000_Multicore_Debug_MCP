import { createHash, randomUUID } from "node:crypto";
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
  type ProposalSummary,
  type ProposalFinalOutcome,
  derivePrimaryMetrics
} from "./ProposalSchemas.js";
import { currentEngineeringPolicySnapshot } from "./meta/PolicySnapshotService.js";

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

/** Input used only when a reviewed meta recommendation becomes a normal Proposal. */
export interface PolicyRecommendationProposalInput {
  recommendationId: string;
  category: string;
  target: string;
  title: string;
  summary: string;
  evidence: {
    sampleSize: number;
    currentPolicyRegime: string;
    validationEscapeCount: number;
    effectSize: number;
    relevantProposalIds: string[];
    relevantEvaluationIds: string[];
    confounders: string[];
  };
  currentPolicy: unknown;
  recommendedPolicyChange: unknown;
  expectedEffect: string[];
  risks: string[];
  confidence: number;
  engineeringPolicyHash: string;
  policyRegime: string;
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

  /**
   * Convert a reviewed policy recommendation into the ordinary Proposal
   * lifecycle. The result is deliberately ready-for-review, never approved.
   */
  createPolicyRecommendationProposal(input: PolicyRecommendationProposalInput): ImprovementProposal {
    const timestamp = new Date(this.now()).toISOString();
    const fingerprint = createHash("sha256")
      .update(JSON.stringify({ source: "policy-recommendation", recommendationId: input.recommendationId, target: input.target, policy: input.recommendedPolicyChange, policyRegime: input.policyRegime }), "utf8")
      .digest("hex");
    const existing = this.options.proposals.findByFingerprint(fingerprint);
    if (existing) return existing;

    const category = policyProposalCategory(input.category);
    const changeKind = policyProposalChangeKind(input.category);
    const currentPolicy = compactPolicyValue(input.currentPolicy);
    const recommendedPolicy = compactPolicyValue(input.recommendedPolicyChange);
    const metrics = policySuccessMetrics(input.category, input.expectedEffect);
    const relevantProposalIds = input.evidence.relevantProposalIds.slice(0, 4).join(",").slice(0, 256);
    const relevantEvaluationIds = input.evidence.relevantEvaluationIds.slice(0, 4).join(",").slice(0, 256);
    const proposal = improvementProposalSchema.parse({
      proposalId: `imp-policy-${fingerprint.slice(0, 24)}-${randomUUID().slice(0, 8)}`,
      fingerprint,
      status: "ready-for-review",
      category,
      target: input.target,
      title: `Policy proposal: ${input.title}`.slice(0, 256),
      summary: `${input.summary} This Proposal was converted from ${input.recommendationId}; it still requires ordinary Proposal review, isolated implementation, PR review, and post-merge evaluation.`.slice(0, 2048),
      evidence: {
        matchingRuns: input.evidence.sampleSize,
        affectedRuns: input.evidence.sampleSize,
        successAfterEscalation: 0,
        failureAfterEscalation: input.evidence.validationEscapeCount,
        sampleWindow: "retained",
        patternRatio: Math.max(0, Math.min(1, Math.abs(input.evidence.effectSize))),
        failureRate: input.evidence.sampleSize === 0 ? 0 : Math.min(1, input.evidence.validationEscapeCount / input.evidence.sampleSize),
        sufficient: true,
        minimumMatchingRuns: 5,
        minimumPatternRatio: 0.2,
        supportingTools: [],
        supportingCapabilities: [],
        context: {
          recommendationId: input.recommendationId,
          policyRegime: input.policyRegime,
          engineeringPolicyHash: input.engineeringPolicyHash,
          currentPolicy,
          recommendedPolicy,
          ...(relevantProposalIds ? { relevantProposalIds } : {}),
          ...(relevantEvaluationIds ? { relevantEvaluationIds } : {})
        },
        rootCause: "likely-mcp-deficiency",
        rootCauseReason: "A deterministic cross-improvement pattern was reviewed before conversion to a normal Proposal.",
        observedAt: timestamp
      },
      proposedChange: {
        kind: changeKind,
        target: input.target,
        description: `Review and, if approved, implement this governance change. Current policy: ${currentPolicy}. Recommended change: ${recommendedPolicy}.`,
        allowedAreas: ["src/improvement/**", "tests/**", "README.md", "skills/c2000-multicore-debug/SKILL.md"],
        forbiddenAreas: ["src/debug/**", "src/boards/**", "src/can/**", "automatic merge", "automatic rollback", "MetaPolicyGuard protected floors"],
        changeScope: "medium",
        implementationMode: "manual-only",
        suggestedTools: []
      },
      expectedBenefit: {
        summary: input.expectedEffect.slice(0, 8).join(" ").slice(0, 1024),
        metrics
      },
      risks: (input.risks.length > 0 ? input.risks : ["Governance changes can create confounding or reduce improvement throughput; retain all safety and human-review floors."]).slice(0, 16).map(risk => ({
        level: "high" as const,
        description: risk.slice(0, 1024),
        mitigation: "Require human Proposal review, isolated validation, PR review, and post-merge evaluation."
      })),
      validationPlan: {
        existingTests: ["tests/improvementProposal.test.ts", "tests/metaAnalytics.test.ts", "tests/toolSafety.test.ts"],
        newRegressionTestRequired: true,
        mockValidation: true,
        hardwareRequired: Boolean(asRecord(input.recommendedPolicyChange).hardwareRequired),
        replayFixtures: input.evidence.relevantEvaluationIds.slice(0, 8),
        beforeAfterMetrics: metrics.map(metric => metric.name),
        rollbackCondition: "Any protected-floor violation, verified regression, or unacceptable throughput loss requires manual investigation.",
        acceptanceCriteria: [
          "The policy change preserves Safety Profile and human merge semantics.",
          "The expected meta metrics are measured before and after the change.",
          "The merged policy change receives a normal Post-Merge Evaluation."
        ]
      },
      confidence: Math.max(0, Math.min(1, input.confidence)),
      priority: policyProposalPriority(input.category),
      generatedBy: "analytics-pattern",
      sourceWindow: "retained",
      source: "policy-recommendation",
      policyRegime: input.policyRegime,
      engineeringPolicyHash: input.engineeringPolicyHash,
      sourceRecommendationId: input.recommendationId,
      primaryMetrics: metrics.map(metric => ({
        name: metric.name,
        classification: metricClassificationForName(metric.name),
        direction: metric.direction,
        required: true,
        tolerance: 0,
        meaningfulDelta: 0.01,
        unit: "",
        rationale: metric.rationale,
        source: "declared" as const
      })),
      primaryMetricsLocked: false,
      primaryMetricsSource: "declared",
      createdAt: timestamp,
      updatedAt: timestamp,
      lastObservedAt: timestamp
    });
    this.options.proposals.upsert(proposal);
    return proposal;
  }

  review(input: ReviewImprovementProposalInput): Record<string, unknown> {
    const current = this.requireProposal(input.proposalId);
    const reason = input.reviewReason.trim();
    if (!reason) {
      throw new DebugMcpError("ProposalReviewReasonRequired", "A reviewReason is required for every Proposal decision", { proposalId: input.proposalId });
    }
    if (input.decision === "approve" && current.status !== "ready-for-review" && current.status !== "deferred") {
      throw new DebugMcpError("ProposalNotReadyForReview", `Proposal ${current.proposalId} is not ready for approval`, {
        proposalId: current.proposalId,
        status: current.status,
        requiredStatus: "ready-for-review"
      });
    }
    if (input.decision !== "approve" && ["implementation-queued", "implementing", "validation-pending", "candidate-ready", "validated", "superseded"].includes(current.status)) {
      throw new DebugMcpError("ProposalInvalidState", `Proposal ${current.proposalId} cannot be reviewed from ${current.status}`, {
        proposalId: current.proposalId,
        status: current.status
      });
    }
    const proposal = input.decision === "approve" ? this.ensurePrimaryMetricsLocked(current) : current;
    if (input.decision === "approve" && !proposal.baselineSha) {
      throw new DebugMcpError("BaselineUnavailable", "An approved Proposal must be bound to a baseline SHA", {
        proposalId: proposal.proposalId,
        actionRequired: "Regenerate the Proposal with baselineSha or configure C2000_MCP_BASELINE_SHA."
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

  /** Lock the primary success metrics before a Proposal enters approval. */
  lockPrimaryMetrics(proposalId: string): ImprovementProposal {
    return this.ensurePrimaryMetricsLocked(this.requireProposal(proposalId));
  }

  /**
   * Record the final post-merge outcome without changing Proposal governance
   * status. This method never approves, merges, reverts, or executes code.
   */
  setFinalOutcome(proposalId: string, finalOutcome: ProposalFinalOutcome): ImprovementProposal {
    const current = this.requireProposal(proposalId);
    if (current.status !== "merged" && current.finalOutcome === undefined) {
      throw new DebugMcpError("ProposalInvalidState", `Proposal ${current.proposalId} is not a merged candidate`, {
        proposalId,
        status: current.status,
        requiredStatus: "merged"
      });
    }
    const proposal = this.ensurePrimaryMetricsLocked(current);
    const updated = improvementProposalSchema.parse({
      ...proposal,
      finalOutcome,
      updatedAt: new Date(this.now()).toISOString()
    });
    this.options.proposals.upsert(updated);
    return updated;
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

  /** Queue state is separate from the active implementation Run record. */
  markImplementationQueued(proposalId: string, baselineSha?: string): ImprovementProposal {
    const proposal = this.requireProposal(proposalId);
    if (proposal.status !== "approved") {
      throw new DebugMcpError("ProposalNotApproved", `Proposal ${proposal.proposalId} must be approved before implementation can be queued`, {
        proposalId: proposal.proposalId,
        status: proposal.status,
        requiredStatus: "approved"
      });
    }
    this.assertCurrentBaseline(proposal, baselineSha);
    return this.persistLifecycle(proposal, "implementation-queued");
  }

  markImplementationStarted(proposalId: string): ImprovementProposal {
    const proposal = this.requireProposal(proposalId);
    if (proposal.status !== "approved" && proposal.status !== "implementation-queued") {
      throw new DebugMcpError("ProposalInvalidState", `Proposal ${proposal.proposalId} cannot start implementation from ${proposal.status}`, {
        proposalId: proposal.proposalId,
        status: proposal.status,
        requiredStatuses: ["approved", "implementation-queued"]
      });
    }
    return this.persistLifecycle(proposal, "implementing");
  }

  markValidationPending(proposalId: string): ImprovementProposal {
    const proposal = this.requireProposal(proposalId);
    if (!["implementing", "validation-pending"].includes(proposal.status)) {
      throw new DebugMcpError("ProposalInvalidState", `Proposal ${proposal.proposalId} cannot enter validation-pending from ${proposal.status}`, {
        proposalId: proposal.proposalId,
        status: proposal.status,
        requiredStatuses: ["implementing", "validation-pending"]
      });
    }
    return this.persistLifecycle(proposal, "validation-pending");
  }

  markImplementationFailed(proposalId: string, reason: string): ImprovementProposal {
    const proposal = this.requireProposal(proposalId);
    if (["candidate-ready", "rejected", "superseded"].includes(proposal.status)) return proposal;
    return this.persistLifecycle(proposal, "implementation-failed", reason);
  }

  markCandidateRejected(proposalId: string, result?: ProposalValidationResult, reason?: string): ImprovementProposal {
    const proposal = this.requireProposal(proposalId);
    if (proposal.status === "candidate-ready") return proposal;
    return this.persistLifecycle(proposal, "candidate-rejected", reason, result);
  }

  markCandidateReady(proposalId: string, result: ProposalValidationResult): ImprovementProposal {
    const proposal = this.requireProposal(proposalId);
    if (proposal.status !== "implementing" && proposal.status !== "validation-pending" && proposal.status !== "validated") {
      throw new DebugMcpError("ProposalInvalidState", `Proposal ${proposal.proposalId} cannot become candidate-ready from ${proposal.status}`, {
        proposalId: proposal.proposalId,
        status: proposal.status,
        requiredStatuses: ["implementing", "validation-pending", "validated"]
      });
    }
    const parsed = proposalValidationResultSchema.parse(result);
    if (!validationCanBeAccepted(parsed)) {
      throw new DebugMcpError("CandidateNotReady", `Proposal ${proposal.proposalId} has not passed candidate validation`, {
        proposalId: proposal.proposalId,
        verdict: parsed.verdict
      });
    }
    return this.persistLifecycle(proposal, "candidate-ready", undefined, parsed);
  }

  /**
   * Record the external review lifecycle without changing the immutable
   * Proposal evidence or implementation run. GitHub/CI state is governance
   * metadata and must never be treated as a new implementation validation.
   */
  markReviewLifecycle(proposalId: string, status: Extract<ProposalStatus, "pr-open" | "merge-recommended" | "merged" | "closed-without-merge">, reason?: string): ImprovementProposal {
    const proposal = this.requireProposal(proposalId);
    if (!["candidate-ready", "validated", "pr-open", "merge-recommended", "closed-without-merge", "merged"].includes(proposal.status)) {
      throw new DebugMcpError("ProposalInvalidState", `Proposal ${proposal.proposalId} cannot enter review lifecycle from ${proposal.status}`, {
        proposalId,
        status: proposal.status,
        requiredStatuses: ["candidate-ready", "validated", "pr-open", "merge-recommended", "closed-without-merge", "merged"]
      });
    }
    return this.persistLifecycle(proposal, status, reason);
  }

  /**
   * Record an externally executed candidate validation. This is intentionally
   * a service API rather than an MCP mutation tool: code changes and their
   * validation remain outside the MCP server's authority.
   */
  recordValidation(input: RecordProposalValidationInput): Record<string, unknown> {
    // Legacy Proposals may predate Round9's explicit metric contract. Lock
    // their derived/declared primary metrics before accepting validation so a
    // later post-merge comparison cannot silently change its target metric set.
    const current = this.requireProposal(input.proposalId);
    if (current.status !== "approved" && current.status !== "implementing" && current.status !== "validation-pending") {
      throw new DebugMcpError("ProposalInvalidState", `Proposal ${current.proposalId} cannot accept validation from ${current.status}`, {
        proposalId: current.proposalId,
        status: current.status,
        requiredStatuses: ["approved", "implementing"]
      });
    }
    const proposal = this.ensurePrimaryMetricsLocked(current);
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
    const preserveExisting = existing !== undefined && shouldPreserveGeneratedLifecycle(existing.status);
    const status: ProposalStatus = preserveExisting
      ? existing.status
      : finding.evidence.sufficient ? "ready-for-review" : "draft";
    const policySnapshot = existing ? undefined : currentEngineeringPolicySnapshot();
    const proposal = improvementProposalSchema.parse({
      proposalId: existing?.proposalId ?? `imp-${finding.fingerprint}-${randomUUID().slice(0, 8)}`,
      fingerprint: finding.fingerprint,
      status,
      category: finding.category,
      target: finding.target,
      title: finding.title,
      summary: finding.summary,
      evidence: {
        ...finding.evidence,
        context: {
          ...finding.evidence.context,
          detector: finding.detector
        }
      },
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
      ...(existing?.policyRegime ? { policyRegime: existing.policyRegime } : existing ? {} : { policyRegime: policySnapshot!.policyRegime }),
      ...(existing?.engineeringPolicyHash ? { engineeringPolicyHash: existing.engineeringPolicyHash } : existing ? {} : { engineeringPolicyHash: policySnapshot!.engineeringPolicyHash }),
      primaryMetrics: existing?.primaryMetricsLocked
        ? existing.primaryMetrics
        : finding.expectedBenefit.metrics.map(metric => ({
            name: metric.name,
            classification: metricClassificationForName(metric.name),
            direction: metric.direction,
            required: true,
            tolerance: 0,
            meaningfulDelta: 0.01,
            unit: "",
            rationale: metric.rationale,
            source: "declared" as const
          })),
      primaryMetricsLocked: existing?.primaryMetricsLocked ?? false,
      ...(existing?.primaryMetricsLockedAt ? { primaryMetricsLockedAt: existing.primaryMetricsLockedAt } : {}),
      primaryMetricsSource: existing?.primaryMetricsSource ?? "declared",
      ...(existing?.source ? { source: existing.source } : {}),
      ...(existing?.finalOutcome ? { finalOutcome: existing.finalOutcome } : {}),
      ...(preserveExisting
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

  private ensurePrimaryMetricsLocked(proposal: ImprovementProposal): ImprovementProposal {
    if (proposal.primaryMetricsLocked && proposal.primaryMetrics.length > 0) return proposal;
    const metrics = derivePrimaryMetrics(proposal);
    if (metrics.length === 0) {
      throw new DebugMcpError("ProposalNotReadyForReview", "Proposal must declare at least one primary success metric before approval", {
        proposalId: proposal.proposalId,
        requiredField: "primaryMetrics"
      });
    }
    const lockedAt = new Date(this.now()).toISOString();
    const locked = improvementProposalSchema.parse({
      ...proposal,
      primaryMetrics: metrics,
      primaryMetricsLocked: true,
      primaryMetricsLockedAt: lockedAt,
      primaryMetricsSource: metrics.some(metric => metric.source === "retrospective") ? "retrospective" : "declared",
      updatedAt: lockedAt
    });
    this.options.proposals.upsert(locked);
    return locked;
  }

  private persistLifecycle(
    proposal: ImprovementProposal,
    status: ProposalStatus,
    reason?: string,
    validationResult?: ProposalValidationResult
  ): ImprovementProposal {
    const updated = improvementProposalSchema.parse({
      ...proposal,
      status,
      updatedAt: new Date(this.now()).toISOString(),
      ...(reason ? { reviewReason: reason } : {}),
      ...(validationResult ? { validationResult } : {})
    });
    this.options.proposals.upsert(updated);
    return updated;
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

function metricClassificationForName(name: string): "workflow" | "tool-surface" | "capability" | "reliability" | "performance" | "error-guidance" | "review-quality" | "test-quality" | "safety" {
  if (/safe|safety|invariant|lease|ownership|flash/i.test(name)) return "safety";
  if (/duration|latency|p95|p99|time|throughput|performance|cycle/i.test(name)) return "performance";
  if (/error|failure|timeout|reliab|success|pass|regression/i.test(name)) return "reliability";
  if (/tool|schema|surface/i.test(name)) return "tool-surface";
  if (/capability|escalat/i.test(name)) return "capability";
  if (/review/i.test(name)) return "review-quality";
  if (/test|coverage/i.test(name)) return "test-quality";
  return "workflow";
}

function policyProposalCategory(category: string): ProposalCategory {
  const mapping: Record<string, ProposalCategory> = {
    "proposal-policy": "workflow",
    "validation-policy": "test-coverage",
    "hardware-policy": "reliability",
    "tool-surface-policy": "tool-surface",
    "capability-policy": "capability",
    "skill-policy": "skill",
    "implementation-policy": "performance",
    "review-policy": "documentation",
    "evaluation-policy": "diagnostics"
  };
  return mapping[category] ?? "workflow";
}

function policyProposalChangeKind(category: string): "workflow-gap" | "surface-promotion" | "surface-demotion" | "capability-review" | "skill-routing" | "error-guidance" | "test-coverage" | "performance" | "rollback" {
  const mapping: Record<string, "workflow-gap" | "surface-promotion" | "surface-demotion" | "capability-review" | "skill-routing" | "error-guidance" | "test-coverage" | "performance" | "rollback"> = {
    "proposal-policy": "workflow-gap",
    "validation-policy": "test-coverage",
    "hardware-policy": "test-coverage",
    "tool-surface-policy": "surface-demotion",
    "capability-policy": "capability-review",
    "skill-policy": "skill-routing",
    "implementation-policy": "performance",
    "review-policy": "error-guidance",
    "evaluation-policy": "test-coverage"
  };
  return mapping[category] ?? "workflow-gap";
}

function policyProposalPriority(category: string): "P0" | "P1" | "P2" | "P3" {
  if (category === "hardware-policy" || category === "validation-policy") return "P1";
  if (category === "proposal-policy" || category === "evaluation-policy") return "P2";
  return "P3";
}

function policySuccessMetrics(category: string, expectedEffect: string[]): Array<{
  name: string;
  direction: "increase" | "decrease" | "preserve";
  rationale: string;
}> {
  const primary = category === "validation-policy" || category === "hardware-policy"
    ? "regression-rate"
    : category === "tool-surface-policy"
      ? "tool-selection-friction"
      : "verified-improvement-yield";
  const direction = /decrease|reduce|lower|fewer|下降|减少/i.test(expectedEffect.join(" ")) ? "decrease" as const : "increase" as const;
  return [
    { name: primary, direction, rationale: expectedEffect[0]?.slice(0, 512) ?? "Measure the expected policy effect." },
    { name: "regression-rate", direction: "preserve" as const, rationale: "Regression rate must not increase after the governance change." }
  ];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function compactPolicyValue(value: unknown): string {
  try {
    return JSON.stringify(value).slice(0, 240);
  } catch {
    return "unserializable-policy";
  }
}

function shouldPreserveGeneratedLifecycle(status: ProposalStatus): boolean {
  return [
    "approved",
    "implementation-queued",
    "implementing",
    "validation-pending",
    "candidate-ready",
    "candidate-rejected",
    "implementation-failed",
    "validated",
    "pr-open",
    "merge-recommended",
    "merged",
    "closed-without-merge",
    "failed",
    "superseded"
  ].includes(status);
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
  return (proposal.status === "validated" || proposal.status === "candidate-ready")
    && proposal.validationResult !== undefined
    && validationCanBeAccepted(proposal.validationResult)
    && proposal.validationResult.baseline === proposal.baselineSha;
}

// Keep this import-time assertion close to the service so validation results
// used by later rounds cannot silently drift from the common schema.
export { proposalValidationResultSchema };
