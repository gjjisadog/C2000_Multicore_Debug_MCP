import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { access, cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const SERVER_NAME = "c2000-multicore";
const MANAGED_BLOCK_START = "# BEGIN c2000-multicore-mcp managed block";
const MANAGED_BLOCK_END = "# END c2000-multicore-mcp managed block";

export interface SetupOptions {
  configPath?: string;
  installRoot?: string;
  workspace?: string;
  serverName: string;
  scope: "user" | "project";
  force: boolean;
  register: boolean;
  installSkill: boolean;
  doctor: boolean;
  json: boolean;
}

export interface RuntimeManifest {
  version: string;
  platform: string;
  arch: string;
  nodeModulesAbi: string;
  entrypoints: {
    proxy: string;
  };
  nativeBindings?: Array<{
    name: string;
    sha256: string;
    path: string;
  }>;
}

export interface SetupResult {
  version: string;
  platform: string;
  arch: string;
  installDirectory: string;
  entrypoint: string;
  configPath: string;
  registration: "codex-cli" | "config-file" | "skipped";
  codexConfigPath?: string;
  skillDirectory?: string;
  doctorPassed: boolean;
}

interface SetupDependencies {
  packageRoot?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  nodeVersion?: string;
  nodeModulesAbi?: string;
  homeDirectory?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  spawn?: typeof spawnSync;
}

export function parseSetupArgs(args: string[]): SetupOptions {
  const options: SetupOptions = {
    serverName: SERVER_NAME,
    scope: "user",
    force: false,
    register: true,
    installSkill: true,
    doctor: true,
    json: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const value = () => {
      const next = args[index + 1];
      if (!next || next.startsWith("--")) throw new Error(`${arg} requires a value`);
      index += 1;
      return next;
    };
    if (arg === "install" || arg === "setup") continue;
    if (arg === "--config") options.configPath = value();
    else if (arg === "--install-root") options.installRoot = value();
    else if (arg === "--workspace") options.workspace = value();
    else if (arg === "--name") options.serverName = value();
    else if (arg === "--scope") {
      const scope = value();
      if (scope !== "user" && scope !== "project") throw new Error("--scope must be user or project");
      options.scope = scope;
    } else if (arg === "--force") options.force = true;
    else if (arg === "--no-register") options.register = false;
    else if (arg === "--no-skill") options.installSkill = false;
    else if (arg === "--no-doctor") options.doctor = false;
    else if (arg === "--json") options.json = true;
    else if (arg === "--help" || arg === "-h") throw new SetupHelpRequested();
    else throw new Error(`Unknown setup option: ${arg}`);
  }

  if (!/^[A-Za-z0-9._-]+$/.test(options.serverName)) {
    throw new Error("--name may contain only letters, numbers, dot, underscore, and hyphen");
  }
  return options;
}

export function validateRuntimeManifest(
  manifest: RuntimeManifest,
  expected: { platform: string; arch: string; nodeModulesAbi: string },
  options: { allowAbiMismatch?: boolean } = {}
): void {
  if (manifest.platform !== expected.platform || manifest.arch !== expected.arch) {
    throw new Error(
      `Runtime package is for ${manifest.platform}-${manifest.arch}, but this machine is ${expected.platform}-${expected.arch}.`
    );
  }
  if (!options.allowAbiMismatch && manifest.nodeModulesAbi !== expected.nodeModulesAbi) {
    throw new Error(
      `Runtime package requires Node modules ABI ${manifest.nodeModulesAbi}, but the active Node uses ABI ${expected.nodeModulesAbi}.`
    );
  }
}

export function validateNodeVersion(nodeVersion: string): void {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(nodeVersion.trim());
  if (!match) {
    throw new Error(`Could not parse active Node.js version: ${nodeVersion}`);
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const supported = (major === 20 && minor >= 19) || (major === 22 && minor >= 12);
  if (!supported) {
    throw new Error(
      `Node.js ${match[1]}.${match[2]}.${match[3]} is unsupported. `
      + "Use Node.js 22.12+ LTS (recommended) or Node.js 20.19+ LTS. "
      + "Node.js 24 is not supported by the current published native dependency bundle."
    );
  }
}

export function buildCodexMcpAddArgs(
  serverName: string,
  entrypoint: string,
  configPath: string,
  nodeExecutable = process.execPath
): string[] {
  return [
    "mcp",
    "add",
    serverName,
    "--env",
    `C2000_MCP_CONFIG=${configPath}`,
    "--",
    nodeExecutable,
    entrypoint
  ];
}

export function createInstalledConfig(workspace: string, runtimeDirectory: string): Record<string, unknown> {
  return {
    adapter: "auto",
    ccs: { scriptingMode: "auto" },
    filesystem: {
      allowedReadRoots: [workspace],
      allowedWriteRoots: [runtimeDirectory]
    },
    debugProbe: {
      queueDir: path.join(runtimeDirectory, "debug-probe-queue"),
      queueTimeoutMs: 600000,
      recoveryPolicy: "owned-and-stale",
      multiBoardEnabled: false
    },
    daemon: {
      enabled: true,
      host: "127.0.0.1",
      port: 0,
      runtimeDir: runtimeDirectory,
      autoStart: true,
      startupTimeoutMs: 15000
    },
    storage: {
      sqlitePath: path.join(runtimeDirectory, "c2000-debugd.sqlite"),
      wal: true
    },
    logging: {
      level: "info",
      logFile: path.join(runtimeDirectory, "c2000-multicore-mcp.log")
    }
  };
}

export async function runSetup(options: SetupOptions, dependencies: SetupDependencies = {}): Promise<SetupResult> {
  const platform = dependencies.platform ?? process.platform;
  const arch = dependencies.arch ?? process.arch;
  const nodeVersion = dependencies.nodeVersion ?? process.version;
  const nodeModulesAbi = dependencies.nodeModulesAbi ?? process.versions.modules;
  const homeDirectory = dependencies.homeDirectory ?? os.homedir();
  const cwd = path.resolve(dependencies.cwd ?? process.cwd());
  const env = dependencies.env ?? process.env;
  const packageRoot = dependencies.packageRoot ?? await findPackageRoot(process.argv[1]);
  validateNodeVersion(nodeVersion);
  const manifestPath = path.join(packageRoot, "dist", "src", "runtime-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as RuntimeManifest;
  validateRuntimeManifest(manifest, { platform, arch, nodeModulesAbi }, { allowAbiMismatch: true });

  const installRoot = path.resolve(
    options.installRoot
      ?? env.C2000_MCP_HOME
      ?? path.join(homeDirectory, ".c2000-multicore-mcp")
  );
  const installDirectory = path.join(
    installRoot,
    "versions",
    `${manifest.version}-${platform}-${arch}-abi${nodeModulesAbi}`
  );
  const installedManifestPath = path.join(installDirectory, "dist", "src", "runtime-manifest.json");
  const alreadyInstalled = await exists(installedManifestPath);
  if (!alreadyInstalled || options.force) {
    await installRuntimeAtomically(packageRoot, installDirectory, manifest, nodeModulesAbi);
  }

  const runtimeDirectory = path.join(installRoot, "runtime");
  await mkdir(runtimeDirectory, { recursive: true });
  const installedConfigPath = path.join(installRoot, "config", `${options.serverName}.json`);
  await mkdir(path.dirname(installedConfigPath), { recursive: true });
  if (options.configPath) {
    const sourceConfig = path.resolve(options.configPath);
    await access(sourceConfig);
    if (sourceConfig !== path.resolve(installedConfigPath)) {
      await cp(sourceConfig, installedConfigPath);
    }
  } else {
    const config = createInstalledConfig(path.resolve(options.workspace ?? cwd), runtimeDirectory);
    await writeFile(installedConfigPath, `${JSON.stringify(config, null, 2)}\n`);
  }

  const entrypoint = path.join(installDirectory, "dist", "src", manifest.entrypoints.proxy);
  await access(entrypoint);

  let skillDirectory: string | undefined;
  if (options.installSkill) {
    const skillSource = path.join(packageRoot, "skills", "c2000-multicore-debug");
    if (await exists(skillSource)) {
      const codexHome = path.resolve(env.CODEX_HOME ?? path.join(homeDirectory, ".codex"));
      skillDirectory = path.join(codexHome, "skills", "c2000-multicore-debug");
      await rm(skillDirectory, { recursive: true, force: true });
      await mkdir(path.dirname(skillDirectory), { recursive: true });
      await cp(skillSource, skillDirectory, { recursive: true });
    }
  }

  let registration: SetupResult["registration"] = "skipped";
  let codexConfigPath: string | undefined;
  if (options.register) {
    const registrationResult = registerCodexServer({
      serverName: options.serverName,
      entrypoint,
      configPath: installedConfigPath,
      scope: options.scope,
      cwd,
      homeDirectory,
      env,
      spawn: dependencies.spawn ?? spawnSync
    });
    registration = registrationResult.method;
    codexConfigPath = registrationResult.codexConfigPath;
  }

  let doctorPassed = false;
  if (options.doctor) {
    const doctorScript = path.join(installDirectory, "scripts", "c2000-mcp-doctor.mjs");
    const result = (dependencies.spawn ?? spawnSync)(
      process.execPath,
      [doctorScript],
      {
        cwd: installDirectory,
        env: {
          ...env,
          C2000_MCP_CONFIG: installedConfigPath,
          C2000_MCP_DOCTOR_TIMEOUT_MS: env.C2000_MCP_DOCTOR_TIMEOUT_MS ?? "30000"
        },
        encoding: "utf8"
      }
    );
    if (result.error || result.status !== 0) {
      const details = `${result.stderr ?? result.stdout ?? result.error?.message ?? "unknown failure"}`.trim();
      throw new Error(`Installed runtime doctor failed: ${details}`);
    }
    doctorPassed = true;
  }

  return {
    version: manifest.version,
    platform,
    arch,
    installDirectory,
    entrypoint,
    configPath: installedConfigPath,
    registration,
    codexConfigPath,
    skillDirectory,
    doctorPassed
  };
}

interface RegisterOptions {
  serverName: string;
  entrypoint: string;
  configPath: string;
  scope: "user" | "project";
  cwd: string;
  homeDirectory: string;
  env: NodeJS.ProcessEnv;
  spawn: typeof spawnSync;
}

function registerCodexServer(options: RegisterOptions): {
  method: "codex-cli" | "config-file";
  codexConfigPath?: string;
} {
  let lastResult: SpawnSyncReturns<string> | undefined;
  if (options.scope === "user") {
    const args = buildCodexMcpAddArgs(options.serverName, options.entrypoint, options.configPath);
    const commands = process.platform === "win32" ? ["codex.exe", "codex.cmd", "codex"] : ["codex"];
    for (const command of commands) {
      const result = options.spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        encoding: "utf8",
        shell: command.endsWith(".cmd")
      });
      lastResult = result;
      if (!result.error && result.status === 0) return { method: "codex-cli" };
      if (result.error && "code" in result.error && result.error.code === "ENOENT") continue;
    }
  }

  const reason = options.scope === "project"
    ? "project scope requested; Codex CLI add is user-scoped"
    : `${lastResult?.stderr ?? lastResult?.stdout ?? lastResult?.error?.message ?? "Codex CLI unavailable"}`.trim();
  const codexConfigPath = options.scope === "project"
    ? path.join(options.cwd, ".codex", "config.toml")
    : path.join(path.resolve(options.env.CODEX_HOME ?? path.join(options.homeDirectory, ".codex")), "config.toml");
  writeManagedCodexConfigSync(codexConfigPath, options.serverName, options.entrypoint, options.configPath, reason);
  return { method: "config-file", codexConfigPath };
}

function writeManagedCodexConfigSync(
  configFile: string,
  serverName: string,
  entrypoint: string,
  configPath: string,
  cliFailure: string
): void {
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  const existing = fs.existsSync(configFile) ? fs.readFileSync(configFile, "utf8") : "";
  const withoutManagedBlock = removeServerTables(removeManagedBlock(existing), serverName);
  const block = [
    MANAGED_BLOCK_START,
    `# Codex CLI fallback reason: ${cliFailure.replace(/[\r\n]+/g, " ").slice(0, 240)}`,
    `[mcp_servers.${tomlKey(serverName)}]`,
    `command = ${tomlString(process.execPath)}`,
    `args = [${tomlString(entrypoint)}]`,
    "",
    `[mcp_servers.${tomlKey(serverName)}.env]`,
    `C2000_MCP_CONFIG = ${tomlString(configPath)}`,
    MANAGED_BLOCK_END
  ].join("\n");
  const prefix = withoutManagedBlock.trimEnd();
  fs.writeFileSync(configFile, `${prefix}${prefix ? "\n\n" : ""}${block}\n`);
}

function removeManagedBlock(content: string): string {
  const start = content.indexOf(MANAGED_BLOCK_START);
  if (start < 0) return content;
  const end = content.indexOf(MANAGED_BLOCK_END, start);
  if (end < 0) throw new Error("Codex config contains an incomplete c2000-multicore-mcp managed block");
  return `${content.slice(0, start)}${content.slice(end + MANAGED_BLOCK_END.length)}`;
}

function removeServerTables(content: string, serverName: string): string {
  const barePrefix = `mcp_servers.${serverName}`;
  const quotedPrefix = `mcp_servers.${tomlString(serverName)}`;
  let removing = false;
  const kept: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/)?.[1]?.trim();
    if (header) {
      removing = header === barePrefix
        || header.startsWith(`${barePrefix}.`)
        || header === quotedPrefix
        || header.startsWith(`${quotedPrefix}.`);
    }
    if (!removing) kept.push(line);
  }
  return kept.join("\n");
}

async function installRuntimeAtomically(
  packageRoot: string,
  installDirectory: string,
  manifest: RuntimeManifest,
  activeNodeModulesAbi: string
): Promise<void> {
  const parent = path.dirname(installDirectory);
  const temporary = path.join(parent, `.installing-${process.pid}-${Date.now()}`);
  await mkdir(parent, { recursive: true });
  await rm(temporary, { recursive: true, force: true });
  try {
    await mkdir(path.join(temporary, "dist"), { recursive: true });
    await cp(path.join(packageRoot, "dist", "src"), path.join(temporary, "dist", "src"), { recursive: true });
    if (manifest.nodeModulesAbi !== activeNodeModulesAbi) {
      const binding = manifest.nativeBindings?.find(candidate => candidate.name === "better_sqlite3.node");
      if (!binding) throw new Error("Runtime manifest does not declare the better_sqlite3.node binding");
      const dependencyBinding = path.join(
        packageRoot,
        "node_modules",
        "better-sqlite3",
        "build",
        "Release",
        "better_sqlite3.node"
      );
      try {
        const requireFromPackage = createRequire(path.join(packageRoot, "package.json"));
        const Database = requireFromPackage("better-sqlite3") as new (filename: string) => { close(): void };
        const database = new Database(":memory:");
        database.close();
        await access(dependencyBinding);
      } catch (error) {
        throw new Error(
          `This release was built for Node ABI ${manifest.nodeModulesAbi}, and npm did not install a usable `
          + `better-sqlite3 binding for active ABI ${activeNodeModulesAbi}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      const installedBinding = path.join(temporary, "dist", "src", binding.path);
      await cp(dependencyBinding, installedBinding);
      const bindingContent = await readFile(installedBinding);
      const installedManifest = {
        ...manifest,
        nodeVersion: process.version,
        nodeModulesAbi: activeNodeModulesAbi,
        adaptedAt: new Date().toISOString(),
        nativeBindings: manifest.nativeBindings!.map(candidate => candidate.name === binding.name
          ? { ...candidate, sha256: createHash("sha256").update(bindingContent).digest("hex") }
          : candidate)
      };
      await writeFile(
        path.join(temporary, "dist", "src", "runtime-manifest.json"),
        `${JSON.stringify(installedManifest, null, 2)}\n`
      );
    }
    await mkdir(path.join(temporary, "scripts"), { recursive: true });
    await cp(
      path.join(packageRoot, "scripts", "c2000-mcp-doctor.mjs"),
      path.join(temporary, "scripts", "c2000-mcp-doctor.mjs")
    );
    await cp(path.join(packageRoot, "package.json"), path.join(temporary, "package.json"));
    await rm(installDirectory, { recursive: true, force: true });
    await rename(temporary, installDirectory);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function findPackageRoot(entrypoint?: string): Promise<string> {
  let current = path.resolve(entrypoint ? path.dirname(entrypoint) : process.cwd());
  while (true) {
    if (
      await exists(path.join(current, "package.json"))
      && await exists(path.join(current, "dist", "src", "runtime-manifest.json"))
    ) return current;
    const parent = path.dirname(current);
    if (parent === current) throw new Error("Could not locate the packaged C2000 MCP runtime");
    current = parent;
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function tomlKey(value: string): string {
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : tomlString(value);
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

export class SetupHelpRequested extends Error {}

export const setupHelp = `C2000 Multicore MCP one-command installer

Usage:
  c2000-multicore-setup install [options]

Options:
  --config <file>        Use an existing C2000 MCP JSON configuration
  --workspace <dir>      Default allowed program/read workspace (default: cwd)
  --install-root <dir>   Durable install root (default: ~/.c2000-multicore-mcp)
  --name <name>          Codex MCP server name (default: c2000-multicore)
  --scope user|project   Register globally or for the current project
  --force                Replace the installed copy of this version
  --no-register          Install without changing Codex MCP configuration
  --no-skill             Do not install the bundled Codex skill
  --no-doctor            Skip the installed-runtime handshake check
  --json                 Print a machine-readable result
`;
