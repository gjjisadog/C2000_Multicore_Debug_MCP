import { readFile } from "node:fs/promises";
import { c2000McpConfigSchema, type C2000McpConfig } from "./config.schema.js";
import { defaultF28P65xCoreMap } from "../debug/types.js";

export async function loadConfig(configPath = process.env.C2000_MCP_CONFIG): Promise<C2000McpConfig> {
  const fileConfig = configPath ? JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown> : {};
  const merged = applyEnvOverrides({
    adapter: "auto",
    ccs: { scriptingMode: "auto" },
    target: { name: "F28P65x", coreMap: defaultF28P65xCoreMap },
    diagnostics: {},
    logging: { level: "info" },
    ...fileConfig
  });
  return c2000McpConfigSchema.parse(merged);
}

function applyEnvOverrides(config: Record<string, unknown>): Record<string, unknown> {
  const ccs = { ...objectAt(config, "ccs") };
  const logging = { ...objectAt(config, "logging") };
  if (process.env.C2000_MCP_ADAPTER) {
    config.adapter = process.env.C2000_MCP_ADAPTER;
    ccs.scriptingMode = process.env.C2000_MCP_ADAPTER;
  }
  if (process.env.C2000_MCP_CCS_INSTALL_PATH) {
    ccs.installPath = process.env.C2000_MCP_CCS_INSTALL_PATH;
  }
  if (process.env.C2000_MCP_WORKSPACE_PATH) {
    ccs.workspacePath = process.env.C2000_MCP_WORKSPACE_PATH;
  }
  if (process.env.C2000_MCP_CCXML_PATH) {
    ccs.ccxmlPath = process.env.C2000_MCP_CCXML_PATH;
  }
  if (process.env.C2000_MCP_DSS_TIMEOUT_MS) {
    ccs.dssTimeoutMs = Number.parseInt(process.env.C2000_MCP_DSS_TIMEOUT_MS, 10);
  }
  if (process.env.C2000_MCP_LOG_LEVEL) {
    logging.level = process.env.C2000_MCP_LOG_LEVEL;
  }
  if (process.env.C2000_MCP_LOG_FILE) {
    logging.logFile = process.env.C2000_MCP_LOG_FILE;
  }
  return { ...config, ccs, logging };
}

function objectAt(config: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = config[key];
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
