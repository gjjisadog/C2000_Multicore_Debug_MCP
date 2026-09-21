import path from "node:path";
import type { C2000McpConfig } from "../config/config.schema.js";
import { resolveDaemonConfig } from "../daemon/DaemonConfig.js";
import { daemonRuntimePaths, isDaemonProcessAlive, readDaemonAuthToken, readDaemonInstance, removeDaemonInstance, type DebugDaemonInstance } from "../daemon/DaemonInstanceFile.js";
import { LocalRpcClient } from "../rpc/RpcServer.js";
import { DebugMcpError } from "../utils/errors.js";
import { compareRuntimeContract, type RuntimeContractCompatibility } from "../contracts/RuntimeContract.js";
import { compareRuntimeBuildIdentity, type RuntimeBuildCompatibility } from "../contracts/RuntimeIdentity.js";
import { isDevelopmentMode, runtimeBuildIdentity } from "../runtimeInfo.js";

export interface DaemonCompatibility {
  compatible: boolean;
  contract: RuntimeContractCompatibility;
  runtime: RuntimeBuildCompatibility;
  mismatches: string[];
}

export interface DiscoveredDaemon {
  instance: DebugDaemonInstance;
  client: LocalRpcClient;
  health: Record<string, unknown>;
  compatibility: DaemonCompatibility;
}

export interface DaemonDiscoveryOptions {
  /** Return an authenticated but incompatible daemon for development maintenance. */
  allowIncompatible?: boolean;
  developmentMode?: boolean;
}

/**
 * Discovers, authenticates, and health-checks a daemon without deciding whether
 * its build may be reused. This deliberately preserves the client/context for a
 * live incompatible daemon so development maintenance can shut down that exact
 * authenticated owner.
 */
export async function discoverDaemonInstance(
  config: C2000McpConfig,
  options: Pick<DaemonDiscoveryOptions, "developmentMode"> = {}
): Promise<DiscoveredDaemon> {
  const daemon = resolveDaemonConfig(config);
  const paths = daemonRuntimePaths(daemon.runtimeDir);
  const instance = await readDaemonInstance(paths);
  if (!instance) {
    throw new DebugMcpError("DaemonUnavailable", "c2000-debugd instance file is missing, stale, or invalid", {
      instanceFile: paths.instanceFile
    });
  }
  if (!isDaemonProcessAlive(instance.pid)) {
    await removeDaemonInstance(paths, instance.instanceId);
    throw new DebugMcpError("DaemonUnavailable", "c2000-debugd instance PID is no longer running", {
      instanceId: instance.instanceId,
      pid: instance.pid
    });
  }
  const authToken = await readDaemonAuthToken(instance);
  if (!authToken) {
    await removeInstanceIfProcessStopped(paths, instance);
    throw new DebugMcpError("DaemonUnavailable", "c2000-debugd authentication token is unavailable", {
      instanceId: instance.instanceId,
      authTokenFile: instance.authTokenFile,
      metadataPreserved: isDaemonProcessAlive(instance.pid)
    });
  }
  const requestTimeoutMs = positiveInteger(process.env.C2000_MCP_REQUEST_TIMEOUT_MS, 600_000);
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
      await removeInstanceIfProcessStopped(paths, instance);
      throw new DebugMcpError("DaemonInstanceInvalid", "c2000-debugd instance file does not match the running daemon", {
        expectedInstanceId: instance.instanceId,
        reportedInstanceId: reportedId,
        metadataPreserved: isDaemonProcessAlive(instance.pid)
      });
    }
    return {
      instance,
      client,
      health,
      compatibility: validateDaemonCompatibility(instance, health, {
        developmentMode: options.developmentMode
      })
    };
  } catch (error) {
    // A health timeout or transient connection refusal is not proof that the
    // owner is dead. Keep the instance metadata while its PID is alive so
    // concurrent frontends can wait for the same daemon instead of racing to
    // start another one.
    await removeInstanceIfProcessStopped(paths, instance);
    if (error instanceof DebugMcpError) throw error;
    throw new DebugMcpError("DaemonUnavailable", "c2000-debugd did not answer its health check", {
      instanceId: instance.instanceId,
      host: instance.host,
      port: instance.port,
      metadataPreserved: isDaemonProcessAlive(instance.pid)
    });
  }
}

/** Strict discovery used by release runtimes and by callers that do not opt into maintenance. */
export async function discoverDaemon(
  config: C2000McpConfig,
  options: DaemonDiscoveryOptions = {}
): Promise<DiscoveredDaemon> {
  const discovered = await discoverDaemonInstance(config, {
    developmentMode: options.developmentMode
  });
  if (!discovered.compatibility.compatible && !options.allowIncompatible) {
    throw daemonCompatibilityError(discovered);
  }
  return discovered;
}

export function validateDaemonCompatibility(
  instance: DebugDaemonInstance,
  health: Record<string, unknown>,
  options: { developmentMode?: boolean } = {}
): DaemonCompatibility {
  const contract = compareRuntimeContract(health.contracts ?? instance.contract);
  const runtime = compareRuntimeBuildIdentity(
    runtimeBuildIdentity(),
    daemonRuntimeIdentity(instance, health),
    { development: options.developmentMode ?? isDevelopmentMode() }
  );
  const mismatches = [
    ...contract.mismatches.map(field => `contract.${field}`),
    ...runtime.mismatches.map(field => `runtime.${field}`)
  ];
  return {
    compatible: mismatches.length === 0,
    contract,
    runtime,
    mismatches
  };
}

export function daemonCompatibilityError(discovered: DiscoveredDaemon): DebugMcpError {
  return new DebugMcpError(
    "DaemonContractMismatch",
    "c2000-debugd is running with an incompatible MCP frontend/daemon contract or runtime build; complete safe daemon maintenance before submitting a test plan",
    {
      instanceId: discovered.instance.instanceId,
      daemonVersion: discovered.instance.version,
      daemonPid: discovered.instance.pid,
      runtimeDir: path.dirname(discovered.instance.authTokenFile),
      mismatches: discovered.compatibility.mismatches,
      expectedContract: discovered.compatibility.contract.expected,
      actualContract: discovered.compatibility.contract.actual ?? null,
      expectedRuntimeIdentity: discovered.compatibility.runtime.expected,
      actualRuntimeIdentity: discovered.compatibility.runtime.actual ?? null,
      mismatchedContractFields: discovered.compatibility.contract.mismatches,
      mismatchedRuntimeFields: discovered.compatibility.runtime.mismatches,
      targetAccessAttempted: false
    }
  );
}

function daemonRuntimeIdentity(instance: DebugDaemonInstance, health: Record<string, unknown>): unknown {
  const healthIdentity = asRecordOrEmpty(health.runtimeIdentity);
  if (Object.keys(healthIdentity).length > 0) return healthIdentity;
  const runtime = asRecordOrEmpty(health.runtime);
  const runtimeIdentity = asRecordOrEmpty(runtime.identity);
  if (Object.keys(runtimeIdentity).length > 0) return runtimeIdentity;
  const instanceIdentity = asRecordOrEmpty(instance.runtimeIdentity);
  return {
    ...instanceIdentity,
    version: instanceIdentity.version ?? instance.version
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DebugMcpError("DaemonProtocolError", "c2000-debugd returned a malformed response");
  }
  return value as Record<string, unknown>;
}

function asRecordOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? NaN : Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function removeInstanceIfProcessStopped(
  paths: ReturnType<typeof daemonRuntimePaths>,
  instance: DebugDaemonInstance
): Promise<void> {
  if (!isDaemonProcessAlive(instance.pid)) {
    await removeDaemonInstance(paths, instance.instanceId);
  }
}
