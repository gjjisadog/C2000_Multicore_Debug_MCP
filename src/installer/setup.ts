import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { access, copyFile, cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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
  schemaVersion?: number;
  version: string;
  builtAt?: string;
  sourceRevision?: string;
  sourceDirty?: boolean | null;
  platform: string;
  arch: string;
  nodeModulesAbi: string;
  runtime?: {
    name?: string;
    version?: string;
    nodeVersion?: string;
    platform?: string;
    arch?: string;
    modulesAbi?: string;
    archiveName?: string;
    source?: string;
    checksumSource?: string;
    archiveSha256?: string;
    bundledNode?: boolean;
    executable?: string;
    executableSha256?: string;
  };
  entrypoints: {
    proxy: string;
    runtimeCheck?: string;
  };
  nativeBindings?: Array<{
    name: string;
    sha256: string;
    path: string;
    abi?: string;
    packageVersion?: string;
  }>;
}

export interface SetupResult {
  version: string;
  builtAt?: string;
  sourceRevision?: string;
  sourceDirty?: boolean | null;
  runtimeAction: "installed" | "installed-side-by-side" | "reused";
  platform: string;
  arch: string;
  installDirectory: string;
  entrypoint: string;
  runtimeExecutable: string;
  configPath: string;
  registration: "codex-cli" | "config-file" | "skipped";
  codexConfigPath?: string;
  skillDirectory?: string;
  skillDirectories?: string[];
  doctorPassed: boolean;
}

interface SetupDependencies {
  packageRoot?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  nodeVersion?: string;
  nodeModulesAbi?: string;
  executablePath?: string;
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
  const manifestPlatform = manifest.runtime?.platform ?? manifest.platform;
  const manifestArch = manifest.runtime?.arch ?? manifest.arch;
  const manifestAbi = manifest.runtime?.modulesAbi ?? manifest.nodeModulesAbi;
  if (manifestPlatform !== expected.platform || manifestArch !== expected.arch) {
    throw new Error(
      `Runtime package is for ${manifestPlatform}-${manifestArch}, but this machine is ${expected.platform}-${expected.arch}.`
    );
  }
  if (!options.allowAbiMismatch && manifestAbi !== expected.nodeModulesAbi) {
    throw new Error(
      `Runtime package requires Node modules ABI ${manifestAbi}, but the active Node uses ABI ${expected.nodeModulesAbi}.`
    );
  }
  if (manifest.runtime?.bundledNode === true && manifest.runtime.modulesAbi !== manifest.nodeModulesAbi) {
    throw new Error(
      `Runtime manifest has inconsistent ABI metadata: runtime ${manifest.runtime.modulesAbi}, native runtime ${manifest.nodeModulesAbi}.`
    );
  }
  if (manifest.runtime?.bundledNode === true) {
    const runtime = manifest.runtime;
    if (runtime.name !== "node"
      || !runtime.version
      || !/^\d+\.\d+\.\d+$/.test(runtime.version)
      || runtime.nodeVersion !== `v${runtime.version}`
      || runtime.executable !== "runtime/node.exe") {
      throw new Error("Bundled runtime metadata must declare a complete Node version and runtime/node.exe.");
    }
  }
}

export function validateNodeVersion(nodeVersion: string): void {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(nodeVersion.trim());
  if (!match) {
    throw new Error(`Could not parse active Node.js version: ${nodeVersion}`);
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const supported = (major === 20 && minor >= 19) || (major === 22 && minor >= 12) || major === 24;
  if (!supported) {
    throw new Error(
      `Node.js ${match[1]}.${match[2]}.${match[3]} is unsupported. `
      + "Use a supported developer Node.js release for source builds (22.12.0 is the Windows release runtime)."
    );
  }
}

export function buildCodexMcpAddArgs(
  serverName: string,
  entrypoint: string,
  configPath: string,
  nodeExecutable: string
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
    programSearchRoots: [workspace],
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
  const executablePath = dependencies.executablePath ?? process.execPath;
  const homeDirectory = dependencies.homeDirectory ?? os.homedir();
  const cwd = path.resolve(dependencies.cwd ?? process.cwd());
  const env = dependencies.env ?? process.env;
  const packageRoot = dependencies.packageRoot ?? await findPackageRoot(process.argv[1]);
  const manifestPath = path.join(packageRoot, "dist", "src", "runtime-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as RuntimeManifest;
  const bundledNodeRequired = manifest.runtime?.bundledNode === true;
  if (bundledNodeRequired) {
    validateRuntimeManifest(manifest, { platform, arch, nodeModulesAbi });
    if (manifest.runtime?.nodeVersion && normalizeNodeVersion(manifest.runtime.nodeVersion) !== normalizeNodeVersion(nodeVersion)) {
      throw new Error(
        `The offline installer was launched by Node ${nodeVersion}, but the bundle requires ${manifest.runtime.nodeVersion}.`
      );
    }
    const sourceNodePath = await findBundledNodePath(packageRoot);
    if (!sourceNodePath) {
      throw new Error(`The offline MCP bundle is missing its private Node runtime beside ${packageRoot}.`);
    }
    if (!samePath(executablePath, sourceNodePath)) {
      throw new Error(
        `The offline installer must run with the bundled Node runtime ${sourceNodePath}; received ${executablePath}.`
      );
    }
    await verifyNativeBindings(packageRoot, manifest);
    await verifyRuntimeCheck(packageRoot, executablePath, manifest, dependencies.spawn ?? spawnSync, env);
  } else {
    // Source/npm component installation is a developer workflow. It may use a
    // supported developer Node, but it must never be able to adapt an offline
    // release to that Node's ABI.
    validateNodeVersion(nodeVersion);
    validateRuntimeManifest(manifest, { platform, arch, nodeModulesAbi }, { allowAbiMismatch: true });
  }

  const installRoot = path.resolve(
    options.installRoot
      ?? env.C2000_MCP_HOME
      ?? path.join(homeDirectory, ".c2000-multicore-mcp")
  );
  const baseInstallDirectory = path.join(
    installRoot,
    "versions",
    `${manifest.version}-${platform}-${arch}`
  );
  const baseDirectoryExists = await exists(baseInstallDirectory);
  let installDirectory = options.force && baseDirectoryExists
    ? await nextRuntimeSlot(baseInstallDirectory, manifest)
    : baseInstallDirectory;
  if (!options.force && baseDirectoryExists) {
    const existingManifestPath = path.join(baseInstallDirectory, "dist", "src", "runtime-manifest.json");
    try {
      const existingManifest = JSON.parse(await readFile(existingManifestPath, "utf8")) as RuntimeManifest;
      if (!runtimeManifestsCanBeReused(existingManifest, manifest, bundledNodeRequired)) {
        installDirectory = await nextRuntimeSlot(baseInstallDirectory, manifest);
      }
    } catch {
      // Preserve the immutable-slot guard below for a directory that exists
      // but is not a complete runtime installation.
    }
  }
  const installedManifestPath = path.join(installDirectory, "dist", "src", "runtime-manifest.json");
  const alreadyInstalled = await exists(installedManifestPath);
  const runtimeAction: SetupResult["runtimeAction"] = alreadyInstalled
    ? "reused"
    : installDirectory === baseInstallDirectory ? "installed" : "installed-side-by-side";
  if (!alreadyInstalled || options.force) {
    await installRuntimeAtomically(packageRoot, installDirectory);
  }
  const installedManifest = JSON.parse(await readFile(installedManifestPath, "utf8")) as RuntimeManifest;
  validateRuntimeManifest(
    installedManifest,
    { platform, arch, nodeModulesAbi },
    { allowAbiMismatch: !bundledNodeRequired }
  );

  const runtimeDirectory = path.join(installRoot, "runtime");
  const dataDirectory = path.join(installRoot, "runtime-data");
  await mkdir(runtimeDirectory, { recursive: true });
  await mkdir(dataDirectory, { recursive: true });
  let installedNodeExecutable = executablePath;
  if (bundledNodeRequired) {
    const sourceNodePath = await findBundledNodePath(packageRoot);
    if (!sourceNodePath) throw new Error("The offline MCP bundle is missing its private Node runtime.");
    const sourceRuntimeDirectory = path.dirname(sourceNodePath);
    await installBundledNodeAtomically(sourceRuntimeDirectory, runtimeDirectory, installedManifest);
    installedNodeExecutable = path.join(runtimeDirectory, process.platform === "win32" ? "node.exe" : "node");
    await access(installedNodeExecutable);
  }
  const installedConfigPath = path.join(installRoot, "config", `${options.serverName}.json`);
  await mkdir(path.dirname(installedConfigPath), { recursive: true });
  if (options.configPath) {
    const sourceConfig = path.resolve(options.configPath);
    await access(sourceConfig);
    if (sourceConfig !== path.resolve(installedConfigPath)) {
      await cp(sourceConfig, installedConfigPath);
    }
  } else {
    const config = createInstalledConfig(path.resolve(options.workspace ?? cwd), dataDirectory);
    await writeFile(installedConfigPath, `${JSON.stringify(config, null, 2)}\n`);
  }

  const entrypoint = path.join(installDirectory, "dist", "src", installedManifest.entrypoints.proxy);
  await access(entrypoint);

  let skillDirectory: string | undefined;
  const skillDirectories: string[] = [];
  if (options.installSkill) {
    for (const skillName of ["c2000-multicore-debug", "c2000-skill-improver"]) {
      const skillSource = path.join(packageRoot, "skills", skillName);
      if (!await exists(skillSource)) continue;
      const codexHome = path.resolve(env.CODEX_HOME ?? path.join(homeDirectory, ".codex"));
      const destination = path.join(codexHome, "skills", skillName);
      await rm(destination, { recursive: true, force: true });
      await mkdir(path.dirname(destination), { recursive: true });
      await cp(skillSource, destination, { recursive: true });
      skillDirectories.push(destination);
      if (skillName === "c2000-multicore-debug") skillDirectory = destination;
    }
  }

  let doctorPassed = false;
  if (options.doctor) {
    const doctorScript = path.join(installDirectory, "scripts", "c2000-mcp-doctor.mjs");
    const result = (dependencies.spawn ?? spawnSync)(
      installedNodeExecutable,
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

  await writeCurrentPointer(installRoot, {
    schemaVersion: 1,
    version: installedManifest.version,
    installDirectory,
    entrypoint,
    runtimeExecutable: installedNodeExecutable,
    configPath: installedConfigPath,
    runtimeManifest: installedManifestPath
  });

  let registration: SetupResult["registration"] = "skipped";
  let codexConfigPath: string | undefined;
  if (options.register) {
    const registrationResult = registerCodexServer({
      serverName: options.serverName,
      entrypoint,
      nodeExecutable: installedNodeExecutable,
      configPath: installedConfigPath,
      scope: options.scope,
      cwd,
      homeDirectory,
      env,
      platform,
      spawn: dependencies.spawn ?? spawnSync
    });
    registration = registrationResult.method;
    codexConfigPath = registrationResult.codexConfigPath;
  }

  return {
    version: installedManifest.version,
    builtAt: installedManifest.builtAt,
    sourceRevision: installedManifest.sourceRevision,
    sourceDirty: installedManifest.sourceDirty,
    runtimeAction,
    platform,
    arch,
    installDirectory,
    entrypoint,
    runtimeExecutable: installedNodeExecutable,
    configPath: installedConfigPath,
    registration,
    codexConfigPath,
    skillDirectory,
    ...(skillDirectories.length > 0 ? { skillDirectories } : {}),
    doctorPassed
  };
}

interface RegisterOptions {
  serverName: string;
  entrypoint: string;
  nodeExecutable: string;
  configPath: string;
  scope: "user" | "project";
  cwd: string;
  homeDirectory: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  spawn: typeof spawnSync;
}

function registerCodexServer(options: RegisterOptions): {
  method: "codex-cli" | "config-file";
  codexConfigPath?: string;
} {
  let lastResult: SpawnSyncReturns<string> | undefined;
  if (options.scope === "user") {
    const args = buildCodexMcpAddArgs(options.serverName, options.entrypoint, options.configPath, options.nodeExecutable);
    const commands = options.platform === "win32" ? ["codex.exe", "codex.cmd", "codex"] : ["codex"];
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
  writeManagedCodexConfigSync(codexConfigPath, options.serverName, options.entrypoint, options.nodeExecutable, options.configPath, reason);
  return { method: "config-file", codexConfigPath };
}

function writeManagedCodexConfigSync(
  configFile: string,
  serverName: string,
  entrypoint: string,
  nodeExecutable: string,
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
    `command = ${tomlString(nodeExecutable)}`,
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
  installDirectory: string
): Promise<void> {
  const parent = path.dirname(installDirectory);
  const temporary = path.join(parent, `.installing-${process.pid}-${Date.now()}`);
  await mkdir(parent, { recursive: true });
  await rm(temporary, { recursive: true, force: true });
  try {
    await cp(packageRoot, temporary, { recursive: true });
    if (await exists(installDirectory)) {
      throw new Error(`The immutable runtime slot already exists but has no usable manifest: ${installDirectory}`);
    }
    await rename(temporary, installDirectory);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function findBundledNodePath(packageRoot: string): Promise<string | undefined> {
  const nodeName = process.platform === "win32" ? "node.exe" : "node";
  const candidates = [
    path.join(packageRoot, "runtime", nodeName),
    path.join(path.dirname(packageRoot), "runtime", nodeName),
    path.join(path.dirname(path.dirname(packageRoot)), "runtime", nodeName)
  ];
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }
  return undefined;
}

async function verifyNativeBindings(packageRoot: string, manifest: RuntimeManifest): Promise<void> {
  const runtimeRoot = path.join(packageRoot, "dist", "src");
  const bindings = manifest.nativeBindings ?? [];
  if (bindings.length === 0) throw new Error("The offline runtime manifest declares no native bindings.");
  const sqliteBinding = bindings.find(binding => binding.name === "better_sqlite3.node");
  if (!sqliteBinding) {
    throw new Error("The offline runtime manifest does not declare better_sqlite3.node.");
  }
  const runtimeAbi = manifest.runtime?.modulesAbi ?? manifest.nodeModulesAbi;
  if (String(sqliteBinding.abi) !== String(runtimeAbi)) {
    throw new Error(`better_sqlite3.node ABI ${sqliteBinding.abi ?? "missing"} does not match the bundled Node ABI ${runtimeAbi}.`);
  }
  for (const binding of bindings) {
    if (!/^[0-9a-f]{64}$/i.test(binding.sha256)) {
      throw new Error(`Invalid SHA-256 in the runtime manifest for ${binding.name}.`);
    }
    const bindingPath = path.resolve(runtimeRoot, binding.path);
    if (!isPathInside(bindingPath, runtimeRoot)) {
      throw new Error(`Native binding path escapes the MCP runtime: ${binding.path}`);
    }
    await access(bindingPath);
    const actual = createHash("sha256").update(await readFile(bindingPath)).digest("hex");
    if (actual.toLowerCase() !== binding.sha256.toLowerCase()) {
      throw new Error(`Native binding SHA-256 mismatch for ${binding.path}.`);
    }
  }
}

async function verifyRuntimeCheck(
  packageRoot: string,
  executablePath: string,
  manifest: RuntimeManifest,
  spawn: typeof spawnSync,
  env: NodeJS.ProcessEnv
): Promise<void> {
  const relative = manifest.entrypoints.runtimeCheck;
  if (!relative) return;
  const checkPath = path.resolve(packageRoot, "dist", "src", relative);
  const runtimeRoot = path.join(packageRoot, "dist", "src");
  if (!isPathInside(checkPath, runtimeRoot)) throw new Error(`Runtime check path escapes the MCP runtime: ${relative}`);
  const result = spawn(executablePath, [checkPath], {
    cwd: packageRoot,
    env,
    encoding: "utf8",
    windowsHide: true
  });
  if (result.error || result.status !== 0) {
    const details = `${result.stderr ?? result.stdout ?? result.error?.message ?? "unknown failure"}`.trim();
    throw new Error(`Bundled better-sqlite3 :memory: verification failed: ${details}`);
  }
}

async function installBundledNodeAtomically(
  sourceRuntimeDirectory: string,
  destinationRuntimeDirectory: string,
  manifest: RuntimeManifest
): Promise<void> {
  const nodeName = process.platform === "win32" ? "node.exe" : "node";
  const sourceNode = path.join(sourceRuntimeDirectory, nodeName);
  const destinationNode = path.join(destinationRuntimeDirectory, nodeName);
  const sourceLicense = path.join(sourceRuntimeDirectory, "LICENSE");
  const destinationLicense = path.join(destinationRuntimeDirectory, "LICENSE");
  await access(sourceNode);
  await access(sourceLicense);
  await mkdir(destinationRuntimeDirectory, { recursive: true });

  const sourceNodeHash = createHash("sha256").update(await readFile(sourceNode)).digest("hex");
  if (manifest.runtime?.executableSha256 && sourceNodeHash.toLowerCase() !== manifest.runtime.executableSha256.toLowerCase()) {
    throw new Error("The bundled Node executable does not match the offline manifest SHA-256.");
  }
  if (await exists(destinationNode)) {
    const installedHash = createHash("sha256").update(await readFile(destinationNode)).digest("hex");
    if (installedHash.toLowerCase() !== sourceNodeHash.toLowerCase()) {
      throw new Error(`Installed private Node runtime differs from the fixed release runtime: ${destinationNode}`);
    }
  } else {
    await copyFileAtomically(sourceNode, destinationNode);
  }
  if (!(await exists(destinationLicense))) await copyFileAtomically(sourceLicense, destinationLicense);
  await writeJsonAtomically(path.join(destinationRuntimeDirectory, "runtime-manifest.json"), {
    schemaVersion: 1,
    runtime: manifest.runtime ? { ...manifest.runtime, executable: nodeName } : manifest.runtime,
    executable: nodeName,
    executableSha256: sourceNodeHash
  });
}

async function copyFileAtomically(source: string, destination: string): Promise<void> {
  const temporary = `${destination}.installing-${process.pid}-${Date.now()}`;
  await rm(temporary, { force: true });
  try {
    await copyFile(source, temporary);
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function writeCurrentPointer(installRoot: string, pointer: Record<string, unknown>): Promise<void> {
  await writeJsonAtomically(path.join(installRoot, "current.json"), pointer);
}

async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
  const temporary = `${filePath}.installing-${process.pid}-${Date.now()}`;
  await mkdir(path.dirname(filePath), { recursive: true });
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
    await rename(temporary, filePath);
  } finally {
    await rm(temporary, { force: true });
  }
}

function normalizeNodeVersion(value: string): string {
  return value.trim().replace(/^v/, "");
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function isPathInside(child: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function runtimeManifestsCanBeReused(
  installed: RuntimeManifest,
  incoming: RuntimeManifest,
  bundledNodeRequired: boolean
): boolean {
  if (installed.version !== incoming.version
    || installed.platform !== incoming.platform
    || installed.arch !== incoming.arch
    || installed.nodeModulesAbi !== incoming.nodeModulesAbi) {
    return false;
  }
  if (!bundledNodeRequired) return true;
  if (installed.runtime?.bundledNode !== true
    || installed.runtime.nodeVersion !== incoming.runtime?.nodeVersion
    || installed.runtime.modulesAbi !== incoming.runtime?.modulesAbi
    || installed.runtime.executableSha256 !== incoming.runtime?.executableSha256) {
    return false;
  }
  const incomingBindings = new Map((incoming.nativeBindings ?? []).map(binding => [binding.name, binding.sha256.toLowerCase()]));
  const installedBindings = new Map((installed.nativeBindings ?? []).map(binding => [binding.name, binding.sha256.toLowerCase()]));
  if (incomingBindings.size !== installedBindings.size) return false;
  for (const [name, hash] of incomingBindings) {
    if (installedBindings.get(name) !== hash) return false;
  }
  return true;
}

async function nextRuntimeSlot(baseInstallDirectory: string, manifest: RuntimeManifest): Promise<string> {
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(manifest))
    .digest("hex")
    .slice(0, 12);
  const stem = `${baseInstallDirectory}-build${fingerprint}`;
  let candidate = stem;
  let suffix = 2;
  while (await exists(candidate)) {
    candidate = `${stem}-${suffix}`;
    suffix += 1;
  }
  return candidate;
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

The Windows offline package supplies its private Node.js runtime; source/npm
installation is a developer-only path.

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
