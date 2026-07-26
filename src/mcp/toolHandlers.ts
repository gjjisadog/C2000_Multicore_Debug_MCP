import type { z } from "zod";
import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DebugSessionManager } from "../debug/DebugSessionManager.js";
import type { ResetType } from "../debug/types.js";
import { assertRunPauseAcceptanceSummary } from "../debug/runPauseAcceptance.js";
import { buildAcceptanceEvidencePlan, buildUiIndependenceEvidence, getDebugBoundary } from "../debug/boundary.js";
import { discoverAcceptancePrograms as discoverAcceptanceProgramsDefault, validateProgramPair } from "../hardware/programDiscovery.js";
import { analyzeRamOwnership as analyzeRamOwnershipDefault } from "../hardware/mapOwnership.js";
import { formatDebugProcessOwners, runHardwarePreflight } from "../hardware/preflight.js";
import { DebugWorkflowService } from "../workflows/DebugWorkflowService.js";
import { DebugMcpError, toStructuredError } from "../utils/errors.js";
import { buildBootHandoffVerdict as buildBootHandoffVerdictCore } from "../debug/bootHandoffVerdict.js";
import { valuesEqual as valuesEqualCore } from "../utils/expressionMatch.js";
import { sleep as sleepCore } from "../utils/async.js";
import { defaultIpcReadyConditions as defaultIpcReadyConditionsCore } from "../debug/defaultDiagnostics.js";
import { resolveTiEnvironment as resolveTiEnvironmentDefault, type ResolveTiEnvironmentOptions } from "../config/tiPaths.js";
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
  waitUntilExpressionSchema
} from "./toolSchemas.js";

type ToolResult = Record<string, any>;

export interface ToolHandlerDeps {
  runHardwarePreflight?: typeof runHardwarePreflight;
  discoverAcceptancePrograms?: typeof discoverAcceptanceProgramsDefault;
  analyzeRamOwnership?: typeof analyzeRamOwnershipDefault;
  getToolContracts?: () => ToolResult[];
  getToolSurfaceGuide?: () => ToolResult;
  getDaemonHealth?: () => Promise<ToolResult> | ToolResult;
  listBoards?: (input: z.infer<typeof listBoardsSchema>) => Promise<ToolResult> | ToolResult;
  registerBoard?: (input: z.infer<typeof registerBoardSchema>) => Promise<ToolResult> | ToolResult;
  recoverBoard?: (input: z.infer<typeof recoverBoardSchema>) => Promise<ToolResult> | ToolResult;
  submitTestPlan?: (input: z.infer<typeof submitTestPlanSchema>) => Promise<ToolResult> | ToolResult;
  getTestRun?: (input: z.infer<typeof getTestRunSchema>) => Promise<ToolResult> | ToolResult;
  listTestRuns?: (input: z.infer<typeof listTestRunsSchema>) => Promise<ToolResult> | ToolResult;
  cancelTestRun?: (input: z.infer<typeof cancelTestRunSchema>) => Promise<ToolResult> | ToolResult;
  getTestArtifacts?: (input: z.infer<typeof getTestArtifactsSchema>) => Promise<ToolResult> | ToolResult;
  submitMultiBoardIpcAcceptance?: (input: z.infer<typeof submitMultiBoardIpcAcceptanceSchema>) => Promise<ToolResult> | ToolResult;
  submitMultiBoardCanAcceptance?: (input: z.infer<typeof submitMultiBoardCanAcceptanceSchema>) => Promise<ToolResult> | ToolResult;
  listCanProfiles?: (input: z.infer<typeof listCanProfilesSchema>) => Promise<ToolResult> | ToolResult;
  getBoardGroupSnapshot?: (input: z.infer<typeof getBoardGroupSnapshotSchema>) => Promise<ToolResult> | ToolResult;
  submitCanFaultCampaign?: (input: z.infer<typeof submitCanFaultCampaignSchema>) => Promise<ToolResult> | ToolResult;
  submitCanSoakTest?: (input: z.infer<typeof submitCanSoakTestSchema>) => Promise<ToolResult> | ToolResult;
  getToolProfile?: () => { activeToolProfile: string; hiddenTools: string[]; profileReason: string };
  getServerHealth?: () => ToolResult;
  resolveTiEnvironment?: typeof resolveTiEnvironmentDefault;
  tiEnvironment?: ResolveTiEnvironmentOptions;
}

export function createToolHandlers(manager: DebugSessionManager, deps: ToolHandlerDeps = {}) {
  const hardwarePreflight = deps.runHardwarePreflight ?? runHardwarePreflight;
  const discoverAcceptancePrograms = deps.discoverAcceptancePrograms ?? discoverAcceptanceProgramsDefault;
  const analyzeRamOwnership = deps.analyzeRamOwnership ?? analyzeRamOwnershipDefault;
  const getToolContracts = deps.getToolContracts ?? (() => []);
  const getToolSurfaceGuide = deps.getToolSurfaceGuide ?? (() => ({}));
  const getDaemonHealth = deps.getDaemonHealth ?? (() => ({
    daemon: { available: false, reason: "This runtime is not hosted by c2000-debugd" },
    workers: { total: 0, healthy: 0, unhealthy: 0 },
    jobs: { queued: 0, running: 0 }
  }));
  const unavailableJobEngine = () => { throw new DebugMcpError("DaemonUnavailable", "Background test jobs require c2000-debugd"); };
  const unavailableRecovery = () => { throw new DebugMcpError("DaemonUnavailable", "Board recovery requires c2000-debugd"); };
  const unavailableRegistration = () => { throw new DebugMcpError("DaemonUnavailable", "Board registration requires c2000-debugd"); };
  const listBoards = deps.listBoards ?? (() => ({ boards: [] }));
  const registerBoard = deps.registerBoard ?? unavailableRegistration;
  const recoverBoard = deps.recoverBoard ?? unavailableRecovery;
  const submitTestPlan = deps.submitTestPlan ?? unavailableJobEngine;
  const getTestRun = deps.getTestRun ?? unavailableJobEngine;
  const listTestRuns = deps.listTestRuns ?? unavailableJobEngine;
  const cancelTestRun = deps.cancelTestRun ?? unavailableJobEngine;
  const getTestArtifacts = deps.getTestArtifacts ?? unavailableJobEngine;
  const submitMultiBoardIpcAcceptance = deps.submitMultiBoardIpcAcceptance ?? unavailableJobEngine;
  const submitMultiBoardCanAcceptance = deps.submitMultiBoardCanAcceptance ?? unavailableJobEngine;
  const listCanProfiles = deps.listCanProfiles ?? unavailableJobEngine;
  const getBoardGroupSnapshot = deps.getBoardGroupSnapshot ?? unavailableJobEngine;
  const submitCanFaultCampaign = deps.submitCanFaultCampaign ?? unavailableJobEngine;
  const submitCanSoakTest = deps.submitCanSoakTest ?? unavailableJobEngine;
  const getToolProfile = deps.getToolProfile ?? (() => ({ activeToolProfile: "full", hiddenTools: [], profileReason: "All tools are available." }));
  const getServerHealth = deps.getServerHealth ?? (() => ({ status: "ready" }));
  const daemonRoutingConfigured = Boolean(deps.getDaemonHealth && deps.listBoards);
  const resolveTiEnvironment = deps.resolveTiEnvironment ?? resolveTiEnvironmentDefault;
  const workflows = new DebugWorkflowService(manager, analyzeRamOwnership);
  const ok = (body: ToolResult = {}): ToolResult => ({ success: true, timestamp: new Date().toISOString(), ...body });
  const fail = (error: unknown, body: ToolResult = {}): ToolResult => ({
    success: false,
    timestamp: new Date().toISOString(),
    ...body,
    error: toStructuredError(error)
  });
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
    async submitMultiBoardIpcAcceptance(input: z.infer<typeof submitMultiBoardIpcAcceptanceSchema>) { try { return ok(await submitMultiBoardIpcAcceptance(input)); } catch (error) { return fail(error); } },
    async submitMultiBoardCanAcceptance(input: z.infer<typeof submitMultiBoardCanAcceptanceSchema>) { try { return ok(await submitMultiBoardCanAcceptance(input)); } catch (error) { return fail(error); } },
    async listCanProfiles(input: z.infer<typeof listCanProfilesSchema>) { try { return ok(await listCanProfiles(input)); } catch (error) { return fail(error); } },
    async getBoardGroupSnapshot(input: z.infer<typeof getBoardGroupSnapshotSchema>) { try { return ok(await getBoardGroupSnapshot(input)); } catch (error) { return fail(error, { groupId: input.groupId }); } },
    async submitCanFaultCampaign(input: z.infer<typeof submitCanFaultCampaignSchema>) { try { return ok(await submitCanFaultCampaign(input)); } catch (error) { return fail(error); } },
    async submitCanSoakTest(input: z.infer<typeof submitCanSoakTestSchema>) { try { return ok(await submitCanSoakTest(input)); } catch (error) { return fail(error); } },
    async getServerHealth(_input: z.infer<typeof serverHealthSchema>) {
      try {
        return ok(getServerHealth());
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
          searchRoots: input.searchRoots ?? programSearchRoots(),
          maxDepth: input.maxDepth
        }));
      } catch (error) {
        return fail(error);
      }
    },

    async getAcceptanceReadiness(input: z.input<typeof acceptanceReadinessSchema>) {
      try {
        const waitForProbeMs = input.waitForProbeMs ?? 0;
        const probePollIntervalMs = input.probePollIntervalMs ?? 250;
        const ccxmlPath = input.ccxmlPath ?? process.env.C2000_MCP_CCXML_PATH;
        const allowExistingDebugProcesses = input.allowExistingDebugProcesses ?? process.env.C2000_ALLOW_EXISTING_DEBUG_PROCESSES === "1";
        const programDiscovery = await discoverAcceptancePrograms({
          cpu1Program: input.cpu1Program ?? process.env.C2000_CPU1_OUT,
          cpu2Program: input.cpu2Program ?? process.env.C2000_CPU2_OUT,
          searchRoots: input.searchRoots ?? programSearchRoots(),
          maxDepth: input.maxDepth
        });
        const probeWaitStartedAt = Date.now();
        let preflight = await hardwarePreflight({ ccsInstallPath: input.ccsInstallPath ?? deps.tiEnvironment?.ccsInstallPath });
        let probeWaitAttempts = 1;
        while (waitForProbeMs > 0
          && Date.now() - probeWaitStartedAt < waitForProbeMs
          && !preflightReady(preflight, allowExistingDebugProcesses)) {
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
        const debugBoundary = getDebugBoundary();
        const uiIndependenceEvidence = buildUiIndependenceEvidence(debugBoundary);
        const acceptanceEvidence = buildAcceptanceEvidencePlan();
        const cpu1Program = discoveredProgramForCore(0, programDiscovery);
        const cpu2Program = discoveredProgramForCore(2, programDiscovery);
        const artifactPair = programDiscovery.pairing ?? validateProgramPair(cpu1Program, cpu2Program, "F28P65x");
        const debugProcessOwners = formatDebugProcessOwners(preflight);
        const hasDebugProcessOwners = preflight.debugProcessDetails.length > 0 || preflight.debugProcesses.length > 0;
        const daemonHealth: ToolResult | undefined = daemonRoutingConfigured
          ? await Promise.resolve(getDaemonHealth()) as ToolResult
          : undefined;
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
        return fail(error);
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
          loadPolicy: input.loadPolicy
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
        return ok(await manager.assignExpression(parsed.sessionId, parsed.coreId, parsed.expression, parsed.value, parsed.verify));
      } catch (error) {
        return fail(error, { sessionId: input.sessionId, coreId: input.coreId });
      }
    },

    async assignExpressions(input: z.input<typeof assignExpressionsSchema>) {
      try {
        const parsed = assignExpressionsSchema.parse(input);
        return okBatch("c2000_assignExpressions", await manager.assignExpressions(parsed.sessionId, parsed.assignments));
      } catch (error) {
        return fail(error, { sessionId: input.sessionId });
      }
    },

    async injectFaults(input: z.input<typeof injectFaultsSchema>) {
      try {
        const parsed = injectFaultsSchema.parse(input);
        return okBatch("c2000_injectFaults", await manager.injectFaults(parsed.sessionId, parsed.faults));
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
      const startedAt = performance.now();
      const deadline = startedAt + parsed.timeoutMs;
      let lastConditions: ToolResult[] = [];
      let pollIterations = 0;
      let expressionBatchCalls = 0;
      while (performance.now() <= deadline) {
        pollIterations++;
        const evaluated = await evaluateConditions(parsed.sessionId, parsed.conditions);
        lastConditions = evaluated.conditions;
        expressionBatchCalls += evaluated.expressionBatchCalls;
        if (lastConditions.every(condition => condition.matched)) {
          const pollDurationMs = performance.now() - startedAt;
          return ok({
            sessionId: parsed.sessionId,
            matched: true,
            timedOut: false,
            conditions: lastConditions,
            pollIterations,
            expressionBatchCalls,
            expressionCount: pollIterations * parsed.conditions.length,
            pollDurationMs,
            matchedAtMs: pollDurationMs
          });
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
        expressionCount: pollIterations * parsed.conditions.length,
        pollDurationMs: performance.now() - startedAt
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
        const load = await manager.loadPrograms(parsed.sessionId, [{
          coreId: parsed.coreId,
          programUri: parsed.programUri,
          mapUri: parsed.mapUri,
          ramOwnershipPolicy: parsed.ramOwnershipPolicy,
          fallbackGsRegions: parsed.fallbackGsRegions,
          loadPolicy: parsed.loadPolicy
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
        const finalState = await manager.getTargetState(parsed.sessionId, parsed.coreId);
        return ok({
          sessionId: parsed.sessionId,
          coreId: finalState.coreId,
          coreName: finalState.coreName,
          performedSteps: ["loadProgram", "resetCore", "runCore", "getTargetState"],
          loadedProgram,
          reset,
          run,
          finalState,
          runToMainSupported: false,
          runToMainAchieved: false,
          unsupportedReason: "Current DebugAdapter has no breakpoint/runToSymbol API; this tool reloads, resets, runs, and returns explicit evidence instead of claiming a halted-at-main state."
        });
      } catch (error) {
        return fail(error, { sessionId: input.sessionId, coreId: input.coreId });
      }
    },

    async runIpcAcceptance(input: z.input<typeof runIpcAcceptanceSchema>) {
      try {
        const parsed = runIpcAcceptanceSchema.parse(input);
        return ok(await workflows.runIpcAcceptance(parsed));
      } catch (error) {
        return fail(error, { sessionId: input.sessionId });
      }
    },

    async launchAndRunIpcAcceptance(input: z.input<typeof launchAndRunIpcAcceptanceSchema>) {
      try {
        const parsed = launchAndRunIpcAcceptanceSchema.parse(input);
        return ok(await workflows.launchAndRunIpcAcceptance(parsed));
      } catch (error) {
        return fail(error);
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
              await manager.loadProgramWithMap(created.sessionId, core.coreId, core.programUri!, core.mapUri);
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
      try {
        const parsed = launchMulticoreDebugSchema.parse(input);
        const programDiscovery = parsed.programDiscovery?.enabled
          ? await discoverAcceptancePrograms({
            cpu1Program: parsed.programDiscovery.cpu1Program ?? process.env.C2000_CPU1_OUT,
            cpu2Program: parsed.programDiscovery.cpu2Program ?? process.env.C2000_CPU2_OUT,
            searchRoots: parsed.programDiscovery.searchRoots ?? programSearchRoots(),
            maxDepth: parsed.programDiscovery.maxDepth
          })
          : undefined;
        if (programDiscovery) {
          failureContext = { programDiscovery };
        }
        const cores = programDiscovery
          ? parsed.cores.map(core => ({
            ...core,
            programUri: core.programUri ?? discoveredProgramForCore(core.coreId, programDiscovery)
          }))
          : parsed.cores;
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
        // CPU1 first so GS ownership writes for CPU2 always see a connected owner core.
        const orderedCores = orderCoresCpu1First(cores);
        for (const core of orderedCores) {
          if (core.connect) {
            await manager.connectTarget(created.sessionId, core.coreId);
          }
          if (core.load) {
            const programUri = core.programUri;
            if (!programUri) {
              throw new DebugMcpError("LaunchProgramMissing", `No programUri is available for launch core ${core.coreId}`, {
                coreId: core.coreId,
                coreName: core.coreName,
                programDiscovery
              });
            }
            await manager.loadProgramWithMap(created.sessionId, core.coreId, programUri, core.mapUri, core.ramOwnershipPolicy ?? "skip", core.fallbackGsRegions);
          }
          if (core.haltAtEntry) {
            await manager.haltCore(created.sessionId, core.coreId);
          }
        }
        const snapshot = await manager.getMulticoreSnapshot(created.sessionId);
        failureContext = { sessionId: created.sessionId, snapshot };
        const postLaunchActions: ToolResult = {};
        if (parsed.postLaunchActions?.assignExpressions) {
          postLaunchActions.assignExpressions = await manager.assignExpressions(
            created.sessionId,
            parsed.postLaunchActions.assignExpressions
          );
        }
        if (parsed.postLaunchActions?.injectFaults) {
          postLaunchActions.injectFaults = await manager.injectFaults(
            created.sessionId,
            parsed.postLaunchActions.injectFaults
          );
        }
        if (Object.keys(postLaunchActions).length > 0) {
          failureContext = { ...failureContext, postLaunchActions };
          assertPostLaunchActions(postLaunchActions);
        }
        const postLaunchChecks: ToolResult = {};
        if (parsed.postLaunchChecks?.waitForExpressionSet) {
          postLaunchChecks.waitForExpressionSet = await waitForExpressionSetResult(
            created.sessionId,
            parsed.postLaunchChecks.waitForExpressionSet.conditions,
            parsed.postLaunchChecks.waitForExpressionSet.timeoutMs,
            parsed.postLaunchChecks.waitForExpressionSet.intervalMs
          );
        }
        if (parsed.postLaunchChecks?.compareExpressions) {
          postLaunchChecks.compareExpressions = await manager.compareExpressions(
            created.sessionId,
            parsed.postLaunchChecks.compareExpressions
          );
        }
        if (parsed.postLaunchChecks?.diagnoseCpu2Boot) {
          postLaunchChecks.diagnoseCpu2Boot = await manager.diagnoseCpu2Boot({
            sessionId: created.sessionId,
            cpu1CoreId: parsed.postLaunchChecks.diagnoseCpu2Boot.cpu1CoreId,
            cpu2CoreId: parsed.postLaunchChecks.diagnoseCpu2Boot.cpu2CoreId,
            cpu1Expressions: parsed.postLaunchChecks.diagnoseCpu2Boot.cpu1Expressions,
            cpu2Expressions: parsed.postLaunchChecks.diagnoseCpu2Boot.cpu2Expressions
          });
        }
        if (parsed.postLaunchChecks?.verifyRunPauseIsolation) {
          postLaunchChecks.verifyRunPauseIsolation = await manager.verifyRunPauseIsolation({
            sessionId: created.sessionId,
            cpu1CoreId: parsed.postLaunchChecks.verifyRunPauseIsolation.cpu1CoreId,
            cpu2CoreId: parsed.postLaunchChecks.verifyRunPauseIsolation.cpu2CoreId,
            settleMs: parsed.postLaunchChecks.verifyRunPauseIsolation.settleMs
          });
        }
        if (Object.keys(postLaunchChecks).length > 0) {
          failureContext = { ...failureContext, postLaunchChecks };
          assertPostLaunchChecks(postLaunchChecks, {
            verifyRunPauseIsolation: parsed.postLaunchChecks?.verifyRunPauseIsolation
          });
        }
        const result = {
          sessionId: created.sessionId,
          deprecated: true,
          replacementTool: "c2000_launchMulticoreDebugWithActions",
          snapshot,
          autoCloseOnComplete: parsed.autoCloseOnComplete,
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
        const body: ToolResult = { ...failureContext };
        if (createdSessionId) {
          body.sessionId = createdSessionId;
          try {
            await manager.closeDebugSession(createdSessionId);
            body.cleanedUp = true;
          } catch (cleanupError) {
            body.cleanedUp = false;
            body.cleanupError = toStructuredError(cleanupError);
          }
        }
        return fail(error, body);
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

function programSearchRoots(): string[] {
  const configured = process.env.C2000_PROGRAM_SEARCH_ROOTS;
  if (configured) {
    return configured.split(path.delimiter).filter(Boolean);
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

function valuesEqual(actual: unknown, expected: unknown): boolean {
  return valuesEqualCore(actual, expected);
}

function sleep(ms: number): Promise<void> {
  return sleepCore(ms);
}
