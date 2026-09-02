import { z } from "zod";
import { proposalValidationResultSchema, type ProposalValidationResult } from "../ProposalSchemas.js";

export const IMPLEMENTATION_RUN_STATUSES = [
  "created",
  "agent-running",
  "agent-complete",
  "agent-failed",
  "validating",
  "validation-pending",
  "validated",
  "candidate-ready",
  "rejected",
  "interrupted",
  "cleanup-complete"
] as const;

export type ImplementationRunStatus = typeof IMPLEMENTATION_RUN_STATUSES[number];

export const CODING_AGENT_STATUSES = ["completed", "failed", "timed-out"] as const;
export type CodingAgentStatus = typeof CODING_AGENT_STATUSES[number];

export const VALIDATION_COMMAND_STATUSES = ["passed", "failed", "not-run"] as const;
export type ValidationCommandStatus = typeof VALIDATION_COMMAND_STATUSES[number];

const shaSchema = z.string().regex(/^[0-9a-f]{7,64}$/i);
const boundedText = (max: number) => z.string().max(max);

export const gitSnapshotSchema = z.object({
  headSha: shaSchema,
  branchName: z.string().max(256).optional(),
  clean: z.boolean(),
  statusShort: z.array(boundedText(1024)).max(512),
  changedFiles: z.array(boundedText(512)).max(512),
  diffStat: boundedText(8192).optional(),
  capturedAt: z.string().datetime()
});

export type GitSnapshot = z.infer<typeof gitSnapshotSchema>;

export const implementationArtifactSchema = z.object({
  kind: z.enum([
    "prompt",
    "agent-output",
    "agent-error",
    "diff",
    "validation-summary",
    "validation-log",
    "candidate-report",
    "revision-feedback",
    "revision-prompt",
    "revision-report",
    "revision-validation-summary"
  ]),
  path: z.string().max(2048),
  sha256: z.string().regex(/^[0-9a-f]{64}$/i),
  bytes: z.number().int().nonnegative()
});

export type ImplementationArtifact = z.infer<typeof implementationArtifactSchema>;

export const codingAgentResultSchema = z.object({
  provider: z.string().trim().min(1).max(128),
  status: z.enum(CODING_AGENT_STATUSES),
  agentRunId: z.string().trim().min(1).max(256).optional(),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime(),
  exitCode: z.number().int().nullable().optional(),
  stdout: boundedText(32_768).optional(),
  stderr: boundedText(32_768).optional(),
  assumptionInvalid: z.boolean().default(false),
  summary: boundedText(2048).optional()
});

export type CodingAgentResult = z.infer<typeof codingAgentResultSchema>;

export const validationCommandResultSchema = z.object({
  name: z.string().trim().min(1).max(256),
  stage: z.string().trim().min(1).max(128),
  status: z.enum(VALIDATION_COMMAND_STATUSES),
  command: z.string().trim().min(1).max(512),
  args: z.array(boundedText(1024)).max(64),
  exitCode: z.number().int().nullable().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  baselineLog: z.string().max(2048).optional(),
  candidateLog: z.string().max(2048).optional(),
  reason: z.string().max(2048).optional()
});

export type ValidationCommandResult = z.infer<typeof validationCommandResultSchema>;

export const improvementImplementationRunSchema = z.object({
  runId: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/),
  proposalId: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/),
  runKind: z.enum(["initial", "revision"]).default("initial"),
  revisionProposalId: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/).optional(),
  parentCandidateSha: shaSchema.optional(),
  baselineSha: shaSchema,
  branchName: z.string().regex(/^(?:improve|auto-improve)\/[A-Za-z0-9._-]{1,220}$/),
  worktreePath: z.string().trim().min(1).max(2048),
  createdAt: z.string().datetime(),
  startedAt: z.string().datetime().optional(),
  finishedAt: z.string().datetime().optional(),
  status: z.enum(IMPLEMENTATION_RUN_STATUSES),
  agentAttempts: z.number().int().nonnegative().max(2).default(0),
  agentProvider: z.string().trim().min(1).max(128).optional(),
  agentRunId: z.string().trim().min(1).max(256).optional(),
  promptArtifact: implementationArtifactSchema.optional(),
  preImplementationStatus: gitSnapshotSchema,
  postImplementationStatus: gitSnapshotSchema.optional(),
  validationResult: proposalValidationResultSchema.optional(),
  validationCommands: z.array(validationCommandResultSchema).max(128).optional(),
  artifacts: z.array(implementationArtifactSchema).max(128).optional(),
  candidateCommitSha: shaSchema.optional(),
  failureReason: boundedText(4096).optional(),
  codingAgentResult: codingAgentResultSchema.optional()
}).superRefine((value, context) => {
  if (value.runKind === "revision" && !value.revisionProposalId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["revisionProposalId"], message: "Revision runs require revisionProposalId" });
  }
  if (value.runKind === "revision" && !value.parentCandidateSha) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["parentCandidateSha"], message: "Revision runs require parentCandidateSha" });
  }
  if (value.runKind === "initial" && value.revisionProposalId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["revisionProposalId"], message: "Initial runs cannot carry revisionProposalId" });
  }
});

export type ImprovementImplementationRun = z.infer<typeof improvementImplementationRunSchema>;

export type ImplementationValidationResult = ProposalValidationResult;

export interface ImplementationRunListQuery {
  proposalId?: string;
  status?: ImplementationRunStatus;
  limit?: number;
}

export function parseImplementationRun(value: unknown): ImprovementImplementationRun | undefined {
  const parsed = improvementImplementationRunSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
