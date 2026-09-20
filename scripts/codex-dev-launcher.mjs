#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readdir, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const launcherPath = fileURLToPath(import.meta.url);

export function resolveProjectRoot() {
  return path.resolve(path.dirname(launcherPath), "..");
}

export async function computeDevBuildId(projectRoot = resolveProjectRoot()) {
  const files = await fingerprintFiles(projectRoot);
  const hash = createHash("sha256");
  for (const relativePath of files) {
    hash.update(relativePath).update("\0").update(await readFile(path.join(projectRoot, relativePath))).update("\0");
  }
  return hash.digest("hex");
}

export async function main(argv = process.argv.slice(2)) {
  const projectRoot = resolveProjectRoot();
  const devBuildId = await computeDevBuildId(projectRoot);
  if (argv.includes("--print-build-id")) {
    process.stdout.write(`${devBuildId}\n`);
    return;
  }

  const packageJson = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
  const requireFromProject = createRequire(path.join(projectRoot, "package.json"));
  const tsxCli = requireFromProject.resolve("tsx/cli");
  const environment = {
    ...process.env,
    C2000_MCP_DEV_MODE: "1",
    C2000_MCP_DEV_BUILD_ID: devBuildId,
    C2000_MCP_REPOSITORY_ROOT: projectRoot,
    C2000_MCP_PACKAGE_VERSION: String(packageJson.version ?? "")
  };
  const child = spawn(process.execPath, [tsxCli, path.join(projectRoot, "src", "index.ts")], {
    cwd: projectRoot,
    env: environment,
    stdio: "inherit",
    windowsHide: false
  });
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
  const signalHandlers = new Map();
  const forwardSignal = signal => {
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill(signal); } catch { /* The child may have exited between the checks. */ }
    }
  };
  signals.forEach(signal => {
    const handler = () => forwardSignal(signal);
    signalHandlers.set(signal, handler);
    process.once(signal, handler);
  });
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  }).then(({ code, signal }) => {
    if (signal) {
      process.exitCode = 128 + signalExitCode(signal);
    } else {
      process.exitCode = code ?? 1;
    }
  }).finally(() => {
    signals.forEach(signal => process.off(signal, signalHandlers.get(signal)));
  });
}

async function fingerprintFiles(projectRoot) {
  const sourceFiles = await collectTypeScriptFiles(path.join(projectRoot, "src"), projectRoot);
  return [...new Set([
    ...sourceFiles,
    "package.json",
    "package-lock.json",
    "config/runtime-manifest.json"
  ])].sort();
}

async function collectTypeScriptFiles(directory, projectRoot) {
  const entries = (await readdir(directory, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const files = [];
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectTypeScriptFiles(absolutePath, projectRoot));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(path.relative(projectRoot, absolutePath).split(path.sep).join("/"));
    }
  }
  return files;
}

function signalExitCode(signal) {
  return { SIGINT: 2, SIGTERM: 15, SIGHUP: 1 }[signal] ?? 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(launcherPath)) {
  main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
