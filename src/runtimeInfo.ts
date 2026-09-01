import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import type { C2000McpConfig } from "./config/config.schema.js";

declare const __C2000_RUNTIME_BUNDLED__: boolean;
declare const __C2000_RUNTIME_BUILT_AT__: string;
declare const __C2000_RUNTIME_SOURCE_REVISION__: string;
declare const __C2000_RUNTIME_SOURCE_DIRTY__: boolean | null;

export const SERVER_NAME = "c2000-multicore-mcp";
export const SERVER_VERSION = "0.7.0";

export function isBundledRuntime(): boolean {
  return typeof __C2000_RUNTIME_BUNDLED__ !== "undefined" && __C2000_RUNTIME_BUNDLED__;
}

export function runtimeBuildInfo() {
  return {
    builtAt: typeof __C2000_RUNTIME_BUILT_AT__ === "undefined" ? null : __C2000_RUNTIME_BUILT_AT__,
    sourceRevision: typeof __C2000_RUNTIME_SOURCE_REVISION__ === "undefined" ? null : __C2000_RUNTIME_SOURCE_REVISION__,
    sourceDirty: typeof __C2000_RUNTIME_SOURCE_DIRTY__ === "undefined" ? null : __C2000_RUNTIME_SOURCE_DIRTY__
  };
}

/**
 * Inspect the runtime that launched this process. A source checkout is allowed
 * to use the developer's Node; an installed offline artifact must be launched
 * by the node.exe kept beside the installed MCP versions.
 */
export function inspectRuntime() {
  const manifestPath = findRuntimeManifestPath();
  const manifest = readManifest(manifestPath);
  const expectedNodePath = manifest?.runtime?.bundledNode === true
    ? findBundledNodePath(manifestPath)
    : undefined;
  const nativeBindingsValid = manifestPath
    ? verifyNativeBindings(manifestPath, manifest?.nativeBindings)
    : false;
  const bundledNode = manifest?.runtime?.bundledNode === true
    && Boolean(expectedNodePath)
    && samePath(process.execPath, expectedNodePath!);
  return {
    bundledNode,
    nodePath: process.execPath,
    expectedNodePath: expectedNodePath ?? null,
    nodeVersion: process.version,
    nodeModulesAbi: process.versions.modules,
    platform: process.platform,
    arch: process.arch,
    nativeBindingsValid,
    runtimeManifestPath: manifestPath ?? null,
    declaredRuntime: manifest?.runtime ?? null
  };
}

export function buildServerHealth(
  config: C2000McpConfig,
  startedAt: string,
  registeredToolNames: string[],
  dynamicCapabilities: { activeCapabilityCount?: number; capabilityMode?: "dynamic" | "static" } = {}
) {
  const adapterMode = config.adapter === "auto" ? config.ccs.scriptingMode : config.adapter;
  const toolProfile = config.toolProfile ?? "safe";
  const toolSurfaceProfile = config.toolSurfaceProfile ?? "agent";
  return {
    status: "ready",
    server: { name: SERVER_NAME, version: SERVER_VERSION },
    runtime: {
      bundled: isBundledRuntime(),
      ...inspectRuntime(),
      entrypoint: process.argv[1],
      pid: process.pid,
      startedAt,
      uptimeSeconds: Math.floor(process.uptime()),
      build: runtimeBuildInfo()
    },
    configuration: {
      adapterMode,
      toolProfile,
      toolSurfaceProfile,
      capabilityMode: dynamicCapabilities.capabilityMode ?? "dynamic",
      activeCapabilityCount: dynamicCapabilities.activeCapabilityCount ?? 0,
      profile: {
        effective: toolProfile,
        source: process.env.C2000_MCP_TOOL_PROFILE
          ? "environment"
          : process.env.C2000_MCP_CONFIG ? "config-file" : "default",
        configPath: process.env.C2000_MCP_CONFIG ?? null,
        appliedAt: startedAt
      },
      surfaceProfile: {
        effective: toolSurfaceProfile,
        source: process.env.C2000_MCP_TOOL_SURFACE
          ? "environment"
          : process.env.C2000_MCP_CONFIG ? "config-file" : "default",
        configPath: process.env.C2000_MCP_CONFIG ?? null,
        appliedAt: startedAt
      },
      reload: {
        supported: false,
        daemonRestartRequired: false,
        frontendReconnectRequired: true,
        message: "Safety and base surface configuration are fixed when this MCP frontend starts; short-lived capability sessions update dynamically. Update JSON/env profiles, then reconnect only this frontend; do not restart c2000-debugd or board workers."
      },
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
      registeredNames: registeredToolNames,
      activeCapabilityCount: dynamicCapabilities.activeCapabilityCount ?? 0
    }
  };
}

function findRuntimeManifestPath(): string | undefined {
  let current = process.argv[1]
    ? path.dirname(path.resolve(process.argv[1]))
    : process.cwd();
  while (true) {
    const candidate = path.join(current, "runtime-manifest.json");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function readManifest(manifestPath: string | undefined): any | undefined {
  if (!manifestPath) return undefined;
  try {
    return JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return undefined;
  }
}

function findBundledNodePath(manifestPath: string | undefined): string | undefined {
  if (!manifestPath) return undefined;
  const packageRoot = path.dirname(path.dirname(path.dirname(manifestPath)));
  const candidates = [
    path.join(packageRoot, "runtime", process.platform === "win32" ? "node.exe" : "node"),
    path.join(path.dirname(packageRoot), "runtime", process.platform === "win32" ? "node.exe" : "node"),
    path.join(path.dirname(path.dirname(packageRoot)), "runtime", process.platform === "win32" ? "node.exe" : "node")
  ];
  return candidates.find(candidate => existsSync(candidate));
}

function verifyNativeBindings(manifestPath: string, bindings: unknown): boolean {
  if (!Array.isArray(bindings) || bindings.length === 0) return false;
  const base = path.dirname(manifestPath);
  return bindings.every(binding => {
    if (!binding || typeof binding !== "object") return false;
    const candidate = binding as { path?: unknown; sha256?: unknown };
    if (typeof candidate.path !== "string" || !/^[0-9a-f]{64}$/i.test(String(candidate.sha256))) return false;
    const bindingPath = path.resolve(base, candidate.path);
    const relative = path.relative(base, bindingPath);
    if (relative.startsWith("..") || path.isAbsolute(relative) || !existsSync(bindingPath)) return false;
    try {
      const actual = createHash("sha256").update(readFileSync(bindingPath)).digest("hex");
      return actual.toLowerCase() === String(candidate.sha256).toLowerCase();
    } catch {
      return false;
    }
  });
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}
