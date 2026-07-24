import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import type { C2000McpConfig } from "../config/config.schema.js";
import { resolveDaemonConfig } from "./DaemonConfig.js";
import { discoverDaemon, type DiscoveredDaemon } from "../proxy/DaemonDiscovery.js";
import { DebugMcpError } from "../utils/errors.js";
import { runtimeEntrypointCandidates } from "../runtimePaths.js";

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

export async function launchDetachedDaemon(options: { cwd?: string; env?: NodeJS.ProcessEnv; preferSource?: boolean } = {}): Promise<void> {
  const entries = runtimeEntrypointCandidates("daemon", import.meta.url);
  const compiledEntry = options.preferSource ? undefined : await firstExisting(entries.compiled);
  const sourceEntry = compiledEntry ? undefined : await firstExisting(entries.source);
  const args = compiledEntry
    ? [compiledEntry, "--detached"]
    : sourceEntry
      ? [resolveTsxCli(), sourceEntry, "--detached"]
      : (() => {
          throw new DebugMcpError("DaemonEntrypointNotFound", "Unable to locate the c2000-debugd runtime entrypoint", {
            compiledCandidates: entries.compiled,
            sourceCandidates: entries.source,
            packageRoots: entries.packageRoots
          });
        })();
  const child = spawn(process.execPath, args, {
    // Keep the caller's cwd only for user-relative config/artifact paths.
    // Runtime executable selection above is module/argv-derived.
    cwd: options.cwd ?? process.cwd(),
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, ...options.env, C2000_MCP_DAEMON_CHILD: "1" }
  });
  child.unref();
}

async function firstExisting(candidates: string[]): Promise<string | undefined> {
  for (const filePath of candidates) {
    if (await exists(filePath)) return filePath;
  }
  return undefined;
}

function resolveTsxCli(): string {
  let lastError: unknown;
  const requireCandidates = [
    ...(typeof import.meta.url === "string" ? [createRequire(import.meta.url)] : []),
    createRequire(path.resolve(process.argv[1] ?? process.execPath))
  ];
  for (const requireFromRuntime of requireCandidates) {
    try {
      return requireFromRuntime.resolve("tsx/cli");
    } catch (error) {
      lastError = error;
    }
  }
  throw new DebugMcpError("DaemonEntrypointNotFound", "The source daemon entrypoint requires the tsx development dependency", {
    cause: lastError instanceof Error ? lastError.message : String(lastError)
  });
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
