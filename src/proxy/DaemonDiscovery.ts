import { rm } from "node:fs/promises";
import type { C2000McpConfig } from "../config/config.schema.js";
import { resolveDaemonConfig } from "../daemon/DaemonConfig.js";
import { daemonRuntimePaths, readDaemonAuthToken, readDaemonInstance, removeDaemonInstance, type DebugDaemonInstance } from "../daemon/DaemonInstanceFile.js";
import { LocalRpcClient } from "../rpc/RpcServer.js";
import { DebugMcpError } from "../utils/errors.js";

export interface DiscoveredDaemon {
  instance: DebugDaemonInstance;
  client: LocalRpcClient;
  health: Record<string, unknown>;
}

/**
 * Reads only the daemon's runtime files, proves the PID/endpoint identity, and
 * clears stale files. It never terminates a process discovered during probing.
 */
export async function discoverDaemon(config: C2000McpConfig): Promise<DiscoveredDaemon> {
  const daemon = resolveDaemonConfig(config);
  const paths = daemonRuntimePaths(daemon.runtimeDir);
  const instance = await readDaemonInstance(paths);
  if (!instance) {
    await rm(paths.instanceFile, { force: true }).catch(() => undefined);
    throw new DebugMcpError("DaemonUnavailable", "c2000-debugd instance file is missing, stale, or invalid", {
      instanceFile: paths.instanceFile
    });
  }
  if (!isPidAlive(instance.pid)) {
    await removeDaemonInstance(paths, instance.instanceId);
    throw new DebugMcpError("DaemonUnavailable", "c2000-debugd instance PID is no longer running", {
      instanceId: instance.instanceId,
      pid: instance.pid
    });
  }
  const authToken = await readDaemonAuthToken(instance);
  if (!authToken) {
    await removeDaemonInstance(paths, instance.instanceId);
    throw new DebugMcpError("DaemonUnavailable", "c2000-debugd authentication token is unavailable", {
      instanceId: instance.instanceId,
      authTokenFile: instance.authTokenFile
    });
  }
  const requestTimeoutMs = positiveInteger(
    process.env.C2000_MCP_REQUEST_TIMEOUT_MS,
    600_000
  );
  const client = new LocalRpcClient({
    host: "127.0.0.1",
    port: instance.port,
    authToken,
    timeoutMs: requestTimeoutMs
  });
  try {
    const health = asRecord(await client.request("health", {}, 5_000));
    const reportedId = asRecord(health.daemon).instanceId;
    if (reportedId !== instance.instanceId) {
      await removeDaemonInstance(paths, instance.instanceId);
      throw new DebugMcpError("DaemonInstanceInvalid", "c2000-debugd instance file does not match the running daemon", {
        expectedInstanceId: instance.instanceId,
        reportedInstanceId: reportedId
      });
    }
    return { instance, client, health };
  } catch (error) {
    await removeDaemonInstance(paths, instance.instanceId);
    if (error instanceof DebugMcpError) throw error;
    throw new DebugMcpError("DaemonUnavailable", "c2000-debugd did not answer its health check", {
      instanceId: instance.instanceId,
      host: instance.host,
      port: instance.port
    });
  }
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM proves a process exists even if this user is not allowed to signal it.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DebugMcpError("DaemonProtocolError", "c2000-debugd returned a malformed response");
  }
  return value as Record<string, unknown>;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? NaN : Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
