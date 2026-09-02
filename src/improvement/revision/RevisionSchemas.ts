import { z } from "zod";
import { validationPlanSchema, type ValidationPlan } from "../ProposalSchemas.js";

const boundedText = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => z.string().trim().max(max).optional();
const shaSchema = z.string().regex(/^[0-9a-f]{7,64}$/i);
const idSchema = z.string().trim().min(1).max(256);

export const REVIEW_FEEDBACK_SOURCES = [
  "review",
  "review-comment",
  "issue-comment",
  "check-comment"
] as const;
export type ReviewFeedbackSource = typeof REVIEW_FEEDBACK_SOURCES[number];

export const REVIEW_FEEDBACK_DISPOSITIONS = [
  "comment",
  "changes-requested",
  "suggestion",
  "question"
] as const;
export type ReviewFeedbackDisposition = typeof REVIEW_FEEDBACK_DISPOSITIONS[number];

export const REVIEW_FEEDBACK_AUTHOR_TYPES = ["human", "bot", "unknown"] as const;
export type ReviewFeedbackAuthorType = typeof REVIEW_FEEDBACK_AUTHOR_TYPES[number];

export const REVIEW_FEEDBACK_CLASSES = [
  "correctness",
  "safety",
  "test-coverage",
  "architecture",
  "tool-surface",
  "capability-policy",
  "workflow",
  "error-guidance",
  "documentation",
  "performance",
  "style",
  "question",
  "non-actionable",
  "potentially-malicious"
] as const;
export type ReviewFeedbackClass = typeof REVIEW_FEEDBACK_CLASSES[number];

export const REVIEW_FEEDBACK_STATUSES = [
  "new",
  "classified",
  "actionable",
  "non-actionable",
  "superseded",
  "resolved",
  "revision-proposed",
  "revision-approved",
  "addressed-by-candidate",
  "reviewer-confirmed",
  "rejected"
] as const;
export type ReviewFeedbackStatus = typeof REVIEW_FEEDBACK_STATUSES[number];

export const improvementReviewFeedbackSchema = z.object({
  feedbackId: idSchema,
  pullRequestId: idSchema,
  pullRequestNumber: z.number().int().positive().optional(),
  reviewId: z.number().int().positive().optional(),
  threadId: optionalText(256),
  commentId: z.number().int().positive().optional(),
  author: boundedText(128),
  authorType: z.enum(REVIEW_FEEDBACK_AUTHOR_TYPES),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime().optional(),
  source: z.enum(REVIEW_FEEDBACK_SOURCES),
  disposition: z.enum(REVIEW_FEEDBACK_DISPOSITIONS),
  path: optionalText(512),
  line: z.number().int().positive().optional(),
  candidateSha: shaSchema.optional(),
  rawTextHash: z.string().regex(/^[0-9a-f]{64}$/i),
  /** Bounded and sanitized evidence only; raw GitHub text is never retained. */
  sanitizedText: z.string().max(2048).optional(),
  normalizedSummary: boundedText(1024),
  fingerprint: z.string().regex(/^[0-9a-f]{32,64}$/i),
  classification: z.enum(REVIEW_FEEDBACK_CLASSES).optional(),
  status: z.enum(REVIEW_FEEDBACK_STATUSES),
  reason: optionalText(1024),
  trustedAsInstruction: z.literal(false).default(false)
});
export type ImprovementReviewFeedback = z.infer<typeof improvementReviewFeedbackSchema>;

export const REVISION_PROPOSAL_STATUSES = [
  "draft",
  "ready-for-review",
  "approved",
  "rejected",
  "deferred",
  "implementing",
  "validation-pending",
  "validated",
  "candidate-ready",
  "superseded",
  "evidence-changed"
] as const;
export type RevisionProposalStatus = typeof REVISION_PROPOSAL_STATUSES[number];

export const REVISION_IMPLEMENTATION_MODES = ["auto-eligible", "manual-only"] as const;
export type RevisionImplementationMode = typeof REVISION_IMPLEMENTATION_MODES[number];

export const REVISION_CHANGE_KINDS = [
  "code-change",
  "test-change",
  "documentation",
  "tool-surface",
  "safety-review",
  "response-needed",
  "new-improvement-proposal"
] as const;
export type RevisionChangeKind = typeof REVISION_CHANGE_KINDS[number];

export const revisionRequestedChangeSchema = z.object({
  kind: z.enum(REVISION_CHANGE_KINDS),
  description: boundedText(2048),
  allowedAreas: z.array(boundedText(256)).max(32),
  forbiddenAreas: z.array(boundedText(256)).max(32),
  acceptanceCriteria: z.array(boundedText(512)).min(1).max(32),
  changeScope: z.enum(["small", "medium", "large"]),
  /** True when the feedback is outside the current candidate's approved scope. */
  newImprovementProposalRecommended: z.boolean().default(false)
});
export type RevisionRequestedChange = z.infer<typeof revisionRequestedChangeSchema>;

export const revisionValidationPlanSchema = validationPlanSchema.extend({
  inheritedFromOriginal: z.literal(true).default(true)
});
export type RevisionValidationPlan = z.infer<typeof revisionValidationPlanSchema>;

export const improvementRevisionProposalSchema = z.object({
  revisionProposalId: idSchema,
  fingerprint: z.string().regex(/^[0-9a-f]{32,64}$/i),
  originalProposalId: idSchema,
  implementationRunId: idSchema,
  pullRequestId: idSchema,
  pullRequestNumber: z.number().int().positive().optional(),
  baseCandidateSha: shaSchema,
  feedbackIds: z.array(idSchema).min(1).max(64),
  feedbackHashes: z.array(z.string().regex(/^[0-9a-f]{64}$/i)).min(1).max(64),
  revisionNumber: z.number().int().positive().max(64),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  status: z.enum(REVISION_PROPOSAL_STATUSES),
  category: z.enum([
    "correctness",
    "safety",
    "test-coverage",
    "architecture",
    "tool-surface",
    "capability-policy",
    "workflow",
    "error-guidance",
    "documentation",
    "performance",
    "style",
    "question",
    "non-actionable",
    "potentially-malicious"
  ]),
  title: boundedText(256),
  summary: boundedText(2048),
  requestedChange: revisionRequestedChangeSchema,
  risk: z.enum(["low", "medium", "high"]),
  validationPlan: revisionValidationPlanSchema,
  implementationMode: z.enum(REVISION_IMPLEMENTATION_MODES),
  reviewReason: optionalText(2048),
  reviewedAt: z.string().datetime().optional(),
  reviewedBy: optionalText(128),
  /** Manual response or an independent proposal is recommended; no code run may start. */
  newImprovementProposalRecommended: z.boolean().default(false),
  untrustedFeedback: z.literal(true).default(true)
}).superRefine((value, context) => {
  if (value.feedbackIds.length !== value.feedbackHashes.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["feedbackHashes"], message: "feedbackIds and feedbackHashes must have equal lengths" });
  }
  if (new Set(value.feedbackIds).size !== value.feedbackIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["feedbackIds"], message: "feedbackIds must be unique" });
  }
});
export type ImprovementRevisionProposal = z.infer<typeof improvementRevisionProposalSchema>;

export const revisionProposalReviewDecisionSchema = z.enum(["approve", "reject", "defer"]);
export type RevisionProposalReviewDecision = z.infer<typeof revisionProposalReviewDecisionSchema>;

export function isRevisionValidationPlan(value: unknown): value is RevisionValidationPlan {
  return revisionValidationPlanSchema.safeParse(value).success;
}

export function cloneValidationPlan(value: ValidationPlan): RevisionValidationPlan {
  return revisionValidationPlanSchema.parse({ ...value, inheritedFromOriginal: true });
}
