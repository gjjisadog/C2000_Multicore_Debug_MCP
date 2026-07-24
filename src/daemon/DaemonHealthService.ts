import type { DebugDaemonInstance } from "./DaemonInstanceFile.js";
import type { DatabaseConsistencyReport } from "../storage/DatabaseConsistencyChecker.js";

export interface DaemonHealthSnapshot {
  instanceId: string;
  pid: number;
  startedAt: string;
  uptimeMs: number;
  databaseReady: boolean;
  schedulerReady: boolean;
}

export function createDaemonHealth(
  instance: DebugDaemonInstance | undefined,
  startedAtMs: number,
  databaseReady: boolean,
  workers = { total: 0, healthy: 0, unhealthy: 0 },
  jobs = { queued: 0, running: 0 },
  consistency: DatabaseConsistencyReport = { healthy: true, checkedAt: new Date().toISOString(), issues: [] }
): Record<string, unknown> {
  const daemon: DaemonHealthSnapshot = {
    instanceId: instance?.instanceId ?? "starting",
    pid: instance?.pid ?? process.pid,
    startedAt: instance?.startedAt ?? new Date(startedAtMs).toISOString(),
    uptimeMs: Math.max(0, Date.now() - startedAtMs),
    databaseReady,
    schedulerReady: true
  };
  return {
    daemon,
    workers,
    jobs,
    consistency
  };
}
