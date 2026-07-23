import { afterEach, describe, expect, test } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveAdapterMode, resolveAdapterModeSync } from "../src/adapters/adapterResolution.js";
import type { C2000McpConfig } from "../src/config/config.schema.js";
import { defaultF28P65xCoreMap } from "../src/debug/types.js";

const originalEnv = { ...process.env };

function baseConfig(overrides: Partial<C2000McpConfig> = {}): C2000McpConfig {
  return {
    adapter: overrides.adapter ?? "auto",
    ccs: {
      scriptingMode: "auto",
      ...overrides.ccs
    },
    target: {
      name: "F28P65x",
      coreMap: defaultF28P65xCoreMap,
      ...overrides.target
    },
    diagnostics: {
      ...overrides.diagnostics
    },
    logging: {
      level: "info",
      ...overrides.logging
    }
  };
}

describe("adapter resolution", () => {
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test("explicit mock and ccs selections win over auto", async () => {
    await expect(resolveAdapterMode(baseConfig({ adapter: "mock" }))).resolves.toEqual(
      expect.objectContaining({ mode: "mock", reason: expect.stringContaining("explicit mock") })
    );
    await expect(resolveAdapterMode(baseConfig({ adapter: "ccs" }))).resolves.toEqual(
      expect.objectContaining({ mode: "ccs", reason: expect.stringContaining("explicit ccs") })
    );
  });

  test("auto mode uses mock when DSS launcher is missing", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "c2000-no-dss-"));
    const resolution = await resolveAdapterMode(baseConfig({
      adapter: "auto",
      ccs: { scriptingMode: "auto", installPath: tempDir }
    }));

    expect(resolution).toEqual(expect.objectContaining({
      mode: "mock",
      requested: "auto",
      reason: expect.stringContaining("DSS launcher not found")
    }));
  });

  test("auto mode selects ccs when DSS launcher exists", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "c2000-with-dss-"));
    const dssDir = path.join(tempDir, "ccs_base", "scripting", "bin");
    await mkdir(dssDir, { recursive: true });
    await writeFile(path.join(dssDir, process.platform === "win32" ? "dss.bat" : "dss.sh"), "#!/bin/sh\n");

    const resolution = await resolveAdapterMode(baseConfig({
      adapter: "auto",
      ccs: { scriptingMode: "auto", installPath: tempDir }
    }));

    expect(resolution).toEqual(expect.objectContaining({
      mode: "ccs",
      requested: "auto",
      reason: expect.stringContaining("DSS launcher found")
    }));
  });

  test("sync auto path defaults to mock without filesystem probe", () => {
    expect(resolveAdapterModeSync(baseConfig({ adapter: "auto" }))).toEqual(
      expect.objectContaining({
        mode: "mock",
        reason: expect.stringContaining("synchronous construction")
      })
    );
  });
});
