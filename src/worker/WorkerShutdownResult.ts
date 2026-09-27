export interface WorkerShutdownResult {
  closedSessionIds: string[];
  failures: Array<{ sessionId: string; error: { code: string; message: string; details?: Record<string, unknown> } }>;
}

export function isWorkerShutdownResult(value: unknown): value is WorkerShutdownResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Record<string, unknown>;
  const closedSessionIds = result.closedSessionIds;
  const failures = result.failures;
  return Array.isArray(closedSessionIds)
    && closedSessionIds.every(id => typeof id === "string")
    && Array.isArray(failures)
    && failures.every(failure => {
      if (!failure || typeof failure !== "object") return false;
      const item = failure as Record<string, unknown>;
      if (typeof item.sessionId !== "string" || !item.error || typeof item.error !== "object") return false;
      const error = item.error as Record<string, unknown>;
      return typeof error.code === "string" && typeof error.message === "string";
    })
    && failures.every(failure => !closedSessionIds.includes(failure.sessionId));
}
