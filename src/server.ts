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
import { registerC2000Tools } from "./mcp/tools.js";
import { Logger } from "./utils/logger.js";
import { normalizeWorkspacePath } from "./utils/pathUtils.js";

export type { AdapterResolution, ResolvedAdapterMode } from "./adapters/adapterResolution.js";
export { resolveAdapterMode, resolveAdapterModeSync } from "./adapters/adapterResolution.js";

export async function createC2000McpServer(config: C2000McpConfig): Promise<McpServer> {
  const logger = new Logger(config.logging.level, config.logging.logFile);
  const adapterResolution = await resolveAdapterMode(config);
  logger.info("debug adapter selected", adapterResolution);
  return buildServer(config, adapterResolution, logger);
}

/**
 * Synchronous construction for tests/scripts that already know the adapter mode.
 * For `auto`, prefer {@link createC2000McpServer} so DSS availability is probed.
 */
export function createC2000McpServerSync(config: C2000McpConfig, resolution?: AdapterResolution): McpServer {
  const logger = new Logger(config.logging.level, config.logging.logFile);
  const adapterResolution = resolution ?? resolveAdapterModeSync(config);
  logger.info("debug adapter selected", adapterResolution);
  return buildServer(config, adapterResolution, logger);
}

function buildServer(config: C2000McpConfig, adapterResolution: AdapterResolution, logger: Logger): McpServer {
  const server = new McpServer(
    { name: "c2000-multicore-mcp", version: "0.1.0" },
    { capabilities: { logging: {} } }
  );
  const effectiveInstallPath = adapterResolution.ccsInstallPath ?? config.ccs.installPath;
  const workspacePath = normalizeWorkspacePath(config.ccs.workspacePath);
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
      }
    }
  );
  registerC2000Tools(server, manager);
  return server;
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
      dssTimeoutMs: config.ccs.dssTimeoutMs
    });
  }
  return new MockDebugAdapter();
}
