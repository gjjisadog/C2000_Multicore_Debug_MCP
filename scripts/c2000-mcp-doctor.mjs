#!/usr/bin/env node
import { access, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
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
  path.join(sourceRuntimeDirectory, "worker", "index.js")
]) {
  try {
    await access(requiredEntry);
  } catch {
    fail("RuntimeArtifactMissing", `Built runtime entrypoint does not exist: ${requiredEntry}`, "Run npm run build before npm run doctor.");
  }
}

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
    health,
    ...(workerCheck ? { workerCheck } : {})
  }, null, 2)}\n`);
} catch (error) {
  fail("McpHandshakeFailed", error instanceof Error ? error.message : String(error), "Run npm ci, npm run build, then npm run doctor. Inspect serverStderr for the failing startup phase.", stderr);
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
