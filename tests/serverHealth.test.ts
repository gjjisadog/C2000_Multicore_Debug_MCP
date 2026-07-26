import { describe, expect, test } from "vitest";
import { buildServerHealth, isBundledRuntime } from "../src/runtimeInfo.js";
import { loadConfig } from "../src/config/config.loader.js";

describe("server runtime health", () => {
  test("reports runtime and registration state without target access", async () => {
    const config = await loadConfig(undefined, {
      resolveTiEnvironment: async () => ({
        ccs: { source: "unresolved", valid: false },
        c2000Ware: { source: "unresolved", valid: false },
        ccxml: { source: "unresolved", valid: false },
        attempts: []
      })
    });
    const health = buildServerHealth(config, "2026-07-11T00:00:00.000Z", ["c2000_getServerHealth"]);

    expect(health).toEqual(expect.objectContaining({
      status: "ready",
      server: { name: "c2000-multicore-mcp", version: "0.6.1" },
      tools: { registeredCount: 1, registeredNames: ["c2000_getServerHealth"] }
    }));
    expect(health.runtime.bundled).toBe(isBundledRuntime());
    expect(health.configuration.pathsConfigured).toEqual({
      ccsInstallPath: false,
      c2000WarePath: false,
      ccxmlPath: false,
      workspacePath: false
    });
  });
});
