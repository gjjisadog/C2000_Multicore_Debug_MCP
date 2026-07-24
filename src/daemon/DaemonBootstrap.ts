import { access } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type { C2000McpConfig } from "../config/config.schema.js";
import { resolveDaemonConfig } from "./DaemonConfig.js";
import { discoverDaemon, type DiscoveredDaemon } from "../proxy/DaemonDiscovery.js";
import { DebugMcpError } from "../utils/errors.js";

export async function ensureDaemon(config: C2000McpConfig): Promise<DiscoveredDaemon> {
  const daemon = resolveDaemonConfig(config);
  if (!daemon.enabled) {
    throw new DebugMcpError("DaemonUnavailable", "c2000-debugd is disabled by configuration");
  }
  try {
    return await discoverDaemon(config);
  } catch (error) {
    if (!daemon.autoStart) throw error;
  }
  await launchDetachedDaemon();
  const deadline = Date.now() + daemon.startupTimeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await discoverDaemon(config);
    } catch (error) {
      lastError = error;
      await delay(100);
    }
  }
  throw new DebugMcpError("DaemonStarting", "c2000-debugd did not become ready before the startup timeout", {
    timeoutMs: daemon.startupTimeoutMs,
    cause: lastError instanceof Error ? lastError.message : String(lastError)
  });
}

export async function launchDetachedDaemon(): Promise<void> {
  const cwd = process.cwd();
  const compiledEntry = path.join(cwd, "dist", "src", "daemon", "index.js");
  const sourceEntry = path.join(cwd, "src", "daemon", "index.ts");
  const useCompiled = await exists(compiledEntry);
  const tsxCli = path.join(cwd, "node_modules", "tsx", "dist", "cli.mjs");
  const args = useCompiled ? [compiledEntry, "--detached"] : [tsxCli, sourceEntry, "--detached"];
  const child = spawn(process.execPath, args, {
    cwd,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, C2000_MCP_DAEMON_CHILD: "1" }
  });
  child.unref();
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}
