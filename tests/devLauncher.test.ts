import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const launcher = path.resolve("scripts", "codex-dev-launcher.mjs");

describe("Codex development launcher", () => {
  test("finds the checkout independently of cwd and emits a stable source fingerprint", async () => {
    const result = await execFileAsync(process.execPath, [launcher, "--print-build-id"], { cwd: os.tmpdir() });
    expect(result.stdout.trim()).toMatch(/^[0-9a-f]{64}$/);

    const source = await readFile(launcher, "utf8");
    expect(source).toContain("C2000_MCP_DEV_MODE: \"1\"");
    expect(source).toContain("C2000_MCP_DEV_BUILD_ID: devBuildId");
    expect(source).toContain("src");
    expect(source).toContain('stdio: "inherit"');
    expect(source).toContain("SIGINT");
    expect(source).toContain("SIGTERM");
    expect(source).toContain("SIGHUP");
    expect(source).toContain('requireFromProject.resolve("tsx/cli")');
  });
});
