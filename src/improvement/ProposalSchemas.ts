import { z } from "zod";
import { ANALYTICS_WINDOWS } from "../analytics/OutcomeSchemas.js";

export const PROPOSAL_STATUSES = [
  "draft",
  "ready-for-review",
  "approved",
  "rejected",
  "deferred",
  "implementing",
  "validated",
  "failed",
  "superseded"
] as const;

export const PROPOSAL_CATEGORIES = [
  "workflow",
  "tool-surface",
  "capability",
  "skill",
  "diagnostics",
  "performance",
  "reliability",
  "documentation",
  "test-coverage"
] as const;

export const PROPOSAL_ROOT_CAUSES = [
  "likely-mcp-deficiency",
  "likely-firmware-deficiency",
  "environment-issue",
  "insufficient-evidence"
] as const;

export const PROPOSAL_CHANGE_KINDS = [
  "workflow-gap",
  "surface-promotion",
  "surface-demotion",
  "capability-review",
  "skill-routing",
  "error-guidance",
  "test-coverage",
  "performance"
] as const;

export const PROPOSAL_RISK_LEVELS = ["low", "medium", "high"] as const;
export const PROPOSAL_CHANGE_SCOPES = ["small", "medium", "large"] as const;
export const PROPOSAL_IMPLEMENTATION_MODES = ["auto-eligible", "manual-only"] as const;
export const PROPOSAL_PRIORITIES = ["P0", "P1", "P2", "P3"] as const;
export const PROPOSAL_VALIDATION_VERDICTS = ["improved", "neutral", "regressed", "inconclusive"] as const;
export const PROPOSAL_REVIEW_DECISIONS = ["approve", "reject", "defer"] as const;

const boundedText = (max: number) => z.string().trim().min(1).max(max);
const boundedName = z.string().regex(/^[A-Za-z0-9._:/-]{1,192}$/);

export const proposalEvidenceSchema = z.object({
  matchingRuns: z.number().int().nonnegative(),
  affectedRuns: z.number().int().nonnegative(),
  successAfterEscalation: z.number().int().nonnegative(),
  failureAfterEscalation: z.number().int().nonnegative(),
  sampleWindow: z.enum(ANALYTICS_WINDOWS),
  patternRatio: z.number().finite().min(0).max(1),
  failureRate: z.number().finite().min(0).max(1),
  sufficient: z.boolean(),
  minimumMatchingRuns: z.number().int().positive(),
  minimumPatternRatio: z.number().finite().min(0).max(1),
  supportingTools: z.array(boundedName).max(64).default([]),
  supportingCapabilities: z.array(boundedName).max(16).default([]),
  context: z.record(boundedText(256)).default({}),
  rootCause: z.enum(PROPOSAL_ROOT_CAUSES),
  rootCauseReason: boundedText(1024),
  schemaCostBytes: z.number().int().nonnegative().optional(),
  observedAt: z.string().datetime().optional()
});

export const proposedChangeSchema = z.object({
  kind: z.enum(PROPOSAL_CHANGE_KINDS),
  target: boundedName,
  description: boundedText(2048),
  allowedAreas: z.array(boundedText(256)).min(1).max(32),
  forbiddenAreas: z.array(boundedText(256)).max(32),
  changeScope: z.enum(PROPOSAL_CHANGE_SCOPES),
  implementationMode: z.enum(PROPOSAL_IMPLEMENTATION_MODES),
  fromExposure: z.string().max(32).optional(),
  toExposure: z.string().max(32).optional(),
  suggestedTools: z.array(boundedName).max(64).default([])
});

export const expectedBenefitSchema = z.object({
  summary: boundedText(1024),
  metrics: z.array(z.object({
    name: boundedName,
    direction: z.enum(["increase", "decrease", "preserve"]),
    rationale: boundedText(512)
  })).min(1).max(16)
});

export const proposalRiskSchema = z.object({
  level: z.enum(PROPOSAL_RISK_LEVELS),
  description: boundedText(1024),
  mitigation: boundedText(1024)
});

export const validationPlanSchema = z.object({
  existingTests: z.array(boundedText(256)).max(64),
  newRegressionTestRequired: z.boolean(),
  mockValidation: z.boolean(),
  hardwareRequired: z.boolean(),
  replayFixtures: z.array(boundedText(256)).max(32).default([]),
  beforeAfterMetrics: z.array(boundedName).max(32),
  rollbackCondition: boundedText(1024),
  acceptanceCriteria: z.array(boundedText(512)).min(1).max(32)
});

export const proposalValidationResultSchema = z.object({
  baseline: z.string().regex(/^[0-9a-f]{7,64}$/i).optional(),
  candidate: z.string().regex(/^[0-9a-f]{7,64}$/i).optional(),
  implementationComplete: z.boolean().default(false),
  tests: z.array(z.object({
    name: boundedText(256),
    status: z.enum(["passed", "failed", "not-run"]),
    durationMs: z.number().int().nonnegative().optional()
  })).min(1).max(128),
  regressions: z.array(boundedText(1024)).max(64),
  metricDelta: z.record(z.number().finite()).default({}),
  safetyChecks: z.array(z.object({ name: boundedName, passed: z.boolean(), details: boundedText(1024) })).min(1).max(64),
  verdict: z.enum(PROPOSAL_VALIDATION_VERDICTS),
  generatedAt: z.string().datetime()
});

export const improvementProposalSchema = z.object({
  proposalId: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/),
  fingerprint: z.string().regex(/^[0-9a-f]{16,64}$/i),
  status: z.enum(PROPOSAL_STATUSES),
  category: z.enum(PROPOSAL_CATEGORIES),
  target: boundedName,
  title: boundedText(256),
  summary: boundedText(2048),
  evidence: proposalEvidenceSchema,
  proposedChange: proposedChangeSchema,
  expectedBenefit: expectedBenefitSchema,
  risks: z.array(proposalRiskSchema).min(1).max(16),
  validationPlan: validationPlanSchema,
  validationResult: proposalValidationResultSchema.optional(),
  confidence: z.number().finite().min(0).max(1),
  priority: z.enum(PROPOSAL_PRIORITIES),
  generatedBy: z.enum(["static-rule", "analytics-pattern", "static-and-analytics"]),
  sourceWindow: z.enum(ANALYTICS_WINDOWS),
  baselineSha: z.string().regex(/^[0-9a-f]{7,64}$/i).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  lastObservedAt: z.string().datetime(),
  reviewReason: z.string().trim().max(2048).optional(),
  reviewedAt: z.string().datetime().optional(),
  reviewedBy: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/).optional()
});

export type ProposalStatus = typeof PROPOSAL_STATUSES[number];
export type ProposalCategory = typeof PROPOSAL_CATEGORIES[number];
export type ProposalRootCause = typeof PROPOSAL_ROOT_CAUSES[number];
export type ProposalChangeKind = typeof PROPOSAL_CHANGE_KINDS[number];
export type ProposalRiskLevel = typeof PROPOSAL_RISK_LEVELS[number];
export type ProposalChangeScope = typeof PROPOSAL_CHANGE_SCOPES[number];
export type ProposalImplementationMode = typeof PROPOSAL_IMPLEMENTATION_MODES[number];
export type ProposalPriority = typeof PROPOSAL_PRIORITIES[number];
export type ProposalValidationVerdict = typeof PROPOSAL_VALIDATION_VERDICTS[number];
export type ProposalReviewDecision = typeof PROPOSAL_REVIEW_DECISIONS[number];
export type ProposalEvidence = z.infer<typeof proposalEvidenceSchema>;
export type ProposedChange = z.infer<typeof proposedChangeSchema>;
export type ExpectedBenefit = z.infer<typeof expectedBenefitSchema>;
export type ProposalRisk = z.infer<typeof proposalRiskSchema>;
export type ValidationPlan = z.infer<typeof validationPlanSchema>;
export type ImprovementProposal = z.infer<typeof improvementProposalSchema>;
export type ProposalValidationResult = z.infer<typeof proposalValidationResultSchema>;

export interface ProposalSummary {
  proposalId: string;
  status: ProposalStatus;
  category: ProposalCategory;
  target: string;
  title: string;
  summary: string;
  confidence: number;
  priority: ProposalPriority;
  rootCause: ProposalRootCause;
  evidence: Pick<ProposalEvidence, "matchingRuns" | "affectedRuns" | "successAfterEscalation" | "failureAfterEscalation" | "sampleWindow" | "sufficient">;
  implementationMode: ProposalImplementationMode;
  validationVerdict?: ProposalValidationVerdict;
  mergeCandidate: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Detector output before ProposalPolicy applies evidence and safety gates. */
export interface ProposalFinding {
  detector: string;
  fingerprint: string;
  category: ProposalCategory;
  target: string;
  title: string;
  summary: string;
  evidence: ProposalEvidence;
  proposedChange: ProposedChange;
  expectedBenefit: ExpectedBenefit;
  risks: ProposalRisk[];
  validationPlan: ValidationPlan;
  confidence: number;
  generatedBy: "static-rule" | "analytics-pattern" | "static-and-analytics";
  priority?: ProposalPriority;
}
