import { describe, expect, test } from "vitest";
import type { C2000McpConfig } from "../src/config/config.schema.js";
import { createC2000McpRuntime } from "../src/server.js";

const config: C2000McpConfig = {
  adapter: "mock",
  ccs: { scriptingMode: "mock" },
  target: {
    name: "F28P65x",
    coreMap: [
      { coreId: 0, coreName: "C28xx_CPU1", corePattern: "C28xx_CPU1" },
      { coreId: 2, coreName: "C28xx_CPU2", corePattern: "C28xx_CPU2" }
    ]
  },
  logging: { level: "error" }
};

describe("server lifecycle", () => {
  test("runtime disposal is idempotent and closes all active logical sessions", async () => {
    const runtime = createC2000McpRuntime(config);
    const first = await runtime.manager.createDebugSession({ sessionName: "one" });
    const second = await runtime.manager.createDebugSession({ sessionName: "two" });

    const [left, right] = await Promise.all([runtime.dispose(), runtime.dispose()]);

    expect(left).toEqual(right);
    expect(left.closedSessionIds).toEqual([first.sessionId, second.sessionId]);
    await expect(runtime.manager.listCores(first.sessionId)).rejects.toMatchObject({ code: "SessionNotFound" });
    await expect(runtime.manager.listCores(second.sessionId)).rejects.toMatchObject({ code: "SessionNotFound" });
  });
});
