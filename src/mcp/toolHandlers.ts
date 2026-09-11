import type { z } from "zod";
import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DebugSessionManager } from "../debug/DebugSessionManager.js";
import type { ResetType } from "../debug/types.js";
import { createApplicationEntryPlan, waitForApplicationEntry } from "../debug/applicationEntry.js";
import { assertRunPauseAcceptanceSummary } from "../debug/runPauseAcceptance.js";
import { buildAcceptanceEvidencePlan, buildUiIndependenceEvidence, getDebugBoundary } from "../debug/boundary.js";
import { discoverAcceptancePrograms as discoverAcceptanceProgramsDefault, validateProgramPair } from "../hardware/programDiscovery.js";
import { analyzeRamOwnership as analyzeRamOwnershipDefault, type MapOwnershipInput } from "../hardware/mapOwnership.js";
import { formatDebugProcessOwners, runHardwarePreflight } from "../hardware/preflight.js";
import { DebugWorkflowService } from "../workflows/DebugWorkflowService.js";
import { MAX_WORKFLOW_POLL_ITERATIONS, resolveIpcStartupPreset, workflowPollIterations } from "../workflows/startupProfiles.js";
import { DebugMcpError, toStructuredError } from "../utils/errors.js";
import { buildBootHandoffVerdict as buildBootHandoffVerdictCore } from "../debug/bootHandoffVerdict.js";
import { valuesEqual as valuesEqualCore } from "../utils/expressionMatch.js";
import { sleep as sleepCore } from "../utils/async.js";
import { defaultIpcReadyConditions as defaultIpcReadyConditionsCore } from "../debug/defaultDiagnostics.js";
import { resolveTiEnvironment as resolveTiEnvironmentDefault, type ResolveTiEnvironmentOptions } from "../config/tiPaths.js";
import type { FilesystemPolicy } from "../security/pathPolicy.js";
import type { VerificationService } from "../verification/VerificationService.js";
import type { OutcomeAnalyticsService } from "../analytics/OutcomeAnalyticsService.js";
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
import {
  collectFailureBundleSchema,
  exportTraceSchema
} from "../observability/TraceSchemas.js";
import {
  compareRunWithBaselineSchema,
  createRunBaselineSchema
} from "../analytics/MetricSchemas.js";
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
  diagnoseBootHandoffSchema,
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
  reviewRollbackRecommendationSchema,
  getImprovementSystemScorecardSchema,
  generateEngineeringPolicyRecommendationsSchema,
  listEngineeringPolicyRecommendationsSchema,
  getEngineeringPolicyRecommendationSchema,
  reviewEngineeringPolicyRecommendationSchema
} from "./toolSchemas.js";

type ToolResult = Record<string, any>;

function assertBoundedWorkflowPolling(timeoutMs: number, intervalMs: number): void {
  const requestedPollIterations = workflowPollIterations(timeoutMs, intervalMs);
  if (requestedPollIterations > MAX_WORKFLOW_POLL_ITERATIONS) {
    throw new DebugMcpError("EvidenceLimitExceeded", `polling exceeds ${MAX_WORKFLOW_POLL_ITERATIONS} bounded iterations`, {
      timeoutMs,
      intervalMs,
      requestedPollIterations,
      maxPollIterations: MAX_WORKFLOW_POLL_ITERATIONS
    });
  }
}

export interface ToolHandlerDeps {
  /** Optional process-local recorder for standalone runtimes; daemon routing records centrally. */
  outcomeAnalytics?: Pick<OutcomeAnalyticsService, "recordToolInvocation">;
  /** Capability lifecycle audit recorder; kept separate to avoid double-recording daemon tool calls. */
  capabilityAudit?: Pick<OutcomeAnalyticsService, "recordCapabilityAudit">;
  runHardwarePreflight?: typeof runHardwarePreflight;
  /** Adapter mode resolved by the owning runtime; never infer it from config `auto`. */
  effectiveAdapterType?: "ccs" | "mock";
  discoverAcceptancePrograms?: typeof discoverAcceptanceProgramsDefault;
  analyzeRamOwnership?: typeof analyzeRamOwnershipDefault;
  getToolContracts?: () => ToolResult[];
  getToolSurfaceGuide?: () => ToolResult;
  listCapabilities?: () => Promise<ToolResult> | ToolResult;
  openCapabilitySession?: (input: z.input<typeof openCapabilitySessionSchema>) => Promise<ToolResult> | ToolResult;
  closeCapabilitySession?: (input: z.input<typeof closeCapabilitySessionSchema>) => Promise<ToolResult> | ToolResult;
  getWorkflowAnalytics?: (input: z.input<typeof getWorkflowAnalyticsSchema>) => Promise<ToolResult> | ToolResult;
  getToolAnalytics?: (input: z.input<typeof getToolAnalyticsSchema>) => Promise<ToolResult> | ToolResult;
  getCapabilityAnalytics?: (input: z.input<typeof getCapabilityAnalyticsSchema>) => Promise<ToolResult> | ToolResult;
  getEscalationRecommendations?: (input: z.input<typeof getEscalationRecommendationsSchema>) => Promise<ToolResult> | ToolResult;
  generateImprovementProposals?: (input: z.input<typeof generateImprovementProposalsSchema>) => Promise<ToolResult> | ToolResult;
  listImprovementProposals?: (input: z.input<typeof listImprovementProposalsSchema>) => Promise<ToolResult> | ToolResult;
  getImprovementProposal?: (input: z.input<typeof getImprovementProposalSchema>) => Promise<ToolResult> | ToolResult;
  reviewImprovementProposal?: (input: z.input<typeof reviewImprovementProposalSchema>) => Promise<ToolResult> | ToolResult;
  exportImprovementImplementationPrompt?: (input: z.input<typeof exportImprovementImplementationPromptSchema>) => Promise<ToolResult> | ToolResult;
  startImprovementImplementation?: (input: z.input<typeof startImprovementImplementationSchema>) => Promise<ToolResult> | ToolResult;
  getImprovementImplementationRun?: (input: z.input<typeof getImprovementImplementationRunSchema>) => Promise<ToolResult> | ToolResult;
  listImprovementImplementationRuns?: (input: z.input<typeof listImprovementImplementationRunsSchema>) => Promise<ToolResult> | ToolResult;
  getImprovementCandidate?: (input: z.input<typeof getImprovementCandidateSchema>) => Promise<ToolResult> | ToolResult;
  cleanupImprovementRun?: (input: z.input<typeof cleanupImprovementRunSchema>) => Promise<ToolResult> | ToolResult;
  publishImprovementCandidate?: (input: z.input<typeof publishImprovementCandidateSchema>) => Promise<ToolResult> | ToolResult;
  getImprovementPullRequest?: (input: z.input<typeof getImprovementPullRequestSchema>) => Promise<ToolResult> | ToolResult;
  refreshImprovementReviewEvidence?: (input: z.input<typeof refreshImprovementReviewEvidenceSchema>) => Promise<ToolResult> | ToolResult;
  getMergeRecommendation?: (input: z.input<typeof getMergeRecommendationSchema>) => Promise<ToolResult> | ToolResult;
  refreshReviewFeedback?: (input: z.input<typeof refreshReviewFeedbackSchema>) => Promise<ToolResult> | ToolResult;
  listReviewFeedback?: (input: z.input<typeof listReviewFeedbackSchema>) => Promise<ToolResult> | ToolResult;
  listRevisionProposals?: (input: z.input<typeof listRevisionProposalsSchema>) => Promise<ToolResult> | ToolResult;
  reviewRevisionProposal?: (input: z.input<typeof reviewRevisionProposalSchema>) => Promise<ToolResult> | ToolResult;
  publishRevisionCandidate?: (input: z.input<typeof publishRevisionCandidateSchema>) => Promise<ToolResult> | ToolResult;
  listPostMergeEvaluations?: (input: z.input<typeof listPostMergeEvaluationsSchema>) => Promise<ToolResult> | ToolResult;
  getPostMergeEvaluation?: (input: z.input<typeof getPostMergeEvaluationSchema>) => Promise<ToolResult> | ToolResult;
  refreshPostMergeEvaluation?: (input: z.input<typeof refreshPostMergeEvaluationSchema>) => Promise<ToolResult> | ToolResult;
  getRollbackRecommendation?: (input: z.input<typeof getRollbackRecommendationSchema>) => Promise<ToolResult> | ToolResult;
  reviewRollbackRecommendation?: (input: z.input<typeof reviewRollbackRecommendationSchema>) => Promise<ToolResult> | ToolResult;
  getImprovementSystemScorecard?: (input: z.input<typeof getImprovementSystemScorecardSchema>) => Promise<ToolResult> | ToolResult;
  generateEngineeringPolicyRecommendations?: (input: z.input<typeof generateEngineeringPolicyRecommendationsSchema>) => Promise<ToolResult> | ToolResult;
  listEngineeringPolicyRecommendations?: (input: z.input<typeof listEngineeringPolicyRecommendationsSchema>) => Promise<ToolResult> | ToolResult;
  getEngineeringPolicyRecommendation?: (input: z.input<typeof getEngineeringPolicyRecommendationSchema>) => Promise<ToolResult> | ToolResult;
  reviewEngineeringPolicyRecommendation?: (input: z.input<typeof reviewEngineeringPolicyRecommendationSchema>) => Promise<ToolResult> | ToolResult;
  getActiveCriticalImprovementRegression?: () => boolean;
  getDaemonHealth?: () => Promise<ToolResult> | ToolResult;
  listBoards?: (input: z.infer<typeof listBoardsSchema>) => Promise<ToolResult> | ToolResult;
  registerBoard?: (input: z.infer<typeof registerBoardSchema>) => Promise<ToolResult> | ToolResult;
  recoverBoard?: (input: z.infer<typeof recoverBoardSchema>) => Promise<ToolResult> | ToolResult;
  submitTestPlan?: (input: z.infer<typeof submitTestPlanSchema>) => Promise<ToolResult> | ToolResult;
  getTestRun?: (input: z.infer<typeof getTestRunSchema>) => Promise<ToolResult> | ToolResult;
  listTestRuns?: (input: z.infer<typeof listTestRunsSchema>) => Promise<ToolResult> | ToolResult;
  cancelTestRun?: (input: z.infer<typeof cancelTestRunSchema>) => Promise<ToolResult> | ToolResult;
  getTestArtifacts?: (input: z.infer<typeof getTestArtifactsSchema>) => Promise<ToolResult> | ToolResult;
  createAcceptanceClosure?: (input: z.infer<typeof createAcceptanceClosureSchema>) => Promise<ToolResult> | ToolResult;
  exportTrace?: (input: z.infer<typeof exportTraceSchema>) => Promise<ToolResult> | ToolResult;
  collectFailureBundle?: (input: z.infer<typeof collectFailureBundleSchema>) => Promise<ToolResult> | ToolResult;
  createRunBaseline?: (input: z.infer<typeof createRunBaselineSchema>) => Promise<ToolResult> | ToolResult;
  compareRunWithBaseline?: (input: z.infer<typeof compareRunWithBaselineSchema>) => Promise<ToolResult> | ToolResult;
  verification?: VerificationService;
  verifyBuild?: (input: z.input<typeof verifyBuildSchema>) => Promise<ToolResult> | ToolResult;
  verifyMap?: (input: z.input<typeof verifyMapSchema>) => Promise<ToolResult> | ToolResult;
  verifyRegression?: (input: z.input<typeof verifyRegressionSchema>) => Promise<ToolResult> | ToolResult;
  verifyReview?: (input: z.input<typeof verifyReviewSchema>) => Promise<ToolResult> | ToolResult;
  runEngineeringVerification?: (input: z.input<typeof runEngineeringVerificationSchema>) => Promise<ToolResult> | ToolResult;
  getVerificationResult?: (input: z.infer<typeof getVerificationResultSchema>) => Promise<ToolResult> | ToolResult;
  submitMultiBoardIpcAcceptance?: (input: z.infer<typeof submitMultiBoardIpcAcceptanceSchema>) => Promise<ToolResult> | ToolResult;
  submitMultiBoardCanAcceptance?: (input: z.infer<typeof submitMultiBoardCanAcceptanceSchema>) => Promise<ToolResult> | ToolResult;
  listCanProfiles?: (input: z.infer<typeof listCanProfilesSchema>) => Promise<ToolResult> | ToolResult;
  getBoardGroupSnapshot?: (input: z.infer<typeof getBoardGroupSnapshotSchema>) => Promise<ToolResult> | ToolResult;
  submitCanFaultCampaign?: (input: z.infer<typeof submitCanFaultCampaignSchema>) => Promise<ToolResult> | ToolResult;
  submitCanSoakTest?: (input: z.infer<typeof submitCanSoakTestSchema>) => Promise<ToolResult> | ToolResult;
  getToolProfile?: () => {
    activeToolProfile: string;
    activeToolSurfaceProfile?: string;
    registeredToolCount?: number;
    hiddenBySafetyCount?: number;
    hiddenBySurfaceCount?: number;
    advancedOnlyCount?: number;
    compatibilityOnlyCount?: number;
    baseVisibleToolCount?: number;
    capabilityVisibleToolCount?: number;
    activeCapabilities?: string[];
    activeCapabilityCount?: number;
    capabilityMode?: string;
    counts?: {
      registered: number;
      hiddenBySafety: number;
      hiddenBySurface: number;
      advancedOnly: number;
      compatibilityOnly: number;
      baseVisible?: number;
      capabilityVisible?: number;
    };
    hiddenTools: string[];
    hiddenAliases?: string[];
    surface?: string;
    profileReason: string;
  };
  getServerHealth?: () => Promise<ToolResult> | ToolResult;
  resolveTiEnvironment?: typeof resolveTiEnvironmentDefault;
  tiEnvironment?: ResolveTiEnvironmentOptions;
  programSearchRoots?: string[];
  filesystem?: FilesystemPolicy;
}

export function createToolHandlers(manager: DebugSessionManager, deps: ToolHandlerDeps = {}) {
  const hardwarePreflight = deps.runHardwarePreflight ?? runHardwarePreflight;
  const discoverAcceptancePrograms = deps.discoverAcceptancePrograms ?? discoverAcceptanceProgramsDefault;
  const analyzeRamOwnership = deps.analyzeRamOwnership ?? analyzeRamOwnershipDefault;
  const getToolContracts = deps.getToolContracts ?? (() => []);
  const getToolSurfaceGuide = deps.getToolSurfaceGuide ?? (() => ({}));
  const unavailableCapabilities = () => { throw new DebugMcpError("CapabilityUnknown", "Capability sessions are not configured in this runtime"); };
  const listCapabilities = deps.listCapabilities ?? unavailableCapabilities;
  const openCapabilitySession = deps.openCapabilitySession ?? unavailableCapabilities;
  const closeCapabilitySession = deps.closeCapabilitySession ?? unavailableCapabilities;
  const unavailableAnalytics = () => { throw new DebugMcpError("DaemonUnavailable", "Outcome analytics require the c2000-debugd analytics service"); };
  const getWorkflowAnalytics = deps.getWorkflowAnalytics ?? unavailableAnalytics;
  const getToolAnalytics = deps.getToolAnalytics ?? unavailableAnalytics;
  const getCapabilityAnalytics = deps.getCapabilityAnalytics ?? unavailableAnalytics;
  const getEscalationRecommendations = deps.getEscalationRecommendations ?? unavailableAnalytics;
  const unavailableImprovement = () => { throw new DebugMcpError("ImprovementAnalyticsUnavailable", "Improvement Proposals require the Outcome Analytics and Proposal services"); };
  const generateImprovementProposals = deps.generateImprovementProposals ?? unavailableImprovement;
  const listImprovementProposals = deps.listImprovementProposals ?? unavailableImprovement;
  const getImprovementProposal = deps.getImprovementProposal ?? unavailableImprovement;
  const reviewImprovementProposal = deps.reviewImprovementProposal ?? unavailableImprovement;
  const exportImprovementImplementationPrompt = deps.exportImprovementImplementationPrompt ?? unavailableImprovement;
  const unavailableImprovementImplementation = () => { throw new DebugMcpError("ImprovementImplementationUnavailable", "Approved improvement implementation is not configured in this runtime"); };
  const startImprovementImplementation = deps.startImprovementImplementation ?? unavailableImprovementImplementation;
  const getImprovementImplementationRun = deps.getImprovementImplementationRun ?? unavailableImprovementImplementation;
  const listImprovementImplementationRuns = deps.listImprovementImplementationRuns ?? unavailableImprovementImplementation;
  const getImprovementCandidate = deps.getImprovementCandidate ?? unavailableImprovementImplementation;
  const cleanupImprovementRun = deps.cleanupImprovementRun ?? unavailableImprovementImplementation;
  const publishImprovementCandidate = deps.publishImprovementCandidate ?? unavailableImprovementImplementation;
  const getImprovementPullRequest = deps.getImprovementPullRequest ?? unavailableImprovementImplementation;
  const refreshImprovementReviewEvidence = deps.refreshImprovementReviewEvidence ?? unavailableImprovementImplementation;
  const getMergeRecommendation = deps.getMergeRecommendation ?? unavailableImprovementImplementation;
  const refreshReviewFeedback = deps.refreshReviewFeedback ?? unavailableImprovementImplementation;
  const listReviewFeedback = deps.listReviewFeedback ?? unavailableImprovementImplementation;
  const listRevisionProposals = deps.listRevisionProposals ?? unavailableImprovementImplementation;
  const reviewRevisionProposal = deps.reviewRevisionProposal ?? unavailableImprovementImplementation;
  const publishRevisionCandidate = deps.publishRevisionCandidate ?? unavailableImprovementImplementation;
  const unavailablePostMergeEvaluation = () => { throw new DebugMcpError("PostMergeEvaluationUnavailable", "Post-merge evaluation service is not configured in this runtime"); };
  const listPostMergeEvaluations = deps.listPostMergeEvaluations ?? unavailablePostMergeEvaluation;
  const getPostMergeEvaluation = deps.getPostMergeEvaluation ?? unavailablePostMergeEvaluation;
  const refreshPostMergeEvaluation = deps.refreshPostMergeEvaluation ?? unavailablePostMergeEvaluation;
  const getRollbackRecommendation = deps.getRollbackRecommendation ?? unavailablePostMergeEvaluation;
  const reviewRollbackRecommendation = deps.reviewRollbackRecommendation ?? unavailablePostMergeEvaluation;
  const unavailableMetaAnalytics = () => { throw new DebugMcpError("ImprovementAnalyticsUnavailable", "Cross-improvement analytics require the Improvement history services"); };
  const getImprovementSystemScorecard = deps.getImprovementSystemScorecard ?? unavailableMetaAnalytics;
  const generateEngineeringPolicyRecommendations = deps.generateEngineeringPolicyRecommendations ?? unavailableMetaAnalytics;
  const listEngineeringPolicyRecommendations = deps.listEngineeringPolicyRecommendations ?? unavailableMetaAnalytics;
  const getEngineeringPolicyRecommendation = deps.getEngineeringPolicyRecommendation ?? unavailableMetaAnalytics;
  const reviewEngineeringPolicyRecommendation = deps.reviewEngineeringPolicyRecommendation ?? unavailableMetaAnalytics;
  const getDaemonHealth = deps.getDaemonHealth ?? (() => ({
    daemon: { available: false, reason: "This runtime is not hosted by c2000-debugd" },
    workers: { total: 0, healthy: 0, unhealthy: 0 },
    jobs: { queued: 0, running: 0 }
  }));
  const unavailableJobEngine = () => { throw new DebugMcpError("DaemonUnavailable", "Background test jobs require c2000-debugd"); };
  const unavailableRecovery = () => { throw new DebugMcpError("DaemonUnavailable", "Board recovery requires c2000-debugd"); };
  const unavailableRegistration = () => { throw new DebugMcpError("DaemonUnavailable", "Board registration requires c2000-debugd"); };
  const unavailableVariableStream = () => { throw new DebugMcpError("DaemonUnavailable", "Variable streaming requires c2000-debugd"); };
  const unavailableDlog = () => { throw new DebugMcpError("DaemonUnavailable", "DLOG buffer access requires c2000-debugd"); };
  const unavailableErad = () => { throw new DebugMcpError("DaemonUnavailable", "ERAD profiling requires c2000-debugd"); };
  const unavailableTrace = () => { throw new DebugMcpError("DaemonUnavailable", "Trace and failure bundle export require c2000-debugd"); };
  const listBoards = deps.listBoards ?? (() => ({ boards: [] }));
  const registerBoard = deps.registerBoard ?? unavailableRegistration;
  const recoverBoard = deps.recoverBoard ?? unavailableRecovery;
  const submitTestPlan = deps.submitTestPlan ?? unavailableJobEngine;
  const getTestRun = deps.getTestRun ?? unavailableJobEngine;
  const listTestRuns = deps.listTestRuns ?? unavailableJobEngine;
  const cancelTestRun = deps.cancelTestRun ?? unavailableJobEngine;
  const getTestArtifacts = deps.getTestArtifacts ?? unavailableJobEngine;
  const createAcceptanceClosure = deps.createAcceptanceClosure ?? unavailableJobEngine;
  const exportTrace = deps.exportTrace ?? unavailableTrace;
  const collectFailureBundle = deps.collectFailureBundle ?? unavailableTrace;
  const createRunBaseline = deps.createRunBaseline ?? unavailableJobEngine;
  const compareRunWithBaseline = deps.compareRunWithBaseline ?? unavailableJobEngine;
  const unavailableVerification = () => { throw new DebugMcpError("DaemonUnavailable", "Engineering verification service is not configured"); };
  const verifyBuild = deps.verifyBuild ?? (deps.verification ? (input: z.input<typeof verifyBuildSchema>) => deps.verification!.verifyBuild(input) : unavailableVerification);
  const verifyMap = deps.verifyMap ?? (deps.verification ? (input: z.input<typeof verifyMapSchema>) => deps.verification!.verifyMap(input) : unavailableVerification);
  const verifyRegression = deps.verifyRegression ?? (deps.verification ? (input: z.input<typeof verifyRegressionSchema>) => deps.verification!.verifyRegression(input) : unavailableVerification);
  const verifyReview = deps.verifyReview ?? (deps.verification ? (input: z.input<typeof verifyReviewSchema>) => deps.verification!.verifyReview(input) : unavailableVerification);
  const runEngineeringVerification = deps.runEngineeringVerification ?? (deps.verification ? (input: z.input<typeof runEngineeringVerificationSchema>) => deps.verification!.runEngineeringVerification(input) : unavailableVerification);
  const getVerificationResult = deps.getVerificationResult ?? (deps.verification ? (input: z.infer<typeof getVerificationResultSchema>) => deps.verification!.getVerificationResult(input) : unavailableVerification);
  const submitMultiBoardIpcAcceptance = deps.submitMultiBoardIpcAcceptance ?? unavailableJobEngine;
  const submitMultiBoardCanAcceptance = deps.submitMultiBoardCanAcceptance ?? unavailableJobEngine;
  const listCanProfiles = deps.listCanProfiles ?? unavailableJobEngine;
  const getBoardGroupSnapshot = deps.getBoardGroupSnapshot ?? unavailableJobEngine;
  const submitCanFaultCampaign = deps.submitCanFaultCampaign ?? unavailableJobEngine;
  const submitCanSoakTest = deps.submitCanSoakTest ?? unavailableJobEngine;
  const getToolProfile = deps.getToolProfile ?? (() => ({
    activeToolProfile: "full",
    activeToolSurfaceProfile: "compatibility",
    hiddenTools: [],
    hiddenAliases: [],
    counts: { registered: 0, hiddenBySafety: 0, hiddenBySurface: 0, advancedOnly: 0, compatibilityOnly: 0 },
    surface: "compatibility",
    profileReason: "All tools are available."
  }));
  const getServerHealth = deps.getServerHealth ?? (() => ({ status: "ready" }));
  const daemonRoutingConfigured = Boolean(deps.getDaemonHealth && deps.listBoards);
  const resolveTiEnvironment = deps.resolveTiEnvironment ?? resolveTiEnvironmentDefault;
  const configuredProgramSearchRoots = deps.programSearchRoots;
  const workflows = new DebugWorkflowService(manager, analyzeRamOwnership, deps.filesystem);
  const ok = (body: ToolResult = {}): ToolResult => ({ success: true, timestamp: new Date().toISOString(), ...body });
  const fail = (error: unknown, body: ToolResult = {}): ToolResult => ({
    success: false,
    timestamp: new Date().toISOString(),
    ...body,
    error: toStructuredError(error)
  });
  const failAtStage = (error: unknown, stage: string, body: ToolResult = {}): ToolResult => {
    const structured = toStructuredError(error);
    return {
      success: false,
      timestamp: new Date().toISOString(),
      ...body,
      error: {
        ...structured,
        details: {
          ...(structured.details ?? {}),
          stage,
          targetAccessAttempted: false
        }
      }
    };
  };
  const okBatch = (label: string, body: ToolResult): ToolResult => {
    const failed = Array.isArray(body.results)
      ? (body.results as Array<Record<string, any>>).filter(item => item.success === false)
      : [];
    if (failed.length === 0) {
      return ok(body);
    }
    return {
      success: false,
      timestamp: new Date().toISOString(),
      ...body,
      error: {
        code: "BatchOperationFailed",
        message: `${label} failed for ${failed.length} item(s)`,
        details: { failed }
      }
    };
  };

  return {
    async listCapabilities(_input: z.infer<typeof listCapabilitiesSchema>) {
      try {
        return ok(await listCapabilities());
      } catch (error) {
        return fail(error);
      }
    },

    async openCapabilitySession(input: z.input<typeof openCapabilitySessionSchema>) {
      try {
        return ok(await openCapabilitySession(openCapabilitySessionSchema.parse(input)));
      } catch (error) {
        return fail(error);
      }
    },

    async closeCapabilitySession(input: z.input<typeof closeCapabilitySessionSchema>) {
      try {
        return ok(await closeCapabilitySession(closeCapabilitySessionSchema.parse(input)));
      } catch (error) {
        return fail(error);
      }
    },

    async getWorkflowAnalytics(input: z.input<typeof getWorkflowAnalyticsSchema>) {
      try {
        return ok(await getWorkflowAnalytics(getWorkflowAnalyticsSchema.parse(input)));
      } catch (error) {
        return fail(error);
      }
    },

    async getToolAnalytics(input: z.input<typeof getToolAnalyticsSchema>) {
      try {
        return ok(await getToolAnalytics(getToolAnalyticsSchema.parse(input)));
      } catch (error) {
        return fail(error);
      }
    },

    async getCapabilityAnalytics(input: z.input<typeof getCapabilityAnalyticsSchema>) {
      try {
        return ok(await getCapabilityAnalytics(getCapabilityAnalyticsSchema.parse(input)));
      } catch (error) {
        return fail(error);
      }
    },

    async getEscalationRecommendations(input: z.input<typeof getEscalationRecommendationsSchema>) {
      try {
        return ok(await getEscalationRecommendations(getEscalationRecommendationsSchema.parse(input)));
      } catch (error) {
        return fail(error);
      }
    },

    async generateImprovementProposals(input: z.input<typeof generateImprovementProposalsSchema>) {
      try {
        return ok(await generateImprovementProposals(generateImprovementProposalsSchema.parse(input)));
      } catch (error) {
        return fail(error);
      }
    },

    async listImprovementProposals(input: z.input<typeof listImprovementProposalsSchema>) {
      try {
        return ok(await listImprovementProposals(listImprovementProposalsSchema.parse(input)));
      } catch (error) {
        return fail(error);
      }
    },

    async getImprovementProposal(input: z.input<typeof getImprovementProposalSchema>) {
      try {
        return ok(await getImprovementProposal(getImprovementProposalSchema.parse(input)));
      } catch (error) {
        return fail(error, { proposalId: input.proposalId });
      }
    },

    async reviewImprovementProposal(input: z.input<typeof reviewImprovementProposalSchema>) {
      try {
        return ok(await reviewImprovementProposal(reviewImprovementProposalSchema.parse(input)));
      } catch (error) {
        return fail(error, { proposalId: input.proposalId });
      }
    },

    async exportImprovementImplementationPrompt(input: z.input<typeof exportImprovementImplementationPromptSchema>) {
      try {
        return ok(await exportImprovementImplementationPrompt(exportImprovementImplementationPromptSchema.parse(input)));
      } catch (error) {
        return fail(error, { proposalId: input.proposalId });
      }
    },

    async startImprovementImplementation(input: z.input<typeof startImprovementImplementationSchema>) {
      try {
        return ok(await startImprovementImplementation(startImprovementImplementationSchema.parse(input)));
      } catch (error) {
        return fail(error, { ...(input.proposalId ? { proposalId: input.proposalId } : {}), ...(input.revisionProposalId ? { revisionProposalId: input.revisionProposalId } : {}) });
      }
    },

    async getImprovementImplementationRun(input: z.input<typeof getImprovementImplementationRunSchema>) {
      try {
        return ok(await getImprovementImplementationRun(getImprovementImplementationRunSchema.parse(input)));
      } catch (error) {
        return fail(error, { runId: input.runId });
      }
    },

    async listImprovementImplementationRuns(input: z.input<typeof listImprovementImplementationRunsSchema>) {
      try {
        return ok(await listImprovementImplementationRuns(listImprovementImplementationRunsSchema.parse(input)));
      } catch (error) {
        return fail(error);
      }
    },

    async getImprovementCandidate(input: z.input<typeof getImprovementCandidateSchema>) {
      try {
        return ok(await getImprovementCandidate(getImprovementCandidateSchema.parse(input)));
      } catch (error) {
        return fail(error, { runId: input.runId });
      }
    },

    async cleanupImprovementRun(input: z.input<typeof cleanupImprovementRunSchema>) {
      try {
        return ok(await cleanupImprovementRun(cleanupImprovementRunSchema.parse(input)));
      } catch (error) {
        return fail(error, { runId: input.runId });
      }
    },

    async publishImprovementCandidate(input: z.input<typeof publishImprovementCandidateSchema>) {
      try {
        return ok(await publishImprovementCandidate(publishImprovementCandidateSchema.parse(input)));
      } catch (error) {
        return fail(error, { implementationRunId: input.implementationRunId });
      }
    },

    async getImprovementPullRequest(input: z.input<typeof getImprovementPullRequestSchema>) {
      try {
        return ok(await getImprovementPullRequest(getImprovementPullRequestSchema.parse(input)));
      } catch (error) {
        return fail(error);
      }
    },

    async refreshImprovementReviewEvidence(input: z.input<typeof refreshImprovementReviewEvidenceSchema>) {
      try {
        return ok(await refreshImprovementReviewEvidence(refreshImprovementReviewEvidenceSchema.parse(input)));
      } catch (error) {
        return fail(error);
      }
    },

    async getMergeRecommendation(input: z.input<typeof getMergeRecommendationSchema>) {
      try {
        return ok(await getMergeRecommendation(getMergeRecommendationSchema.parse(input)));
      } catch (error) {
        return fail(error);
      }
    },

    async refreshReviewFeedback(input: z.input<typeof refreshReviewFeedbackSchema>) {
      try {
        return ok(await refreshReviewFeedback(refreshReviewFeedbackSchema.parse(input)));
      } catch (error) {
        return fail(error);
      }
    },

    async listReviewFeedback(input: z.input<typeof listReviewFeedbackSchema>) {
      try {
        return ok(await listReviewFeedback(listReviewFeedbackSchema.parse(input)));
      } catch (error) {
        return fail(error);
      }
    },

    async listRevisionProposals(input: z.input<typeof listRevisionProposalsSchema>) {
      try {
        return ok(await listRevisionProposals(listRevisionProposalsSchema.parse(input)));
      } catch (error) {
        return fail(error);
      }
    },

    async reviewRevisionProposal(input: z.input<typeof reviewRevisionProposalSchema>) {
      try {
        return ok(await reviewRevisionProposal(reviewRevisionProposalSchema.parse(input)));
      } catch (error) {
        return fail(error, { revisionProposalId: input.revisionProposalId });
      }
    },

    async publishRevisionCandidate(input: z.input<typeof publishRevisionCandidateSchema>) {
      try {
        return ok(await publishRevisionCandidate(publishRevisionCandidateSchema.parse(input)));
      } catch (error) {
        return fail(error, { revisionProposalId: input.revisionProposalId });
      }
    },

    async listPostMergeEvaluations(input: z.input<typeof listPostMergeEvaluationsSchema>) {
      try {
        return ok(await listPostMergeEvaluations(listPostMergeEvaluationsSchema.parse(input)));
      } catch (error) {
        return fail(error);
      }
    },

    async getPostMergeEvaluation(input: z.input<typeof getPostMergeEvaluationSchema>) {
      try {
        return ok(await getPostMergeEvaluation(getPostMergeEvaluationSchema.parse(input)));
      } catch (error) {
        return fail(error, { evaluationId: input.evaluationId });
      }
    },

    async refreshPostMergeEvaluation(input: z.input<typeof refreshPostMergeEvaluationSchema>) {
      try {
        return ok(await refreshPostMergeEvaluation(refreshPostMergeEvaluationSchema.parse(input)));
      } catch (error) {
        return fail(error, { evaluationId: input.evaluationId });
      }
    },

    async getRollbackRecommendation(input: z.input<typeof getRollbackRecommendationSchema>) {
      try {
        return ok(await getRollbackRecommendation(getRollbackRecommendationSchema.parse(input)));
      } catch (error) {
        return fail(error);
      }
    },

    async reviewRollbackRecommendation(input: z.input<typeof reviewRollbackRecommendationSchema>) {
      try {
        return ok(await reviewRollbackRecommendation(reviewRollbackRecommendationSchema.parse(input)));
      } catch (error) {
        return fail(error, { recommendationId: input.recommendationId });
      }
    },

    async getImprovementSystemScorecard(input: z.input<typeof getImprovementSystemScorecardSchema>) {
      try {
        return ok(await getImprovementSystemScorecard(getImprovementSystemScorecardSchema.parse(input)));
      } catch (error) {
        return fail(error);
      }
    },

    async generateEngineeringPolicyRecommendations(input: z.input<typeof generateEngineeringPolicyRecommendationsSchema>) {
      try {
        return ok(await generateEngineeringPolicyRecommendations(generateEngineeringPolicyRecommendationsSchema.parse(input)));
      } catch (error) {
        return fail(error);
      }
    },

    async listEngineeringPolicyRecommendations(input: z.input<typeof listEngineeringPolicyRecommendationsSchema>) {
      try {
        return ok(await listEngineeringPolicyRecommendations(listEngineeringPolicyRecommendationsSchema.parse(input)));
      } catch (error) {
        return fail(error);
      }
    },

    async getEngineeringPolicyRecommendation(input: z.input<typeof getEngineeringPolicyRecommendationSchema>) {
      try {
        return ok(await getEngineeringPolicyRecommendation(getEngineeringPolicyRecommendationSchema.parse(input)));
      } catch (error) {
        return fail(error, { recommendationId: input.recommendationId });
      }
    },

    async reviewEngineeringPolicyRecommendation(input: z.input<typeof reviewEngineeringPolicyRecommendationSchema>) {
      try {
        return ok(await reviewEngineeringPolicyRecommendation(reviewEngineeringPolicyRecommendationSchema.parse(input)));
      } catch (error) {
        return fail(error, { recommendationId: input.recommendationId });
      }
    },

    async getDaemonHealth(_input: z.infer<typeof daemonHealthSchema>) {
      try {
        return ok(await getDaemonHealth());
      } catch (error) {
        return fail(error);
      }
    },

    async listBoards(input: z.infer<typeof listBoardsSchema>) {
      try {
        return ok(await listBoards(input));
      } catch (error) {
        return fail(error);
      }
    },

    async registerBoard(input: z.infer<typeof registerBoardSchema>) {
      try {
        return ok(await registerBoard(input));
      } catch (error) {
        return fail(error, { boardId: input.boardId, probeSerial: input.probeSerial });
      }
    },

    async recoverBoard(input: z.infer<typeof recoverBoardSchema>) { try { return ok(await recoverBoard(input)); } catch (error) { return fail(error, { boardId: input.boardId }); } },

    async submitTestPlan(input: z.infer<typeof submitTestPlanSchema>) { try { return ok(await submitTestPlan(input)); } catch (error) { return fail(error); } },
    async getTestRun(input: z.infer<typeof getTestRunSchema>) { try { return ok(await getTestRun(input)); } catch (error) { return fail(error, { jobId: input.jobId }); } },
    async listTestRuns(input: z.infer<typeof listTestRunsSchema>) { try { return ok(await listTestRuns(input)); } catch (error) { return fail(error); } },
    async cancelTestRun(input: z.infer<typeof cancelTestRunSchema>) { try { return ok(await cancelTestRun(input)); } catch (error) { return fail(error, { jobId: input.jobId }); } },
    async getTestArtifacts(input: z.infer<typeof getTestArtifactsSchema>) { try { return ok(await getTestArtifacts(input)); } catch (error) { return fail(error, { jobId: input.jobId }); } },
    async createAcceptanceClosure(input: z.input<typeof createAcceptanceClosureSchema>) { try { return ok(await createAcceptanceClosure(createAcceptanceClosureSchema.parse(input))); } catch (error) { return fail(error, { jobId: input.jobId }); } },
    async exportTrace(input: z.input<typeof exportTraceSchema>) { try { return ok(await exportTrace(exportTraceSchema.parse(input))); } catch (error) { return fail(error, { jobId: input.jobId }); } },
    async collectFailureBundle(input: z.input<typeof collectFailureBundleSchema>) { try { return ok(await collectFailureBundle(collectFailureBundleSchema.parse(input))); } catch (error) { return fail(error, { jobId: input.jobId }); } },
    async createRunBaseline(input: z.input<typeof createRunBaselineSchema>) { try { return ok(await createRunBaseline(createRunBaselineSchema.parse(input))); } catch (error) { return fail(error, { jobId: input.jobId }); } },
    async compareRunWithBaseline(input: z.input<typeof compareRunWithBaselineSchema>) { try { return ok(await compareRunWithBaseline(compareRunWithBaselineSchema.parse(input))); } catch (error) { return fail(error, { jobId: input.jobId, baselineId: input.baselineId }); } },
    async verifyBuild(input: z.input<typeof verifyBuildSchema>) { try { return ok(await verifyBuild(verifyBuildSchema.parse(input))); } catch (error) { return fail(error, { verificationId: input.verificationId, jobId: input.jobId }); } },
    async verifyMap(input: z.input<typeof verifyMapSchema>) { try { return ok(await verifyMap(verifyMapSchema.parse(input))); } catch (error) { return fail(error, { verificationId: input.verificationId, jobId: input.jobId }); } },
    async verifyRegression(input: z.input<typeof verifyRegressionSchema>) { try { return ok(await verifyRegression(verifyRegressionSchema.parse(input))); } catch (error) { return fail(error, { verificationId: input.verificationId, jobId: input.jobId }); } },
    async verifyReview(input: z.input<typeof verifyReviewSchema>) { try { return ok(await verifyReview(verifyReviewSchema.parse(input))); } catch (error) { return fail(error, { verificationId: input.verificationId, jobId: input.jobId }); } },
    async runEngineeringVerification(input: z.input<typeof runEngineeringVerificationSchema>) { try { return ok(await runEngineeringVerification(runEngineeringVerificationSchema.parse(input))); } catch (error) { return fail(error, { verificationId: input.verificationId, jobId: input.jobId }); } },
    async getVerificationResult(input: z.infer<typeof getVerificationResultSchema>) { try { return ok(await getVerificationResult(getVerificationResultSchema.parse(input))); } catch (error) { return fail(error, { verificationId: input.verificationId }); } },
    async submitMultiBoardIpcAcceptance(input: z.infer<typeof submitMultiBoardIpcAcceptanceSchema>) { try { return ok(await submitMultiBoardIpcAcceptance(input)); } catch (error) { return fail(error); } },
    async submitMultiBoardCanAcceptance(input: z.infer<typeof submitMultiBoardCanAcceptanceSchema>) { try { return ok(await submitMultiBoardCanAcceptance(input)); } catch (error) { return fail(error); } },
    async listCanProfiles(input: z.infer<typeof listCanProfilesSchema>) { try { return ok(await listCanProfiles(input)); } catch (error) { return fail(error); } },
    async getBoardGroupSnapshot(input: z.infer<typeof getBoardGroupSnapshotSchema>) { try { return ok(await getBoardGroupSnapshot(input)); } catch (error) { return fail(error, { groupId: input.groupId }); } },
    async submitCanFaultCampaign(input: z.infer<typeof submitCanFaultCampaignSchema>) { try { return ok(await submitCanFaultCampaign(input)); } catch (error) { return fail(error); } },
    async submitCanSoakTest(input: z.infer<typeof submitCanSoakTestSchema>) { try { return ok(await submitCanSoakTest(input)); } catch (error) { return fail(error); } },
    async startVariableStream(input: z.input<typeof startVariableStreamSchema>) { try { startVariableStreamSchema.parse(input); return ok(await unavailableVariableStream()); } catch (error) { return fail(error); } },
    async stopVariableStream(input: z.input<typeof stopVariableStreamSchema>) { try { stopVariableStreamSchema.parse(input); return ok(await unavailableVariableStream()); } catch (error) { return fail(error); } },
    async getVariableStreamStatus(input: z.input<typeof getVariableStreamStatusSchema>) { try { getVariableStreamStatusSchema.parse(input); return ok(await unavailableVariableStream()); } catch (error) { return fail(error); } },
    async readVariableSamples(input: z.input<typeof readVariableSamplesSchema>) { try { readVariableSamplesSchema.parse(input); return ok(await unavailableVariableStream()); } catch (error) { return fail(error); } },
    async exportVariableStream(input: z.input<typeof exportVariableStreamSchema>) { try { exportVariableStreamSchema.parse(input); return ok(await unavailableVariableStream()); } catch (error) { return fail(error); } },
    async describeDlogBuffer(input: z.input<typeof dlogBufferRequestSchema>) { try { dlogBufferRequestSchema.parse(input); return ok(await unavailableDlog()); } catch (error) { return fail(error); } },
    async getDlogStatus(input: z.input<typeof dlogBufferRequestSchema>) { try { dlogBufferRequestSchema.parse(input); return ok(await unavailableDlog()); } catch (error) { return fail(error); } },
    async readDlogBuffer(input: z.input<typeof dlogBufferRequestSchema>) { try { dlogBufferRequestSchema.parse(input); return ok(await unavailableDlog()); } catch (error) { return fail(error); } },
    async exportDlog(input: z.input<typeof dlogBufferRequestSchema>) { try { dlogBufferRequestSchema.parse(input); return ok(await unavailableDlog()); } catch (error) { return fail(error); } },
    async getEradCapabilities(input: z.input<typeof getEradCapabilitiesSchema>) { try { getEradCapabilitiesSchema.parse(input); return ok(await unavailableErad()); } catch (error) { return fail(error); } },
    async configureEradProfile(input: z.input<typeof configureEradProfileSchema>) { try { configureEradProfileSchema.parse(input); return ok(await unavailableErad()); } catch (error) { return fail(error); } },
    async startEradProfile(input: z.input<typeof startEradProfileSchema>) { try { startEradProfileSchema.parse(input); return ok(await unavailableErad()); } catch (error) { return fail(error); } },
    async stopEradProfile(input: z.input<typeof stopEradProfileSchema>) { try { stopEradProfileSchema.parse(input); return ok(await unavailableErad()); } catch (error) { return fail(error); } },
    async readEradProfile(input: z.input<typeof readEradProfileSchema>) { try { readEradProfileSchema.parse(input); return ok(await unavailableErad()); } catch (error) { return fail(error); } },
    async exportEradProfile(input: z.input<typeof exportEradProfileSchema>) { try { exportEradProfileSchema.parse(input); return ok(await unavailableErad()); } catch (error) { return fail(error); } },
    async getServerHealth(_input: z.infer<typeof serverHealthSchema>) {
      try {
        return ok(await getServerHealth());
      } catch (error) {
        return fail(error);
      }
    },

    async getEnvironment(_input: z.infer<typeof environmentSchema>) {
      try {
        return ok(await resolveTiEnvironment(deps.tiEnvironment));
      } catch (error) {
        return fail(error);
      }
    },

    async getToolContracts(_input: z.infer<typeof toolContractsSchema>) {
      try {
        return ok({
          tools: getToolContracts(),
          toolSurface: getToolSurfaceGuide(),
          ...getToolProfile()
        });
      } catch (error) {
        return fail(error);
      }
    },

    async getDebugBoundary(_input: z.infer<typeof debugBoundarySchema>) {
      try {
        return ok(getDebugBoundary());
      } catch (error) {
        return fail(error);
      }
    },

    async getAcceptanceEvidence(_input: z.infer<typeof acceptanceEvidenceSchema>) {
      try {
        return ok(buildAcceptanceEvidencePlan());
      } catch (error) {
        return fail(error);
      }
    },

    async getHardwarePreflight(input: z.infer<typeof hardwarePreflightSchema>) {
      try {
        return ok(await hardwarePreflight({ ccsInstallPath: input.ccsInstallPath ?? deps.tiEnvironment?.ccsInstallPath }));
      } catch (error) {
        return fail(error);
      }
    },

    async discoverAcceptancePrograms(input: z.infer<typeof acceptanceProgramDiscoverySchema>) {
      try {
        return ok(await discoverAcceptancePrograms({
          cpu1Program: input.cpu1Program ?? process.env.C2000_CPU1_OUT,
          cpu2Program: input.cpu2Program ?? process.env.C2000_CPU2_OUT,
          searchRoots: input.searchRoots ?? programSearchRoots(configuredProgramSearchRoots),
          maxDepth: input.maxDepth
        }));
      } catch (error) {
        return fail(error);
      }
    },

    async getAcceptanceReadiness(input: z.input<typeof acceptanceReadinessSchema>) {
      let readinessStage = "input-validation";
      try {
        const waitForProbeMs = input.waitForProbeMs ?? 0;
        const probePollIntervalMs = input.probePollIntervalMs ?? 250;
        const ccxmlPath = input.ccxmlPath ?? process.env.C2000_MCP_CCXML_PATH;
        const allowExistingDebugProcesses = input.allowExistingDebugProcesses ?? process.env.C2000_ALLOW_EXISTING_DEBUG_PROCESSES === "1";
        readinessStage = "program-discovery";
        const programDiscovery = await discoverAcceptancePrograms({
          cpu1Program: input.cpu1Program ?? process.env.C2000_CPU1_OUT,
          cpu2Program: input.cpu2Program ?? process.env.C2000_CPU2_OUT,
          searchRoots: input.searchRoots ?? programSearchRoots(configuredProgramSearchRoots),
          maxDepth: input.maxDepth
        });
        const probeWaitStartedAt = Date.now();
        readinessStage = "hardware-preflight";
        let preflight = await hardwarePreflight({ ccsInstallPath: input.ccsInstallPath ?? deps.tiEnvironment?.ccsInstallPath });
        let probeWaitAttempts = 1;
        while (waitForProbeMs > 0
          && Date.now() - probeWaitStartedAt < waitForProbeMs
          && !preflightReady(preflight, allowExistingDebugProcesses)) {
          readinessStage = "hardware-preflight-wait";
          const remainingMs = waitForProbeMs - (Date.now() - probeWaitStartedAt);
          await sleepCore(Math.min(probePollIntervalMs, Math.max(1, remainingMs)));
          preflight = await hardwarePreflight({ ccsInstallPath: input.ccsInstallPath ?? deps.tiEnvironment?.ccsInstallPath });
          probeWaitAttempts++;
        }
        const probeWait = {
          requestedMs: waitForProbeMs,
          elapsedMs: Date.now() - probeWaitStartedAt,
          attempts: probeWaitAttempts,
          released: preflightReady(preflight, allowExistingDebugProcesses)
        };
        readinessStage = "debug-boundary";
        const debugBoundary = getDebugBoundary();
        const uiIndependenceEvidence = buildUiIndependenceEvidence(debugBoundary);
        const acceptanceEvidence = buildAcceptanceEvidencePlan();
        readinessStage = "artifact-pair-validation";
        const cpu1Program = discoveredProgramForCore(0, programDiscovery);
        const cpu2Program = discoveredProgramForCore(2, programDiscovery);
        const artifactPair = programDiscovery.pairing ?? validateProgramPair(cpu1Program, cpu2Program, "F28P65x");
        const debugProcessOwners = formatDebugProcessOwners(preflight);
        const hasDebugProcessOwners = preflight.debugProcessDetails.length > 0 || preflight.debugProcesses.length > 0;
        readinessStage = "daemon-health";
        const daemonHealth: ToolResult | undefined = daemonRoutingConfigured
          ? await Promise.resolve(getDaemonHealth()) as ToolResult
          : undefined;
        readinessStage = "board-route";
        const boardListing = daemonRoutingConfigured ? await Promise.resolve(listBoards({})) : undefined;
        const registeredBoards = Array.isArray(boardListing?.boards) ? boardListing.boards as ToolResult[] : [];
        const enumeratedProbeSerials = new Set(
          (Array.isArray(preflight.xdsdfu.devices) ? preflight.xdsdfu.devices : [])
            .map((device: ToolResult) => device.serialNumber)
            .filter((serialNumber: unknown): serialNumber is string => typeof serialNumber === "string" && serialNumber.length > 0)
        );
        const selectedBoards = registeredBoards.filter(board =>
          typeof board.probeSerial === "string" && enumeratedProbeSerials.has(board.probeSerial)
        );
        const readyBoards = selectedBoards.filter(board => board.status === "READY" && !board.currentLeaseId);
        const boardConcurrency = daemonHealth?.boardConcurrency as ToolResult | undefined;
        const workers = daemonHealth?.workers as ToolResult | undefined;
        const workersHealthy = typeof workers?.healthy === "number" && workers.healthy > 0;
        const concurrencyAvailable = typeof boardConcurrency?.limit === "number"
          && typeof boardConcurrency?.active === "number"
          && boardConcurrency.limit > 0
          && boardConcurrency.active < boardConcurrency.limit;
        const daemonRoute = daemonRoutingConfigured
          ? {
            applicable: true,
            ok: registeredBoards.length > 0
              && selectedBoards.length > 0
              && readyBoards.length > 0
              && workersHealthy
              && concurrencyAvailable,
            enumeratedProbeSerials: [...enumeratedProbeSerials],
            registeredBoardIds: registeredBoards.map(board => board.boardId),
            selectedBoards: selectedBoards.map(board => ({
              boardId: board.boardId,
              probeSerial: board.probeSerial,
              status: board.status,
              currentLeaseId: board.currentLeaseId,
              workerInstanceId: board.currentWorkerInstanceId
            })),
            workers,
            boardConcurrency,
            nextTool: registeredBoards.length === 0
              ? "c2000_registerBoard"
              : readyBoards.length === 0
                ? "c2000_listBoards"
                : undefined
          }
          : { applicable: false, ok: true, reason: "Readiness is running without the c2000-debugd board router." };
        readinessStage = "host-readiness-checks";
        const checks = {
          ccxml: await hostFileCheck(ccxmlPath, "C2000_MCP_CCXML_PATH or ccxmlPath is required"),
          cpu1Program: await hostFileCheck(cpu1Program, "CPU1 .out program was not discovered"),
          cpu2Program: await hostFileCheck(cpu2Program, "CPU2 .out program was not discovered"),
          artifactPair: {
            ok: artifactPair.compatible,
            ...artifactPair
          },
          xds110: {
            ok: preflight.xdsdfu.probeReady ?? (preflight.xdsdfu.ok === true && Array.isArray(preflight.xdsdfu.devices) && preflight.xdsdfu.devices.length > 0),
            commandOk: preflight.xdsdfu.commandOk ?? preflight.xdsdfu.ok,
            probeReady: preflight.xdsdfu.probeReady ?? (Array.isArray(preflight.xdsdfu.devices) && preflight.xdsdfu.devices.length > 0),
            attempts: preflight.xdsdfu.attempts,
            xdsdfuPath: preflight.xdsdfuPath,
            devices: preflight.xdsdfu.devices ?? [],
            error: preflight.xdsdfu.error
          },
          debugProcessOwnership: {
            ok: preflight.processInspection?.ok !== false && (!hasDebugProcessOwners || allowExistingDebugProcesses),
            inspection: preflight.processInspection,
            owners: debugProcessOwners,
            overrideAccepted: hasDebugProcessOwners && allowExistingDebugProcesses,
            details: preflight.debugProcessDetails
          },
          debugBoundary: {
            ok: debugBoundary.officialTiMcpDebugControlsUsed === false
              && debugBoundary.activeTargetAllowed === false
              && debugBoundary.uiFocusRequired === false
              && debugBoundary.selectedCpuRequired === false,
            officialTiMcpDebugControlsUsed: debugBoundary.officialTiMcpDebugControlsUsed,
            activeTargetAllowed: debugBoundary.activeTargetAllowed,
            uiFocusRequired: debugBoundary.uiFocusRequired,
            selectedCpuRequired: debugBoundary.selectedCpuRequired
          },
          daemonRoute
        };
        const blockers = acceptanceBlockers(checks);
        const warnings = acceptanceWarnings(checks);
        return ok({
          readyForHardwareAcceptance: blockers.length === 0,
          blockers,
          warnings,
          checks,
          programDiscovery,
          preflight,
          probeWait,
          debugBoundary,
          uiIndependenceEvidence,
          acceptanceEvidence,
          nextCommand: hardwareAcceptanceCommand({
            ccsInstallPath: input.ccsInstallPath,
            ccxmlPath,
            cpu1Program,
            cpu2Program,
            allowExistingDebugProcesses
          })
        });
      } catch (error) {
        return failAtStage(error, readinessStage);
      }
    },

    async analyzeRamOwnership(input: z.infer<typeof ramOwnershipAnalysisSchema>) {
      try {
        return ok(await analyzeRamOwnership(input));
      } catch (error) {
        return fail(error);
      }
    },

    async createDebugSession(input: z.input<typeof createDebugSessionSchema>) {
      try {
        const result = await manager.createDebugSession({
          sessionName: input.sessionName,
          ccxmlPath: input.ccxmlPath,
          coreMap: input.coreMap,
          probeId: input.probeId,
          preferredProbeIds: input.preferredProbeIds,
          allowAutoProbeAllocation: input.allowAutoProbeAllocation
        });
        return ok({ ...result, cores: result.cores.map(core => ({ coreId: core.coreId, coreName: core.coreName })) });
      } catch (error) {
        return fail(error);
      }
    },

    async listCores(input: z.infer<typeof sessionSchema>) {
      try {
        return ok({ sessionId: input.sessionId, cores: await manager.listCores(input.sessionId) });
      } catch (error) {
        return fail(error, { sessionId: input.sessionId });
      }
    },

    async getSessionTopology(input: z.infer<typeof sessionSchema>) {
      try {
        return ok(await manager.getSessionTopology(input.sessionId));
      } catch (error) {
        return fail(error, { sessionId: input.sessionId });
      }
    },

    async closeDebugSession(input: z.infer<typeof sessionSchema>) {
      try {
        return ok(await manager.closeDebugSession(input.sessionId));
      } catch (error) {
        return fail(error, { sessionId: input.sessionId });
      }
    },

    async connectTarget(input: z.infer<typeof sessionCoreSchema>) {
      return targetStateResult(input, () => manager.connectTarget(input.sessionId, input.coreId));
    },

    async disconnectTarget(input: z.infer<typeof sessionCoreSchema>) {
      return targetStateResult(input, () => manager.disconnectTarget(input.sessionId, input.coreId));
    },

    async runCore(input: z.infer<typeof sessionCoreSchema>) {
      return targetStateResult(input, () => manager.runCore(input.sessionId, input.coreId));
    },

    async continue(input: z.infer<typeof sessionCoreSchema>) {
      return targetStateResult(input, () => manager.runCore(input.sessionId, input.coreId));
    },

    async haltCore(input: z.infer<typeof sessionCoreSchema>) {
      return targetStateResult(input, () => manager.haltCore(input.sessionId, input.coreId));
    },

    async pause(input: z.infer<typeof sessionCoreSchema>) {
      return targetStateResult(input, () => manager.haltCore(input.sessionId, input.coreId));
    },

    async resetCore(input: z.infer<typeof resetCoreSchema>) {
      return targetStateResult(input, () => manager.resetCore(input.sessionId, input.coreId, input.resetType as ResetType));
    },

    async getTargetState(input: z.infer<typeof sessionCoreSchema>) {
      return targetStateResult(input, () => manager.getTargetState(input.sessionId, input.coreId));
    },

    async loadProgram(input: z.infer<typeof loadProgramSchema>) {
      try {
        const loaded = await manager.loadPrograms(input.sessionId, [{
          coreId: input.coreId,
          programUri: input.programUri,
          mapUri: input.mapUri,
          ramOwnershipPolicy: input.ramOwnershipPolicy,
          fallbackGsRegions: input.fallbackGsRegions,
          loadPolicy: input.loadPolicy,
          allowDestructiveFlashReload: input.allowDestructiveFlashReload
        }]);
        const result = loaded.results[0] as ToolResult | undefined;
        if (!result || result.success !== true) {
          return {
            success: false,
            timestamp: new Date().toISOString(),
            sessionId: input.sessionId,
            coreId: input.coreId,
            ...(result ?? {
              error: {
                code: "ProgramLoadFailed",
                message: "Program load returned no per-core result"
              }
            })
          };
        }
        return ok(result);
      } catch (error) {
        return fail(error, { sessionId: input.sessionId, coreId: input.coreId });
      }
    },

    async loadSymbols(input: z.infer<typeof loadSymbolsSchema>) {
      try {
        return ok(await manager.loadSymbols(input.sessionId, input.coreId, input.programUri));
      } catch (error) {
        return fail(error, { sessionId: input.sessionId, coreId: input.coreId, targetMemoryWritten: false });
      }
    },

    async loadPrograms(input: z.infer<typeof loadProgramsSchema>) {
      try {
        return okBatch("c2000_loadPrograms", await manager.loadPrograms(input.sessionId, input.programs));
      } catch (error) {
        return fail(error, { sessionId: input.sessionId });
      }
    },

    async connectCores(input: z.infer<typeof batchCoresSchema>) {
      return batchResult(input.sessionId, () => manager.connectCores(input.sessionId, input.coreIds));
    },

    async haltCores(input: z.infer<typeof batchCoresSchema>) {
      return batchResult(input.sessionId, () => manager.haltCores(input.sessionId, input.coreIds));
    },

    async resetCores(input: z.infer<typeof resetCoresSchema>) {
      return batchResult(input.sessionId, () => manager.resetCores(input.sessionId, input.coreIds, input.resetType as ResetType));
    },

    async runCores(input: z.infer<typeof batchCoresSchema>) {
      return batchResult(input.sessionId, () => manager.runCores(input.sessionId, input.coreIds));
    },

    async getMulticoreSnapshot(input: z.infer<typeof multicoreSnapshotSchema>) {
      try {
        return ok(await manager.getMulticoreSnapshot(input.sessionId, input.coreIds));
      } catch (error) {
        return fail(error, { sessionId: input.sessionId });
      }
    },

    async evaluateMany(input: z.infer<typeof evaluateManySchema>) {
      try {
        const coreName = await resolveCoreName(input.sessionId, input.coreId);
        return ok({
          sessionId: input.sessionId,
          coreId: input.coreId,
          coreName,
          results: await manager.evaluateMany(input.sessionId, input.coreId, input.expressions)
        });
      } catch (error) {
        return fail(error, { sessionId: input.sessionId, coreId: input.coreId });
      }
    },

    async assignExpression(input: z.input<typeof assignExpressionSchema>) {
      try {
        const parsed = assignExpressionSchema.parse(input);
        const assignment = normalizeExpressionAssignment(parsed);
        return ok(await manager.assignExpression(parsed.sessionId, assignment.coreId, assignment.expression, assignment.value, assignment.verify));
      } catch (error) {
        return fail(error, { sessionId: input.sessionId, coreId: input.coreId });
      }
    },

    async assignExpressions(input: z.input<typeof assignExpressionsSchema>) {
      try {
        const parsed = assignExpressionsSchema.parse(input);
        return okBatch("c2000_assignExpressions", await manager.assignExpressions(parsed.sessionId, parsed.assignments.map(normalizeExpressionAssignment)));
      } catch (error) {
        return fail(error, { sessionId: input.sessionId });
      }
    },

    async injectFaults(input: z.input<typeof injectFaultsSchema>) {
      try {
        const parsed = injectFaultsSchema.parse(input);
        return okBatch("c2000_injectFaults", await manager.injectFaults(parsed.sessionId, parsed.faults.map(fault => ({ ...normalizeExpressionAssignment(fault), ...(fault.label ? { label: fault.label } : {}) }))));
      } catch (error) {
        return fail(error, { sessionId: input.sessionId });
      }
    },

    async compareExpressions(input: z.infer<typeof compareExpressionsSchema>) {
      try {
        return ok(await manager.compareExpressions(input.sessionId, input.comparisons));
      } catch (error) {
        return fail(error, { sessionId: input.sessionId });
      }
    },

    async getLoadedProgramInfo(input: z.infer<typeof sessionCoreSchema>) {
      try {
        const coreName = await resolveCoreName(input.sessionId, input.coreId);
        const info = await manager.getLoadedProgramInfo(input.sessionId, input.coreId);
        if (!info) {
          return ok({
            sessionId: input.sessionId,
            coreId: input.coreId,
            coreName,
            warning: "No program was loaded through this MCP for this core. CCS GUI-loaded program information is not trusted by this registry."
          });
        }
        return ok(info as unknown as ToolResult);
      } catch (error) {
        return fail(error, { sessionId: input.sessionId, coreId: input.coreId });
      }
    },

    async resolvePc(input: z.infer<typeof sessionCoreSchema>) {
      try {
        const coreName = await resolveCoreName(input.sessionId, input.coreId);
        return ok({ sessionId: input.sessionId, coreId: input.coreId, coreName, ...(await manager.resolvePc(input.sessionId, input.coreId)) });
      } catch (error) {
        return fail(error, { sessionId: input.sessionId, coreId: input.coreId });
      }
    },

    async resolveAddress(input: z.infer<typeof resolveAddressSchema>) {
      try {
        const coreName = await resolveCoreName(input.sessionId, input.coreId);
        return ok({ sessionId: input.sessionId, coreId: input.coreId, coreName, ...(await manager.resolveAddress(input.sessionId, input.coreId, input.address)) });
      } catch (error) {
        return fail(error, { sessionId: input.sessionId, coreId: input.coreId, address: input.address });
      }
    },

    async waitUntilExpression(input: z.infer<typeof waitUntilExpressionSchema>) {
      let coreName: string | undefined;
      try {
        coreName = await resolveCoreName(input.sessionId, input.coreId);
      } catch (error) {
        return fail(error, { sessionId: input.sessionId, coreId: input.coreId });
      }
      const deadline = Date.now() + input.timeoutMs;
      let lastResult: unknown;
      while (Date.now() <= deadline) {
        const results = await manager.evaluateMany(input.sessionId, input.coreId, [input.expression]);
        lastResult = results[0];
        if (results[0]?.success && valuesEqual(results[0].value, input.expected)) {
          return ok({
            sessionId: input.sessionId,
            coreId: input.coreId,
            coreName,
            expression: input.expression,
            matched: true,
            result: results[0]
          });
        }
        await sleep(input.intervalMs);
      }
      return {
        success: false,
        timestamp: new Date().toISOString(),
        sessionId: input.sessionId,
        coreId: input.coreId,
        coreName,
        expression: input.expression,
        expected: input.expected,
        timedOut: true,
        lastResult
      };
    },

    async waitForExpressionSet(input: z.input<typeof waitForExpressionSetSchema>) {
      const parsed = waitForExpressionSetSchema.parse(input);
      assertBoundedWorkflowPolling(parsed.timeoutMs, parsed.intervalMs);
      const startedAt = performance.now();
      const deadline = startedAt + parsed.timeoutMs;
      let lastConditions: ToolResult[] = [];
      let firstFailure: ToolResult | undefined;
      let pollIterations = 0;
      let expressionBatchCalls = 0;
      let expressionCount = 0;
      const uniqueExpressionsPerPoll = new Set(parsed.conditions.map(condition => `${condition.coreId}:${condition.expression}`)).size;
      while (performance.now() <= deadline) {
        pollIterations++;
        const evaluated = await evaluateConditions(parsed.sessionId, parsed.conditions);
        lastConditions = evaluated.conditions;
        expressionBatchCalls += evaluated.expressionBatchCalls;
        expressionCount += uniqueExpressionsPerPoll;
        if (lastConditions.every(condition => condition.matched)) {
          const pollDurationMs = performance.now() - startedAt;
          return ok({
            sessionId: parsed.sessionId,
            matched: true,
            timedOut: false,
            conditions: lastConditions,
            pollIterations,
            expressionBatchCalls,
            expressionCount,
            pollDurationMs,
            matchedAtMs: pollDurationMs,
            ...(firstFailure ? { firstFailure } : {})
          });
        }
        if (!firstFailure) {
          firstFailure = {
            pollIteration: pollIterations,
            elapsedMs: performance.now() - startedAt,
            conditions: lastConditions.filter(condition => condition.matched !== true)
          };
        }
        const remainingMs = deadline - performance.now();
        if (remainingMs <= 0) break;
        await sleep(Math.min(parsed.intervalMs, remainingMs));
      }
      return {
        success: false,
        timestamp: new Date().toISOString(),
        sessionId: parsed.sessionId,
        matched: false,
        timedOut: true,
        conditions: lastConditions,
        pollIterations,
        expressionBatchCalls,
        expressionCount,
        pollDurationMs: performance.now() - startedAt,
        ...(firstFailure ? { firstFailure } : {})
      };
    },

    async diagnoseCpu2Boot(input: z.input<typeof diagnoseCpu2BootSchema>) {
      try {
        const parsed = diagnoseCpu2BootSchema.parse(input);
        return ok(await manager.diagnoseCpu2Boot(parsed));
      } catch (error) {
        return fail(error, { sessionId: input.sessionId });
      }
    },

    async diagnoseBootHandoff(input: z.input<typeof diagnoseBootHandoffSchema>) {
      try {
        const parsed = diagnoseBootHandoffSchema.parse(input);
        const boot = await manager.diagnoseCpu2Boot(parsed);
        const ramOwnership = parsed.maps ? await analyzeRamOwnership({ maps: parsed.maps }) : undefined;
        return ok({
          ...boot,
          ...(ramOwnership ? { ramOwnership } : {}),
          verdict: buildBootHandoffVerdict(boot, ramOwnership)
        });
      } catch (error) {
        return fail(error, { sessionId: input.sessionId });
      }
    },

    async waitForIpcReady(input: z.input<typeof waitForIpcReadySchema>) {
      try {
        const parsed = waitForIpcReadySchema.parse(input);
        const conditions = parsed.conditions ?? defaultIpcReadyConditions(parsed.cpu1CoreId, parsed.cpu2CoreId);
        const result = await waitForExpressionSetResult(parsed.sessionId, conditions, parsed.timeoutMs, parsed.intervalMs);
        return result.matched
          ? ok({ ...result, defaultConditionsUsed: parsed.conditions === undefined })
          : { success: false, timestamp: new Date().toISOString(), ...result, defaultConditionsUsed: parsed.conditions === undefined };
      } catch (error) {
        return fail(error, { sessionId: input.sessionId });
      }
    },

    async reloadResetRunToMain(input: z.input<typeof reloadResetRunToMainSchema>) {
      try {
        const parsed = reloadResetRunToMainSchema.parse(input);
        const mapAnalysis = parsed.mapUri
          ? await analyzeRamOwnership({
            maps: [{
              coreId: parsed.coreId,
              mapPath: manager.normalizeArtifactUri(parsed.mapUri)
            }]
          })
          : undefined;
        const applicationEntryPlan = createApplicationEntryPlan({
          coreId: parsed.coreId,
          explicitAddress: parsed.entryAddress,
          map: mapAnalysis?.maps[0]
        });
        const load = await manager.loadPrograms(parsed.sessionId, [{
          coreId: parsed.coreId,
          programUri: parsed.programUri,
          mapUri: parsed.mapUri,
          ramOwnershipPolicy: parsed.ramOwnershipPolicy,
          fallbackGsRegions: parsed.fallbackGsRegions,
          loadPolicy: parsed.loadPolicy,
          allowDestructiveFlashReload: parsed.allowDestructiveFlashReload
        }]);
        const loadedProgram = load.results[0] as ToolResult | undefined;
        if (!loadedProgram || loadedProgram.success !== true) {
          throw new DebugMcpError("BatchOperationFailed", "Reload workflow program step failed", {
            sessionId: parsed.sessionId,
            coreId: parsed.coreId,
            failed: loadedProgram
          });
        }
        const reset = await manager.resetCore(parsed.sessionId, parsed.coreId, parsed.resetType as ResetType);
        if (parsed.settleMs > 0) {
          await sleep(parsed.settleMs);
        }
        const run = await manager.runCore(parsed.sessionId, parsed.coreId);
        const applicationEntry = applicationEntryPlan.configured
          ? await waitForApplicationEntry(manager, {
            sessionId: parsed.sessionId,
            plan: applicationEntryPlan,
            timeoutMs: parsed.entryTimeoutMs,
            intervalMs: Math.min(parsed.entryTimeoutMs, 100)
          })
          : undefined;
        if (applicationEntry && !applicationEntry.reached) {
          let halt: ToolResult;
          try {
            halt = await manager.haltCore(parsed.sessionId, parsed.coreId);
          } catch (error) {
            halt = { success: false, error: toStructuredError(error) };
          }
          throw new DebugMcpError("ApplicationEntryNotReached", "The core PC did not enter the declared application code range", {
            sessionId: parsed.sessionId,
            coreId: parsed.coreId,
            diagnosisCode: "APPLICATION_ENTRY_NOT_REACHED",
            applicationEntry,
            halt
          });
        }
        const finalState = await manager.getTargetState(parsed.sessionId, parsed.coreId);
        return ok({
          sessionId: parsed.sessionId,
          coreId: finalState.coreId,
          coreName: finalState.coreName,
          performedSteps: ["loadProgram", "resetCore", "runCore", ...(applicationEntry ? ["verifyApplicationEntry"] : []), "getTargetState"],
          loadedProgram,
          reset,
          run,
          finalState,
          ...(applicationEntry ? {
            applicationEntry,
            runToMainSupported: false,
            runToMainAchieved: false,
            unsupportedReason: "Application entry was confirmed by PC range, but the adapter still has no breakpoint/runToSymbol API and did not claim a halted-at-main state."
          } : {
            runToMainSupported: false,
            runToMainAchieved: false,
            unsupportedReason: "No application entry address or executable linker-map range was supplied; the current DebugAdapter has no breakpoint/runToSymbol API, so reload/reset/run evidence is returned without claiming entry confirmation."
          })
        });
      } catch (error) {
        return fail(error, { sessionId: input.sessionId, coreId: input.coreId });
      }
    },

    async runIpcAcceptance(input: z.input<typeof runIpcAcceptanceSchema>) {
      try {
        const parsed = runIpcAcceptanceSchema.parse(resolveIpcStartupPreset(input as Record<string, unknown>));
        assertBoundedWorkflowPolling(parsed.timeoutMs, parsed.intervalMs);
        return ok(await workflows.runIpcAcceptance(parsed));
      } catch (error) {
        return fail(error, { sessionId: input.sessionId });
      }
    },

    async launchAndRunIpcAcceptance(input: z.input<typeof launchAndRunIpcAcceptanceSchema>) {
      try {
        const parsed = launchAndRunIpcAcceptanceSchema.parse(resolveIpcStartupPreset(input as Record<string, unknown>));
        assertBoundedWorkflowPolling(parsed.timeoutMs, parsed.intervalMs);
        return ok(await workflows.launchAndRunIpcAcceptance(parsed));
      } catch (error) {
        const structured = toStructuredError(error);
        const launch = structured.details?.launch;
        const launchEvidence = launch && typeof launch === "object" && !Array.isArray(launch)
          ? launch as Record<string, unknown>
          : undefined;
        return fail(error, {
          ...(typeof launchEvidence?.sessionId === "string" ? { sessionId: launchEvidence.sessionId } : {}),
          ...(typeof launchEvidence?.cleanedUp === "boolean" ? { cleanedUp: launchEvidence.cleanedUp } : {}),
          ...(launchEvidence?.cleanupError ? { cleanupError: launchEvidence.cleanupError } : {})
        });
      }
    },

    async runBootHandoffDiagnosis(input: z.input<typeof runBootHandoffDiagnosisSchema>) {
      try {
        const parsed = runBootHandoffDiagnosisSchema.parse(input);
        return ok(await workflows.runBootHandoffDiagnosis(parsed));
      } catch (error) {
        return fail(error, { sessionId: input.sessionId });
      }
    },

    async runReloadAndDiagnose(input: z.input<typeof runReloadAndDiagnoseSchema>) {
      try {
        const parsed = runReloadAndDiagnoseSchema.parse(input);
        return ok(await workflows.runReloadAndDiagnose(parsed));
      } catch (error) {
        return fail(error, { sessionId: input.sessionId });
      }
    },

    async runFullDebugBundle(input: z.input<typeof runFullDebugBundleSchema>) {
      try {
        const parsed = runFullDebugBundleSchema.parse(input);
        return ok(await workflows.runFullDebugBundle(parsed));
      } catch (error) {
        return fail(error, { sessionId: input.sessionId });
      }
    },

    async verifyRunPauseIsolation(input: z.input<typeof verifyRunPauseIsolationSchema>) {
      try {
        return ok(await manager.verifyRunPauseIsolation(input));
      } catch (error) {
        return fail(error, { sessionId: input.sessionId });
      }
    },

    async launchMultiBoardDebug(input: z.input<typeof launchMultiBoardDebugSchema>) {
      const createdSessionIds: string[] = [];
      const results: ToolResult[] = [];
      let rollbackOnFailure = true;
      try {
        const parsed = launchMultiBoardDebugSchema.parse(input);
        rollbackOnFailure = parsed.rollbackOnFailure;
        const preflight = await hardwarePreflight({ ccsInstallPath: parsed.ccsInstallPath });
        const connectedProbeSerials = (preflight.xdsdfu.devices ?? [])
          .map(device => device.serialNumber?.trim())
          .filter((serial): serial is string => Boolean(serial));
        const connectedProbeSet = new Set(connectedProbeSerials);
        const requestedBoardIds = new Set<string>();
        const requestedProbeSerials = new Set<string>();
        const boards = parsed.boards.map(board => ({ ...board, ccxmlPath: path.resolve(board.ccxmlPath) }));

        for (const board of boards) {
          const boardId = board.boardId ?? board.probeSerial;
          if (requestedBoardIds.has(boardId)) {
            throw new DebugMcpError("DuplicateBoardId", `Duplicate boardId ${boardId}`, { boardId });
          }
          if (requestedProbeSerials.has(board.probeSerial)) {
            throw new DebugMcpError("DuplicateProbeAllocation", `Probe ${board.probeSerial} was assigned more than once`, {
              probeSerial: board.probeSerial
            });
          }
          if (!connectedProbeSet.has(board.probeSerial)) {
            throw new DebugMcpError("ProbeNotConnected", `Requested XDS110 probe ${board.probeSerial} is not connected`, {
              probeSerial: board.probeSerial,
              connectedProbeSerials
            });
          }
          const ccxml = await readFile(board.ccxmlPath, "utf8");
          const probeBinding = inspectXds110SerialBinding(ccxml, board.probeSerial);
          if (!probeBinding.valid) {
            throw new DebugMcpError(probeBinding.code, probeBinding.message, {
              boardId,
              probeSerial: board.probeSerial,
              ccxmlPath: board.ccxmlPath,
              ...probeBinding.details
            });
          }
          requestedBoardIds.add(boardId);
          requestedProbeSerials.add(board.probeSerial);
        }

        for (const board of boards) {
          const boardId = board.boardId ?? board.probeSerial;
          for (const core of board.cores) {
            if (core.load && !core.programUri) {
              throw new DebugMcpError("LaunchProgramMissing", `No programUri is available for ${boardId} core ${core.coreId}`, {
                boardId,
                coreId: core.coreId,
                coreName: core.coreName
              });
            }
          }
          const cpu1Core = board.cores.find(core => core.load && isCpuCore(core, "cpu1"));
          const cpu2Core = board.cores.find(core => core.load && isCpuCore(core, "cpu2"));
          if (cpu1Core && cpu2Core) {
            const pairing = validateProgramPair(cpu1Core.programUri, cpu2Core.programUri);
            if (!pairing.compatible) {
              throw new DebugMcpError("ArtifactPairInvalid", `CPU1/CPU2 launch artifacts are incompatible for ${boardId}`, {
                boardId,
                pairing
              });
            }
          }

          const created = await manager.createDebugSession({
            sessionName: board.sessionName ?? board.targetConfigurationName ?? `multi-board-${boardId}`,
            ccxmlPath: board.ccxmlPath,
            coreMap: board.cores.map(core => ({ coreId: core.coreId, coreName: core.coreName, corePattern: core.corePattern }))
          });
          createdSessionIds.push(created.sessionId);
          for (const core of orderCoresCpu1First(board.cores)) {
            if (core.connect) {
              await manager.connectTarget(created.sessionId, core.coreId);
            }
            if (core.load) {
              await manager.loadProgramWithMap(
                created.sessionId,
                core.coreId,
                core.programUri!,
                core.mapUri,
                core.ramOwnershipPolicy ?? "require-map",
                core.fallbackGsRegions,
                core.allowDestructiveFlashReload
              );
            }
            if (core.haltAtEntry) {
              await manager.haltCore(created.sessionId, core.coreId);
            }
          }
          const snapshot = await manager.getMulticoreSnapshot(created.sessionId);
          results.push({
            boardId,
            probeSerial: board.probeSerial,
            ccxmlPath: board.ccxmlPath,
            sessionId: created.sessionId,
            snapshot,
            ...(board.autoCloseOnComplete
              ? { autoClose: manager.armIdleAutoClose(created.sessionId, board.autoCloseIdleTimeoutMs) }
              : {})
          });
        }
        return ok({
          workflow: "c2000_launchMultiBoardDebug",
          orchestration: "server-internal",
          allocationMode: "sequential-session-allocation",
          connectedProbeSerials,
          results
        });
      } catch (error) {
        const rollback: ToolResult[] = [];
        if (rollbackOnFailure) {
          for (const sessionId of [...createdSessionIds].reverse()) {
            try {
              await manager.closeDebugSession(sessionId);
              rollback.push({ sessionId, closed: true });
            } catch (cleanupError) {
              rollback.push({ sessionId, closed: false, error: toStructuredError(cleanupError) });
            }
          }
        }
        return fail(error, {
          workflow: "c2000_launchMultiBoardDebug",
          results,
          ...(rollback.length > 0 ? { rollback } : {})
        });
      }
    },

    async launchMulticoreDebug(input: z.input<typeof launchMulticoreDebugSchema>) {
      let createdSessionId: string | undefined;
      let failureContext: ToolResult = {};
      let launchCores: Array<{ coreId: number; coreName: string; programUri?: string; mapUri?: string; ramOwnershipPolicy?: "require-map" | "explicit-fallback" | "skip"; fallbackGsRegions?: number[] }> = [];
      let workflowStage = "input-validation";
      const performedSteps: string[] = [];
      let effectiveStartup: ToolResult = {
        startupPreset: null,
        resetType: null,
        loadSequence: null,
        runSequence: null,
        runPolicy: "owner-first-handoff-only",
        normalAcceptanceRunExecuted: false
      };
      try {
        const parsed = launchMulticoreDebugSchema.parse(input);
        workflowStage = "startup-contract-validation";
        failureContext = {
          effectiveStartup: {
            startupPreset: parsed.startupPreset ?? null,
            resetType: parsed.resetType ?? null,
            loadSequence: parsed.loadSequence ?? null,
            runSequence: parsed.runSequence ?? null,
            runPolicy: "owner-first-handoff-only",
            normalAcceptanceRunExecuted: false
          },
          workflowStage,
          performedSteps: [...performedSteps],
          targetAccessAttempted: false
        };
        const resolvedStartup = resolveIpcStartupPreset(parsed as unknown as Record<string, unknown>);
        const loadSequence = (resolvedStartup.loadSequence as { mode: "cpu1-then-cpu2" | "cpu1-run-before-cpu2"; cpu1SettleMs: number } | undefined)
          ?? { mode: "cpu1-then-cpu2" as const, cpu1SettleMs: 250 };
        const resetType = (resolvedStartup.resetType as ResetType | undefined) ?? "cpu";
        const runSequence = resolvedStartup.runSequence ?? null;
      effectiveStartup = {
          startupPreset: resolvedStartup.startupPreset ?? null,
          resetType,
          loadSequence,
          runSequence,
          runPolicy: "owner-first-handoff-only",
        normalAcceptanceRunExecuted: false
      };
        failureContext = { effectiveStartup, workflowStage, performedSteps: [...performedSteps], targetAccessAttempted: false };
        let physicalPreflight: ToolResult | undefined;
        workflowStage = "program-discovery";
        const programDiscovery = parsed.loadPrograms && parsed.programDiscovery?.enabled
          ? await discoverAcceptancePrograms({
            cpu1Program: parsed.programDiscovery.cpu1Program ?? process.env.C2000_CPU1_OUT,
            cpu2Program: parsed.programDiscovery.cpu2Program ?? process.env.C2000_CPU2_OUT,
            searchRoots: parsed.programDiscovery.searchRoots ?? programSearchRoots(configuredProgramSearchRoots),
            maxDepth: parsed.programDiscovery.maxDepth
          })
          : undefined;
        if (programDiscovery) {
          failureContext = { ...failureContext, programDiscovery };
        }
        const requestedCores = programDiscovery
          ? parsed.cores.map(core => ({
            ...core,
            programUri: core.programUri ?? discoveredProgramForCore(core.coreId, programDiscovery)
          }))
          : parsed.cores;
        const cores = requestedCores.map(core => parsed.loadPrograms ? core : { ...core, load: false });
        launchCores = cores;
        for (const core of cores) {
          if (core.load && !core.programUri) {
            throw new DebugMcpError("LaunchProgramMissing", `No programUri is available for launch core ${core.coreId}`, {
              coreId: core.coreId,
              coreName: core.coreName,
              programDiscovery
            });
          }
        }
        const cpu1Core = cores.find(core => core.load && isCpuCore(core, "cpu1"));
        const cpu2Core = cores.find(core => core.load && isCpuCore(core, "cpu2"));
        if (cpu1Core && cpu2Core) {
          const pairing = validateProgramPair(cpu1Core.programUri, cpu2Core.programUri, programDiscovery ? "F28P65x" : undefined);
          failureContext = { ...failureContext, artifactPair: pairing };
          if (!pairing.compatible) {
            throw new DebugMcpError("ArtifactPairInvalid", "CPU1/CPU2 launch artifacts are incomplete or incompatible", { pairing });
          }
        }
        // Capture the physical XDS evidence before CCS opens the debug
        // session and claims the probe.  The resolved runtime adapter mode is
        // the only authority used here; configured `auto` is never promoted.
        if (deps.effectiveAdapterType === "ccs") {
          workflowStage = "hardware-preflight";
          physicalPreflight = await hardwarePreflight({
            ccsInstallPath: deps.tiEnvironment?.ccsInstallPath
          });
          performedSteps.push("hardwarePreflight");
          failureContext = { ...failureContext, workflowStage, performedSteps: [...performedSteps], preflight: physicalPreflight };
        }
        const created = await manager.createDebugSession({
          sessionName: parsed.sessionName ?? parsed.targetConfigurationName ?? "launch-multicore-debug",
          ccxmlPath: parsed.ccxmlPath,
          boardId: parsed.boardId,
          probeId: parsed.probeId,
          preferredProbeIds: parsed.preferredProbeIds,
          allowAutoProbeAllocation: parsed.allowAutoProbeAllocation,
          coreMap: cores.map(core => ({ coreId: core.coreId, coreName: core.coreName, corePattern: core.corePattern }))
        });
        createdSessionId = created.sessionId;
        failureContext = { ...failureContext, sessionId: created.sessionId, created, targetAccessAttempted: true };
        const loadedCpu1 = cores.find(core => core.load && isCpuCore(core, "cpu1"));
        const loadedCpu2 = cores.find(core => core.load && isCpuCore(core, "cpu2"));
        const dualCoreLoad = parsed.loadPrograms && Boolean(loadedCpu1 && loadedCpu2);
        const runStage = async <T>(stage: string, operation: string, action: () => Promise<T>): Promise<T> => {
          workflowStage = stage;
          const value = await action();
          performedSteps.push(operation);
          failureContext = { ...failureContext, workflowStage, performedSteps: [...performedSteps] };
          return value;
        };

        if (dualCoreLoad) {
          // Owner-first launch is deliberately explicit: connect both cores,
          // establish a halted/reset baseline, then perform only the CPU1
          // handoff run required to release CPU2 RAM ownership.
          const coreIds = [loadedCpu1!.coreId, loadedCpu2!.coreId];
          const connected = await runStage("connect-both", "connectCores", () => manager.connectCores(created.sessionId, coreIds));
          assertBatchSucceeded("connectCores", connected);
          const initialHalt = await runStage("initial-halt", "haltCores", () => manager.haltCores(created.sessionId, coreIds));
          assertBatchSucceeded("haltCores", initialHalt);
          const reset = await runStage("reset", "resetCores", () => manager.resetCores(created.sessionId, coreIds, resetType));
          assertBatchSucceeded("resetCores", reset);
          await runStage("cpu1-load", "loadCpu1Program", () => manager.loadProgramWithMap(
            created.sessionId,
            loadedCpu1!.coreId,
            loadedCpu1!.programUri!,
            loadedCpu1!.mapUri,
            loadedCpu1!.ramOwnershipPolicy ?? "skip",
            loadedCpu1!.fallbackGsRegions,
            loadedCpu1!.allowDestructiveFlashReload
          ));
          if (loadSequence.mode === "cpu1-run-before-cpu2") {
            await runStage("owner-first-handoff-run", "runCpu1BeforeCpu2Load", () => manager.runCore(created.sessionId, loadedCpu1!.coreId));
            await runStage("owner-first-handoff-settle", "waitCpu1Settle", () => sleepCore(loadSequence.cpu1SettleMs));
          }
          await runStage("cpu2-load", "loadCpu2Program", () => manager.loadProgramWithMap(
            created.sessionId,
            loadedCpu2!.coreId,
            loadedCpu2!.programUri!,
            loadedCpu2!.mapUri,
            loadedCpu2!.ramOwnershipPolicy ?? "skip",
            loadedCpu2!.fallbackGsRegions,
            loadedCpu2!.allowDestructiveFlashReload
          ));
          const postLoadHalt = await runStage("post-load-halt", "haltCoresAfterLoad", () => manager.haltCores(created.sessionId, coreIds));
          assertBatchSucceeded("haltCoresAfterLoad", postLoadHalt);
        } else {
          // Connect-only and single-core launches retain their existing
          // semantics: loadPrograms=false never resets, loads, or runs.
          for (const core of orderCoresCpu1First(cores)) {
            if (core.connect) await runStage("connect", `connectCore:${core.coreId}`, () => manager.connectTarget(created.sessionId, core.coreId));
            if (core.load) {
              await runStage("program-load", `loadProgram:${core.coreId}`, () => manager.loadProgramWithMap(
                created.sessionId,
                core.coreId,
                core.programUri!,
                core.mapUri,
                core.ramOwnershipPolicy ?? "skip",
                core.fallbackGsRegions,
                core.allowDestructiveFlashReload
              ));
            }
            if (core.haltAtEntry) await runStage("halt", `haltCore:${core.coreId}`, () => manager.haltCore(created.sessionId, core.coreId));
          }
        }
        const snapshot = await runStage("snapshot", "getMulticoreSnapshot", () => manager.getMulticoreSnapshot(created.sessionId));
        failureContext = { ...failureContext, snapshot };
        const sessionTopology = await manager.getSessionTopology(created.sessionId);
        failureContext = { ...failureContext, sessionTopology };
        // Persist the physical XDS preflight alongside the effective adapter
        // identity.  This is deliberately captured after the worker/session
        // exists, and only for a real CCS adapter; mock launches must remain
        // deterministic and classify as MOCK without touching host hardware.
        if (!physicalPreflight && sessionTopology.effectiveAdapterType === "ccs") {
          physicalPreflight = await runStage("hardware-preflight", "hardwarePreflight", () => hardwarePreflight({
            ccsInstallPath: deps.tiEnvironment?.ccsInstallPath
          }));
          failureContext = { ...failureContext, preflight: physicalPreflight };
        }
        const postLaunchActions: ToolResult = {};
        const postLaunchActionsInput = parsed.postLaunchActions;
        if (postLaunchActionsInput?.assignExpressions) {
          postLaunchActions.assignExpressions = await runStage("post-launch-actions", "assignExpressions", () => manager.assignExpressions(
            created.sessionId,
            postLaunchActionsInput.assignExpressions!.map(normalizeExpressionAssignment)
          ));
        }
        if (postLaunchActionsInput?.injectFaults) {
          postLaunchActions.injectFaults = await runStage("post-launch-actions", "injectFaults", () => manager.injectFaults(
            created.sessionId,
            postLaunchActionsInput.injectFaults!.map(fault => ({ ...normalizeExpressionAssignment(fault), ...(fault.label ? { label: fault.label } : {}) }))
          ));
        }
        if (Object.keys(postLaunchActions).length > 0) {
          failureContext = { ...failureContext, postLaunchActions };
          assertPostLaunchActions(postLaunchActions);
        }
        const postLaunchChecks: ToolResult = {};
        const postLaunchChecksInput = parsed.postLaunchChecks;
        if (postLaunchChecksInput?.waitForExpressionSet) {
          postLaunchChecks.waitForExpressionSet = await runStage("post-launch-checks", "waitForExpressionSet", () => waitForExpressionSetResult(
            created.sessionId,
            postLaunchChecksInput.waitForExpressionSet!.conditions,
            postLaunchChecksInput.waitForExpressionSet!.timeoutMs,
            postLaunchChecksInput.waitForExpressionSet!.intervalMs
          ));
        }
        if (postLaunchChecksInput?.compareExpressions) {
          postLaunchChecks.compareExpressions = await runStage("post-launch-checks", "compareExpressions", () => manager.compareExpressions(
            created.sessionId,
            postLaunchChecksInput.compareExpressions!
          ));
        }
        if (postLaunchChecksInput?.diagnoseCpu2Boot) {
          postLaunchChecks.diagnoseCpu2Boot = await runStage("post-launch-diagnosis", "diagnoseCpu2Boot", () => manager.diagnoseCpu2Boot({
            sessionId: created.sessionId,
            cpu1CoreId: postLaunchChecksInput.diagnoseCpu2Boot!.cpu1CoreId,
            cpu2CoreId: postLaunchChecksInput.diagnoseCpu2Boot!.cpu2CoreId,
            cpu1Expressions: postLaunchChecksInput.diagnoseCpu2Boot!.cpu1Expressions,
            cpu2Expressions: postLaunchChecksInput.diagnoseCpu2Boot!.cpu2Expressions
          }));
        }
        if (postLaunchChecksInput?.verifyRunPauseIsolation) {
          postLaunchChecks.verifyRunPauseIsolation = await runStage("post-launch-checks", "verifyRunPauseIsolation", () => manager.verifyRunPauseIsolation({
            sessionId: created.sessionId,
            cpu1CoreId: postLaunchChecksInput.verifyRunPauseIsolation!.cpu1CoreId,
            cpu2CoreId: postLaunchChecksInput.verifyRunPauseIsolation!.cpu2CoreId,
            settleMs: postLaunchChecksInput.verifyRunPauseIsolation!.settleMs
          }));
        }
        if (Object.keys(postLaunchChecks).length > 0) {
          failureContext = { ...failureContext, postLaunchChecks };
          assertPostLaunchChecks(postLaunchChecks, {
            verifyRunPauseIsolation: postLaunchChecksInput?.verifyRunPauseIsolation
          });
        }
        const result = {
          sessionId: created.sessionId,
          adapterSessionId: sessionTopology.adapterSessionId,
          adapterName: sessionTopology.adapterName,
          effectiveAdapterType: sessionTopology.effectiveAdapterType,
          sessionTopology,
          deprecated: true,
          replacementTool: "c2000_launchMulticoreDebugWithActions",
          snapshot,
          autoCloseOnComplete: parsed.autoCloseOnComplete,
          loadPrograms: parsed.loadPrograms,
          startupPreset: effectiveStartup.startupPreset,
          resetType,
          loadSequence,
          runSequence,
          effectiveStartup,
          workflowStage: "completed",
          performedSteps,
          normalAcceptanceRunExecuted: false,
          ...(physicalPreflight ? { preflight: physicalPreflight } : {}),
          ...(programDiscovery ? { programDiscovery } : {}),
          ...(Object.keys(postLaunchActions).length > 0 ? { postLaunchActions } : {}),
          ...(Object.keys(postLaunchChecks).length > 0 ? { postLaunchChecks } : {})
        };
        if (!parsed.autoCloseOnComplete) {
          return ok(result);
        }
        return ok({
          ...result,
          autoClose: manager.armIdleAutoClose(created.sessionId, parsed.autoCloseIdleTimeoutMs)
        });
      } catch (error) {
        const body: ToolResult = {
          ...failureContext,
          workflowStage,
          performedSteps: [...performedSteps],
          effectiveStartup,
          targetAccessAttempted: Boolean(createdSessionId)
        };
        if (createdSessionId) {
          body.sessionId = createdSessionId;
          try {
            body.preCleanupDiagnostics = await captureLaunchPreCleanupDiagnostics({
              manager,
              analyzeRamOwnership,
              sessionId: createdSessionId,
              cores: launchCores,
              workflowStage,
              performedSteps,
              effectiveStartup
            });
          } catch (diagnosticError) {
            body.preCleanupDiagnostics = {
              schemaVersion: 1,
              provenance: {
                captureSource: "pre-cleanup-collector-failed",
                capturedBeforeSessionClose: true,
                collectorTargetAccessed: false,
                targetReadsOnly: true
              },
              sessionId: createdSessionId,
              workflowStage,
              performedSteps: [...performedSteps],
              effectiveStartup,
              collectorError: toStructuredError(diagnosticError)
            };
          }
          try {
            const cleanup = await manager.closeDebugSession(createdSessionId);
            body.cleanup = cleanup;
            body.cleanedUp = cleanup.closed === true;
            body.sessionClosed = cleanup.closed === true;
            body.adapterDisposed = cleanup.cleanup?.adapterDisposed === true;
          } catch (cleanupError) {
            body.cleanedUp = false;
            body.sessionClosed = false;
            body.cleanupError = toStructuredError(cleanupError);
          }
        }
        const structured = toStructuredError(error);
        return {
          success: false,
          timestamp: new Date().toISOString(),
          ...body,
          error: {
            ...structured,
            details: {
              ...(structured.details ?? {}),
              workflowStage,
              performedSteps: [...performedSteps],
              effectiveStartup,
              targetAccessAttempted: Boolean(createdSessionId),
              ...(body.preCleanupDiagnostics ? { preCleanupDiagnostics: body.preCleanupDiagnostics } : {})
            }
          }
        };
      }
    },

    async launchMulticoreDebugSafe(input: z.input<typeof launchMulticoreDebugSafeSchema>) {
      const parsed = launchMulticoreDebugSafeSchema.parse(input);
      return this.launchMulticoreDebug({ ...parsed, cores: parsed.cores.map(core => ({ ...core, ramOwnershipPolicy: core.ramOwnershipPolicy ?? "require-map" })) });
    },

    async launchMulticoreDebugWithActions(input: z.input<typeof launchMulticoreDebugWithActionsSchema>) {
      const parsed = launchMulticoreDebugWithActionsSchema.parse(input);
      const result = await this.launchMulticoreDebug({ ...parsed, cores: parsed.cores.map(core => ({ ...core, ramOwnershipPolicy: core.ramOwnershipPolicy ?? "require-map" })) });
      return { ...result, deprecated: false, replacementTool: undefined };
    }
  };

  async function targetStateResult(input: { sessionId: string; coreId: number }, action: () => Promise<unknown>) {
    try {
      return ok({ sessionId: input.sessionId, ...(await action() as Record<string, unknown>) });
    } catch (error) {
      return fail(error, { sessionId: input.sessionId, coreId: input.coreId });
    }
  }

  async function batchResult(sessionId: string, action: () => Promise<unknown>) {
    try {
      return okBatch("batch operation", await action() as Record<string, unknown>);
    } catch (error) {
      return fail(error, { sessionId });
    }
  }

  async function evaluateConditions(sessionId: string, conditions: z.infer<typeof waitForExpressionSetSchema>["conditions"]) {
    const grouped = new Map<number, string[]>();
    for (const condition of conditions) {
      grouped.set(condition.coreId, [...(grouped.get(condition.coreId) ?? []), condition.expression]);
    }
    const batches = await Promise.all([...grouped].map(async ([coreId, expressions]) => ({
      coreId,
      results: await manager.evaluateMany(sessionId, coreId, [...new Set(expressions)])
    })));
    const byCore = new Map(batches.map(batch => [batch.coreId, batch.results]));
    return {
      expressionBatchCalls: batches.length,
      conditions: conditions.map(condition => {
        const result = byCore.get(condition.coreId)?.find(item => item.expression === condition.expression);
        return {
          label: condition.label,
          coreId: condition.coreId,
          expression: condition.expression,
          expected: condition.expected,
          matched: result?.success === true && valuesEqual(result.value, condition.expected),
          result
        };
      })
    };
  }

  async function resolveCoreName(sessionId: string, coreId: number): Promise<string> {
    const topology = await manager.getSessionTopology(sessionId);
    const core = topology.cores.find(item => item.coreId === coreId);
    if (!core) {
      throw new DebugMcpError("CoreNotFound", `Core ${coreId} was not found in session ${sessionId}`, { sessionId, coreId });
    }
    return core.coreName;
  }

  async function waitForExpressionSetResult(
    sessionId: string,
    conditions: z.infer<typeof waitForExpressionSetSchema>["conditions"],
    timeoutMs: number,
    intervalMs: number
  ) {
    const deadline = Date.now() + timeoutMs;
    let lastConditions: ToolResult[] = [];
    while (Date.now() <= deadline) {
      lastConditions = (await evaluateConditions(sessionId, conditions)).conditions;
      if (lastConditions.every(condition => condition.matched)) {
        return {
          sessionId,
          matched: true,
          timedOut: false,
          conditions: lastConditions
        };
      }
      await sleep(intervalMs);
    }
    return {
      sessionId,
      matched: false,
      timedOut: true,
      conditions: lastConditions
    };
  }

  function assertPostLaunchChecks(
    postLaunchChecks: ToolResult,
    expected: { verifyRunPauseIsolation?: { cpu1CoreId?: number; cpu2CoreId?: number } } = {}
  ) {
    const waitForExpressionSet = postLaunchChecks.waitForExpressionSet as Record<string, any> | undefined;
    if (waitForExpressionSet && waitForExpressionSet.matched !== true) {
      throw new DebugMcpError("PostLaunchCheckFailed", "post-launch waitForExpressionSet did not match", {
        waitForExpressionSet
      });
    }
    const compareExpressions = postLaunchChecks.compareExpressions as Record<string, any> | undefined;
    if (compareExpressions && compareExpressions.matched !== true) {
      throw new DebugMcpError("PostLaunchCheckFailed", "post-launch compareExpressions did not match", {
        compareExpressions
      });
    }
    const verifyRunPauseIsolation = postLaunchChecks.verifyRunPauseIsolation as Record<string, any> | undefined;
    if (verifyRunPauseIsolation) {
      try {
        assertRunPauseAcceptanceSummary(verifyRunPauseIsolation.acceptanceSummary, expected.verifyRunPauseIsolation);
      } catch (error) {
        throw new DebugMcpError("PostLaunchCheckFailed", "post-launch run/pause isolation check failed", {
          acceptanceSummary: verifyRunPauseIsolation.acceptanceSummary,
          validationError: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }

  function assertPostLaunchActions(postLaunchActions: ToolResult) {
    const assignExpressions = postLaunchActions.assignExpressions as Record<string, any> | undefined;
    const failedAssignments = Array.isArray(assignExpressions?.results)
      ? (assignExpressions.results as Array<Record<string, any>>).filter(item => item.success !== true)
      : [];
    if (assignExpressions && failedAssignments.length > 0) {
      throw new DebugMcpError("PostLaunchActionFailed", "post-launch assignExpressions failed", {
        failed: failedAssignments
      });
    }
    const injectFaults = postLaunchActions.injectFaults as Record<string, any> | undefined;
    const failedFaults = Array.isArray(injectFaults?.results)
      ? (injectFaults.results as Array<Record<string, any>>).filter(item => item.success !== true)
      : [];
    if (injectFaults && failedFaults.length > 0) {
      throw new DebugMcpError("PostLaunchActionFailed", "post-launch injectFaults failed", {
        failed: failedFaults
      });
    }
  }
}

function defaultIpcReadyConditions(cpu1CoreId: number, cpu2CoreId: number) {
  return defaultIpcReadyConditionsCore(cpu1CoreId, cpu2CoreId);
}

function buildBootHandoffVerdict(boot: ToolResult, ramOwnership?: ToolResult) {
  return buildBootHandoffVerdictCore(boot, ramOwnership as any);
}

function bootExpressionReady(result: ToolResult): boolean {
  if (result.success !== true) {
    return false;
  }
  if (result.expression === "g_stCoreCommCpu1Watch.ulCpu2BootLastError") {
    return Number(result.value) === 0;
  }
  if (result.expression === "g_stCoreCommCpu1Watch.emStage" ||
      result.expression === "g_stCoreCommCpu2Watch.emStage") {
    return Number(result.value) === 5;
  }
  return !["0", "false", "undefined"].includes(String(result.value).toLowerCase());
}

function discoveredProgramForCore(coreId: number, programDiscovery: ToolResult): string | undefined {
  if (coreId === 0) {
    return typeof programDiscovery.cpu1?.selected === "string" ? programDiscovery.cpu1.selected : undefined;
  }
  if (coreId === 2) {
    return typeof programDiscovery.cpu2?.selected === "string" ? programDiscovery.cpu2.selected : undefined;
  }
  return undefined;
}

/**
 * Collect live launch evidence while the original session/lease still exists.
 * Each item is isolated so one unavailable debugger capability cannot hide the
 * remaining target state, PC, loaded identity, map, or handoff evidence.
 * This helper performs reads only; it never halts, resets, runs, loads, or
 * writes target state.
 */
async function captureLaunchPreCleanupDiagnostics(options: {
  manager: DebugSessionManager;
  analyzeRamOwnership: (input: MapOwnershipInput) => unknown | Promise<unknown>;
  sessionId: string;
  cores: Array<{ coreId: number; coreName: string; programUri?: string; mapUri?: string }>;
  workflowStage: string;
  performedSteps: string[];
  effectiveStartup: Record<string, unknown>;
}): Promise<ToolResult> {
  const capture = async (name: string, action: () => Promise<unknown>): Promise<ToolResult> => {
    try {
      return { name, status: "COLLECTED", value: await action() };
    } catch (error) {
      return { name, status: "FAILED", error: toStructuredError(error) };
    }
  };

  const sessionTopology = await capture("session-topology", () => options.manager.getSessionTopology(options.sessionId));
  const targetState: ToolResult[] = [];
  const resolvedPc: ToolResult[] = [];
  const loadedProgramIdentity: ToolResult[] = [];
  for (const core of options.cores) {
    targetState.push(await capture(`target-state:${core.coreId}`, async () => {
      const state = await options.manager.getTargetState(options.sessionId, core.coreId);
      return { coreId: core.coreId, coreName: core.coreName, state };
    }));
    resolvedPc.push(await capture(`pc:${core.coreId}`, async () => {
      const resolved = await options.manager.resolvePc(options.sessionId, core.coreId);
      return { coreId: core.coreId, rawPc: resolved.pc ?? null, resolved };
    }));
    loadedProgramIdentity.push(await capture(`loaded-program:${core.coreId}`, async () => {
      const info = await options.manager.getLoadedProgramInfo(options.sessionId, core.coreId);
      return {
        coreId: core.coreId,
        available: info !== undefined,
        source: "mcp-loaded-program-registry",
        info: info ?? null
      };
    }));
  }

  const snapshot = await capture("multicore-snapshot", () => options.manager.getMulticoreSnapshot(options.sessionId));
  const maps: MapOwnershipInput["maps"] = [];
  const mapResolutionFailures: ToolResult[] = [];
  for (const core of options.cores.filter(candidate => typeof candidate.mapUri === "string" && candidate.mapUri.length > 0)) {
    try {
      maps.push({
        coreId: core.coreId,
        coreName: core.coreName,
        mapPath: options.manager.normalizeArtifactUri(core.mapUri!)
      });
    } catch (error) {
      mapResolutionFailures.push({ name: `map:${core.coreId}`, status: "FAILED", error: toStructuredError(error) });
    }
  }
  const staticRamOwnership = maps.length > 0
    ? await capture("static-ram-ownership", async () => {
      const analysis = await options.analyzeRamOwnership({ maps }) as Record<string, unknown>;
      return mapResolutionFailures.length > 0 ? { ...analysis, mapResolutionFailures } : analysis;
    })
    : mapResolutionFailures.length > 0
      ? { name: "static-ram-ownership", status: "FAILED", value: { mapResolutionFailures } }
      : { name: "static-ram-ownership", status: "MISSING", reason: "No launch map was supplied for read-only static ownership analysis." };
  let runtimeRamOwnership: ToolResult;
  const ownership = staticRamOwnership.value as { ownershipActions?: unknown[] } | undefined;
  if (staticRamOwnership.status === "COLLECTED" && Array.isArray(ownership?.ownershipActions)) {
    runtimeRamOwnership = await capture("runtime-ram-ownership", () => options.manager.verifyRuntimeRamOwnership(
      options.sessionId,
      ownership.ownershipActions as never[]
    ));
  } else {
    runtimeRamOwnership = { name: "runtime-ram-ownership", status: "MISSING", reason: "Static ownership actions were unavailable." };
  }
  const coreIds = options.cores.map(core => core.coreId);
  const cpu1CoreId = options.cores.find(core => isCpuCore(core, "cpu1"))?.coreId;
  const cpu2CoreId = options.cores.find(core => isCpuCore(core, "cpu2"))?.coreId;
  const bootHandoffDiagnosis = cpu1CoreId !== undefined && cpu2CoreId !== undefined
    ? await capture("boot-handoff-diagnosis", () => options.manager.diagnoseCpu2Boot({
      sessionId: options.sessionId,
      cpu1CoreId,
      cpu2CoreId
    }))
    : { name: "boot-handoff-diagnosis", status: "MISSING", reason: "CPU1/CPU2 core pair was not available." };

  return {
    schemaVersion: 1,
    provenance: {
      captureSource: "live-pre-cleanup-session",
      capturedBeforeSessionClose: true,
      collectorTargetAccessed: true,
      targetReadsOnly: true,
      targetAccessAttempted: true
    },
    sessionId: options.sessionId,
    adapterSessionId: sessionTopology.status === "COLLECTED"
      && sessionTopology.value && typeof sessionTopology.value === "object"
      && typeof (sessionTopology.value as Record<string, unknown>).adapterSessionId === "string"
      ? (sessionTopology.value as Record<string, unknown>).adapterSessionId
      : null,
    workerGeneration: null,
    workerGenerationAvailability: "not-exposed-by-launch-handler",
    workflowStage: options.workflowStage,
    performedSteps: [...options.performedSteps],
    effectiveStartup: options.effectiveStartup,
    coreIds,
    sessionTopology,
    targetState,
    resolvedPc,
    loadedProgramIdentity,
    snapshot,
    staticRamOwnership,
    runtimeRamOwnership,
    bootHandoffDiagnosis
  };
}

function assertBatchSucceeded(label: string, result: ToolResult): void {
  const failed = Array.isArray(result.results)
    ? (result.results as ToolResult[]).filter(item => item.success !== true)
    : [];
  if (failed.length > 0) {
    throw new DebugMcpError("BatchOperationFailed", `${label} failed for ${failed.length} item(s)`, { failed });
  }
}

function isCpuCore(core: { coreId: number; coreName: string }, expected: "cpu1" | "cpu2"): boolean {
  const normalized = core.coreName.toLowerCase();
  return expected === "cpu1"
    ? core.coreId === 0 || normalized.includes("cpu1") || normalized.includes("c28x1")
    : core.coreId === 2 || normalized.includes("cpu2") || normalized.includes("c28x2");
}

function orderCoresCpu1First<T extends { coreId: number }>(cores: T[]): T[] {
  return [...cores].sort((left, right) => {
    if (left.coreId === 0) {
      return -1;
    }
    if (right.coreId === 0) {
      return 1;
    }
    return left.coreId - right.coreId;
  });
}

function inspectXds110SerialBinding(ccxml: string, expectedSerial: string): {
  valid: boolean;
  code: "ProbeBindingMissing" | "ProbeBindingInvalid";
  message: string;
  details: ToolResult;
} {
  const selection = findXmlElementAttributes(ccxml, "property", attributes => attributes.id === "Debug Probe Selection");
  if (!selection) {
    return {
      valid: false,
      code: "ProbeBindingMissing",
      message: `Target configuration does not declare XDS110 Debug Probe Selection for ${expectedSerial}`,
      details: { expectedSerial }
    };
  }
  if (selection.Value !== "0") {
    return {
      valid: false,
      code: "ProbeBindingInvalid",
      message: `Target configuration does not select XDS110 by serial number for ${expectedSerial}`,
      details: { expectedSerial, actualDebugProbeSelection: selection.Value ?? null, expectedDebugProbeSelection: "0" }
    };
  }

  const serialChoice = findXmlElementAttributes(ccxml, "choice", attributes => attributes.Name === "Select by serial number");
  if (!serialChoice || serialChoice.value !== "0") {
    return {
      valid: false,
      code: "ProbeBindingInvalid",
      message: `Target configuration has no valid Select by serial number choice for ${expectedSerial}`,
      details: { expectedSerial, actualSerialChoice: serialChoice?.value ?? null, expectedSerialChoice: "0" }
    };
  }

  const serialField = findXmlElementAttributes(ccxml, "property", attributes => attributes.id === "-- Enter the serial number");
  if (!serialField) {
    return {
      valid: false,
      code: "ProbeBindingMissing",
      message: `Target configuration does not provide an XDS110 serial number for ${expectedSerial}`,
      details: { expectedSerial }
    };
  }
  if (serialField.Value !== expectedSerial) {
    return {
      valid: false,
      code: "ProbeBindingInvalid",
      message: `Target configuration binds XDS110 serial ${serialField.Value ?? "<missing>"}, not ${expectedSerial}`,
      details: { expectedSerial, configuredSerial: serialField.Value ?? null }
    };
  }
  return { valid: true, code: "ProbeBindingInvalid", message: "", details: {} };
}

function findXmlElementAttributes(
  xml: string,
  element: string,
  predicate: (attributes: Record<string, string>) => boolean
): Record<string, string> | undefined {
  const tags = xml.match(new RegExp(`<${element}\\b[^>]*>`, "g")) ?? [];
  for (const tag of tags) {
    const attributes = Object.fromEntries(
      Array.from(tag.matchAll(/([:\w-]+)\s*=\s*(["'])(.*?)\2/g), match => [match[1], match[3]])
    );
    if (predicate(attributes)) return attributes;
  }
  return undefined;
}

function programSearchRoots(configuredRoots: string[] | undefined): string[] {
  const configured = process.env.C2000_PROGRAM_SEARCH_ROOTS;
  if (configured) {
    return configured.split(path.delimiter).filter(Boolean);
  }
  if (configuredRoots && configuredRoots.length > 0) {
    return configuredRoots;
  }
  return [path.join(os.homedir(), "workspace_ccstheia")];
}

async function hostFileCheck(filePath: string | undefined, missingReason: string): Promise<ToolResult> {
  if (!filePath) {
    return { ok: false, reason: missingReason };
  }
  try {
    const fileStat = await stat(filePath);
    return {
      ok: fileStat.isFile(),
      path: filePath,
      exists: true,
      sizeBytes: fileStat.size,
      reason: fileStat.isFile() ? undefined : "Path exists but is not a file"
    };
  } catch (error) {
    return {
      ok: false,
      path: filePath,
      exists: false,
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}

function acceptanceBlockers(checks: ToolResult): string[] {
  const blockers: string[] = [];
  if (!checks.ccxml?.ok) {
    blockers.push(`Target configuration is not ready: ${checks.ccxml?.reason ?? checks.ccxml?.path ?? "missing ccxml"}`);
  }
  if (!checks.cpu1Program?.ok) {
    blockers.push(`CPU1 program is not ready: ${checks.cpu1Program?.reason ?? checks.cpu1Program?.path ?? "missing .out"}`);
  }
  if (!checks.cpu2Program?.ok) {
    blockers.push(`CPU2 program is not ready: ${checks.cpu2Program?.reason ?? checks.cpu2Program?.path ?? "missing .out"}`);
  }
  if (!checks.artifactPair?.ok) {
    blockers.push(`CPU1/CPU2 artifacts are incompatible: ${(checks.artifactPair?.issues ?? []).join("; ")}`);
  }
  if (!checks.xds110?.ok) {
    blockers.push("XDS110 probe is not enumerated by xdsdfu");
  }
  if (!checks.debugProcessOwnership?.ok) {
    blockers.push(checks.debugProcessOwnership?.inspection?.ok === false
      ? `Could not inspect debug-process ownership: ${checks.debugProcessOwnership.inspection.error ?? "process enumeration failed"}`
      : `Existing debug-related process(es) may own the XDS probe: ${checks.debugProcessOwnership.owners}`);
  }
  if (!checks.debugBoundary?.ok) {
    blockers.push("Debug boundary contract is not ready for F28P65x explicit per-core automation");
  }
  if (!checks.daemonRoute?.ok) {
    blockers.push(checks.daemonRoute?.nextTool === "c2000_registerBoard"
      ? "No board is registered with c2000-debugd; call c2000_registerBoard before hardware acceptance"
      : "No matching registered board has a READY, unleased worker route with available concurrency");
  }
  return blockers;
}

function preflightReady(preflight: ToolResult, allowExistingDebugProcesses: boolean): boolean {
  const xdsReady = preflight.xdsdfu?.ok === true
    && Array.isArray(preflight.xdsdfu.devices)
    && preflight.xdsdfu.devices.length > 0;
  const hasOwners = (preflight.debugProcessDetails?.length ?? 0) > 0
    || (preflight.debugProcesses?.length ?? 0) > 0;
  return xdsReady && (!hasOwners || allowExistingDebugProcesses);
}

function acceptanceWarnings(checks: ToolResult): string[] {
  const warnings: string[] = [];
  if (checks.debugProcessOwnership?.overrideAccepted) {
    warnings.push(`Existing debug-related process override accepted: ${checks.debugProcessOwnership.owners}`);
  }
  return warnings;
}

function hardwareAcceptanceCommand(options: {
  ccsInstallPath?: string;
  ccxmlPath?: string;
  cpu1Program?: string;
  cpu2Program?: string;
  allowExistingDebugProcesses?: boolean;
}): string {
  const assignments = [
    ["C2000_RUN_LAUNCH", "1"],
    ["C2000_RUN_ISOLATION", "1"],
    ["C2000_ALLOW_EXISTING_DEBUG_PROCESSES", options.allowExistingDebugProcesses ? "1" : undefined],
    ["C2000_MCP_CCS_INSTALL_PATH", options.ccsInstallPath],
    ["C2000_MCP_CCXML_PATH", options.ccxmlPath],
    ["C2000_CPU1_OUT", options.cpu1Program],
    ["C2000_CPU2_OUT", options.cpu2Program]
  ]
    .filter((assignment): assignment is [string, string] => typeof assignment[1] === "string" && assignment[1].length > 0)
    .map(([name, value]) => `${name}=${shellValue(value)}`);
  return [...assignments, "npm run acceptance:ccs:mcp"].join(" ");
}

function shellValue(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function normalizeExpressionAssignment<T extends {
  coreId: number;
  expression: string;
  value: string | number | boolean;
  verify: boolean;
  verification?: "readback" | "write-only";
}>(assignment: T) {
  return {
    coreId: assignment.coreId,
    expression: assignment.expression,
    value: assignment.value,
    // A one-shot hook is consumed by firmware, so a post-write readback is
    // not a valid success criterion. Keep ordinary assignments fail-closed.
    verify: assignment.verification === "write-only" ? false : assignment.verify
  };
}

function valuesEqual(actual: unknown, expected: unknown): boolean {
  return valuesEqualCore(actual, expected);
}

function sleep(ms: number): Promise<void> {
  return sleepCore(ms);
}
