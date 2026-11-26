import type { z } from "zod";
import { afterEach, describe, expect, test } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveAdapterMode, resolveAdapterModeSync } from "../src/adapters/adapterResolution.js";
import { c2000McpConfigSchema, type C2000McpConfig } from "../src/config/config.schema.js";
import { defaultF28P65xCoreMap } from "../src/debug/types.js";

const originalEnv = { ...process.env };

function baseConfig(overrides: Partial<z.input<typeof c2000McpConfigSchema>> = {}): C2000McpConfig {
  return c2000McpConfigSchema.parse({
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
  });
}

describe("adapter resolution", () => {
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test("explicit mock ignores a CCS path", async () => {
    const config = baseConfig({ adapter: "mock", ccs: { installPath: "missing-ccs" } });
    await expect(resolveAdapterMode(config)).resolves.toEqual(
      expect.objectContaining({ mode: "mock", reason: expect.stringContaining("explicit mock") })
    );
    expect(resolveAdapterModeSync(config).mode).toBe("mock");
  });

  test.each(["auto", "ccs"] as const)("%s rejects a configured CCS path with no DSS launcher", async (adapter) => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "c2000-no-dss-"));
    const config = baseConfig({ adapter, ccs: { installPath: tempDir } });
    const expected = { code: "DssNotFound", details: expect.objectContaining({ ccsInstallPath: tempDir }) };

    await expect(resolveAdapterMode(config)).rejects.toMatchObject(expected);
    expect(() => resolveAdapterModeSync(config)).toThrow(expect.objectContaining(expected));
  });

  test("auto rejects an invalid CCS path set by the environment", async () => {
    process.env.C2000_MCP_CCS_INSTALL_PATH = path.join(tmpdir(), "missing-c2000-ccs");
    await expect(resolveAdapterMode(baseConfig())).rejects.toMatchObject({ code: "DssNotFound" });
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
    await expect(resolveAdapterMode(baseConfig({ adapter: "ccs", ccs: { installPath: tempDir } })))
      .resolves.toMatchObject({ mode: "ccs", reason: "explicit ccs adapter selection" });
  });

  test("sync auto path selects ccs when the DSS launcher exists", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "c2000-sync-with-dss-"));
    const dssDir = path.join(tempDir, "ccs_base", "scripting", "bin");
    await mkdir(dssDir, { recursive: true });
    await writeFile(path.join(dssDir, process.platform === "win32" ? "dss.bat" : "dss.sh"), "#!/bin/sh\n");

    expect(resolveAdapterModeSync(baseConfig({
      adapter: "auto",
      ccs: { scriptingMode: "auto", installPath: tempDir }
    }))).toEqual(
      expect.objectContaining({
        mode: "ccs",
        reason: expect.stringContaining("DSS launcher found")
      })
    );
  });
});
