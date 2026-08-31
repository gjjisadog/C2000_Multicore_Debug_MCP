import { z } from "zod";
import { evidenceClassificationSchema } from "../artifacts/ArtifactSchemas.js";
import { verificationStatusSchema, hardGateFailureSchema } from "../verification/VerificationSchemas.js";

export const EVOLUTION_SCHEMA_VERSION = 1 as const;
const versionSchema = z.string().min(1).max(128);
const evidenceIdSchema = z.string().min(1).max(256);

export const skillEditOperationSchema = z.enum(["ADD", "DELETE", "REPLACE"]);
export const skillEditSchema = z.object({
  editId: z.string().min(1).optional(),
  operation: skillEditOperationSchema,
  section: z.string().min(1).max(256),
  content: z.string().max(64 * 1024).optional(),
  reason: z.string().min(1).max(4096),
  evidenceIds: z.array(evidenceIdSchema).min(1),
  source: z.string().min(1).optional()
}).superRefine((edit, context) => {
  if ((edit.operation === "ADD" || edit.operation === "REPLACE") && !edit.content) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["content"], message: `${edit.operation} requires content` });
  }
  if (!edit.content && edit.operation === "DELETE") return;
  if (edit.content !== undefined && edit.operation === "DELETE") {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["content"], message: "DELETE edits must not carry replacement content" });
  }
});

export const skillEditPolicySchema = z.object({
  maxAdditions: z.number().int().nonnegative().default(2),
  maxDeletions: z.number().int().nonnegative().default(1),
  maxReplacements: z.number().int().nonnegative().default(1),
  maxChangedTokens: z.number().int().nonnegative().default(200),
  allowFullRewrite: z.boolean().default(false)
});

export const skillEvolutionConfigSchema = skillEditPolicySchema.extend({
  enabled: z.boolean().default(true),
  requireValidationSet: z.boolean().default(true),
  requireHoldoutSet: z.boolean().default(false)
});

export const skillVerificationSetsSchema = z.object({
  trainingVerificationIds: z.array(evidenceIdSchema).default([]),
  validationVerificationIds: z.array(evidenceIdSchema).default([]),
  holdoutVerificationIds: z.array(evidenceIdSchema).default([])
}).superRefine((sets, context) => {
  const groups = [
    ["trainingVerificationIds", sets.trainingVerificationIds],
    ["validationVerificationIds", sets.validationVerificationIds],
    ["holdoutVerificationIds", sets.holdoutVerificationIds]
  ] as const;
  for (let left = 0; left < groups.length; left += 1) {
    for (let right = left + 1; right < groups.length; right += 1) {
      const overlap = groups[left][1].filter(id => groups[right][1].includes(id));
      if (overlap.length > 0) context.addIssue({ code: z.ZodIssueCode.custom, path: [groups[left][0]], message: `verification sets overlap: ${overlap.join(", ")}` });
    }
  }
});

/** A persisted fact about one verification run, kept separate from lessons and skill edits. */
export const experienceSchema = z.object({
  schemaVersion: z.literal(EVOLUTION_SCHEMA_VERSION),
  experienceId: evidenceIdSchema,
  verificationId: evidenceIdSchema,
  jobId: evidenceIdSchema.optional(),
  taskId: evidenceIdSchema.nullable().optional(),
  skillName: versionSchema.nullable().optional(),
  skillVersion: versionSchema.nullable().optional(),
  agent: versionSchema.nullable().optional(),
  model: versionSchema.nullable().optional(),
  commitSha: versionSchema.nullable().optional(),
  projectIdentity: versionSchema.nullable().optional(),
  status: verificationStatusSchema,
  evidenceClassification: evidenceClassificationSchema,
  summary: z.string().min(1).max(4096).optional(),
  createdAt: z.string().datetime()
});

/** A deliberately higher-level pattern backed by multiple persisted experiences. */
export const lessonSchema = z.object({
  schemaVersion: z.literal(EVOLUTION_SCHEMA_VERSION),
  lessonId: evidenceIdSchema,
  skillName: versionSchema,
  experienceIds: z.array(evidenceIdSchema).min(2),
  pattern: z.string().min(1).max(4096),
  evidenceIds: z.array(evidenceIdSchema).min(1),
  proposedEditIds: z.array(evidenceIdSchema).default([]),
  createdAt: z.string().datetime()
}).superRefine((lesson, context) => {
  if (new Set(lesson.experienceIds).size !== lesson.experienceIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["experienceIds"], message: "lesson experience ids must be unique" });
  }
  if (new Set(lesson.evidenceIds).size !== lesson.evidenceIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["evidenceIds"], message: "lesson evidence ids must be unique" });
  }
});

const candidateSkillBaseSchema = z.object({
  schemaVersion: z.literal(EVOLUTION_SCHEMA_VERSION),
  candidateSkillId: z.string().min(1),
  skillName: z.string().min(1),
  baseSkillVersion: versionSchema,
  candidateSkillVersion: versionSchema,
  edits: z.array(skillEditSchema),
  policy: skillEditPolicySchema,
  trainingVerificationIds: z.array(evidenceIdSchema).default([]),
  validationVerificationIds: z.array(evidenceIdSchema).default([]),
  holdoutVerificationIds: z.array(evidenceIdSchema).default([]),
  createdAt: z.string().datetime(),
  promoted: z.boolean().default(false)
});

export const candidateSkillSchema = candidateSkillBaseSchema.superRefine((candidate, context) => {
  const sets = skillVerificationSetsSchema.safeParse(candidate);
  if (!sets.success) {
    for (const issue of sets.error.issues) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: issue.path, message: issue.message });
    }
  }
});

export const candidateSkillInputSchema = candidateSkillBaseSchema.omit({
  schemaVersion: true,
  candidateSkillId: true,
  createdAt: true,
  promoted: true
}).extend({
  candidateSkillId: z.string().min(1).optional(),
  policy: skillEditPolicySchema.default({})
});

export const skillEvaluationResultSchema = z.object({
  schemaVersion: z.literal(EVOLUTION_SCHEMA_VERSION),
  set: z.enum(["training", "validation", "holdout"]),
  verificationIds: z.array(evidenceIdSchema).min(1),
  score: z.number().finite().nullable(),
  passed: z.boolean(),
  complete: z.boolean(),
  criticalRegressionCount: z.number().int().nonnegative(),
  hardGateFailures: z.array(hardGateFailureSchema),
  createdAt: z.string().datetime()
});

export const evolutionDecisionSchema = z.enum(["PENDING", "PROMOTABLE", "REJECTED"]);
export const evolutionRunSchema = z.object({
  schemaVersion: z.literal(EVOLUTION_SCHEMA_VERSION),
  evolutionRunId: z.string().min(1),
  skillName: z.string().min(1),
  baseSkillVersion: versionSchema,
  candidateSkillVersion: versionSchema.optional(),
  trainingVerificationIds: z.array(evidenceIdSchema),
  validationVerificationIds: z.array(evidenceIdSchema),
  holdoutVerificationIds: z.array(evidenceIdSchema).default([]),
  candidateEdits: z.array(skillEditSchema),
  baselineScore: z.number().finite(),
  candidateScore: z.number().finite().nullable(),
  hardGateFailures: z.array(hardGateFailureSchema),
  criticalRegressionCount: z.number().int().nonnegative().default(0),
  requiredHardGatesPass: z.boolean(),
  decision: evolutionDecisionSchema,
  rejectedReason: z.string().min(1).optional(),
  createdAt: z.string().datetime()
}).superRefine((run, context) => {
  const all = [...run.trainingVerificationIds, ...run.validationVerificationIds, ...run.holdoutVerificationIds];
  if (new Set(all).size !== all.length) context.addIssue({ code: z.ZodIssueCode.custom, path: ["validationVerificationIds"], message: "training, validation, and holdout verification ids must be disjoint" });
});

export const rejectedEditSchema = z.object({
  schemaVersion: z.literal(EVOLUTION_SCHEMA_VERSION),
  rejectedEditId: z.string().min(1),
  skillName: z.string().min(1),
  baseSkillVersion: versionSchema,
  candidateSkillVersion: versionSchema.optional(),
  edit: skillEditSchema,
  reason: z.string().min(1),
  baselineScore: z.number().finite().nullable(),
  candidateScore: z.number().finite().nullable(),
  validationVerificationIds: z.array(evidenceIdSchema),
  hardGateFailures: z.array(hardGateFailureSchema),
  createdAt: z.string().datetime()
});

export const rejectedEditBufferSchema = z.object({
  schemaVersion: z.literal(EVOLUTION_SCHEMA_VERSION),
  entries: z.array(rejectedEditSchema)
});

export type SkillEditOperation = z.infer<typeof skillEditOperationSchema>;
export type SkillEdit = z.infer<typeof skillEditSchema>;
export type SkillEditPolicy = z.infer<typeof skillEditPolicySchema>;
export type SkillEvolutionConfig = z.infer<typeof skillEvolutionConfigSchema>;
export type SkillVerificationSets = z.infer<typeof skillVerificationSetsSchema>;
export type Experience = z.infer<typeof experienceSchema>;
export type Lesson = z.infer<typeof lessonSchema>;
export type CandidateSkill = z.infer<typeof candidateSkillSchema>;
export type SkillEvaluationResult = z.infer<typeof skillEvaluationResultSchema>;
export type EvolutionRun = z.infer<typeof evolutionRunSchema>;
export type RejectedEdit = z.infer<typeof rejectedEditSchema>;
export type RejectedEditBuffer = z.infer<typeof rejectedEditBufferSchema>;
