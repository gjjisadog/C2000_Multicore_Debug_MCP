#!/usr/bin/env node
import { access, copyFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

const isolated = process.argv.includes("--isolated");
const entrypointArgument = process.argv.slice(2).find(argument => !argument.startsWith("--"));
const sourceEntrypoint = path.resolve(entrypointArgument ?? "dist/src/index.js");
const configuredTimeout = Number.parseInt(process.env.C2000_MCP_DOCTOR_TIMEOUT_MS ?? "10000", 10);
const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 10000;
const requiredTools = ["c2000_getServerHealth", "c2000_getEnvironment", "c2000_getToolContracts"];
let child;
let isolatedDirectory;
let entrypoint = sourceEntrypoint;

try {
  await access(sourceEntrypoint);
} catch {
  fail("RuntimeArtifactMissing", `Built MCP entrypoint does not exist: ${sourceEntrypoint}`, "Run npm run build before npm run doctor.");
}

if (isolated) {
  isolatedDirectory = await mkdtemp(path.join(os.tmpdir(), "c2000-mcp-doctor-"));
  entrypoint = path.join(isolatedDirectory, "c2000-mcp.js");
  await copyFile(sourceEntrypoint, entrypoint);
}

child = spawn(process.execPath, [entrypoint], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    C2000_MCP_ADAPTER: process.env.C2000_MCP_ADAPTER ?? "mock",
    C2000_MCP_TOOL_PROFILE: process.env.C2000_MCP_TOOL_PROFILE ?? "readonly",
    C2000_MCP_LOG_LEVEL: process.env.C2000_MCP_LOG_LEVEL ?? "error"
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
  process.stdout.write(`${JSON.stringify({
    ok: true,
    isolated,
    entrypoint,
    toolCount: names.length,
    requiredTools,
    health
  }, null, 2)}\n`);
} catch (error) {
  fail("McpHandshakeFailed", error instanceof Error ? error.message : String(error), "Run npm ci, npm run build, then npm run doctor. Inspect serverStderr for the failing startup phase.", stderr);
} finally {
  child.kill("SIGTERM");
  if (isolatedDirectory) await rm(isolatedDirectory, { recursive: true, force: true });
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
