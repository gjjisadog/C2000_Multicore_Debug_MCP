import type { C2000ToolInvoker } from "../mcp/tools.js";
import { DURABLE_PLAN_LIMITS, resolveArtifactsForBoard, type TestPlan, type TestPlanStep } from "./TestPlanSchema.js";
import type { CanAcceptanceService } from "../can/CanAcceptanceService.js";
import type { BoardLeaseContext } from "../boards/types.js";
import { DebugMcpError } from "../utils/errors.js";

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
  constructor(private readonly tools: C2000ToolInvoker, private readonly canAcceptance?: CanAcceptanceService) {}

  async execute(context: StepExecutionContext): Promise<Record<string, unknown>> {
    const { plan, step, boardId, sessionId } = context;
    context.signal?.throwIfAborted();
    const artifacts = resolveArtifactsForBoard(plan, boardId);
    switch (step.type) {
      case "delay":
        await abortableDelay(step.delayMs ?? 0, context.signal);
        return { delayedMs: step.delayMs ?? 0 };
      case "canAcceptance":
        if (!this.canAcceptance) throw new Error("CAN acceptance is unavailable in this runtime");
        return this.canAcceptance.execute(context);
      case "preflight":
        return this.tools.invokeTool("c2000_getHardwarePreflight", {});
      case "launchMulticore":
        const loadPrograms = step.loadPrograms;
        return this.tools.invokeTool("c2000_launchMulticoreDebug", fenced(context, {
          boardId,
          sessionName: `${plan.name}-${boardId}`,
          loadPrograms,
          loadSequence: step.loadSequence,
          cores: [
            {
              coreId: 0, coreName: "C28xx_CPU1", corePattern: "C28xx_CPU1",
              ...(loadPrograms && artifacts?.cpu1OutPath ? { programUri: artifacts.cpu1OutPath, mapUri: artifacts.cpu1MapPath } : {}),
              connect: true, load: loadPrograms && Boolean(artifacts?.cpu1OutPath), haltAtEntry: true
            },
            {
              coreId: 2, coreName: "C28xx_CPU2", corePattern: "C28xx_CPU2",
              ...(loadPrograms && artifacts?.cpu2OutPath ? { programUri: artifacts.cpu2OutPath, mapUri: artifacts.cpu2MapPath } : {}),
              connect: true, load: loadPrograms && Boolean(artifacts?.cpu2OutPath), haltAtEntry: true
            }
          ]
        }));
      case "assignExpressions":
        return this.tools.invokeTool("c2000_assignExpressions", fenced(context, requiredSession({ sessionId, assignments: step.assignments })));
      case "injectFaults":
        return this.tools.invokeTool("c2000_injectFaults", fenced(context, requiredSession({ sessionId, faults: step.faults })));
      case "captureExpressions":
        return this.captureExpressions(context, requiredSessionId(sessionId), step.reads, step.sampleCount, step.intervalMs, step.label);
      case "waitForExpressions":
        return this.tools.invokeTool("c2000_waitForExpressionSet", fenced(context, requiredSession({
          sessionId,
          conditions: step.conditions,
          timeoutMs: step.timeoutMs,
          intervalMs: step.intervalMs
        })));
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
              loadPolicy: step.loadPolicy
            }))
          })));
        }
        const capture = await this.captureExpressions(context, activeSessionId, step.reads, 1, 0, "post-reset-reconnect");
        return { success: true, sessionId: activeSessionId, reset, reconnect, reloadMode: step.reload, reload, ...capture };
      }
      case "runIpcAcceptance":
        return this.tools.invokeTool("c2000_runIpcAcceptance", fenced(context, requiredSession({
          sessionId, device: "F28P65x", cpu1CoreId: 0, cpu2CoreId: 2,
          cpu1OutPath: artifacts?.cpu1OutPath, cpu2OutPath: artifacts?.cpu2OutPath,
          cpu1MapPath: artifacts?.cpu1MapPath, cpu2MapPath: artifacts?.cpu2MapPath,
          resetType: "cpu",
          loadPolicy: (step as Record<string, unknown>).loadPolicy,
          loadSequence: (step as Record<string, unknown>).loadSequence,
          ipcReadyExpressions: (step as Record<string, unknown>).ipcReadyExpressions,
          runSequence: { runCpu1First: true, runCpu2: true, settleMs: 0 },
          timeoutMs: step.timeoutMs ?? 10000, intervalMs: step.intervalMs ?? 100,
          verifyRuntimeRamOwnership: Boolean((step as Record<string, unknown>).verifyRuntimeRamOwnership),
          collectDebugBundle: plan.failurePolicy.collectDebugBundle,
          outputDir: artifacts?.outputDir
        })));
      case "runBootHandoffDiagnosis":
        return this.tools.invokeTool("c2000_runBootHandoffDiagnosis", fenced(context, requiredSession({ sessionId, device: "F28P65x", cpu1CoreId: 0, cpu2CoreId: 2, cpu1OutPath: artifacts?.cpu1OutPath, cpu2OutPath: artifacts?.cpu2OutPath, cpu1MapPath: artifacts?.cpu1MapPath, cpu2MapPath: artifacts?.cpu2MapPath, verifyRuntimeRamOwnership: false, outputDir: artifacts?.outputDir })));
      case "runReloadAndDiagnose":
        return this.tools.invokeTool("c2000_runReloadAndDiagnose", fenced(context, requiredSession({ sessionId, device: "F28P65x", cpu1CoreId: 0, cpu2CoreId: 2, cpu1OutPath: artifacts?.cpu1OutPath, cpu2OutPath: artifacts?.cpu2OutPath, cpu1MapPath: artifacts?.cpu1MapPath, cpu2MapPath: artifacts?.cpu2MapPath, resetType: "cpu", runCpu1: true, runCpu2: false, timeoutMs: step.timeoutMs, intervalMs: step.intervalMs ?? 100, collectDebugBundle: plan.failurePolicy.collectDebugBundle, outputDir: artifacts?.outputDir })));
      case "runFullDebugBundle":
        return this.tools.invokeTool("c2000_runFullDebugBundle", fenced(context, requiredSession({ sessionId, device: "F28P65x", cpu1CoreId: 0, cpu2CoreId: 2, cpu1OutPath: artifacts?.cpu1OutPath, cpu2OutPath: artifacts?.cpu2OutPath, cpu1MapPath: artifacts?.cpu1MapPath, cpu2MapPath: artifacts?.cpu2MapPath, outputDir: artifacts?.outputDir })));
      case "cleanup":
        return sessionId ? this.tools.invokeTool("c2000_closeDebugSession", fenced(context, { sessionId })) : { success: true, skipped: true };
    }
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
