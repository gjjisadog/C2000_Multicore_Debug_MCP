import { DebugMcpError, toStructuredError, type StructuredError } from "../utils/errors.js";
import type { Logger } from "../utils/logger.js";

export type StartupStageStatus = "completed" | "failed";

export interface StartupStageRecord {
  stage: string;
  status: StartupStageStatus;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  targetAccessAttempted: boolean;
  error?: StructuredError;
}

export interface StartupDiagnostics {
  schemaVersion: 1;
  targetAccessAttempted: boolean;
  stages: StartupStageRecord[];
}

export interface StartupStageOptions {
  /** True only when the stage may issue a command to a target core. */
  targetAccessAttempted?: boolean;
}

export type StartupStageRunner = <T>(
  stage: string,
  work: () => Promise<T>,
  options?: StartupStageOptions
) => Promise<T>;

/** Create a mutable, JSON-safe startup trace for one create-session attempt. */
export function createStartupDiagnostics(): StartupDiagnostics {
  return {
    schemaVersion: 1,
    targetAccessAttempted: false,
    stages: []
  };
}

/**
 * Run one startup stage and retain timing/error evidence. The runner does not
 * retry or hide failures; it only adds the stage context to structured MCP
 * errors so the caller can distinguish probe, DSS, and core-state failures.
 */
export function createStartupStageRunner(
  diagnostics: StartupDiagnostics,
  logger?: Pick<Logger, "debug" | "info" | "warn">
): StartupStageRunner {
  return async <T>(stage: string, work: () => Promise<T>, options: StartupStageOptions = {}): Promise<T> => {
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    const targetAccessAttempted = options.targetAccessAttempted === true;
    if (targetAccessAttempted) diagnostics.targetAccessAttempted = true;
    logger?.debug("debug startup stage started", { stage, targetAccessAttempted });
    try {
      const result = await work();
      const finishedAtMs = Date.now();
      diagnostics.stages.push({
        stage,
        status: "completed",
        startedAt,
        finishedAt: new Date(finishedAtMs).toISOString(),
        durationMs: Math.max(0, finishedAtMs - startedAtMs),
        targetAccessAttempted
      });
      logger?.debug("debug startup stage completed", { stage, durationMs: Math.max(0, finishedAtMs - startedAtMs), targetAccessAttempted });
      return result;
    } catch (error) {
      const finishedAtMs = Date.now();
      const structured = withoutStartupContext(toStructuredError(error));
      diagnostics.stages.push({
        stage,
        status: "failed",
        startedAt,
        finishedAt: new Date(finishedAtMs).toISOString(),
        durationMs: Math.max(0, finishedAtMs - startedAtMs),
        targetAccessAttempted,
        error: structured
      });
      logger?.warn("debug startup stage failed", { stage, durationMs: Math.max(0, finishedAtMs - startedAtMs), targetAccessAttempted, error: structured });
      if (error instanceof DebugMcpError) {
        throw new DebugMcpError(error.code, error.message, {
          ...stripStartupContextDetails(error.details),
          startupStage: stage,
          startupDiagnostics: diagnostics
        });
      }
      throw new DebugMcpError("StartupStageFailed", `Debug startup stage failed: ${stage}`, {
        startupStage: stage,
        startupDiagnostics: diagnostics,
        cause: structured
      });
    }
  };
}

/**
 * Nested stages reuse the same diagnostics object. Strip an earlier stage's
 * trace before storing or wrapping the error so the trace remains JSON-safe
 * and cannot contain a self-referential diagnostics object.
 */
function withoutStartupContext(error: StructuredError): StructuredError {
  return {
    ...error,
    ...(error.details ? { details: stripStartupContextDetails(error.details) } : {})
  };
}

function stripStartupContextDetails(details: Record<string, unknown>): Record<string, unknown> {
  const { startupStage: _startupStage, startupDiagnostics: _startupDiagnostics, ...safeDetails } = details;
  return safeDetails;
}
