import { afterEach, describe, expect, test } from "vitest";
import { loadConfig } from "../src/config/config.loader.js";

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
});
