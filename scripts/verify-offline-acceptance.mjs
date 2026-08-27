import { access, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const installRoot = parseInstallRoot(process.argv.slice(2));
const pointerPath = path.join(installRoot, "current.json");
const pointer = JSON.parse(await readFile(pointerPath, "utf8"));
const nodePath = path.join(installRoot, "runtime", "node.exe");
const slot = path.resolve(pointer.installDirectory);
const runtimeCheck = path.join(slot, "dist", "src", "installer", "runtime-check.js");
const doctor = path.join(slot, "scripts", "c2000-mcp-doctor.mjs");
const cleanPath = process.env.SystemRoot
  ? `${path.join(process.env.SystemRoot, "System32")};${process.env.SystemRoot}`
  : "";
const env = { ...process.env, PATH: cleanPath };
const commandChecks = {
  node: assertUnavailable("node", env),
  npm: assertUnavailable("npm", env),
  npx: assertUnavailable("npx", env),
  gh: assertUnavailable("gh", env),
  git: assertUnavailable("git", env),
  python: assertUnavailable("python", env)
};

await access(nodePath);
await access(runtimeCheck);
await access(doctor);
if (path.resolve(pointer.runtimeExecutable).toLowerCase() !== path.resolve(nodePath).toLowerCase()) {
  throw new Error("current.json does not point to the installed private Node runtime.");
}

const nodeProbe = run(nodePath, ["-p", "JSON.stringify({nodeVersion:process.version,nodeModulesAbi:process.versions.modules,platform:process.platform,arch:process.arch})"], installRoot, env);
const runtimeManifest = JSON.parse(await readFile(path.join(slot, "dist", "src", "runtime-manifest.json"), "utf8"));
if (nodeProbe.nodeVersion !== runtimeManifest.runtime.nodeVersion
  || String(nodeProbe.nodeModulesAbi) !== String(runtimeManifest.runtime.modulesAbi)) {
  throw new Error(`Installed private Node disagrees with the MCP manifest: ${JSON.stringify({ nodeProbe, runtimeManifest })}`);
}

const sqlite = run(nodePath, [runtimeCheck], slot, env);
const doctorResult = run(nodePath, [doctor, "--verify-worker"], installRoot, {
  ...env,
  C2000_MCP_HOME: installRoot,
  C2000_MCP_ADAPTER: "mock",
  C2000_MCP_TOOL_PROFILE: "readonly",
  C2000_MCP_LOG_LEVEL: "error"
});

const koffiPath = path.join(slot, "dist", "src", "node_modules", "koffi", "index.js");
let koffiLoaded = false;
try {
  await import(pathToFileURL(koffiPath).href);
  koffiLoaded = true;
} catch (error) {
  throw new Error(`Bundled koffi native binding could not be loaded: ${error instanceof Error ? error.message : String(error)}`);
}

if (doctorResult.health?.runtime?.bundledNode !== true) {
  throw new Error(`Doctor did not observe the private runtime: ${JSON.stringify(doctorResult.health?.runtime)}`);
}
if (!doctorResult.workerCheck || doctorResult.workerCheck.status !== "READY") {
  throw new Error(`Mock worker did not reach READY: ${JSON.stringify(doctorResult.workerCheck)}`);
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  acceptance: {
    systemNodeUnavailable: commandChecks.node,
    npmUnavailable: commandChecks.npm,
    npxUnavailable: commandChecks.npx,
    ghUnavailable: commandChecks.gh,
    gitUnavailable: commandChecks.git,
    pythonUnavailable: commandChecks.python,
    offlineInstall: true,
    doctor: true,
    sqliteMemory: sqlite.sqliteMemory === true,
    mockWorker: doctorResult.workerCheck,
    mcpHandshake: {
      initialize: doctorResult.ok === true,
      toolsList: doctorResult.toolCount >= doctorResult.requiredTools.length,
      c2000_getServerHealth: doctorResult.health?.success === true && doctorResult.health.status === "ready"
    },
    koffiNativeBindingLoaded: koffiLoaded
  },
  nodeProbe,
  runtimeManifest: {
    version: runtimeManifest.runtime.version,
    nodeVersion: runtimeManifest.runtime.nodeVersion,
    nodeModulesAbi: runtimeManifest.runtime.modulesAbi,
    nativeBindings: runtimeManifest.nativeBindings
  },
  doctor: doctorResult
}, null, 2)}\n`);

function parseInstallRoot(args) {
  const index = args.indexOf("--install-root");
  if (index >= 0) {
    const value = args[index + 1];
    if (!value) throw new Error("--install-root requires a path");
    return path.resolve(value);
  }
  return path.resolve(process.env.C2000_MCP_HOME ?? path.join(os.homedir(), ".c2000-multicore-mcp"));
}

function run(command, args, cwd, env) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", windowsHide: true });
  if (result.error || result.status !== 0) {
    throw new Error(`${path.basename(command)} failed: ${result.stderr || result.stdout || result.error?.message || `exit ${result.status}`}`);
  }
  try {
    return JSON.parse(result.stdout.trim());
  } catch (error) {
    throw new Error(`Expected JSON from ${command}: ${error instanceof Error ? error.message : String(error)}\n${result.stdout}`);
  }
}

function assertUnavailable(command, env) {
  const where = process.env.SystemRoot
    ? path.join(process.env.SystemRoot, "System32", "where.exe")
    : "where";
  const result = spawnSync(where, [command], { cwd: installRoot, env, encoding: "utf8", windowsHide: true });
  if (!result.error && result.status === 0) {
    throw new Error(`Clean acceptance PATH unexpectedly exposes ${command}: ${result.stdout.trim()}`);
  }
  return true;
}
