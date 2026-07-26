import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { z } from "zod";
import type { DebugSessionManager } from "../debug/DebugSessionManager.js";
import type { CoreId, EvaluateResult, LoadedProgramInfo, ResetType } from "../debug/types.js";
import { analyzeRamOwnership as analyzeRamOwnershipDefault, type MapOwnershipInput, type RamOwnershipAnalysis } from "../hardware/mapOwnership.js";
import { describeProgramArtifact, validateProgramPair } from "../hardware/programDiscovery.js";
import { fileMetadata } from "../utils/fileHash.js";
import type {
  expressionConditionSchema,
  expressionReadSetSchema,
  launchAndRunIpcAcceptanceSchema,
  runBootHandoffDiagnosisSchema,
  runFullDebugBundleSchema,
  runIpcAcceptanceSchema,
  runReloadAndDiagnoseSchema
} from "../mcp/toolSchemas.js";
import { DebugMcpError, toStructuredError } from "../utils/errors.js";
import { buildBootHandoffVerdict } from "../debug/bootHandoffVerdict.js";
import { defaultExpressionReadSets, defaultIpcReadyConditions } from "../debug/defaultDiagnostics.js";
import { valuesEqual } from "../utils/expressionMatch.js";
import { sleep } from "../utils/async.js";
import type { RamOwnershipAction } from "../hardware/mapOwnership.js";
import type { DebugEvidence } from "../debug/DebugEvidence.js";

type ToolResult = Record<string, any>;
type ExpressionCondition = z.infer<typeof expressionConditionSchema>;
type ExpressionReadSet = z.infer<typeof expressionReadSetSchema>;

export class DebugWorkflowService {
  constructor(
    private readonly manager: DebugSessionManager,
    private readonly analyzeRamOwnership: typeof analyzeRamOwnershipDefault = analyzeRamOwnershipDefault
  ) {}

  async launchAndRunIpcAcceptance(input: z.infer<typeof launchAndRunIpcAcceptanceSchema>): Promise<ToolResult> {
    assertIpcArtifactSet(input);
    const sessionName = input.sessionName ?? "launch-and-run-ipc-acceptance";
    const coreIds = [input.cpu1CoreId, input.cpu2CoreId];
    let sessionId: string | undefined;
    const workflowStartedAt = performance.now();
    const cleanup: ToolResult = { sessionClosed: false, probeLeaseReleased: false, cleanupErrors: [], cleanupDurationMs: 0 };

    try {
      const created = await this.manager.createDebugSession({
        sessionName,
        ccxmlPath: input.ccxmlPath,
        probeId: input.probeId,
        preferredProbeIds: input.preferredProbeIds,
        allowAutoProbeAllocation: input.allowAutoProbeAllocation,
        coreMap: [
          { coreId: input.cpu1CoreId, coreName: input.cpu1CoreName, corePattern: input.cpu1CorePattern },
          { coreId: input.cpu2CoreId, coreName: input.cpu2CoreName, corePattern: input.cpu2CorePattern }
        ]
      });
      sessionId = created.sessionId;
      const connected = await this.manager.connectCores(sessionId, coreIds);
      const acceptance = await this.runIpcAcceptance({
        ...input,
        sessionId
      });

      const result = {
        ...acceptance,
        workflow: "c2000_launchAndRunIpcAcceptance",
        autoCloseOnComplete: input.autoCloseOnComplete,
        orchestration: "server-internal",
        mcpToolCalls: [],
        approvalClass: "workflow-confirmation",
        sessionMode: input.sessionMode,
        cleanup,
        performance: { ...acceptance.performance, totalMs: performance.now() - workflowStartedAt },
        launch: {
          sessionName,
          ...(input.ccxmlPath ? { ccxmlPath: input.ccxmlPath } : {}),
          coreMap: created.cores.map(core => ({
            coreId: core.coreId,
            coreName: core.coreName,
            corePattern: core.corePattern
          })),
          connectedCoreIds: coreIds,
          created,
          connected
        }
      };
      if (!input.autoCloseOnComplete) {
        return result;
      }
      return {
        ...result,
        autoClose: this.manager.armIdleAutoClose(sessionId, input.autoCloseIdleTimeoutMs)
      };
    } catch (error) {
      const launch: ToolResult = { sessionName, coreIds };
      if (sessionId && input.sessionMode === "interactive") {
        launch.sessionId = sessionId;
        try {
          await this.manager.closeDebugSession(sessionId);
          launch.cleanedUp = true;
        } catch (cleanupError) {
          launch.cleanedUp = false;
          launch.cleanupError = toStructuredError(cleanupError);
        }
      }
      throw new DebugMcpError(
        "PostLaunchCheckFailed",
        "Launch and IPC acceptance workflow failed",
        { launch, cause: toStructuredError(error) }
      );
    } finally {
      if (sessionId && input.sessionMode === "ephemeral") {
        const cleanupStartedAt = performance.now();
        try {
          await this.manager.closeDebugSession(sessionId);
          cleanup.sessionClosed = true;
          cleanup.probeLeaseReleased = true;
        } catch (cleanupError) {
          cleanup.cleanupErrors.push(toStructuredError(cleanupError));
        } finally {
          cleanup.cleanupDurationMs = performance.now() - cleanupStartedAt;
        }
      }
    }
  }

  async runIpcAcceptance(input: z.infer<typeof runIpcAcceptanceSchema>): Promise<ToolResult> {
    assertIpcArtifactSet(input);
    const workflowStartedAt = performance.now();
    const coreIds = [input.cpu1CoreId, input.cpu2CoreId];
    const performedSteps: string[] = [];
    const maps = this.normalizeMaps(mapsFromPaths(input));

    const initialHalt = await this.manager.haltCores(input.sessionId, coreIds);
    performedSteps.push("haltCores");
    assertBatchSucceeded("haltCores", initialHalt);
    const reset = await this.manager.resetCores(input.sessionId, coreIds, input.resetType as ResetType);
    performedSteps.push("resetCores");
    assertBatchSucceeded("resetCores", reset);
    const cpu1Program = { coreId: input.cpu1CoreId, programUri: input.cpu1OutPath, mapUri: input.cpu1MapPath, loadPolicy: input.loadPolicy };
    const cpu2Program = { coreId: input.cpu2CoreId, programUri: input.cpu2OutPath, mapUri: input.cpu2MapPath, loadPolicy: input.loadPolicy };
    let load;
    if (input.loadSequence.mode === "cpu1-run-before-cpu2") {
      const cpu1Load = await this.manager.loadPrograms(input.sessionId, [cpu1Program]);
      assertBatchSucceeded("loadCpu1Program", cpu1Load);
      performedSteps.push("loadCpu1Program");
      await this.manager.runCore(input.sessionId, input.cpu1CoreId);
      performedSteps.push("runCpu1BeforeCpu2Load");
      await sleep(input.loadSequence.cpu1SettleMs);
      const cpu2Load = await this.manager.loadPrograms(input.sessionId, [cpu2Program]);
      load = { sessionId: input.sessionId, results: [...cpu1Load.results, ...cpu2Load.results] };
      performedSteps.push("loadCpu2Program");
    } else {
      load = await this.manager.loadPrograms(input.sessionId, [cpu1Program, cpu2Program]);
      performedSteps.push("loadPrograms");
    }
    assertBatchSucceeded("loadPrograms", load);
    const postLoadHalt = await this.manager.haltCores(input.sessionId, coreIds);
    performedSteps.push("haltCoresAfterLoad");
    assertBatchSucceeded("haltCoresAfterLoad", postLoadHalt);
    const snapshot = await this.manager.getMulticoreSnapshot(input.sessionId, coreIds);
    performedSteps.push("getMulticoreSnapshot");
    const ramOwnership = await this.analyzeRamOwnership({ maps });
    performedSteps.push("analyzeRamOwnership");
    const elfFreshness = await this.checkElfFreshness(input.sessionId, [
      { coreId: input.cpu1CoreId, outPath: input.cpu1OutPath },
      { coreId: input.cpu2CoreId, outPath: input.cpu2OutPath }
    ]);
    performedSteps.push("checkElfFreshness");
    const runtimeRamOwnership = await this.runtimeRamOwnershipStatus(
      input.sessionId,
      input.verifyRuntimeRamOwnership,
      ramOwnership.ownershipActions
    );
    const runPlan = resolveRunPlan(input.runSequence, input.cpu1CoreId, input.cpu2CoreId);
    for (const coreId of runPlan.coreOrder) {
      await this.manager.runCore(input.sessionId, coreId);
      performedSteps.push(coreId === input.cpu1CoreId ? "runCpu1" : "runCpu2");
      await sleep(input.runSequence.settleMs);
    }
    const conditions = input.ipcReadyExpressions ?? defaultIpcReadyConditions(input.cpu1CoreId, input.cpu2CoreId);
    const ipcReady = await this.waitForExpressionSet(input.sessionId, conditions, input.timeoutMs, input.intervalMs, input.pollingStrategy, input.pollingSchedule);
    performedSteps.push("waitForIpcReady");
    const timeoutRecovery = ipcReady.timedOut
      ? await this.haltAndResolvePc(input.sessionId, coreIds)
      : undefined;
    if (timeoutRecovery) {
      performedSteps.push("haltAndResolvePcOnTimeout");
    }
    const diagnosis = await this.buildBootHandoffDiagnosis({
      sessionId: input.sessionId,
      device: input.device,
      cpu1CoreId: input.cpu1CoreId,
      cpu2CoreId: input.cpu2CoreId,
      ramOwnership,
      elfFreshness,
      runtimeRamOwnership,
      ipcReady,
      extraExpressions: conditions,
      ipcAcceptance: true,
      cpu1Expressions: conditions.filter(condition => condition.coreId === input.cpu1CoreId).map(condition => condition.expression),
      cpu2Expressions: conditions.filter(condition => condition.coreId === input.cpu2CoreId).map(condition => condition.expression)
    });
    performedSteps.push("diagnoseBootHandoff");
    const result: ToolResult = {
      workflow: "c2000_runIpcAcceptance",
      orchestration: "server-internal",
      mcpToolCalls: [],
      approvalClass: "workflow-confirmation",
      effectsApplied: ["target-halt", "target-reset", "program-load", "ram-ownership-change", "target-run", "target-read"],
      sessionId: input.sessionId,
      device: input.device,
      cpu1CoreId: input.cpu1CoreId,
      cpu2CoreId: input.cpu2CoreId,
      success: ipcReady.matched === true
        && load.results.every((item: ToolResult) => item.success === true)
        && elfFreshness.allFresh === true
        && runtimeRamOwnershipAccepted(runtimeRamOwnership),
      performedSteps,
      initialHalt,
      reset,
      load,
      postLoadHalt,
      snapshot,
      ramOwnership,
      elfFreshness,
      runtimeRamOwnership,
      runPlan,
      ipcReady,
      ...(timeoutRecovery ? { timeoutRecovery } : {}),
      diagnosis,
      performance: {
        totalMs: performance.now() - workflowStartedAt,
        ipcPollMs: ipcReady.pollDurationMs,
        ipcPollIterations: ipcReady.pollIterations,
        expressionBatchCount: ipcReady.expressionBatchCalls,
        expressionCount: ipcReady.expressionCount
      }
    };
    if (input.collectDebugBundle) {
      result.debugBundle = await this.writeDebugBundle(input.outputDir ?? defaultBundleDir("ipc-acceptance"), result);
    }
    return result;
  }

  async runBootHandoffDiagnosis(input: z.infer<typeof runBootHandoffDiagnosisSchema>): Promise<ToolResult> {
    const maps = this.normalizeMaps(input.maps ?? mapsFromPaths(input));
    const ramOwnership = maps.length > 0 ? await this.analyzeRamOwnership({ maps }) : undefined;
    const elfFreshness = await this.checkElfFreshness(input.sessionId, [
      { coreId: input.cpu1CoreId, outPath: input.cpu1OutPath },
      { coreId: input.cpu2CoreId, outPath: input.cpu2OutPath }
    ]);
    const runtimeRamOwnership = await this.runtimeRamOwnershipStatus(
      input.sessionId,
      input.verifyRuntimeRamOwnership,
      ramOwnership?.ownershipActions
    );
    return this.buildBootHandoffDiagnosis({
      sessionId: input.sessionId,
      device: input.device,
      cpu1CoreId: input.cpu1CoreId,
      cpu2CoreId: input.cpu2CoreId,
      ramOwnership,
      elfFreshness,
      runtimeRamOwnership,
      extraExpressions: input.expressions
    });
  }

  async runReloadAndDiagnose(input: z.infer<typeof runReloadAndDiagnoseSchema>): Promise<ToolResult> {
    const coreIds = [input.cpu1CoreId, input.cpu2CoreId];
    const performedSteps: string[] = [];
    const maps = this.normalizeMaps(mapsFromPaths(input));
    const halt = await this.manager.haltCores(input.sessionId, coreIds);
    performedSteps.push("haltCores");
    assertBatchSucceeded("haltCores", halt);
    const reset = await this.manager.resetCores(input.sessionId, coreIds, input.resetType as ResetType);
    performedSteps.push("resetCores");
    assertBatchSucceeded("resetCores", reset);
    const load = await this.manager.loadPrograms(input.sessionId, [
      { coreId: input.cpu1CoreId, programUri: input.cpu1OutPath, mapUri: input.cpu1MapPath, loadPolicy: input.loadPolicy },
      { coreId: input.cpu2CoreId, programUri: input.cpu2OutPath, mapUri: input.cpu2MapPath, ramOwnershipPolicy: input.ramOwnershipPolicy, fallbackGsRegions: input.fallbackGsRegions, loadPolicy: input.loadPolicy }
    ]);
    performedSteps.push("loadPrograms");
    assertBatchSucceeded("loadPrograms", load);
    const postLoadHalt = await this.manager.haltCores(input.sessionId, coreIds);
    performedSteps.push("haltCoresAfterLoad");
    assertBatchSucceeded("haltCoresAfterLoad", postLoadHalt);
    let postLoadReset: ToolResult | undefined;
    let postLoadResetHalt: ToolResult | undefined;
    if (input.postLoadBoot) {
      postLoadReset = await this.manager.resetCores(input.sessionId, coreIds, input.postLoadBoot.resetType as ResetType);
      performedSteps.push("resetCoresAfterLoad");
      assertBatchSucceeded("resetCoresAfterLoad", postLoadReset);
      postLoadResetHalt = await this.manager.haltCores(input.sessionId, coreIds);
      performedSteps.push("haltCoresAfterPostLoadReset");
      assertBatchSucceeded("haltCoresAfterPostLoadReset", postLoadResetHalt);
    }
    const snapshot = await this.manager.getMulticoreSnapshot(input.sessionId, coreIds);
    performedSteps.push("getMulticoreSnapshot");
    const ramOwnership = maps.length > 0 ? await this.analyzeRamOwnership({ maps }) : undefined;
    const elfFreshness = await this.checkElfFreshness(input.sessionId, [
      { coreId: input.cpu1CoreId, outPath: input.cpu1OutPath },
      { coreId: input.cpu2CoreId, outPath: input.cpu2OutPath }
    ]);
    const runCpu1 = input.postLoadBoot?.runCpu1 ?? input.runCpu1;
    const runCpu2 = input.postLoadBoot?.runCpu2 ?? input.runCpu2;
    if (runCpu1) {
      await this.manager.runCore(input.sessionId, input.cpu1CoreId);
      performedSteps.push("runCpu1");
    }
    if (input.postLoadBoot && runCpu1 && runCpu2 && input.postLoadBoot.cpu1SettleMs > 0) {
      await sleep(input.postLoadBoot.cpu1SettleMs);
      performedSteps.push("cpu1PostLoadBootSettle");
    }
    if (runCpu2) {
      await this.manager.runCore(input.sessionId, input.cpu2CoreId);
      performedSteps.push("runCpu2");
    }
    const wait = input.waitExpressions && input.timeoutMs
      ? await this.waitForExpressionSet(input.sessionId, input.waitExpressions, input.timeoutMs, input.intervalMs, input.pollingStrategy, input.pollingSchedule)
      : undefined;
    if (wait) {
      performedSteps.push("waitExpressions");
    }
    const runtimeRamOwnership = await this.runtimeRamOwnershipStatus(
      input.sessionId,
      input.verifyRuntimeRamOwnership,
      ramOwnership?.ownershipActions
    );
    const diagnosis = await this.buildBootHandoffDiagnosis({
      sessionId: input.sessionId,
      device: input.device,
      cpu1CoreId: input.cpu1CoreId,
      cpu2CoreId: input.cpu2CoreId,
      ramOwnership,
      elfFreshness,
      runtimeRamOwnership,
      ipcReady: wait
    });
    const result: ToolResult = {
      workflow: "c2000_runReloadAndDiagnose",
      orchestration: "server-internal",
      mcpToolCalls: [],
      approvalClass: "workflow-confirmation",
      effectsApplied: ["target-halt", "target-reset", "program-load", "ram-ownership-change", "target-run", "target-read"],
      sessionId: input.sessionId,
      device: input.device,
      cpu1CoreId: input.cpu1CoreId,
      cpu2CoreId: input.cpu2CoreId,
      success: load.results.every((item: ToolResult) => item.success === true)
        && (!wait || wait.matched === true)
        && runtimeRamOwnershipAccepted(runtimeRamOwnership),
      performedSteps,
      halt,
      reset,
      load,
      postLoadHalt,
      ...(postLoadReset ? {
        postLoadBoot: {
          controlled: true,
          resetType: input.postLoadBoot?.resetType,
          runCpu1,
          runCpu2,
          cpu1SettleMs: input.postLoadBoot?.cpu1SettleMs,
          pcWritten: false
        },
        postLoadReset,
        postLoadResetHalt
      } : {}),
      snapshot,
      ...(ramOwnership ? { ramOwnership } : {}),
      elfFreshness,
      runtimeRamOwnership,
      ...(wait ? { wait } : {}),
      diagnosis
    };
    if (input.collectDebugBundle) {
      result.debugBundle = await this.writeDebugBundle(input.outputDir ?? defaultBundleDir("reload-diagnose"), result);
    }
    return result;
  }

  async runFullDebugBundle(input: z.infer<typeof runFullDebugBundleSchema>): Promise<ToolResult> {
    const coreIds = input.coreIds ?? [input.cpu1CoreId, input.cpu2CoreId];
    const maps = this.normalizeMaps(input.maps ?? mapsFromPaths(input));
    const snapshot = await this.manager.getMulticoreSnapshot(input.sessionId, coreIds);
    const loadedPrograms = await Promise.all(coreIds.map(async coreId => ({
      coreId,
      loadedProgramInfo: await this.manager.getLoadedProgramInfo(input.sessionId, coreId)
    })));
    const expressions = await this.evaluateReadSets(input.sessionId, input.expressions ?? defaultExpressionReadSets(input.cpu1CoreId, input.cpu2CoreId));
    const pc = await Promise.all(coreIds.map(async coreId => ({ coreId, ...(await this.manager.resolvePc(input.sessionId, coreId)) })));
    const ramOwnership = maps.length > 0 ? await this.analyzeRamOwnership({ maps }) : undefined;
    const elfFreshness = await this.checkElfFreshness(input.sessionId, [
      { coreId: input.cpu1CoreId, outPath: input.cpu1OutPath },
      { coreId: input.cpu2CoreId, outPath: input.cpu2OutPath }
    ]);
    const runtimeRamOwnership = await this.runtimeRamOwnershipStatus(
      input.sessionId,
      input.verifyRuntimeRamOwnership,
      ramOwnership?.ownershipActions
    );
    const evidence: DebugEvidence = {
      sessionId: input.sessionId,
      capturedAt: new Date().toISOString(),
      cores: coreIds.map(coreId => {
        const snapshotCore = snapshot.cores.find((core: ToolResult) => core.coreId === coreId);
        return {
          coreId,
          coreName: snapshotCore?.coreName,
          connected: snapshotCore?.connected,
          state: snapshotCore?.state,
          pc: pc.find(item => item.coreId === coreId),
          loadedProgramInfo: loadedPrograms.find(item => item.coreId === coreId)?.loadedProgramInfo,
          expressions: expressions.find(item => item.coreId === coreId)?.results
        };
      }),
      ramOwnership,
      runtimeRamOwnership,
      elfFreshness,
      commandStats: { total: 0, byOperation: {} }
    };
    const bootHandoff = await this.buildBootHandoffDiagnosis({
      sessionId: input.sessionId,
      device: input.device,
      cpu1CoreId: input.cpu1CoreId,
      cpu2CoreId: input.cpu2CoreId,
      ramOwnership,
      elfFreshness,
      runtimeRamOwnership,
      evidence
    });
    const result: ToolResult = {
      workflow: "c2000_runFullDebugBundle",
      orchestration: "server-internal",
      mcpToolCalls: [],
      approvalClass: "workflow-confirmation",
      effectsApplied: ["target-read", "bundle-write"],
      sessionId: input.sessionId,
      device: input.device,
      cpu1CoreId: input.cpu1CoreId,
      cpu2CoreId: input.cpu2CoreId,
      success: runtimeRamOwnershipAccepted(runtimeRamOwnership),
      snapshot,
      loadedPrograms,
      expressions,
      pc,
      ...(ramOwnership ? { ramOwnership } : {}),
      elfFreshness,
      runtimeRamOwnership,
      bootHandoff,
      evidence
    };
    result.bundle = await this.writeDebugBundle(input.outputDir, result);
    return result;
  }

  private async buildBootHandoffDiagnosis(options: {
    sessionId: string;
    device: string;
    cpu1CoreId: CoreId;
    cpu2CoreId: CoreId;
    ramOwnership?: RamOwnershipAnalysis;
    elfFreshness?: ToolResult;
    runtimeRamOwnership?: ToolResult;
    ipcReady?: ToolResult;
    extraExpressions?: ExpressionCondition[];
    ipcAcceptance?: boolean;
    evidence?: DebugEvidence;
    cpu1Expressions?: string[];
    cpu2Expressions?: string[];
  }): Promise<ToolResult> {
    const cpu1Expressions = options.extraExpressions
      ?.filter(condition => condition.coreId === options.cpu1CoreId)
      .map(condition => condition.expression);
    const cpu2Expressions = options.extraExpressions
      ?.filter(condition => condition.coreId === options.cpu2CoreId)
      .map(condition => condition.expression);
    const boot = options.evidence ? bootEvidence(options.evidence, options.cpu1CoreId, options.cpu2CoreId) : await this.manager.diagnoseCpu2Boot({
      sessionId: options.sessionId,
      cpu1CoreId: options.cpu1CoreId,
      cpu2CoreId: options.cpu2CoreId,
      // A caller-supplied IPC condition set is the diagnostic contract for this
      // acceptance run. Pass empty per-core lists deliberately so the manager
      // does not fall back to symbols from an unrelated default application.
      ...(options.extraExpressions ? {
        cpu1Expressions: cpu1Expressions ?? [],
        cpu2Expressions: cpu2Expressions ?? []
      } : {
        cpu1Expressions: options.cpu1Expressions,
        cpu2Expressions: options.cpu2Expressions
      })
    });
    const extraExpressions = options.extraExpressions
      ? await this.evaluateConditions(options.sessionId, options.extraExpressions)
      : undefined;
    const bootVerdict = options.ipcAcceptance
      ? buildIpcAcceptanceVerdict(options.ipcReady, options.ramOwnership)
      : buildBootHandoffVerdict(boot, options.ramOwnership);
    const runtimeOwnershipReady = runtimeRamOwnershipAccepted(options.runtimeRamOwnership);
    const verdict = {
      ...bootVerdict,
      runtimeRamOwnershipReady: runtimeOwnershipReady,
      ready: bootVerdict.ready && runtimeOwnershipReady,
      reasons: runtimeOwnershipReady
        ? bootVerdict.reasons
        : [...bootVerdict.reasons, "Runtime RAM ownership verification was requested but did not match."]
    };
    const ipcTimedOut = options.ipcReady?.timedOut === true;
    const diagnosisCode = ipcTimedOut
      ? "IPC_READY_TIMEOUT"
      : verdict.ready
        ? (options.ipcAcceptance ? "IPC_ACCEPTANCE_READY" : "BOOT_HANDOFF_READY")
        : (options.ipcAcceptance ? "IPC_ACCEPTANCE_NOT_READY" : "BOOT_HANDOFF_NOT_READY");
    const severity = diagnosisCode === "IPC_READY_TIMEOUT"
      ? "error"
      : diagnosisCode === "BOOT_HANDOFF_NOT_READY" || diagnosisCode === "IPC_ACCEPTANCE_NOT_READY"
        ? "warning"
        : "info";
    return {
      workflow: "c2000_runBootHandoffDiagnosis",
      orchestration: "server-internal",
      mcpToolCalls: [],
      approvalClass: "read-only",
      performedSteps: ["snapshot", "loadedPrograms", "expressions", "pc", "ramOwnership", "elfFreshness", "diagnosis"],
      effectsApplied: ["target-read"],
      device: options.device,
      diagnosisCode,
      severity,
      recommendedActions: recommendedActions(diagnosisCode, verdict, options.ramOwnership),
      evidence: {
        explicitCores: { cpu1CoreId: options.cpu1CoreId, cpu2CoreId: options.cpu2CoreId },
        noCcsUiFocusRequired: true,
        managerRoute: "sessionId -> coreId -> DebugSession",
        verdict
      },
      ...boot,
      verdict,
      ...(options.ramOwnership ? { ramOwnership: options.ramOwnership } : {}),
      ...(options.elfFreshness ? { elfFreshness: options.elfFreshness } : {}),
      ...(options.runtimeRamOwnership ? { runtimeRamOwnership: options.runtimeRamOwnership } : {}),
      ...(extraExpressions ? { expressions: extraExpressions } : {})
    };
  }

  private async evaluateReadSets(sessionId: string, readSets: ExpressionReadSet[]) {
    return Promise.all(readSets.map(async readSet => ({
      label: readSet.label,
      coreId: readSet.coreId,
      results: await this.manager.evaluateMany(sessionId, readSet.coreId, readSet.expressions)
    })));
  }

  private async evaluateConditions(sessionId: string, conditions: ExpressionCondition[]) {
    return Promise.all(conditions.map(async condition => {
      const [result] = await this.manager.evaluateMany(sessionId, condition.coreId, [condition.expression]);
      return conditionResult(condition, result);
    }));
  }

  private async waitForExpressionSet(
    sessionId: string,
    conditions: ExpressionCondition[],
    timeoutMs: number,
    intervalMs: number,
    strategy: "fixed" | "adaptive" = "adaptive",
    schedule?: Array<{ untilMs?: number; intervalMs: number }>
  ) {
    const startedAt = performance.now();
    const deadline = startedAt + timeoutMs;
    let lastConditions: ToolResult[] = [];
    let pollIterations = 0;
    let expressionBatchCalls = 0;
    const grouped = groupConditionsByCore(conditions);
    while (performance.now() <= deadline) {
      pollIterations++;
      const batches = await Promise.all(grouped.map(async group => ({
        group,
        results: await this.manager.evaluateMany(sessionId, group.coreId, group.expressions)
      })));
      expressionBatchCalls += batches.length;
      lastConditions = batches.flatMap(({ group, results }) => group.conditions.map(condition =>
        conditionResult(condition, results.find(result => result.expression === condition.expression))
      ));
      if (lastConditions.every(condition => condition.matched)) {
        const pollDurationMs = performance.now() - startedAt;
        return { sessionId, matched: true, timedOut: false, conditions: lastConditions, pollIterations, expressionBatchCalls, expressionCount: pollIterations * conditions.length, pollDurationMs, matchedAtMs: pollDurationMs };
      }
      const remainingMs = deadline - performance.now();
      if (remainingMs <= 0) break;
      const elapsedMs = performance.now() - startedAt;
      await sleep(Math.min(strategy === "fixed" ? intervalMs : adaptiveInterval(elapsedMs, schedule), remainingMs));
    }
    return { sessionId, matched: false, timedOut: true, conditions: lastConditions, pollIterations, expressionBatchCalls, expressionCount: pollIterations * conditions.length, pollDurationMs: performance.now() - startedAt };
  }

  private async haltAndResolvePc(sessionId: string, coreIds: CoreId[]) {
    const halt = await this.manager.haltCores(sessionId, coreIds);
    const pc = await Promise.all(coreIds.map(async coreId => ({ coreId, ...(await this.manager.resolvePc(sessionId, coreId)) })));
    return { halt, pc };
  }

  private async checkElfFreshness(sessionId: string, programs: Array<{ coreId: CoreId; outPath?: string }>) {
    const checked = await Promise.all(programs
      .filter((program): program is { coreId: CoreId; outPath: string } => typeof program.outPath === "string" && program.outPath.length > 0)
      .map(async program => {
        const expectedPath = this.manager.normalizeArtifactUri(program.outPath);
        const loadedProgramInfo = await this.manager.getLoadedProgramInfo(sessionId, program.coreId);
        const metadata = await fileMetadata(expectedPath);
        const fresh = loadedProgramInfo?.programUri === expectedPath
          && loadedProgramInfo.fileSize === metadata.fileSize
          && loadedProgramInfo.sha256 === metadata.sha256;
        return {
          coreId: program.coreId,
          expectedPath,
          fresh,
          hostFile: metadata,
          loadedProgramInfo
        };
      }));
    return {
      allFresh: checked.every(item => item.fresh),
      programs: checked
    };
  }

  private normalizeMaps(maps: MapOwnershipInput["maps"]): MapOwnershipInput["maps"] {
    return maps.map(map => ({
      ...map,
      mapPath: this.manager.normalizeArtifactUri(map.mapPath)
    }));
  }

  private async runtimeRamOwnershipStatus(
    sessionId: string,
    requested: boolean,
    actions?: RamOwnershipAction[]
  ) {
    if (!requested) {
      return {
        requested: false,
        supported: true,
        skipped: true,
        reason: "Runtime RAM ownership verification was not requested."
      };
    }
    try {
      return await this.manager.verifyRuntimeRamOwnership(sessionId, actions ?? []);
    } catch (error) {
      return {
        requested: true,
        supported: true,
        skipped: false,
        matched: false,
        error: toStructuredError(error),
        reason: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private async writeDebugBundle(outputDir: string, result: ToolResult) {
    await mkdir(outputDir, { recursive: true });
    const files: string[] = [];
    const writeJson = async (fileName: string, body: unknown) => {
      const filePath = path.join(outputDir, fileName);
      await writeFile(filePath, `${JSON.stringify(body, null, 2)}\n`);
      files.push(filePath);
    };
    await writeJson("snapshot.json", result.snapshot ?? result.diagnosis?.snapshot ?? result.bootHandoff?.snapshot);
    await writeJson("ram-ownership.json", result.ramOwnership ?? result.diagnosis?.ramOwnership ?? result.bootHandoff?.ramOwnership ?? null);
    await writeJson("elf-freshness.json", result.elfFreshness ?? result.diagnosis?.elfFreshness ?? result.bootHandoff?.elfFreshness ?? null);
    await writeJson("boot-handoff.json", result.diagnosis ?? result.bootHandoff ?? result);
    await writeJson("evidence.json", compactEvidence(result));
    const summaryPath = path.join(outputDir, "summary.md");
    await writeFile(summaryPath, summaryMarkdown(result));
    files.unshift(summaryPath);
    return { outputDir, files };
  }
}

function assertIpcArtifactSet(input: {
  device: string;
  cpu1OutPath: string;
  cpu2OutPath: string;
  cpu1MapPath: string;
  cpu2MapPath: string;
}): void {
  const programPair = validateProgramPair(input.cpu1OutPath, input.cpu2OutPath, input.device);
  const mapPair = validateProgramPair(input.cpu1MapPath, input.cpu2MapPath, input.device);
  const issues = [...programPair.issues, ...mapPair.issues.map(issue => `map: ${issue}`)];
  const cpu1Out = describeProgramArtifact(input.cpu1OutPath);
  const cpu1Map = describeProgramArtifact(input.cpu1MapPath);
  const cpu2Out = describeProgramArtifact(input.cpu2OutPath);
  const cpu2Map = describeProgramArtifact(input.cpu2MapPath);
  if (cpu1Out.configuration && cpu1Map.configuration && cpu1Out.configuration !== cpu1Map.configuration) {
    issues.push(`CPU1 output/map configuration mismatch: ${cpu1Out.configuration} vs ${cpu1Map.configuration}`);
  }
  if (cpu2Out.configuration && cpu2Map.configuration && cpu2Out.configuration !== cpu2Map.configuration) {
    issues.push(`CPU2 output/map configuration mismatch: ${cpu2Out.configuration} vs ${cpu2Map.configuration}`);
  }
  if (issues.length > 0) {
    throw new DebugMcpError("ArtifactPairInvalid", "IPC acceptance artifacts are incomplete or incompatible", {
      programPair,
      mapPair,
      issues
    });
  }
}

function assertBatchSucceeded(label: string, result: ToolResult): void {
  const failed = Array.isArray(result.results)
    ? (result.results as ToolResult[]).filter(item => item.success !== true)
    : [];
  if (failed.length > 0) {
    throw new DebugMcpError("BatchOperationFailed", `${label} failed for ${failed.length} item(s)`, {
      failed
    });
  }
}

function mapsFromPaths(input: { cpu1CoreId: CoreId; cpu2CoreId: CoreId; cpu1MapPath?: string; cpu2MapPath?: string }): MapOwnershipInput["maps"] {
  const maps: Array<MapOwnershipInput["maps"][number] | undefined> = [
    input.cpu1MapPath ? { coreId: input.cpu1CoreId, coreName: "C28xx_CPU1", mapPath: input.cpu1MapPath } : undefined,
    input.cpu2MapPath ? { coreId: input.cpu2CoreId, coreName: "C28xx_CPU2", mapPath: input.cpu2MapPath } : undefined
  ];
  return maps.filter((map): map is MapOwnershipInput["maps"][number] => map !== undefined);
}

function conditionResult(condition: ExpressionCondition, result?: EvaluateResult): ToolResult {
  return {
    label: condition.label,
    coreId: condition.coreId,
    expression: condition.expression,
    expected: condition.expected,
    matched: result?.success === true && valuesEqual(result.value, condition.expected),
    result
  };
}

function bootEvidence(evidence: DebugEvidence, cpu1CoreId: CoreId, cpu2CoreId: CoreId): ToolResult {
  const cpu1 = evidence.cores.find(core => core.coreId === cpu1CoreId);
  const cpu2 = evidence.cores.find(core => core.coreId === cpu2CoreId);
  return {
    sessionId: evidence.sessionId,
    snapshot: {
      sessionId: evidence.sessionId,
      cores: evidence.cores.map(core => ({ coreId: core.coreId, coreName: core.coreName, connected: core.connected, state: core.state, pc: core.pc?.pc }))
    },
    cpu1: { coreId: cpu1CoreId, pc: cpu1?.pc, expressions: cpu1?.expressions ?? [] },
    cpu2: { coreId: cpu2CoreId, pc: cpu2?.pc, expressions: cpu2?.expressions ?? [] }
  };
}
function recommendedActions(diagnosisCode: string, verdict: ToolResult, ramOwnership?: RamOwnershipAnalysis): string[] {
  if (diagnosisCode === "IPC_READY_TIMEOUT") {
    return [
      "Halt both cores and inspect CPU1 IPC stage/ready/error fields and the CPU2 stage expression.",
      "Verify CPU1 runs first and releases CPU2 boot handoff before CPU2 is expected to report IPC ready."
    ];
  }
  if (diagnosisCode === "IPC_ACCEPTANCE_NOT_READY") {
    const actions = ["Check each supplied IPC acceptance condition and the CPU1/CPU2 run sequence before rerunning acceptance."];
    if (!verdict.ramOwnershipReady || (ramOwnership?.ownershipActions.length ?? 0) === 0) {
      actions.push("Review CPU2 .map RAMGS usage and CPU1 MEMCFG_GSXMSEL ownership setup.");
    }
    return actions;
  }
  if (diagnosisCode === "BOOT_HANDOFF_NOT_READY") {
    const actions = ["Check CPU1 IPC stage/ready/error expressions and CPU2 boot stage before rerunning acceptance."];
    if (!verdict.ramOwnershipReady || (ramOwnership?.ownershipActions.length ?? 0) === 0) {
      actions.push("Review CPU2 .map RAMGS usage and CPU1 MEMCFG_GSXMSEL ownership setup.");
    }
    return actions;
  }
  return ["Evidence indicates CPU1/CPU2 boot handoff and IPC-ready state are consistent."];
}

function buildIpcAcceptanceVerdict(ipcReady: ToolResult | undefined, ramOwnership?: RamOwnershipAnalysis): ToolResult {
  const ipcReadyMatched = ipcReady?.matched === true;
  const reasons: string[] = [];
  if (!ipcReadyMatched) {
    reasons.push("The supplied IPC acceptance conditions did not all match.");
  }

  let ramOwnershipReady = true;
  if (ramOwnership) {
    const cpu2NeedsGs = ramOwnership.maps.some(map => map.coreId === 2 && map.usedGsRam.length > 0);
    if (cpu2NeedsGs && ramOwnership.ownershipActions.length === 0) {
      ramOwnershipReady = false;
      reasons.push("CPU2 map uses GS RAM but no ownership actions were generated.");
    }
  }

  return {
    cpu1Ready: ipcReadyMatched,
    cpu2Ready: ipcReadyMatched,
    ipcReady: ipcReadyMatched,
    readinessBasis: "matched-ipc-conditions",
    ramOwnershipReady,
    ready: ipcReadyMatched && ramOwnershipReady,
    reasons
  };
}

function summaryMarkdown(result: ToolResult): string {
  const diagnosis = result.diagnosis ?? result.bootHandoff ?? result;
  const evidence = compactEvidence(result);
  const conditionLines = evidence.conditions.length > 0
    ? evidence.conditions.map((condition: ToolResult) =>
      `- ${condition.label ?? condition.expression}: ${condition.actual ?? "n/a"} (expected ${condition.expected}, matched=${condition.matched})`)
    : ["- No IPC conditions recorded."];
  return [
    `# ${result.workflow ?? "c2000 workflow"} Debug Bundle`,
    "",
    `- sessionId: ${result.sessionId ?? "unknown"}`,
    `- device: ${result.device ?? "unknown"}`,
    `- success: ${String(result.success)}`,
    `- diagnosisCode: ${diagnosis.diagnosisCode ?? "n/a"}`,
    `- severity: ${diagnosis.severity ?? "n/a"}`,
    `- orchestration: ${result.orchestration ?? "server-internal"}`,
    `- mcpToolCalls: ${JSON.stringify(result.mcpToolCalls ?? [])}`,
    `- verdictReady: ${String(evidence.verdictReady)}`,
    `- runtimeRamOwnershipMatched: ${String(evidence.runtimeRamOwnership?.matched ?? "n/a")}`,
    "",
    "## IPC conditions",
    "",
    ...conditionLines,
    "",
    "## Loaded programs",
    "",
    ...evidence.programs.map((program: ToolResult) =>
      `- CPU${program.coreId === 0 ? "1" : "2"}: ${program.path ?? "unknown"} sha256=${program.sha256 ?? "unknown"} fresh=${String(program.fresh)}`),
    "",
    "## PC evidence",
    "",
    ...evidence.pc.map((entry: ToolResult) =>
      `- core ${entry.coreId}: ${entry.address ?? "unknown"}${entry.function ? ` ${entry.function}+${entry.offset ?? "0x0"}` : ""}${entry.memoryRegion ? ` [${entry.memoryRegion}]` : ""}`),
    ""
  ].join("\n");
}

function compactEvidence(result: ToolResult) {
  const diagnosis = result.diagnosis ?? result.bootHandoff ?? result;
  const freshness = result.elfFreshness ?? diagnosis.elfFreshness;
  const conditions = (result.ipcReady?.conditions ?? []).map((condition: ToolResult) => ({
    label: condition.label,
    coreId: condition.coreId,
    expression: condition.expression,
    expected: condition.expected,
    actual: condition.result?.value,
    matched: condition.matched === true
  }));
  const programs = (freshness?.programs ?? []).map((program: ToolResult) => ({
    coreId: program.coreId,
    path: program.expectedPath,
    sha256: program.hostFile?.sha256,
    fresh: program.fresh === true
  }));
  const pc = [diagnosis.cpu1, diagnosis.cpu2]
    .filter(Boolean)
    .map((core: ToolResult) => ({ coreId: core.coreId, ...(core.pc ?? {}) }));
  return {
    success: result.success === true,
    workflow: result.workflow,
    diagnosisCode: diagnosis.diagnosisCode,
    severity: diagnosis.severity,
    verdictReady: diagnosis.verdict?.ready,
    conditions,
    runtimeRamOwnership: result.runtimeRamOwnership ?? diagnosis.runtimeRamOwnership,
    programs,
    pc,
    runPlan: result.runPlan,
    performedSteps: result.performedSteps ?? []
  };
}

function defaultBundleDir(label: string): string {
  return path.join(process.cwd(), ".c2000-debug-bundles", `${label}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
}

function runtimeRamOwnershipAccepted(status: ToolResult | undefined): boolean {
  return status?.requested !== true || status.matched === true;
}

function resolveRunPlan(
  sequence: { runMode?: "cpu1_boots_cpu2" | "debugger_runs_both" | "cpu2_pre_running"; runCpu1First: boolean; runCpu2: boolean },
  cpu1CoreId: CoreId,
  cpu2CoreId: CoreId
) {
  if (sequence.runMode === "cpu1_boots_cpu2") {
    return {
      mode: sequence.runMode,
      coreOrder: [cpu1CoreId],
      warnings: ["CPU2 is not run by the debugger; use this mode only when CPU1 firmware releases CPU2 from reset."]
    };
  }
  if (sequence.runMode === "debugger_runs_both") {
    return { mode: sequence.runMode, coreOrder: [cpu1CoreId, cpu2CoreId], warnings: [] };
  }
  if (sequence.runMode === "cpu2_pre_running") {
    return {
      mode: sequence.runMode,
      coreOrder: [cpu2CoreId, cpu1CoreId],
      warnings: ["CPU2 is started before CPU1; use only for firmware designed for this ordering."]
    };
  }
  return {
    mode: "legacy_flags" as const,
    coreOrder: [
      ...(sequence.runCpu1First ? [cpu1CoreId] : []),
      ...(sequence.runCpu2 ? [cpu2CoreId] : [])
    ],
    warnings: sequence.runCpu1First && !sequence.runCpu2
      ? ["CPU2 remains debugger-halted unless CPU1 firmware explicitly releases it."]
      : []
  };
}

function groupConditionsByCore(conditions: ExpressionCondition[]) {
  const groups = new Map<CoreId, ExpressionCondition[]>();
  for (const condition of conditions) groups.set(condition.coreId, [...(groups.get(condition.coreId) ?? []), condition]);
  return [...groups.entries()].map(([coreId, coreConditions]) => ({
    coreId,
    conditions: coreConditions,
    expressions: [...new Set(coreConditions.map(condition => condition.expression))]
  }));
}

function adaptiveInterval(elapsedMs: number, schedule?: Array<{ untilMs?: number; intervalMs: number }>) {
  const selected = schedule ?? [{ untilMs: 500, intervalMs: 50 }, { untilMs: 2000, intervalMs: 100 }, { intervalMs: 250 }];
  return selected.find(item => item.untilMs === undefined || elapsedMs < item.untilMs)?.intervalMs ?? selected[selected.length - 1]!.intervalMs;
}
