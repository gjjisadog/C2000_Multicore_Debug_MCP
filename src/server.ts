import { readFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CcsScriptingAdapter } from "./adapters/CcsScriptingAdapter.js";
import {
  resolveAdapterMode,
  resolveAdapterModeSync,
  type AdapterResolution,
  type ResolvedAdapterMode
} from "./adapters/adapterResolution.js";
import { MockDebugAdapter } from "./adapters/MockDebugAdapter.js";
import type { DebugAdapter } from "./adapters/types.js";
import type { C2000McpConfig } from "./config/config.schema.js";
import { DebugSessionManager } from "./debug/DebugSessionManager.js";
import { LoadedProgramRegistry } from "./debug/LoadedProgramRegistry.js";
import { DebugProbePoolCoordinator, FileDebugProbeCoordinator } from "./hardware/debugProbeCoordinator.js";
import { recoverDebugProbe, runHardwarePreflight } from "./hardware/preflight.js";
import {
  createC2000ToolInvoker,
  definitionsForProfile,
  getToolContracts,
  getToolSurfaceGuide,
  registerC2000Tools,
  type C2000ToolInvoker
} from "./mcp/tools.js";
import type { ToolHandlerDeps } from "./mcp/toolHandlers.js";
import { buildServerHealth, SERVER_NAME, SERVER_VERSION } from "./runtimeInfo.js";
import { DebugMcpError } from "./utils/errors.js";
import { Logger } from "./utils/logger.js";
import { normalizeWorkspacePath } from "./utils/pathUtils.js";

export type { AdapterResolution, ResolvedAdapterMode } from "./adapters/adapterResolution.js";
export { resolveAdapterMode, resolveAdapterModeSync } from "./adapters/adapterResolution.js";

export interface C2000McpRuntime {
  server: McpServer;
  manager: DebugSessionManager;
  toolInvoker: C2000ToolInvoker;
  dispose(): Promise<Awaited<ReturnType<DebugSessionManager["disposeAllSessions"]>>>;
}

export async function createC2000McpRuntime(
  config: C2000McpConfig,
  toolHandlerDeps: ToolHandlerDeps = {}
): Promise<C2000McpRuntime> {
  const logger = new Logger(config.logging.level, config.logging.logFile);
  const adapterResolution = await resolveAdapterMode(config);
  logger.info("debug adapter selected", adapterResolution);
  return buildRuntime(config, adapterResolution, logger, toolHandlerDeps);
}

/** Synchronous construction for tests/scripts that already know the adapter mode. */
export function createC2000McpRuntimeSync(
  config: C2000McpConfig,
  resolution?: AdapterResolution,
  toolHandlerDeps: ToolHandlerDeps = {}
): C2000McpRuntime {
  const logger = new Logger(config.logging.level, config.logging.logFile);
  const adapterResolution = resolution ?? resolveAdapterModeSync(config);
  logger.info("debug adapter selected", adapterResolution);
  return buildRuntime(config, adapterResolution, logger, toolHandlerDeps);
}

export async function createC2000McpServer(config: C2000McpConfig): Promise<McpServer> {
  return (await createC2000McpRuntime(config)).server;
}

export function createC2000McpServerSync(config: C2000McpConfig, resolution?: AdapterResolution): McpServer {
  return createC2000McpRuntimeSync(config, resolution).server;
}

function buildRuntime(
  config: C2000McpConfig,
  adapterResolution: AdapterResolution,
  logger: Logger,
  toolHandlerDeps: ToolHandlerDeps
): C2000McpRuntime {
  const startedAt = new Date().toISOString();
  const registeredToolNames = definitionsForProfile(config.toolProfile).map(tool => tool.name);
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { logging: {} } }
  );
  const effectiveInstallPath = adapterResolution.ccsInstallPath ?? config.ccs.installPath;
  const workspacePath = normalizeWorkspacePath(config.ccs.workspacePath);
  const isCcs = adapterResolution.mode === "ccs";
  // Some programmatic callers construct a config without passing through loadConfig.
  // Keep the server usable in that supported test/embedding path.
  const debugProbe = config.debugProbe ?? {
    queueDir: "runtime/debug-probe-queue",
    queueTimeoutMs: 600_000,
    recoveryPolicy: "owned-and-stale" as const,
    multiBoardEnabled: false
  };
  const enabledProbes = debugProbe.probes?.filter(probe => probe.enabled);
  const probeCoordinator = !isCcs
    ? undefined
    : debugProbe.multiBoardEnabled
      ? new DebugProbePoolCoordinator(debugProbe.queueDir, enabledProbes ?? [], debugProbe.queueTimeoutMs)
      : new FileDebugProbeCoordinator(debugProbe.queueDir, debugProbe.queueTimeoutMs);
  const tiEnvironment = {
    ccsInstallPath: effectiveInstallPath,
    c2000WarePath: config.ccs.c2000WarePath,
    ccxmlPath: config.ccs.ccxmlPath
  };
  const getServerHealth = () => buildServerHealth(config, startedAt, registeredToolNames);
  const manager = new DebugSessionManager(
    createAdapterFromMode(adapterResolution.mode, config, effectiveInstallPath, workspacePath),
    new LoadedProgramRegistry(),
    logger,
    {
      defaultCcxmlPath: config.ccs.ccxmlPath,
      defaultCoreMap: config.target.coreMap,
      defaultWorkspacePath: workspacePath,
      diagnostics: {
        cpu1BootExpressions: config.diagnostics?.cpu1BootExpressions,
        cpu2BootExpressions: config.diagnostics?.cpu2BootExpressions
      },
      probeCoordinator,
      prepareProbe: isCcs ? createProbePreparer(config, effectiveInstallPath) : undefined
    }
  );
  const toolInvoker = createC2000ToolInvoker(manager, {
    ...toolHandlerDeps,
    getToolContracts: () => getToolContracts(config.toolProfile),
    getToolSurfaceGuide,
    getToolProfile: () => ({
      activeToolProfile: config.toolProfile,
      hiddenTools: definitionsForProfile("full").filter(tool => !registeredToolNames.includes(tool.name)).map(tool => tool.name),
      profileReason: `Configured tool profile: ${config.toolProfile}`
    }),
    getServerHealth,
    tiEnvironment
  });
  registerC2000Tools(server, toolInvoker, {}, config.toolProfile, config.filesystem, tiEnvironment, { getServerHealth });

  let disposal: Promise<Awaited<ReturnType<DebugSessionManager["disposeAllSessions"]>>> | undefined;
  return {
    server,
    manager,
    toolInvoker,
    dispose: () => (disposal ??= manager.disposeAllSessions())
  };
}

function createProbePreparer(config: C2000McpConfig, ccsInstallPath?: string) {
  const recoveryPolicy = config.debugProbe?.recoveryPolicy ?? "owned-and-stale";
  return async (lease?: { probe?: { probeId: string; serialNumber: string; ccxmlPath: string } }) => {
    if (lease?.probe) {
      const preflight = await runHardwarePreflight({ ccsInstallPath });
      const detectedSerials = preflight.xdsdfu.devices
        ?.map(device => device.serialNumber)
        .filter((serial): serial is string => Boolean(serial)) ?? [];
      if (!detectedSerials.includes(lease.probe.serialNumber)) {
        throw new DebugMcpError("ProbeIdentityMismatch", `Configured XDS110 is not connected: ${lease.probe.probeId}`, {
          expectedSerialNumber: lease.probe.serialNumber,
          detectedSerialNumbers: detectedSerials
        });
      }
      const ccxml = await readFile(lease.probe.ccxmlPath, "utf8");
      if (!ccxml.includes(lease.probe.serialNumber)) {
        throw new DebugMcpError("ProbeIdentityMismatch", "The board ccxml is not bound to its configured XDS110 serial number", {
          probeId: lease.probe.probeId,
          serialNumber: lease.probe.serialNumber,
          ccxmlPath: lease.probe.ccxmlPath
        });
      }
    }
    const recovery = await recoverDebugProbe({
      ccsInstallPath,
      policy: recoveryPolicy,
      targetCcxmlPath: lease?.probe?.ccxmlPath
    });
    if (!recovery.recovered) {
      throw new DebugMcpError("ProbeRecoveryBlocked", "XDS110 recovery blocked by an existing debug owner", {
        policy: recovery.policy,
        remainingOwners: recovery.remainingOwners
      });
    }
    return recovery;
  };
}

function createAdapterFromMode(
  mode: ResolvedAdapterMode,
  config: C2000McpConfig,
  ccsInstallPath?: string,
  workspacePath?: string
): DebugAdapter {
  if (mode === "ccs") {
    return new CcsScriptingAdapter({
      ccsInstallPath: ccsInstallPath ?? config.ccs.installPath,
      workspacePath: workspacePath ?? normalizeWorkspacePath(config.ccs.workspacePath),
      dssTimeoutMs: config.ccs.dssTimeoutMs,
      timeouts: config.ccs.timeouts
    });
  }
  return new MockDebugAdapter();
}
