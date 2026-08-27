#!/usr/bin/env node
import { access, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const isolated = process.argv.includes("--isolated");
const verifyWorker = process.argv.includes("--verify-worker");
const entrypointArgument = process.argv.slice(2).find(argument => !argument.startsWith("--"));
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceEntrypoint = path.resolve(entrypointArgument ?? path.join(projectRoot, "dist", "src", "index.js"));
const sourceRuntimeDirectory = path.dirname(sourceEntrypoint);
const configuredTimeout = Number.parseInt(process.env.C2000_MCP_DOCTOR_TIMEOUT_MS ?? "10000", 10);
const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 10000;
const requiredTools = ["c2000_getServerHealth", "c2000_getEnvironment", "c2000_getToolContracts"];
let child;
let isolatedDirectory;
let executionDirectory;
let daemonRuntimeDirectory;
let doctorConfigPath;
let entrypoint = sourceEntrypoint;

for (const requiredEntry of [
  sourceEntrypoint,
  path.join(sourceRuntimeDirectory, "daemon", "index.js"),
  path.join(sourceRuntimeDirectory, "worker", "index.js"),
  path.join(sourceRuntimeDirectory, "can-worker", "index.js"),
  path.join(sourceRuntimeDirectory, "installer", "runtime-check.js")
]) {
  try {
    await access(requiredEntry);
  } catch {
    fail("RuntimeArtifactMissing", `Built runtime entrypoint does not exist: ${requiredEntry}`, "Run npm run build before npm run doctor.");
  }
}
const runtimeDetails = await verifyRuntimeManifest(sourceRuntimeDirectory);

if (isolated) {
  isolatedDirectory = await mkdtemp(path.join(os.tmpdir(), "c2000-mcp-doctor-"));
  // Preserve the published dist/src layout so runtime sibling discovery uses
  // the same paths as a package or global installation.
  const isolatedRuntimeDirectory = path.join(isolatedDirectory, "dist", "src");
  await cp(sourceRuntimeDirectory, isolatedRuntimeDirectory, { recursive: true });
  await writeFile(path.join(isolatedDirectory, "package.json"), `${JSON.stringify({ type: "module" })}\n`);
  entrypoint = path.join(isolatedRuntimeDirectory, "index.js");
}

// A fresh caller directory proves the executable lookup is independent of the
// MCP host's workspace and prevents doctor from attaching to a user daemon.
executionDirectory = await mkdtemp(path.join(os.tmpdir(), "c2000-mcp-doctor-cwd-"));
daemonRuntimeDirectory = path.join(executionDirectory, "daemon-runtime");
if (verifyWorker) {
  doctorConfigPath = path.join(executionDirectory, "doctor-worker-config.json");
  await writeFile(doctorConfigPath, `${JSON.stringify({
    adapter: "mock",
    ccs: { scriptingMode: "mock" },
    target: { name: "F28P65x", coreMap: [{ coreId: 0, coreName: "C28xx_CPU1" }] },
    boards: [{
      boardId: "doctor-board",
      probeSerial: "DOCTOR-MOCK-PROBE",
      device: "F28P65x",
      ccxmlPath: path.join(executionDirectory, "doctor-mock.ccxml"),
      tags: ["doctor"]
    }]
  }, null, 2)}\n`);
}

child = spawn(process.execPath, [entrypoint], {
  cwd: executionDirectory,
  env: {
    ...process.env,
    C2000_MCP_ADAPTER: process.env.C2000_MCP_ADAPTER ?? "mock",
    C2000_MCP_TOOL_PROFILE: process.env.C2000_MCP_TOOL_PROFILE ?? "readonly",
    C2000_MCP_LOG_LEVEL: process.env.C2000_MCP_LOG_LEVEL ?? "error",
    C2000_MCP_DAEMON_RUNTIME_DIR: daemonRuntimeDirectory,
    ...(doctorConfigPath ? { C2000_MCP_CONFIG: doctorConfigPath } : {})
  },
  stdio: ["pipe", "pipe", "pipe"]
});

let stdoutBuffer = "";
let stderr = "";
let nextId = 1;
const pending = new Map();

child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stderr.on("data", chunk => { stderr += chunk; });
child.stdout.on("data", chunk => {
  stdoutBuffer += chunk;
  while (true) {
    const newline = stdoutBuffer.indexOf("\n");
    if (newline < 0) break;
    const line = stdoutBuffer.slice(0, newline).replace(/\r$/, "");
    stdoutBuffer = stdoutBuffer.slice(newline + 1);
    if (!line) continue;
    try {
      const message = JSON.parse(line);
      if (message.id !== undefined && pending.has(message.id)) {
        const waiter = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
        else waiter.resolve(message.result);
      }
    } catch (error) {
      rejectAll(error);
    }
  }
});
child.once("exit", (code, signal) => rejectAll(new Error(`MCP process exited before doctor completed (code=${code}, signal=${signal}).`)));
child.once("error", rejectAll);

try {
  await request("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "c2000-mcp-doctor", version: "1.0.0" }
  });
  notify("notifications/initialized", {});
  const listed = await request("tools/list", {});
  const names = listed.tools.map(tool => tool.name);
  const missingTools = requiredTools.filter(name => !names.includes(name));
  if (missingTools.length > 0) {
    throw new Error(`Required tools are missing: ${missingTools.join(", ")}`);
  }
  const healthResult = await request("tools/call", { name: "c2000_getServerHealth", arguments: {} });
  const health = healthResult.structuredContent ?? JSON.parse(healthResult.content?.[0]?.text ?? "{}");
  if (health.success !== true || health.status !== "ready") {
    throw new Error(`Server health check failed: ${JSON.stringify(health)}`);
  }
  if (health.runtime?.bundled !== true) {
    throw new Error("The active MCP artifact is not self-contained (runtime.bundled !== true). Run npm run build.");
  }
  if (runtimeDetails.bundledNode && health.runtime?.bundledNode !== true) {
    throw new Error(`The active MCP artifact was not launched by its private Node runtime: ${JSON.stringify(health.runtime)}`);
  }
  let workerCheck;
  if (verifyWorker) {
    const boardResult = await request("tools/call", { name: "c2000_listBoards", arguments: {} });
    const boardPayload = boardResult.structuredContent ?? JSON.parse(boardResult.content?.[0]?.text ?? "{}");
    const board = Array.isArray(boardPayload.boards) ? boardPayload.boards.find(item => item?.boardId === "doctor-board") : undefined;
    if (boardPayload.success !== true || board?.status !== "READY" || typeof board.currentWorkerInstanceId !== "string") {
      throw new Error(`Worker did not become ready from the runtime artifact: ${JSON.stringify(boardPayload)}`);
    }
    workerCheck = { boardId: board.boardId, status: board.status, workerInstanceId: board.currentWorkerInstanceId };
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    isolated,
    entrypoint,
    toolCount: names.length,
    requiredTools,
    runtime: runtimeDetails,
    health,
    ...(workerCheck ? { workerCheck } : {})
  }, null, 2)}\n`);
} catch (error) {
  const remediation = runtimeDetails?.bundledNode
    ? "Reinstall the Windows offline bundle and re-run its private-runtime doctor. Inspect serverStderr for the failing startup phase."
    : "Run npm ci, npm run build, then npm run doctor. Inspect serverStderr for the failing startup phase.";
  fail("McpHandshakeFailed", error instanceof Error ? error.message : String(error), remediation, stderr);
} finally {
  child.kill("SIGTERM");
  await stopDoctorDaemon(daemonRuntimeDirectory);
  if (executionDirectory) await removeDirectoryWhenUnlocked(executionDirectory);
  if (isolatedDirectory) await removeDirectoryWhenUnlocked(isolatedDirectory);
}

function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out after ${timeoutMs} ms waiting for ${method}.`));
    }, timeoutMs);
    pending.set(id, {
      resolve: value => { clearTimeout(timer); resolve(value); },
      reject: error => { clearTimeout(timer); reject(error); }
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

function notify(method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
}

function rejectAll(error) {
  for (const waiter of pending.values()) waiter.reject(error);
  pending.clear();
}

function fail(code, message, remediation, serverStderr = "") {
  process.stderr.write(`${JSON.stringify({ ok: false, code, message, remediation, serverStderr: serverStderr.trim() }, null, 2)}\n`);
  child?.kill("SIGTERM");
  process.exit(1);
}

async function verifyRuntimeManifest(runtimeDirectory) {
  const manifestPath = path.join(runtimeDirectory, "runtime-manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    fail("RuntimeNativeBindingMismatch", `Runtime manifest is missing or invalid: ${manifestPath}`, "Run npm run build on the target platform.");
  }
  const manifestPlatform = manifest.runtime?.platform ?? manifest.platform;
  const manifestArch = manifest.runtime?.arch ?? manifest.arch;
  const manifestAbi = manifest.runtime?.modulesAbi ?? manifest.nodeModulesAbi;
  const bundledNode = manifest.runtime?.bundledNode === true;
  if (bundledNode && (manifest.runtime?.name !== "node"
    || !/^\d+\.\d+\.\d+$/.test(String(manifest.runtime?.version))
    || manifest.runtime?.nodeVersion !== `v${manifest.runtime?.version}`
    || manifest.runtime?.modulesAbi !== manifest.nodeModulesAbi
    || manifest.runtime?.executable !== "runtime/node.exe")) {
    fail("RuntimeManifestInvalid", "Bundled runtime metadata is incomplete or inconsistent.", "Reinstall the Windows offline bundle.");
  }
  if (manifestPlatform !== process.platform) {
    fail("RuntimePlatformMismatch", `Runtime was built for ${manifestPlatform}, current platform is ${process.platform}.`, "Rebuild the runtime on this platform.");
  }
  if (manifestArch !== process.arch) {
    fail("RuntimeArchitectureMismatch", `Runtime was built for ${manifestArch}, current architecture is ${process.arch}.`, "Rebuild the runtime for this architecture.");
  }
  if (String(manifestAbi) !== String(process.versions.modules)) {
    fail("RuntimeAbiMismatch", `Runtime ABI ${manifestAbi} does not match current Node ABI ${process.versions.modules}.`, "Use the private Node runtime from the offline bundle or rebuild the developer artifact.");
  }
  const expectedNodePath = bundledNode ? findBundledNodePath(manifestPath) : undefined;
  if (bundledNode && !expectedNodePath) {
    fail("RuntimeBundledNodeMissing", `The private Node executable is missing beside ${manifestPath}.`, "Reinstall the complete Windows offline bundle.");
  }
  if (bundledNode && !samePath(process.execPath, expectedNodePath)) {
    fail("RuntimeBundledNodeMismatch", `The MCP was launched by ${process.execPath}, expected ${expectedNodePath}.`, "Register the MCP with the installed runtime\\node.exe.");
  }
  if (bundledNode && normalizeNodeVersion(manifest.runtime.nodeVersion) !== normalizeNodeVersion(process.version)) {
    fail("RuntimeVersionMismatch", `Runtime version ${manifest.runtime.nodeVersion} does not match ${process.version}.`, "Reinstall the fixed Windows runtime.");
  }
  const bindings = manifest.nativeBindings ?? [];
  if (bindings.length === 0) {
    fail(
      "RuntimeNativeBindingMismatch",
      "The runtime manifest declares no native bindings.",
      bundledNode ? "Reinstall the Windows offline bundle." : "Run npm run build with the native dependencies installed."
    );
  }
  const sqliteBinding = bindings.find(binding => binding.name === "better_sqlite3.node");
  if (!sqliteBinding || String(sqliteBinding.abi) !== String(manifestAbi)) {
    fail(
      "RuntimeNativeBindingMismatch",
      `better_sqlite3.node ABI ${sqliteBinding?.abi ?? "missing"} does not match runtime ABI ${manifestAbi}.`,
      bundledNode ? "Reinstall the Windows offline bundle." : "Run npm run build with the matching developer Node."
    );
  }
  for (const binding of bindings) {
    try {
      const bindingPath = path.resolve(runtimeDirectory, binding.path);
      if (!isPathInside(bindingPath, runtimeDirectory)) throw new Error("binding path escapes runtime directory");
      const data = await readFile(bindingPath);
      const actual = createHash("sha256").update(data).digest("hex");
      if (actual !== binding.sha256) throw new Error(`SHA-256 ${actual} != ${binding.sha256}`);
    } catch (error) {
      fail(
        "RuntimeNativeBindingMismatch",
        `Native binding verification failed for ${binding.path}: ${error instanceof Error ? error.message : String(error)}`,
        bundledNode ? "Reinstall the Windows offline bundle." : "Run npm ci and npm run build on this platform."
      );
    }
  }
  const runtimeCheckRelative = manifest.entrypoints?.runtimeCheck ?? "installer/runtime-check.js";
  const runtimeCheckPath = path.resolve(runtimeDirectory, runtimeCheckRelative);
  if (!isPathInside(runtimeCheckPath, runtimeDirectory)) {
    fail("RuntimeNativeBindingMismatch", `Runtime check path escapes the runtime directory: ${runtimeCheckRelative}`, "Rebuild or reinstall the matching runtime.");
  }
  const runtimeCheck = spawnSync(process.execPath, [runtimeCheckPath], { cwd: runtimeDirectory, encoding: "utf8", windowsHide: true });
  if (runtimeCheck.error || runtimeCheck.status !== 0) {
    fail("RuntimeNativeBindingMismatch", `better-sqlite3 :memory: verification failed: ${runtimeCheck.stderr || runtimeCheck.stdout || runtimeCheck.error?.message || runtimeCheck.status}`, "Rebuild or reinstall the matching native runtime.");
  }
  let sqliteMemory = false;
  try { sqliteMemory = JSON.parse(runtimeCheck.stdout.trim()).sqliteMemory === true; } catch { /* child health will provide the detailed failure */ }
  return {
    bundledNode,
    nodePath: process.execPath,
    expectedNodePath: expectedNodePath ?? null,
    nodeVersion: process.version,
    nodeModulesAbi: process.versions.modules,
    platform: process.platform,
    arch: process.arch,
    nativeBindingsValid: true,
    sqliteMemory,
    runtimeManifestPath: manifestPath,
    declaredRuntime: manifest.runtime ?? null
  };
}

function findBundledNodePath(manifestPath) {
  const packageRoot = path.dirname(path.dirname(path.dirname(manifestPath)));
  const nodeName = process.platform === "win32" ? "node.exe" : "node";
  const candidates = [
    path.join(packageRoot, "runtime", nodeName),
    path.join(path.dirname(packageRoot), "runtime", nodeName),
    path.join(path.dirname(path.dirname(packageRoot)), "runtime", nodeName)
  ];
  return candidates.find(candidate => pathExists(candidate));
}

function pathExists(filePath) {
  return existsSync(filePath);
}

function samePath(left, right) { return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase(); }
function normalizeNodeVersion(value) { return String(value).trim().replace(/^v/, ""); }
function isPathInside(child, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function stopDoctorDaemon(runtimeDirectory) {
  if (!runtimeDirectory) return;
  try {
    const instance = JSON.parse(await readFile(path.join(runtimeDirectory, "debugd-instance.json"), "utf8"));
    if (typeof instance.pid === "number" && instance.pid > 0) {
      try {
        process.kill(instance.pid, "SIGTERM");
        await waitForProcessExit(instance.pid);
      } catch {
        // The doctor-owned daemon already exited.
      }
    }
  } catch {
    // The daemon may fail before it writes an instance file.
  }
}

async function waitForProcessExit(pid, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await delay(50);
    } catch {
      return;
    }
  }
}

async function removeDirectoryWhenUnlocked(directory) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await rm(directory, { recursive: true, force: true, maxRetries: 1, retryDelay: 50 });
      return;
    } catch (error) {
      if (attempt === 19) throw error;
      await delay(100);
    }
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
