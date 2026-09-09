import { z } from "zod";
import { canHealthPolicySchema, testArtifactsSchema, testPlanSchema } from "../jobs/TestPlanSchema.js";
import { canAcceptanceProfileSchema } from "../can/CanProfileSchema.js";
import { HYBRID30K_DK9_OWNER_FIRST_STARTUP, IPC_STARTUP_PRESET_NAMES } from "../workflows/startupProfiles.js";
import { allowDestructiveFlashReloadSchema } from "../contracts/FlashReloadContract.js";
import { buildVerificationInputSchema } from "../verification/build/BuildSchemas.js";
import { mapVerificationInputSchema } from "../verification/map/MapSchemas.js";
import { regressionPlanSchema } from "../verification/regression/RegressionSchemas.js";
import { reviewVerificationInputSchema } from "../verification/review/ReviewSchemas.js";
import { engineeringVerificationInputSchema } from "../verification/VerificationService.js";
import { TOOL_CAPABILITY_NAMES } from "./capabilities.js";
import { ANALYTICS_WINDOWS, OUTCOME_FAILURE_CLASSES } from "../analytics/OutcomeSchemas.js";
import {
  PROPOSAL_CATEGORIES,
  PROPOSAL_STATUSES,
  PROPOSAL_REVIEW_DECISIONS
} from "../improvement/ProposalSchemas.js";
import { IMPLEMENTATION_RUN_STATUSES } from "../improvement/implementation/ImplementationSchemas.js";
import { hardwareEvidenceSchema } from "../improvement/review/ReviewSchemas.js";
import {
  REVIEW_FEEDBACK_CLASSES,
  REVIEW_FEEDBACK_STATUSES,
  REVISION_PROPOSAL_STATUSES,
  revisionProposalReviewDecisionSchema
} from "../improvement/revision/RevisionSchemas.js";
import {
  POST_MERGE_EVALUATION_STATUSES,
  POST_MERGE_VERDICTS,
  ROLLBACK_RECOMMENDATION_STATUSES
} from "../improvement/evaluation/EvaluationSchemas.js";

const resetTypeSchema = z.enum(["cpu", "system", "restart", "default"]);
const ipcLoadSequenceSchema = z.object({
  mode: z.enum(["cpu1-then-cpu2", "cpu1-run-before-cpu2"]).default("cpu1-then-cpu2"),
  cpu1SettleMs: z.number().int().nonnegative().default(250)
});
const ipcRunSequenceSchema = z.object({
  runMode: z.enum(["cpu1_boots_cpu2", "debugger_runs_both", "cpu2_pre_running"]).optional(),
  runCpu1First: z.boolean().optional(),
  runCpu2: z.boolean().optional(),
  settleMs: z.number().int().nonnegative().default(0),
  /** Disconnect CPU2 while CPU1 performs the firmware-owned boot handoff. */
  releaseCpu2BeforeCpu1: z.boolean().optional()
}).superRefine((sequence, context) => {
  if (!sequence.runMode) return;
  const expected = {
    cpu1_boots_cpu2: { runCpu1First: true, runCpu2: false },
    debugger_runs_both: { runCpu1First: true, runCpu2: true },
    cpu2_pre_running: { runCpu1First: false, runCpu2: true }
  }[sequence.runMode];
  if (sequence.runCpu1First !== undefined && sequence.runCpu1First !== expected.runCpu1First) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["runCpu1First"], message: `runMode ${sequence.runMode} requires runCpu1First=${expected.runCpu1First}` });
  }
  if (sequence.runCpu2 !== undefined && sequence.runCpu2 !== expected.runCpu2) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["runCpu2"], message: `runMode ${sequence.runMode} requires runCpu2=${expected.runCpu2}` });
  }
}).transform(sequence => ({
  ...sequence,
  runCpu1First: sequence.runCpu1First ?? (sequence.runMode !== "cpu2_pre_running"),
  runCpu2: sequence.runCpu2 ?? (sequence.runMode !== "cpu1_boots_cpu2")
}));

export const coreConfigSchema = z.object({
  coreId: z.number().int(),
  coreName: z.string().min(1),
  corePattern: z.string().min(1).optional().describe("Exact CCS core selector; prefer C28xx_CPU1 or C28xx_CPU2 instead of a regular expression")
});

export const createDebugSessionSchema = z.object({
  sessionName: z.string().min(1).optional(),
  ccxmlPath: z.string().min(1).optional(),
  coreMap: z.array(coreConfigSchema).min(1).optional(),
  /** Optional routing hint for c2000-debugd; existing interactive calls remain unchanged. */
  boardId: z.string().min(1).optional(),
  probeId: z.string().min(1).optional(),
  preferredProbeIds: z.array(z.string().min(1)).min(1).optional(),
  allowAutoProbeAllocation: z.boolean().default(false)
});

export const hardwarePreflightSchema = z.object({
  ccsInstallPath: z.string().min(1).optional()
});

export const acceptanceProgramDiscoverySchema = z.object({
  cpu1Program: z.string().min(1).optional(),
  cpu2Program: z.string().min(1).optional(),
  searchRoots: z.array(z.string().min(1)).optional(),
  maxDepth: z.number().int().nonnegative().optional()
});

export const acceptanceReadinessSchema = z.object({
  ccsInstallPath: z.string().min(1).optional(),
  ccxmlPath: z.string().min(1).optional(),
  cpu1Program: z.string().min(1).optional(),
  cpu2Program: z.string().min(1).optional(),
  searchRoots: z.array(z.string().min(1)).optional(),
  maxDepth: z.number().int().nonnegative().optional(),
  allowExistingDebugProcesses: z.boolean().optional(),
  waitForProbeMs: z.number().int().nonnegative().default(0),
  probePollIntervalMs: z.number().int().positive().default(250)
});

export const ramOwnershipMapSchema = z.object({
  coreId: z.number().int(),
  coreName: z.string().min(1).optional(),
  mapPath: z.string().min(1)
});

export const ramOwnershipAnalysisSchema = z.object({
  maps: z.array(ramOwnershipMapSchema).min(1)
});

export const toolContractsSchema = z.object({});

/** Capability controls are intentionally string-validated in the handler so unknown values return a structured MCP error. */
export const listCapabilitiesSchema = z.object({});
export const openCapabilitySessionSchema = z.object({
  capability: z.string().min(1).describe(`Capability group. Known values: ${TOOL_CAPABILITY_NAMES.join(", ")}`),
  reason: z.string().trim().min(1),
  ttlSeconds: z.number().int().optional().describe("Temporary exposure lifetime in seconds; defaults to 900 and cannot exceed 1800."),
  openedFrom: z.object({
    workflow: z.string().trim().min(1).max(128).optional(),
    failureClass: z.enum(OUTCOME_FAILURE_CLASSES).optional(),
    jobId: z.string().trim().min(1).max(128).optional()
  }).optional(),
  recommendationId: z.string().trim().min(1).max(128).optional()
});
export const closeCapabilitySessionSchema = z.object({
  sessionId: z.string().min(1),
  outcome: z.enum(["resolved", "not-resolved", "abandoned", "unknown"]).optional()
});

export const getWorkflowAnalyticsSchema = z.object({
  window: z.enum(ANALYTICS_WINDOWS).default("7d"),
  workflow: z.string().trim().min(1).max(128).optional()
});

export const getToolAnalyticsSchema = z.object({
  window: z.enum(ANALYTICS_WINDOWS).default("7d"),
  tool: z.string().trim().min(1).max(128).optional(),
  family: z.string().trim().min(1).max(64).optional(),
  role: z.string().trim().min(1).max(32).optional(),
  exposure: z.string().trim().min(1).max(32).optional(),
  capability: z.enum(TOOL_CAPABILITY_NAMES).optional()
});

export const getCapabilityAnalyticsSchema = z.object({
  window: z.enum(ANALYTICS_WINDOWS).default("7d"),
  capability: z.enum(TOOL_CAPABILITY_NAMES).optional()
});

export const getEscalationRecommendationsSchema = z.object({
  workflow: z.string().trim().min(1).max(128).optional(),
  stage: z.string().trim().min(1).max(96).optional(),
  errorCode: z.string().trim().min(1).max(128).optional(),
  failureClass: z.enum(OUTCOME_FAILURE_CLASSES).optional(),
  jobId: z.string().trim().min(1).max(128).optional(),
  boardId: z.string().trim().min(1).max(128).optional()
});

export const generateImprovementProposalsSchema = z.object({
  window: z.enum(ANALYTICS_WINDOWS).default("30d"),
  baselineSha: z.string().regex(/^[0-9a-f]{7,64}$/i).optional()
});

export const listImprovementProposalsSchema = z.object({
  status: z.enum(PROPOSAL_STATUSES).optional(),
  category: z.enum(PROPOSAL_CATEGORIES).optional(),
  target: z.string().trim().min(1).max(192).optional(),
  minConfidence: z.number().finite().min(0).max(1).optional(),
  limit: z.number().int().positive().max(500).default(100)
});

export const getImprovementProposalSchema = z.object({
  proposalId: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/)
});

export const reviewImprovementProposalSchema = z.object({
  proposalId: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/),
  decision: z.enum(PROPOSAL_REVIEW_DECISIONS),
  reviewReason: z.string().trim().min(1).max(2048),
  reviewer: z.string().trim().regex(/^[A-Za-z0-9._:-]{1,128}$/).optional()
});

export const exportImprovementImplementationPromptSchema = z.object({
  proposalId: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/)
});

export const startImprovementImplementationSchema = z.object({
  proposalId: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/).optional(),
  revisionProposalId: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/).optional()
}).refine(value => [value.proposalId, value.revisionProposalId].filter(item => item !== undefined).length === 1, {
  message: "Exactly one proposalId or revisionProposalId is required"
});

export const getImprovementImplementationRunSchema = z.object({
  runId: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/)
});

export const listImprovementImplementationRunsSchema = z.object({
  proposalId: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/).optional(),
  status: z.enum(IMPLEMENTATION_RUN_STATUSES).optional(),
  limit: z.number().int().positive().max(500).default(100)
});

export const getImprovementCandidateSchema = z.object({
  runId: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/)
});

export const cleanupImprovementRunSchema = z.object({
  runId: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/)
});

export const publishImprovementCandidateSchema = z.object({
  implementationRunId: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/)
});

const improvementPullRequestSelectorObject = z.object({
  implementationRunId: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/).optional(),
  pullRequestId: z.string().trim().min(1).max(256).optional(),
  pullRequestNumber: z.number().int().positive().optional()
});

const requireOnePullRequestSelector = <T extends { implementationRunId?: string; pullRequestId?: string; pullRequestNumber?: number }>(value: T) => [value.implementationRunId, value.pullRequestId, value.pullRequestNumber].filter(item => item !== undefined).length === 1;

export const getImprovementPullRequestSchema = improvementPullRequestSelectorObject.refine(requireOnePullRequestSelector, {
  message: "Exactly one implementationRunId, pullRequestId, or pullRequestNumber is required"
});
export const refreshImprovementReviewEvidenceSchema = improvementPullRequestSelectorObject.extend({
  hardwareEvidence: hardwareEvidenceSchema.optional()
}).refine(requireOnePullRequestSelector, {
  message: "Exactly one implementationRunId, pullRequestId, or pullRequestNumber is required"
});
export const getMergeRecommendationSchema = improvementPullRequestSelectorObject.refine(requireOnePullRequestSelector, {
  message: "Exactly one implementationRunId, pullRequestId, or pullRequestNumber is required"
});

export const refreshReviewFeedbackSchema = improvementPullRequestSelectorObject.refine(requireOnePullRequestSelector, {
  message: "Exactly one implementationRunId, pullRequestId, or pullRequestNumber is required"
});

export const listReviewFeedbackSchema = improvementPullRequestSelectorObject.extend({
  status: z.enum(REVIEW_FEEDBACK_STATUSES).optional(),
  classification: z.enum(REVIEW_FEEDBACK_CLASSES).optional(),
  limit: z.number().int().positive().max(500).default(100)
});

export const listRevisionProposalsSchema = z.object({
  originalProposalId: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/).optional(),
  pullRequestId: z.string().trim().min(1).max(256).optional(),
  pullRequestNumber: z.number().int().positive().optional(),
  status: z.enum(REVISION_PROPOSAL_STATUSES).optional(),
  limit: z.number().int().positive().max(500).default(100),
  /** Explicitly ask the service to classify current feedback into proposals before listing. */
  generate: z.boolean().default(false)
}).superRefine((value, context) => {
  if (!value.generate) return;
  const selectorCount = [value.originalProposalId, value.pullRequestId, value.pullRequestNumber].filter(item => item !== undefined).length;
  if (selectorCount !== 1) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["generate"],
      message: "generate=true requires exactly one originalProposalId, pullRequestId, or pullRequestNumber"
    });
  }
});

export const reviewRevisionProposalSchema = z.object({
  revisionProposalId: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/),
  decision: revisionProposalReviewDecisionSchema,
  reviewReason: z.string().trim().min(1).max(2048),
  reviewer: z.string().trim().regex(/^[A-Za-z0-9._:-]{1,128}$/).optional()
});

export const publishRevisionCandidateSchema = z.object({
  revisionProposalId: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/)
});

export const listPostMergeEvaluationsSchema = z.object({
  proposalId: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/).optional(),
  lifecycleStatus: z.enum(POST_MERGE_EVALUATION_STATUSES).optional(),
  verdict: z.enum(POST_MERGE_VERDICTS).optional(),
  limit: z.number().int().positive().max(500).default(100)
});

export const getPostMergeEvaluationSchema = z.object({
  evaluationId: z.string().regex(/^[A-Za-z0-9._:-]{8,256}$/)
});

export const refreshPostMergeEvaluationSchema = z.object({
  evaluationId: z.string().regex(/^[A-Za-z0-9._:-]{8,256}$/),
  finalize: z.boolean().default(false)
});

export const getRollbackRecommendationSchema = z.object({
  recommendationId: z.string().regex(/^[A-Za-z0-9._:-]{8,256}$/).optional(),
  evaluationId: z.string().regex(/^[A-Za-z0-9._:-]{8,256}$/).optional()
}).refine(value => Boolean(value.recommendationId) !== Boolean(value.evaluationId), {
  message: "Exactly one recommendationId or evaluationId is required"
});

export const reviewRollbackRecommendationSchema = z.object({
  recommendationId: z.string().regex(/^[A-Za-z0-9._:-]{8,256}$/),
  action: z.enum(["acknowledge", "reject", "convert-to-proposal", "resolve"]),
  reason: z.string().trim().min(1).max(2048),
  reviewer: z.string().trim().regex(/^[A-Za-z0-9._:-]{1,128}$/).optional()
});

export const verifyBuildSchema = buildVerificationInputSchema;
export const verifyMapSchema = mapVerificationInputSchema;
export const verifyRegressionSchema = regressionPlanSchema;
export const verifyReviewSchema = reviewVerificationInputSchema;
export const runEngineeringVerificationSchema = engineeringVerificationInputSchema;
export const getVerificationResultSchema = z.object({
  verificationId: z.string().regex(/^[A-Za-z0-9._/-]+$/)
});

export const serverHealthSchema = z.object({});

export const environmentSchema = z.object({});

export const debugBoundarySchema = z.object({});

export const acceptanceEvidenceSchema = z.object({});

/** Read-only daemon liveness and scheduler state. */
export const daemonHealthSchema = z.object({});

export const listBoardsSchema = z.object({
  status: z.array(z.enum(["OFFLINE", "AVAILABLE", "RESERVED", "STARTING", "READY", "RUNNING", "RECOVERING", "QUARANTINED", "FAILED"])).min(1).optional(),
  tags: z.array(z.string().min(1)).min(1).optional()
});

/** Persist a serial-bound board registration and optionally start its isolated worker. */
export const registerBoardSchema = z.object({
  boardId: z.string().min(1),
  probeSerial: z.string().min(1),
  device: z.string().min(1).default("F28P65x"),
  ccxmlPath: z.string().min(1),
  tags: z.array(z.string().min(1)).default([]),
  startWorker: z.boolean().default(true)
});

/** Restart only the daemon-owned worker for a registered board. This never terminates external CCS/DSS processes. */
export const recoverBoardSchema = z.object({
  boardId: z.string().min(1),
  dryRun: z.boolean().default(true)
});

export const submitTestPlanSchema = z.object({ plan: testPlanSchema });
export const getTestRunSchema = z.object({
  jobId: z.string().min(1),
  includeSteps: z.boolean().default(true),
  includeEvents: z.boolean().default(false),
  waitForTerminalMs: z.number().int().nonnegative().max(30_000).default(0)
    .describe("Wait up to 30 seconds for a terminal status to reduce client-side polling; 0 reads immediately.")
});
export const listTestRunsSchema = z.object({ status: z.array(z.string().min(1)).min(1).optional() });
export const cancelTestRunSchema = z.object({ jobId: z.string().min(1) });
export const getTestArtifactsSchema = z.object({ jobId: z.string().min(1) });
export const createAcceptanceClosureSchema = z.object({
  jobId: z.string().min(1),
  offlineJsonPath: z.string().min(1),
  offlineCsvPath: z.string().min(1),
  offlineMarkdownPath: z.string().min(1),
  outputPath: z.string().min(1).optional()
});
export const expressionConditionSchema = z.object({
  label: z.string().min(1).optional(),
  coreId: z.number().int(),
  expression: z.string().min(1),
  expected: z.union([z.string(), z.number(), z.boolean()])
});
export const workflowRunModeSchema = z.enum(["cpu1_boots_cpu2", "debugger_runs_both", "cpu2_pre_running"]);
const programPreparationSchema = z.enum(["load", "symbols-only"]).default("load");
const preStartupSafetyGuardSchema = z.object({
  conditions: z.array(expressionConditionSchema).min(1).max(128),
  haltCoreIds: z.array(z.number().int()).min(1).max(2).default([0, 2])
}).strict().describe("For durable symbols-only IPC, evaluate after symbols load and before reset/run; a mismatch fails closed and halts the declared cores.");
const ipcArtifactHashShape = {
  cpu1OutSha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
  cpu2OutSha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
  cpu1MapSha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
  cpu2MapSha256: z.string().regex(/^[a-f0-9]{64}$/i).optional()
};
export const submitMultiBoardIpcAcceptanceSchema = z.object({
  boardIds: z.array(z.string().min(1)).min(1),
  artifacts: testArtifactsSchema,
  parallelism: z.number().int().positive().optional(),
  timeoutMs: z.number().int().positive().default(10000),
  intervalMs: z.number().int().positive().default(100),
  startupPreset: z.enum(IPC_STARTUP_PRESET_NAMES).optional(),
  resetType: resetTypeSchema.default(HYBRID30K_DK9_OWNER_FIRST_STARTUP.resetType),
  programPreparation: programPreparationSchema,
  loadPolicy: z.enum(["always", "if-changed", "verify-mcp-registry", "verify-only"]).default("always")
    .describe("verify-mcp-registry only checks artifacts previously loaded through the same MCP session; verify-only is a deprecated alias"),
  allowDestructiveFlashReload: allowDestructiveFlashReloadSchema
    .describe("Explicitly authorize repeated CPU2 Flash programming in each durable board session"),
  loadSequence: ipcLoadSequenceSchema.default(HYBRID30K_DK9_OWNER_FIRST_STARTUP.loadSequence),
  runSequence: ipcRunSequenceSchema.default(HYBRID30K_DK9_OWNER_FIRST_STARTUP.runSequence),
  runMode: workflowRunModeSchema.default("debugger_runs_both"),
  ipcReadyExpressions: z.array(expressionConditionSchema).min(1).optional(),
  verifyRuntimeRamOwnership: z.boolean().default(false),
  collectDebugBundle: z.boolean().default(true),
  failurePolicy: z.object({ continueHealthyBoards: z.boolean().default(true), quarantineFailedBoard: z.boolean().default(true) }).default({ continueHealthyBoards: true, quarantineFailedBoard: true })
});

const canArtifactSelectionShape = {
  artifacts: testArtifactsSchema.optional(),
  artifactsByBoard: z.record(testArtifactsSchema).optional(),
  artifactsByRole: z.record(testArtifactsSchema).optional()
};

/** Submit a durable two-board CAN acceptance job. Hardware mode fails closed until an adapter is installed. */
export const submitMultiBoardCanAcceptanceSchema = z.object({
  name: z.string().min(1).default("two-board-can-acceptance"),
  boardIds: z.array(z.string().min(1)).length(2).refine(ids => ids[0] !== ids[1], "boardIds must identify two distinct boards"),
  ...canArtifactSelectionShape,
  profile: canAcceptanceProfileSchema,
  failurePolicy: z.object({ continueHealthyBoards: z.boolean().default(false), quarantineFailedBoard: z.boolean().default(true), collectDebugBundle: z.boolean().default(true) }).default({ continueHealthyBoards: false, quarantineFailedBoard: true, collectDebugBundle: true })
});

export const listCanProfilesSchema = z.object({
  profileId: z.string().min(1).optional(),
  includeRetired: z.boolean().default(false)
});

export const getBoardGroupSnapshotSchema = z.object({
  groupId: z.string().min(1),
  includeBarriers: z.boolean().default(true),
  includeResults: z.boolean().default(true)
});

export const submitCanFaultCampaignSchema = z.object({
  name: z.string().min(1).default("two-board-can-fault-campaign"),
  boardIds: z.array(z.string().min(1)).length(2).refine(ids => ids[0] !== ids[1], "boardIds must identify two distinct boards"),
  ...canArtifactSelectionShape,
  profile: canAcceptanceProfileSchema,
  iterations: z.number().int().positive().max(10_000).default(1),
  failFast: z.boolean().default(false),
  health: canHealthPolicySchema,
  resetOrRejoinRequested: z.boolean().default(false),
  failurePolicy: z.object({ continueHealthyBoards: z.boolean().default(true), quarantineFailedBoard: z.boolean().default(true), collectDebugBundle: z.boolean().default(true) }).default({ continueHealthyBoards: true, quarantineFailedBoard: true, collectDebugBundle: true })
});

export const submitCanSoakTestSchema = z.object({
  name: z.string().min(1).default("two-board-can-soak"),
  boardIds: z.array(z.string().min(1)).length(2).refine(ids => ids[0] !== ids[1], "boardIds must identify two distinct boards"),
  ...canArtifactSelectionShape,
  profile: canAcceptanceProfileSchema,
  iterations: z.number().int().positive().max(10_000).default(1),
  durationMs: z.number().int().positive().max(86_400_000).optional(),
  health: canHealthPolicySchema,
  failurePolicy: z.object({ continueHealthyBoards: z.boolean().default(true), quarantineFailedBoard: z.boolean().default(true), collectDebugBundle: z.boolean().default(true) }).default({ continueHealthyBoards: true, quarantineFailedBoard: true, collectDebugBundle: true })
});

export const sessionCoreSchema = z.object({
  sessionId: z.string().min(1),
  coreId: z.number().int()
});

export const sessionSchema = z.object({
  sessionId: z.string().min(1)
});

export const multicoreSnapshotSchema = z.object({
  sessionId: z.string().min(1),
  coreIds: z.array(z.number().int()).min(1).optional()
});

export const resetCoreSchema = sessionCoreSchema.extend({
  resetType: z.enum(["cpu", "system", "restart", "default"]).default("default")
});

export const loadProgramSchema = sessionCoreSchema.extend({
  programUri: z.string().min(1),
  mapUri: z.string().min(1).optional(),
  ramOwnershipPolicy: z.enum(["require-map", "explicit-fallback", "skip"]).optional(),
  fallbackGsRegions: z.array(z.number().int().min(0).max(15)).min(1).optional(),
  loadPolicy: z.enum(["always", "if-changed", "verify-mcp-registry", "verify-only"]).default("always")
    .describe("verify-mcp-registry only checks artifacts previously loaded through the same MCP session; verify-only is a deprecated alias"),
  allowDestructiveFlashReload: allowDestructiveFlashReloadSchema
    .describe("Explicitly authorize a repeated CPU2 Flash load; otherwise MCP fails closed before CCS can erase a resident image")
});

export const loadSymbolsSchema = sessionCoreSchema.extend({
  programUri: z.string().min(1)
});

export const loadProgramsSchema = z.object({
  sessionId: z.string().min(1),
  programs: z.array(loadProgramSchema.omit({ sessionId: true })).min(1)
});

export const batchCoresSchema = z.object({
  sessionId: z.string().min(1),
  coreIds: z.array(z.number().int()).min(1)
});

export const resetCoresSchema = batchCoresSchema.extend({
  resetType: z.enum(["cpu", "system", "restart", "default"]).default("default")
});

export const evaluateManySchema = sessionCoreSchema.extend({
  expressions: z.array(z.string().min(1)).min(1)
});

export const assignExpressionSchema = sessionCoreSchema.extend({
  expression: z.string().min(1),
  value: z.union([z.string(), z.number(), z.boolean()]),
  verify: z.boolean().default(true),
  verification: z.enum(["readback", "write-only"]).optional()
    .describe("write-only is for one-shot hooks consumed by firmware immediately; it maps to verify=false")
});

const expressionAssignmentSchema = z.object({
  coreId: z.number().int(),
  expression: z.string().min(1),
  value: z.union([z.string(), z.number(), z.boolean()]),
  verify: z.boolean().default(true),
  verification: z.enum(["readback", "write-only"]).optional()
    .describe("write-only is for one-shot hooks consumed by firmware immediately; it maps to verify=false")
});

const expressionEndpointSchema = z.object({
  coreId: z.number().int(),
  expression: z.string().min(1)
});

export const expressionReadSetSchema = z.object({
  label: z.string().min(1).optional(),
  coreId: z.number().int(),
  expressions: z.array(z.string().min(1)).min(1)
});

export const pollingScheduleItemSchema = z.object({
  untilMs: z.number().int().positive().optional(),
  intervalMs: z.number().int().positive()
});

const expressionComparisonSchema = z.object({
  label: z.string().min(1).optional(),
  left: expressionEndpointSchema,
  right: expressionEndpointSchema
});

export const compareExpressionsSchema = z.object({
  sessionId: z.string().min(1),
  comparisons: z.array(expressionComparisonSchema).min(1)
});

export const assignExpressionsSchema = z.object({
  sessionId: z.string().min(1),
  assignments: z.array(expressionAssignmentSchema).min(1)
});

const faultInjectionSchema = expressionAssignmentSchema.extend({
  label: z.string().min(1).optional()
});

export const injectFaultsSchema = z.object({
  sessionId: z.string().min(1),
  faults: z.array(faultInjectionSchema).min(1)
});

export const resolveAddressSchema = sessionCoreSchema.extend({
  address: z.string().min(1)
});

export const waitUntilExpressionSchema = sessionCoreSchema.extend({
  expression: z.string().min(1),
  expected: z.union([z.string(), z.number(), z.boolean()]),
  timeoutMs: z.number().int().positive(),
  intervalMs: z.number().int().positive().default(100)
});

export const waitForExpressionSetSchema = z.object({
  sessionId: z.string().min(1),
  conditions: z.array(expressionConditionSchema).min(1),
  timeoutMs: z.number().int().positive(),
  intervalMs: z.number().int().positive().default(100)
});

export const diagnoseCpu2BootSchema = z.object({
  sessionId: z.string().min(1),
  cpu1CoreId: z.number().int(),
  cpu2CoreId: z.number().int(),
  cpu1Expressions: z.array(z.string().min(1)).optional(),
  cpu2Expressions: z.array(z.string().min(1)).optional()
});

export const diagnoseBootHandoffSchema = diagnoseCpu2BootSchema.extend({
  maps: z.array(ramOwnershipMapSchema).min(1).optional()
});

export const waitForIpcReadySchema = z.object({
  sessionId: z.string().min(1),
  cpu1CoreId: z.number().int(),
  cpu2CoreId: z.number().int(),
  timeoutMs: z.number().int().positive(),
  intervalMs: z.number().int().positive().default(100),
  conditions: z.array(expressionConditionSchema).min(1).optional()
});

export const reloadResetRunToMainSchema = sessionCoreSchema.extend({
  programUri: z.string().min(1),
  mapUri: z.string().min(1).optional(),
  ramOwnershipPolicy: z.enum(["require-map", "explicit-fallback", "skip"]).optional(),
  fallbackGsRegions: z.array(z.number().int().min(0).max(15)).min(1).optional(),
  resetType: z.enum(["cpu", "system", "restart", "default"]).default("default"),
  loadPolicy: z.enum(["always", "if-changed", "verify-mcp-registry", "verify-only"]).default("always")
    .describe("verify-mcp-registry only checks artifacts previously loaded through the same MCP session; verify-only is a deprecated alias"),
  allowDestructiveFlashReload: allowDestructiveFlashReloadSchema
    .describe("Explicitly authorize a repeated CPU2 Flash load; otherwise MCP fails closed before CCS can erase a resident image"),
  settleMs: z.number().int().nonnegative().default(250)
});

/**
 * `runMode` is the durable startup contract. The legacy booleans remain
 * accepted for compatibility, but an explicitly supplied value may not
 * contradict the selected mode. When omitted, the booleans retain their
 * historical defaults; when a mode is supplied, its implied defaults are
 * materialized so callers do not have to repeat them.
 */
export const workflowRunSequenceSchema = z.object({
  runMode: workflowRunModeSchema.optional(),
  runCpu1First: z.boolean().optional(),
  runCpu2: z.boolean().optional(),
  settleMs: z.number().int().nonnegative().default(0),
  releaseCpu2BeforeCpu1: z.boolean().optional()
}).superRefine((sequence, context) => {
  if (!sequence.runMode) return;
  const expected = {
    cpu1_boots_cpu2: { runCpu1First: true, runCpu2: false },
    debugger_runs_both: { runCpu1First: true, runCpu2: true },
    cpu2_pre_running: { runCpu1First: false, runCpu2: true }
  }[sequence.runMode];
  if (sequence.runCpu1First !== undefined && sequence.runCpu1First !== expected.runCpu1First) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["runCpu1First"], message: `runMode ${sequence.runMode} requires runCpu1First=${expected.runCpu1First}` });
  }
  if (sequence.runCpu2 !== undefined && sequence.runCpu2 !== expected.runCpu2) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["runCpu2"], message: `runMode ${sequence.runMode} requires runCpu2=${expected.runCpu2}` });
  }
}).transform(sequence => ({
  ...sequence,
  runCpu1First: sequence.runCpu1First ?? (sequence.runMode !== "cpu2_pre_running"),
  runCpu2: sequence.runCpu2 ?? (sequence.runMode !== "cpu1_boots_cpu2")
})).default({ runCpu1First: true, runCpu2: false, settleMs: 0 });

const runIpcAcceptanceObjectSchema = z.object({
  sessionId: z.string().min(1),
  device: z.string().min(1).default("F28P65x"),
  cpu1CoreId: z.number().int(),
  cpu2CoreId: z.number().int(),
  cpu1OutPath: z.string().min(1),
  cpu2OutPath: z.string().min(1),
  cpu1MapPath: z.string().min(1),
  cpu2MapPath: z.string().min(1),
  startupPreset: z.enum(IPC_STARTUP_PRESET_NAMES).optional(),
  resetType: resetTypeSchema.default("default"),
  programPreparation: programPreparationSchema.describe("Use symbols-only for an image already resident in Flash; this loads symbols but does not verify resident Flash contents."),
  ...ipcArtifactHashShape,
  loadPolicy: z.enum(["always", "if-changed", "verify-mcp-registry", "verify-only"]).default("always")
    .describe("verify-mcp-registry only checks artifacts previously loaded through the same MCP session; verify-only is a deprecated alias"),
  allowDestructiveFlashReload: allowDestructiveFlashReloadSchema
    .describe("Explicitly authorize repeated CPU2 Flash programming in this session"),
  loadSequence: ipcLoadSequenceSchema.default({ mode: "cpu1-then-cpu2", cpu1SettleMs: 250 }),
  runSequence: ipcRunSequenceSchema.default({ runCpu1First: true, runCpu2: false, settleMs: 0 }),
  preStartupSafetyGuard: preStartupSafetyGuardSchema.optional(),
  ipcReadyExpressions: z.array(expressionConditionSchema).min(1).optional(),
  timeoutMs: z.number().int().positive(),
  intervalMs: z.number().int().positive().default(100),
  pollingStrategy: z.enum(["fixed", "adaptive"]).default("adaptive"),
  pollingSchedule: z.array(pollingScheduleItemSchema).min(1).optional(),
  verifyRuntimeRamOwnership: z.boolean().default(false),
  collectDebugBundle: z.boolean().default(false),
  outputDir: z.string().min(1).optional()
});

export const runIpcAcceptanceSchema = runIpcAcceptanceObjectSchema;

export const launchAndRunIpcAcceptanceSchema = runIpcAcceptanceObjectSchema.omit({ sessionId: true, preStartupSafetyGuard: true }).extend({
  boardId: z.string().min(1).optional(),
  sessionMode: z.enum(["ephemeral", "interactive"]).default("ephemeral"),
  idleTimeoutMs: z.number().int().positive().optional(),
  sessionName: z.string().min(1).optional(),
  ccxmlPath: z.string().min(1).optional(),
  autoCloseOnComplete: z.boolean().default(false),
  autoCloseIdleTimeoutMs: z.number().int().positive().default(60000),
  cpu1CoreName: z.string().min(1).default("C28xx_CPU1"),
  cpu1CorePattern: z.string().min(1).optional().describe("Exact CCS selector for CPU1; normally C28xx_CPU1"),
  cpu2CoreName: z.string().min(1).default("C28xx_CPU2"),
  cpu2CorePattern: z.string().min(1).optional().describe("Exact CCS selector for CPU2; normally C28xx_CPU2"),
  probeId: z.string().min(1).optional(),
  preferredProbeIds: z.array(z.string().min(1)).min(1).optional(),
  allowAutoProbeAllocation: z.boolean().default(false)
});

export const runBootHandoffDiagnosisSchema = z.object({
  sessionId: z.string().min(1),
  device: z.string().min(1).default("F28P65x"),
  cpu1CoreId: z.number().int(),
  cpu2CoreId: z.number().int(),
  cpu1OutPath: z.string().min(1).optional(),
  cpu2OutPath: z.string().min(1).optional(),
  cpu1MapPath: z.string().min(1).optional(),
  cpu2MapPath: z.string().min(1).optional(),
  maps: z.array(ramOwnershipMapSchema).min(1).optional(),
  expressions: z.array(expressionConditionSchema).min(1).optional(),
  verifyRuntimeRamOwnership: z.boolean().default(false),
  expectedPostLoadHalt: z.boolean().default(false),
  outputDir: z.string().min(1).optional()
});

export const runReloadAndDiagnoseSchema = z.object({
  sessionId: z.string().min(1),
  device: z.string().min(1).default("F28P65x"),
  cpu1CoreId: z.number().int(),
  cpu2CoreId: z.number().int(),
  cpu1OutPath: z.string().min(1),
  cpu2OutPath: z.string().min(1),
  cpu1MapPath: z.string().min(1).optional(),
  cpu2MapPath: z.string().min(1).optional(),
  ramOwnershipPolicy: z.enum(["require-map", "explicit-fallback", "skip"]).default("require-map"),
  loadPolicy: z.enum(["always", "if-changed", "verify-mcp-registry", "verify-only"]).default("always")
    .describe("verify-mcp-registry only checks artifacts previously loaded through the same MCP session; verify-only is a deprecated alias"),
  allowDestructiveFlashReload: allowDestructiveFlashReloadSchema
    .describe("Explicitly authorize repeated CPU2 Flash programming in this session"),
  fallbackGsRegions: z.array(z.number().int().min(0).max(15)).min(1).optional(),
  resetType: z.enum(["cpu", "system", "restart", "default"]).default("default"),
  runCpu1: z.boolean().default(true),
  runCpu2: z.boolean().default(false),
  postLoadBoot: z.object({
    resetType: z.enum(["cpu", "system", "restart", "default"]).default("system"),
    runCpu1: z.boolean().default(true),
    cpu1SettleMs: z.number().int().nonnegative().default(250),
    runCpu2: z.boolean().default(false),
    /** Disconnect CPU2 while CPU1 performs the firmware-owned boot handoff. */
    releaseCpu2BeforeCpu1: z.boolean().optional()
  }).optional().describe("After programming and halting, reset both cores again and start them in a controlled CPU1-first order. This does not write PC or claim target Flash verification."),
  waitExpressions: z.array(expressionConditionSchema).min(1).optional(),
  timeoutMs: z.number().int().positive().optional(),
  intervalMs: z.number().int().positive().default(100),
  pollingStrategy: z.enum(["fixed", "adaptive"]).default("adaptive"),
  pollingSchedule: z.array(pollingScheduleItemSchema).min(1).optional(),
  verifyRuntimeRamOwnership: z.boolean().default(false),
  collectDebugBundle: z.boolean().default(false),
  outputDir: z.string().min(1).optional()
});

export const runFullDebugBundleSchema = z.object({
  sessionId: z.string().min(1),
  device: z.string().min(1).default("F28P65x"),
  cpu1CoreId: z.number().int(),
  cpu2CoreId: z.number().int(),
  coreIds: z.array(z.number().int()).min(1).optional(),
  cpu1OutPath: z.string().min(1).optional(),
  cpu2OutPath: z.string().min(1).optional(),
  cpu1MapPath: z.string().min(1).optional(),
  cpu2MapPath: z.string().min(1).optional(),
  maps: z.array(ramOwnershipMapSchema).min(1).optional(),
  expressions: z.array(expressionReadSetSchema).min(1).optional(),
  verifyRuntimeRamOwnership: z.boolean().default(false),
  outputDir: z.string().min(1)
});

export const verifyRunPauseIsolationSchema = z.object({
  sessionId: z.string().min(1),
  cpu1CoreId: z.number().int().default(0),
  cpu2CoreId: z.number().int().default(2),
  settleMs: z.number().int().nonnegative().default(250)
});

export const launchCoreSchema = z.object({
  coreId: z.number().int(),
  coreName: z.string().min(1),
  corePattern: z.string().min(1).optional().describe("Exact CCS core selector; prefer C28xx_CPU1 or C28xx_CPU2 instead of a regular expression"),
  programUri: z.string().min(1).optional(),
  mapUri: z.string().min(1).optional(),
  ramOwnershipPolicy: z.enum(["require-map", "explicit-fallback", "skip"]).optional(),
  fallbackGsRegions: z.array(z.number().int().min(0).max(15)).min(1).optional(),
  allowDestructiveFlashReload: allowDestructiveFlashReloadSchema
    .describe("Explicitly authorize a repeated CPU2 Flash load; otherwise MCP fails closed before CCS can erase a resident image"),
  connect: z.boolean().default(true),
  load: z.boolean().default(true),
  haltAtEntry: z.boolean().default(true)
});

export const launchMulticoreDebugSchema = z.object({
  boardId: z.string().min(1).optional(),
  sessionName: z.string().min(1).optional(),
  targetConfigurationName: z.string().min(1).optional(),
  ccxmlPath: z.string().min(1).optional(),
  autoCloseOnComplete: z.boolean().default(true),
  autoCloseIdleTimeoutMs: z.number().int().positive().default(60000),
  probeId: z.string().min(1).optional(),
  preferredProbeIds: z.array(z.string().min(1)).min(1).optional(),
  allowAutoProbeAllocation: z.boolean().default(false),
  loadPrograms: z.boolean().default(true),
  /** Explicit startup contract. A preset is resolved before any target access. */
  startupPreset: z.enum(IPC_STARTUP_PRESET_NAMES).optional(),
  resetType: resetTypeSchema.optional(),
  programDiscovery: z.object({
    enabled: z.boolean().default(false),
    cpu1Program: z.string().min(1).optional(),
    cpu2Program: z.string().min(1).optional(),
    searchRoots: z.array(z.string().min(1)).optional(),
    maxDepth: z.number().int().nonnegative().optional()
  }).optional(),
  loadSequence: z.object({
    mode: z.enum(["cpu1-then-cpu2", "cpu1-run-before-cpu2"]).default("cpu1-then-cpu2"),
    cpu1SettleMs: z.number().int().nonnegative().default(250)
  }).optional(),
  /** Recorded in effectiveStartup; launch never executes this normal run sequence. */
  runSequence: z.object({
    runMode: z.enum(["cpu1_boots_cpu2", "debugger_runs_both", "cpu2_pre_running"]).optional(),
    runCpu1First: z.boolean().default(true),
    runCpu2: z.boolean().default(true),
    settleMs: z.number().int().nonnegative().default(500),
    releaseCpu2BeforeCpu1: z.boolean().optional()
  }).optional(),
  cores: z.array(launchCoreSchema).min(1),
  postLaunchActions: z.object({
    assignExpressions: z.array(expressionAssignmentSchema).min(1).optional(),
    injectFaults: z.array(faultInjectionSchema).min(1).optional()
  }).optional(),
  postLaunchChecks: z.object({
    waitForExpressionSet: z.object({
      conditions: z.array(expressionConditionSchema).min(1),
      timeoutMs: z.number().int().positive(),
      intervalMs: z.number().int().positive().default(100)
    }).optional(),
    compareExpressions: z.array(expressionComparisonSchema).min(1).optional(),
    diagnoseCpu2Boot: z.object({
      cpu1CoreId: z.number().int(),
      cpu2CoreId: z.number().int(),
      cpu1Expressions: z.array(z.string().min(1)).optional(),
      cpu2Expressions: z.array(z.string().min(1)).optional()
    }).optional(),
    verifyRunPauseIsolation: z.object({
      cpu1CoreId: z.number().int().default(0),
      cpu2CoreId: z.number().int().default(2),
      settleMs: z.number().int().nonnegative().default(250)
    }).optional()
  }).optional()
});

const multiBoardLaunchEntrySchema = z.object({
  boardId: z.string().min(1).optional(),
  probeSerial: z.string().min(1),
  sessionName: z.string().min(1).optional(),
  targetConfigurationName: z.string().min(1).optional(),
  ccxmlPath: z.string().min(1),
  autoCloseOnComplete: z.boolean().default(true),
  autoCloseIdleTimeoutMs: z.number().int().positive().default(60000),
  cores: z.array(launchCoreSchema).min(1)
});

export const launchMultiBoardDebugSchema = z.object({
  ccsInstallPath: z.string().min(1).optional(),
  rollbackOnFailure: z.boolean().default(true),
  boards: z.array(multiBoardLaunchEntrySchema).min(1).max(8)
});

export const launchMulticoreDebugSafeSchema = launchMulticoreDebugSchema
  .omit({ postLaunchActions: true, postLaunchChecks: true })
  .extend({ postLaunchChecks: launchMulticoreDebugSchema.shape.postLaunchChecks.unwrap().omit({ verifyRunPauseIsolation: true }).optional() });

export const launchMulticoreDebugWithActionsSchema = launchMulticoreDebugSchema;
