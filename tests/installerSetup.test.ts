import { describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildCodexMcpAddArgs,
  createInstalledConfig,
  parseSetupArgs,
  runSetup,
  validateRuntimeManifest
} from "../src/installer/setup.js";

describe("one-command installer", () => {
  test("parses safe cross-platform setup defaults and overrides", () => {
    expect(parseSetupArgs(["install"])).toEqual(expect.objectContaining({
      serverName: "c2000-multicore",
      scope: "user",
      register: true,
      installSkill: true,
      doctor: true
    }));
    expect(parseSetupArgs([
      "install",
      "--scope", "project",
      "--workspace", "D:/firmware",
      "--config", "custom.json",
      "--no-skill",
      "--json"
    ])).toEqual(expect.objectContaining({
      scope: "project",
      workspace: "D:/firmware",
      configPath: "custom.json",
      installSkill: false,
      json: true
    }));
  });

  test("rejects a package built for a different OS, architecture, or Node ABI", () => {
    const manifest = {
      version: "0.5.0",
      platform: "darwin",
      arch: "arm64",
      nodeModulesAbi: "127",
      entrypoints: { proxy: "index.js" }
    };
    expect(() => validateRuntimeManifest(manifest, {
      platform: "win32",
      arch: "x64",
      nodeModulesAbi: "127"
    })).toThrow(/darwin-arm64.*win32-x64/);
    expect(() => validateRuntimeManifest(manifest, {
      platform: "darwin",
      arch: "arm64",
      nodeModulesAbi: "115"
    })).toThrow(/ABI 127.*ABI 115/);
  });

  test("builds the documented Codex CLI registration command without a shell", () => {
    expect(buildCodexMcpAddArgs(
      "c2000-multicore",
      "C:\\Program Files\\c2000\\index.js",
      "C:\\Users\\me\\c2000.json",
      "C:\\Program Files\\nodejs\\node.exe"
    )).toEqual([
      "mcp", "add", "c2000-multicore",
      "--env", "C2000_MCP_CONFIG=C:\\Users\\me\\c2000.json",
      "--",
      "C:\\Program Files\\nodejs\\node.exe",
      "C:\\Program Files\\c2000\\index.js"
    ]);
  });

  test("generates an absolute durable runtime configuration", () => {
    const workspace = path.resolve("firmware");
    const runtime = path.resolve("runtime");
    const config = createInstalledConfig(workspace, runtime) as {
      filesystem: { allowedReadRoots: string[] };
      daemon: { runtimeDir: string };
      storage: { sqlitePath: string };
    };
    expect(config.filesystem.allowedReadRoots).toEqual([workspace]);
    expect(config.daemon.runtimeDir).toBe(runtime);
    expect(config.storage.sqlitePath).toBe(path.join(runtime, "c2000-debugd.sqlite"));
  });

  test("falls back to an idempotent managed Codex config block when the CLI is unavailable", async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), "c2000-installer-test-"));
    try {
      const packageRoot = path.join(temporary, "package");
      await mkdir(path.join(packageRoot, "dist", "src", "installer"), { recursive: true });
      await mkdir(path.join(packageRoot, "scripts"), { recursive: true });
      await writeFile(path.join(packageRoot, "dist", "src", "index.js"), "");
      await writeFile(path.join(packageRoot, "dist", "src", "installer", "index.js"), "");
      await writeFile(path.join(packageRoot, "scripts", "c2000-mcp-doctor.mjs"), "");
      await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ name: "c2000-multicore-mcp" }));
      await writeFile(path.join(packageRoot, "dist", "src", "runtime-manifest.json"), JSON.stringify({
        version: "9.9.9",
        platform: process.platform,
        arch: process.arch,
        nodeModulesAbi: process.versions.modules,
        entrypoints: { proxy: "index.js" }
      }));
      const unavailable = (() => ({
        pid: 0,
        output: [],
        stdout: "",
        stderr: "",
        status: null,
        signal: null,
        error: Object.assign(new Error("not found"), { code: "ENOENT" })
      })) as unknown as typeof spawnSync;
      const options = parseSetupArgs([
        "install",
        "--install-root", path.join(temporary, "install"),
        "--workspace", temporary,
        "--no-skill",
        "--no-doctor"
      ]);
      const result = await runSetup(options, {
        packageRoot,
        homeDirectory: path.join(temporary, "home"),
        cwd: temporary,
        spawn: unavailable
      });
      expect(result.registration).toBe("config-file");
      const configToml = await readFile(result.codexConfigPath!, "utf8");
      expect(configToml).toContain("# BEGIN c2000-multicore-mcp managed block");
      expect(configToml).toContain("[mcp_servers.c2000-multicore]");
      expect(configToml).toContain("C2000_MCP_CONFIG");
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});
