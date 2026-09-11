import type { C2000ToolInvoker } from "../mcp/tools.js";
import { DURABLE_PLAN_LIMITS, resolveArtifactsForBoard, type TestArtifacts, type TestPlan, type TestPlanStep } from "./TestPlanSchema.js";
import type { CanAcceptanceService } from "../can/CanAcceptanceService.js";
import type { BoardLeaseContext } from "../boards/types.js";
import { DebugMcpError, toStructuredError } from "../utils/errors.js";
import { assertAllowedReadPath, type FilesystemPolicy } from "../security/pathPolicy.js";
import { sha256File } from "../utils/fileHash.js";
import { valuesEqual } from "../utils/expressionMatch.js";

export interface StepExecutionContext {
  jobId: string;
  boardId: string;
  sessionId?: string;
  /** Durable lease held by the job engine; group work never invents ownership. */
  leaseId?: string;
  leaseContext?: BoardLeaseContext;
  probeSerial?: string;
  plan: TestPlan;
  step: TestPlanStep;
  signal?: AbortSignal;
}

export class StepRegistry {
  constructor(
    private readonly tools: C2000ToolInvoker,
    private readonly canAcceptance?: CanAcceptanceService,
    private readonly filesystem?: FilesystemPolicy
  ) {}

  async execute(context: StepExecutionContext): Promise<Record<string, unknown>> {
    const { plan, step, boardId, sessionId } = context;
    context.signal?.throwIfAborted();
    const artifacts = resolveArtifactsForBoard(plan, boardId);
    switch (step.type) {
      case "delay":
        return this.executeDelay(context, step.delayMs ?? 0);
      case "canAcceptance":
        if (!this.canAcceptance) throw new Error("CAN acceptance is unavailable in this runtime");
        return this.canAcceptance.execute(context);
      case "preflight":
        return this.tools.invokeTool("c2000_getHardwarePreflight", {});
      case "launchMulticore":
        const hasArtifacts = Boolean(artifacts?.cpu1OutPath && artifacts.cpu2OutPath);
        // CAN-only plans use the debug session as a fenced board-flow
        // boundary and intentionally do not need firmware artifacts. For all
        // other durable flows, a load-enabled launch must be explicit and
        // complete rather than silently degrading to connect-only.
        const loadPrograms = step.loadPrograms && (hasArtifacts || !plan.can);
        if (step.loadPrograms && !hasArtifacts && !plan.can) {
          throw new DebugMcpError("LaunchArtifactsMissing", "launchMulticore.loadPrograms=true requires CPU1 and CPU2 artifacts for the selected board", {
            boardId,
            requiredArtifacts: ["cpu1OutPath", "cpu2OutPath"]
          });
        }
        const artifactPreflight = loadPrograms ? await this.preflightDeclaredArtifactHashes(artifacts) : undefined;
        const launch = await this.tools.invokeTool("c2000_launchMulticoreDebug", fenced(context, {
          boardId,
          sessionName: `${plan.name}-${boardId}`,
          autoCloseOnComplete: false,
          loadPrograms,
          ...(step.startupPreset ? { startupPreset: step.startupPreset } : {}),
          ...(step.resetType ? { resetType: step.resetType } : {}),
          loadSequence: step.loadSequence,
          ...(step.runSequence ? { runSequence: step.runSequence } : {}),
          cores: [
            {
              coreId: 0, coreName: "C28xx_CPU1", corePattern: "C28xx_CPU1",
              ...(loadPrograms && artifacts?.cpu1OutPath ? { programUri: artifacts.cpu1OutPath, mapUri: artifacts.cpu1MapPath } : {}),
              ...(loadPrograms ? { ramOwnershipPolicy: "require-map" } : {}),
              connect: true, load: loadPrograms && Boolean(artifacts?.cpu1OutPath), haltAtEntry: true
            },
            {
              coreId: 2, coreName: "C28xx_CPU2", corePattern: "C28xx_CPU2",
              ...(loadPrograms && artifacts?.cpu2OutPath ? {
                programUri: artifacts.cpu2OutPath,
                mapUri: artifacts.cpu2MapPath,
                ramOwnershipPolicy: "require-map"
              } : {}),
              connect: true, load: loadPrograms && Boolean(artifacts?.cpu2OutPath), haltAtEntry: true
            }
          ]
        }));
        return {
          ...launch,
          ...(artifactPreflight ? { artifactPreflight } : {})
        };
      case "assignExpressions": {
        const activeSessionId = requiredSessionId(sessionId);
        const results: Record<string, unknown>[] = [];
        for (const assignment of step.assignments) {
          results.push(await this.invokeRequired("c2000_assignExpression", fenced(context, {
            sessionId: activeSessionId,
            ...assignment
          })));
        }
        return { success: true, sessionId: activeSessionId, assignmentMode: "ordered-fail-fast", results };
      }
      case "injectFaults":
        return this.tools.invokeTool("c2000_injectFaults", fenced(context, requiredSession({ sessionId, faults: step.faults })));
      case "captureExpressions":
        return this.captureExpressions(context, requiredSessionId(sessionId), step.reads, step.sampleCount, step.intervalMs, step.label);
      case "waitForExpressions":
        return plan.safetyGuards
          ? this.waitForExpressionsWithGuards(context, requiredSessionId(sessionId), step.conditions, step.timeoutMs, step.intervalMs)
          : this.tools.invokeTool("c2000_waitForExpressionSet", fenced(context, requiredSession({
            sessionId,
            conditions: step.conditions,
            timeoutMs: step.timeoutMs,
            intervalMs: step.intervalMs
          })));
      case "runCores": {
        const activeSessionId = requiredSessionId(sessionId);
        const run = await this.invokeRequired("c2000_runCores", fenced(context, { sessionId: activeSessionId, coreIds: step.coreIds }));
        const safetyGuardChecks: Record<string, unknown>[] = [];
        let safetyGuardPollIterations = 0;
        if (step.monitorMs > 0) {
          const deadline = Date.now() + step.monitorMs;
          while (Date.now() < deadline) {
            await abortableDelay(Math.min(step.intervalMs, Math.max(0, deadline - Date.now())), context.signal);
            if (plan.safetyGuards) {
              safetyGuardPollIterations += 1;
              retainGuardEvidence(safetyGuardChecks, await this.assertSafetyGuards(context, activeSessionId, "run-monitor"));
            }
          }
        }
        return { success: true, sessionId: activeSessionId, run, monitorMs: step.monitorMs, safetyGuardPollIterations, safetyGuardChecks };
      }
      case "haltCores": {
        const activeSessionId = requiredSessionId(sessionId);
        const halt = await this.invokeRequired("c2000_haltCores", fenced(context, { sessionId: activeSessionId, coreIds: step.coreIds }));
        return { success: true, sessionId: activeSessionId, halt };
      }
      case "reconnectAfterTargetReset":
        return this.reconnectAfterTargetReset(context, requiredSessionId(sessionId), step);
      case "restorePrograms":
        return this.restorePrograms(context, requiredSessionId(sessionId), step);
      case "resetReconnectCapture": {
        const activeSessionId = requiredSessionId(sessionId);
        const reset = await this.invokeRequired("c2000_resetCores", fenced(context, {
          sessionId: activeSessionId,
          coreIds: step.coreIds,
          resetType: step.resetType
        }));
        await abortableDelay(step.settleMs, context.signal);
        const reconnect = await this.invokeRequired("c2000_connectCores", fenced(context, {
          sessionId: activeSessionId,
          coreIds: step.coreIds
        }));
        const reload: Record<string, unknown>[] = [];
        if (step.reload === "symbols") {
          for (const coreId of step.coreIds) {
            const programUri = programForCore(artifacts, coreId);
            reload.push(await this.invokeRequired("c2000_loadSymbols", fenced(context, { sessionId: activeSessionId, coreId, programUri })));
          }
        } else if (step.reload === "programs") {
          reload.push(await this.invokeRequired("c2000_loadPrograms", fenced(context, {
            sessionId: activeSessionId,
            programs: step.coreIds.map(coreId => ({
              coreId,
              programUri: programForCore(artifacts, coreId),
              ...(mapForCore(artifacts, coreId) ? { mapUri: mapForCore(artifacts, coreId) } : {}),
              loadPolicy: step.loadPolicy,
              allowDestructiveFlashReload: step.allowDestructiveFlashReload
            }))
          })));
        }
        const capture = await this.captureExpressions(context, activeSessionId, step.reads, 1, 0, "post-reset-reconnect");
        return { success: true, sessionId: activeSessionId, reset, reconnect, reloadMode: step.reload, reload, ...capture };
      }
      case "runIpcAcceptance":
        await this.preflightDeclaredArtifactHashes(artifacts);
        return this.tools.invokeTool("c2000_runIpcAcceptance", fenced(context, requiredSession({
          sessionId, device: "F28P65x", cpu1CoreId: 0, cpu2CoreId: 2,
          cpu1OutPath: artifacts?.cpu1OutPath, cpu2OutPath: artifacts?.cpu2OutPath,
          cpu1MapPath: artifacts?.cpu1MapPath, cpu2MapPath: artifacts?.cpu2MapPath,
          startupPreset: step.startupPreset,
          resetType: step.resetType,
          programPreparation: step.programPreparation,
          ...(step.programPreparation === "symbols-only" && plan.safetyGuards ? {
            preStartupSafetyGuard: {
              conditions: plan.safetyGuards.conditions,
              haltCoreIds: plan.safetyGuards.haltCoreIds
            }
          } : {}),
          cpu1OutSha256: artifacts?.cpu1OutSha256,
          cpu2OutSha256: artifacts?.cpu2OutSha256,
          cpu1MapSha256: artifacts?.cpu1MapSha256,
          cpu2MapSha256: artifacts?.cpu2MapSha256,
          loadPolicy: step.loadPolicy,
          allowDestructiveFlashReload: step.allowDestructiveFlashReload,
          loadSequence: step.loadSequence,
          ipcReadyExpressions: step.ipcReadyExpressions,
          runSequence: step.runMode
            ? {
              ...step.runSequence,
              runMode: step.runMode,
              runCpu1First: step.runMode !== "cpu2_pre_running",
              runCpu2: step.runMode !== "cpu1_boots_cpu2",
              settleMs: step.runSequence?.settleMs ?? 0
            }
            : step.runSequence,
          cpu1EntryAddress: step.cpu1EntryAddress,
          applicationEntryTimeoutMs: step.applicationEntryTimeoutMs,
          bootModeExpression: step.bootModeExpression,
          cpu1ResetStateExpression: step.cpu1ResetStateExpression,
          bootSyncExpressions: step.bootSyncExpressions,
          timeoutMs: step.timeoutMs ?? 10000,
          intervalMs: step.intervalMs ?? 100,
          verifyRuntimeRamOwnership: Boolean(step.verifyRuntimeRamOwnership),
          collectDebugBundle: plan.failurePolicy.collectDebugBundle,
          outputDir: artifacts?.outputDir
        })));
      case "runBootHandoffDiagnosis":
        return this.tools.invokeTool("c2000_runBootHandoffDiagnosis", fenced(context, requiredSession({
          sessionId,
          device: "F28P65x",
          cpu1CoreId: 0,
          cpu2CoreId: 2,
          cpu1OutPath: artifacts?.cpu1OutPath,
          cpu2OutPath: artifacts?.cpu2OutPath,
          cpu1MapPath: artifacts?.cpu1MapPath,
          cpu2MapPath: artifacts?.cpu2MapPath,
          verifyRuntimeRamOwnership: Boolean(step.verifyRuntimeRamOwnership),
          expectedPostLoadHalt: Boolean(step.expectedPostLoadHalt),
          outputDir: artifacts?.outputDir
        })));
      case "runReloadAndDiagnose":
        return this.tools.invokeTool("c2000_runReloadAndDiagnose", fenced(context, requiredSession({ sessionId, device: "F28P65x", cpu1CoreId: 0, cpu2CoreId: 2, cpu1OutPath: artifacts?.cpu1OutPath, cpu2OutPath: artifacts?.cpu2OutPath, cpu1MapPath: artifacts?.cpu1MapPath, cpu2MapPath: artifacts?.cpu2MapPath, resetType: "cpu", runCpu1: true, runCpu2: false, allowDestructiveFlashReload: step.allowDestructiveFlashReload, timeoutMs: step.timeoutMs, intervalMs: step.intervalMs ?? 100, collectDebugBundle: plan.failurePolicy.collectDebugBundle, outputDir: artifacts?.outputDir })));
      case "runFullDebugBundle":
        return this.tools.invokeTool("c2000_runFullDebugBundle", fenced(context, requiredSession({ sessionId, device: "F28P65x", cpu1CoreId: 0, cpu2CoreId: 2, cpu1OutPath: artifacts?.cpu1OutPath, cpu2OutPath: artifacts?.cpu2OutPath, cpu1MapPath: artifacts?.cpu1MapPath, cpu2MapPath: artifacts?.cpu2MapPath, outputDir: artifacts?.outputDir })));
      case "cleanup":
        return sessionId ? this.tools.invokeTool("c2000_closeDebugSession", fenced(context, { sessionId })) : { success: true, skipped: true };
    }
  }

  async assertSafetyGuards(context: StepExecutionContext, sessionId: string, phase: string): Promise<Record<string, unknown>> {
    const guards = context.plan.safetyGuards;
    if (!guards) return { phase, skipped: true };
    let evidence: Record<string, unknown>;
    try {
      const evaluated = await this.evaluateConditions(context, sessionId, guards.conditions);
      evidence = { phase, checkedAt: new Date().toISOString(), ...evaluated };
      if (evaluated.matched) return evidence;
    } catch (error) {
      evidence = { phase, checkedAt: new Date().toISOString(), matched: false, evaluationError: toStructuredError(error) };
    }
    let halt: Record<string, unknown>;
    try {
      halt = await this.invokeConfirmedHalt(context, sessionId, guards.haltCoreIds);
    } catch (error) {
      halt = { success: false, error: toStructuredError(error) };
    }
    throw new DebugMcpError("SafetyGuardViolation", "A durable safety guard did not match or could not be evaluated; fenced halt was issued before failing the job", {
      sessionId,
      evidence,
      haltCoreIds: guards.haltCoreIds,
      halt
    });
  }

  private async executeDelay(context: StepExecutionContext, delayMs: number): Promise<Record<string, unknown>> {
    const sessionId = context.sessionId;
    const guards = context.plan.safetyGuards;
    if (!sessionId || !guards || delayMs === 0) {
      await abortableDelay(delayMs, context.signal);
      return { delayedMs: delayMs, safetyGuardChecks: [] };
    }
    const safetyGuardChecks: Record<string, unknown>[] = [];
    let safetyGuardPollIterations = 0;
    const deadline = Date.now() + delayMs;
    while (Date.now() < deadline) {
      await abortableDelay(Math.min(guards.intervalMs, Math.max(0, deadline - Date.now())), context.signal);
      safetyGuardPollIterations += 1;
      retainGuardEvidence(safetyGuardChecks, await this.assertSafetyGuards(context, sessionId, "delay-monitor"));
    }
    return { delayedMs: delayMs, safetyGuardPollIterations, safetyGuardChecks };
  }

  private async waitForExpressionsWithGuards(
    context: StepExecutionContext,
    sessionId: string,
    conditions: Array<{ label?: string; coreId: number; expression: string; expected: string | number | boolean }>,
    timeoutMs: number,
    intervalMs: number
  ): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    let pollIterations = 0;
    let lastConditions: Record<string, unknown>[] = [];
    const safetyGuardChecks: Record<string, unknown>[] = [];
    while (Date.now() <= deadline) {
      pollIterations += 1;
      const evaluated = await this.evaluateConditions(context, sessionId, conditions);
      lastConditions = evaluated.conditions;
      retainGuardEvidence(safetyGuardChecks, await this.assertSafetyGuards(context, sessionId, "wait-monitor"));
      if (evaluated.matched) {
        return { success: true, sessionId, matched: true, timedOut: false, pollIterations, conditions: lastConditions, safetyGuardChecks };
      }
      if (Date.now() >= deadline) break;
      await abortableDelay(Math.min(intervalMs, Math.max(0, deadline - Date.now())), context.signal);
    }
    throw new DebugMcpError("ExpressionWaitTimeout", "Durable expression wait timed out while safety guards remained active", {
      sessionId, timeoutMs, intervalMs, pollIterations, conditions: lastConditions, safetyGuardChecks
    });
  }

  private async reconnectAfterTargetReset(
    context: StepExecutionContext,
    sessionId: string,
    step: Extract<TestPlanStep, { type: "reconnectAfterTargetReset" }>
  ): Promise<Record<string, unknown>> {
    assertReconnectCoreScope(step);
    const symbolPaths = step.reloadSymbols
      ? await Promise.all(step.coreIds.map(async coreId => [coreId, await this.validateReadPath(programForCore(resolveArtifactsForBoard(context.plan, context.boardId), coreId))] as const))
      : [];
    const baselineSnapshot = await this.invokeRequired("c2000_getMulticoreSnapshot", fenced(context, { sessionId, coreIds: step.coreIds }));
    assertConnectedSnapshotBaseline(baselineSnapshot, step.coreIds);
    const safetyGuardChecks: Record<string, unknown>[] = [];
    if (context.plan.safetyGuards) {
      retainGuardEvidence(safetyGuardChecks, await this.assertSafetyGuards(context, sessionId, "reset-wait-baseline"));
    }
    const baselineEvidence = step.resetEvidence
      ? await this.readResetEvidence(context, sessionId, step.resetEvidence, "baseline")
      : undefined;
    const pollIntervalMs = Math.min(step.intervalMs, context.plan.safetyGuards?.intervalMs ?? step.intervalMs);
    const deadline = Date.now() + step.timeoutMs;
    let pollIterations = 0;
    let lastSnapshot: Record<string, unknown> | undefined = baselineSnapshot;
    let resetEvidence: Record<string, unknown> | undefined;
    let observed: Record<string, unknown> | undefined;
    // A host-side guard/evidence read can consume a very small configured
    // timeout before the first post-baseline snapshot is returned. Always
    // allow two bounded observations so a disconnect that occurs between the
    // baseline and first poll is not lost solely to scheduler jitter.
    const minimumPollIterations = 2;
    while (pollIterations < minimumPollIterations || Date.now() <= deadline) {
      const remainingMs = Math.max(0, deadline - Date.now());
      if (remainingMs > 0) await abortableDelay(Math.min(pollIntervalMs, remainingMs), context.signal);
      pollIterations += 1;
      try {
        lastSnapshot = await this.invokeRequired("c2000_getMulticoreSnapshot", fenced(context, { sessionId, coreIds: step.coreIds }));
      } catch (error) {
        if (!isTargetReadInaccessible(error)) throw error;
        observed = { mode: "target-state-unreadable", observedAt: new Date().toISOString(), error: toStructuredError(error) };
        break;
      }
      const disconnectedCoreIds = snapshotDisconnectedCoreIds(lastSnapshot, step.coreIds);
      if (disconnectedCoreIds.length > 0) {
        observed = { mode: "target-disconnected", disconnectedCoreIds, observedAt: new Date().toISOString() };
        break;
      }
      const unreadableCoreIds = snapshotUnreadableCoreIds(lastSnapshot, step.coreIds);
      if (unreadableCoreIds.length > 0) {
        observed = { mode: "target-state-unreadable", unreadableCoreIds, observedAt: new Date().toISOString(), snapshot: lastSnapshot };
        break;
      }
      if (context.plan.safetyGuards) {
        retainGuardEvidence(safetyGuardChecks, await this.assertSafetyGuards(context, sessionId, "reset-wait-monitor"));
      }
      if (step.resetEvidence) {
        const currentEvidence = await this.readResetEvidence(context, sessionId, step.resetEvidence, "poll");
        resetEvidence = compareFreshResetEvidence(step.resetEvidence, baselineEvidence!, currentEvidence);
        if (resetEvidence.matched === true) {
          observed = { mode: "explicit-reset-expression", observedAt: new Date().toISOString(), resetEvidence };
          break;
        }
      }
      if (Date.now() >= deadline && pollIterations >= minimumPollIterations) break;
    }
    if (!observed) {
      throw new DebugMcpError("TargetResetNotObserved", "No target disconnect or matching explicit reset evidence was observed before reconnect timeout", {
        sessionId, coreIds: step.coreIds, timeoutMs: step.timeoutMs, pollIterations, baselineSnapshot, baselineEvidence, lastSnapshot, resetEvidence, safetyGuardChecks
      });
    }
    const reconnect = await this.invokeRequired("c2000_connectCores", fenced(context, { sessionId, coreIds: step.coreIds }));
    if (context.plan.safetyGuards) {
      retainGuardEvidence(safetyGuardChecks, await this.assertSafetyGuards(context, sessionId, "post-reset-reconnect"));
    }
    const symbols: Record<string, unknown>[] = [];
    for (const [coreId, programUri] of symbolPaths) {
      symbols.push(await this.invokeRequired("c2000_loadSymbols", fenced(context, { sessionId, coreId, programUri })));
    }
    const capture = await this.captureRequiredExpressions(context, sessionId, step.resetCauseReads, "reset-cause", "ResetCauseReadFailed");
    const run: Record<string, unknown>[] = [];
    let settleGuardPollIterations = 0;
    if (step.runAfterReconnect) {
      run.push(await this.invokeRequired("c2000_runCores", fenced(context, { sessionId, coreIds: [0] })));
      if (context.plan.safetyGuards) {
        retainGuardEvidence(safetyGuardChecks, await this.assertSafetyGuards(context, sessionId, "post-reconnect-cpu1-run"));
        const settleDeadline = Date.now() + step.runAfterReconnect.cpu1SettleMs;
        while (Date.now() < settleDeadline) {
          await abortableDelay(Math.min(context.plan.safetyGuards.intervalMs, Math.max(0, settleDeadline - Date.now())), context.signal);
          settleGuardPollIterations += 1;
          retainGuardEvidence(safetyGuardChecks, await this.assertSafetyGuards(context, sessionId, "reconnect-cpu1-settle-monitor"));
        }
      } else {
        await abortableDelay(step.runAfterReconnect.cpu1SettleMs, context.signal);
      }
      if (step.runAfterReconnect.runCpu2) {
        run.push(await this.invokeRequired("c2000_runCores", fenced(context, { sessionId, coreIds: [2] })));
        if (context.plan.safetyGuards) {
          retainGuardEvidence(safetyGuardChecks, await this.assertSafetyGuards(context, sessionId, "post-reconnect-cpu2-run"));
        }
      }
    }
    return { success: true, sessionId, resetObservation: observed, baselineSnapshot, baselineEvidence, pollIterations, reconnect, symbols, ...capture, run, settleGuardPollIterations, safetyGuardChecks };
  }

  private async restorePrograms(
    context: StepExecutionContext,
    sessionId: string,
    step: Extract<TestPlanStep, { type: "restorePrograms" }>
  ): Promise<Record<string, unknown>> {
    let artifacts: Array<{ coreId: 0 | 2; outPath: string; mapPath: string; outSha256: string; mapSha256: string }> | undefined;
    let initialHalt: Record<string, unknown> | undefined;
    let load: Record<string, unknown> | undefined;
    try {
      artifacts = await Promise.all([step.artifacts.cpu1, step.artifacts.cpu2].map(async artifact => {
        const outPath = await this.validateReadPath(artifact.outPath);
        const mapPath = await this.validateReadPath(artifact.mapPath);
        const [outSha256, mapSha256] = await Promise.all([sha256File(outPath), sha256File(mapPath)]);
        if (outSha256.toLowerCase() !== artifact.outSha256.toLowerCase() || mapSha256.toLowerCase() !== artifact.mapSha256.toLowerCase()) {
          throw new DebugMcpError("ArtifactHashMismatch", "Restore artifact hash does not match the explicit durable plan", {
            coreId: artifact.coreId, outPath, mapPath, expectedOutSha256: artifact.outSha256, actualOutSha256: outSha256,
            expectedMapSha256: artifact.mapSha256, actualMapSha256: mapSha256
          });
        }
        return { ...artifact, outPath, mapPath, outSha256, mapSha256 };
      }));
      initialHalt = await this.invokeConfirmedHalt(context, sessionId, [0, 2]);
      load = await this.invokeRequired("c2000_loadPrograms", fenced(context, {
        sessionId,
        programs: artifacts.map(artifact => ({
          coreId: artifact.coreId,
          programUri: artifact.outPath,
          mapUri: artifact.mapPath,
          ramOwnershipPolicy: "require-map",
          loadPolicy: "always",
          allowDestructiveFlashReload: step.allowDestructiveFlashReload
        }))
      }));
      verifyRestoredProgramResults(load, artifacts);
      const postLoadHashes = await Promise.all(artifacts.map(async artifact => ({
        coreId: artifact.coreId,
        outSha256: await sha256File(artifact.outPath),
        mapSha256: await sha256File(artifact.mapPath)
      })));
      for (const hashes of postLoadHashes) {
        const expected = artifacts.find(artifact => artifact.coreId === hashes.coreId)!;
        if (hashes.outSha256.toLowerCase() !== expected.outSha256.toLowerCase() || hashes.mapSha256.toLowerCase() !== expected.mapSha256.toLowerCase()) {
          throw new DebugMcpError("ArtifactHashMismatch", "Restore artifacts changed during the target load operation", { expected, actual: hashes });
        }
      }
      const finalHalt = await this.invokeConfirmedHalt(context, sessionId, [0, 2]);
      return { success: true, sessionId, verifiedArtifacts: artifacts, postLoadHashes, initialHalt, load, finalHalt, finalState: "Halted", ranCores: false, wroteProgramCounter: false };
    } catch (error) {
      let isolation: Record<string, unknown>;
      try {
        isolation = await this.invokeConfirmedHalt(context, sessionId, [0, 2]);
      } catch (isolationError) {
        isolation = { success: false, error: toStructuredError(isolationError) };
      }
      throw new DebugMcpError("RestoreProgramsFailed", "Program restore failed; fenced halt isolation was attempted and no core was run", {
        sessionId, initialHalt, load, isolation, cause: toStructuredError(error), preflightCompleted: Boolean(artifacts), ranCores: false, wroteProgramCounter: false
      });
    }
  }

  private async readResetEvidence(
    context: StepExecutionContext,
    sessionId: string,
    evidence: NonNullable<Extract<TestPlanStep, { type: "reconnectAfterTargetReset" }>["resetEvidence"]>,
    phase: "baseline" | "poll"
  ): Promise<Record<string, unknown>> {
    const reads = [...new Set(evidence.map(item => item.coreId))].map(coreId => ({
      coreId,
      expressions: [...new Set(evidence.filter(item => item.coreId === coreId).map(item => item.expression))]
    }));
    const captured = await this.captureRequiredExpressions(context, sessionId, reads, `reset-evidence-${phase}`, "ResetEvidenceReadFailed");
    return { phase, capturedAt: new Date().toISOString(), values: flattenCapturedValues(captured.expressionSnapshots) };
  }

  private async captureRequiredExpressions(
    context: StepExecutionContext,
    sessionId: string,
    reads: Array<{ label?: string; coreId: number; expressions: string[] }>,
    label: string,
    errorCode: "ResetEvidenceReadFailed" | "ResetCauseReadFailed"
  ): Promise<Record<string, unknown>> {
    let capture: Record<string, unknown>;
    try {
      capture = await this.captureExpressions(context, sessionId, reads, 1, 0, label);
    } catch (error) {
      throw new DebugMcpError(errorCode, `${label} requires every requested expression to be readable`, {
        sessionId, cause: toStructuredError(error)
      });
    }
    const failures = requiredCaptureFailures(capture.expressionSnapshots, reads);
    if (failures.length > 0) {
      throw new DebugMcpError(errorCode, `${label} requires every requested expression to be readable`, { sessionId, failures, capture });
    }
    return capture;
  }

  private async evaluateConditions(
    context: StepExecutionContext,
    sessionId: string,
    conditions: Array<{ label?: string; coreId: number; expression: string; operator?: "eq"; expected: string | number | boolean }>
  ): Promise<{ matched: boolean; conditions: Record<string, unknown>[] }> {
    const byCore = new Map<number, Record<string, unknown>[]>();
    for (const coreId of [...new Set(conditions.map(condition => condition.coreId))]) {
      const expressions = [...new Set(conditions.filter(condition => condition.coreId === coreId).map(condition => condition.expression))];
      const evaluated = await this.invokeRequired("c2000_evaluateMany", fenced(context, { sessionId, coreId, expressions }));
      byCore.set(coreId, Array.isArray(evaluated.results) ? evaluated.results.filter(isRecord) : []);
    }
    const results = conditions.map(condition => {
      const result = byCore.get(condition.coreId)?.find(item => item.expression === condition.expression);
      return {
        ...(condition.label ? { label: condition.label } : {}),
        coreId: condition.coreId,
        expression: condition.expression,
        operator: condition.operator ?? "eq",
        expected: condition.expected,
        matched: result?.success === true && valuesEqual(result.value, condition.expected),
        result
      };
    });
    return { matched: results.every(result => result.matched), conditions: results };
  }

  private async validateReadPath(candidate: string): Promise<string> {
    if (!this.filesystem) {
      throw new DebugMcpError("PathOutsideAllowedReadRoots", "Durable artifact access requires an explicit allowed-read-roots policy", { path: candidate, allowedRoots: [] });
    }
    return assertAllowedReadPath(candidate, this.filesystem);
  }

  /**
   * Verify caller-declared build hashes before creating a target session.
   * Hashes are optional for compatibility, but when supplied they turn the
   * durable launch into a reproducible fresh-artifact boundary instead of
   * discovering an old or swapped ELF only after target mutation.
   */
  private async preflightDeclaredArtifactHashes(artifacts: TestArtifacts | undefined): Promise<Record<string, unknown> | undefined> {
    if (!artifacts) return undefined;
    const declarations = [
      { coreId: 0, kind: "out", path: artifacts.cpu1OutPath, expected: artifacts.cpu1OutSha256 },
      { coreId: 2, kind: "out", path: artifacts.cpu2OutPath, expected: artifacts.cpu2OutSha256 },
      { coreId: 0, kind: "map", path: artifacts.cpu1MapPath, expected: artifacts.cpu1MapSha256 },
      { coreId: 2, kind: "map", path: artifacts.cpu2MapPath, expected: artifacts.cpu2MapSha256 }
    ];
    const missingDeclarations = declarations
      .filter(declaration => declaration.expected && !declaration.path)
      .map(declaration => `cpu${declaration.coreId === 0 ? 1 : 2}${declaration.kind === "out" ? "Out" : "Map"}Path`);
    if (missingDeclarations.length > 0) {
      throw new DebugMcpError("LaunchArtifactsMissing", "A durable launch hash declaration has no corresponding artifact path", {
        missingDeclarations
      });
    }
    const selected = declarations.filter((declaration): declaration is typeof declarations[number] & { path: string; expected: string } => Boolean(declaration.path && declaration.expected));
    if (selected.length === 0) return undefined;
    const verified = await Promise.all(selected.map(async declaration => {
      const resolvedPath = await this.validateReadPath(declaration.path);
      const actual = await sha256File(resolvedPath);
      if (actual.toLowerCase() !== declaration.expected.toLowerCase()) {
        throw new DebugMcpError("ArtifactHashMismatch", "Declared durable launch artifact hash does not match the host file", {
          coreId: declaration.coreId,
          kind: declaration.kind,
          path: resolvedPath,
          expectedSha256: declaration.expected,
          actualSha256: actual
        });
      }
      return { coreId: declaration.coreId, kind: declaration.kind, path: resolvedPath, sha256: actual };
    }));
    return { checked: true, mode: "declared-sha256", artifacts: verified };
  }

  private async captureExpressions(
    context: StepExecutionContext,
    sessionId: string,
    reads: Array<{ label?: string; coreId: number; expressions: string[] }>,
    sampleCount: number,
    intervalMs: number,
    label?: string
  ): Promise<Record<string, unknown>> {
    const expressionSnapshots: Record<string, unknown>[] = [];
    let capturedBytes = 0;
    for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
      context.signal?.throwIfAborted();
      const capturedAt = new Date().toISOString();
      const captures: Record<string, unknown>[] = [];
      for (const read of reads) {
        const evaluated = await this.invokeRequired("c2000_evaluateMany", fenced(context, {
          sessionId,
          coreId: read.coreId,
          expressions: read.expressions
        }));
        const capture = { ...(read.label ? { label: read.label } : {}), coreId: read.coreId, expressions: read.expressions, evaluated };
        capturedBytes += jsonSize(capture);
        if (capturedBytes > DURABLE_PLAN_LIMITS.maxStepOutputBytes) {
          throw new DebugMcpError("EvidenceLimitExceeded", "Expression capture exceeded the durable step output limit", {
            capturedBytes,
            maxStepOutputBytes: DURABLE_PLAN_LIMITS.maxStepOutputBytes,
            sampleIndex,
            coreId: read.coreId
          });
        }
        captures.push(capture);
      }
      const failures = captureFailuresForReads(captures, reads);
      if (failures.length > 0) {
        throw new DebugMcpError("ExpressionCaptureFailed", "Expression capture requires every requested expression to be readable", {
          sessionId,
          label,
          sampleIndex,
          failures,
          requestedExpressionCount: reads.reduce((total, read) => total + read.expressions.length, 0)
        });
      }
      expressionSnapshots.push({ ...(label ? { label } : {}), sampleIndex, capturedAt, captures });
      if (sampleIndex + 1 < sampleCount) await abortableDelay(intervalMs, context.signal);
    }
    return { success: true, sessionId, expressionSnapshots };
  }

  private async invokeRequired(toolName: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const result = await this.tools.invokeTool(toolName, input);
    if (result.success === false) {
      throw new DebugMcpError("BatchOperationFailed", `${toolName} failed during durable step execution`, { toolName, result });
    }
    return result;
  }

  private async invokeConfirmedHalt(context: StepExecutionContext, sessionId: string, coreIds: readonly number[]): Promise<Record<string, unknown>> {
    const halt = await this.invokeRequired("c2000_haltCores", fenced(context, { sessionId, coreIds: [...coreIds] }));
    const results = Array.isArray(halt.results) ? halt.results.filter(isRecord) : [];
    const unconfirmedCoreIds = coreIds.filter(coreId => !results.some(result => result.coreId === coreId && result.success === true));
    if (unconfirmedCoreIds.length > 0) {
      throw new DebugMcpError("TargetHaltFailed", "Fenced halt did not confirm every requested core", { sessionId, coreIds, unconfirmedCoreIds, halt });
    }
    return halt;
  }
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise(resolve => setTimeout(resolve, ms));
  signal.throwIfAborted();
  const activeSignal = signal;
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, ms);
    const abort = () => {
      clearTimeout(timer);
      activeSignal.removeEventListener("abort", abort);
      reject(activeSignal.reason ?? new DOMException("Operation aborted", "AbortError"));
    };
    function done() {
      activeSignal.removeEventListener("abort", abort);
      resolve();
    }
    activeSignal.addEventListener("abort", abort, { once: true });
  });
}

function fenced<T extends Record<string, unknown>>(context: StepExecutionContext, input: T): T & { __leaseContext?: BoardLeaseContext } {
  return { ...input, ...(context.leaseContext ? { __leaseContext: context.leaseContext } : {}) };
}

function requiredSession<T extends Record<string, unknown>>(input: T): T {
  if (typeof input.sessionId !== "string") throw new Error("Job step requires a board session");
  return input;
}

function requiredSessionId(sessionId: string | undefined): string {
  if (!sessionId) throw new DebugMcpError("SessionNotFound", "Durable job step requires the session created by the current board flow");
  return sessionId;
}

function programForCore(artifacts: ReturnType<typeof resolveArtifactsForBoard>, coreId: number): string {
  const program = coreId === 0 ? artifacts?.cpu1OutPath : coreId === 2 ? artifacts?.cpu2OutPath : undefined;
  if (!program) throw new DebugMcpError("LaunchProgramMissing", "Reset/reconnect reload requires an explicit artifact for every requested core", { coreId });
  return program;
}

function mapForCore(artifacts: ReturnType<typeof resolveArtifactsForBoard>, coreId: number): string | undefined {
  return coreId === 0 ? artifacts?.cpu1MapPath : coreId === 2 ? artifacts?.cpu2MapPath : undefined;
}

function jsonSize(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    throw new DebugMcpError("EvidenceSerializationFailed", "Expression capture result is not JSON serializable");
  }
}

function snapshotDisconnectedCoreIds(snapshot: Record<string, unknown>, expectedCoreIds: readonly number[]): number[] {
  const cores = Array.isArray(snapshot.cores) ? snapshot.cores.filter(isRecord) : [];
  return expectedCoreIds.filter(coreId => {
    const core = cores.find(candidate => candidate.coreId === coreId);
    return core?.connected === false || core?.state === "Disconnected";
  });
}

function assertReconnectCoreScope(step: Extract<TestPlanStep, { type: "reconnectAfterTargetReset" }>): void {
  const coreIds = new Set<number>(step.coreIds);
  const invalidEvidence = (step.resetEvidence ?? []).filter(evidence => !coreIds.has(evidence.coreId));
  const invalidReads = step.resetCauseReads.filter(read => !coreIds.has(read.coreId));
  const invalidRunCoreIds = step.runAfterReconnect
    ? [0, ...(step.runAfterReconnect.runCpu2 ? [2] : [])].filter(coreId => !coreIds.has(coreId))
    : [];
  if (invalidEvidence.length > 0 || invalidReads.length > 0 || invalidRunCoreIds.length > 0) {
    throw new DebugMcpError("ResetCoreScopeInvalid", "Reset evidence, cause reads, and post-reconnect runs must stay within reconnectAfterTargetReset.coreIds", {
      coreIds: step.coreIds,
      invalidEvidence,
      invalidReads,
      invalidRunCoreIds
    });
  }
}

function snapshotUnreadableCoreIds(snapshot: Record<string, unknown>, expectedCoreIds: readonly number[]): number[] {
  const cores = Array.isArray(snapshot.cores) ? snapshot.cores.filter(isRecord) : [];
  return expectedCoreIds.filter(coreId => {
    const core = cores.find(candidate => candidate.coreId === coreId);
    return !core || core.connected !== true;
  });
}

function assertConnectedSnapshotBaseline(snapshot: Record<string, unknown>, expectedCoreIds: readonly number[]): void {
  const cores = Array.isArray(snapshot.cores) ? snapshot.cores.filter(isRecord) : [];
  const invalidCoreIds = expectedCoreIds.filter(coreId => {
    const core = cores.find(candidate => candidate.coreId === coreId);
    return !core || core.connected !== true || core.state === "Disconnected";
  });
  if (invalidCoreIds.length > 0) {
    throw new DebugMcpError("TargetResetBaselineInvalid", "Reset observation requires a connected, readable baseline for every requested core", {
      expectedCoreIds, invalidCoreIds, snapshot
    });
  }
}

function isTargetReadInaccessible(error: unknown): boolean {
  const inaccessibleCodes = new Set(["CoreNotConnected", "SessionClosed", "PersistentChannelDisconnected"]);
  const visit = (value: unknown): boolean => {
    if (!isRecord(value)) return false;
    if (typeof value.code === "string" && inaccessibleCodes.has(value.code)) return true;
    return Object.values(value).some(visit);
  };
  return visit(toStructuredError(error));
}

function requiredCaptureFailures(
  snapshots: unknown,
  reads: Array<{ coreId: number; expressions: string[] }>
): Record<string, unknown>[] {
  const snapshot = Array.isArray(snapshots) && isRecord(snapshots[0]) ? snapshots[0] : undefined;
  const captures = snapshot && Array.isArray(snapshot.captures) ? snapshot.captures.filter(isRecord) : [];
  return captureFailuresForReads(captures, reads);
}

function captureFailuresForReads(
  captures: Array<Record<string, unknown>>,
  reads: Array<{ coreId: number; expressions: string[] }>
): Record<string, unknown>[] {
  const failures: Record<string, unknown>[] = [];
  for (const [readIndex, read] of reads.entries()) {
    const capture = captures[readIndex];
    const evaluated = capture && isRecord(capture.evaluated) ? capture.evaluated : undefined;
    const results = evaluated && Array.isArray(evaluated.results) ? evaluated.results.filter(isRecord) : [];
    for (const expression of read.expressions) {
      const result = results.find(candidate => candidate.expression === expression);
      if (!result || result.success !== true || !Object.prototype.hasOwnProperty.call(result, "value")) {
        failures.push({ coreId: read.coreId, expression, result });
      }
    }
  }
  return failures;
}

function flattenCapturedValues(snapshots: unknown): Record<string, unknown>[] {
  const snapshot = Array.isArray(snapshots) && isRecord(snapshots[0]) ? snapshots[0] : undefined;
  const captures = snapshot && Array.isArray(snapshot.captures) ? snapshot.captures.filter(isRecord) : [];
  return captures.flatMap(capture => {
    const evaluated = isRecord(capture.evaluated) ? capture.evaluated : undefined;
    const results = evaluated && Array.isArray(evaluated.results) ? evaluated.results.filter(isRecord) : [];
    return results.map(result => ({ coreId: capture.coreId, expression: result.expression, value: result.value }));
  });
}

function compareFreshResetEvidence(
  evidence: NonNullable<Extract<TestPlanStep, { type: "reconnectAfterTargetReset" }>["resetEvidence"]>,
  baseline: Record<string, unknown>,
  current: Record<string, unknown>
): Record<string, unknown> {
  const baselineValues = Array.isArray(baseline.values) ? baseline.values.filter(isRecord) : [];
  const currentValues = Array.isArray(current.values) ? current.values.filter(isRecord) : [];
  const conditions = evidence.map(item => {
    const baselineValue = baselineValues.find(value => value.coreId === item.coreId && value.expression === item.expression)?.value;
    const currentValue = currentValues.find(value => value.coreId === item.coreId && value.expression === item.expression)?.value;
    let matched = false;
    if (item.freshness === "transition-to-expected") {
      matched = !valuesEqual(baselineValue, item.expected) && valuesEqual(currentValue, item.expected);
    } else if (item.freshness === "monotonic-increase") {
      matched = typeof baselineValue === "number" && typeof currentValue === "number" && currentValue >= baselineValue + item.minimumDelta;
    } else {
      matched = !valuesEqual(currentValue, baselineValue);
    }
    return { ...item, baselineValue, currentValue, matched };
  });
  return { matched: conditions.every(condition => condition.matched), conditions };
}

function verifyRestoredProgramResults(
  load: Record<string, unknown>,
  artifacts: Array<{ coreId: 0 | 2; outSha256: string }>
): void {
  const results = Array.isArray(load.results) ? load.results.filter(isRecord) : [];
  for (const artifact of artifacts) {
    const result = results.find(candidate => candidate.coreId === artifact.coreId);
    if (!result || result.success !== true || result.loaded !== true || typeof result.sha256 !== "string" || result.sha256.toLowerCase() !== artifact.outSha256.toLowerCase()) {
      throw new DebugMcpError("ArtifactHashMismatch", "Loaded program evidence did not confirm the requested core and SHA-256", {
        coreId: artifact.coreId,
        expectedOutSha256: artifact.outSha256,
        result
      });
    }
  }
}

function retainGuardEvidence(target: Record<string, unknown>[], evidence: Record<string, unknown>): void {
  if (target.length < DURABLE_PLAN_LIMITS.maxGuardEvidenceSnapshots) target.push(evidence);
  else target[target.length - 1] = evidence;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
