import type { C2000ToolInvoker } from "../mcp/tools.js";
import { resolveArtifactsForBoard, type TestPlan, type TestPlanStep } from "./TestPlanSchema.js";
import type { CanAcceptanceService } from "../can/CanAcceptanceService.js";
import type { BoardLeaseContext } from "../boards/types.js";

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
        return this.tools.invokeTool("c2000_launchMulticoreDebug", fenced(context, {
          boardId,
          sessionName: `${plan.name}-${boardId}`,
          cores: [
            { coreId: 0, coreName: "C28xx_CPU1", corePattern: "C28xx_CPU1", programUri: artifacts?.cpu1OutPath, mapUri: artifacts?.cpu1MapPath, connect: true, load: Boolean(artifacts?.cpu1OutPath), haltAtEntry: true },
            { coreId: 2, coreName: "C28xx_CPU2", corePattern: "C28xx_CPU2", programUri: artifacts?.cpu2OutPath, mapUri: artifacts?.cpu2MapPath, connect: true, load: Boolean(artifacts?.cpu2OutPath), haltAtEntry: true }
          ]
        }));
      case "runIpcAcceptance":
        return this.tools.invokeTool("c2000_runIpcAcceptance", fenced(context, requiredSession({
          sessionId, device: "F28P65x", cpu1CoreId: 0, cpu2CoreId: 2,
          cpu1OutPath: artifacts?.cpu1OutPath, cpu2OutPath: artifacts?.cpu2OutPath,
          cpu1MapPath: artifacts?.cpu1MapPath, cpu2MapPath: artifacts?.cpu2MapPath,
          resetType: "cpu", runSequence: { runCpu1First: true, runCpu2: true, settleMs: 0 },
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
