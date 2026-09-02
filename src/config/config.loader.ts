import { readFile } from "node:fs/promises";
import path from "node:path";
import { c2000McpConfigSchema, type C2000McpConfig } from "./config.schema.js";
import { defaultF28P65xCoreMap } from "../debug/types.js";
import { resolveTiEnvironment as resolveTiEnvironmentDefault, type ResolveTiEnvironmentOptions, type TiEnvironmentResolution } from "./tiPaths.js";

interface ConfigLoaderDeps {
  resolveTiEnvironment?: (options?: ResolveTiEnvironmentOptions) => Promise<TiEnvironmentResolution>;
}

export async function loadConfig(configPath = process.env.C2000_MCP_CONFIG, deps: ConfigLoaderDeps = {}): Promise<C2000McpConfig> {
  const fileConfig = configPath ? JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown> : {};
  const merged = applyEnvOverrides({
    adapter: "auto",
    ccs: { scriptingMode: "auto" },
    target: { name: "F28P65x", coreMap: defaultF28P65xCoreMap },
    programSearchRoots: [],
    diagnostics: {},
    logging: { level: "info" },
    toolProfile: "safe",
    toolSurfaceProfile: "agent",
    filesystem: { allowedReadRoots: [process.cwd()], allowedWriteRoots: [path.join(process.cwd(), "runtime")] },
    debugProbe: { queueDir: path.join(process.cwd(), "runtime", "debug-probe-queue"), queueTimeoutMs: 600000, recoveryPolicy: "owned-and-stale", multiBoardEnabled: false },
    daemon: {
      enabled: true,
      host: "127.0.0.1",
      port: 0,
      runtimeDir: "./runtime",
      autoStart: true,
      startupTimeoutMs: 15000
    },
    storage: { sqlitePath: "./runtime/c2000-debugd.sqlite", wal: true },
    improvement: {
      enabled: false,
      repositoryRoot: process.cwd(),
      worktreeRoot: path.join(path.dirname(process.cwd()), ".c2000-improvement-worktrees"),
      artifactRoot: path.join(process.cwd(), "runtime", "improvement-artifacts"),
      baseRef: "master",
      maxActiveRuns: 1,
      codingAgent: { provider: "configured-agent", args: [], timeoutMs: 15 * 60 * 1000 }
    },
    workers: {
      heartbeatIntervalMs: 1000,
      heartbeatTimeoutMs: 5000,
      defaultCommandTimeoutMs: 60000,
      restartLimit: 5,
      restartWindowMs: 60000
    },
    scheduler: { maxActiveJobs: 16, maxParallelBoards: 4, agingThresholdMs: 30000, starvationTimeoutMs: 300000, pollIntervalMs: 250 },
    boards: [],
    ...fileConfig
  });
  const ccs = { ...objectAt(merged, "ccs") };
  const resolved = await (deps.resolveTiEnvironment ?? resolveTiEnvironmentDefault)({
    ccsInstallPath: stringAt(ccs, "installPath"),
    c2000WarePath: stringAt(ccs, "c2000WarePath"),
    ccxmlPath: stringAt(ccs, "ccxmlPath")
  });
  if (resolved.ccs.path) ccs.installPath = resolved.ccs.path;
  if (resolved.c2000Ware.path) ccs.c2000WarePath = resolved.c2000Ware.path;
  if (resolved.ccxml.path) ccs.ccxmlPath = resolved.ccxml.path;
  merged.ccs = ccs;
  return c2000McpConfigSchema.parse(merged);
}

function applyEnvOverrides(config: Record<string, unknown>): Record<string, unknown> {
  const ccs = { ...objectAt(config, "ccs") };
  const logging = { ...objectAt(config, "logging") };
  const daemon = { ...objectAt(config, "daemon") };
  const filesystem = { ...objectAt(config, "filesystem") };
  const debugProbe = { ...objectAt(config, "debugProbe") };
  const improvement = { ...objectAt(config, "improvement") };
  const codingAgent = { ...objectAt(improvement, "codingAgent") };
  if (process.env.C2000_MCP_TOOL_PROFILE) config.toolProfile = process.env.C2000_MCP_TOOL_PROFILE;
  if (process.env.C2000_MCP_TOOL_SURFACE) config.toolSurfaceProfile = process.env.C2000_MCP_TOOL_SURFACE;
  if (process.env.C2000_MCP_ALLOWED_READ_ROOTS) filesystem.allowedReadRoots = process.env.C2000_MCP_ALLOWED_READ_ROOTS.split(path.delimiter).filter(Boolean);
  if (process.env.C2000_MCP_ALLOWED_WRITE_ROOTS) filesystem.allowedWriteRoots = process.env.C2000_MCP_ALLOWED_WRITE_ROOTS.split(path.delimiter).filter(Boolean);
  if (process.env.C2000_PROGRAM_SEARCH_ROOTS) config.programSearchRoots = process.env.C2000_PROGRAM_SEARCH_ROOTS.split(path.delimiter).filter(Boolean);
  if (process.env.C2000_MCP_PROBE_QUEUE_DIR) debugProbe.queueDir = process.env.C2000_MCP_PROBE_QUEUE_DIR;
  if (process.env.C2000_MCP_PROBE_QUEUE_TIMEOUT_MS) debugProbe.queueTimeoutMs = Number.parseInt(process.env.C2000_MCP_PROBE_QUEUE_TIMEOUT_MS, 10);
  if (process.env.C2000_MCP_PROBE_RECOVERY_POLICY) debugProbe.recoveryPolicy = process.env.C2000_MCP_PROBE_RECOVERY_POLICY;
  if (process.env.C2000_MCP_PROBES_JSON) debugProbe.probes = JSON.parse(process.env.C2000_MCP_PROBES_JSON);
  if (process.env.C2000_MCP_MULTI_BOARD_ENABLED) debugProbe.multiBoardEnabled = process.env.C2000_MCP_MULTI_BOARD_ENABLED === "1" || process.env.C2000_MCP_MULTI_BOARD_ENABLED === "true";
  if (process.env.C2000_MCP_IMPROVEMENT_ENABLED) improvement.enabled = parseBooleanOverride(process.env.C2000_MCP_IMPROVEMENT_ENABLED);
  if (process.env.C2000_MCP_IMPROVEMENT_REPOSITORY_ROOT) improvement.repositoryRoot = process.env.C2000_MCP_IMPROVEMENT_REPOSITORY_ROOT;
  if (process.env.C2000_MCP_IMPROVEMENT_WORKTREE_ROOT) improvement.worktreeRoot = process.env.C2000_MCP_IMPROVEMENT_WORKTREE_ROOT;
  if (process.env.C2000_MCP_IMPROVEMENT_ARTIFACT_ROOT) improvement.artifactRoot = process.env.C2000_MCP_IMPROVEMENT_ARTIFACT_ROOT;
  if (process.env.C2000_MCP_IMPROVEMENT_BASE_REF) improvement.baseRef = process.env.C2000_MCP_IMPROVEMENT_BASE_REF;
  if (process.env.C2000_MCP_IMPROVEMENT_AGENT_PROVIDER) codingAgent.provider = process.env.C2000_MCP_IMPROVEMENT_AGENT_PROVIDER;
  if (process.env.C2000_MCP_IMPROVEMENT_AGENT_COMMAND) codingAgent.command = process.env.C2000_MCP_IMPROVEMENT_AGENT_COMMAND;
  if (process.env.C2000_MCP_IMPROVEMENT_AGENT_ARGS_JSON) codingAgent.args = JSON.parse(process.env.C2000_MCP_IMPROVEMENT_AGENT_ARGS_JSON);
  if (process.env.C2000_MCP_IMPROVEMENT_AGENT_TIMEOUT_MS) codingAgent.timeoutMs = Number.parseInt(process.env.C2000_MCP_IMPROVEMENT_AGENT_TIMEOUT_MS, 10);
  if (process.env.C2000_MCP_ADAPTER) {
    config.adapter = process.env.C2000_MCP_ADAPTER;
    ccs.scriptingMode = process.env.C2000_MCP_ADAPTER;
  }
  if (process.env.C2000_MCP_CCS_INSTALL_PATH) {
    ccs.installPath = process.env.C2000_MCP_CCS_INSTALL_PATH;
  }
  if (process.env.C2000_MCP_C2000WARE_PATH) {
    ccs.c2000WarePath = process.env.C2000_MCP_C2000WARE_PATH;
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
  if (process.env.C2000_MCP_DAEMON_RUNTIME_DIR) {
    daemon.runtimeDir = process.env.C2000_MCP_DAEMON_RUNTIME_DIR;
  }
  if (process.env.C2000_MCP_DAEMON_AUTO_START) {
    daemon.autoStart = process.env.C2000_MCP_DAEMON_AUTO_START !== "0";
  }
  improvement.codingAgent = codingAgent;
  return { ...config, ccs, logging, daemon, filesystem, debugProbe, improvement };
}

function parseBooleanOverride(value: string): boolean {
  if (value === "1" || value === "true") return true;
  if (value === "0" || value === "false") return false;
  throw new Error(`Invalid C2000_MCP_IMPROVEMENT_ENABLED value: ${value}. Expected true, false, 1, or 0.`);
}

function objectAt(config: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = config[key];
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringAt(config: Record<string, unknown>, key: string): string | undefined {
  return typeof config[key] === "string" ? config[key] : undefined;
}
