import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CcsScriptingAdapter } from "./adapters/CcsScriptingAdapter.js";
import { MockDebugAdapter } from "./adapters/MockDebugAdapter.js";
import type { DebugAdapter } from "./adapters/types.js";
import type { C2000McpConfig } from "./config/config.schema.js";
import { DebugSessionManager } from "./debug/DebugSessionManager.js";
import { LoadedProgramRegistry } from "./debug/LoadedProgramRegistry.js";
import { registerC2000Tools } from "./mcp/tools.js";
import { Logger } from "./utils/logger.js";

export function createC2000McpServer(config: C2000McpConfig): McpServer {
  const server = new McpServer(
    { name: "c2000-multicore-mcp", version: "0.1.0" },
    { capabilities: { logging: {} } }
  );
  const logger = new Logger(config.logging.level, config.logging.logFile);
  const manager = new DebugSessionManager(createAdapter(config), new LoadedProgramRegistry(), logger);
  registerC2000Tools(server, manager);
  return server;
}

function createAdapter(config: C2000McpConfig): DebugAdapter {
  const adapterMode = config.adapter === "auto" ? config.ccs.scriptingMode : config.adapter;
  if (adapterMode === "ccs") {
    return new CcsScriptingAdapter({
      ccsInstallPath: config.ccs.installPath,
      workspacePath: config.ccs.workspacePath,
      dssTimeoutMs: config.ccs.dssTimeoutMs
    });
  }
  return new MockDebugAdapter();
}
