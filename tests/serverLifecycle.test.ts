import { describe, expect, test } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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
  diagnostics: {},
  logging: { level: "error" }
};

describe("server lifecycle", () => {
  test("runtime disposal is idempotent and closes all active logical sessions", async () => {
    const runtime = await createC2000McpRuntime(config);
    const first = await runtime.manager.createDebugSession({ sessionName: "one" });
    const second = await runtime.manager.createDebugSession({ sessionName: "two" });

    const [left, right] = await Promise.all([runtime.dispose(), runtime.dispose()]);

    expect(left).toEqual(right);
    expect(left.closedSessionIds).toEqual([first.sessionId, second.sessionId]);
    await expect(runtime.manager.listCores(first.sessionId)).rejects.toMatchObject({ code: "SessionNotFound" });
    await expect(runtime.manager.listCores(second.sessionId)).rejects.toMatchObject({ code: "SessionNotFound" });
  });

  test("uses configured firmware roots for host-only program discovery", async () => {
    const firmwareRoot = await mkdtemp(path.join(tmpdir(), "c2000-configured-program-root-"));
    await writeFile(path.join(firmwareRoot, "hybrid30k_cpu1_ram_cpu1.out"), "cpu1");
    await writeFile(path.join(firmwareRoot, "hybrid30k_cpu2_ram_cpu2.out"), "cpu2");
    const runtime = await createC2000McpRuntime({ ...config, programSearchRoots: [firmwareRoot] });
    try {
      const result = await runtime.toolInvoker.invokeTool("c2000_discoverAcceptancePrograms", {});
      expect(result).toMatchObject({
        success: true,
        cpu1: { selected: path.join(firmwareRoot, "hybrid30k_cpu1_ram_cpu1.out"), source: "discovered" },
        cpu2: { selected: path.join(firmwareRoot, "hybrid30k_cpu2_ram_cpu2.out"), source: "discovered" }
      });
    } finally {
      await runtime.dispose();
      await rm(firmwareRoot, { recursive: true, force: true });
    }
  });
});
