import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { loadConfig } from "../src/config/config.loader.js";
import { ensureDaemon, launchDetachedDaemon } from "../src/daemon/DaemonBootstrap.js";
import { discoverDaemonInstance } from "../src/proxy/DaemonDiscovery.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

describe("development daemon upgrade", () => {
  test("replaces a daemon with a changed devBuildId through authenticated graceful shutdown", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "c2000-daemon-dev-upgrade-"));
    directories.push(directory);
    const runtimeDir = path.join(directory, "runtime");
    const configPath = path.join(directory, "config.json");
    await writeFile(configPath, JSON.stringify({
      adapter: "mock",
      ccs: { scriptingMode: "mock" },
      target: { name: "F28P65x", coreMap: [{ coreId: 0, coreName: "C28xx_CPU1" }] },
      logging: { level: "error" },
      daemon: { enabled: true, host: "127.0.0.1", port: 0, runtimeDir, autoStart: true, startupTimeoutMs: 5_000 },
      storage: { sqlitePath: path.join(runtimeDir, "debugd.sqlite"), wal: true },
      scheduler: { maxParallelBoards: 1, pollIntervalMs: 10 },
      boards: []
    }, null, 2));
    const config = await loadConfig(configPath);
    const previousEnvironment = {
      config: process.env.C2000_MCP_CONFIG,
      mode: process.env.C2000_MCP_DEV_MODE,
      buildId: process.env.C2000_MCP_DEV_BUILD_ID
    };
    let oldPid: number | undefined;
    let newPid: number | undefined;
    try {
      await launchDetachedDaemon({
        cwd: directory,
        preferSource: true,
        env: {
          C2000_MCP_CONFIG: configPath,
          C2000_MCP_DEV_MODE: "1",
          C2000_MCP_DEV_BUILD_ID: "old-source"
        }
      });
      const old = await waitFor(() => discoverDaemonInstance(config).catch(() => undefined));
      oldPid = old.instance.pid;

      process.env.C2000_MCP_CONFIG = configPath;
      process.env.C2000_MCP_DEV_MODE = "1";
      process.env.C2000_MCP_DEV_BUILD_ID = "new-source";
      const replacement = await ensureDaemon(config);
      newPid = replacement.instance.pid;

      expect(replacement.instance.instanceId).not.toBe(old.instance.instanceId);
      expect(replacement.compatibility.compatible).toBe(true);
      expect(replacement.instance.runtimeIdentity?.devBuildId).toBe("new-source");
    } finally {
      if (!newPid) {
        const active = await discoverDaemonInstance(config).catch(() => undefined);
        if (active) newPid = active.instance.pid;
      }
      if (newPid) await stopProcess(newPid);
      else if (oldPid) await stopProcess(oldPid);
      restoreEnvironment(previousEnvironment);
    }
  }, 30_000);
});

async function waitFor<T>(read: () => Promise<T | undefined>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("timed out waiting for development daemon");
}

async function stopProcess(pid: number): Promise<void> {
  try { process.kill(pid, "SIGTERM"); } catch { return; }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await new Promise(resolve => setTimeout(resolve, 50));
    } catch {
      return;
    }
  }
  throw new Error(`daemon process ${pid} did not stop`);
}

function restoreEnvironment(previous: { config?: string; mode?: string; buildId?: string }): void {
  restore("C2000_MCP_CONFIG", previous.config);
  restore("C2000_MCP_DEV_MODE", previous.mode);
  restore("C2000_MCP_DEV_BUILD_ID", previous.buildId);
}

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
