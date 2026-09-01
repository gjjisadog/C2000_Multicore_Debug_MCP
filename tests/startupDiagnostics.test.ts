import { describe, expect, test } from "vitest";
import { startupFailure, startupReady } from "../src/startupDiagnostics.js";

describe("startup diagnostics", () => {
  test("classifies dependency failures with an actionable repair", () => {
    const diagnostic = startupFailure("load-config", new Error("ERR_MODULE_NOT_FOUND: Cannot find module zod"));

    expect(diagnostic).toEqual(expect.objectContaining({
      level: "error",
      event: "c2000_mcp_startup_failed",
      phase: "load-config",
      code: "ConfigLoadFailed",
      remediation: "Run npm ci, npm run build, then npm run doctor."
    }));
  });

  test("reports a machine-readable ready event", () => {
    expect(startupReady({ bundled: true, toolProfile: "safe", toolSurfaceProfile: "agent", capabilityMode: "dynamic" })).toEqual(expect.objectContaining({
      level: "info",
      event: "c2000_mcp_ready",
      bundled: true,
      toolProfile: "safe",
      toolSurfaceProfile: "agent",
      capabilityMode: "dynamic"
    }));
  });
});
