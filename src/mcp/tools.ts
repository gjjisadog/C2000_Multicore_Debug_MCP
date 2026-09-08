import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { normalizeObjectSchema } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import type { z } from "zod";
import type { DebugSessionManager } from "../debug/DebugSessionManager.js";
import { DebugMcpError, toStructuredError } from "../utils/errors.js";
import {
  CAPABILITY_DESCRIPTORS,
  CapabilitySessionManager,
  type CapabilitySession,
  type CapabilitySessionContext,
  type CapabilitySessionOutcome,
  type ToolCapability
} from "./capabilities.js";
import type { Logger } from "../utils/logger.js";
import { createToolHandlers, type ToolHandlerDeps } from "./toolHandlers.js";
import { validateToolPaths, type FilesystemPolicy } from "../security/pathPolicy.js";
import type { ResolveTiEnvironmentOptions } from "../config/tiPaths.js";
import {
  exportVariableStreamSchema,
  getVariableStreamStatusSchema,
  readVariableSamplesSchema,
  startVariableStreamSchema,
  stopVariableStreamSchema
} from "../observability/VariableStreamSchemas.js";
import { dlogBufferRequestSchema } from "../observability/DlogSchemas.js";
import {
  configureEradProfileSchema,
  exportEradProfileSchema,
  getEradCapabilitiesSchema,
  readEradProfileSchema,
  startEradProfileSchema,
  stopEradProfileSchema
} from "../observability/EradSchemas.js";
import { collectFailureBundleSchema, exportTraceSchema } from "../observability/TraceSchemas.js";
import { compareRunWithBaselineSchema, createRunBaselineSchema } from "../analytics/MetricSchemas.js";
import {
  acceptanceProgramDiscoverySchema,
  acceptanceEvidenceSchema,
  acceptanceReadinessSchema,
  assignExpressionSchema,
  assignExpressionsSchema,
  batchCoresSchema,
  compareExpressionsSchema,
  createDebugSessionSchema,
  cancelTestRunSchema,
  daemonHealthSchema,
  debugBoundarySchema,
  diagnoseCpu2BootSchema,
  evaluateManySchema,
  environmentSchema,
  hardwarePreflightSchema,
  getTestArtifactsSchema,
  createAcceptanceClosureSchema,
  getTestRunSchema,
  injectFaultsSchema,
  launchAndRunIpcAcceptanceSchema,
  launchMultiBoardDebugSchema,
  listBoardsSchema,
  recoverBoardSchema,
  listTestRunsSchema,
  launchMulticoreDebugSchema,
  launchMulticoreDebugSafeSchema,
  launchMulticoreDebugWithActionsSchema,
  loadProgramsSchema,
  loadProgramSchema,
  loadSymbolsSchema,
  multicoreSnapshotSchema,
  diagnoseBootHandoffSchema,
  ramOwnershipAnalysisSchema,
  registerBoardSchema,
  reloadResetRunToMainSchema,
  resetCoresSchema,
  resetCoreSchema,
  resolveAddressSchema,
  runBootHandoffDiagnosisSchema,
  runFullDebugBundleSchema,
  runIpcAcceptanceSchema,
  runReloadAndDiagnoseSchema,
  sessionCoreSchema,
  sessionSchema,
  serverHealthSchema,
  toolContractsSchema,
  submitMultiBoardIpcAcceptanceSchema,
  submitMultiBoardCanAcceptanceSchema,
  listCanProfilesSchema,
  getBoardGroupSnapshotSchema,
  submitCanFaultCampaignSchema,
  submitCanSoakTestSchema,
  submitTestPlanSchema,
  verifyRunPauseIsolationSchema,
  waitForIpcReadySchema,
  waitForExpressionSetSchema,
  waitUntilExpressionSchema,
  verifyBuildSchema,
  verifyMapSchema,
  verifyRegressionSchema,
  verifyReviewSchema,
  runEngineeringVerificationSchema,
  getVerificationResultSchema,
  listCapabilitiesSchema,
  openCapabilitySessionSchema,
  closeCapabilitySessionSchema,
  getWorkflowAnalyticsSchema,
  getToolAnalyticsSchema,
  getCapabilityAnalyticsSchema,
  getEscalationRecommendationsSchema,
  generateImprovementProposalsSchema,
  listImprovementProposalsSchema,
  getImprovementProposalSchema,
  reviewImprovementProposalSchema,
  exportImprovementImplementationPromptSchema,
  startImprovementImplementationSchema,
  getImprovementImplementationRunSchema,
  listImprovementImplementationRunsSchema,
  getImprovementCandidateSchema,
  cleanupImprovementRunSchema,
  publishImprovementCandidateSchema,
  getImprovementPullRequestSchema,
  refreshImprovementReviewEvidenceSchema,
  getMergeRecommendationSchema,
  refreshReviewFeedbackSchema,
  listReviewFeedbackSchema,
  listRevisionProposalsSchema,
  reviewRevisionProposalSchema,
  publishRevisionCandidateSchema,
  listPostMergeEvaluationsSchema,
  getPostMergeEvaluationSchema,
  refreshPostMergeEvaluationSchema,
  getRollbackRecommendationSchema,
  reviewRollbackRecommendationSchema
} from "./toolSchemas.js";

type ZodObjectSchema = z.ZodTypeAny;
type Handler = (input: any) => Promise<Record<string, unknown>>;
type ToolInputScope = "host" | "session" | "core" | "batch" | "launch";
type ToolTargetEffect =
  | "host-read"
  | "session-read"
  | "session-lifecycle"
  | "target-read"
  | "connectivity-control"
  | "execution-control"
  | "reset-control"
  | "program-load"
  | "symbol-load"
  | "memory-write"
  | "launch-workflow"
  | "job-control"
  | "observation-control"
  | "capability-control"
  | "repository-control";

type ToolRole = "primary" | "alias" | "workflow" | "host" | "diagnostic";
type ToolFamily =
  | "host"
  | "session"
  | "connectivity"
  | "execution"
  | "reset"
  | "program"
  | "read"
  | "write"
  | "wait"
  | "diagnosis"
  | "workflow"
  | "observability"
  | "analytics"
  | "improvement"
  | "verification";

export type ToolEffect = "host-read" | "host-write" | "host-process-terminate" | "session-create" | "session-dispose" | "target-read" | "target-connect" | "target-disconnect" | "target-run" | "target-halt" | "target-reset" | "program-load" | "symbol-load" | "target-memory-write" | "ram-ownership-change" | "fault-injection" | "bundle-write" | "repository-write" | "repository-commit";
export type ToolProfile = "readonly" | "safe" | "full";
export type ToolSurfaceProfile = "agent" | "advanced" | "compatibility";
export type AgentExposure = "default" | "advanced" | "compatibility";
type ToolAnnotations = { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  schema: ZodObjectSchema;
  handlerName: keyof ReturnType<typeof createToolHandlers>;
  inputScope: ToolInputScope;
  targetEffect: ToolTargetEffect;
  role: ToolRole;
  family: ToolFamily;
  /** The intended MCP exposure tier; safety still controls whether it can register. */
  exposure: AgentExposure;
  /** Optional semantic capability grant required when this advanced tool is on agent surface. */
  capability?: ToolCapability;
  /** When role is alias, the preferred primary tool name. */
  aliasOf?: string;
  coreIdentityFields?: string[];
  responseCoreIdentityFields?: string[];
  effects: ToolEffect[];
  annotations: ToolAnnotations;
  approvalClass: "read-only" | "session-lifecycle" | "target-control" | "program-load" | "target-mutation" | "workflow-confirmation" | "repository-write" | "repository-commit";
}

export interface ToolExposureSummary {
  profile: ToolProfile;
  surface: ToolSurfaceProfile;
  registered: ToolDefinition[];
  registeredToolCount: number;
  hiddenBySafetyCount: number;
  hiddenBySurfaceCount: number;
  advancedOnlyCount: number;
  compatibilityOnlyCount: number;
  hiddenTools: string[];
  hiddenAliases: string[];
  baseVisibleToolCount: number;
  capabilityVisibleToolCount: number;
  activeCapabilities: ToolCapability[];
  activeCapabilitySessions: CapabilitySession[];
}

const singleCoreResponseIdentity = ["coreId", "coreName"] as const;
const coreOnlyResponseIdentity = ["coreId", "coreName"] as const;
const batchCoreResponseIdentity = ["results[].coreId", "results[].coreName"] as const;
const snapshotCoreResponseIdentity = ["cores[].coreId", "cores[].coreName"] as const;
const comparisonResponseIdentity = ["comparisons[].left.coreId", "comparisons[].right.coreId"] as const;
const waitSetResponseIdentity = ["conditions[].coreId"] as const;
const diagnoseCpu2BootResponseIdentity = ["cpu1.coreId", "cpu2.coreId", "snapshot.cores[].coreId"] as const;
const ramOwnershipResponseIdentity = ["maps[].coreId", "ownershipActions[].targetCoreId"] as const;
const diagnoseBootHandoffResponseIdentity = ["cpu1.coreId", "cpu2.coreId", "snapshot.cores[].coreId", "ramOwnership.maps[].coreId"] as const;
const workflowIpcAcceptanceResponseIdentity = [
  "snapshot.cores[].coreId",
  "ipcReady.conditions[].coreId",
  "diagnosis.cpu1.coreId",
  "diagnosis.cpu2.coreId",
  "diagnosis.snapshot.cores[].coreId",
  "ramOwnership.maps[].coreId"
] as const;
const launchAndRunIpcAcceptanceResponseIdentity = [
  "launch.coreMap[].coreId",
  "launch.created.cores[].coreId",
  "launch.connected.results[].coreId",
  ...workflowIpcAcceptanceResponseIdentity
] as const;
const workflowBootHandoffResponseIdentity = [
  "cpu1.coreId",
  "cpu2.coreId",
  "snapshot.cores[].coreId",
  "ramOwnership.maps[].coreId",
  "expressions[].coreId",
  "pc[].coreId"
] as const;
const workflowReloadAndDiagnoseResponseIdentity = [
  "snapshot.cores[].coreId",
  "wait.conditions[].coreId",
  "diagnosis.cpu1.coreId",
  "diagnosis.cpu2.coreId",
  "diagnosis.snapshot.cores[].coreId",
  "ramOwnership.maps[].coreId"
] as const;
const workflowFullBundleResponseIdentity = [
  "snapshot.cores[].coreId",
  "loadedPrograms[].coreId",
  "expressions[].coreId",
  "pc[].coreId",
  "ramOwnership.maps[].coreId",
  "bootHandoff.cpu1.coreId",
  "bootHandoff.cpu2.coreId"
] as const;
const runPauseAcceptanceResponseIdentity = [
  "acceptanceSummary.steps[].commandCoreId",
  "acceptanceSummary.steps[].commandCoreName"
] as const;
const launchResponseIdentity = [
  "snapshot.cores[].coreId",
  "postLaunchActions.assignExpressions.results[].coreId",
  "postLaunchActions.injectFaults.results[].coreId",
  "postLaunchChecks.waitForExpressionSet.conditions[].coreId",
  "postLaunchChecks.compareExpressions.comparisons[].left.coreId",
  "postLaunchChecks.compareExpressions.comparisons[].right.coreId",
  "postLaunchChecks.diagnoseCpu2Boot.cpu1.coreId",
  "postLaunchChecks.diagnoseCpu2Boot.cpu2.coreId",
  "postLaunchChecks.verifyRunPauseIsolation.acceptanceSummary.steps[].commandCoreId",
  "postLaunchChecks.verifyRunPauseIsolation.acceptanceSummary.steps[].commandCoreName"
] as const;
const multiBoardLaunchResponseIdentity = [
  "results[].boardId",
  "results[].probeSerial",
  "results[].sessionId",
  "results[].snapshot.cores[].coreId",
  "results[].snapshot.cores[].coreName"
] as const;

/**
 * Base entries may omit exposure only so additions fail closed to advanced.
 * decorateDefinition always emits the required, explicit ToolDefinition field.
 */
type BaseToolDefinition = Omit<ToolDefinition, "effects" | "annotations" | "approvalClass" | "exposure"> & { exposure?: AgentExposure };

/**
 * Only high-frequency task-level tools explicitly opt into the default
 * surface. Any new definition omitted from `exposure` fails closed to
 * `advanced`.
 */
const baseToolDefinitions: BaseToolDefinition[] = [
  { name: "c2000_listCapabilities", title: "List C2000 Capabilities", description: "List temporary advanced capability groups, their safety-derived availability, and active capability sessions without touching a target.", schema: listCapabilitiesSchema, handlerName: "listCapabilities", inputScope: "host", targetEffect: "capability-control", role: "host", family: "host", exposure: "default" },
  { name: "c2000_openCapabilitySession", title: "Open C2000 Capability Session", description: "Open one short-lived, reason-bound advanced capability group. This never expands the configured safety profile; only tools still allowed by safety can become visible.", schema: openCapabilitySessionSchema, handlerName: "openCapabilitySession", inputScope: "host", targetEffect: "capability-control", role: "host", family: "host", exposure: "default" },
  { name: "c2000_closeCapabilitySession", title: "Close C2000 Capability Session", description: "Close a temporary advanced capability session and remove its tools from the MCP surface.", schema: closeCapabilitySessionSchema, handlerName: "closeCapabilitySession", inputScope: "host", targetEffect: "capability-control", role: "host", family: "host", exposure: "default" },
  { name: "c2000_getEscalationRecommendations", title: "Get C2000 Escalation Recommendations", description: "Return deterministic, safety-aware next-capability recommendations for a structured workflow failure. This never opens a capability, selects full access, or changes the MCP surface.", schema: getEscalationRecommendationsSchema, handlerName: "getEscalationRecommendations", inputScope: "host", targetEffect: "host-read", role: "host", family: "analytics", exposure: "default" },
  { name: "c2000_getWorkflowAnalytics", title: "Get C2000 Workflow Analytics", description: "Advanced host-only summary of workflow success, failure, timeout, duration, stage, and failure-class outcomes over a bounded retention window. It never returns raw events or touches a target.", schema: getWorkflowAnalyticsSchema, handlerName: "getWorkflowAnalytics", inputScope: "host", targetEffect: "host-read", role: "host", family: "analytics", exposure: "advanced" },
  { name: "c2000_getCapabilityAnalytics", title: "Get C2000 Capability Analytics", description: "Advanced host-only summary of temporary capability opens, closes, expiry, use, active duration, and correlated continuation outcomes. It never returns raw events or touches a target.", schema: getCapabilityAnalyticsSchema, handlerName: "getCapabilityAnalytics", inputScope: "host", targetEffect: "host-read", role: "host", family: "analytics", exposure: "advanced" },
  { name: "c2000_getToolAnalytics", title: "Get C2000 Tool Analytics", description: "Advanced host-only summary of tool invocation outcomes grouped by tool, family, role, effects, exposure, and capability. It distinguishes invocation outcome from domain verdict and never returns raw inputs.", schema: getToolAnalyticsSchema, handlerName: "getToolAnalytics", inputScope: "host", targetEffect: "host-read", role: "host", family: "analytics", exposure: "advanced" },
  { name: "c2000_generateImprovementProposals", title: "Generate C2000 Improvement Proposals", description: "Advanced host-only governance operation: analyze bounded Outcome Analytics and persist evidence-bound improvement proposals. It never edits source code, changes the target, or approves a proposal.", schema: generateImprovementProposalsSchema, handlerName: "generateImprovementProposals", inputScope: "host", targetEffect: "job-control", role: "host", family: "improvement", exposure: "advanced" },
  { name: "c2000_listImprovementProposals", title: "List C2000 Improvement Proposals", description: "Advanced host-only summary of reviewable or explicitly filtered improvement proposals; raw Outcome Events and source code are not returned.", schema: listImprovementProposalsSchema, handlerName: "listImprovementProposals", inputScope: "host", targetEffect: "host-read", role: "host", family: "improvement", exposure: "advanced" },
  { name: "c2000_getImprovementProposal", title: "Get C2000 Improvement Proposal", description: "Advanced host-only read of one evidence-bound Proposal, including risks, validation plan, root-cause gate, and baseline binding.", schema: getImprovementProposalSchema, handlerName: "getImprovementProposal", inputScope: "host", targetEffect: "host-read", role: "host", family: "improvement", exposure: "advanced" },
  { name: "c2000_reviewImprovementProposal", title: "Review C2000 Improvement Proposal", description: "Advanced host-only human review gate. Approve, reject, or defer a Proposal; approval records intent only and never edits, commits, pushes, or merges code.", schema: reviewImprovementProposalSchema, handlerName: "reviewImprovementProposal", inputScope: "host", targetEffect: "job-control", role: "host", family: "improvement", exposure: "advanced" },
  { name: "c2000_exportImprovementImplementationPrompt", title: "Export C2000 Improvement Implementation Prompt", description: "Advanced host-only operation that emits a deterministic, baseline-bound Coding Agent prompt for an approved low-risk Proposal. It requires an isolated worktree and never executes the prompt.", schema: exportImprovementImplementationPromptSchema, handlerName: "exportImprovementImplementationPrompt", inputScope: "host", targetEffect: "job-control", role: "host", family: "improvement", exposure: "advanced" },
  { name: "c2000_startImprovementImplementation", title: "Start C2000 Improvement Implementation", description: "Advanced governance operation: start an approved Proposal in a fresh isolated worktree using the configured coding-agent provider, independently validate the candidate, and create a candidate-branch commit only when all gates pass. It never edits master, pushes, merges, or publishes.", schema: startImprovementImplementationSchema, handlerName: "startImprovementImplementation", inputScope: "host", targetEffect: "repository-control", role: "host", family: "improvement", exposure: "advanced" },
  { name: "c2000_getImprovementImplementationRun", title: "Get C2000 Improvement Implementation Run", description: "Read the durable state, isolated worktree metadata, agent result, validation stages, and artifacts for one improvement implementation run.", schema: getImprovementImplementationRunSchema, handlerName: "getImprovementImplementationRun", inputScope: "host", targetEffect: "host-read", role: "host", family: "improvement", exposure: "advanced" },
  { name: "c2000_listImprovementImplementationRuns", title: "List C2000 Improvement Implementation Runs", description: "List durable implementation attempts by Proposal or lifecycle status without exposing source contents or arbitrary command output.", schema: listImprovementImplementationRunsSchema, handlerName: "listImprovementImplementationRuns", inputScope: "host", targetEffect: "host-read", role: "host", family: "improvement", exposure: "advanced" },
  { name: "c2000_getImprovementCandidate", title: "Get C2000 Improvement Candidate", description: "Return a validated candidate branch/commit and bounded artifact references for human review. The MCP never merges or pushes this candidate automatically.", schema: getImprovementCandidateSchema, handlerName: "getImprovementCandidate", inputScope: "host", targetEffect: "host-read", role: "host", family: "improvement", exposure: "advanced" },
  { name: "c2000_cleanupImprovementRun", title: "Cleanup C2000 Improvement Run", description: "Remove a retained terminal improvement worktree after inspection. Active runs cannot be cleaned up and the candidate branch is retained for audit; this never touches master.", schema: cleanupImprovementRunSchema, handlerName: "cleanupImprovementRun", inputScope: "host", targetEffect: "repository-control", role: "host", family: "improvement", exposure: "advanced" },
  { name: "c2000_publishImprovementCandidate", title: "Publish C2000 Improvement Candidate", description: "Advanced governance operation: publish one independently validated candidate branch to the configured GitHub remote after verifying repository identity, branch safety, clean state, exact SHA, and base freshness. It never creates, approves, or merges a pull request.", schema: publishImprovementCandidateSchema, handlerName: "publishImprovementCandidate", inputScope: "host", targetEffect: "repository-control", role: "host", family: "improvement", exposure: "advanced" },
  { name: "c2000_getImprovementPullRequest", title: "Get C2000 Improvement Pull Request", description: "Read the locally recorded controlled improvement pull request, candidate identity, and the latest stored review evidence without contacting the target.", schema: getImprovementPullRequestSchema, handlerName: "getImprovementPullRequest", inputScope: "host", targetEffect: "host-read", role: "host", family: "improvement", exposure: "advanced" },
  { name: "c2000_refreshImprovementReviewEvidence", title: "Refresh C2000 Improvement Review Evidence", description: "Refresh candidate-bound CI, human-review, base, head, mergeability, and optional hardware evidence for an existing improvement pull request. It never merges or changes implementation code.", schema: refreshImprovementReviewEvidenceSchema, handlerName: "refreshImprovementReviewEvidence", inputScope: "host", targetEffect: "repository-control", role: "host", family: "improvement", exposure: "advanced" },
  { name: "c2000_getMergeRecommendation", title: "Get C2000 Merge Recommendation", description: "Read the latest deterministic fail-closed merge recommendation for a controlled improvement pull request. This is evidence only; human merge remains required and no merge API is called.", schema: getMergeRecommendationSchema, handlerName: "getMergeRecommendation", inputScope: "host", targetEffect: "host-read", role: "host", family: "improvement", exposure: "advanced" },
  { name: "c2000_refreshReviewFeedback", title: "Refresh C2000 Review Feedback", description: "Advanced governance operation: fetch and sanitize bounded PR review feedback as untrusted evidence. It never treats comments as instructions or changes source code.", schema: refreshReviewFeedbackSchema, handlerName: "refreshReviewFeedback", inputScope: "host", targetEffect: "repository-control", role: "host", family: "improvement", exposure: "advanced" },
  { name: "c2000_listReviewFeedback", title: "List C2000 Review Feedback", description: "Read normalized, sanitized review feedback and deterministic classifications for a controlled improvement PR. Raw review text is never returned.", schema: listReviewFeedbackSchema, handlerName: "listReviewFeedback", inputScope: "host", targetEffect: "host-read", role: "host", family: "improvement", exposure: "advanced" },
  { name: "c2000_listRevisionProposals", title: "List C2000 Revision Proposals", description: "List evidence-bound revision proposals generated from untrusted PR feedback; set generate=true for one selected PR after c2000_refreshReviewFeedback to classify current feedback before listing. The original Improvement Proposal remains immutable.", schema: listRevisionProposalsSchema, handlerName: "listRevisionProposals", inputScope: "host", targetEffect: "host-read", role: "host", family: "improvement", exposure: "advanced" },
  { name: "c2000_reviewRevisionProposal", title: "Review C2000 Revision Proposal", description: "Human-gated approval, rejection, or deferral of a controlled review revision. Approval records intent only and never edits, commits, pushes, or merges code.", schema: reviewRevisionProposalSchema, handlerName: "reviewRevisionProposal", inputScope: "host", targetEffect: "repository-control", role: "host", family: "improvement", exposure: "advanced" },
  { name: "c2000_publishRevisionCandidate", title: "Publish C2000 Revision Candidate", description: "Publish one independently validated C(n+1) candidate to the existing PR branch with an ordinary fast-forward push. It never force-pushes, rebases, amends, auto-resolves review, or merges.", schema: publishRevisionCandidateSchema, handlerName: "publishRevisionCandidate", inputScope: "host", targetEffect: "repository-control", role: "host", family: "improvement", exposure: "advanced" },
  { name: "c2000_listPostMergeEvaluations", title: "List C2000 Post-Merge Evaluations", description: "Advanced governance read: list frozen-baseline post-merge evaluations and their deployment, lifecycle, and verdict state. It never changes source, production, or target state.", schema: listPostMergeEvaluationsSchema, handlerName: "listPostMergeEvaluations", inputScope: "host", targetEffect: "host-read", role: "host", family: "improvement", exposure: "advanced" },
  { name: "c2000_getPostMergeEvaluation", title: "Get C2000 Post-Merge Evaluation", description: "Advanced governance read: inspect one post-merge evaluation, immutable baseline snapshot history, comparable post-merge metrics, and any rollback recommendation.", schema: getPostMergeEvaluationSchema, handlerName: "getPostMergeEvaluation", inputScope: "host", targetEffect: "host-read", role: "host", family: "improvement", exposure: "advanced" },
  { name: "c2000_refreshPostMergeEvaluation", title: "Refresh C2000 Post-Merge Evaluation", description: "Advanced governance operation: collect only runtime-matched post-merge Outcome Events and update deterministic evaluation evidence. It never deploys, rolls back, edits, pushes, or merges.", schema: refreshPostMergeEvaluationSchema, handlerName: "refreshPostMergeEvaluation", inputScope: "host", targetEffect: "job-control", role: "host", family: "improvement", exposure: "advanced" },
  { name: "c2000_getRollbackRecommendation", title: "Get C2000 Rollback Recommendation", description: "Advanced governance read: inspect a human-only rollback or follow-up recommendation produced by a post-merge regression evaluation. Automatic execution is permanently disabled.", schema: getRollbackRecommendationSchema, handlerName: "getRollbackRecommendation", inputScope: "host", targetEffect: "host-read", role: "host", family: "improvement", exposure: "advanced" },
  { name: "c2000_reviewRollbackRecommendation", title: "Review C2000 Rollback Recommendation", description: "Advanced human governance gate: acknowledge, reject, convert to a ready-for-review follow-up Proposal, or resolve a rollback recommendation. It never executes the selected action.", schema: reviewRollbackRecommendationSchema, handlerName: "reviewRollbackRecommendation", inputScope: "host", targetEffect: "job-control", role: "host", family: "improvement", exposure: "advanced" },
  { name: "c2000_getDaemonHealth", title: "Get C2000 Debug Daemon Health", description: "Return local c2000-debugd health, worker, and background job counts without touching a target.", schema: daemonHealthSchema, handlerName: "getDaemonHealth", inputScope: "host", targetEffect: "host-read", role: "host", family: "host", exposure: "default" },
  { name: "c2000_listBoards", title: "List C2000 Boards", description: "List persisted board registrations, health state, lease ownership, and quarantine evidence. If empty, call c2000_registerBoard before any daemon-routed launch.", schema: listBoardsSchema, handlerName: "listBoards", inputScope: "host", targetEffect: "host-read", role: "host", family: "host", exposure: "default" },
  { name: "c2000_registerBoard", title: "Register C2000 Board", description: "Validate a serial-bound XDS110 .ccxml, persist the board registration, and start its isolated daemon worker without touching the target.", schema: registerBoardSchema, handlerName: "registerBoard", inputScope: "host", targetEffect: "job-control", role: "workflow", family: "workflow", exposure: "default" },
  { name: "c2000_recoverBoard", title: "Recover C2000 Board Worker", description: "Dry-run or restart only the daemon-owned worker for one registered board. It never kills external CCS/DSS processes.", schema: recoverBoardSchema, handlerName: "recoverBoard", inputScope: "host", targetEffect: "job-control", role: "workflow", family: "workflow", exposure: "default" },
  { name: "c2000_submitTestPlan", title: "Submit C2000 Test Plan", description: "Persist and schedule a structured background test plan; returns immediately with a stable jobId. In the safe profile, use guarded durable assign/capture/wait steps for lease-fenced target workflows while direct expression-write tools remain hidden.", schema: submitTestPlanSchema, handlerName: "submitTestPlan", inputScope: "host", targetEffect: "job-control", role: "workflow", family: "workflow", exposure: "default" },
  { name: "c2000_submitMultiBoardIpcAcceptance", title: "Submit Multi-Board IPC Acceptance", description: "Create and submit a structured multi-board IPC job without waiting for test completion.", schema: submitMultiBoardIpcAcceptanceSchema, handlerName: "submitMultiBoardIpcAcceptance", inputScope: "host", targetEffect: "job-control", role: "workflow", family: "workflow", coreIdentityFields: ["ipcReadyExpressions[].coreId"], exposure: "default" },
  { name: "c2000_submitMultiBoardCanAcceptance", title: "Submit Two-Board CAN Acceptance", description: "Persist a CAN pair and schedule a background two-board CAN test. Hardware mode fails closed until a physical CAN adapter is configured; mock mode is simulation only.", schema: submitMultiBoardCanAcceptanceSchema, handlerName: "submitMultiBoardCanAcceptance", inputScope: "host", targetEffect: "job-control", role: "workflow", family: "workflow", exposure: "default" },
  { name: "c2000_getBoardGroupSnapshot", title: "Get Board Group Snapshot", description: "Read durable CAN group lifecycle, member lease/session snapshots, named barriers, and evidence without touching a target.", schema: getBoardGroupSnapshotSchema, handlerName: "getBoardGroupSnapshot", inputScope: "host", targetEffect: "host-read", role: "host", family: "host", capability: "can.advanced" },
  { name: "c2000_listCanProfiles", title: "List CAN Profiles", description: "List versioned, hash-addressable CAN profile declarations without touching a target.", schema: listCanProfilesSchema, handlerName: "listCanProfiles", inputScope: "host", targetEffect: "host-read", role: "host", family: "host", capability: "can.advanced" },
  { name: "c2000_submitCanFaultCampaign", title: "Submit CAN Fault Campaign", description: "Submit a finite, durable two-board CAN fault campaign. Reset/rejoin recovery is never blindly replayed after interruption.", schema: submitCanFaultCampaignSchema, handlerName: "submitCanFaultCampaign", inputScope: "host", targetEffect: "job-control", role: "workflow", family: "workflow", capability: "can.advanced" },
  { name: "c2000_submitCanSoakTest", title: "Submit CAN Soak Test", description: "Submit a finite duration/iteration CAN soak job with durable checkpoints; it never runs indefinitely.", schema: submitCanSoakTestSchema, handlerName: "submitCanSoakTest", inputScope: "host", targetEffect: "job-control", role: "workflow", family: "workflow", capability: "can.advanced" },
  { name: "c2000_getTestRun", title: "Get C2000 Test Run", description: "Read a durable background test run by jobId. Set waitForTerminalMs up to 30 seconds to avoid repeated client-side polling.", schema: getTestRunSchema, handlerName: "getTestRun", inputScope: "host", targetEffect: "host-read", role: "host", family: "host", exposure: "default" },
  { name: "c2000_listTestRuns", title: "List C2000 Test Runs", description: "List durable C2000 background test runs.", schema: listTestRunsSchema, handlerName: "listTestRuns", inputScope: "host", targetEffect: "host-read", role: "host", family: "host", exposure: "default" },
  { name: "c2000_cancelTestRun", title: "Cancel C2000 Test Run", description: "Request safe cancellation at the next job step boundary.", schema: cancelTestRunSchema, handlerName: "cancelTestRun", inputScope: "host", targetEffect: "job-control", role: "workflow", family: "workflow", exposure: "default" },
  { name: "c2000_getTestArtifacts", title: "Get C2000 Test Artifacts", description: "List durable artifacts attached to a background test run.", schema: getTestArtifactsSchema, handlerName: "getTestArtifacts", inputScope: "host", targetEffect: "host-read", role: "host", family: "host", exposure: "default" },
  { name: "c2000_createAcceptanceClosure", title: "Create C2000 Acceptance Closure", description: "Create a detached, hash-bound acceptance attestation for canonical run artifacts and independently generated offline analysis without mutating the canonical manifest or touching a target.", schema: createAcceptanceClosureSchema, handlerName: "createAcceptanceClosure", inputScope: "host", targetEffect: "job-control", role: "primary", family: "observability", capability: "observability.metrics" },
  { name: "c2000_exportTrace", title: "Export C2000 Perfetto Trace", description: "Atomically export an offline Perfetto timeline from durable SQLite and/or completed artifacts. It never reconnects to a target or changes a job result.", schema: exportTraceSchema, handlerName: "exportTrace", inputScope: "host", targetEffect: "job-control", role: "primary", family: "observability", exposure: "default" },
  { name: "c2000_collectFailureBundle", title: "Collect C2000 Failure Bundle", description: "Best-effort, timeout-bounded collection of historical job, session, CAN, variable, DLOG, ERAD, and Trace evidence. This is read-only and does not access the target.", schema: collectFailureBundleSchema, handlerName: "collectFailureBundle", inputScope: "host", targetEffect: "job-control", role: "primary", family: "observability", exposure: "default" },
  { name: "c2000_createRunBaseline", title: "Create C2000 Run Baseline", description: "Generate deterministic metrics from durable job evidence and atomically create a firmware/test-plan-bound baseline. This never touches a target.", schema: createRunBaselineSchema, handlerName: "createRunBaseline", inputScope: "host", targetEffect: "job-control", role: "primary", family: "observability", capability: "observability.metrics" },
  { name: "c2000_compareRunWithBaseline", title: "Compare C2000 Run With Baseline", description: "Compare deterministic run metrics with a compatible baseline using explicit thresholds. Identity mismatches fail closed unless explicitly overridden.", schema: compareRunWithBaselineSchema, handlerName: "compareRunWithBaseline", inputScope: "host", targetEffect: "job-control", role: "primary", family: "observability", capability: "observability.metrics" },
  { name: "c2000_verifyBuild", title: "Verify C2000 Build", description: "Run or inspect a trusted, configured build provider and persist structured diagnostics, build identity, and complete logs. MCP input cannot submit arbitrary shell commands.", schema: verifyBuildSchema, handlerName: "verifyBuild", inputScope: "host", targetEffect: "job-control", role: "primary", family: "verification" },
  { name: "c2000_verifyMap", title: "Verify C2000 Linker Map", description: "Parse a TI C2000 linker map, emit deterministic memory/section metrics, enforce configured hard gates, and reject stale build artifacts.", schema: verifyMapSchema, handlerName: "verifyMap", inputScope: "host", targetEffect: "job-control", role: "primary", family: "verification" },
  { name: "c2000_verifyRegression", title: "Verify C2000 Regression Plan", description: "Execute a declared host/mock regression plan through allowlisted runners and persist per-suite results and full logs. Hardware suites require explicit hardware mode and a durable runner.", schema: verifyRegressionSchema, handlerName: "verifyRegression", inputScope: "host", targetEffect: "job-control", role: "primary", family: "verification" },
  { name: "c2000_verifyReview", title: "Verify C2000 Change Review", description: "Run deterministic diff metadata, path, pattern, and configured companion-evidence checks without requiring Git or an LLM.", schema: verifyReviewSchema, handlerName: "verifyReview", inputScope: "host", targetEffect: "job-control", role: "primary", family: "verification" },
  { name: "c2000_runEngineeringVerification", title: "Run C2000 Engineering Verification", description: "Preferred high-level verification workflow: Build, Map, Regression, Review, durable evidence, and a hard-gate final decision. Failed builds never fall through to stale maps or falsely passing regression.", schema: runEngineeringVerificationSchema, handlerName: "runEngineeringVerification", inputScope: "host", targetEffect: "job-control", role: "workflow", family: "verification" },
  { name: "c2000_getVerificationResult", title: "Get C2000 Verification Result", description: "Read a persisted structured verification result and its atomic artifact manifest by verificationId without touching a target.", schema: getVerificationResultSchema, handlerName: "getVerificationResult", inputScope: "host", targetEffect: "host-read", role: "primary", family: "verification" },
  { name: "c2000_startVariableStream", title: "Start C2000 Slow Variable Stream", description: "Start one bounded, low-priority host-polled variable stream for one explicit board/session/core. This does not halt the target and is not a high-rate waveform sampler. Prefer variables as {symbol,typeName} objects for deterministic C28x width validation; bare symbol strings are accepted only when the adapter exposes a reliable type.", schema: startVariableStreamSchema, handlerName: "startVariableStream", inputScope: "core", targetEffect: "observation-control", role: "primary", family: "observability", capability: "observability.variables", coreIdentityFields: ["coreId"], responseCoreIdentityFields: ["coreId", "coreName"] },
  { name: "c2000_stopVariableStream", title: "Stop C2000 Slow Variable Stream", description: "Idempotently stop or cancel an explicitly identified variable stream.", schema: stopVariableStreamSchema, handlerName: "stopVariableStream", inputScope: "core", targetEffect: "observation-control", role: "primary", family: "observability", capability: "observability.variables", coreIdentityFields: ["coreId"], responseCoreIdentityFields: ["coreId", "coreName"] },
  { name: "c2000_getVariableStreamStatus", title: "Get C2000 Variable Stream Status", description: "Read persisted stream identity, metadata, statistics, status, and artifact status without touching the target.", schema: getVariableStreamStatusSchema, handlerName: "getVariableStreamStatus", inputScope: "core", targetEffect: "observation-control", role: "primary", family: "observability", capability: "observability.variables", coreIdentityFields: ["coreId"], responseCoreIdentityFields: ["coreId", "coreName"] },
  { name: "c2000_readVariableSamples", title: "Read C2000 Variable Samples", description: "Page through ordered variable samples persisted by c2000-debugd without touching the target.", schema: readVariableSamplesSchema, handlerName: "readVariableSamples", inputScope: "core", targetEffect: "observation-control", role: "primary", family: "observability", capability: "observability.variables", coreIdentityFields: ["coreId"], responseCoreIdentityFields: ["coreId", "coreName", "samples[].coreId", "samples[].coreName"] },
  { name: "c2000_exportVariableStream", title: "Export C2000 Variable Stream", description: "Idempotently generate the portable variable-stream evidence snapshot from SQLite.", schema: exportVariableStreamSchema, handlerName: "exportVariableStream", inputScope: "core", targetEffect: "observation-control", role: "primary", family: "observability", capability: "observability.variables", coreIdentityFields: ["coreId"], responseCoreIdentityFields: ["coreId", "coreName"] },
  { name: "c2000_describeDlogBuffer", title: "Describe C2000 DLOG Buffer", description: "Resolve and validate a read-only structure-of-arrays DLOG buffer on one explicit board/session/core without reading its samples.", schema: dlogBufferRequestSchema, handlerName: "describeDlogBuffer", inputScope: "core", targetEffect: "target-read", role: "primary", family: "observability", capability: "observability.dlog", coreIdentityFields: ["coreId"], responseCoreIdentityFields: ["coreId", "coreName"] },
  { name: "c2000_getDlogStatus", title: "Get C2000 DLOG Status", description: "Read DLOG state, write index, trigger index, optional capture generation, and sample rate from one explicit core.", schema: dlogBufferRequestSchema, handlerName: "getDlogStatus", inputScope: "core", targetEffect: "target-read", role: "primary", family: "observability", capability: "observability.dlog", coreIdentityFields: ["coreId"], responseCoreIdentityFields: ["coreId", "coreName"] },
  { name: "c2000_readDlogBuffer", title: "Read C2000 DLOG Buffer", description: "Read and normalize an existing target-side DLOG capture with bounded consistency retries. This never arms or modifies firmware.", schema: dlogBufferRequestSchema, handlerName: "readDlogBuffer", inputScope: "core", targetEffect: "target-read", role: "primary", family: "observability", capability: "observability.dlog", coreIdentityFields: ["coreId"], responseCoreIdentityFields: ["coreId", "coreName"] },
  { name: "c2000_exportDlog", title: "Export C2000 DLOG", description: "Read a consistent target-side DLOG capture and atomically export dlog.json, dlog.csv, and the standard evidence snapshot.", schema: dlogBufferRequestSchema, handlerName: "exportDlog", inputScope: "core", targetEffect: "observation-control", role: "primary", family: "observability", capability: "observability.dlog", coreIdentityFields: ["coreId"], responseCoreIdentityFields: ["coreId", "coreName"] },
  { name: "c2000_getEradCapabilities", title: "Get F28P65x ERAD Capabilities", description: "Inspect F28P65x ERAD ownership, occupied resources, and supported first-version profiling features on one explicit board/session/core.", schema: getEradCapabilitiesSchema, handlerName: "getEradCapabilities", inputScope: "core", targetEffect: "target-read", role: "primary", family: "observability", capability: "observability.erad", coreIdentityFields: ["coreId"], responseCoreIdentityFields: ["coreId", "coreName"] },
  { name: "c2000_configureEradProfile", title: "Configure F28P65x ERAD Profile", description: "Resolve a PC range and configure explicitly fenced F28P65x ERAD resources. This writes ERAD registers and never silently overwrites occupied resources.", schema: configureEradProfileSchema, handlerName: "configureEradProfile", inputScope: "core", targetEffect: "memory-write", role: "primary", family: "observability", capability: "observability.erad", coreIdentityFields: ["coreId"], responseCoreIdentityFields: ["coreId", "coreName"] },
  { name: "c2000_startEradProfile", title: "Start F28P65x ERAD Profile", description: "Enable a previously configured ERAD profile on its frozen board/session/core and resource set.", schema: startEradProfileSchema, handlerName: "startEradProfile", inputScope: "core", targetEffect: "memory-write", role: "primary", family: "observability", capability: "observability.erad", coreIdentityFields: ["coreId"], responseCoreIdentityFields: ["coreId", "coreName"] },
  { name: "c2000_stopEradProfile", title: "Stop F28P65x ERAD Profile", description: "Idempotently stop or cancel an ERAD profile, read counters, and restore the prior selected-resource configuration.", schema: stopEradProfileSchema, handlerName: "stopEradProfile", inputScope: "core", targetEffect: "memory-write", role: "primary", family: "observability", capability: "observability.erad", coreIdentityFields: ["coreId"], responseCoreIdentityFields: ["coreId", "coreName"] },
  { name: "c2000_readEradProfile", title: "Read F28P65x ERAD Profile", description: "Read persisted ERAD profile status and completed statistics without touching the target.", schema: readEradProfileSchema, handlerName: "readEradProfile", inputScope: "core", targetEffect: "observation-control", role: "primary", family: "observability", capability: "observability.erad", coreIdentityFields: ["coreId"], responseCoreIdentityFields: ["coreId", "coreName"] },
  { name: "c2000_exportEradProfile", title: "Export F28P65x ERAD Profile", description: "Idempotently export erad.json and the standardized atomic evidence snapshot for a terminal profile.", schema: exportEradProfileSchema, handlerName: "exportEradProfile", inputScope: "core", targetEffect: "observation-control", role: "primary", family: "observability", capability: "observability.erad", coreIdentityFields: ["coreId"], responseCoreIdentityFields: ["coreId", "coreName"] },
  { name: "c2000_getToolContracts", title: "Get C2000 Tool Contracts", description: "Return active tool contracts and the current exposure policy; use this once when contract discovery is needed.", schema: toolContractsSchema, handlerName: "getToolContracts", inputScope: "host", targetEffect: "host-read", role: "host", family: "host", exposure: "default" },
  { name: "c2000_getServerHealth", title: "Get C2000 Server Health", description: "Return runtime, adapter, safety profile, and tool-surface health without touching a target.", schema: serverHealthSchema, handlerName: "getServerHealth", inputScope: "host", targetEffect: "host-read", role: "host", family: "host", exposure: "default" },
  { name: "c2000_getEnvironment", title: "Get C2000 Environment", description: "Resolve CCS, C2000Ware, and target configuration paths without touching a target.", schema: environmentSchema, handlerName: "getEnvironment", inputScope: "host", targetEffect: "host-read", role: "host", family: "host", exposure: "default" },
  { name: "c2000_getDebugBoundary", title: "Get C2000 Debug Boundary", description: "Return read-only guarantees that F28P65x debug control uses explicit per-core c2000 tools, not TI official MCP active-target controls.", schema: debugBoundarySchema, handlerName: "getDebugBoundary", inputScope: "host", targetEffect: "host-read", role: "host", family: "host" },
  { name: "c2000_getAcceptanceEvidence", title: "Get C2000 Acceptance Evidence", description: "Return a read-only map from final F28P65x acceptance requirements to the c2000 tools and evidence fields that prove them.", schema: acceptanceEvidenceSchema, handlerName: "getAcceptanceEvidence", inputScope: "host", targetEffect: "host-read", role: "host", family: "host" },
  { name: "c2000_getHardwarePreflight", title: "Get C2000 Hardware Preflight", description: "Run read-only host checks for XDS110 enumeration and existing CCS debug owner processes before target control.", schema: hardwarePreflightSchema, handlerName: "getHardwarePreflight", inputScope: "host", targetEffect: "host-read", role: "host", family: "host", exposure: "default" },
  { name: "c2000_discoverAcceptancePrograms", title: "Discover C2000 Acceptance Programs", description: "Find CPU1 and CPU2 .out files for F28P65x hardware acceptance without touching the target.", schema: acceptanceProgramDiscoverySchema, handlerName: "discoverAcceptancePrograms", inputScope: "host", targetEffect: "host-read", role: "host", family: "host" },
  { name: "c2000_getAcceptanceReadiness", title: "Get C2000 Acceptance Readiness", description: "Return a read-only hardware acceptance readiness report that combines ccxml, CPU program discovery, XDS110 preflight, debug ownership, and debug boundary checks.", schema: acceptanceReadinessSchema, handlerName: "getAcceptanceReadiness", inputScope: "host", targetEffect: "host-read", role: "host", family: "host" },
  { name: "c2000_analyzeRamOwnership", title: "Analyze C2000 RAM Ownership", description: "Parse C2000 linker .map files and report GS RAM ownership handoff writes required before CPU2 loads.", schema: ramOwnershipAnalysisSchema, handlerName: "analyzeRamOwnership", inputScope: "host", targetEffect: "host-read", role: "diagnostic", family: "diagnosis", coreIdentityFields: ["maps[].coreId"], responseCoreIdentityFields: [...ramOwnershipResponseIdentity] },
  { name: "c2000_createDebugSession", title: "Create C2000 Debug Session", description: "Create a logical multicore debug session with explicit core mapping. The response includes stage-timed startupDiagnostics for probe preparation, DSS startup, and initial core-state discovery.", schema: createDebugSessionSchema, handlerName: "createDebugSession", inputScope: "launch", targetEffect: "session-lifecycle", role: "primary", family: "session", capability: "debug.manual" },
  { name: "c2000_listCores", title: "List C2000 Cores", description: "List cores for a logical debug session (refreshes connection state via getState).", schema: sessionSchema, handlerName: "listCores", inputScope: "session", targetEffect: "session-read", role: "primary", family: "session", capability: "debug.manual" },
  { name: "c2000_getSessionTopology", title: "Get C2000 Session Topology", description: "Return the logical session coreId to core target mapping without touching target state.", schema: sessionSchema, handlerName: "getSessionTopology", inputScope: "session", targetEffect: "session-read", role: "primary", family: "session", exposure: "advanced" },
  { name: "c2000_closeDebugSession", title: "Close C2000 Debug Session", description: "Close a logical debug session and dispose its adapter resources.", schema: sessionSchema, handlerName: "closeDebugSession", inputScope: "session", targetEffect: "session-lifecycle", role: "primary", family: "session", capability: "debug.manual" },
  { name: "c2000_connectTarget", title: "Connect C2000 Target", description: "Connect a specific core by sessionId and coreId using the c2000 adapter path.", schema: sessionCoreSchema, handlerName: "connectTarget", inputScope: "core", targetEffect: "connectivity-control", role: "primary", family: "connectivity", capability: "debug.manual", coreIdentityFields: ["coreId"], responseCoreIdentityFields: [...singleCoreResponseIdentity] },
  { name: "c2000_disconnectTarget", title: "Disconnect C2000 Target", description: "Disconnect a specific core by sessionId and coreId using the c2000 adapter path.", schema: sessionCoreSchema, handlerName: "disconnectTarget", inputScope: "core", targetEffect: "connectivity-control", role: "primary", family: "connectivity", capability: "debug.manual", coreIdentityFields: ["coreId"], responseCoreIdentityFields: [...singleCoreResponseIdentity] },
  { name: "c2000_runCore", title: "Run C2000 Core", description: "Primary run control: run a specific core by sessionId and coreId. Prefer this over c2000_continue for new clients.", schema: sessionCoreSchema, handlerName: "runCore", inputScope: "core", targetEffect: "execution-control", role: "primary", family: "execution", capability: "debug.manual", coreIdentityFields: ["coreId"], responseCoreIdentityFields: [...singleCoreResponseIdentity] },
  { name: "c2000_continue", title: "Continue C2000 Core", description: "Alias of c2000_runCore (same handler path). Kept for TI MCP naming familiarity; prefer c2000_runCore.", schema: sessionCoreSchema, handlerName: "continue", inputScope: "core", targetEffect: "execution-control", role: "alias", family: "execution", exposure: "compatibility", aliasOf: "c2000_runCore", coreIdentityFields: ["coreId"], responseCoreIdentityFields: [...singleCoreResponseIdentity] },
  { name: "c2000_haltCore", title: "Halt C2000 Core", description: "Primary halt control: halt a specific core by sessionId and coreId. Prefer this over c2000_pause for new clients.", schema: sessionCoreSchema, handlerName: "haltCore", inputScope: "core", targetEffect: "execution-control", role: "primary", family: "execution", capability: "debug.manual", coreIdentityFields: ["coreId"], responseCoreIdentityFields: [...singleCoreResponseIdentity] },
  { name: "c2000_pause", title: "Pause C2000 Core", description: "Alias of c2000_haltCore (same handler path). Kept for TI MCP naming familiarity; prefer c2000_haltCore.", schema: sessionCoreSchema, handlerName: "pause", inputScope: "core", targetEffect: "execution-control", role: "alias", family: "execution", exposure: "compatibility", aliasOf: "c2000_haltCore", coreIdentityFields: ["coreId"], responseCoreIdentityFields: [...singleCoreResponseIdentity] },
  { name: "c2000_reset", title: "Reset C2000 Core", description: "Reset a specific core by sessionId, coreId, and resetType.", schema: resetCoreSchema, handlerName: "resetCore", inputScope: "core", targetEffect: "reset-control", role: "primary", family: "reset", capability: "debug.manual", coreIdentityFields: ["coreId"], responseCoreIdentityFields: [...singleCoreResponseIdentity] },
  { name: "c2000_getTargetState", title: "Get C2000 Target State", description: "Read connection state, run state and PC for one explicit core.", schema: sessionCoreSchema, handlerName: "getTargetState", inputScope: "core", targetEffect: "target-read", role: "primary", family: "read", capability: "debug.manual", coreIdentityFields: ["coreId"], responseCoreIdentityFields: [...singleCoreResponseIdentity] },
  { name: "c2000_loadProgram", title: "Load C2000 Program", description: "Load a .out program to one explicit core and record file metadata. Repeated CPU2 Flash loads fail closed before erase unless allowDestructiveFlashReload=true.", schema: loadProgramSchema, handlerName: "loadProgram", inputScope: "core", targetEffect: "program-load", role: "primary", family: "program", capability: "debug.program", coreIdentityFields: ["coreId"], responseCoreIdentityFields: [...singleCoreResponseIdentity] },
  { name: "c2000_loadSymbols", title: "Load C2000 Symbols Only", description: "Load debug symbols from a .out file into one explicit core session without erasing, programming, or writing target memory. Use for an image already resident in Flash.", schema: loadSymbolsSchema, handlerName: "loadSymbols", inputScope: "core", targetEffect: "symbol-load", role: "primary", family: "program", capability: "debug.program", coreIdentityFields: ["coreId"], responseCoreIdentityFields: [...singleCoreResponseIdentity] },
  { name: "c2000_loadPrograms", title: "Load C2000 Programs", description: "Load multiple core programs and return independent per-core results. The batch is preflighted so disconnected target cores and repeated CPU2 Flash loads fail closed before any target memory write; a connectivity failure returns nextAction=c2000_connectCores.", schema: loadProgramsSchema, handlerName: "loadPrograms", inputScope: "batch", targetEffect: "program-load", role: "primary", family: "program", capability: "debug.program", coreIdentityFields: ["programs[].coreId"], responseCoreIdentityFields: [...batchCoreResponseIdentity] },
  { name: "c2000_connectCores", title: "Connect C2000 Cores", description: "Connect multiple cores by explicit coreIds.", schema: batchCoresSchema, handlerName: "connectCores", inputScope: "batch", targetEffect: "connectivity-control", role: "primary", family: "connectivity", capability: "debug.manual", coreIdentityFields: ["coreIds[]"], responseCoreIdentityFields: [...batchCoreResponseIdentity] },
  { name: "c2000_haltCores", title: "Halt C2000 Cores", description: "Halt multiple cores by explicit coreIds.", schema: batchCoresSchema, handlerName: "haltCores", inputScope: "batch", targetEffect: "execution-control", role: "primary", family: "execution", capability: "debug.manual", coreIdentityFields: ["coreIds[]"], responseCoreIdentityFields: [...batchCoreResponseIdentity] },
  { name: "c2000_resetCores", title: "Reset C2000 Cores", description: "Reset multiple cores by explicit coreIds.", schema: resetCoresSchema, handlerName: "resetCores", inputScope: "batch", targetEffect: "reset-control", role: "primary", family: "reset", capability: "debug.manual", coreIdentityFields: ["coreIds[]"], responseCoreIdentityFields: [...batchCoreResponseIdentity] },
  { name: "c2000_runCores", title: "Run C2000 Cores", description: "Run multiple cores by explicit coreIds.", schema: batchCoresSchema, handlerName: "runCores", inputScope: "batch", targetEffect: "execution-control", role: "primary", family: "execution", capability: "debug.manual", coreIdentityFields: ["coreIds[]"], responseCoreIdentityFields: [...batchCoreResponseIdentity] },
  { name: "c2000_getMulticoreSnapshot", title: "Get C2000 Multicore Snapshot", description: "Read state, PC and loaded program for explicit coreIds, defaulting to every core in a session. Target reads can perturb real-time execution on CCS; avoid high-rate polling during live UART/IPC timing checks.", schema: multicoreSnapshotSchema, handlerName: "getMulticoreSnapshot", inputScope: "session", targetEffect: "target-read", role: "primary", family: "read", exposure: "default", coreIdentityFields: ["coreIds[]"], responseCoreIdentityFields: [...snapshotCoreResponseIdentity] },
  { name: "c2000_evaluateMany", title: "Evaluate C2000 Expressions", description: "Evaluate multiple expressions on one explicit core with independent results. Target reads can perturb real-time execution on CCS; avoid high-rate polling during live UART/IPC timing checks.", schema: evaluateManySchema, handlerName: "evaluateMany", inputScope: "core", targetEffect: "target-read", role: "primary", family: "read", exposure: "default", coreIdentityFields: ["coreId"], responseCoreIdentityFields: [...coreOnlyResponseIdentity] },
  { name: "c2000_assignExpression", title: "Assign C2000 Expression", description: "Assign a value expression on one explicit core for fault injection or parameter synchronization checks. Use verification=write-only for a one-shot firmware hook that consumes the value immediately.", schema: assignExpressionSchema, handlerName: "assignExpression", inputScope: "core", targetEffect: "memory-write", role: "primary", family: "write", coreIdentityFields: ["coreId"], responseCoreIdentityFields: [...singleCoreResponseIdentity] },
  { name: "c2000_assignExpressions", title: "Assign C2000 Expressions", description: "Assign multiple explicit per-core expressions for fault injection, MSGRAM, IPC, or parameter synchronization setup. Each item may use verification=write-only for a one-shot hook.", schema: assignExpressionsSchema, handlerName: "assignExpressions", inputScope: "batch", targetEffect: "memory-write", role: "primary", family: "write", coreIdentityFields: ["assignments[].coreId"], responseCoreIdentityFields: [...batchCoreResponseIdentity] },
  { name: "c2000_injectFaults", title: "Inject C2000 Faults", description: "Inject labeled fault values through explicit per-core expressions and optional readback verification.", schema: injectFaultsSchema, handlerName: "injectFaults", inputScope: "batch", targetEffect: "memory-write", role: "primary", family: "write", coreIdentityFields: ["faults[].coreId"], responseCoreIdentityFields: [...batchCoreResponseIdentity] },
  { name: "c2000_compareExpressions", title: "Compare C2000 Expressions", description: "Compare explicit per-core expression pairs for IPC, MSGRAM and parameter synchronization checks.", schema: compareExpressionsSchema, handlerName: "compareExpressions", inputScope: "session", targetEffect: "target-read", role: "primary", family: "read", coreIdentityFields: ["comparisons[].left.coreId", "comparisons[].right.coreId"], responseCoreIdentityFields: [...comparisonResponseIdentity] },
  { name: "c2000_getLoadedProgramInfo", title: "Get C2000 Loaded Program Info", description: "Return trusted metadata for programs loaded through this MCP.", schema: sessionCoreSchema, handlerName: "getLoadedProgramInfo", inputScope: "core", targetEffect: "target-read", role: "primary", family: "read", capability: "debug.manual", coreIdentityFields: ["coreId"], responseCoreIdentityFields: [...coreOnlyResponseIdentity] },
  { name: "c2000_resolvePc", title: "Resolve C2000 PC", description: "Resolve current PC for one core, returning partial data when source mapping is unavailable.", schema: sessionCoreSchema, handlerName: "resolvePc", inputScope: "core", targetEffect: "target-read", role: "primary", family: "read", capability: "debug.manual", coreIdentityFields: ["coreId"], responseCoreIdentityFields: [...coreOnlyResponseIdentity] },
  { name: "c2000_resolveAddress", title: "Resolve C2000 Address", description: "Resolve a code address for one explicit core (honest partial when symbol map unavailable).", schema: resolveAddressSchema, handlerName: "resolveAddress", inputScope: "core", targetEffect: "target-read", role: "primary", family: "read", capability: "debug.manual", coreIdentityFields: ["coreId"], responseCoreIdentityFields: [...coreOnlyResponseIdentity] },
  { name: "c2000_waitUntilExpression", title: "Wait Until C2000 Expression", description: "Poll one expression until it matches the expected value or times out.", schema: waitUntilExpressionSchema, handlerName: "waitUntilExpression", inputScope: "core", targetEffect: "target-read", role: "primary", family: "wait", capability: "debug.wait", coreIdentityFields: ["coreId"], responseCoreIdentityFields: [...coreOnlyResponseIdentity] },
  { name: "c2000_waitForExpressionSet", title: "Wait For C2000 Expression Set", description: "Poll explicit per-core expressions until all conditions match or the timeout expires.", schema: waitForExpressionSetSchema, handlerName: "waitForExpressionSet", inputScope: "session", targetEffect: "target-read", role: "primary", family: "wait", capability: "debug.wait", coreIdentityFields: ["conditions[].coreId"], responseCoreIdentityFields: [...waitSetResponseIdentity] },
  { name: "c2000_diagnoseCpu2Boot", title: "Diagnose C2000 CPU2 Boot", description: "Collect CPU1/CPU2 snapshot, PC and boot/IPC expressions for F28P65x CPU2 bring-up debugging. Prefer c2000_runBootHandoffDiagnosis for full handoff workflow.", schema: diagnoseCpu2BootSchema, handlerName: "diagnoseCpu2Boot", inputScope: "session", targetEffect: "target-read", role: "diagnostic", family: "diagnosis", coreIdentityFields: ["cpu1CoreId", "cpu2CoreId"], responseCoreIdentityFields: [...diagnoseCpu2BootResponseIdentity] },
  { name: "c2000_diagnoseBootHandoff", title: "Diagnose C2000 Boot Handoff", description: "Collect CPU1/CPU2 boot diagnostics plus RAM ownership map evidence and a compact handoff verdict. Prefer workflow c2000_runBootHandoffDiagnosis when available.", schema: diagnoseBootHandoffSchema, handlerName: "diagnoseBootHandoff", inputScope: "session", targetEffect: "target-read", role: "diagnostic", family: "diagnosis", coreIdentityFields: ["cpu1CoreId", "cpu2CoreId"], responseCoreIdentityFields: [...diagnoseBootHandoffResponseIdentity] },
  { name: "c2000_waitForIpcReady", title: "Wait For C2000 IPC Ready", description: "Poll default or supplied CPU1/CPU2 IPC-ready expressions until all match or timeout.", schema: waitForIpcReadySchema, handlerName: "waitForIpcReady", inputScope: "session", targetEffect: "target-read", role: "primary", family: "wait", capability: "debug.wait", coreIdentityFields: ["cpu1CoreId", "cpu2CoreId", "conditions[].coreId"], responseCoreIdentityFields: [...waitSetResponseIdentity] },
  { name: "c2000_reloadResetRunToMain", title: "Reload Reset Run C2000 Core", description: "Reload one explicit core, reset it, run it, and report that true breakpoint run-to-main is not supported by the current adapter.", schema: reloadResetRunToMainSchema, handlerName: "reloadResetRunToMain", inputScope: "core", targetEffect: "launch-workflow", role: "workflow", family: "workflow", coreIdentityFields: ["coreId"], responseCoreIdentityFields: [...singleCoreResponseIdentity] },
  { name: "c2000_launchAndRunIpcAcceptance", title: "Launch And Run C2000 IPC Acceptance", description: "Preferred task-level one-shot after c2000_listBoards confirms a registered worker: create and connect CPU1/CPU2 (standard coreIds 0 and 2), then run full IPC acceptance. The server validates the load/run contract and real-map IPC symbols before target mutation. programPreparation=symbols-only loads matching .out symbols without programming or verifying resident Flash. For RAM builds that initialize ownership from CPU1, use loadSequence.mode=cpu1-run-before-cpu2; for firmware-owned CPU2 release, use runSequence.runMode=cpu1_boots_cpu2.", schema: launchAndRunIpcAcceptanceSchema, handlerName: "launchAndRunIpcAcceptance", inputScope: "launch", targetEffect: "launch-workflow", role: "workflow", family: "workflow", exposure: "default", coreIdentityFields: ["cpu1CoreId", "cpu2CoreId", "ipcReadyExpressions[].coreId"], responseCoreIdentityFields: [...launchAndRunIpcAcceptanceResponseIdentity] },
  { name: "c2000_runIpcAcceptance", title: "Run C2000 IPC Acceptance Workflow", description: "Preferred task-level workflow when a session already exists: full F28P65x CPU1/CPU2 IPC acceptance in one server-side call. The server validates the load/run contract and real-map IPC symbols before target mutation; programPreparation=symbols-only loads matching .out symbols without programming or verifying resident Flash. Use this instead of launchMulticoreDebug followed by generic runCores for an IPC handshake. For firmware-owned CPU2 release, use runSequence.runMode=cpu1_boots_cpu2.", schema: runIpcAcceptanceSchema, handlerName: "runIpcAcceptance", inputScope: "launch", targetEffect: "launch-workflow", role: "workflow", family: "workflow", exposure: "default", coreIdentityFields: ["cpu1CoreId", "cpu2CoreId", "ipcReadyExpressions[].coreId"], responseCoreIdentityFields: [...workflowIpcAcceptanceResponseIdentity] },
  { name: "c2000_runBootHandoffDiagnosis", title: "Run C2000 Boot Handoff Diagnosis Workflow", description: "Preferred task-level boot diagnosis: snapshot, programs, expressions, PC, RAM ownership, ELF freshness, and CPU2 handoff in one workflow.", schema: runBootHandoffDiagnosisSchema, handlerName: "runBootHandoffDiagnosis", inputScope: "launch", targetEffect: "launch-workflow", role: "workflow", family: "workflow", exposure: "default", coreIdentityFields: ["cpu1CoreId", "cpu2CoreId", "expressions[].coreId"], responseCoreIdentityFields: [...workflowBootHandoffResponseIdentity] },
  { name: "c2000_runReloadAndDiagnose", title: "Run C2000 Reload And Diagnose Workflow", description: "Preferred task-level reload path: halt/reset/load, optionally perform a controlled post-load reset and CPU1-first boot, wait, then diagnose in one workflow. Set postLoadBoot.releaseCpu2BeforeCpu1=true when firmware owns CPU2 release; repeated CPU2 Flash loads remain blocked unless explicitly authorized. The post-load boot does not write PC or claim Flash verification.", schema: runReloadAndDiagnoseSchema, handlerName: "runReloadAndDiagnose", inputScope: "launch", targetEffect: "launch-workflow", role: "workflow", family: "workflow", exposure: "default", coreIdentityFields: ["cpu1CoreId", "cpu2CoreId", "waitExpressions[].coreId"], responseCoreIdentityFields: [...workflowReloadAndDiagnoseResponseIdentity] },
  { name: "c2000_runFullDebugBundle", title: "Run C2000 Full Debug Bundle Workflow", description: "Preferred task-level evidence capture: full multicore debug bundle with summary files in one workflow.", schema: runFullDebugBundleSchema, handlerName: "runFullDebugBundle", inputScope: "launch", targetEffect: "launch-workflow", role: "workflow", family: "workflow", exposure: "default", coreIdentityFields: ["cpu1CoreId", "cpu2CoreId", "coreIds[]", "expressions[].coreId", "maps[].coreId"], responseCoreIdentityFields: [...workflowFullBundleResponseIdentity] },
  { name: "c2000_verifyRunPauseIsolation", title: "Verify C2000 Run/Pause Isolation", description: "Run and pause CPU1/CPU2 one at a time, proving each command affects only the requested core.", schema: verifyRunPauseIsolationSchema, handlerName: "verifyRunPauseIsolation", inputScope: "session", targetEffect: "execution-control", role: "diagnostic", family: "execution", coreIdentityFields: ["cpu1CoreId", "cpu2CoreId"], responseCoreIdentityFields: [...runPauseAcceptanceResponseIdentity] },
  { name: "c2000_launchMultiBoardDebug", title: "Launch C2000 Multi-Board Debug", description: "Allocate explicit XDS110 serial numbers to independently bound .ccxml configurations, then create isolated multicore sessions for every connected board in one MCP call. Sessions auto-close after the requested idle timeout by default.", schema: launchMultiBoardDebugSchema, handlerName: "launchMultiBoardDebug", inputScope: "launch", targetEffect: "launch-workflow", role: "workflow", family: "workflow", coreIdentityFields: ["boards[].cores[].coreId"], responseCoreIdentityFields: [...multiBoardLaunchResponseIdentity] },
  { name: "c2000_launchMulticoreDebug", title: "Launch C2000 Multicore Debug", description: "Create, connect, load and snapshot a multicore debug flow. The session and its DSS process auto-close after the requested idle timeout by default; set autoCloseOnComplete=false for an interactive session. Prefer workflow tools for IPC/boot diagnosis after launch.", schema: launchMulticoreDebugSchema, handlerName: "launchMulticoreDebug", inputScope: "launch", targetEffect: "launch-workflow", role: "workflow", family: "workflow", coreIdentityFields: [
    "cores[].coreId",
    "postLaunchActions.assignExpressions[].coreId",
    "postLaunchActions.injectFaults[].coreId",
    "postLaunchChecks.waitForExpressionSet.conditions[].coreId",
    "postLaunchChecks.compareExpressions[].left.coreId",
    "postLaunchChecks.compareExpressions[].right.coreId",
    "postLaunchChecks.diagnoseCpu2Boot.cpu1CoreId",
    "postLaunchChecks.diagnoseCpu2Boot.cpu2CoreId",
    "postLaunchChecks.verifyRunPauseIsolation.cpu1CoreId",
    "postLaunchChecks.verifyRunPauseIsolation.cpu2CoreId"
  ], responseCoreIdentityFields: [...launchResponseIdentity] },
  { name: "c2000_launchMulticoreDebugSafe", title: "Launch C2000 Multicore Debug Safely", description: "After confirming board registration, create, connect, load, halt, snapshot and perform read-only checks without expression writes, fault injection, reset or automatic run. F28P65x CPU1/CPU2 use coreIds 0/2.", schema: launchMulticoreDebugSafeSchema, handlerName: "launchMulticoreDebugSafe", inputScope: "launch", targetEffect: "launch-workflow", role: "workflow", family: "workflow", coreIdentityFields: ["cores[].coreId"], responseCoreIdentityFields: [...launchResponseIdentity] },
  { name: "c2000_launchMulticoreDebugWithActions", title: "Launch C2000 Multicore Debug With Target Actions", description: "Create and launch a multicore session with explicit target mutations including assignments, fault injection, or run/pause isolation.", schema: launchMulticoreDebugWithActionsSchema, handlerName: "launchMulticoreDebugWithActions", inputScope: "launch", targetEffect: "launch-workflow", role: "workflow", family: "workflow", coreIdentityFields: ["cores[].coreId"], responseCoreIdentityFields: [...launchResponseIdentity] }
];

export const c2000ToolDefinitions: ToolDefinition[] = baseToolDefinitions.map(definition => decorateDefinition(definition));

export interface C2000ToolInvoker {
  invokeTool(toolName: string, input: unknown): Promise<Record<string, unknown>>;
}

export interface C2000ToolRegistration {
  invoker: C2000ToolInvoker;
  capabilitySessions: CapabilitySessionManager;
  dynamicToolListSupported: boolean;
  visibleDefinitions(): ToolDefinition[];
  getExposureSummary(): ToolExposureSummary;
  dispose(): void;
}

export function createC2000ToolInvoker(
  manager: DebugSessionManager,
  deps: ToolHandlerDeps = {}
): C2000ToolInvoker {
  const handlers = createToolHandlers(manager, { getToolContracts, getToolSurfaceGuide, ...deps });
  const definitions = new Map(c2000ToolDefinitions.map(definition => [definition.name, definition]));
  const outcomeAnalytics = deps.outcomeAnalytics;

  return {
    async invokeTool(toolName: string, input: unknown): Promise<Record<string, unknown>> {
      const startedAt = Date.now();
      const definition = definitions.get(toolName);
      const sessionId = getInputSessionId(input);
      if (!definition) {
        const result = failedInvocation(new DebugMcpError("ToolNotFound", `Unknown C2000 tool: ${toolName}`, { toolName }), sessionId);
        recordToolOutcome(outcomeAnalytics, { toolName, input, result, durationMs: Date.now() - startedAt });
        return result;
      }
      try {
        // The daemon validates again even when a proxy has already checked this input.
        const parsedInput = definition.schema.parse(input);
        const handler = handlers[definition.handlerName] as Handler;
        // Several workflow wrappers intentionally call sibling handlers through
        // `this`; preserve the handler object when invoking through the generic router.
        const invoke = () => handler.call(handlers, parsedInput);
        const result = typeof sessionId === "string" && definition.name !== "c2000_closeDebugSession"
          ? await manager.withSessionActivity(sessionId, invoke)
          : await invoke();
        recordToolOutcome(outcomeAnalytics, { toolName, input, result, durationMs: Date.now() - startedAt });
        return result;
      } catch (error) {
        const result = failedInvocation(error, sessionId);
        recordToolOutcome(outcomeAnalytics, { toolName, input, result, durationMs: Date.now() - startedAt });
        return result;
      }
    }
  };
}

export function registerC2000Tools(
  server: McpServer,
  source: DebugSessionManager | C2000ToolInvoker,
  deps: ToolHandlerDeps = {},
  profile: ToolProfile = toolProfileFromEnv(),
  filesystem: FilesystemPolicy = { allowedReadRoots: [process.cwd()], allowedWriteRoots: [] },
  tiEnvironment: ResolveTiEnvironmentOptions = {},
  runtime: { getServerHealth?: () => Record<string, any> | Promise<Record<string, any>> } = {},
  surface: ToolSurfaceProfile = toolSurfaceProfileFromEnv(),
  options: { capabilitySessions?: CapabilitySessionManager; logger?: Pick<Logger, "info" | "warn"> } = {}
): C2000ToolRegistration {
  const capabilitySessions = options.capabilitySessions ?? new CapabilitySessionManager({ logger: options.logger });
  const controller = new ToolCapabilityController(profile, surface, capabilitySessions);
  const dynamicMcpCandidate = supportsDynamicMcpServer(server);
  const definitionsToRegister = dynamicMcpCandidate
    ? definitionsForSafetyProfile(profile)
    : controller.visibleDefinitions();
  const effectiveDeps: ToolHandlerDeps = {
    ...deps,
    getToolContracts: () => getToolContracts(profile, surface, capabilitySessions.activeCapabilities()),
    getToolSurfaceGuide: () => getToolSurfaceGuide(profile, surface, capabilitySessions.activeCapabilities()),
    getToolProfile: () => toolProfilePayload(controller.getExposureSummary()),
    listCapabilities: () => controller.listCapabilities(),
    openCapabilitySession: input => controller.openCapabilitySession(input),
    closeCapabilitySession: input => controller.closeCapabilitySession(input),
    getServerHealth: runtime.getServerHealth ?? deps.getServerHealth,
    tiEnvironment,
  };
  const invoker = isToolInvoker(source) ? source : createC2000ToolInvoker(source, effectiveDeps);

  const registeredTools = new Map<string, RegisteredTool>();
  for (const definition of definitionsToRegister) {
    const registered = server.registerTool(
      definition.name,
      {
        title: definition.title,
        description: definition.description,
        inputSchema: objectShape(definition.schema),
        annotations: definition.annotations
      },
      async (input: any) => {
        let result: Record<string, unknown>;
        try {
          controller.assertToolVisible(definition.name);
          await validateToolPaths(input, filesystem);
          result = await invokeRegisteredDefinition(definition, input, invoker, controller, runtime);
        } catch (error) {
          result = failedInvocation(error, getInputSessionId(input));
        }
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
          isError: result.success === false
        };
      }
    );
    registeredTools.set(definition.name, registered);
  }

  const dynamicToolListSupported = dynamicMcpCandidate
    && installDynamicMcpDispatch(server, controller, registeredTools);
  controller.setDynamicToolListSupported(dynamicToolListSupported);
  const unsubscribe = capabilitySessions.subscribe(() => {
    if (!dynamicToolListSupported) return;
    syncRegisteredToolMembership(controller, registeredTools);
    server.sendToolListChanged();
  });
  return {
    invoker,
    capabilitySessions,
    dynamicToolListSupported,
    visibleDefinitions: () => controller.visibleDefinitions(),
    getExposureSummary: () => controller.getExposureSummary(),
    dispose: () => {
      unsubscribe();
      capabilitySessions.dispose();
    }
  };
}

class ToolCapabilityController {
  private readonly byName = new Map(c2000ToolDefinitions.map(definition => [definition.name, definition]));
  private dynamicToolListSupported = false;

  constructor(
    private readonly profile: ToolProfile,
    private readonly surface: ToolSurfaceProfile,
    private readonly sessions: CapabilitySessionManager
  ) {}

  setDynamicToolListSupported(value: boolean): void {
    this.dynamicToolListSupported = value;
  }

  visibleDefinitions(): ToolDefinition[] {
    return definitionsForDynamicExposure(this.profile, this.surface, this.sessions.activeCapabilities());
  }

  getExposureSummary(): ToolExposureSummary {
    return getToolExposureSummary(
      this.profile,
      this.surface,
      this.sessions.activeCapabilities(),
      this.sessions.listActiveSessions()
    );
  }

  listCapabilities(): Record<string, unknown> {
    const safetyDefinitions = definitionsForSafetyProfile(this.profile);
    const safetyNames = new Set(safetyDefinitions.map(definition => definition.name));
    const active = new Set(this.sessions.activeCapabilities());
    return {
      activeToolProfile: this.profile,
      activeToolSurfaceProfile: this.surface,
      capabilityMode: "dynamic",
      available: CAPABILITY_DESCRIPTORS.map(descriptor => {
        const members = c2000ToolDefinitions.filter(tool => tool.capability === descriptor.name);
        const allowed = members.filter(tool => safetyNames.has(tool.name));
        return {
          name: descriptor.name,
          description: descriptor.description,
          risk: descriptor.risk,
          requiresSafety: minimumProfileFor(members),
          active: this.surface === "agent" && active.has(descriptor.name),
          implicitlyVisible: this.surface !== "agent",
          toolCount: allowed.length,
          blockedBySafety: members.filter(tool => !safetyNames.has(tool.name)).map(tool => tool.name)
        };
      }),
      activeSessions: this.sessions.listActiveSessions()
    };
  }

  openCapabilitySession(input: {
    capability: string;
    reason: string;
    ttlSeconds?: number;
    openedFrom?: CapabilitySessionContext;
    recommendationId?: string;
  }): Record<string, unknown> {
    const descriptor = CAPABILITY_DESCRIPTORS.find(candidate => candidate.name === input.capability.trim());
    if (!descriptor) {
      throw new DebugMcpError("CapabilityUnknown", `Unknown C2000 capability: ${input.capability}`, {
        capability: input.capability,
        availableCapabilities: CAPABILITY_DESCRIPTORS.map(candidate => candidate.name)
      });
    }
    const members = c2000ToolDefinitions.filter(tool => tool.capability === descriptor.name);
    const safetyDefinitions = definitionsForSafetyProfile(this.profile);
    const safetyNames = new Set(safetyDefinitions.map(definition => definition.name));
    const allowed = members.filter(tool => safetyNames.has(tool.name));
    const blockedBySafety = members.filter(tool => !safetyNames.has(tool.name)).map(tool => tool.name);
    if (allowed.length === 0) {
      throw new DebugMcpError("CapabilityNotAllowedBySafetyProfile", `Capability ${descriptor.name} is not allowed by tool profile ${this.profile}`, {
        capability: descriptor.name,
        activeToolProfile: this.profile,
        activeSurface: this.surface,
        requestedTools: members.map(tool => tool.name),
        visibleTools: [],
        blockedBySafety
      });
    }

    if (this.surface !== "agent") {
      return {
        capability: descriptor.name,
        session: null,
        created: false,
        implicitlyVisible: true,
        requestedTools: members.map(tool => tool.name),
        visibleTools: allowed.map(tool => tool.name),
        blockedBySafety,
        activeCapabilities: this.sessions.activeCapabilities(),
        requiresReconnect: false,
        toolsListChanged: false
      };
    }

    const opened = this.sessions.open(
      descriptor.name,
      input.reason,
      input.ttlSeconds,
      undefined,
      input.openedFrom,
      input.recommendationId
    );
    const summary = this.getExposureSummary();
    return {
      capability: descriptor.name,
      session: opened.session,
      created: opened.created,
      requestedTools: members.map(tool => tool.name),
      visibleTools: allowed.map(tool => tool.name),
      blockedBySafety,
      activeCapabilities: summary.activeCapabilities,
      activeToolProfile: this.profile,
      activeToolSurfaceProfile: this.surface,
      requiresReconnect: !this.dynamicToolListSupported,
      toolsListChanged: this.dynamicToolListSupported
    };
  }

  closeCapabilitySession(input: { sessionId: string; outcome?: CapabilitySessionOutcome }): Record<string, unknown> {
    const session = this.sessions.close(input.sessionId, input.outcome);
    const summary = this.getExposureSummary();
    return {
      session,
      activeCapabilities: summary.activeCapabilities,
      visibleTools: summary.registered.map(tool => tool.name),
      requiresReconnect: !this.dynamicToolListSupported,
      toolsListChanged: this.dynamicToolListSupported
    };
  }

  assertToolVisible(toolName: string): void {
    const summary = this.getExposureSummary();
    if (summary.registered.some(tool => tool.name === toolName)) return;
    const definition = this.byName.get(toolName);
    if (!definition) {
      throw new DebugMcpError("ToolNotFound", `Unknown C2000 tool: ${toolName}`, { toolName });
    }
    const safetyAllowed = definitionsForSafetyProfile(this.profile).some(tool => tool.name === toolName);
    if (!safetyAllowed) {
      if (definition.capability) {
        throw new DebugMcpError("CapabilityNotAllowedBySafetyProfile", `Tool ${toolName} is blocked by tool profile ${this.profile}`, {
          tool: toolName,
          requiredCapability: definition.capability,
          activeSurface: this.surface,
          activeToolProfile: this.profile
        });
      }
      throw new DebugMcpError("ToolNotFound", `Tool ${toolName} is blocked by tool profile ${this.profile}`, {
        tool: toolName,
        activeToolProfile: this.profile
      });
    }
    if (definition.capability && this.surface === "agent") {
      const expired = this.sessions.lastEndedReason(definition.capability) === "expired";
      throw new DebugMcpError(expired ? "CapabilityExpired" : "CapabilityRequired", `Tool ${toolName} requires capability ${definition.capability}`, {
        tool: toolName,
        requiredCapability: definition.capability,
        activeSurface: this.surface,
        activeToolProfile: this.profile,
        activeCapabilities: summary.activeCapabilities,
        ...(expired ? { remediation: "Open a new short-lived capability session with c2000_openCapabilitySession." } : {})
      });
    }
    throw new DebugMcpError("ToolNotFound", `Tool ${toolName} is not visible on the ${this.surface} surface`, {
      tool: toolName,
      activeSurface: this.surface,
      activeToolProfile: this.profile
    });
  }
}

async function invokeRegisteredDefinition(
  definition: ToolDefinition,
  input: unknown,
  invoker: C2000ToolInvoker,
  controller: ToolCapabilityController,
  runtime: { getServerHealth?: () => Record<string, any> | Promise<Record<string, any>> }
): Promise<Record<string, unknown>> {
  if (definition.name === "c2000_listCapabilities") {
    return successResult(controller.listCapabilities());
  }
  if (definition.name === "c2000_openCapabilitySession") {
    return successResult(controller.openCapabilitySession(input as { capability: string; reason: string; ttlSeconds?: number; openedFrom?: CapabilitySessionContext; recommendationId?: string }));
  }
  if (definition.name === "c2000_closeCapabilitySession") {
    return successResult(controller.closeCapabilitySession(input as { sessionId: string; outcome?: CapabilitySessionOutcome }));
  }
  if (definition.name === "c2000_getToolContracts") {
    return successResult({
      tools: getToolContracts(controller.getExposureSummary().profile, controller.getExposureSummary().surface, controller.getExposureSummary().activeCapabilities),
      toolSurface: getToolSurfaceGuide(controller.getExposureSummary().profile, controller.getExposureSummary().surface, controller.getExposureSummary().activeCapabilities),
      ...toolProfilePayload(controller.getExposureSummary())
    });
  }
  if (definition.name === "c2000_getServerHealth" && runtime.getServerHealth) {
    const raw = await runtime.getServerHealth();
    return augmentServerHealthResult(raw, controller.getExposureSummary());
  }
  return invoker.invokeTool(definition.name, input);
}

function supportsDynamicMcpServer(server: McpServer): boolean {
  // The current MCP SDK exposes the list-changed notification and the
  // underlying public request-handler API. Do not depend on private SDK maps:
  // the registered tool's public `enabled` field controls tools/list, while
  // the public call handler below preserves a structured capability error for
  // clients that call a cached tool after its grant expires.
  return typeof server.sendToolListChanged === "function"
    && typeof server.server.setRequestHandler === "function";
}

function installDynamicMcpDispatch(
  server: McpServer,
  controller: ToolCapabilityController,
  registeredTools: Map<string, RegisteredTool>
): boolean {
  syncRegisteredToolMembership(controller, registeredTools);
  // McpServer does not expose a visibility predicate for its built-in
  // tools/list handler. Reinstall the public request handler with the same
  // SDK serialization rules, calculating membership at request time so lazy
  // TTL expiry is reflected even when a fake or stalled clock does not fire a
  // timer callback. This uses only public SDK APIs and no private handler map.
  server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: visibleRegisteredTools(controller, registeredTools)
  }));
  server.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    try {
      controller.assertToolVisible(request.params.name);
      const registered = registeredTools.get(request.params.name);
      if (!registered || typeof registered.handler !== "function") {
        throw new DebugMcpError("ToolNotFound", `Unknown C2000 tool: ${request.params.name}`, { toolName: request.params.name });
      }
      // All C2000 registrations use the regular callback form (task support is
      // forbidden). Calling the public RegisteredTool handler directly keeps
      // the SDK's normal tools/list membership while allowing the router to
      // return CapabilityRequired/CapabilityExpired for stale cached calls.
      return await registered.handler((request.params.arguments ?? {}) as any, extra as any) as any;
    } catch (error) {
      const result = failedInvocation(error, getInputSessionId(request.params.arguments));
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
        isError: true
      };
    }
  });
  return true;
}

function visibleRegisteredTools(
  controller: ToolCapabilityController,
  registeredTools: Map<string, RegisteredTool>
): Array<Record<string, unknown>> {
  const visibleNames = new Set(controller.visibleDefinitions().map(definition => definition.name));
  const tools: Array<Record<string, unknown>> = [];
  for (const [name, registered] of registeredTools) {
    if (!registered.enabled || !visibleNames.has(name)) continue;
    const inputSchema = registered.inputSchema ? normalizeObjectSchema(registered.inputSchema) : undefined;
    tools.push({
      name,
      ...(registered.title === undefined ? {} : { title: registered.title }),
      ...(registered.description === undefined ? {} : { description: registered.description }),
      inputSchema: inputSchema
        ? toJsonSchemaCompat(inputSchema, { strictUnions: true, pipeStrategy: "input" })
        : { type: "object", properties: {} },
      ...(registered.annotations === undefined ? {} : { annotations: registered.annotations }),
      ...(registered.execution === undefined ? {} : { execution: registered.execution }),
      ...(registered._meta === undefined ? {} : { _meta: registered._meta })
    });
  }
  return tools;
}

function syncRegisteredToolMembership(
  controller: ToolCapabilityController,
  registeredTools: Map<string, RegisteredTool>
): void {
  const visibleNames = new Set(controller.visibleDefinitions().map(definition => definition.name));
  for (const [name, registered] of registeredTools) {
    // `enabled` is a public RegisteredTool property. Assigning it avoids a
    // notification per tool; the caller emits one consolidated list-changed
    // notification after the capability set has been updated.
    registered.enabled = visibleNames.has(name);
  }
}

function toolProfilePayload(exposure: ToolExposureSummary) {
  return {
    activeToolProfile: exposure.profile,
    activeToolSurfaceProfile: exposure.surface,
    registeredToolCount: exposure.registeredToolCount,
    hiddenBySafetyCount: exposure.hiddenBySafetyCount,
    hiddenBySurfaceCount: exposure.hiddenBySurfaceCount,
    advancedOnlyCount: exposure.advancedOnlyCount,
    compatibilityOnlyCount: exposure.compatibilityOnlyCount,
    counts: {
      registered: exposure.registeredToolCount,
      hiddenBySafety: exposure.hiddenBySafetyCount,
      hiddenBySurface: exposure.hiddenBySurfaceCount,
      advancedOnly: exposure.advancedOnlyCount,
      compatibilityOnly: exposure.compatibilityOnlyCount,
      baseVisible: exposure.baseVisibleToolCount,
      capabilityVisible: exposure.capabilityVisibleToolCount
    },
    baseVisibleToolCount: exposure.baseVisibleToolCount,
    capabilityVisibleToolCount: exposure.capabilityVisibleToolCount,
    activeCapabilities: exposure.activeCapabilities,
    activeCapabilityCount: exposure.activeCapabilities.length,
    capabilityMode: "dynamic",
    hiddenTools: exposure.hiddenTools,
    hiddenAliases: exposure.hiddenAliases,
    surface: exposure.surface,
    profileReason: `Configured tool profile: ${exposure.profile}; configured tool surface: ${exposure.surface}`
  };
}

function successResult(body: Record<string, unknown>): Record<string, unknown> {
  return { success: true, timestamp: new Date().toISOString(), ...body };
}

function augmentServerHealthResult(raw: Record<string, any>, exposure: ToolExposureSummary): Record<string, unknown> {
  const result = raw.success === true ? { ...raw } : successResult(raw);
  const configuration = asRecord(result.configuration);
  const tools = asRecord(result.tools);
  return {
    ...result,
    configuration: {
      ...configuration,
      capabilityMode: "dynamic",
      activeCapabilityCount: exposure.activeCapabilities.length
    },
    tools: {
      ...tools,
      registeredCount: exposure.registeredToolCount,
      registeredNames: exposure.registered.map(definition => definition.name),
      activeCapabilityCount: exposure.activeCapabilities.length
    }
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function minimumProfileFor(definitions: ToolDefinition[]): ToolProfile {
  if (definitions.length === 0) return "full";
  const readonlyNames = new Set(definitionsForSafetyProfile("readonly").map(definition => definition.name));
  if (definitions.every(definition => readonlyNames.has(definition.name))) return "readonly";
  const safeNames = new Set(definitionsForSafetyProfile("safe").map(definition => definition.name));
  if (definitions.every(definition => safeNames.has(definition.name))) return "safe";
  return "full";
}

function isToolInvoker(value: DebugSessionManager | C2000ToolInvoker): value is C2000ToolInvoker {
  return typeof (value as C2000ToolInvoker).invokeTool === "function";
}

function getInputSessionId(input: unknown): string | undefined {
  return input && typeof input === "object" && typeof (input as { sessionId?: unknown }).sessionId === "string"
    ? (input as { sessionId: string }).sessionId
    : undefined;
}

function failedInvocation(error: unknown, sessionId?: string): Record<string, unknown> {
  return {
    success: false,
    timestamp: new Date().toISOString(),
    ...(sessionId ? { sessionId } : {}),
    error: toStructuredError(error)
  };
}

function recordToolOutcome(
  analytics: Pick<NonNullable<ToolHandlerDeps["outcomeAnalytics"]>, "recordToolInvocation"> | undefined,
  input: { toolName: string; input?: unknown; result?: Record<string, unknown>; error?: unknown; durationMs: number }
): void {
  try {
    analytics?.recordToolInvocation(input);
  } catch {
    // Optional analytics must never change a tool's functional result.
  }
}

export function getToolContracts(
  profile: ToolProfile = "full",
  surface: ToolSurfaceProfile = "compatibility",
  activeCapabilities: readonly ToolCapability[] = []
) {
  return getToolExposureSummary(profile, surface, activeCapabilities).registered.map(definition => {
    const inputFields = Object.keys(objectShape(definition.schema));
    return {
      name: definition.name,
      title: definition.title,
      description: definition.description,
      inputScope: definition.inputScope,
      targetEffect: definition.targetEffect,
      role: definition.role,
      family: definition.family,
      exposure: definition.exposure,
      capability: definition.capability,
      safetyAllowed: true,
      surfaceVisible: true,
      aliasOf: definition.aliasOf,
      preferred: definition.role !== "alias",
      effects: definition.effects,
      annotations: definition.annotations,
      approvalClass: definition.approvalClass,
      touchesTarget: definition.effects.some(effect => effect.startsWith("target-") || effect === "program-load" || effect === "ram-ownership-change"),
      writesTarget: definition.effects.some(effect => ["target-memory-write", "program-load", "ram-ownership-change"].includes(effect)),
      runsTarget: definition.effects.includes("target-run"),
      resetsTarget: definition.effects.includes("target-reset"),
      writesHostFiles: definition.effects.some(effect => effect === "host-write" || effect === "bundle-write" || effect === "repository-write" || effect === "repository-commit"),
      writesRepository: definition.effects.some(effect => effect === "repository-write" || effect === "repository-commit"),
      createsRepositoryCommit: definition.effects.includes("repository-commit"),
      changesRamOwnership: definition.effects.includes("ram-ownership-change"),
      inputFields,
      requiredInputFields: requiredInputFields(definition.schema),
      coreIdentityFields: definition.coreIdentityFields ?? [],
      responseCoreIdentityFields: definition.responseCoreIdentityFields ?? [],
      handlerName: definition.handlerName
    };
  });
}

/** Compact tool-surface guide for agents: prefer workflows, then primary atomics, avoid aliases when possible. */
export function getToolSurfaceGuide(
  profile: ToolProfile = "full",
  surface: ToolSurfaceProfile = "compatibility",
  activeCapabilities: readonly ToolCapability[] = []
) {
  const exposure = getToolExposureSummary(profile, surface, activeCapabilities);
  const tools = getToolContracts(profile, surface, activeCapabilities);
  const families = Array.from(new Set(tools.map(tool => tool.family))).sort();
  const aliases = tools
    .filter(tool => tool.role === "alias")
    .map(tool => ({ name: tool.name, useInstead: tool.aliasOf }));
  const hiddenAliases = c2000ToolDefinitions
    .filter(tool => tool.role === "alias" && !tools.some(registered => registered.name === tool.name))
    .map(tool => tool.name);
  const preferredWorkflows = tools.filter(tool => tool.role === "workflow").map(tool => tool.name);
  const preferredAtomics = tools
    .filter(tool => tool.role === "primary")
    .map(tool => tool.name);
  const surfaceGuidance = surface === "agent"
    ? [
        "Use the registered task-level workflow for the job first; the agent surface intentionally omits raw core control, program/load primitives, generic waits, and observability lifecycle tools.",
        "If the task genuinely needs manual core control, symbol/load control, generic waits, or profiling, call c2000_listCapabilities and open only the required short-lived capability; do not bypass this MCP through shell, CCS, or daemon RPC calls."
      ]
    : [
        "Prefer one workflow tool (c2000_launchAndRunIpcAcceptance, c2000_runIpcAcceptance, c2000_runBootHandoffDiagnosis, c2000_runReloadAndDiagnose, c2000_runFullDebugBundle) over long atomic chains.",
        "For single-step control prefer primary tools: c2000_runCore / c2000_haltCore (not c2000_continue / c2000_pause aliases)."
      ];
  return {
    surface,
    guidance: [
      ...surfaceGuidance,
      "c2000_continue and c2000_pause are compatibility aliases, not separate semantics; they are registered only on the compatibility surface.",
      "Use host tools (readiness/preflight/boundary) before target-touching acceptance.",
      "For daemon-routed hardware, call c2000_getDaemonHealth and c2000_listBoards first. If no board is registered, stop and call c2000_registerBoard; do not try alternate launch tools.",
      "Use F28P65x coreId 0 for C28xx_CPU1 and coreId 2 for C28xx_CPU2.",
      "Use exact CCS corePattern selectors C28xx_CPU1 and C28xx_CPU2; do not send regular expressions.",
      "For a CPU2 RAM image that requires CPU1 ownership initialization, explicitly use loadSequence.mode=cpu1-run-before-cpu2.",
      "When CPU1 firmware owns the CPU2 boot handoff, use runSequence.runMode=cpu1_boots_cpu2; MCP disconnects CPU2 while CPU1 runs and reconnects it before diagnosis.",
      "Set runSequence.runMode (or durable runIpcAcceptance.runMode) explicitly; when present it is authoritative and contradictory legacy runCpu1First/runCpu2 values are rejected.",
      "The workflow result reports cpu2StartAuthority: firmware-owned, debugger-owned, pre-running, or unspecified; unspecified means legacy flags were used and CPU2 startup ownership is not proven.",
      "Target reads may pause or perturb real-time execution on CCS; avoid high-rate c2000_evaluateMany, snapshots, or expression waits while judging UART/IPC timing.",
      "Do not combine runMode=cpu2_pre_running with loadSequence.mode=cpu1-run-before-cpu2; the server rejects this before target mutation.",
      ...(surface === "agent"
        ? ["Use c2000_runIpcAcceptance or c2000_launchAndRunIpcAcceptance for IPC startup; the task-level workflow performs the boot-handoff contract.", "Capability sessions are temporary and reason-bound. Open observability.dlog, observability.erad, observability.variables, debug.manual, debug.program, or debug.wait only when the task requires it; the active safety profile still filters every member tool."]
        : ["Use c2000_runIpcAcceptance or c2000_launchAndRunIpcAcceptance for IPC startup; launchMulticoreDebug followed by generic runCores does not perform the boot-handoff contract."]),
      ...(surface === "agent"
        ? []
        : ["For one-shot firmware hooks, set assignment.verification=write-only; ordinary assignments keep readback verification by default."]),
      ...(surface === "agent"
        ? ["If firmware is already resident in Flash, use the resident-image symbol path provided by the selected workflow; never substitute a program load for symbol-only loading."]
        : ["If firmware is already resident in Flash, use c2000_loadSymbols; do not use c2000_loadProgram as a symbol-only substitute."]),
      ...(surface === "agent"
        ? ["Repeated CPU2 Flash programming remains blocked before erase; use the selected workflow's resident-image path or explicitly authorize an intentional reprogram only through the advanced surface."]
        : ["Repeated CPU2 Flash programming is blocked before erase; use c2000_loadSymbols for resident images or explicitly set allowDestructiveFlashReload=true after confirming the intentional reprogram."]),
      "outputDir must be inside a configured allowedWriteRoots path; when omitted, workflow bundles use a timestamped directory under the first allowedWriteRoots entry. Program, map, and ccxml files must be inside allowedReadRoots.",
      ...(surface === "agent"
        ? []
        : [
            "Use c2000_runEngineeringVerification after code changes; treat Build, Map, Regression, Review, artifact completeness, and hard-gate failures as separate facts. Build PASS alone is not task completion.",
            "Verification is deterministic and host-observable; it never calls an LLM, accepts arbitrary shell text, or upgrades Mock evidence to Hardware evidence."
          ])
    ],
    families,
    preferredWorkflows,
    preferredAtomics,
    aliases,
    hiddenAliases,
    counts: {
      total: tools.length,
      primary: tools.filter(tool => tool.role === "primary").length,
      alias: aliases.length,
      workflow: preferredWorkflows.length,
      host: tools.filter(tool => tool.role === "host").length,
      diagnostic: tools.filter(tool => tool.role === "diagnostic").length
    },
    advancedOnly: exposure.advancedOnlyCount,
    compatibilityOnly: exposure.compatibilityOnlyCount,
    activeCapabilities: exposure.activeCapabilities,
    capabilityVisibleToolCount: exposure.capabilityVisibleToolCount
  };
}

/** Backwards-compatible helper: this function intentionally remains safety-only. */
export function definitionsForProfile(profile: ToolProfile): ToolDefinition[] {
  return definitionsForSafetyProfile(profile);
}

export function definitionsForSafetyProfile(profile: ToolProfile): ToolDefinition[] {
  if (profile === "full") return [...c2000ToolDefinitions];
  if (profile === "readonly") return c2000ToolDefinitions.filter(tool => tool.annotations.readOnlyHint);
  if (profile === "safe") {
    return c2000ToolDefinitions.filter(tool => !tool.effects.includes("fault-injection") && !tool.effects.includes("target-memory-write"));
  }
  throw new Error(`Invalid C2000 tool profile: ${String(profile)}`);
}

export function definitionsForSurfaceProfile(surface: ToolSurfaceProfile): ToolDefinition[] {
  if (surface === "compatibility") return [...c2000ToolDefinitions];
  if (surface === "advanced") return c2000ToolDefinitions.filter(tool => tool.exposure !== "compatibility");
  if (surface === "agent") return c2000ToolDefinitions.filter(tool => tool.exposure === "default");
  throw new Error(`Invalid C2000 tool surface profile: ${String(surface)}`);
}

/** Apply safety first, then intersect with the requested MCP surface. */
export function definitionsForExposure(profile: ToolProfile, surface: ToolSurfaceProfile): ToolDefinition[] {
  return definitionsForDynamicExposure(profile, surface, []);
}

/**
 * Apply safety first, then the configured base surface, then temporary
 * capability grants. Compatibility aliases never participate in a grant.
 */
export function definitionsForDynamicExposure(
  profile: ToolProfile,
  surface: ToolSurfaceProfile,
  activeCapabilities: readonly ToolCapability[] = []
): ToolDefinition[] {
  const safetyDefinitions = definitionsForSafetyProfile(profile);
  const active = new Set(activeCapabilities);
  const baseNames = new Set(definitionsForSurfaceProfile(surface).map(tool => tool.name));
  return safetyDefinitions.filter(tool => {
    if (baseNames.has(tool.name)) return true;
    return surface === "agent"
      && tool.exposure === "advanced"
      && tool.capability !== undefined
      && active.has(tool.capability);
  });
}

export function getToolExposureSummary(
  profile: ToolProfile,
  surface: ToolSurfaceProfile,
  activeCapabilities: readonly ToolCapability[] = [],
  activeCapabilitySessions: readonly CapabilitySession[] = []
): ToolExposureSummary {
  const safetyDefinitions = definitionsForSafetyProfile(profile);
  const baseVisible = definitionsForExposure(profile, surface);
  const registered = definitionsForDynamicExposure(profile, surface, activeCapabilities);
  const safetyNames = new Set(safetyDefinitions.map(tool => tool.name));
  const registeredNames = new Set(registered.map(tool => tool.name));
  const hiddenBySafetyCount = c2000ToolDefinitions.filter(tool => !safetyNames.has(tool.name)).length;
  const hiddenBySurfaceCount = safetyDefinitions.filter(tool => !registeredNames.has(tool.name)).length;
  const hiddenTools = c2000ToolDefinitions.filter(tool => !registeredNames.has(tool.name)).map(tool => tool.name);
  const advancedOnlyCount = safetyDefinitions.filter(tool => tool.exposure === "advanced" && !registeredNames.has(tool.name)).length;
  const compatibilityOnlyCount = safetyDefinitions.filter(tool => tool.exposure === "compatibility" && !registeredNames.has(tool.name)).length;
  return {
    profile,
    surface,
    registered,
    registeredToolCount: registered.length,
    hiddenBySafetyCount,
    hiddenBySurfaceCount,
    advancedOnlyCount,
    compatibilityOnlyCount,
    hiddenTools,
    hiddenAliases: c2000ToolDefinitions
      .filter(tool => tool.role === "alias" && !registeredNames.has(tool.name))
      .map(tool => tool.name),
    baseVisibleToolCount: baseVisible.length,
    capabilityVisibleToolCount: registered.filter(tool => !baseVisible.some(base => base.name === tool.name)).length,
    activeCapabilities: Array.from(new Set(activeCapabilities)),
    activeCapabilitySessions: activeCapabilitySessions.map(session => ({ ...session }))
  };
}

export function toolProfileFromEnv(): ToolProfile {
  const value = process.env.C2000_MCP_TOOL_PROFILE ?? "safe";
  return value === "readonly" || value === "full" ? value : "safe";
}

export function toolSurfaceProfileFromEnv(): ToolSurfaceProfile {
  const value = process.env.C2000_MCP_TOOL_SURFACE;
  if (value === undefined) return "agent";
  if (value === "agent" || value === "advanced" || value === "compatibility") return value;
  throw new Error(`Invalid C2000_MCP_TOOL_SURFACE value: ${value}. Expected agent, advanced, or compatibility.`);
}

function decorateDefinition(definition: BaseToolDefinition): ToolDefinition {
  const effects = effectsFor(definition.name, definition.targetEffect);
  const readOnlyHint = effects.every(effect => ["host-read", "target-read"].includes(effect));
  const destructiveHint = effects.some(effect => ["host-process-terminate", "target-reset", "target-memory-write", "ram-ownership-change", "fault-injection"].includes(effect));
  const exposure = exposureForDefinition(definition);
  return {
    ...definition,
    description: descriptionForExposure(definition, exposure),
    exposure,
    effects,
    annotations: { readOnlyHint, destructiveHint, idempotentHint: readOnlyHint, openWorldHint: false },
    approvalClass: readOnlyHint
      ? "read-only"
      : definition.targetEffect === "repository-control"
        ? effects.includes("repository-commit") ? "repository-commit" : "repository-write"
        : definition.targetEffect === "session-lifecycle" ? "session-lifecycle"
          : effects.includes("program-load") ? "program-load"
            : destructiveHint ? "target-mutation"
              : definition.targetEffect === "launch-workflow" ? "workflow-confirmation" : "target-control"
  };
}

function exposureForDefinition(definition: BaseToolDefinition): AgentExposure {
  if (definition.exposure) return definition.exposure;
  if (definition.role === "alias") return "compatibility";
  return "advanced";
}

function descriptionForExposure(definition: BaseToolDefinition, exposure: AgentExposure): string {
  if (exposure === "default") {
    return definition.role === "workflow" && !definition.description.startsWith("Preferred")
      ? `Preferred task-level entry point. ${definition.description}`
      : definition.description;
  }
  if (exposure === "compatibility") {
    return `Compatibility surface tool. ${definition.description}`;
  }
  if (definition.family === "observability") {
    return `Advanced observability tool. ${definition.description}`;
  }
  if (definition.family === "verification") {
    return `Advanced verification tool. ${definition.description}`;
  }
  if (definition.family === "analytics") {
    return `Advanced analytics tool. ${definition.description}`;
  }
  if (definition.family === "improvement") {
    return `Advanced improvement governance tool. ${definition.description}`;
  }
  if (definition.role === "diagnostic") {
    return `Advanced diagnostic tool. Prefer the task-level workflow when available. ${definition.description}`;
  }
  if (["session", "connectivity", "execution", "reset", "program", "write", "wait"].includes(definition.family)) {
    return `Advanced manual debug primitive. Prefer the task-level workflow when available. ${definition.description}`;
  }
  return `Advanced task-specific tool. Prefer the task-level workflow when available. ${definition.description}`;
}

function effectsFor(name: string, targetEffect: ToolTargetEffect): ToolEffect[] {
  if (targetEffect === "capability-control") return ["host-read"];
  if (targetEffect === "repository-control") {
    return name === "c2000_startImprovementImplementation"
      ? ["host-write", "repository-write", "repository-commit"]
      : ["host-write", "repository-write"];
  }
  if (targetEffect === "observation-control") {
    if (name === "c2000_verifyMap" || name === "c2000_verifyReview") return ["host-read", "bundle-write"];
    if (name === "c2000_exportTrace" || name === "c2000_collectFailureBundle" || name === "c2000_createRunBaseline" || name === "c2000_compareRunWithBaseline" || name === "c2000_createAcceptanceClosure") return ["host-read", "bundle-write"];
    if (name === "c2000_startVariableStream") return ["target-read", "bundle-write"];
    if (name === "c2000_exportVariableStream") return ["bundle-write"];
    if (name === "c2000_stopVariableStream") return ["host-write"];
    if (name === "c2000_exportDlog") return ["target-read", "bundle-write"];
    if (name === "c2000_describeDlogBuffer" || name === "c2000_getDlogStatus" || name === "c2000_readDlogBuffer") return ["target-read"];
    if (name === "c2000_exportEradProfile") return ["bundle-write"];
    if (name === "c2000_readEradProfile") return ["host-read"];
    return ["host-read"];
  }
  if (targetEffect === "host-read" || targetEffect === "session-read") return ["host-read"];
  if (name === "c2000_createDebugSession") return ["session-create", "host-process-terminate"];
  if (name === "c2000_closeDebugSession") return ["session-dispose"];
  if (targetEffect === "target-read") return ["target-read"];
  if (targetEffect === "connectivity-control") return [name.includes("disconnect") ? "target-disconnect" : "target-connect"];
  if (targetEffect === "reset-control") return ["target-reset"];
  if (targetEffect === "program-load") return ["program-load", "ram-ownership-change"];
  if (targetEffect === "symbol-load") return ["symbol-load"];
  if (targetEffect === "memory-write") return name.includes("injectFault") ? ["target-memory-write", "fault-injection"] : ["target-memory-write"];
  if (targetEffect === "job-control") {
    if (name === "c2000_recoverBoard") return ["host-process-terminate"];
    if (name === "c2000_exportTrace" || name === "c2000_collectFailureBundle" || name === "c2000_createRunBaseline" || name === "c2000_compareRunWithBaseline" || name === "c2000_createAcceptanceClosure" || name === "c2000_verifyMap" || name === "c2000_verifyReview") return ["host-read", "bundle-write"];
    return ["host-write"];
  }
  if (targetEffect === "execution-control") return [name.includes("halt") || name.includes("pause") ? "target-halt" : "target-run"];
  if (name === "c2000_runBootHandoffDiagnosis") return ["target-read"];
  if (name === "c2000_runFullDebugBundle") return ["target-read", "bundle-write"];
  if (name === "c2000_launchAndRunIpcAcceptance") return ["session-create", "host-process-terminate", "target-connect", "target-halt", "target-reset", "program-load", "ram-ownership-change", "target-run", "target-read"];
  if (name === "c2000_launchMulticoreDebugSafe") return ["session-create", "host-process-terminate", "target-connect", "program-load", "ram-ownership-change", "target-halt", "target-read"];
  if (name === "c2000_launchMulticoreDebug" || name === "c2000_launchMulticoreDebugWithActions") return ["session-create", "host-process-terminate", "target-connect", "program-load", "ram-ownership-change", "target-halt", "target-read", "target-memory-write", "fault-injection", "target-run"];
  return ["target-halt", "target-reset", "program-load", "ram-ownership-change", "target-run", "target-read"];
}

function requiredInputFields(schema: ZodObjectSchema): string[] {
  const parsed = schema.safeParse({});
  if (parsed.success) {
    return [];
  }
  return Array.from(new Set(parsed.error.issues
    .filter(issue => issue.path.length === 1)
    .map(issue => String(issue.path[0]))));
}

function objectShape(schema: ZodObjectSchema): z.AnyZodObject["shape"] {
  const value = schema as z.AnyZodObject & { _def?: { schema?: ZodObjectSchema; innerType?: ZodObjectSchema } };
  if (value.shape) return value.shape;
  if (value._def?.schema) return objectShape(value._def.schema);
  if (value._def?.innerType) return objectShape(value._def.innerType);
  return {};
}
