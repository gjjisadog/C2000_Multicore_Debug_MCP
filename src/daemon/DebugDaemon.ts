import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import type { C2000McpConfig } from "../config/config.schema.js";
import { createC2000McpRuntime, type C2000McpRuntime } from "../server.js";
import { createDaemonHealth } from "./DaemonHealthService.js";
import { acquireDaemonSingletonLock, daemonRuntimePaths, newAuthTokenFile, removeDaemonInstance, writeDaemonInstance, type DaemonRuntimePaths, type DebugDaemonInstance } from "./DaemonInstanceFile.js";
import { resolveDaemonConfig } from "./DaemonConfig.js";
import { DaemonRpcServer } from "./DaemonRpcServer.js";
import { SqliteStore } from "../storage/SqliteStore.js";
import { BoardRepository } from "../storage/repositories/BoardRepository.js";
import { WorkerRepository } from "../storage/repositories/WorkerRepository.js";
import { TestRunRepository } from "../storage/repositories/TestRunRepository.js";
import { EventRepository } from "../storage/repositories/EventRepository.js";
import { LeaseRepository } from "../storage/repositories/LeaseRepository.js";
import { BoardRegistry } from "../boards/BoardRegistry.js";
import { BoardWorkerSupervisor } from "../boards/BoardWorkerSupervisor.js";
import { SessionRepository } from "../storage/repositories/SessionRepository.js";
import { DaemonToolRouter } from "./DaemonToolRouter.js";
import { ArtifactRepository } from "../storage/repositories/ArtifactRepository.js";
import { TestJobEngine } from "../jobs/TestJobEngine.js";
import { BoardGroupRepository } from "../storage/repositories/BoardGroupRepository.js";
import { CanTestResultRepository } from "../storage/repositories/CanTestResultRepository.js";
import { BoardGroupBarrierRepository } from "../storage/repositories/BoardGroupBarrierRepository.js";
import { CanProfileRepository } from "../storage/repositories/CanProfileRepository.js";
import { CanProfileRegistry } from "../can/CanProfileRegistry.js";
import { CanCampaignRepository } from "../storage/repositories/CanCampaignRepository.js";
import { BoardGroupReconcileDecisionRepository } from "../storage/repositories/BoardGroupReconcileDecisionRepository.js";
import { CanReportService } from "../can/CanReportService.js";
import { CanAcceptanceService } from "../can/CanAcceptanceService.js";
import { DatabaseConsistencyChecker } from "../storage/DatabaseConsistencyChecker.js";
import { MockCanBusAdapter } from "../can/MockCanBusAdapter.js";
import { NoopCanBusAdapter } from "../can/NoopCanBusAdapter.js";
import { CanWorkerProcess } from "../can-worker/CanWorkerProcess.js";
import { runtimeBuildInfo, SERVER_VERSION } from "../runtimeInfo.js";
import { runtimeContractIdentity } from "../contracts/RuntimeContract.js";
import { assertCcxmlProbeBinding } from "../hardware/ccxmlBinding.js";
import { DebugMcpError } from "../utils/errors.js";
import { ArtifactExportRepository } from "../storage/repositories/ArtifactExportRepository.js";
import { JobArtifactSnapshotService } from "../artifacts/JobArtifactSnapshotService.js";
import { VariableStreamRepository } from "../storage/repositories/VariableStreamRepository.js";
import { VariableStreamService } from "../observability/VariableStreamService.js";
import { DlogService } from "../observability/DlogService.js";
import { EradProfileRepository } from "../storage/repositories/EradProfileRepository.js";
import { EradService } from "../observability/EradService.js";
import { TraceService } from "../observability/TraceService.js";
import { FailureBundleService } from "../observability/FailureBundleService.js";
import { RunMetricsService } from "../analytics/RunMetricsService.js";
import { BaselineService } from "../analytics/BaselineService.js";
import { AcceptanceClosureService } from "../artifacts/AcceptanceClosureService.js";
import { VerificationService } from "../verification/VerificationService.js";
import { OutcomeEventRepository } from "../analytics/OutcomeEventRepository.js";
import { OutcomeAnalyticsService } from "../analytics/OutcomeAnalyticsService.js";
import { ProposalRepository } from "../improvement/ProposalRepository.js";
import { ImprovementProposalService } from "../improvement/ImprovementProposalService.js";
import { ConfiguredCodingAgent } from "../improvement/implementation/ImprovementAgentRunner.js";
import { CandidateCommitService } from "../improvement/implementation/CandidateCommitService.js";
import { ImplementationRunRepository } from "../improvement/implementation/ImplementationRunRepository.js";
import { ImprovementImplementationService } from "../improvement/implementation/ImprovementImplementationService.js";
import { ImprovementValidationService } from "../improvement/implementation/ImprovementValidationService.js";
import { ImprovementWorktreeManager } from "../improvement/implementation/ImprovementWorktreeManager.js";
import { reviewPolicyConfigSchema } from "../improvement/review/ReviewSchemas.js";
import { ImprovementPullRequestRepository, ImprovementReviewEvidenceRepository, MergeRecommendationRepository } from "../improvement/review/ReviewRepositories.js";
import { CandidateReviewService } from "../improvement/review/CandidateReviewService.js";
import { CandidatePublishService } from "../improvement/review/CandidatePublishService.js";
import { GitHubReviewProvider } from "../improvement/review/GitHubReviewProvider.js";
import { ImprovementPullRequestService } from "../improvement/review/ImprovementPullRequestService.js";
import { ImprovementReviewFeedbackRepository, ImprovementRevisionProposalRepository } from "../improvement/revision/RevisionRepositories.js";
import { ReviewFeedbackService } from "../improvement/revision/ReviewFeedbackService.js";
import { RevisionProposalService } from "../improvement/revision/RevisionProposalService.js";
import {
  PostMergeEvaluationRepository,
  PostMergeEvaluationSnapshotRepository,
  RollbackRecommendationRepository
} from "../improvement/evaluation/EvaluationRepositories.js";
import { PostMergeEvaluationService } from "../improvement/evaluation/PostMergeEvaluationService.js";
import { Logger } from "../utils/logger.js";

/** Owns all durable debug state. A proxy may disconnect without affecting it. */
export class DebugDaemon {
  private readonly startedAtMs = Date.now();
  private readonly instanceId = randomUUID();
  private readonly authToken = randomBytes(32).toString("base64url");
  private readonly daemonConfig;
  private readonly paths: DaemonRuntimePaths;
  private runtime?: C2000McpRuntime;
  private store?: SqliteStore;
  private consistency?: DatabaseConsistencyChecker;
  private registry?: BoardRegistry;
  private workers?: WorkerRepository;
  private testRuns?: TestRunRepository;
  private sessions?: SessionRepository;
  private workerSupervisor?: BoardWorkerSupervisor;
  private variableStreams?: VariableStreamService;
  private dlog?: DlogService;
  private erad?: EradService;
  private jobEngine?: TestJobEngine;
  private rpcServer?: DaemonRpcServer;
  private analytics?: OutcomeAnalyticsService;
  private improvementImplementation?: ImprovementImplementationService;
  private postMergeEvaluation?: PostMergeEvaluationService;
  private instance?: DebugDaemonInstance;
  private releaseSingleton?: () => Promise<void>;
  private stopping?: Promise<void>;

  constructor(private readonly config: C2000McpConfig) {
    this.daemonConfig = resolveDaemonConfig(config);
    this.paths = daemonRuntimePaths(this.daemonConfig.runtimeDir);
  }

  async start(): Promise<DebugDaemonInstance> {
    if (this.instance) return this.instance;
    const databasePath = path.resolve(this.config.storage?.sqlitePath ?? "./runtime/c2000-debugd.sqlite");
    const store = await SqliteStore.open(databasePath, { wal: this.config.storage?.wal ?? true });
    this.store = store;
    this.consistency = new DatabaseConsistencyChecker(store);
    const boards = new BoardRepository(store);
    const events = new EventRepository(store);
    const outcomeEvents = new OutcomeEventRepository(store);
    const analytics = new OutcomeAnalyticsService({
      repository: outcomeEvents,
      toolProfile: this.config.toolProfile ?? "safe",
      toolSurfaceProfile: this.config.toolSurfaceProfile ?? "agent",
      runtimeIdentity: { mcpVersion: SERVER_VERSION, mcpGitSha: runtimeBuildInfo().sourceRevision ?? "unknown" },
      logger: new Logger(this.config.logging.level, this.config.logging.logFile)
    });
    this.analytics = analytics;
    void analytics.maintain();
    const proposalRecords = new ProposalRepository(store);
    const improvementProposals = new ImprovementProposalService({
      events: outcomeEvents,
      proposals: proposalRecords,
      currentBaselineSha: () => process.env.C2000_MCP_BASELINE_SHA,
      logger: new Logger(this.config.logging.level, this.config.logging.logFile)
    });
    const improvementConfig = {
      repositoryRoot: this.config.improvement?.repositoryRoot,
      worktreeRoot: this.config.improvement?.worktreeRoot ?? "../.c2000-improvement-worktrees",
      artifactRoot: this.config.improvement?.artifactRoot ?? "./runtime/improvement-artifacts",
      baseRef: this.config.improvement?.baseRef ?? "master",
      enabled: this.config.improvement?.enabled ?? false,
      maxActiveRuns: this.config.improvement?.maxActiveRuns ?? 1,
      codingAgent: this.config.improvement?.codingAgent ?? {},
      review: reviewPolicyConfigSchema.parse(this.config.improvement?.review ?? {})
    };
    const improvementRepositoryRoot = path.resolve(improvementConfig.repositoryRoot ?? process.cwd());
    const improvementWorktreeRoot = path.resolve(improvementRepositoryRoot, improvementConfig.worktreeRoot ?? "../.c2000-improvement-worktrees");
    const improvementArtifactRoot = path.resolve(improvementRepositoryRoot, improvementConfig.artifactRoot ?? "./runtime/improvement-artifacts");
    const improvementWorktrees = new ImprovementWorktreeManager({ repositoryRoot: improvementRepositoryRoot, worktreeRoot: improvementWorktreeRoot });
    const improvementRuns = new ImplementationRunRepository(store);
    const improvementPullRequests = new ImprovementPullRequestRepository(store);
    const improvementReviewEvidence = new ImprovementReviewEvidenceRepository(store);
    const mergeRecommendations = new MergeRecommendationRepository(store);
    const postMergeEvaluations = new PostMergeEvaluationRepository(store);
    const postMergeEvaluationSnapshots = new PostMergeEvaluationSnapshotRepository(store);
    const rollbackRecommendations = new RollbackRecommendationRepository(store);
    const postMergeEvaluation = new PostMergeEvaluationService({
      evaluations: postMergeEvaluations,
      snapshots: postMergeEvaluationSnapshots,
      rollbackRecommendations,
      events: outcomeEvents,
      proposals: proposalRecords,
      proposalService: improvementProposals,
      logger: new Logger(this.config.logging.level, this.config.logging.logFile)
    });
    this.postMergeEvaluation = postMergeEvaluation;
    const candidateReview = new CandidateReviewService({
      runs: improvementRuns,
      proposals: proposalRecords,
      worktrees: improvementWorktrees,
      artifactRoot: improvementArtifactRoot,
      baseRef: improvementConfig.baseRef,
      currentBaseSha: () => improvementWorktrees.resolveRef(improvementConfig.baseRef),
      revalidationPolicy: improvementConfig.review.revalidationPolicy
    });
    const candidatePublish = new CandidatePublishService({
      runs: improvementRuns,
      worktrees: improvementWorktrees,
      candidateReview,
      review: improvementConfig.review,
      repositoryRoot: improvementRepositoryRoot
    });
    const githubReviewProvider = new GitHubReviewProvider({
      repository: improvementConfig.review.repository,
      apiBaseUrl: improvementConfig.review.apiBaseUrl,
      githubTokenEnv: improvementConfig.review.githubTokenEnv,
      logger: new Logger(this.config.logging.level, this.config.logging.logFile)
    });
    const reviewFeedbackRecords = new ImprovementReviewFeedbackRepository(store);
    const revisionProposalRecords = new ImprovementRevisionProposalRepository(store);
    let revisionProposals: RevisionProposalService | undefined;
    const reviewFeedback = new ReviewFeedbackService({
      feedback: reviewFeedbackRecords,
      pullRequests: improvementPullRequests,
      provider: githubReviewProvider,
      logger: new Logger(this.config.logging.level, this.config.logging.logFile),
      artifactRoot: improvementArtifactRoot,
      onEvidenceChanged: (feedbackIds, reason) => { revisionProposals?.markEvidenceChangedByFeedback(feedbackIds, reason); },
      recordAnalytics: event => analytics.recordReviewFeedback(event)
    });
    revisionProposals = new RevisionProposalService({
      feedback: reviewFeedback,
      feedbackStore: reviewFeedbackRecords,
      revisions: revisionProposalRecords,
      pullRequests: improvementPullRequests,
      proposals: proposalRecords,
      runs: improvementRuns,
      provider: githubReviewProvider,
      repository: improvementConfig.review.repository,
      logger: new Logger(this.config.logging.level, this.config.logging.logFile),
      recordAnalytics: event => analytics.recordRevisionOutcome(event)
    });
    const improvementImplementation = new ImprovementImplementationService({
      proposals: proposalRecords,
      proposalService: improvementProposals,
      revisionGate: revisionProposals,
      runs: improvementRuns,
      worktrees: improvementWorktrees,
      agent: new ConfiguredCodingAgent(improvementConfig.codingAgent),
      validation: new ImprovementValidationService({ worktrees: improvementWorktrees, artifactRoot: improvementArtifactRoot }),
      candidateCommits: new CandidateCommitService(improvementWorktrees),
      artifactRoot: improvementArtifactRoot,
      currentMasterSha: () => improvementWorktrees.resolveRef(improvementConfig.baseRef ?? "master"),
      baseRef: improvementConfig.baseRef ?? "master",
      enabled: improvementConfig.enabled ?? false,
      maxActiveRuns: improvementConfig.maxActiveRuns ?? 1,
      logger: new Logger(this.config.logging.level, this.config.logging.logFile)
    });
    const improvementPullRequest = new ImprovementPullRequestService({
      runs: improvementRuns,
      proposals: proposalRecords,
      proposalService: improvementProposals,
      pullRequests: improvementPullRequests,
      evidence: improvementReviewEvidence,
      recommendations: mergeRecommendations,
      candidateReview,
      candidatePublish,
      provider: githubReviewProvider,
      review: improvementConfig.review,
      artifactRoot: improvementArtifactRoot,
      revisionService: revisionProposals,
      onMerged: pullRequest => { postMergeEvaluation.ensureForMergedPullRequest(pullRequest); },
      logger: new Logger(this.config.logging.level, this.config.logging.logFile)
    });
    improvementImplementation.reconcileOnStartup();
    this.improvementImplementation = improvementImplementation;
    const artifacts = new ArtifactRepository(store);
    const artifactExports = new ArtifactExportRepository(store);
    const canReports = new CanReportService(artifacts, path.join(path.dirname(databasePath), "can-artifacts"));
    const groups = new BoardGroupRepository(store);
    const groupBarriers = new BoardGroupBarrierRepository(store);
    const canProfiles = new CanProfileRegistry(new CanProfileRepository(store));
    const canCampaigns = new CanCampaignRepository(store);
    const groupReconcileDecisions = new BoardGroupReconcileDecisionRepository(store);
    const canResults = new CanTestResultRepository(store);
    this.workers = new WorkerRepository(store);
    this.testRuns = new TestRunRepository(store);
    this.sessions = new SessionRepository(store);
    const variableStreamRecords = new VariableStreamRepository(store);
    const eradProfileRecords = new EradProfileRepository(store);
    const artifactSnapshots = new JobArtifactSnapshotService({
      rootDirectory: path.join(path.dirname(databasePath), "artifacts"),
      config: this.config,
      runs: this.testRuns,
      boards,
      sessions: this.sessions,
      workers: this.workers,
      events,
      artifacts,
      exports: artifactExports
    });
    const observabilityRoot = path.join(path.dirname(databasePath), "artifacts");
    const acceptanceClosures = new AcceptanceClosureService({
      rootDirectory: observabilityRoot,
      artifacts
    });
    const trace = new TraceService({
      rootDirectory: observabilityRoot,
      runs: this.testRuns,
      events,
      artifacts,
      exports: artifactExports,
      canResults
    });
    const failureBundles = new FailureBundleService({
      rootDirectory: observabilityRoot,
      runs: this.testRuns,
      sessions: this.sessions,
      events,
      artifacts,
      exports: artifactExports,
      canResults,
      trace
    });
    const metrics = new RunMetricsService({
      rootDirectory: observabilityRoot,
      runs: this.testRuns,
      events,
      artifacts,
      exports: artifactExports,
      canResults
    });
    const baselines = new BaselineService({
      rootDirectory: observabilityRoot,
      runs: this.testRuns,
      artifacts,
      exports: artifactExports,
      metrics
    });
    const verification = new VerificationService({
      rootDirectory: path.join(observabilityRoot, "verification"),
      filesystem: this.config.filesystem,
      config: this.config.verification,
      registerArtifact: artifact => {
        // Host-only verification can be correlated with a durable job without
        // pretending that a standalone verification is itself a target job.
        if (!this.testRuns?.get(artifact.jobId)) return;
        artifacts.upsert(artifact);
      }
    });
    this.registry = new BoardRegistry(boards, events, store, new LeaseRepository(store));
    this.registry.registerAll((this.config.boards ?? []).map(board => ({
      boardId: board.boardId,
      probeSerial: board.probeSerial,
      device: board.device,
      ccxmlPath: board.ccxmlPath,
      tags: board.tags
    })));
    const runtime = await createC2000McpRuntime(this.config, {
      getDaemonHealth: () => this.getHealth(),
      capabilityAudit: analytics,
      getWorkflowAnalytics: input => analytics.getWorkflowAnalytics(input),
      getCapabilityAnalytics: input => analytics.getCapabilityAnalytics(input),
      getToolAnalytics: input => analytics.getToolAnalytics(input),
      getEscalationRecommendations: input => analytics.getEscalationRecommendations(input),
      generateImprovementProposals: input => improvementProposals.generate(input),
      listImprovementProposals: input => improvementProposals.list(input),
      getImprovementProposal: input => improvementProposals.get(input.proposalId),
      reviewImprovementProposal: input => improvementProposals.review(input),
      exportImprovementImplementationPrompt: input => improvementProposals.exportImplementationPrompt(input.proposalId),
      startImprovementImplementation: input => improvementImplementation.start(input),
      getImprovementImplementationRun: input => improvementImplementation.get(input.runId),
      listImprovementImplementationRuns: input => improvementImplementation.list(input),
      getImprovementCandidate: input => improvementImplementation.getCandidate(input.runId),
      cleanupImprovementRun: input => improvementImplementation.cleanup(input.runId),
      publishImprovementCandidate: input => improvementPullRequest.publish(input),
      getImprovementPullRequest: input => improvementPullRequest.get(input),
      refreshImprovementReviewEvidence: input => improvementPullRequest.refresh(input),
      getMergeRecommendation: input => improvementPullRequest.getMergeRecommendation(input),
      refreshReviewFeedback: input => reviewFeedback.refresh(input),
      listReviewFeedback: input => reviewFeedback.list({
        ...(input.pullRequestId ? { pullRequestId: input.pullRequestId } : {}),
        ...(input.pullRequestNumber !== undefined ? { pullRequestNumber: input.pullRequestNumber } : {}),
        ...(input.implementationRunId ? { pullRequestId: improvementPullRequests.findByImplementationRun(input.implementationRunId)?.pullRequestId } : {}),
        ...(input.status ? { status: input.status } : {}),
        ...(input.classification ? { classification: input.classification } : {}),
        limit: input.limit
      }),
      listRevisionProposals: async input => {
        const generated = input.generate
          ? await revisionProposals.generate(input)
          : undefined;
        const pullRequestIdForNumber = input.pullRequestNumber !== undefined
          ? improvementPullRequests.list(500).find(item => item.number === input.pullRequestNumber)?.pullRequestId
          : undefined;
        const listed = revisionProposals.list({
          ...(input.originalProposalId ? { originalProposalId: input.originalProposalId } : {}),
          ...(input.pullRequestId ? { pullRequestId: input.pullRequestId } : {}),
          ...(input.pullRequestNumber !== undefined ? { pullRequestId: pullRequestIdForNumber ?? "__missing_pull_request__" } : {}),
          ...(input.status ? { status: input.status } : {}),
          limit: input.limit
        });
        return {
          ...listed,
          ...(generated ? {
            generatedRevisionProposals: generated.revisionProposals,
            recommendations: generated.recommendations
          } : {})
        };
      },
      reviewRevisionProposal: input => revisionProposals.review(input),
      publishRevisionCandidate: input => improvementPullRequest.publishRevision(input),
      listPostMergeEvaluations: input => postMergeEvaluation.list(input),
      getPostMergeEvaluation: input => postMergeEvaluation.get(input.evaluationId),
      refreshPostMergeEvaluation: input => postMergeEvaluation.refresh(input),
      getRollbackRecommendation: input => input.recommendationId
        ? postMergeEvaluation.getRollbackRecommendation(input.recommendationId)
        : postMergeEvaluation.getRollbackRecommendationForEvaluation(input.evaluationId!),
      reviewRollbackRecommendation: input => postMergeEvaluation.reviewRollbackRecommendation(input),
      getActiveCriticalImprovementRegression: () => postMergeEvaluation.hasActiveCriticalRegression(),
      listBoards: input => ({ boards: this.registry?.list(input) ?? [] }),
      registerBoard: input => this.registerBoard(input),
      recoverBoard: input => this.recoverBoard(input),
      submitTestPlan: input => this.requireJobEngine().submit(input.plan),
      getTestRun: input => this.requireJobEngine().get(input.jobId, input),
      listTestRuns: input => this.requireJobEngine().list(input.status),
      cancelTestRun: input => this.requireJobEngine().cancel(input.jobId),
      getTestArtifacts: input => ({
        jobId: input.jobId,
        artifacts: artifacts.list(input.jobId),
        artifactExport: artifactExports.get(input.jobId) ?? null
      }),
      createAcceptanceClosure: input => acceptanceClosures.create(input),
      exportTrace: input => trace.export(input),
      collectFailureBundle: input => failureBundles.collect(input),
      createRunBaseline: input => baselines.create(input),
      compareRunWithBaseline: input => baselines.compare(input),
      verification,
      submitMultiBoardIpcAcceptance: input => this.requireJobEngine().submit({
        planVersion: 1,
        name: "multi-board-ipc-acceptance",
        boardIds: input.boardIds,
        artifacts: input.artifacts,
        parallelism: input.parallelism,
        steps: [
          { type: "launchMulticore", loadPrograms: false },
          {
            type: "runIpcAcceptance",
            timeoutMs: input.timeoutMs,
            intervalMs: input.intervalMs,
            startupPreset: input.startupPreset,
            resetType: input.resetType,
            programPreparation: input.programPreparation,
            verifyRuntimeRamOwnership: input.verifyRuntimeRamOwnership,
            loadPolicy: input.loadPolicy,
            allowDestructiveFlashReload: input.allowDestructiveFlashReload,
            loadSequence: input.loadSequence,
            runSequence: input.runSequence,
            runMode: input.runMode,
            ipcReadyExpressions: input.ipcReadyExpressions
          },
          { type: "cleanup" }
        ],
        failurePolicy: { ...input.failurePolicy, collectDebugBundle: input.collectDebugBundle },
        recoveryPolicy: "safe_restart_board"
      }),
      submitMultiBoardCanAcceptance: input => this.requireJobEngine().submit({
        planVersion: 1,
        name: input.name,
        boardIds: input.boardIds,
        ...(input.artifacts ? { artifacts: input.artifacts } : {}),
        ...(input.artifactsByBoard ? { artifactsByBoard: input.artifactsByBoard } : {}),
        ...(input.artifactsByRole ? { artifactsByRole: input.artifactsByRole } : {}),
        can: { profile: input.profile },
        steps: [{ type: "launchMulticore", loadPrograms: hasCanArtifacts(input) }, { type: "canAcceptance" }, { type: "cleanup" }],
        failurePolicy: input.failurePolicy,
        recoveryPolicy: "safe_restart_board"
      }),
      submitCanFaultCampaign: input => this.requireJobEngine().submit({
        planVersion: 1, name: input.name, boardIds: input.boardIds, ...(input.artifacts ? { artifacts: input.artifacts } : {}), ...(input.artifactsByBoard ? { artifactsByBoard: input.artifactsByBoard } : {}), ...(input.artifactsByRole ? { artifactsByRole: input.artifactsByRole } : {}),
        can: { profile: input.profile, execution: { mode: "fault_campaign", iterations: input.iterations, matrixCases: [], failFast: input.failFast, health: input.health, resetOrRejoinRequested: input.resetOrRejoinRequested } },
        steps: [{ type: "launchMulticore", loadPrograms: hasCanArtifacts(input) }, { type: "canAcceptance" }, { type: "cleanup" }], failurePolicy: input.failurePolicy, recoveryPolicy: input.resetOrRejoinRequested ? "manual_intervention_required" : "safe_restart_board"
      }),
      submitCanSoakTest: input => this.requireJobEngine().submit({
        planVersion: 1, name: input.name, boardIds: input.boardIds, ...(input.artifacts ? { artifacts: input.artifacts } : {}), ...(input.artifactsByBoard ? { artifactsByBoard: input.artifactsByBoard } : {}), ...(input.artifactsByRole ? { artifactsByRole: input.artifactsByRole } : {}),
        can: { profile: input.profile, execution: { mode: "soak", iterations: input.iterations, ...(input.durationMs ? { durationMs: input.durationMs } : {}), matrixCases: [], failFast: false, health: input.health, resetOrRejoinRequested: false } },
        steps: [{ type: "launchMulticore", loadPrograms: hasCanArtifacts(input) }, { type: "canAcceptance" }, { type: "cleanup" }], failurePolicy: input.failurePolicy, recoveryPolicy: "safe_restart_board"
      }),
      listCanProfiles: input => ({ profiles: canProfiles.list(input) }),
      getBoardGroupSnapshot: input => {
        const group = groups.require(input.groupId);
        return {
          group,
          ...(input.includeBarriers ? { barriers: groupBarriers.list(input.groupId) } : {}),
          ...(input.includeResults ? { results: canResults.listByGroup(input.groupId) } : {}),
          reconcileDecisions: groupReconcileDecisions.list(input.groupId),
          ...(canCampaigns.getByJob(group.jobId ?? "") ? { campaign: canCampaigns.getByJob(group.jobId ?? ""), cases: canCampaigns.getByJob(group.jobId ?? "") ? canCampaigns.cases(canCampaigns.getByJob(group.jobId ?? "")!.campaignId) : [] } : {})
        };
      }
    });
    this.runtime = runtime;
    const workerSupervisor = new BoardWorkerSupervisor({
      config: this.config,
      daemonInstanceId: this.instanceId,
      registry: this.registry,
      workers: this.workers,
      events,
    });
    this.workerSupervisor = workerSupervisor;
    const toolRouter = new DaemonToolRouter(runtime.toolInvoker, this.registry, workerSupervisor, this.sessions, analytics);
    const variableStreams = new VariableStreamService({
      rootDirectory: path.join(path.dirname(databasePath), "artifacts"),
      config: this.config,
      streams: variableStreamRecords,
      boards,
      sessions: this.sessions,
      workers: workerSupervisor,
      leaseContext: (sessionId, boardId, ttlMs) => toolRouter.requireInteractiveLeaseContext(sessionId, boardId, ttlMs)
    });
    this.variableStreams = variableStreams;
    toolRouter.setVariableStreamService(variableStreams);
    const dlog = new DlogService({
      rootDirectory: path.join(path.dirname(databasePath), "artifacts"),
      config: this.config,
      boards,
      sessions: this.sessions,
      workers: workerSupervisor,
      leaseContext: (sessionId, boardId, ttlMs) => toolRouter.requireInteractiveLeaseContext(sessionId, boardId, ttlMs)
    });
    this.dlog = dlog;
    toolRouter.setDlogService(dlog);
    const erad = new EradService({
      rootDirectory: path.join(path.dirname(databasePath), "artifacts"),
      config: this.config,
      profiles: eradProfileRecords,
      boards,
      sessions: this.sessions,
      workers: workerSupervisor,
      leaseContext: (sessionId, boardId, ttlMs) => toolRouter.requireInteractiveLeaseContext(sessionId, boardId, ttlMs)
    });
    this.erad = erad;
    toolRouter.setEradService(erad);
    workerSupervisor.setLowPriorityPreemptor(async (boardId, toolName) => {
      await variableStreams.preemptBoard(boardId, toolName);
      await erad.preemptBoard(boardId, toolName);
    });
    this.jobEngine = new TestJobEngine({
      registry: this.registry,
      runs: this.testRuns,
      events,
      artifacts,
      tools: toolRouter,
      ensureBoardWorker: boardId => workerSupervisor.ensureWorker(boardId),
      maxActiveJobs: this.config.scheduler?.maxActiveJobs ?? 16,
      maxParallelBoards: this.config.scheduler?.maxParallelBoards ?? 4,
      agingThresholdMs: this.config.scheduler?.agingThresholdMs ?? 30000,
      starvationTimeoutMs: this.config.scheduler?.starvationTimeoutMs ?? 300000,
      canAcceptance: new CanAcceptanceService({
        groups,
        barriers: groupBarriers,
        profiles: canProfiles,
        campaigns: canCampaigns,
        reports: canReports,
        results: canResults,
        events,
        tools: toolRouter,
        adapterFactory: kind => {
          if (kind === "mock") return new MockCanBusAdapter();
          const configured = this.config.canAdapters?.[0];
          return configured?.type === "pcan-basic"
            ? new CanWorkerProcess(this.config, this.instanceId)
            : new NoopCanBusAdapter();
        }
      }),
      canCampaigns,
      canResults,
      boardGroups: groups,
      groupBarriers,
      groupReconcileDecisions,
      artifactSnapshots,
      failureBundles,
      filesystem: this.config.filesystem
    });
    const rpcServer = new DaemonRpcServer({
      authToken: this.authToken,
      port: this.daemonConfig.port,
      toolInvoker: toolRouter,
      health: () => this.getHealth(),
      recordOutcomeEvent: event => { analytics.recordExternalEvent(event); },
      shutdown: () => { void this.stop(); }
    });
    this.rpcServer = rpcServer;
    try {
      this.releaseSingleton = await acquireDaemonSingletonLock(this.paths, this.instanceId);
      const endpoint = await rpcServer.listen();
      const instance: DebugDaemonInstance = {
        instanceId: this.instanceId,
        pid: process.pid,
        startedAt: new Date(this.startedAtMs).toISOString(),
        host: endpoint.host,
        port: endpoint.port,
        authTokenFile: newAuthTokenFile(this.paths, this.instanceId),
        databasePath,
        version: SERVER_VERSION,
        contract: runtimeContractIdentity()
      };
      // Do not publish discovery metadata before every configured worker has
      // completed its own runtime handshake. Otherwise a fresh proxy can
      // connect while boards are still only STARTING.
      await workerSupervisor.startAll();
      await writeDaemonInstance(this.paths, instance, this.authToken);
      this.instance = instance;
      const recovering = this.testRuns.markRecovering();
      for (const jobId of recovering) {
        events.append({ level: "warn", sourceType: "daemon", sourceId: instance.instanceId, jobId, eventType: "JOB_MARKED_RECOVERING", payload: {} });
      }
      await artifactSnapshots.recoverExisting();
      await variableStreams.recoverInterrupted();
      this.jobEngine.start();
      return instance;
    } catch (error) {
      await rpcServer.close().catch(() => undefined);
      await workerSupervisor.stopAll().catch(() => undefined);
      await improvementImplementation.shutdown().catch(() => undefined);
      await runtime.dispose().catch(() => undefined);
      store.close();
      this.rpcServer = undefined;
      this.runtime = undefined;
      this.store = undefined;
      this.consistency = undefined;
      this.sessions = undefined;
      this.workerSupervisor = undefined;
      this.variableStreams = undefined;
      this.dlog = undefined;
      this.erad = undefined;
      this.analytics = undefined;
      this.postMergeEvaluation = undefined;
      this.jobEngine = undefined;
      await this.releaseSingleton?.().catch(() => undefined);
      this.releaseSingleton = undefined;
      throw error;
    }
  }

  getHealth(): Record<string, unknown> {
    const health = createDaemonHealth(
      this.instance,
      this.startedAtMs,
      Boolean(this.store),
      this.workers?.countHealthy(),
      this.testRuns?.counts(),
      this.consistency?.check(),
      this.jobEngine?.boardConcurrencySnapshot(),
      this.registry?.list()
    );
    const implementationRuns = this.improvementImplementation?.list({}).runs;
    const activeImplementationRunCount = Array.isArray(implementationRuns)
      ? implementationRuns.filter(run => run && typeof run === "object" && ["created", "agent-running", "agent-complete", "validating", "validation-pending", "validated"].includes(String((run as { status?: unknown }).status))).length
      : 0;
    return {
      ...health,
      toolProfile: this.config.toolProfile ?? "safe",
      toolSurfaceProfile: this.config.toolSurfaceProfile ?? "agent",
      capabilityMode: "dynamic",
      activeImplementationRunCount,
      activeCriticalImprovementRegression: this.postMergeEvaluation?.hasActiveCriticalRegression() ?? false
    };
  }

  async stop(): Promise<void> {
    this.stopping ??= this.stopInternal();
    return this.stopping;
  }

  private async stopInternal(): Promise<void> {
    await this.improvementImplementation?.shutdown().catch(() => undefined);
    this.jobEngine?.beginStop();
    if (this.testRuns) {
      const recovering = this.testRuns.markRecovering();
      for (const jobId of recovering) {
        // Event writing remains available until after the engine has stopped.
        this.store && new EventRepository(this.store).append({ level: "warn", sourceType: "daemon", sourceId: this.instanceId, jobId, eventType: "JOB_MARKED_RECOVERING_ON_STOP", payload: {} });
      }
    }
    await this.rpcServer?.close().catch(() => undefined);
    await this.jobEngine?.stop().catch(() => undefined);
    await this.variableStreams?.stopAll().catch(() => undefined);
    await this.erad?.stopAll().catch(() => undefined);
    await this.workerSupervisor?.stopAll().catch(() => undefined);
    await this.runtime?.dispose().catch(() => undefined);
    this.store?.close();
    this.analytics = undefined;
    this.improvementImplementation = undefined;
    await removeDaemonInstance(this.paths, this.instance?.instanceId);
    await this.releaseSingleton?.().catch(() => undefined);
    this.releaseSingleton = undefined;
    this.rpcServer = undefined;
    this.runtime = undefined;
    this.store = undefined;
    this.consistency = undefined;
    this.registry = undefined;
    this.workers = undefined;
    this.testRuns = undefined;
    this.sessions = undefined;
    this.workerSupervisor = undefined;
    this.variableStreams = undefined;
    this.dlog = undefined;
    this.erad = undefined;
    this.jobEngine = undefined;
    this.instance = undefined;
  }

  private requireJobEngine(): TestJobEngine {
    if (!this.jobEngine) throw new Error("Test job engine is not ready");
    return this.jobEngine;
  }

  private async registerBoard(input: {
    boardId: string;
    probeSerial: string;
    device: string;
    ccxmlPath: string;
    tags: string[];
    startWorker: boolean;
  }): Promise<Record<string, unknown>> {
    const registry = this.registry;
    const supervisor = this.workerSupervisor;
    if (!registry || !supervisor) throw new DebugMcpError("DaemonStarting", "Board registration is not ready");
    await assertCcxmlProbeBinding(input.ccxmlPath, input.probeSerial);
    const registered = registry.list();
    const conflicting = registered.find(board =>
      board.probeSerial === input.probeSerial && board.boardId !== input.boardId
    );
    if (conflicting) {
      throw new DebugMcpError("DuplicateProbeAllocation", `XDS110 ${input.probeSerial} is already registered`, {
        requestedBoardId: input.boardId,
        existingBoardId: conflicting.boardId,
        probeSerial: input.probeSerial
      });
    }
    const previous = registered.find(board => board.boardId === input.boardId);
    const bindingChanged = previous !== undefined
      && (previous.probeSerial !== input.probeSerial || previous.ccxmlPath !== input.ccxmlPath);
    const board = registry.register({
      boardId: input.boardId,
      probeSerial: input.probeSerial,
      device: input.device,
      ccxmlPath: input.ccxmlPath,
      tags: input.tags
    });
    if (!input.startWorker) {
      return { board, workerStarted: false, action: previous ? "UPDATED" : "REGISTERED" };
    }
    if (bindingChanged && previous.currentWorkerInstanceId) {
      await supervisor.restartBoard(input.boardId, "board-registration-updated", {
        previousProbeSerial: previous.probeSerial,
        probeSerial: input.probeSerial
      });
    } else {
      await supervisor.startBoard(input.boardId);
    }
    return {
      board: registry.get(input.boardId),
      workerStarted: true,
      action: previous ? "UPDATED" : "REGISTERED"
    };
  }

  private async recoverBoard(input: { boardId: string; dryRun: boolean }): Promise<Record<string, unknown>> {
    const board = this.registry?.get(input.boardId);
    const supervisor = this.workerSupervisor;
    if (!board || !supervisor) throw new Error("Board recovery is not ready");
    if (input.dryRun) {
      return {
        success: true,
        dryRun: true,
        boardId: board.boardId,
        probeSerial: board.probeSerial,
        action: "RESTART_DAEMON_OWNED_WORKER_ONLY",
        externalProcessTermination: false
      };
    }
    await supervisor.restartBoard(board.boardId, "operator-requested-recovery", { requestedBy: "c2000_recoverBoard" });
    return {
      success: true,
      dryRun: false,
      boardId: board.boardId,
      probeSerial: board.probeSerial,
      action: "RESTARTED_DAEMON_OWNED_WORKER_ONLY",
      externalProcessTermination: false
    };
  }
}

function hasCanArtifacts(input: {
  artifacts?: unknown;
  artifactsByBoard?: unknown;
  artifactsByRole?: unknown;
}): boolean {
  const hasRecordEntries = (value: unknown) => Boolean(value && typeof value === "object" && Object.keys(value).length > 0);
  return Boolean(input.artifacts) || hasRecordEntries(input.artifactsByBoard) || hasRecordEntries(input.artifactsByRole);
}
