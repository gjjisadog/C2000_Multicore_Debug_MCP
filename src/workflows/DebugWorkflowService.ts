import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { z } from "zod";
import type { DebugSessionManager } from "../debug/DebugSessionManager.js";
import type { CoreId, Cpu2FaultEvidenceOptions, EvaluateResult, LoadedProgramInfo, ResetType } from "../debug/types.js";
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
import { DebugMcpError, toStructuredError, type DebugErrorCode } from "../utils/errors.js";
import { buildBootHandoffVerdict } from "../debug/bootHandoffVerdict.js";
import { DEFAULT_CPU1_BOOT_EXPRESSIONS, defaultExpressionReadSets, defaultIpcReadyConditions } from "../debug/defaultDiagnostics.js";
import { classifyDebugFailure, classifyIpcAcceptance } from "../debug/DebugFailureClassifier.js";
import { describeWorkflowStartupContract, workflowStartupContractIssues } from "../debug/startupContract.js";
import { createApplicationEntryPlan, waitForApplicationEntry, type ApplicationEntryCheck } from "../debug/applicationEntry.js";
import { isPairedFlashPreset } from "./startupProfiles.js";
import { valuesEqual } from "../utils/expressionMatch.js";
import { Cpu2BootGate, assertReadOwnership } from "../debug/Cpu2BootGate.js";
import { bootObservationExpressionSchema, type Cpu2BootContract } from "../jobs/TestPlanSchema.js";
import { sleep } from "../utils/async.js";
import type { RamOwnershipAction } from "../hardware/mapOwnership.js";
import type { DebugEvidence } from "../debug/DebugEvidence.js";
import { assertAllowedWritePath, type FilesystemPolicy } from "../security/pathPolicy.js";
import { verifyResidentImageForSession, type ResidentImageVerificationCheck } from "../debug/residentImageVerification.js";

type ToolResult = Record<string, any>;
type ExpressionCondition = z.infer<typeof expressionConditionSchema>;
type ExpressionReadSet = z.infer<typeof expressionReadSetSchema>;

const SYMBOLS_ONLY_FLASH_NOTE = "Symbols loaded; target Flash contents were not verified by this workflow.";

export class DebugWorkflowService {
  constructor(
    private readonly manager: DebugSessionManager,
    private readonly analyzeRamOwnership: typeof analyzeRamOwnershipDefault = analyzeRamOwnershipDefault,
    private readonly filesystem?: FilesystemPolicy
  ) {}

  async launchAndRunIpcAcceptance(input: z.infer<typeof launchAndRunIpcAcceptanceSchema>): Promise<ToolResult> {
    if (input.systemResetBeforeHandoff) {
      throw new DebugMcpError("StartupContractInvalid", "System Reset requires a guarded current-session IPC step after an exact-pair load; it cannot create a new session");
    }
    assertWorkflowStartupContract(input);
    const artifactPreflight = await assertIpcArtifactSet(input, artifactPath => this.manager.normalizeArtifactUri(artifactPath));
    const sessionName = input.sessionName ?? "launch-and-run-ipc-acceptance";
    const coreIds = [input.cpu1CoreId, input.cpu2CoreId];
    let sessionId: string | undefined;
    const workflowStartedAt = performance.now();
    const cleanup: ToolResult = { sessionClosed: false, probeLeaseReleased: false, cleanupErrors: [], cleanupDurationMs: 0 };
    let cleanupAttempted = false;
    const cleanupSession = async () => {
      if (!sessionId || cleanupAttempted) return;
      cleanupAttempted = true;
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
    };

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
      const residentVerification = input.residentImageManifests?.length
        ? await this.verifyResidentImage(sessionId, input.residentImageManifests)
        : undefined;
      const acceptance = await this.runIpcAcceptanceInternal({
        ...input,
        sessionId
      }, artifactPreflight, () => undefined, residentVerification);

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
      if (sessionId) {
        launch.sessionId = sessionId;
        const shouldCleanup = input.sessionMode === "ephemeral" || input.cleanupOnFailure;
        if (shouldCleanup) {
          await cleanupSession();
          launch.cleanedUp = cleanup.sessionClosed && cleanup.probeLeaseReleased && cleanup.cleanupErrors.length === 0;
          if (cleanup.cleanupErrors.length > 0) {
            launch.cleanupError = cleanup.cleanupErrors[0];
          }
        } else {
          launch.cleanedUp = false;
          launch.preservedForRecovery = true;
        }
      }
      const cause = toStructuredError(error);
      throw new DebugMcpError(
        "PostLaunchCheckFailed",
        "Launch and IPC acceptance workflow failed",
        { launch, cause, cleanup, optimization: classifyDebugFailure(cause) }
      );
    } finally {
      if (sessionId && input.sessionMode === "ephemeral") await cleanupSession();
    }
  }

  async runIpcAcceptance(input: z.infer<typeof runIpcAcceptanceSchema>): Promise<ToolResult> {
    const effectiveStartup = {
      startupPreset: input.startupPreset ?? null,
      resetType: input.resetType,
      postLoadResetType: input.postLoadResetType ?? null,
      systemResetBeforeHandoff: input.systemResetBeforeHandoff ?? null,
      loadSequence: input.loadSequence,
      runSequence: input.runSequence,
      programPreparation: input.programPreparation,
      cpu1EntryAddress: input.cpu1EntryAddress ?? null,
      applicationEntryTimeoutMs: input.applicationEntryTimeoutMs,
      timeoutMs: input.timeoutMs,
      intervalMs: input.intervalMs
    };
    let workflowStage = "artifact-validation";
    try {
      const result = await this.runIpcAcceptanceCore(input, stage => { workflowStage = stage; });
      return { ...result, effectiveStartup, workflowStage: "completed" };
    } catch (error) {
      if (error instanceof DebugMcpError) {
        let isolation: ToolResult | undefined;
        let firstFaultCpu1: ToolResult | undefined;
        if (input.systemResetBeforeHandoff?.cpu2BootContract
          && !["artifact-validation", "artifact-preflight"].includes(workflowStage)
          && !/lease|fenc|worker|session|cancel|abort|permission|policy/i.test(error.code)) {
          try {
            const halt = await this.manager.haltCores(input.sessionId, [input.cpu1CoreId, input.cpu2CoreId]);
            isolation = { ...halt, success: halt.results.every(result => result.success === true) };
            assertReadOwnership(halt.results.map(result => ({ ...result, expression: `core:${result.coreId}` })));
            const expressions = input.bootSyncExpressions ?? [];
            if (expressions.length > 0 && halt.results.some(result => result.coreId === input.cpu1CoreId && result.success)) {
              firstFaultCpu1 = { phase: "after-confirmed-cpu1-halt", results:
                await this.manager.evaluateMany(input.sessionId, input.cpu1CoreId, expressions) };
            }
          } catch (failure) {
            if (!isolation) isolation = { success: false, error: toStructuredError(failure) };
            else firstFaultCpu1 = { error: toStructuredError(failure) };
          }
        }
        throw new DebugMcpError(error.code, error.message, {
          ...error.details,
          ...(isolation ? { halt: isolation, twoPhaseIsolation: true } : {}),
          ...(firstFaultCpu1 ? { firstFaultCpu1 } : {}),
          workflowStage,
          effectiveStartup
        });
      }
      throw error;
    }
  }

  private async runIpcAcceptanceCore(input: z.infer<typeof runIpcAcceptanceSchema>, setStage: (stage: string) => void): Promise<ToolResult> {
    assertWorkflowStartupContract(input);
    const artifactPreflight = await assertIpcArtifactSet(input, artifactPath => this.manager.normalizeArtifactUri(artifactPath));
    setStage("artifact-preflight");
    setStage("resident-image-verification");
    const residentVerification = input.residentImageManifests?.length
      ? await this.verifyResidentImage(input.sessionId, input.residentImageManifests)
      : undefined;
    return this.runIpcAcceptanceInternal(input, artifactPreflight, setStage, residentVerification);
  }

  private async runIpcAcceptanceInternal(
    input: z.infer<typeof runIpcAcceptanceSchema>,
    artifactPreflight: ToolResult,
    setStage: (stage: string) => void,
    residentVerification?: ToolResult
  ): Promise<ToolResult> {
    const workflowStartedAt = performance.now();
    const bundleOutputDir = input.collectDebugBundle
      ? await this.resolveBundleOutputDir(input.outputDir, "ipc-acceptance")
      : undefined;
    const coreIds = [input.cpu1CoreId, input.cpu2CoreId];
    const performedSteps: string[] = [];
    const maps = this.normalizeMaps(mapsFromPaths(input));
    const runPlan = resolveRunPlan(input.runSequence, input.cpu1CoreId, input.cpu2CoreId);
    const systemResetRequested = input.systemResetBeforeHandoff !== undefined;
    const bootContract = input.systemResetBeforeHandoff?.cpu2BootContract;
    const allGuards = [...(input.preStartupSafetyGuard?.conditions ?? []),
      ...(input.systemResetBeforeHandoff?.postStartupConditions ?? [])];
    if (bootContract && allGuards.some(condition =>
      !bootObservationExpressionSchema.safeParse(condition.expression).success
      || (condition.coreId === input.cpu2CoreId && condition.expected !== 0 && condition.expected !== 1))) {
      throw new DebugMcpError("StartupContractInvalid", "Two-phase boot requires read-only guards and numeric CPU2 boolean predicates");
    }
    const cpu2BootGate = bootContract ? new Cpu2BootGate(bootContract,
      (coreId, expressions) => this.manager.evaluateManyWithTimeout(input.sessionId, coreId, expressions,
        bootContract.timeoutMs, { diagnostics: "errors-only" }),
      allGuards.filter(condition => condition.coreId === input.cpu2CoreId)) : undefined;
    if (systemResetRequested) {
      if (input.device !== "F28P65x" || input.cpu1CoreId !== 0 || input.cpu2CoreId !== 2
        || input.runSequence.runMode !== "cpu1_boots_cpu2" || input.postLoadResetType !== undefined
        || input.programPreparation !== "symbols-only" || input.loadPolicy !== "verify-mcp-registry"
        || !input.preStartupSafetyGuard
        || !input.cpu1OutSha256 || !input.cpu2OutSha256 || !input.cpu1MapSha256 || !input.cpu2MapSha256
        || !coreIds.every(coreId => input.preStartupSafetyGuard!.conditions.some(c => c.coreId === coreId))) {
        throw new DebugMcpError("StartupContractInvalid", "System Reset requires explicit F28P65x cores 0/2, cpu1_boots_cpu2, verified resident images with all four hashes, both-core guards, and no postLoadResetType");
      }
    }
    if (input.postLoadResetType && !runPlan.releaseCpu2BeforeCpu1) {
      throw new DebugMcpError("StartupContractInvalid", "postLoadResetType requires firmware-owned CPU2 boot");
    }
    if (runPlan.releaseCpu2BeforeCpu1 && (runPlan.coreOrder.length !== 1 || runPlan.coreOrder[0] !== input.cpu1CoreId)) {
      throw new DebugMcpError("Cpu2BootReleaseSequenceInvalid", "CPU2 release-before-CPU1 requires a CPU1-only run plan", {
        sessionId: input.sessionId,
        cpu1CoreId: input.cpu1CoreId,
        cpu2CoreId: input.cpu2CoreId,
        runPlan
      });
    }
    if (runPlan.releaseCpu2BeforeCpu1 && input.loadSequence.mode !== "cpu1-then-cpu2") {
      throw new DebugMcpError("Cpu2BootReleaseSequenceInvalid", "Firmware-owned CPU2 boot requires both images to be loaded before CPU2 is disconnected and CPU1 is started", {
        sessionId: input.sessionId,
        loadSequence: input.loadSequence,
        requiredLoadMode: "cpu1-then-cpu2",
        runPlan
      });
    }
    // Parse linker maps before touching the target. This produces the GS/flash
    // ownership plan up front and prevents a malformed map from leaving a
    // partially reset or partially loaded multicore session behind.
    const ramOwnership = await this.analyzeRamOwnership({ maps });
    // Resolve the F28P65x Flash programming contract from real linker-map
    // evidence before the first halt/reset/load reaches the target.
    const pairedFlash = resolvePairedFlashContract({
      startupPreset: input.startupPreset ?? null,
      loadMode: input.loadSequence.mode,
      ownerCoreId: input.cpu1CoreId,
      targetCoreId: input.cpu2CoreId,
      cpu2FlashBanks: ramOwnership.flashOwnershipActions
        .filter(action => action.targetCoreId === input.cpu2CoreId)
        .flatMap(action => action.flashBanks)
    });
    performedSteps.push("artifactPreflight", "analyzeRamOwnership");
    const applicationEntryPlan = runPlan.releaseCpu2BeforeCpu1
      ? createApplicationEntryPlan({
        coreId: input.cpu1CoreId,
        explicitAddress: input.cpu1EntryAddress,
        map: ramOwnership.maps.find(map => map.coreId === input.cpu1CoreId)
      })
      : undefined;
    if (applicationEntryPlan && !applicationEntryPlan.configured) {
      throw new DebugMcpError("ApplicationEntryNotConfigured", "Firmware-owned CPU2 boot requires a CPU1 application entry that can be verified from the linker map or an explicit cpu1EntryAddress", {
        sessionId: input.sessionId,
        cpu1CoreId: input.cpu1CoreId,
        cpu1MapPath: input.cpu1MapPath,
        applicationEntry: applicationEntryPlan,
        diagnosisCode: "APPLICATION_ENTRY_NOT_CONFIGURED"
      });
    }
    if (runPlan.releaseCpu2BeforeCpu1) {
      assertCpu1OnlyResetType(input.postLoadResetType ?? "restart", input.sessionId, input.cpu1CoreId);
    }
    if (input.preStartupSafetyGuard) {
      assertPreStartupSafetyGuardScope(input.preStartupSafetyGuard, coreIds);
    }

    let load: ToolResult | undefined;
    let flashProgramming: ToolResult | undefined;
    const safetyGuardChecks: ToolResult[] = [];
    if (input.programPreparation === "symbols-only") {
      // Resident Flash has no program-load side effect. Load both symbol
      // tables while the connect-only durable session is still at its safe
      // halted baseline, then evaluate durable safety expressions against the
      // now-available symbols before any reset or run authority is exercised.
      setStage("symbols-load");
      const symbolLoadResults: ToolResult[] = [];
      const cpu1Symbols = await this.manager.loadSymbols(input.sessionId, input.cpu1CoreId, input.cpu1OutPath, input.cpu1MapPath);
      symbolLoadResults.push({
        ...cpu1Symbols,
        success: true,
        loaded: false,
        skipped: false,
        targetMemoryWritten: false,
        targetFlashVerified: false
      });
      performedSteps.push("loadCpu1Symbols");
      const cpu2Symbols = await this.manager.loadSymbols(input.sessionId, input.cpu2CoreId, input.cpu2OutPath, input.cpu2MapPath);
      symbolLoadResults.push({
        ...cpu2Symbols,
        success: true,
        loaded: false,
        skipped: false,
        targetMemoryWritten: false,
        targetFlashVerified: false
      });
      performedSteps.push("loadCpu2Symbols");
      load = {
        sessionId: input.sessionId,
        mode: "symbols-only",
        results: symbolLoadResults,
        targetMemoryWritten: false,
        targetFlashVerified: false,
        note: SYMBOLS_ONLY_FLASH_NOTE
      };
      assertBatchSucceeded("loadSymbols", load);
      if (input.preStartupSafetyGuard) {
        setStage("pre-startup-safety-guard");
        safetyGuardChecks.push(await this.verifyPreStartupSafetyGuard(input.sessionId, {
          ...input.preStartupSafetyGuard,
          conditions: input.preStartupSafetyGuard.conditions.filter(condition =>
            !cpu2BootGate || condition.coreId === input.cpu1CoreId)
        }));
        performedSteps.push("verifyPreStartupSafetyGuard");
      }
    }

    setStage("initial-halt");
    const initialHalt = await this.manager.haltCores(input.sessionId, coreIds);
    performedSteps.push("haltCores");
    assertBatchSucceeded("haltCores", initialHalt);
    setStage("reset");
    const reset = runPlan.releaseCpu2BeforeCpu1
      ? skippedResetBatch(input.sessionId, coreIds, input.resetType as ResetType, systemResetRequested
        ? "Initial reset skipped; explicitly authorized System Reset occurs after identity checks and before CPU2 disconnect."
        : "Firmware-owned CPU2 boot starts with a post-load CPU1-only restart; CPU2 is not reset before handoff.")
      : await this.manager.resetCores(input.sessionId, coreIds, input.resetType as ResetType);
    performedSteps.push(runPlan.releaseCpu2BeforeCpu1 ? "skipResetBeforeFirmwareHandoff" : "resetCores");
    assertBatchSucceeded("resetCores", reset);
    const cpu1Program = {
      coreId: input.cpu1CoreId,
      programUri: input.cpu1OutPath,
      mapUri: input.cpu1MapPath,
      loadPolicy: input.loadPolicy,
      allowDestructiveFlashReload: input.allowDestructiveFlashReload
    };
    const cpu2Program = {
      coreId: input.cpu2CoreId,
      programUri: input.cpu2OutPath,
      mapUri: input.cpu2MapPath,
      loadPolicy: input.loadPolicy,
      allowDestructiveFlashReload: input.allowDestructiveFlashReload
    };
    if (input.programPreparation !== "symbols-only") {
      setStage("program-load");
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
      } else if (pairedFlash.required) {
        // Flash programming boundary. Both images are programmed while every
        // application core stays halted; the manager refuses to start any core
        // for as long as this boundary is open. Application startup is a
        // separate stage that only begins after the boundary closes.
        setStage("paired-flash");
        await this.manager.beginPairedFlashProgramming(input.sessionId, {
          ownerCoreId: input.cpu1CoreId,
          targetCoreId: input.cpu2CoreId,
          flashBanks: pairedFlash.flashBanks
        });
        performedSteps.push("beginPairedFlashProgramming");
        let cpu1Load: ToolResult | undefined;
        let ownerHalt: ToolResult | undefined;
        let cpu2Load: ToolResult | undefined;
        let loadError: unknown;
        try {
          cpu1Load = await this.manager.loadPrograms(input.sessionId, [cpu1Program]);
          assertBatchSucceeded("loadCpu1Program", cpu1Load);
          performedSteps.push("loadCpu1Program");
          setStage("paired-flash-owner-halt");
          ownerHalt = await this.manager.haltCore(input.sessionId, input.cpu1CoreId);
          performedSteps.push("confirmHaltedOwnerDuringPairedFlash");
          cpu2Load = await this.manager.loadPrograms(input.sessionId, [cpu2Program]);
          assertBatchSucceeded("loadCpu2Program", cpu2Load);
          performedSteps.push("loadCpu2Program");
        } catch (error) {
          loadError = error;
        } finally {
          await this.manager.endPairedFlashProgramming(input.sessionId, {
            success: loadError === undefined,
            ...(loadError === undefined ? {} : { reason: toStructuredError(loadError).message.slice(0, 256) })
          });
        }
        if (cpu1Load || cpu2Load) {
          load = {
            sessionId: input.sessionId,
            results: [...(cpu1Load?.results ?? []), ...(cpu2Load?.results ?? [])]
          };
        }
        if (loadError !== undefined) {
          throw loadError;
        }
        flashProgramming = {
          stage: "paired-flash",
          performed: true,
          mode: "cpu1-then-cpu2",
          preset: pairedFlash.preset,
          contractSource: pairedFlash.source,
          ownerCoreId: input.cpu1CoreId,
          targetCoreId: input.cpu2CoreId,
          flashBanks: pairedFlash.flashBanks,
          ownerStateAfterCpu1Load: ownerHalt,
          cpu1LoadedBeforeCpu2: true,
          applicationCoresStartedDuringFlash: false,
          boundary: "Both Flash images are programmed while every application core stays halted; application startup begins only after this boundary."
        };
        performedSteps.push("completePairedFlashProgramming");
      } else {
        load = await this.manager.loadPrograms(input.sessionId, [cpu1Program, cpu2Program]);
        performedSteps.push("loadPrograms");
      }
      if (!load) {
        throw new DebugMcpError("BatchOperationFailed", "Program preparation produced no load result", {
          sessionId: input.sessionId,
          loadSequence: input.loadSequence,
          pairedFlash: { required: pairedFlash.required, source: pairedFlash.source, flashBanks: pairedFlash.flashBanks }
        });
      }
      assertBatchSucceeded("loadPrograms", load);
    }
    if (!load) {
      throw new DebugMcpError("BatchOperationFailed", "IPC acceptance did not produce a program or symbol preparation result", {
        sessionId: input.sessionId,
        programPreparation: input.programPreparation
      });
    }
    if (!flashProgramming) {
      // Every IPC acceptance reports its Flash programming contract, even when
      // it never opened a Flash boundary.
      flashProgramming = {
        stage: "paired-flash",
        performed: false,
        mode: input.loadSequence.mode,
        preset: pairedFlash.preset,
        contractSource: pairedFlash.source,
        ownerCoreId: input.cpu1CoreId,
        targetCoreId: input.cpu2CoreId,
        flashBanks: pairedFlash.flashBanks,
        applicationCoresStartedDuringFlash: false,
        reason: input.programPreparation === "symbols-only"
          ? "symbols-only preparation does not program Flash"
          : "no CPU2 Flash image was found in the CPU2 linker map"
      };
    }
    let cpu2Release: ToolResult | undefined;
    let postLoadReset: ToolResult | undefined;
    let postLoadHalt: ToolResult;
    let systemResetFreshness: ToolResult | undefined;
    if (systemResetRequested) {
      setStage("pre-system-reset-identity");
      systemResetFreshness = await this.checkElfFreshness(input.sessionId, [
        { coreId: input.cpu1CoreId, outPath: input.cpu1OutPath },
        { coreId: input.cpu2CoreId, outPath: input.cpu2OutPath }
      ], artifactPreflight, load.results);
      if (!systemResetFreshness.allFresh
        || !systemResetFreshness.programs.every((program: ToolResult) =>
          program.programmedProgramFresh === true)) {
        throw new DebugMcpError("ArtifactPairInvalid", "System Reset requires an exact pair loaded in the current session", { elfFreshness: systemResetFreshness });
      }
      performedSteps.push("verifyPairBeforeSystemReset");
      if (cpu2BootGate) {
        setStage("cpu2-boot-epoch-baseline");
        await cpu2BootGate.captureBaseline();
        performedSteps.push("captureCpu2BootEpochBeforeReset");
      }
    }
    if (runPlan.releaseCpu2BeforeCpu1) {
      // Normally disconnect CPU2 immediately: firmware may already hold it in
      // reset. The explicit System Reset experiment instead requires a readable,
      // halted pair before reset. All operations after disconnect stay CPU1-only.
      setStage("cpu2-connect-initialization-disable");
      const preparation = await this.manager.prepareFirmwareHandoff(input.sessionId, input.cpu2CoreId);
      performedSteps.push("disableCpu2ConnectInitialization");
      if (systemResetRequested) {
        setStage("system-reset-preparation");
        const cpu1Preparation = await this.manager.prepareFirmwareHandoff(input.sessionId, input.cpu1CoreId);
        performedSteps.push("disableCpu1ResetInitialization");
        const before = await this.manager.getMulticoreSnapshot(input.sessionId, coreIds);
        if (!before.cores.every(core => core.connected && core.state === "Halted")) {
          throw new DebugMcpError("StartupContractInvalid", "System Reset requires both cores connected and halted", { before });
        }
        setStage("system-reset-before-cpu2-disconnect");
        const resetResult = await this.manager.resetCore(input.sessionId, input.cpu1CoreId, "system");
        postLoadReset = { ...resetResult, phase: "before-cpu2-disconnect", authorized: true,
          preparation: [cpu1Preparation, preparation], before,
          affectsPeripheralAndProtectionState: true, physicalColdStartVerified: false };
        if (!resetResult.connected || resetResult.state !== "Halted") {
          throw new DebugMcpError("StartupContractInvalid", "System Reset did not leave CPU1 connected and halted", { postLoadReset });
        }
        performedSteps.push("systemResetBeforeCpu2Disconnect");
      }
      setStage("cpu2-release");
      cpu2Release = {
        preparation,
        disconnected: await this.manager.disconnectTarget(input.sessionId, input.cpu2CoreId),
        mode: "disconnect-before-cpu1"
      };
      performedSteps.push("disconnectCpu2BeforeCpu1");
      setStage("post-load-halt");
      postLoadHalt = await this.manager.haltCore(input.sessionId, input.cpu1CoreId);
      performedSteps.push("haltCpu1AfterLoad");
    } else {
      setStage("post-load-halt");
      postLoadHalt = await this.manager.haltCores(input.sessionId, coreIds);
      performedSteps.push("haltCoresAfterLoad");
      assertBatchSucceeded("haltCoresAfterLoad", postLoadHalt);
    }
    setStage("pre-run-evidence");
    const snapshot = await this.manager.getMulticoreSnapshot(
      input.sessionId,
      runPlan.releaseCpu2BeforeCpu1 ? [input.cpu1CoreId] : coreIds
    );
    performedSteps.push("getMulticoreSnapshot");
    const elfFreshness = systemResetFreshness ?? await this.checkElfFreshness(input.sessionId, [
      { coreId: input.cpu1CoreId, outPath: input.cpu1OutPath },
      { coreId: input.cpu2CoreId, outPath: input.cpu2OutPath }
    ], artifactPreflight, input.programPreparation === "symbols-only" ? load.results : undefined);
    performedSteps.push("checkElfFreshness");
    if (runPlan.releaseCpu2BeforeCpu1 && !systemResetRequested) {
      // The CPU2 Flash plugin may leave CPU1 at a loader PC in shared RAM.
      // Never resume that PC. Only CPU1 is restarted; it owns CPU2 boot. This
      // is intentionally also done for symbols-only/resident-Flash runs so
      // the entry check proves the actual CPU1 startup path.
      let preparation: ToolResult | undefined;
      if (input.postLoadResetType === "cpu") {
        // TI CPU1 OnReset runs to a ROM breakpoint and may release CPU2 to
        // Wait Boot. Suppress those callbacks before the CPU1-only reset.
        setStage("cpu1-reset-initialization-disable");
        preparation = await this.manager.prepareFirmwareHandoff(input.sessionId, input.cpu1CoreId);
        performedSteps.push("disableCpu1ResetInitialization");
      }
      setStage("post-load-cpu1-reset");
      postLoadReset = {
        ...(await this.manager.resetCore(input.sessionId, input.cpu1CoreId,
          input.postLoadResetType ?? "restart")),
        ...(preparation ? { preparation } : {})
      };
      performedSteps.push("resetCpu1AfterLoad");
    }
    let applicationEntry: ApplicationEntryCheck | undefined;
    setStage("run-sequence");
    if (runPlan.releaseCpu2BeforeCpu1) {
      await this.manager.runCore(input.sessionId, input.cpu1CoreId);
      performedSteps.push("runCpu1");
      applicationEntry = await waitForApplicationEntry(this.manager, {
        sessionId: input.sessionId,
        plan: applicationEntryPlan!,
        timeoutMs: input.applicationEntryTimeoutMs,
        intervalMs: Math.min(input.intervalMs, input.applicationEntryTimeoutMs)
      });
      performedSteps.push("verifyCpu1ApplicationEntry");
      if (!applicationEntry.reached) {
        setStage("application-entry-diagnosis");
        const startupEvidence = await collectCpu1OnlyStartupEvidence(this.manager, {
          sessionId: input.sessionId,
          cpu1CoreId: input.cpu1CoreId,
          cpu2CoreId: input.cpu2CoreId,
          applicationEntry,
          postLoadReset,
          bootModeExpression: input.bootModeExpression,
          cpu1ResetStateExpression: input.cpu1ResetStateExpression,
          bootSyncExpressions: input.bootSyncExpressions,
          ipcReadyExpressions: input.ipcReadyExpressions
        });
        throw new DebugMcpError("ApplicationEntryNotReached", "CPU1 did not enter the declared application code before the bounded entry check expired; CPU2 was not reconnected and IPC readiness was skipped", {
          sessionId: input.sessionId,
          cpu1CoreId: input.cpu1CoreId,
          cpu2CoreId: input.cpu2CoreId,
          diagnosisCode: "APPLICATION_ENTRY_NOT_REACHED",
          applicationEntry,
          startupEvidence,
          ipcReadySkipped: true,
          performedSteps
        });
      }
      if (!cpu2BootGate) await sleep(input.runSequence.settleMs);
    } else {
      for (const coreId of runPlan.coreOrder) {
        await this.manager.runCore(input.sessionId, coreId);
        performedSteps.push(coreId === input.cpu1CoreId ? "runCpu1" : "runCpu2");
        await sleep(input.runSequence.settleMs);
      }
    }
    if (cpu2BootGate) {
      setStage("cpu2-boot-contract");
      try {
        await cpu2BootGate.waitAndArm(
          () => this.verifyPreStartupSafetyGuard(input.sessionId, {
            conditions: input.preStartupSafetyGuard!.conditions.filter(condition => condition.coreId === input.cpu1CoreId),
            haltCoreIds: coreIds
          }, "cpu2-disarmed-cpu1-invariants"),
          async () => {
            cpu2Release = { ...cpu2Release,
              reconnected: await this.manager.connectTarget(input.sessionId, input.cpu2CoreId),
              reason: "fresh-epoch-app-init-and-logic-commit", fixedSettleUsed: false };
            performedSteps.push("reconnectCpu2AfterLogicCommit");
          });
        performedSteps.push("verifyCpu2BootContract", "armCpu2SafetyGuard");
      } catch (error) {
        const cause = toStructuredError(error);
        throw new DebugMcpError(cause.code as DebugErrorCode, cause.message, { ...cause.details,
          cpu2BootGate: cpu2BootGate.evidence, postLoadReset, applicationEntry, cpu2Release,
          artifactPreflight, elfFreshness, performedSteps, ipcReadySkipped: true });
      }
    } else if (runPlan.releaseCpu2BeforeCpu1) {
      setStage("cpu2-reconnect");
      cpu2Release = {
        ...cpu2Release,
        reconnected: await this.manager.connectTarget(input.sessionId, input.cpu2CoreId),
        settleMs: input.runSequence.settleMs
      };
      performedSteps.push("reconnectCpu2AfterCpu1");
    }
    if (input.systemResetBeforeHandoff) {
      setStage("post-system-reset-safety-guard");
      try {
        safetyGuardChecks.push(await this.verifyPreStartupSafetyGuard(input.sessionId, {
          conditions: allGuards.filter(condition => !cpu2BootGate || condition.coreId === input.cpu1CoreId),
          haltCoreIds: coreIds
        }, "post-system-reset-startup"));
        performedSteps.push("verifyPostSystemResetSafetyGuard");
      } catch (error) {
        const cause = toStructuredError(error);
        throw new DebugMcpError("SafetyGuardViolation", cause.message, { ...cause.details,
          postLoadReset, applicationEntry, cpu2Release, performedSteps: [...performedSteps],
          safetyGuardChecks: [...safetyGuardChecks], ipcReadySkipped: true });
      }
    }
    setStage("ipc-readiness-wait");
    const runtimeSafetyCheck = cpu2BootGate ? async () => {
      await this.verifyPreStartupSafetyGuard(input.sessionId, {
        conditions: allGuards.filter(condition => condition.coreId === input.cpu1CoreId), haltCoreIds: coreIds
      }, "cpu2-armed-cpu1-invariants");
      await cpu2BootGate.verifyRuntime();
    } : undefined;
    const conditions = input.ipcReadyExpressions ?? defaultIpcReadyConditions(input.cpu1CoreId, input.cpu2CoreId);
    const ipcReady = await this.waitForExpressionSet(input.sessionId, conditions, input.timeoutMs,
      input.intervalMs, input.pollingStrategy, input.pollingSchedule,
      input.bootSyncExpressions?.length ? { coreId: input.cpu1CoreId, expressions: input.bootSyncExpressions } : undefined,
      runtimeSafetyCheck);
    performedSteps.push("waitForIpcReady");
    // Freeze the first read set before any follow-up target access. Diagnostic
    // errors must still stop the workflow, but must not erase startup evidence.
    const firstFailureEvidence: ToolResult = {
      sessionId: input.sessionId, cpu1CoreId: input.cpu1CoreId, cpu2CoreId: input.cpu2CoreId,
      capturedAt: new Date().toISOString(), success: false, diagnosticCompleteness: "incomplete",
      firstFailureStage: ipcReady.timedOut ? "ipc-readiness-wait" : "post-readiness-diagnostics",
      firstFailureCode: ipcReady.timedOut ? "IPC_READY_TIMEOUT" : "POST_READINESS_DIAGNOSTIC_FAILED",
      ipcReady, ...(applicationEntry ? { applicationEntry } : {}),
      ...(flashProgramming ? { flashProgramming } : {}),
      artifactPreflight, elfFreshness, ramOwnership, runPlan, snapshot,
      snapshotPhase: "post-load-before-startup", initialHalt, reset, load, postLoadHalt,
      ...(postLoadReset ? { postLoadReset } : {}), loadSequence: input.loadSequence,
      safetyGuardChecks: [...safetyGuardChecks],
      ...(cpu2BootGate ? { cpu2BootGate: cpu2BootGate.evidence } : {}),
      ...(cpu2Release ? { cpu2Release } : {}),
      performedSteps: [...performedSteps]
    };
    const timeoutRecovery: ToolResult | undefined = ipcReady.timedOut ? { pc: [] } : undefined;
    if (timeoutRecovery) firstFailureEvidence.timeoutRecovery = timeoutRecovery;
    try {
      if (timeoutRecovery) {
        setStage("ipc-timeout-diagnostics");
        await this.haltAndResolvePc(input.sessionId, coreIds, timeoutRecovery);
        performedSteps.push("haltAndResolvePcOnTimeout");
      }
      if (ipcReady.diagnosticReads?.complete === false) {
        if (!timeoutRecovery) {
          firstFailureEvidence.diagnosticHalt = await this.manager.haltCores(input.sessionId, coreIds);
        }
        throw new DebugMcpError("ExpressionCaptureFailed", "Requested CPU1 boot observations could not all be read", {
          diagnosticReads: ipcReady.diagnosticReads
        });
      }
      setStage("runtime-ram-ownership");
      const runtimeRamOwnership = await this.runtimeRamOwnershipStatus(
        input.sessionId,
        input.verifyRuntimeRamOwnership,
        ramOwnership.ownershipActions
      );
      firstFailureEvidence.runtimeRamOwnership = runtimeRamOwnership;
      performedSteps.push("verifyRuntimeRamOwnership");
      setStage("diagnosis");
      const diagnosis = await this.buildBootHandoffDiagnosis({
        sessionId: input.sessionId,
        device: input.device,
        cpu1CoreId: input.cpu1CoreId,
        cpu2CoreId: input.cpu2CoreId,
        ramOwnership,
        elfFreshness,
        runtimeRamOwnership,
        ipcReady,
        applicationEntry,
        extraExpressions: conditions,
        ipcAcceptance: true,
        cpu1Expressions: conditions.filter(condition => condition.coreId === input.cpu1CoreId).map(condition => condition.expression),
        cpu2Expressions: conditions.filter(condition => condition.coreId === input.cpu2CoreId).map(condition => condition.expression),
        cpu2FaultEvidence: input.cpu2FaultEvidence
      });
      const optimization = classifyIpcAcceptance({ ipcReady, elfFreshness, runtimeRamOwnership, runPlan, applicationEntry });
      performedSteps.push("diagnoseBootHandoff");
      if (runtimeSafetyCheck && !ipcReady.timedOut) await runtimeSafetyCheck();
      const result: ToolResult = {
        workflow: "c2000_runIpcAcceptance",
        orchestration: "server-internal",
        mcpToolCalls: [],
        approvalClass: "workflow-confirmation",
        effectsApplied: [
          "target-halt",
          ...(!isSkippedResetBatch(reset) || postLoadReset ? ["target-reset"] : []),
          ...(input.programPreparation === "symbols-only" ? ["symbol-load"] : ["program-load", "ram-ownership-change"]),
          "target-run", "target-read",
          ...(cpu2Release ? ["debugger-gel-unload", "target-disconnect", "target-connect"] : [])
        ],
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
        programPreparation: input.programPreparation,
        ...(residentVerification ? { residentVerification } : {}),
        ...(input.programPreparation === "symbols-only" ? {
          targetFlashVerified: false,
          programPreparationEvidence: {
            mode: "symbols-only",
            symbolsLoaded: true,
            targetMemoryWritten: false,
            targetFlashVerified: false,
            note: SYMBOLS_ONLY_FLASH_NOTE
          }
        } : {}),
        postLoadHalt,
        ...(postLoadReset ? { postLoadReset } : {}),
        ...(applicationEntry ? { applicationEntry } : {}),
        ...(flashProgramming ? { flashProgramming } : {}),
        snapshot,
        artifactPreflight,
        ramOwnership,
        elfFreshness,
        runtimeRamOwnership,
        runPlan,
        ...(cpu2Release ? { cpu2Release } : {}),
        loadSequence: input.loadSequence,
        startupContract: describeWorkflowStartupContract({
          loadMode: input.loadSequence.mode,
          runMode: input.runSequence.runMode,
          runCpu1First: input.runSequence.runCpu1First,
          runCpu2: input.runSequence.runCpu2,
          releaseCpu2BeforeCpu1: input.runSequence.releaseCpu2BeforeCpu1
        }),
        ipcReady,
        optimization,
        ...(cpu2BootGate ? { cpu2BootGate: cpu2BootGate.evidence } : {}),
        ...(safetyGuardChecks.length > 0 ? { safetyGuardChecks } : {}),
        ...(timeoutRecovery ? { timeoutRecovery } : {}),
        diagnosis,
        performance: {
          totalMs: performance.now() - workflowStartedAt,
          ipcPollMs: ipcReady.pollDurationMs,
          ipcPollIterations: ipcReady.pollIterations,
          expressionBatchCount: ipcReady.expressionBatchCalls,
          expressionCount: ipcReady.expressionCount,
          diagnosisExpressionReadsReused: diagnosis.performance?.expressionReadsReused === true
        }
      };
      if (input.collectDebugBundle) {
        result.debugBundle = await this.writeDebugBundle(bundleOutputDir!, result);
      }
      return result;
    } catch (error) {
      const cause = toStructuredError(error);
      const details = { ...cause.details, firstFailureEvidence, diagnosticError: cause };
      // Preserve fencing/safety error codes and perform no further target reads.
      throw new DebugMcpError(error instanceof DebugMcpError ? error.code : "PostLaunchCheckFailed",
        cause.message, details);
    }
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
      extraExpressions: input.expressions,
      cpu2FaultEvidence: input.cpu2FaultEvidence,
      expectedPostLoadHalt: input.expectedPostLoadHalt
    });
  }

  async runReloadAndDiagnose(input: z.infer<typeof runReloadAndDiagnoseSchema>): Promise<ToolResult> {
    const coreIds = [input.cpu1CoreId, input.cpu2CoreId];
    const performedSteps: string[] = [];
    let workflowStage = "input-validation";
    let targetAccessAttempted = false;
    const effectiveStartup = {
      resetType: input.resetType,
      runCpu1: input.runCpu1,
      runCpu2: input.runCpu2,
      postLoadBoot: input.postLoadBoot ?? null,
      cpu1EntryAddress: input.cpu1EntryAddress ?? null,
      applicationEntryTimeoutMs: input.applicationEntryTimeoutMs,
      timeoutMs: input.timeoutMs,
      intervalMs: input.intervalMs
    };
    try {
      workflowStage = "artifact-validation";
      const artifactPreflight = await assertReloadArtifactSet(input, artifactPath => this.manager.normalizeArtifactUri(artifactPath));
      const bundleOutputDir = input.collectDebugBundle
        ? await this.resolveBundleOutputDir(input.outputDir, "reload-diagnose")
        : undefined;
      performedSteps.push("artifactPreflight");
      workflowStage = "startup-contract-validation";
      if (input.postLoadBoot?.releaseCpu2BeforeCpu1 && (!input.postLoadBoot.runCpu1 || input.postLoadBoot.runCpu2)) {
        throw new DebugMcpError("Cpu2BootReleaseSequenceInvalid", "CPU2 release-before-CPU1 requires runCpu1=true and runCpu2=false", {
          sessionId: input.sessionId,
          runCpu1: input.postLoadBoot.runCpu1,
          runCpu2: input.postLoadBoot.runCpu2
        });
      }
      const firmwareOwned = input.postLoadBoot?.releaseCpu2BeforeCpu1 === true;
      workflowStage = "initial-halt";
      const maps = this.normalizeMaps(mapsFromPaths(input));
      const ramOwnership = maps.length > 0 ? await this.analyzeRamOwnership({ maps }) : undefined;
      if (ramOwnership) performedSteps.push("analyzeRamOwnership");
      const applicationEntryPlan = firmwareOwned
        ? createApplicationEntryPlan({
          coreId: input.cpu1CoreId,
          explicitAddress: input.cpu1EntryAddress,
          map: ramOwnership?.maps.find(map => map.coreId === input.cpu1CoreId)
        })
        : undefined;
      if (applicationEntryPlan && !applicationEntryPlan.configured) {
        throw new DebugMcpError("ApplicationEntryNotConfigured", "Firmware-owned CPU2 boot requires a CPU1 application entry that can be verified from the linker map or an explicit cpu1EntryAddress", {
          sessionId: input.sessionId,
          cpu1CoreId: input.cpu1CoreId,
          cpu1MapPath: input.cpu1MapPath,
          applicationEntry: applicationEntryPlan,
          diagnosisCode: "APPLICATION_ENTRY_NOT_CONFIGURED"
        });
      }
      if (firmwareOwned) {
        assertCpu1OnlyResetType(input.postLoadBoot!.resetType as ResetType, input.sessionId, input.cpu1CoreId);
      }
      targetAccessAttempted = true;
      const halt = await this.manager.haltCores(input.sessionId, coreIds);
      performedSteps.push("haltCores");
      assertBatchSucceeded("haltCores", halt);

      workflowStage = "reset";
      const reset = firmwareOwned
        ? skippedResetBatch(input.sessionId, coreIds, input.resetType as ResetType, "Firmware-owned CPU2 boot starts with a post-load CPU1-only restart; CPU2 is not reset before handoff.")
        : await this.manager.resetCores(input.sessionId, coreIds, input.resetType as ResetType);
      performedSteps.push(firmwareOwned ? "skipResetBeforeFirmwareHandoff" : "resetCores");
      assertBatchSucceeded("resetCores", reset);

      workflowStage = "program-load";
      const load = await this.manager.loadPrograms(input.sessionId, [
        {
          coreId: input.cpu1CoreId,
          programUri: input.cpu1OutPath,
          mapUri: input.cpu1MapPath,
          loadPolicy: input.loadPolicy,
          allowDestructiveFlashReload: input.allowDestructiveFlashReload
        },
        {
          coreId: input.cpu2CoreId,
          programUri: input.cpu2OutPath,
          mapUri: input.cpu2MapPath,
          ramOwnershipPolicy: input.ramOwnershipPolicy,
          fallbackGsRegions: input.fallbackGsRegions,
          loadPolicy: input.loadPolicy,
          allowDestructiveFlashReload: input.allowDestructiveFlashReload
        }
      ]);
      performedSteps.push("loadPrograms");
      assertBatchSucceeded("loadPrograms", load);

      let postLoadHalt: ToolResult;
      let postLoadReset: ToolResult | undefined;
      let postLoadResetHalt: ToolResult | undefined;
      let cpu2Release: ToolResult | undefined;
      let applicationEntry: ApplicationEntryCheck | undefined;
      const postLoadBoot = input.postLoadBoot;
      if (postLoadBoot?.releaseCpu2BeforeCpu1) {
        // Disconnect CPU2 immediately after both images are loaded.  CPU2 may
        // be in a firmware-owned reset/wait-boot state, so no post-load halt
        // or snapshot is allowed to touch it before CPU1 starts.
        workflowStage = "cpu2-connect-initialization-disable";
        const preparation = await this.manager.prepareFirmwareHandoff(input.sessionId, input.cpu2CoreId);
        performedSteps.push("disableCpu2ConnectInitialization");
        workflowStage = "cpu2-release";
        cpu2Release = {
          preparation,
          disconnected: await this.manager.disconnectTarget(input.sessionId, input.cpu2CoreId),
          mode: "disconnect-before-cpu1"
        };
        performedSteps.push("disconnectCpu2BeforeCpu1");
        workflowStage = "post-load-halt";
        postLoadHalt = await this.manager.haltCore(input.sessionId, input.cpu1CoreId);
        performedSteps.push("haltCpu1AfterLoad");
      } else {
        workflowStage = "post-load-halt";
        postLoadHalt = await this.manager.haltCores(input.sessionId, coreIds);
        performedSteps.push("haltCoresAfterLoad");
        assertBatchSucceeded("haltCoresAfterLoad", postLoadHalt);
      }
      if (postLoadBoot && !postLoadBoot.releaseCpu2BeforeCpu1) {
        workflowStage = "post-load-reset";
        postLoadReset = await this.manager.resetCores(input.sessionId, coreIds, postLoadBoot.resetType as ResetType);
        performedSteps.push("resetCoresAfterLoad");
        assertBatchSucceeded("resetCoresAfterLoad", postLoadReset);
        postLoadResetHalt = await this.manager.haltCores(input.sessionId, coreIds);
        performedSteps.push("haltCoresAfterPostLoadReset");
        assertBatchSucceeded("haltCoresAfterPostLoadReset", postLoadResetHalt);
      }

      workflowStage = "pre-run-evidence";
      const snapshot = await this.manager.getMulticoreSnapshot(
        input.sessionId,
        firmwareOwned ? [input.cpu1CoreId] : coreIds
      );
      performedSteps.push("getMulticoreSnapshot");
      const elfFreshness = await this.checkElfFreshness(input.sessionId, [
        { coreId: input.cpu1CoreId, outPath: input.cpu1OutPath },
        { coreId: input.cpu2CoreId, outPath: input.cpu2OutPath }
      ], artifactPreflight);
      const runCpu1 = postLoadBoot?.runCpu1 ?? input.runCpu1;
      const runCpu2 = postLoadBoot?.runCpu2 ?? input.runCpu2;
      if (postLoadBoot?.releaseCpu2BeforeCpu1) {
        // Firmware owns CPU2 boot. A system reset may hold CPU2 in reset, so do
        // not reset/halt/read that core again until CPU1 has released it.
        let preparation: ToolResult | undefined;
        if (postLoadBoot.resetType === "cpu") {
          workflowStage = "cpu1-reset-initialization-disable";
          preparation = await this.manager.prepareFirmwareHandoff(input.sessionId, input.cpu1CoreId);
          performedSteps.push("disableCpu1ResetInitialization");
        }
        workflowStage = "post-load-cpu1-reset";
        postLoadReset = {
          ...(await this.manager.resetCores(
            input.sessionId, [input.cpu1CoreId], postLoadBoot.resetType as ResetType
          )),
          ...(preparation ? { preparation } : {})
        };
        performedSteps.push("resetCpu1AfterLoad");
        assertBatchSucceeded("resetCpu1AfterLoad", postLoadReset);
      }
      if (runCpu1) {
        workflowStage = "run-sequence";
        await this.manager.runCore(input.sessionId, input.cpu1CoreId);
        performedSteps.push("runCpu1");
        if (postLoadBoot?.releaseCpu2BeforeCpu1) {
          workflowStage = "cpu1-application-entry";
          applicationEntry = await waitForApplicationEntry(this.manager, {
            sessionId: input.sessionId,
            plan: applicationEntryPlan!,
            timeoutMs: input.applicationEntryTimeoutMs,
            intervalMs: Math.min(input.intervalMs, input.applicationEntryTimeoutMs)
          });
          performedSteps.push("verifyCpu1ApplicationEntry");
          if (!applicationEntry.reached) {
            workflowStage = "application-entry-diagnosis";
            const startupEvidence = await collectCpu1OnlyStartupEvidence(this.manager, {
              sessionId: input.sessionId,
              cpu1CoreId: input.cpu1CoreId,
              cpu2CoreId: input.cpu2CoreId,
              applicationEntry,
              postLoadReset,
              bootModeExpression: input.bootModeExpression,
              cpu1ResetStateExpression: input.cpu1ResetStateExpression,
              bootSyncExpressions: input.bootSyncExpressions,
              ipcReadyExpressions: input.waitExpressions
            });
            throw new DebugMcpError("ApplicationEntryNotReached", "CPU1 did not enter the declared application code before the bounded entry check expired; CPU2 was not reconnected", {
              sessionId: input.sessionId,
              cpu1CoreId: input.cpu1CoreId,
              cpu2CoreId: input.cpu2CoreId,
              diagnosisCode: "APPLICATION_ENTRY_NOT_REACHED",
              applicationEntry,
              startupEvidence,
              ipcReadySkipped: true,
              performedSteps
            });
          }
        }
      }
      if (postLoadBoot && runCpu1 && (runCpu2 || postLoadBoot.releaseCpu2BeforeCpu1) && postLoadBoot.cpu1SettleMs > 0) {
        await sleep(postLoadBoot.cpu1SettleMs);
        performedSteps.push("cpu1PostLoadBootSettle");
      }
      if (postLoadBoot?.releaseCpu2BeforeCpu1) {
        workflowStage = "cpu2-reconnect";
        cpu2Release = {
          ...cpu2Release,
          reconnected: await this.manager.connectTarget(input.sessionId, input.cpu2CoreId),
          settleMs: postLoadBoot.cpu1SettleMs
        };
        performedSteps.push("reconnectCpu2AfterCpu1");
      }
      if (runCpu2) {
        workflowStage = "run-sequence";
        await this.manager.runCore(input.sessionId, input.cpu2CoreId);
        performedSteps.push("runCpu2");
      }
      workflowStage = "ipc-readiness-wait";
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
      workflowStage = "diagnosis";
      const diagnosis = await this.buildBootHandoffDiagnosis({
        sessionId: input.sessionId,
        device: input.device,
        cpu1CoreId: input.cpu1CoreId,
        cpu2CoreId: input.cpu2CoreId,
        ramOwnership,
        elfFreshness,
        runtimeRamOwnership,
        ipcReady: wait,
        applicationEntry,
        cpu2FaultEvidence: input.cpu2FaultEvidence
      });
      performedSteps.push("diagnoseBootHandoff");
      const result: ToolResult = {
        workflow: "c2000_runReloadAndDiagnose",
        orchestration: "server-internal",
        mcpToolCalls: [],
        approvalClass: "workflow-confirmation",
        effectsApplied: [
          "target-halt",
          ...(!isSkippedResetBatch(reset) ? ["target-reset"] : []),
          "program-load", "ram-ownership-change", "target-run", "target-read",
          ...(cpu2Release ? ["debugger-gel-unload", "target-disconnect", "target-connect"] : [])
        ],
        sessionId: input.sessionId,
        device: input.device,
        cpu1CoreId: input.cpu1CoreId,
        cpu2CoreId: input.cpu2CoreId,
        success: load.results.every((item: ToolResult) => item.success === true)
          && (!wait || wait.matched === true)
          && runtimeRamOwnershipAccepted(runtimeRamOwnership),
        workflowStage: "completed",
        targetAccessAttempted,
        effectiveStartup,
        performedSteps,
        halt,
        reset,
        load,
        postLoadHalt,
        ...(cpu2Release ? { cpu2Release } : {}),
        ...(postLoadReset ? {
          postLoadBoot: {
            controlled: true,
            resetType: postLoadBoot?.resetType,
            runCpu1,
            runCpu2,
            cpu1SettleMs: postLoadBoot?.cpu1SettleMs,
            ...(postLoadBoot?.releaseCpu2BeforeCpu1 === true ? { releaseCpu2BeforeCpu1: true } : {}),
            pcWritten: false
          },
          postLoadReset,
          postLoadResetHalt,
          ...(cpu2Release ? { cpu2Release } : {})
        } : {}),
        snapshot,
        artifactPreflight,
        ...(ramOwnership ? { ramOwnership } : {}),
        elfFreshness,
        runtimeRamOwnership,
        ...(wait ? { wait } : {}),
        ...(applicationEntry ? { applicationEntry } : {}),
        diagnosis
      };
      if (input.collectDebugBundle) {
        workflowStage = "bundle-write";
        result.debugBundle = await this.writeDebugBundle(bundleOutputDir!, result);
      }
      return result;
    } catch (error) {
      const structured = toStructuredError(error);
      const details = {
        ...(structured.details ?? {}),
        workflow: "c2000_runReloadAndDiagnose",
        sessionId: input.sessionId,
        workflowStage,
        performedSteps: [...performedSteps],
        effectiveStartup,
        targetAccessAttempted
      };
      if (error instanceof DebugMcpError) {
        throw new DebugMcpError(error.code, error.message, details);
      }
      throw new DebugMcpError("PostLaunchCheckFailed", "Reload and diagnosis workflow failed", { ...details, cause: structured });
    }
  }

  async runFullDebugBundle(input: z.infer<typeof runFullDebugBundleSchema>): Promise<ToolResult> {
    const bundleOutputDir = await this.resolveBundleOutputDir(input.outputDir, "full-debug-bundle");
    const coreIds = input.coreIds ?? [input.cpu1CoreId, input.cpu2CoreId];
    const maps = this.normalizeMaps(input.maps ?? mapsFromPaths(input));
    const snapshot = await this.manager.getMulticoreSnapshot(input.sessionId, coreIds);
    const loadedPrograms = await Promise.all(coreIds.map(async coreId => ({
      coreId,
      loadedProgramInfo: await this.manager.getLoadedProgramInfo(input.sessionId, coreId)
    })));
    const expressions = await this.evaluateReadSets(input.sessionId, input.expressions ?? defaultExpressionReadSets(input.cpu1CoreId, input.cpu2CoreId));
    const pc = await Promise.all(coreIds.map(async coreId => ({ coreId, ...(await this.manager.resolvePc(input.sessionId, coreId)) })));
    const cpu2FaultEvidence = await this.manager.collectCpu2FaultEvidence({
      sessionId: input.sessionId,
      cpu1CoreId: input.cpu1CoreId,
      cpu2CoreId: input.cpu2CoreId,
      cpu2Pc: pc.find(item => item.coreId === input.cpu2CoreId),
      cpu2FaultEvidence: input.cpu2FaultEvidence
    });
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
      cpu2FaultEvidence,
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
    result.bundle = await this.writeDebugBundle(bundleOutputDir, result);
    return result;
  }

  private async resolveBundleOutputDir(outputDir: string | undefined, label: string): Promise<string> {
    if (outputDir) {
      return this.filesystem ? assertAllowedWritePath(outputDir, this.filesystem) : outputDir;
    }
    return defaultBundleDir(label, this.filesystem);
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
    applicationEntry?: ApplicationEntryCheck;
    extraExpressions?: ExpressionCondition[];
    ipcAcceptance?: boolean;
    evidence?: DebugEvidence;
    cpu1Expressions?: string[];
    cpu2Expressions?: string[];
    cpu2FaultEvidence?: Cpu2FaultEvidenceOptions;
    expectedPostLoadHalt?: boolean;
    precomputedExpressionResults?: Array<{ coreId: CoreId; results: EvaluateResult[] }>;
  }): Promise<ToolResult> {
    const cpu1Expressions = options.extraExpressions
      ?.filter(condition => condition.coreId === options.cpu1CoreId)
      .map(condition => condition.expression);
    const cpu2Expressions = options.extraExpressions
      ?.filter(condition => condition.coreId === options.cpu2CoreId)
      .map(condition => condition.expression);
    const precomputedExpressionResults = options.precomputedExpressionResults
      ?? buildPrecomputedExpressionResults(options.extraExpressions, options.ipcReady);
    let boot = options.evidence ? bootEvidence(options.evidence, options.cpu1CoreId, options.cpu2CoreId) : await this.manager.diagnoseCpu2Boot({
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
      }),
      ...(options.cpu2FaultEvidence ? { cpu2FaultEvidence: options.cpu2FaultEvidence } : {}),
      collectCpu2FaultEvidence: false,
      ...(precomputedExpressionResults ? { precomputedExpressionResults } : {})
    });
    const extraExpressions = options.extraExpressions
      ? precomputedExpressionResults
        ? options.extraExpressions.map(condition => conditionResult(
          condition,
          precomputedExpressionResults
            .find(group => group.coreId === condition.coreId)
            ?.results.find(result => result.expression === condition.expression)
        ))
        : await this.evaluateConditions(options.sessionId, options.extraExpressions)
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
    // Keep the normal, successful IPC path timing-light.  A bounded fault
    // snapshot is collected automatically after a failed handoff, or when a
    // caller explicitly supplies the evidence configuration.  A CPU2 entry
    // failure intentionally keeps the existing CPU2-access suppression.
    const shouldCollectCpu2FaultEvidence = !options.evidence
      && options.applicationEntry?.reached !== false
      && (options.cpu2FaultEvidence !== undefined || !verdict.ready);
    if (shouldCollectCpu2FaultEvidence && !boot.cpu2?.faultEvidence) {
      try {
        const faultEvidence = await this.manager.collectCpu2FaultEvidence({
          sessionId: options.sessionId,
          cpu1CoreId: options.cpu1CoreId,
          cpu2CoreId: options.cpu2CoreId,
          cpu2Pc: boot.cpu2?.pc,
          cpu2FaultEvidence: options.cpu2FaultEvidence
        });
        boot = {
          ...boot,
          cpu2: { ...boot.cpu2, faultEvidence }
        };
      } catch (error) {
        boot = { ...boot, faultEvidenceError: toStructuredError(error) };
      }
    }
    const applicationEntryNotReached = options.applicationEntry?.reached === false;
    const ipcTimedOut = options.ipcReady?.timedOut === true;
    const diagnosisCode = applicationEntryNotReached
      ? "APPLICATION_ENTRY_NOT_REACHED"
      : ipcTimedOut
      ? "IPC_READY_TIMEOUT"
      : verdict.ready
        ? (options.ipcAcceptance ? "IPC_ACCEPTANCE_READY" : "BOOT_HANDOFF_READY")
        : (options.ipcAcceptance ? "IPC_ACCEPTANCE_NOT_READY" : "BOOT_HANDOFF_NOT_READY");
    const severity = diagnosisCode === "APPLICATION_ENTRY_NOT_REACHED" || diagnosisCode === "IPC_READY_TIMEOUT"
      ? "error"
      : diagnosisCode === "BOOT_HANDOFF_NOT_READY" || diagnosisCode === "IPC_ACCEPTANCE_NOT_READY"
        ? "warning"
        : "info";
    const postLoadHaltSemantics = options.expectedPostLoadHalt
      ? {
        phase: "post-load-halt",
        expected: true,
        diagnosisCode,
        bootHandoffNotReadyIsExpected: diagnosisCode === "BOOT_HANDOFF_NOT_READY",
        normalAcceptanceRunExecuted: false,
        note: "The launch-only contract intentionally leaves both cores halted; BOOT_HANDOFF_NOT_READY is a bounded post-load diagnostic outcome, not an OpenLoop function failure."
      }
      : undefined;
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
      ...(postLoadHaltSemantics ? { postLoadHaltSemantics } : {}),
      recommendedActions: recommendedActions(diagnosisCode, verdict, options.ramOwnership),
      evidence: {
        explicitCores: { cpu1CoreId: options.cpu1CoreId, cpu2CoreId: options.cpu2CoreId },
        noCcsUiFocusRequired: true,
        managerRoute: "sessionId -> coreId -> DebugSession",
        verdict
      },
      ...boot,
      ...(options.applicationEntry ? { applicationEntry: options.applicationEntry } : {}),
      verdict,
      ...(options.ramOwnership ? { ramOwnership: options.ramOwnership } : {}),
      ...(options.elfFreshness ? { elfFreshness: options.elfFreshness } : {}),
      ...(options.runtimeRamOwnership ? { runtimeRamOwnership: options.runtimeRamOwnership } : {}),
      performance: {
        expressionReadsReused: Boolean(precomputedExpressionResults)
      },
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

  private async verifyPreStartupSafetyGuard(
    sessionId: string,
    guard: { conditions: ExpressionCondition[]; haltCoreIds: number[] },
    phase = "symbols-loaded-before-startup"
  ): Promise<ToolResult> {
    let evidence: ToolResult;
    try {
      const conditions = await this.evaluateConditions(sessionId, guard.conditions);
      evidence = {
        phase,
        checkedAt: new Date().toISOString(),
        matched: conditions.every(condition => condition.matched === true),
        conditions
      };
      if (evidence.matched === true) return evidence;
    } catch (error) {
      evidence = {
        phase,
        checkedAt: new Date().toISOString(),
        matched: false,
        evaluationError: toStructuredError(error)
      };
    }

    let halt: ToolResult;
    try {
      halt = await this.manager.haltCores(sessionId, guard.haltCoreIds as CoreId[]);
      assertBatchSucceeded("preStartupSafetyGuardHalt", halt);
    } catch (error) {
      halt = { success: false, error: toStructuredError(error) };
    }
    throw new DebugMcpError(
      "SafetyGuardViolation",
      "A safety guard did not match or could not be evaluated; a halt was issued",
      { sessionId, evidence, haltCoreIds: guard.haltCoreIds, halt }
    );
  }

  private async waitForExpressionSet(
    sessionId: string,
    conditions: ExpressionCondition[],
    timeoutMs: number,
    intervalMs: number,
    strategy: "fixed" | "adaptive" = "adaptive",
    schedule?: Array<{ untilMs?: number; intervalMs: number }>,
    observations?: { coreId: CoreId; expressions: string[] },
    runtimeSafetyCheck?: () => Promise<void>
  ) {
    const startedAt = performance.now();
    const deadline = startedAt + timeoutMs;
    let lastConditions: ToolResult[] = [];
    let firstFailure: ToolResult | undefined;
    let pollIterations = 0;
    let expressionBatchCalls = 0;
    let expressionCount = 0;
    const grouped = groupConditionsByCore(conditions);
    let diagnosticReads: { capturedAt: string; coreId: CoreId; complete: boolean; results: EvaluateResult[] } | undefined;
    if (observations) {
      let group = grouped.find(item => item.coreId === observations.coreId);
      if (!group) {
        group = { coreId: observations.coreId, conditions: [], expressions: [] };
        grouped.push(group);
      }
      group.expressions = [...new Set([...group.expressions, ...observations.expressions])];
    }
    const uniqueExpressionsPerPoll = grouped.reduce((count, group) => count + group.expressions.length, 0);
    while (performance.now() <= deadline) {
      pollIterations++;
      if (runtimeSafetyCheck) await runtimeSafetyCheck();
      const batches = await Promise.all(grouped.map(async group => ({
        group,
        results: await this.manager.evaluateMany(sessionId, group.coreId, group.expressions)
      })));
      expressionBatchCalls += batches.length;
      expressionCount += uniqueExpressionsPerPoll;
      if (runtimeSafetyCheck) await runtimeSafetyCheck();
      lastConditions = batches.flatMap(({ group, results }) => group.conditions.map(condition =>
        conditionResult(condition, results.find(result => result.expression === condition.expression))
      ));
      if (observations) {
        const results = batches.find(batch => batch.group.coreId === observations.coreId)!.results;
        const observed = results.filter(result => observations.expressions.includes(result.expression));
        diagnosticReads = {
          capturedAt: new Date().toISOString(), coreId: observations.coreId, results: observed,
          complete: observations.expressions.every(expression =>
            observed.some(result => result.expression === expression && result.success))
        };
      }
      if (lastConditions.every(condition => condition.matched)) {
        const pollDurationMs = performance.now() - startedAt;
        return {
          sessionId, matched: true, timedOut: false, conditions: lastConditions, pollIterations,
          expressionBatchCalls, expressionCount, pollDurationMs, matchedAtMs: pollDurationMs,
          ...(diagnosticReads ? { diagnosticReads } : {}),
          ...(firstFailure ? { firstFailure } : {})
        };
      }
      if (!firstFailure) {
        let snapshot: ToolResult | undefined;
        try {
          snapshot = await this.manager.getMulticoreSnapshot(sessionId, grouped.map(group => group.coreId));
        } catch (error) {
          snapshot = { error: toStructuredError(error) };
        }
        firstFailure = {
          pollIteration: pollIterations,
          elapsedMs: performance.now() - startedAt,
          conditions: lastConditions.filter(condition => condition.matched !== true),
          ...(diagnosticReads ? { diagnosticReads } : {}),
          snapshot
        };
      }
      const remainingMs = deadline - performance.now();
      if (remainingMs <= 0) break;
      const elapsedMs = performance.now() - startedAt;
      await sleep(Math.min(strategy === "fixed" ? intervalMs : adaptiveInterval(elapsedMs, schedule), remainingMs));
    }
    return {
      sessionId, matched: false, timedOut: true, conditions: lastConditions, pollIterations,
      expressionBatchCalls, expressionCount, pollDurationMs: performance.now() - startedAt,
      ...(diagnosticReads ? { diagnosticReads } : {}),
      ...(firstFailure ? { firstFailure } : {})
    };
  }

  private async haltAndResolvePc(sessionId: string, coreIds: CoreId[], evidence: ToolResult) {
    evidence.halt = await this.manager.haltCores(sessionId, coreIds);
    assertBatchSucceeded("ipc-timeout-halt", evidence.halt);
    for (const coreId of coreIds) {
      try {
        evidence.pc.push({ coreId, ...(await this.manager.resolvePc(sessionId, coreId)) });
      } catch (error) {
        evidence.pc.push({ coreId, error: toStructuredError(error) });
        throw error;
      }
    }
  }

  private async checkElfFreshness(
    sessionId: string,
    programs: Array<{ coreId: CoreId; outPath?: string }>,
    artifactPreflight?: ToolResult,
    preparationResults?: ToolResult[]
  ) {
    const preflightFiles = Array.isArray(artifactPreflight?.hostFiles)
      ? artifactPreflight.hostFiles.filter((item: unknown): item is ToolResult => Boolean(item) && typeof item === "object")
      : [];
    const checked = await Promise.all(programs
      .filter((program): program is { coreId: CoreId; outPath: string } => typeof program.outPath === "string" && program.outPath.length > 0)
      .map(async program => {
        const expectedPath = this.manager.normalizeArtifactUri(program.outPath);
        const loadedProgramInfo = await this.manager.getLoadedProgramInfo(sessionId, program.coreId);
        const programmedProgramInfo = await this.manager.getProgrammedProgramInfo(sessionId, program.coreId);
        const preparationResult = preparationResults?.find(item => item.coreId === program.coreId);
        const metadata = await fileMetadata(expectedPath);
        const preflightFile = preflightFiles.find(item => item.path === expectedPath);
        const preflightStable = !preflightFile
          || (preflightFile.fileSize === metadata.fileSize && preflightFile.fileMTime === metadata.fileMTime && preflightFile.sha256 === metadata.sha256);
        const loadedProgramFresh = loadedProgramInfo?.programUri === expectedPath
          && loadedProgramInfo.fileSize === metadata.fileSize
          && loadedProgramInfo.sha256 === metadata.sha256;
        const programmedProgramFresh = programmedProgramInfo?.targetMemoryWritten === true
          && programmedProgramInfo.programUri === expectedPath
          && programmedProgramInfo.fileSize === metadata.fileSize
          && programmedProgramInfo.sha256 === metadata.sha256;
        const symbolsFresh = preparationResult?.success === true
          && preparationResult.symbolsLoaded === true
          && preparationResult.targetMemoryWritten === false
          && preparationResult.programUri === expectedPath
          && preparationResult.fileSize === metadata.fileSize
          && preparationResult.sha256 === metadata.sha256;
        return {
          coreId: program.coreId,
          expectedPath,
          fresh: (loadedProgramInfo ? loadedProgramFresh : symbolsFresh) && preflightStable,
          programmedProgramFresh: programmedProgramFresh && preflightStable,
          preflightStable,
          ...(preflightFile ? { preflightFile } : {}),
          hostFile: metadata,
          loadedProgramInfo,
          programmedProgramInfo,
          ...(preparationResult ? { preparationResult } : {})
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
      const structured = toStructuredError(error);
      const details = structured.details ?? {};
      return {
        requested: true,
        supported: true,
        skipped: false,
        matched: false,
        source: details.source === "MEMCFG_GSXMSEL" ? "MEMCFG_GSXMSEL" : undefined,
        register: details.register === "MEMCFG_GSXMSEL" ? "MEMCFG_GSXMSEL" : undefined,
        ownerCoreId: numberValue(details.ownerCoreId),
        targetCoreId: numberValue(details.targetCoreId),
        page: typeof details.page === "string" ? details.page : undefined,
        typeSize: numberValue(details.typeSize),
        address: numberValue(details.address),
        expectedMask: numberValue(details.expectedMask),
        actualValue: numberValue(details.actualValue),
        error: structured,
        reason: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private async verifyResidentImage(
    sessionId: string,
    requests: Array<{ coreId: number; programUri?: string; manifestUri: string; mapUri?: string }>
  ): Promise<ToolResult> {
    const checks: ResidentImageVerificationCheck[] = requests.map(request => {
      if (!request.programUri) {
        throw new DebugMcpError("ResidentArtifactsMissing", "Resident-image verification requires a CPU .out artifact", {
          sessionId,
          coreId: request.coreId,
          manifestUri: request.manifestUri,
          targetMemoryWritten: false,
          nextAction: "Provide programUri, or let the resident shortcut resolve it from the session's loaded-image record."
        });
      }
      return {
        coreId: request.coreId,
        programUri: request.programUri,
        manifestUri: request.manifestUri,
        ...(request.mapUri ? { mapUri: request.mapUri } : {})
      };
    });
    const verification = await verifyResidentImageForSession(this.manager, {
      sessionId,
      checks,
      connectIfNeeded: true
    });
    if (verification.success !== true || verification.verified !== true) {
      throw new DebugMcpError("ResidentImageMismatch", "Resident-image manifest verification failed before symbols were loaded", {
        sessionId,
        targetMemoryWritten: false,
        residentVerification: verification,
        nextAction: "Check that the manifest matches the exact resident CPU1/CPU2 Flash image pair, then retry the symbols-only workflow."
      });
    }
    return verification as ToolResult;
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
    await writeJson("artifact-preflight.json", result.artifactPreflight ?? null);
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

async function assertIpcArtifactSet(input: {
  device: string;
  cpu1CoreId: CoreId;
  cpu2CoreId: CoreId;
  cpu1OutPath: string;
  cpu2OutPath: string;
  cpu1MapPath?: string;
  cpu2MapPath?: string;
  programPreparation?: "load" | "symbols-only";
  verifyRuntimeRamOwnership?: boolean;
  cpu1OutSha256?: string;
  cpu2OutSha256?: string;
  cpu1MapSha256?: string;
  cpu2MapSha256?: string;
  ipcReadyExpressions?: ExpressionCondition[];
  bootSyncExpressions?: string[];
  systemResetBeforeHandoff?: { postStartupConditions: ExpressionCondition[]; cpu2BootContract?: Cpu2BootContract };
}, normalizePath: (artifactPath: string) => string = artifactPath => artifactPath): Promise<ToolResult> {
  const normalizedInput = {
    ...input,
    cpu1OutPath: normalizePath(input.cpu1OutPath),
    cpu2OutPath: normalizePath(input.cpu2OutPath),
    ...(input.cpu1MapPath ? { cpu1MapPath: normalizePath(input.cpu1MapPath) } : {}),
    ...(input.cpu2MapPath ? { cpu2MapPath: normalizePath(input.cpu2MapPath) } : {})
  };
  const programPair = validateProgramPair(normalizedInput.cpu1OutPath, normalizedInput.cpu2OutPath, input.device);
  const mapsComplete = Boolean(normalizedInput.cpu1MapPath && normalizedInput.cpu2MapPath);
  const allowMissingMaps = input.programPreparation === "symbols-only" && input.verifyRuntimeRamOwnership !== true;
  const mapPair = validateProgramPair(normalizedInput.cpu1MapPath, normalizedInput.cpu2MapPath, input.device);
  const issues = [...programPair.issues];
  if (mapsComplete || !allowMissingMaps) {
    issues.push(...mapPair.issues.map(issue => `map: ${issue}`));
  } else if (normalizedInput.cpu1MapPath || normalizedInput.cpu2MapPath) {
    issues.push("map: CPU1 and CPU2 maps must be supplied together when one map is provided");
  }
  const files = [
    ["CPU1 output", normalizedInput.cpu1OutPath],
    ["CPU2 output", normalizedInput.cpu2OutPath],
    ...(normalizedInput.cpu1MapPath ? [["CPU1 map", normalizedInput.cpu1MapPath] as const] : []),
    ...(normalizedInput.cpu2MapPath ? [["CPU2 map", normalizedInput.cpu2MapPath] as const] : [])
  ] as const;
  const fileChecks = await Promise.all(files.map(async ([label, filePath]) => {
    try {
      const info = await stat(filePath);
      return info.isFile() ? undefined : `${label} is not a regular file: ${filePath}`;
    } catch (error) {
      return `${label} is not readable: ${filePath} (${error instanceof Error ? error.message : String(error)})`;
    }
  }));
  issues.push(...fileChecks.filter((issue): issue is string => issue !== undefined));
  const hostFiles = await Promise.all(files
    .map(async ([label, filePath]) => {
      try {
        const metadata = await fileMetadata(filePath);
        return { label, path: filePath, ...metadata };
      } catch {
        return undefined;
      }
    }));
  const hashDeclarations = [
    { field: "cpu1OutSha256", label: "CPU1 output", path: normalizedInput.cpu1OutPath, expected: input.cpu1OutSha256 },
    { field: "cpu2OutSha256", label: "CPU2 output", path: normalizedInput.cpu2OutPath, expected: input.cpu2OutSha256 },
    { field: "cpu1MapSha256", label: "CPU1 map", path: normalizedInput.cpu1MapPath, expected: input.cpu1MapSha256 },
    { field: "cpu2MapSha256", label: "CPU2 map", path: normalizedInput.cpu2MapPath, expected: input.cpu2MapSha256 }
  ];
  issues.push(...hashDeclarations.flatMap(declaration => {
    if (!declaration.expected) return [];
    const actual = hostFiles.find(file => file?.path === declaration.path)?.sha256;
    return actual && actual.toLowerCase() !== declaration.expected.toLowerCase()
      ? [`${declaration.label} SHA-256 does not match declared hash: ${declaration.path}`]
      : [];
  }));
  const artifactSemantics = mapsComplete
    ? await validateIpcArtifactSymbols({
      cpu1CoreId: input.cpu1CoreId,
      cpu2CoreId: input.cpu2CoreId,
      cpu1MapPath: normalizedInput.cpu1MapPath!,
      cpu2MapPath: normalizedInput.cpu2MapPath!,
      expressions: [
        ...(input.ipcReadyExpressions ?? defaultIpcReadyConditions(input.cpu1CoreId, input.cpu2CoreId)),
        // Symbol validation only: these observations never become readiness gates.
        ...(input.bootSyncExpressions ?? []).map(expression => ({ coreId: input.cpu1CoreId, expression, expected: 0 })),
        ...(input.systemResetBeforeHandoff?.postStartupConditions ?? []),
        ...Object.entries(input.systemResetBeforeHandoff?.cpu2BootContract ?? {})
          .filter(([key]) => key.endsWith("Expression"))
          .map(([, expression]) => ({ coreId: input.cpu1CoreId, expression: String(expression), expected: 0 })),
        ...(input.systemResetBeforeHandoff?.cpu2BootContract?.mirrorBooleanExpressions ?? [])
          .map(expression => ({ coreId: input.cpu2CoreId, expression, expected: 0 }))
      ]
    })
    : { skipped: true, reason: "Map validation is not required for symbols-only resident debugging when runtime RAM ownership verification is disabled.", issues: [] };
  issues.push(...artifactSemantics.issues);
  const cpu1Out = describeProgramArtifact(normalizedInput.cpu1OutPath);
  const cpu2Out = describeProgramArtifact(normalizedInput.cpu2OutPath);
  if (mapsComplete) {
    const cpu1Map = describeProgramArtifact(normalizedInput.cpu1MapPath!);
    const cpu2Map = describeProgramArtifact(normalizedInput.cpu2MapPath!);
    if (cpu1Out.configuration && cpu1Map.configuration && cpu1Out.configuration !== cpu1Map.configuration) {
      issues.push(`CPU1 output/map configuration mismatch: ${cpu1Out.configuration} vs ${cpu1Map.configuration}`);
    }
    if (cpu2Out.configuration && cpu2Map.configuration && cpu2Out.configuration !== cpu2Map.configuration) {
      issues.push(`CPU2 output/map configuration mismatch: ${cpu2Out.configuration} vs ${cpu2Map.configuration}`);
    }
  }
  if (issues.length > 0) {
    throw new DebugMcpError("ArtifactPairInvalid", "IPC acceptance artifacts are incomplete or incompatible", {
      programPair,
      mapPair,
      artifactSemantics,
      issues
    });
  }
  return {
    checked: true,
    normalizedPaths: {
      cpu1OutPath: normalizedInput.cpu1OutPath,
      cpu2OutPath: normalizedInput.cpu2OutPath,
      ...(normalizedInput.cpu1MapPath ? { cpu1MapPath: normalizedInput.cpu1MapPath } : {}),
      ...(normalizedInput.cpu2MapPath ? { cpu2MapPath: normalizedInput.cpu2MapPath } : {})
    },
    hostFiles: hostFiles.filter(item => item !== undefined),
    declaredHashes: hashDeclarations
      .filter((declaration): declaration is typeof declaration & { expected: string } => Boolean(declaration.expected))
      .map(declaration => ({ field: declaration.field, path: declaration.path, sha256: declaration.expected })),
    programPair,
    mapPair,
    artifactSemantics
  };
}

async function assertReloadArtifactSet(input: {
  device: string;
  cpu1CoreId: CoreId;
  cpu2CoreId: CoreId;
  cpu1OutPath: string;
  cpu2OutPath: string;
  cpu1MapPath?: string;
  cpu2MapPath?: string;
  waitExpressions?: ExpressionCondition[];
}, normalizePath: (artifactPath: string) => string = artifactPath => artifactPath): Promise<ToolResult> {
  const normalized = {
    ...input,
    cpu1OutPath: normalizePath(input.cpu1OutPath),
    cpu2OutPath: normalizePath(input.cpu2OutPath),
    ...(input.cpu1MapPath ? { cpu1MapPath: normalizePath(input.cpu1MapPath) } : {}),
    ...(input.cpu2MapPath ? { cpu2MapPath: normalizePath(input.cpu2MapPath) } : {})
  };
  const programPair = validateProgramPair(normalized.cpu1OutPath, normalized.cpu2OutPath, input.device);
  const issues = [...programPair.issues];
  const files = [
    ["CPU1 output", normalized.cpu1OutPath],
    ["CPU2 output", normalized.cpu2OutPath],
    ...(normalized.cpu1MapPath ? [["CPU1 map", normalized.cpu1MapPath] as const] : []),
    ...(normalized.cpu2MapPath ? [["CPU2 map", normalized.cpu2MapPath] as const] : [])
  ] as const;
  const fileChecks = await Promise.all(files.map(async ([label, filePath]) => {
    try {
      const info = await stat(filePath);
      return info.isFile() ? undefined : `${label} is not a regular file: ${filePath}`;
    } catch (error) {
      return `${label} is not readable: ${filePath} (${error instanceof Error ? error.message : String(error)})`;
    }
  }));
  issues.push(...fileChecks.filter((issue): issue is string => issue !== undefined));
  const hostFiles = await Promise.all(files
    .filter(([label]) => label.endsWith("output"))
    .map(async ([label, filePath]) => {
      try {
        const metadata = await fileMetadata(filePath);
        return { label, path: filePath, ...metadata };
      } catch {
        return undefined;
      }
    }));
  let mapPair: ReturnType<typeof validateProgramPair> | undefined;
  let artifactSemantics: ToolResult | undefined;
  if (normalized.cpu1MapPath && normalized.cpu2MapPath) {
    mapPair = validateProgramPair(normalized.cpu1MapPath, normalized.cpu2MapPath, input.device);
    issues.push(...mapPair.issues.map(issue => `map: ${issue}`));
    const cpu1Map = describeProgramArtifact(normalized.cpu1MapPath);
    const cpu2Map = describeProgramArtifact(normalized.cpu2MapPath);
    if (cpu1Map.configuration && cpu2Map.configuration && cpu1Map.configuration !== cpu2Map.configuration) {
      issues.push(`map configuration mismatch: ${cpu1Map.configuration} vs ${cpu2Map.configuration}`);
    }
    artifactSemantics = await validateIpcArtifactSymbols({
      cpu1CoreId: input.cpu1CoreId,
      cpu2CoreId: input.cpu2CoreId,
      cpu1MapPath: normalized.cpu1MapPath,
      cpu2MapPath: normalized.cpu2MapPath,
      expressions: input.waitExpressions ?? defaultIpcReadyConditions(input.cpu1CoreId, input.cpu2CoreId)
    });
    issues.push(...artifactSemantics.issues);
  }
  if (issues.length > 0) {
    throw new DebugMcpError("ArtifactPairInvalid", "Reload workflow artifacts are incomplete or incompatible", {
      programPair,
      ...(mapPair ? { mapPair } : {}),
      ...(artifactSemantics ? { artifactSemantics } : {}),
      issues
    });
  }
  return {
    checked: true,
    normalizedPaths: normalized,
    hostFiles: hostFiles.filter(item => item !== undefined),
    programPair,
    ...(mapPair ? { mapPair } : {}),
    ...(artifactSemantics ? { artifactSemantics } : {})
  };
}

async function validateIpcArtifactSymbols(input: {
  cpu1CoreId: CoreId;
  cpu2CoreId: CoreId;
  cpu1MapPath: string;
  cpu2MapPath: string;
  expressions: ExpressionCondition[];
}): Promise<ToolResult> {
  const maps = [
    { coreId: input.cpu1CoreId, mapPath: input.cpu1MapPath },
    { coreId: input.cpu2CoreId, mapPath: input.cpu2MapPath }
  ];
  const requiredByCore = new Map<number, string[]>();
  const validCoreIds = new Set(maps.map(map => map.coreId));
  const unknownCoreConditions = input.expressions
    .filter(condition => !validCoreIds.has(condition.coreId))
    .map(condition => `IPC condition ${condition.expression} targets core ${condition.coreId}, which is not in the CPU1/CPU2 acceptance pair`);
  for (const condition of input.expressions) {
    const root = expressionRootSymbol(condition.expression);
    if (!root) continue;
    const symbols = requiredByCore.get(condition.coreId) ?? [];
    if (!symbols.includes(root)) symbols.push(root);
    requiredByCore.set(condition.coreId, symbols);
  }
  const results = await Promise.all(maps.map(async map => {
    const requiredSymbols = requiredByCore.get(map.coreId) ?? [];
    try {
      const content = await readFile(map.mapPath, "utf8");
      const hasSymbolTable = /GLOBAL (?:DATA )?SYMBOLS:\s+SORTED/i.test(content);
      if (!hasSymbolTable) {
        return {
          coreId: map.coreId,
          mapPath: map.mapPath,
          checked: false,
          reason: "map does not expose a recognizable global symbol table",
          requiredSymbols
        };
      }
      const missingSymbols = requiredSymbols.filter(symbol => !new RegExp(`\\b${escapeRegExp(symbol)}\\b`).test(content));
      return {
        coreId: map.coreId,
        mapPath: map.mapPath,
        checked: true,
        requiredSymbols,
        missingSymbols
      };
    } catch (error) {
      return {
        coreId: map.coreId,
        mapPath: map.mapPath,
        checked: false,
        reason: error instanceof Error ? error.message : String(error),
        requiredSymbols
      };
    }
  }));
  const missing = results.flatMap(result => (result.missingSymbols ?? []).map(symbol => `core ${result.coreId} map is missing IPC diagnostic symbol ${symbol}`));
  return {
    mode: "map-global-symbols",
    checked: results.some(result => result.checked === true),
    results,
    issues: [...unknownCoreConditions, ...missing]
  };
}

function expressionRootSymbol(expression: string): string | undefined {
  return expression.trim().match(/^[(&\s]*([A-Za-z_][A-Za-z0-9_]*)/)?.[1];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

function assertCpu1OnlyResetType(resetType: ResetType, sessionId: string, cpu1CoreId: CoreId): void {
  if (resetType === "system" || resetType === "default") {
    throw new DebugMcpError("Cpu1OnlyResetRequired", "Firmware-owned CPU2 boot requires a CPU1-only cpu or restart reset after CPU2 disconnect", {
      sessionId,
      cpu1CoreId,
      requestedResetType: resetType,
      allowedResetTypes: ["cpu", "restart"],
      diagnosisCode: "APPLICATION_ENTRY_NOT_REACHED"
    });
  }
}

async function collectCpu1OnlyStartupEvidence(
  manager: Pick<DebugSessionManager, "haltCore" | "getMulticoreSnapshot" | "evaluateMany">,
  options: {
    sessionId: string;
    cpu1CoreId: CoreId;
    cpu2CoreId: CoreId;
    applicationEntry: ApplicationEntryCheck;
    postLoadReset?: ToolResult;
    bootModeExpression?: string;
    cpu1ResetStateExpression?: string;
    bootSyncExpressions?: string[];
    ipcReadyExpressions?: ExpressionCondition[];
  }
): Promise<ToolResult> {
  let halt: ToolResult;
  try {
    halt = await manager.haltCore(options.sessionId, options.cpu1CoreId);
  } catch (error) {
    halt = { success: false, error: toStructuredError(error) };
  }

  let snapshot: ToolResult;
  try {
    snapshot = await manager.getMulticoreSnapshot(options.sessionId, [options.cpu1CoreId]);
  } catch (error) {
    snapshot = { success: false, error: toStructuredError(error) };
  }

  const requestedBootSyncExpressions = options.bootSyncExpressions?.length
    ? options.bootSyncExpressions
    : (options.ipcReadyExpressions ?? [])
      .filter(condition => condition.coreId === options.cpu1CoreId)
      .map(condition => condition.expression);
  const bootSyncExpressions = requestedBootSyncExpressions.length > 0
    ? requestedBootSyncExpressions
    : [...DEFAULT_CPU1_BOOT_EXPRESSIONS];
  const expressions = [...new Set([
    ...(options.bootModeExpression ? [options.bootModeExpression] : []),
    ...(options.cpu1ResetStateExpression ? [options.cpu1ResetStateExpression] : []),
    ...bootSyncExpressions
  ])];
  let results: EvaluateResult[] = [];
  let evaluationError: ToolResult | undefined;
  try {
    results = await manager.evaluateMany(options.sessionId, options.cpu1CoreId, expressions);
  } catch (error) {
    evaluationError = toStructuredError(error);
  }
  const resultFor = (expression: string | undefined): ToolResult | undefined => {
    if (!expression) return undefined;
    const result = results.find(item => item.expression === expression);
    return {
      expression,
      ...(result ? { result } : {}),
      ...(evaluationError ? { evaluationError } : {})
    };
  };
  const bootSyncResults = bootSyncExpressions.map(expression => ({
    expression,
    result: results.find(result => result.expression === expression)
  }));
  const cpu1Snapshot = Array.isArray(snapshot.cores)
    ? snapshot.cores.find((core: ToolResult) => core.coreId === options.cpu1CoreId)
    : undefined;
  return {
    capturedAt: new Date().toISOString(),
    targetAccessPolicy: "cpu1-only-after-cpu2-disconnect",
    applicationEntry: options.applicationEntry,
    cpu1: {
      coreId: options.cpu1CoreId,
      halt,
      snapshot: cpu1Snapshot,
      reset: options.postLoadReset,
      bootMode: resultFor(options.bootModeExpression) ?? { status: "not-configured" },
      resetState: resultFor(options.cpu1ResetStateExpression) ?? {
        status: "target-state",
        state: cpu1Snapshot?.state,
        connected: cpu1Snapshot?.connected
      },
      bootSync: {
        status: evaluationError ? "evaluation-failed" : "recorded",
        expressions: bootSyncResults,
        ...(evaluationError ? { evaluationError } : {})
      }
    },
    cpu2: {
      coreId: options.cpu2CoreId,
      connected: false,
      state: "Disconnected",
      targetOperationsSuppressed: true,
      reason: "CPU2 remained disconnected because CPU1 application entry was not confirmed."
    },
    ipcReadySkipped: true
  };
}

function assertPreStartupSafetyGuardScope(
  guard: { conditions: Array<{ coreId: number }>; haltCoreIds: number[] },
  coreIds: readonly number[]
): void {
  const allowed = new Set(coreIds);
  const invalidConditionCoreIds = [...new Set(guard.conditions.map(condition => condition.coreId).filter(coreId => !allowed.has(coreId)))];
  const invalidHaltCoreIds = [...new Set(guard.haltCoreIds.filter(coreId => !allowed.has(coreId)))];
  if (invalidConditionCoreIds.length > 0 || invalidHaltCoreIds.length > 0) {
    throw new DebugMcpError("StartupContractInvalid", "The pre-startup safety guard must remain within the IPC workflow core scope", {
      allowedCoreIds: [...allowed],
      invalidConditionCoreIds,
      invalidHaltCoreIds
    });
  }
}

export interface PairedFlashContract {
  /** True when this run programs Flash and must honour the paired boundary. */
  required: boolean;
  preset: string | null;
  source: "startup-preset" | "cpu2-linker-map" | "none";
  ownerCoreId: CoreId;
  targetCoreId: CoreId;
  flashBanks: number[];
}

/**
 * F28P65x paired Flash programming contract.
 *
 * Programming a CPU2 Flash image requires the CPU1 on-chip Flash Plugin to
 * prepare the shared Flash clock and bank mapping while CPU1 holds the target.
 * The legacy `cpu1-run-before-cpu2` load sequence starts CPU1 before CPU2 is
 * loaded, so it cannot be combined with a CPU2 Flash image; that combination is
 * rejected here, before the first target access, instead of being discovered as
 * a DSS timeout during preparation.
 */
export function resolvePairedFlashContract(input: {
  startupPreset?: string | null;
  loadMode: "cpu1-then-cpu2" | "cpu1-run-before-cpu2";
  ownerCoreId: CoreId;
  targetCoreId: CoreId;
  cpu2FlashBanks: number[];
}): PairedFlashContract {
  const flashBanks = [...new Set(input.cpu2FlashBanks)]
    .filter(bank => Number.isInteger(bank) && bank >= 0)
    .sort((left, right) => left - right);
  const presetRequested = isPairedFlashPreset(input.startupPreset);
  const source: PairedFlashContract["source"] = presetRequested
    ? "startup-preset"
    : flashBanks.length > 0 ? "cpu2-linker-map" : "none";
  if (input.loadMode === "cpu1-run-before-cpu2" && flashBanks.length > 0) {
    throw new DebugMcpError(
      "StartupContractInvalid",
      "A CPU2 Flash image cannot use loadSequence.mode cpu1-run-before-cpu2: CPU1 must stay halted while the CPU1 Flash Plugin prepares the shared Flash clock and bank mapping",
      {
        loadMode: input.loadMode,
        cpu1CoreId: input.ownerCoreId,
        cpu2CoreId: input.targetCoreId,
        cpu2FlashBanks: flashBanks,
        diagnosisCode: "PAIRED_FLASH_REQUIRES_HALTED_OWNER",
        targetMemoryWritten: false,
        requiredLoadMode: "cpu1-then-cpu2",
        nextAction: "Use startupPreset f28p65x-paired-flash (or loadSequence.mode cpu1-then-cpu2); both Flash images are then programmed before any application core is started."
      }
    );
  }
  return {
    required: presetRequested || flashBanks.length > 0,
    preset: input.startupPreset ?? null,
    source,
    ownerCoreId: input.ownerCoreId,
    targetCoreId: input.targetCoreId,
    flashBanks
  };
}

function assertWorkflowStartupContract(input: {
  loadSequence: { mode: "cpu1-then-cpu2" | "cpu1-run-before-cpu2" };
  runSequence: { runMode?: "cpu1_boots_cpu2" | "debugger_runs_both" | "cpu2_pre_running"; runCpu1First: boolean; runCpu2: boolean; releaseCpu2BeforeCpu1?: boolean };
}): void {
  const issues = workflowStartupContractIssues({
    loadMode: input.loadSequence.mode,
    runMode: input.runSequence.runMode,
    runCpu1First: input.runSequence.runCpu1First,
    runCpu2: input.runSequence.runCpu2,
    releaseCpu2BeforeCpu1: input.runSequence.releaseCpu2BeforeCpu1
  });
  if (issues.length > 0) {
    throw new DebugMcpError("StartupContractInvalid", "The requested multicore load/run sequence is internally contradictory", {
      issues,
      startupContract: describeWorkflowStartupContract({
        loadMode: input.loadSequence.mode,
        runMode: input.runSequence.runMode,
        runCpu1First: input.runSequence.runCpu1First,
        runCpu2: input.runSequence.runCpu2,
        releaseCpu2BeforeCpu1: input.runSequence.releaseCpu2BeforeCpu1
      })
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

function skippedResetBatch(
  sessionId: string,
  coreIds: CoreId[],
  requestedResetType: ResetType,
  reason: string
): ToolResult {
  return {
    sessionId,
    sequential: true,
    skipped: true,
    requestedResetType,
    reason,
    results: coreIds.map(coreId => ({
      coreId,
      success: true,
      skipped: true,
      skipReason: reason
    }))
  };
}

function isSkippedResetBatch(result: { results?: unknown[] } | ToolResult): boolean {
  return (result as ToolResult).skipped === true;
}

function buildPrecomputedExpressionResults(
  conditions: ExpressionCondition[] | undefined,
  ipcReady: ToolResult | undefined
): Array<{ coreId: CoreId; results: EvaluateResult[] }> | undefined {
  // A timed-out poll is followed by a halt/PC recovery, so its values are no
  // longer a snapshot of the state used by the diagnosis. Only reuse a fully
  // matched poll with no intervening target mutation.
  if (!conditions || ipcReady?.matched !== true || !Array.isArray(ipcReady.conditions)) return undefined;

  const observed = new Map<CoreId, Map<string, EvaluateResult>>();
  for (const condition of ipcReady.conditions) {
    if (!isEvaluateResult(condition?.result)) continue;
    const byExpression = observed.get(condition.coreId) ?? new Map<string, EvaluateResult>();
    byExpression.set(condition.expression, condition.result);
    observed.set(condition.coreId, byExpression);
  }

  const groups = groupConditionsByCore(conditions);
  const results: Array<{ coreId: CoreId; results: EvaluateResult[] }> = [];
  for (const group of groups) {
    const byExpression = observed.get(group.coreId);
    const groupResults = group.expressions.map(expression => byExpression?.get(expression));
    if (groupResults.some(result => result === undefined)) return undefined;
    results.push({ coreId: group.coreId, results: groupResults as EvaluateResult[] });
  }
  return results;
}

function isEvaluateResult(value: unknown): value is EvaluateResult {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<EvaluateResult>;
  return typeof candidate.expression === "string" && typeof candidate.success === "boolean";
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
    cpu2: {
      coreId: cpu2CoreId,
      pc: cpu2?.pc,
      expressions: cpu2?.expressions ?? [],
      ...(evidence.cpu2FaultEvidence ? { faultEvidence: evidence.cpu2FaultEvidence } : {})
    }
  };
}
function recommendedActions(diagnosisCode: string, verdict: ToolResult, ramOwnership?: RamOwnershipAnalysis): string[] {
  if (diagnosisCode === "APPLICATION_ENTRY_NOT_REACHED") {
    return [
      "Verify the CPU1 PC enters the linker-map application code range after the CPU1-only restart.",
      "Inspect the recorded boot mode, CPU1 reset state, and boot-sync expressions; CPU2 was intentionally not touched before entry confirmation."
    ];
  }
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
    `- failureSignature: ${String(evidence.optimization?.failureSignature ?? "n/a")}`,
    `- applicationEntryReached: ${String(evidence.applicationEntry?.reached ?? "n/a")}`,
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
    artifactPreflight: result.artifactPreflight,
    runtimeRamOwnership: result.runtimeRamOwnership ?? diagnosis.runtimeRamOwnership,
    optimization: result.optimization,
    applicationEntry: result.applicationEntry ?? diagnosis.applicationEntry,
    startupEvidence: result.startupEvidence,
    programs,
    pc,
    runPlan: result.runPlan,
    performedSteps: result.performedSteps ?? []
  };
}

function defaultBundleDir(label: string, filesystem?: FilesystemPolicy): string {
  const configuredRoot = filesystem?.allowedWriteRoots.find(root => root.length > 0);
  if (filesystem && !configuredRoot) {
    throw new DebugMcpError("PathOutsideAllowedWriteRoots", "No allowed write root is configured for the default workflow bundle", {
      label,
      allowedRoots: []
    });
  }
  const root = configuredRoot ? path.resolve(configuredRoot) : process.cwd();
  return path.join(root, ".c2000-debug-bundles", `${label}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
}

function runtimeRamOwnershipAccepted(status: ToolResult | undefined): boolean {
  return status?.requested !== true || status.matched === true;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function resolveRunPlan(
  sequence: {
    runMode?: "cpu1_boots_cpu2" | "debugger_runs_both" | "cpu2_pre_running";
    runCpu1First: boolean;
    runCpu2: boolean;
    releaseCpu2BeforeCpu1?: boolean;
  },
  cpu1CoreId: CoreId,
  cpu2CoreId: CoreId
) {
  if (sequence.runMode === "cpu1_boots_cpu2") {
    return {
      mode: sequence.runMode,
      cpu2StartAuthority: "firmware-owned" as const,
      coreOrder: [cpu1CoreId],
      releaseCpu2BeforeCpu1: true,
      warnings: ["CPU2 is disconnected while CPU1 firmware releases it from reset, then reconnected for diagnosis."]
    };
  }
  if (sequence.runMode === "debugger_runs_both") {
    return { mode: sequence.runMode, cpu2StartAuthority: "debugger-owned" as const, coreOrder: [cpu1CoreId, cpu2CoreId], releaseCpu2BeforeCpu1: false, warnings: [] };
  }
  if (sequence.runMode === "cpu2_pre_running") {
    return {
      mode: sequence.runMode,
      cpu2StartAuthority: "pre-running" as const,
      coreOrder: [cpu2CoreId, cpu1CoreId],
      releaseCpu2BeforeCpu1: false,
      warnings: ["CPU2 is started before CPU1; use only for firmware designed for this ordering."]
    };
  }
  return {
    mode: "legacy_flags" as const,
    cpu2StartAuthority: "unspecified" as const,
    coreOrder: [
      ...(sequence.runCpu1First ? [cpu1CoreId] : []),
      ...(sequence.runCpu2 ? [cpu2CoreId] : [])
    ],
    releaseCpu2BeforeCpu1: sequence.releaseCpu2BeforeCpu1 === true,
    warnings: sequence.runCpu1First && !sequence.runCpu2 && !sequence.releaseCpu2BeforeCpu1
      ? ["CPU2 remains debugger-halted unless CPU1 firmware explicitly releases it or releaseCpu2BeforeCpu1 is enabled."]
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
