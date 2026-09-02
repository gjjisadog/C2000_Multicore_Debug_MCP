import { createHash } from "node:crypto";
import { mergeRecommendationSchema, type MergeRecommendation, type ReviewEvidence } from "./ReviewSchemas.js";
import type { ImprovementPullRequest } from "./ReviewSchemas.js";
import type { ImprovementProposal } from "../ProposalSchemas.js";

export interface MergeRecommendationInput {
  pullRequest: ImprovementPullRequest;
  proposal?: ImprovementProposal;
  evidence: ReviewEvidence;
  now?: () => number;
}

/** Pure, fail-closed recommendation logic. It cannot publish or merge. */
export class MergeRecommendationService {
  evaluate(input: MergeRecommendationInput): MergeRecommendation {
    const now = new Date((input.now ?? (() => Date.now()))()).toISOString();
    const blockers: string[] = [];
    const warnings = [...input.evidence.warnings];
    const rationale: string[] = [];
    const evidence = input.evidence;
    const evidenceIdentityMatches = evidence.pullRequestId === input.pullRequest.pullRequestId
      && evidence.candidateSha.toLowerCase() === input.pullRequest.candidateSha.toLowerCase();
    if (!evidenceIdentityMatches) blockers.push("review evidence identity mismatch");
    const proposalReady = !input.proposal || ["candidate-ready", "validated", "pr-open", "merge-recommended", "closed-without-merge"].includes(input.proposal.status);
    if (!proposalReady) blockers.push(`proposal lifecycle is ${input.proposal!.status}`);
    if (input.pullRequest.status === "merged-externally") blockers.push("pull request was already merged externally");
    else if (input.pullRequest.status === "closed") blockers.push("pull request is closed");
    else if (!["open", "merge-recommended"].includes(input.pullRequest.status)) blockers.push(`pull request lifecycle is ${input.pullRequest.status}`);
    if (evidence.candidate.status !== "pass" || evidence.local.status !== "pass") blockers.push("candidate/local integrity is not passing");
    if (evidence.ci.status === "fail") blockers.push("a required CI check failed");
    else if (["pending", "missing", "inconclusive", "stale"].includes(evidence.ci.status)) blockers.push(`CI evidence is ${evidence.ci.status}`);
    if (evidence.hardware.status === "fail") blockers.push("hardware evidence failed");
    else if (["pending", "missing", "inconclusive", "stale"].includes(evidence.hardware.status)) blockers.push(`hardware evidence is ${evidence.hardware.status}`);
    if (evidence.reviews.status === "fail") blockers.push("review changes were requested");
    else if (["pending", "missing", "inconclusive", "stale"].includes(evidence.reviews.status)) blockers.push("required human review is not satisfied");
    if (evidence.base.status !== "pass") blockers.push("candidate base requires revalidation");
    if (evidence.head.status !== "pass") blockers.push("pull request head no longer matches candidate SHA");
    if (evidence.mergeability === "conflicting") blockers.push("GitHub reports a merge conflict");
    else if (evidence.mergeability === "unknown") blockers.push("GitHub mergeability is not known");
    if (input.pullRequest.draft) blockers.push("pull request is still a draft");
    if (!proposalReady) rationale.push("Proposal approval/candidate lifecycle gate is not satisfied.");
    if (input.pullRequest.draft) rationale.push("A human must explicitly mark the draft PR ready for review.");
    if (warnings.length > 0) rationale.push("Optional or informational review evidence was retained as warnings.");
    const verdict = selectVerdict(blockers, evidence);
    if (verdict === "MERGE_RECOMMENDED") rationale.push("All configured local, CI, hardware, review, base, head, and safety gates pass.");
    else if (verdict === "DO_NOT_MERGE") rationale.push("A fail-closed gate rejected this candidate; human review must not merge it.");
    else if (verdict === "NEEDS_REVALIDATION") rationale.push("Candidate or base identity changed; create a fresh validated candidate before review continues.");
    else rationale.push("Required evidence is pending, missing, or unavailable; no merge decision is recommended yet.");
    const recommendationId = `recommendation-${createHash("sha256").update(`${input.pullRequest.pullRequestId}:${input.pullRequest.candidateSha}:${evidence.evidenceHash}`).digest("hex").slice(0, 32)}`;
    return mergeRecommendationSchema.parse({
      recommendationId,
      pullRequestId: input.pullRequest.pullRequestId,
      ...(input.pullRequest.number ? { pullRequestNumber: input.pullRequest.number } : {}),
      candidateSha: input.pullRequest.candidateSha,
      verdict,
      generatedAt: now,
      evidenceHash: evidence.evidenceHash,
      evidence: {
        local: evidence.local,
        ci: evidence.ci,
        hardware: evidence.hardware,
        review: evidence.reviews,
        base: evidence.base,
        candidate: evidence.candidate,
        mergeability: evidence.mergeability
      },
      blockers,
      warnings,
      rationale,
      humanMergeRequired: true,
      mergeActionTaken: false
    });
  }
}

function selectVerdict(blockers: readonly string[], evidence: ReviewEvidence): "MERGE_RECOMMENDED" | "DO_NOT_MERGE" | "BLOCKED" | "NEEDS_REVALIDATION" {
  if (evidence.head.status === "stale" || evidence.base.status === "stale" || blockers.some(blocker => /identity mismatch/.test(blocker))) return "NEEDS_REVALIDATION";
  if (blockers.some(blocker => /failed|conflict|changes were requested|integrity|lifecycle|closed|already merged|publication failed/.test(blocker))) return "DO_NOT_MERGE";
  if (blockers.length > 0) return "BLOCKED";
  return "MERGE_RECOMMENDED";
}
