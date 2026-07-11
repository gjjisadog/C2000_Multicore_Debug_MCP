import { afterEach, describe, expect, test } from "vitest";
import { loadConfig } from "../src/config/config.loader.js";
import type { TiEnvironmentResolution } from "../src/config/tiPaths.js";

const originalEnv = { ...process.env };

describe("loadConfig", () => {
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test("loads DSS timeout from C2000_MCP_DSS_TIMEOUT_MS", async () => {
    delete process.env.C2000_MCP_CONFIG;
    process.env.C2000_MCP_DSS_TIMEOUT_MS = "60000";

    const config = await loadConfig();

    expect(config.ccs.dssTimeoutMs).toBe(60000);
  });

  test("fills missing TI paths from validated discovery", async () => {
    delete process.env.C2000_MCP_CCS_INSTALL_PATH;
    delete process.env.C2000_MCP_C2000WARE_PATH;
    delete process.env.C2000_MCP_CCXML_PATH;
    const resolved: TiEnvironmentResolution = {
      ccs: { path: "/resolved/ccs", version: "21.0.0", source: "discovered", valid: true },
      c2000Ware: { path: "/resolved/C2000Ware", version: "26.1.0.0", source: "discovered", valid: true },
      ccxml: { path: "/resolved/target.ccxml", source: "derived", valid: true },
      attempts: []
    };

    const config = await loadConfig(undefined, { resolveTiEnvironment: async () => resolved });

    expect(config.ccs.installPath).toBe("/resolved/ccs");
    expect(config.ccs.c2000WarePath).toBe("/resolved/C2000Ware");
    expect(config.ccs.ccxmlPath).toBe("/resolved/target.ccxml");
  });

  test("environment overrides are passed as explicit discovery inputs", async () => {
    process.env.C2000_MCP_CCS_INSTALL_PATH = "/env/ccs";
    process.env.C2000_MCP_C2000WARE_PATH = "/env/C2000Ware";
    process.env.C2000_MCP_CCXML_PATH = "/env/target.ccxml";
    let received: unknown;

    await loadConfig(undefined, { resolveTiEnvironment: async (options = {}) => {
      received = options;
      return {
        ccs: { path: options.ccsInstallPath, source: "explicit", valid: true },
        c2000Ware: { path: options.c2000WarePath, source: "explicit", valid: true },
        ccxml: { path: options.ccxmlPath, source: "explicit", valid: true },
        attempts: []
      };
    } });

    expect(received).toMatchObject({
      ccsInstallPath: "/env/ccs",
      c2000WarePath: "/env/C2000Ware",
      ccxmlPath: "/env/target.ccxml"
    });
  });
});
