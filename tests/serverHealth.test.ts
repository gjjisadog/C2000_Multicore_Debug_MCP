import { describe, expect, test } from "vitest";
import { buildServerHealth, isBundledRuntime, runtimeBuildInfo } from "../src/runtimeInfo.js";
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
      server: { name: "c2000-multicore-mcp", version: "0.7.0" },
      tools: expect.objectContaining({ registeredCount: 1, registeredNames: ["c2000_getServerHealth"] })
    }));
    expect(health.runtime.bundled).toBe(isBundledRuntime());
    expect(health.runtime.build).toEqual(runtimeBuildInfo());
    expect(Object.values(health.configuration.pathsConfigured).every(value => typeof value === "boolean")).toBe(true);
    expect(health.configuration.profile).toEqual(expect.objectContaining({
      effective: config.toolProfile,
      appliedAt: "2026-07-11T00:00:00.000Z"
    }));
    expect(health.configuration.toolSurfaceProfile).toBe(config.toolSurfaceProfile);
    expect(health.configuration.capabilityMode).toBe("dynamic");
    expect(health.configuration.activeCapabilityCount).toBe(0);
    expect(health.tools.activeCapabilityCount).toBe(0);
    expect(health.configuration.surfaceProfile).toEqual(expect.objectContaining({
      effective: config.toolSurfaceProfile,
      appliedAt: "2026-07-11T00:00:00.000Z"
    }));
    expect(health.configuration.reload).toEqual(expect.objectContaining({
      supported: false,
      daemonRestartRequired: false,
      frontendReconnectRequired: true
    }));

    const mixedRuntimeHealth = buildServerHealth(config, "2026-07-11T00:00:00.000Z", [], { runtimeVersionMismatch: true });
    expect(mixedRuntimeHealth.configuration.runtimeVersionMismatch).toBe(true);
    expect(mixedRuntimeHealth.tools.runtimeVersionMismatch).toBe(true);
  });
});
