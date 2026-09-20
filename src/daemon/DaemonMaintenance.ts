import { access } from "node:fs/promises";
import type { C2000McpConfig } from "../config/config.schema.js";
import { daemonRuntimePaths, isDaemonProcessAlive, readDaemonInstance, type DebugDaemonInstance } from "./DaemonInstanceFile.js";
import { resolveDaemonConfig } from "./DaemonConfig.js";
import { DebugMcpError } from "../utils/errors.js";
import { discoverDaemon, type DiscoveredDaemon } from "../proxy/DaemonDiscovery.js";

export interface DaemonMaintenanceOptions {
  launch: () => Promise<void>;
  rediscover?: () => Promise<DiscoveredDaemon>;
  timeoutMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  isProcessAlive?: (pid: number) => boolean;
  readInstance?: (runtimeDir: string) => Promise<DebugDaemonInstance | undefined>;
  isLockHeld?: (lockFile: string) => Promise<boolean>;
}

/**
 * Gracefully replaces only the authenticated daemon returned by discovery.
 * This is intentionally a development-only orchestration primitive: it never
 * sends taskkill/kill -9 and never guesses which external process to terminate.
 */
export async function restartOwnedDaemon(
  config: C2000McpConfig,
  discovered: DiscoveredDaemon,
  options: DaemonMaintenanceOptions
): Promise<DiscoveredDaemon> {
  const daemon = resolveDaemonConfig(config);
  const paths = daemonRuntimePaths(daemon.runtimeDir);
  const timeoutMs = options.timeoutMs ?? maintenanceTimeoutMs(daemon.startupTimeoutMs);
  const sleep = options.sleep ?? delay;
  const isProcessAlive = options.isProcessAlive ?? isDaemonProcessAlive;
  const readInstance = options.readInstance ?? (runtimeDir => readDaemonInstance(daemonRuntimePaths(runtimeDir)));
  const isLockHeld = options.isLockHeld ?? pathExists;
  const oldInstance = discovered.instance;

  const current = await readInstance(paths.runtimeDir);
  if (!sameDaemon(current, oldInstance)) {
    throw maintenanceRequired(oldInstance, paths.runtimeDir, discovered, "ownership-check", {
      reason: "The authenticated daemon instance changed before shutdown; no process was terminated."
    });
  }

  try {
    await discovered.client.request("shutdown", {});
  } catch (error) {
    throw maintenanceRequired(oldInstance, paths.runtimeDir, discovered, "shutdown", {
      reason: "Authenticated shutdown RPC failed; the daemon was not force-terminated.",
      cause: error instanceof Error ? error.message : String(error)
    });
  }

  const stopped = await waitForDaemonStopped({
    oldInstance,
    runtimeDir: paths.runtimeDir,
    lockFile: paths.lockFile,
    deadline: Date.now() + timeoutMs,
    sleep,
    isProcessAlive,
    readInstance,
    isLockHeld
  });
  if (!stopped) {
    throw maintenanceRequired(oldInstance, paths.runtimeDir, discovered, "wait-for-stop", {
      reason: "The daemon did not release its PID, instance metadata, and singleton lock before the maintenance timeout.",
      timeoutMs
    });
  }

  try {
    await options.launch();
  } catch (error) {
    throw maintenanceRequired(oldInstance, paths.runtimeDir, discovered, "launch", {
      reason: "The old daemon stopped, but the current daemon could not be launched.",
      cause: error instanceof Error ? error.message : String(error)
    });
  }

  const rediscover = options.rediscover ?? (() => discoverDaemon(config));
  const reconnectDeadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < reconnectDeadline) {
    try {
      const replacement = await rediscover();
      if (replacement.compatibility.compatible) return replacement;
      lastError = new DebugMcpError("DaemonContractMismatch", "The replacement daemon is still incompatible", {
        mismatches: replacement.compatibility.mismatches
      });
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  throw maintenanceRequired(oldInstance, paths.runtimeDir, discovered, "reconnect", {
    reason: "The replacement daemon did not become compatible before the maintenance timeout.",
    timeoutMs,
    cause: lastError instanceof Error ? lastError.message : String(lastError ?? "unknown")
  });
}

async function waitForDaemonStopped(options: {
  oldInstance: DebugDaemonInstance;
  runtimeDir: string;
  lockFile: string;
  deadline: number;
  sleep: (milliseconds: number) => Promise<void>;
  isProcessAlive: (pid: number) => boolean;
  readInstance: (runtimeDir: string) => Promise<DebugDaemonInstance | undefined>;
  isLockHeld: (lockFile: string) => Promise<boolean>;
}): Promise<boolean> {
  while (Date.now() < options.deadline) {
    const current = await options.readInstance(options.runtimeDir);
    const instanceChanged = !current || current.instanceId !== options.oldInstance.instanceId || current.pid !== options.oldInstance.pid;
    const processStopped = !options.isProcessAlive(options.oldInstance.pid);
    const lockReleased = !(await options.isLockHeld(options.lockFile));
    if (processStopped && instanceChanged && lockReleased) return true;
    await options.sleep(100);
  }
  return false;
}

function maintenanceRequired(
  oldInstance: DebugDaemonInstance,
  runtimeDir: string,
  discovered: DiscoveredDaemon,
  phase: string,
  details: Record<string, unknown>
): DebugMcpError {
  return new DebugMcpError(
    "DaemonMaintenanceRequired",
    "Development daemon maintenance could not complete safely; manual daemon maintenance is required",
    {
      oldPid: oldInstance.pid,
      instanceId: oldInstance.instanceId,
      runtimeDir,
      mismatchReasons: discovered.compatibility.mismatches,
      phase,
      ...details
    }
  );
}

function sameDaemon(left: DebugDaemonInstance | undefined, right: DebugDaemonInstance): boolean {
  return left?.instanceId === right.instanceId && left.pid === right.pid;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function maintenanceTimeoutMs(startupTimeoutMs: number): number {
  const configured = Number.parseInt(process.env.C2000_MCP_DAEMON_MAINTENANCE_TIMEOUT_MS ?? "", 10);
  return Number.isInteger(configured) && configured > 0
    ? configured
    : Math.max(5_000, startupTimeoutMs);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}
