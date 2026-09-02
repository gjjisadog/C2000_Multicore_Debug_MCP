import { randomUUID } from "node:crypto";
import { DebugMcpError } from "../../utils/errors.js";
import {
  hardwareEvidenceSchema,
  improvementPullRequestSchema,
  candidateReviewResultSchema,
  reviewCheckSchema,
  reviewEvidenceSchema,
  sha256Json,
  type EvidenceStatus,
  type HardwareEvidence,
  type ReviewCheck,
  type ReviewEvidence,
  type ReviewPolicyConfig
} from "./ReviewSchemas.js";
import type { ImprovementPullRequest } from "./ReviewSchemas.js";
import type { CandidateReviewResult } from "./ReviewSchemas.js";
import type { ProviderCheck, ProviderPullRequest, ProviderReview } from "./GitHubReviewProvider.js";

export interface ReviewEvidenceInput {
  pullRequest: ImprovementPullRequest;
  providerPullRequest: ProviderPullRequest;
  candidateReview: CandidateReviewResult;
  /** Baseline of the run that produced the current candidate (C1 for C2). */
  candidateBaselineSha?: string;
  /** Base-branch SHA observed for the current PR record. */
  expectedProviderBaseSha?: string;
  checks: readonly ProviderCheck[];
  reviews: readonly ProviderReview[];
  policy: ReviewPolicyConfig;
  hardwareRequired?: boolean;
  hardwareEvidence?: HardwareEvidence;
  now?: () => number;
}

/** Converts external CI/review/hardware observations into candidate-bound facts. */
export class ReviewEvidenceService {
  collect(input: ReviewEvidenceInput): ReviewEvidence {
    const now = new Date((input.now ?? (() => Date.now()))()).toISOString();
    const pullRequest = improvementPullRequestSchema.safeParse(input.pullRequest);
    const candidateReview = candidateReviewResultSchema.safeParse(input.candidateReview);
    if (!pullRequest.success || !candidateReview.success) {
      throw new DebugMcpError("ReviewEvidenceInvalid", "Review evidence input is not a valid candidate-bound record", {
        pullRequestValid: pullRequest.success,
        candidateReviewValid: candidateReview.success
      });
    }
    const candidateSha = pullRequest.data.candidateSha;
    const candidateBaselineSha = input.candidateBaselineSha ?? pullRequest.data.baselineSha;
    const candidateIdentityMatches = candidateReview.data.candidateSha.toLowerCase() === candidateSha.toLowerCase()
      && candidateReview.data.baselineSha.toLowerCase() === candidateBaselineSha.toLowerCase();
    const candidateIsPublishable = candidateReview.data.valid && candidateReview.data.publishAllowed && candidateIdentityMatches;
    const localStatus: EvidenceStatus = candidateIsPublishable ? "pass" : "fail";
    const candidateStatus: EvidenceStatus = candidateIsPublishable ? "pass" : "fail";
    const providerBaseSha = input.providerPullRequest.baseSha;
    const expectedProviderBaseSha = input.expectedProviderBaseSha ?? candidateReview.data.currentBaseSha;
    const providerBaseMatches = /^[0-9a-f]{7,64}$/i.test(providerBaseSha)
      && providerBaseSha.toLowerCase() === expectedProviderBaseSha.toLowerCase();
    const baseStatus: EvidenceStatus = candidateReview.data.baseDrift.classification === "NO_DRIFT" && providerBaseMatches ? "pass" : "stale";
    const headStatus: EvidenceStatus = input.providerPullRequest.headSha.toLowerCase() === candidateSha.toLowerCase() ? "pass" : "stale";
    const checks = normalizeChecks(input.checks, candidateSha, input.policy);
    const ci = evaluateChecks(checks.required, checks.optional);
    const reviews = evaluateReviews(input.reviews, input.policy);
    const hardware = evaluateHardware(input.hardwareRequired === true, input.hardwareEvidence, candidateSha, now);
    const mergeability = input.providerPullRequest.mergeable;
    const warnings = [
      ...checks.optional.filter(check => check.status !== "passed").map(check => `Optional CI check is not passing: ${check.name}`),
      ...(input.providerPullRequest.draft ? ["Pull request is still a draft"] : []),
      ...(reviews.botApprovals > 0 ? [`${reviews.botApprovals} bot approval(s) are recorded but do not satisfy a human review gate`] : [])
    ];
    const baseRecord = {
      pullRequestId: input.pullRequest.pullRequestId,
      candidateSha,
      checkedAt: now,
      candidate: state(candidateStatus, candidateSha, now, candidateIsPublishable ? undefined : candidateReview.data.issues.join("; ") || "candidate is not publishable"),
      local: state(localStatus, candidateSha, now, candidateIsPublishable ? undefined : candidateReview.data.issues.join("; ") || "candidate is not publishable"),
      ci: {
        ...state(ci.status, candidateSha, now, ci.reason),
        requiredChecks: checks.required,
        optionalChecks: checks.optional
      },
      reviews: {
        ...state(reviews.status, candidateSha, now, reviews.reason),
        approvals: reviews.approvals,
        humanApprovals: reviews.humanApprovals,
        botApprovals: reviews.botApprovals,
        changesRequested: reviews.changesRequested,
        humanReviewRequired: reviews.humanReviewRequired
      },
      hardware: hardware.state,
      base: {
        ...state(baseStatus, candidateSha, now, baseStatus === "pass"
          ? undefined
          : candidateReview.data.baseDrift.classification !== "NO_DRIFT"
            ? `Base drift: ${candidateReview.data.baseDrift.classification}`
            : "Pull request base SHA does not match the current validated base"),
        classification: candidateReview.data.baseDrift.classification
      },
      head: state(headStatus, candidateSha, now, headStatus === "pass" ? undefined : "Pull request head SHA does not match the candidate SHA"),
      mergeability,
      ...(hardware.evidence ? { hardwareEvidence: hardware.evidence } : {}),
      warnings
    };
    const evidenceHash = sha256Json(baseRecord);
    return reviewEvidenceSchema.parse({
      evidenceId: `evidence-${randomUUID()}`,
      ...baseRecord,
      evidenceHash
    });
  }
}

function state(status: EvidenceStatus, candidateSha: string, checkedAt: string, reason?: string) {
  return {
    status,
    candidateSha,
    checkedAt,
    ...(reason ? { reason: reason.slice(0, 1024) } : {})
  };
}

function normalizeChecks(
  source: readonly ProviderCheck[],
  candidateSha: string,
  policy: ReviewPolicyConfig
): { required: ReviewCheck[]; optional: ReviewCheck[] } {
  const byName = new Map<string, ProviderCheck>();
  for (const check of source) {
    if (check.candidateSha.toLowerCase() !== candidateSha.toLowerCase()) continue;
    byName.set(check.name, check);
  }
  const convert = (name: string, required: boolean): ReviewCheck => {
    const check = byName.get(name);
    if (!check) return reviewCheckSchema.parse({ name, status: "unknown", candidateSha, required, optional: !required, details: "check not reported for candidate SHA" });
    return reviewCheckSchema.parse({
      name: check.name,
      status: check.status,
      candidateSha,
      required,
      optional: !required,
      ...(check.conclusion ? { conclusion: check.conclusion } : {}),
      ...(check.details ? { details: check.details.slice(0, 1024) } : {})
    });
  };
  return {
    required: policy.requiredChecks.map(name => convert(name, true)),
    optional: policy.optionalChecks.map(name => convert(name, false))
  };
}

function evaluateChecks(required: readonly ReviewCheck[], optional: readonly ReviewCheck[]): { status: EvidenceStatus; reason?: string } {
  if (required.length === 0) return { status: "not-required" };
  const failed = required.filter(check => ["failed", "cancelled"].includes(check.status));
  if (failed.length > 0) return { status: "fail", reason: failed.map(check => check.name).join(", ") };
  const missing = required.filter(check => ["pending", "unknown"].includes(check.status));
  if (missing.length > 0) return { status: missing.some(check => check.status === "unknown") ? "missing" : "pending", reason: missing.map(check => check.name).join(", ") };
  const inconclusive = required.filter(check => check.status !== "passed");
  if (inconclusive.length > 0) return { status: "inconclusive", reason: inconclusive.map(check => `${check.name}:${check.status}`).join(", ") };
  return { status: "pass" };
}

function evaluateReviews(reviews: readonly ProviderReview[], policy: ReviewPolicyConfig): {
  status: EvidenceStatus;
  reason?: string;
  approvals: number;
  humanApprovals: number;
  botApprovals: number;
  changesRequested: boolean;
  humanReviewRequired: boolean;
} {
  const latest = new Map<string, ProviderReview>();
  for (const review of reviews) {
    const existing = latest.get(review.login);
    if (!existing || review.id > existing.id) latest.set(review.login, review);
  }
  const values = Array.from(latest.values());
  const trusted = new Set(policy.trustedReviewers.map(login => login.toLowerCase()));
  const isTrusted = (login: string) => trusted.size === 0 || trusted.has(login.toLowerCase());
  // A bot, organization, or unknown account may report a review state, but
  // only a trusted human CHANGES_REQUESTED review is authoritative for the
  // human gate. This keeps automated review evidence informative without
  // allowing an untrusted actor to change the merge decision. A subsequent
  // ordinary comment is not reviewer confirmation: a request remains active
  // until that same trusted human approves or explicitly dismisses it.
  const changesRequested = Array.from(new Set(reviews
    .filter(review => review.userType === "User" && isTrusted(review.login))
    .map(review => review.login.toLowerCase())))
    .some(login => {
      const history = reviews
        .filter(review => review.userType === "User" && review.login.toLowerCase() === login && isTrusted(review.login))
        .sort((left, right) => left.id - right.id);
      const lastRequested = history.filter(review => review.state === "changes-requested").at(-1);
      if (!lastRequested) return false;
      const lastResolution = history
        .filter(review => review.state === "approved" || review.state === "dismissed")
        .at(-1);
      return !lastResolution || lastResolution.id < lastRequested.id;
    });
  const humanApprovals = values.filter(review => review.state === "approved" && review.userType === "User" && isTrusted(review.login)).length;
  const botApprovals = values.filter(review => review.state === "approved" && review.userType !== "User").length;
  const approvals = values.filter(review => review.state === "approved").length;
  const minimum = Math.max(policy.requiredApprovingReviews, policy.requireHumanReview ? 1 : 0);
  const humanReviewRequired = minimum > 0;
  if (changesRequested) return { status: "fail", reason: "reviewer requested changes", approvals, humanApprovals, botApprovals, changesRequested, humanReviewRequired };
  if (!humanReviewRequired) return { status: "not-required", approvals, humanApprovals, botApprovals, changesRequested, humanReviewRequired };
  if (humanApprovals < minimum) return { status: "missing", reason: `requires ${minimum} trusted human approval(s)`, approvals, humanApprovals, botApprovals, changesRequested, humanReviewRequired };
  return { status: "pass", approvals, humanApprovals, botApprovals, changesRequested, humanReviewRequired };
}

function evaluateHardware(required: boolean, supplied: HardwareEvidence | undefined, candidateSha: string, now: string): { state: ReturnType<typeof state>; evidence?: HardwareEvidence } {
  if (!required) return { state: state("not-required", candidateSha, now) };
  if (!supplied) return { state: state("missing", candidateSha, now, "hardware evidence is required but was not supplied") };
  const parsed = hardwareEvidenceSchema.safeParse(supplied);
  if (!parsed.success) throw new DebugMcpError("HardwareEvidenceInvalid", "Hardware evidence does not match the bounded evidence schema", { candidateSha });
  if (parsed.data.candidateSha.toLowerCase() !== candidateSha.toLowerCase()) return { state: state("stale", candidateSha, now, "hardware evidence is bound to a different candidate SHA") };
  return {
    state: state(parsed.data.verdict === "passed" ? "pass" : parsed.data.verdict === "failed" ? "fail" : "inconclusive", candidateSha, now, parsed.data.verdict === "passed" ? undefined : `hardware verdict: ${parsed.data.verdict}`),
    evidence: parsed.data
  };
}
