import process from "node:process";
import type { C2000McpConfig } from "./config/config.schema.js";

declare const __C2000_RUNTIME_BUNDLED__: boolean;

export const SERVER_NAME = "c2000-multicore-mcp";
export const SERVER_VERSION = "0.6.1";

export function isBundledRuntime(): boolean {
  return typeof __C2000_RUNTIME_BUNDLED__ !== "undefined" && __C2000_RUNTIME_BUNDLED__;
}

export function buildServerHealth(config: C2000McpConfig, startedAt: string, registeredToolNames: string[]) {
  const adapterMode = config.adapter === "auto" ? config.ccs.scriptingMode : config.adapter;
  return {
    status: "ready",
    server: { name: SERVER_NAME, version: SERVER_VERSION },
    runtime: {
      bundled: isBundledRuntime(),
      entrypoint: process.argv[1],
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      pid: process.pid,
      startedAt,
      uptimeSeconds: Math.floor(process.uptime())
    },
    configuration: {
      adapterMode,
      toolProfile: config.toolProfile,
      configFileConfigured: Boolean(process.env.C2000_MCP_CONFIG),
      loggingToFile: Boolean(config.logging.logFile),
      pathsConfigured: {
        ccsInstallPath: Boolean(config.ccs.installPath),
        c2000WarePath: Boolean(config.ccs.c2000WarePath),
        ccxmlPath: Boolean(config.ccs.ccxmlPath),
        workspacePath: Boolean(config.ccs.workspacePath)
      }
    },
    tools: {
      registeredCount: registeredToolNames.length,
      registeredNames: registeredToolNames
    }
  };
}
