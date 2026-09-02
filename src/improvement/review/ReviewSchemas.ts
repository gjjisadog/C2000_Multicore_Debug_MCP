import { createHash } from "node:crypto";
import { z } from "zod";

const shaSchema = z.string().regex(/^[0-9a-f]{7,64}$/i);
const boundedText = (max: number) => z.string().trim().min(1).max(max);

export const BASE_DRIFT_CLASSIFICATIONS = [
  "NO_DRIFT",
  "FAST_FORWARD_DRIFT",
  "CONFLICTING_DRIFT",
  "SIGNIFICANT_DRIFT"
] as const;
export type BaseDriftClassification = typeof BASE_DRIFT_CLASSIFICATIONS[number];

export const REVALIDATION_POLICIES = [
  "on-candidate-change",
  "on-base-change",
  "on-significant-base-change"
] as const;
export type RevalidationPolicy = typeof REVALIDATION_POLICIES[number];

export const REVIEW_CHECK_STATUSES = ["pending", "passed", "failed", "cancelled", "skipped", "neutral", "unknown"] as const;
export type ReviewCheckStatus = typeof REVIEW_CHECK_STATUSES[number];

export const REVIEW_STATES = ["approved", "changes-requested", "commented", "pending", "dismissed"] as const;
export type ReviewState = typeof REVIEW_STATES[number];

export const EVIDENCE_STATUSES = ["pass", "fail", "pending", "missing", "inconclusive", "not-required", "stale"] as const;
export type EvidenceStatus = typeof EVIDENCE_STATUSES[number];

export const PULL_REQUEST_STATUSES = [
  "preparing",
  "open",
  "checks-running",
  "review-required",
  "hardware-required",
  "merge-recommended",
  "changes-requested",
  "blocked",
  "closed",
  "merged-externally",
  "publish-failed"
] as const;
export type ImprovementPullRequestStatus = typeof PULL_REQUEST_STATUSES[number];

export const MERGE_RECOMMENDATION_VERDICTS = [
  "MERGE_RECOMMENDED",
  "DO_NOT_MERGE",
  "BLOCKED",
  "NEEDS_REVALIDATION"
] as const;
export type MergeRecommendationVerdict = typeof MERGE_RECOMMENDATION_VERDICTS[number];

export const MERGEABILITY_STATES = ["mergeable", "conflicting", "unknown"] as const;
export type MergeabilityState = typeof MERGEABILITY_STATES[number];

export const reviewPolicyConfigSchema = z.object({
  /** GitHub owner/repository expected by the configured writable remote. */
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).default("gjjisadog/C2000_Multicore_Debug_MCP"),
  remote: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/).default("github"),
  baseBranch: z.string().regex(/^[A-Za-z0-9._/-]{1,256}$/).default("master"),
  protectedBranches: z.array(z.string().regex(/^[A-Za-z0-9._/*-]{1,256}$/)).default(["master", "main", "develop", "release/*"]),
  requiredChecks: z.array(z.string().trim().min(1).max(256)).max(64).default([]),
  optionalChecks: z.array(z.string().trim().min(1).max(256)).max(64).default([]),
  requiredApprovingReviews: z.number().int().nonnegative().max(10).default(0),
  requireHumanReview: z.boolean().default(true),
  trustedReviewers: z.array(z.string().trim().min(1).max(128)).max(64).default([]),
  revalidationPolicy: z.enum(REVALIDATION_POLICIES).default("on-significant-base-change"),
  apiBaseUrl: z.string().url().default("https://api.github.com"),
  githubTokenEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/).default("C2000_MCP_GITHUB_TOKEN")
});

export type ReviewPolicyConfig = z.infer<typeof reviewPolicyConfigSchema>;

export const improvementPullRequestSchema = z.object({
  pullRequestId: boundedText(256),
  proposalId: boundedText(128),
  implementationRunId: boundedText(128),
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  branch: z.string().regex(/^(?:improve|auto-improve)\/[A-Za-z0-9._-]{1,220}$/),
  baseBranch: z.string().regex(/^[A-Za-z0-9._/-]{1,256}$/),
  candidateSha: shaSchema,
  baselineSha: shaSchema,
  number: z.number().int().positive().optional(),
  url: z.string().url().optional(),
  title: boundedText(512),
  status: z.enum(PULL_REQUEST_STATUSES),
  draft: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  originalBaseSha: shaSchema.optional(),
  currentBaseSha: shaSchema.optional(),
  currentHeadSha: shaSchema.optional(),
  mergedCommitSha: shaSchema.optional(),
  mergedAt: z.string().datetime().optional(),
  generatedBodyHash: z.string().regex(/^[0-9a-f]{64}$/i),
  humanBodyPreserved: z.boolean().default(true)
});
export type ImprovementPullRequest = z.infer<typeof improvementPullRequestSchema>;

export const reviewCheckSchema = z.object({
  name: boundedText(256),
  status: z.enum(REVIEW_CHECK_STATUSES),
  candidateSha: shaSchema,
  required: z.boolean(),
  optional: z.boolean().default(false),
  conclusion: z.string().max(128).optional(),
  details: z.string().max(1024).optional()
});
export type ReviewCheck = z.infer<typeof reviewCheckSchema>;

export const reviewActorSchema = z.object({
  login: boundedText(128),
  userType: z.enum(["User", "Bot", "Organization", "Unknown"]),
  state: z.enum(REVIEW_STATES),
  submittedAt: z.string().datetime().optional()
});
export type ReviewActor = z.infer<typeof reviewActorSchema>;

export const evidenceStateSchema = z.object({
  status: z.enum(EVIDENCE_STATUSES),
  reason: z.string().max(1024).optional(),
  candidateSha: shaSchema.optional(),
  checkedAt: z.string().datetime().optional()
});
export type EvidenceState = z.infer<typeof evidenceStateSchema>;

export const hardwareEvidenceSchema = z.object({
  candidateSha: shaSchema,
  source: z.enum(["c2000-test-job", "acceptance-job", "acceptance-closure", "failure-bundle"]),
  verdict: z.enum(["passed", "failed", "inconclusive"]),
  firmwareIdentity: boundedText(256),
  testPlan: boundedText(256),
  boardCount: z.number().int().positive().max(128),
  artifactIds: z.array(boundedText(256)).max(128),
  recordedAt: z.string().datetime(),
  details: z.record(z.union([z.string().max(1024), z.number(), z.boolean()])).optional()
});
export type HardwareEvidence = z.infer<typeof hardwareEvidenceSchema>;

export const reviewEvidenceSchema = z.object({
  evidenceId: boundedText(256),
  pullRequestId: boundedText(256),
  candidateSha: shaSchema,
  checkedAt: z.string().datetime(),
  candidate: evidenceStateSchema,
  local: evidenceStateSchema,
  ci: evidenceStateSchema.extend({
    requiredChecks: z.array(reviewCheckSchema).max(64),
    optionalChecks: z.array(reviewCheckSchema).max(64)
  }),
  reviews: evidenceStateSchema.extend({
    approvals: z.number().int().nonnegative(),
    humanApprovals: z.number().int().nonnegative(),
    botApprovals: z.number().int().nonnegative(),
    changesRequested: z.boolean(),
    humanReviewRequired: z.boolean()
  }),
  hardware: evidenceStateSchema,
  base: evidenceStateSchema.extend({
    classification: z.enum(BASE_DRIFT_CLASSIFICATIONS)
  }),
  head: evidenceStateSchema,
  mergeability: z.enum(MERGEABILITY_STATES),
  hardwareEvidence: hardwareEvidenceSchema.optional(),
  warnings: z.array(z.string().max(1024)).max(64),
  evidenceHash: z.string().regex(/^[0-9a-f]{64}$/i)
});
export type ReviewEvidence = z.infer<typeof reviewEvidenceSchema>;

export const mergeRecommendationSchema = z.object({
  recommendationId: boundedText(256),
  pullRequestId: boundedText(256),
  pullRequestNumber: z.number().int().positive().optional(),
  candidateSha: shaSchema,
  verdict: z.enum(MERGE_RECOMMENDATION_VERDICTS),
  generatedAt: z.string().datetime(),
  evidenceHash: z.string().regex(/^[0-9a-f]{64}$/i),
  evidence: z.object({
    local: evidenceStateSchema,
    ci: evidenceStateSchema,
    hardware: evidenceStateSchema,
    review: evidenceStateSchema,
    base: evidenceStateSchema,
    candidate: evidenceStateSchema,
    mergeability: z.enum(MERGEABILITY_STATES)
  }),
  blockers: z.array(z.string().max(1024)).max(64),
  warnings: z.array(z.string().max(1024)).max(64),
  rationale: z.array(z.string().max(1024)).max(64),
  humanMergeRequired: z.literal(true),
  mergeActionTaken: z.literal(false)
});
export type MergeRecommendation = z.infer<typeof mergeRecommendationSchema>;

export const candidateReviewResultSchema = z.object({
  valid: z.boolean(),
  publishAllowed: z.boolean(),
  runId: boundedText(128),
  proposalId: boundedText(128),
  branch: z.string().regex(/^(?:improve|auto-improve)\/[A-Za-z0-9._-]{1,220}$/),
  baselineSha: shaSchema,
  candidateSha: shaSchema,
  currentBaseSha: shaSchema,
  changedFiles: z.array(z.string().max(512)).max(512),
  commitCount: z.number().int().nonnegative(),
  validationPassed: z.boolean(),
  artifactsValid: z.boolean(),
  candidateReportPresent: z.boolean(),
  clean: z.boolean(),
  baseDrift: z.object({
    classification: z.enum(BASE_DRIFT_CLASSIFICATIONS),
    changedFiles: z.array(z.string().max(512)).max(512),
    significant: z.boolean(),
    revalidationRequired: z.boolean()
  }),
  issues: z.array(z.string().max(1024)).max(64),
  failureCode: z.string().max(128).optional()
});
export type CandidateReviewResult = z.infer<typeof candidateReviewResultSchema>;

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => stableStringify(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

export function sha256Json(value: unknown): string {
  return createHash("sha256").update(stableStringify(value), "utf8").digest("hex");
}
