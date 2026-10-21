import { describe, expect, test, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { c2000McpConfigSchema } from "../src/config/config.schema.js";
import { createC2000McpRuntime } from "../src/server.js";
import { createC2000McpProxyRuntime } from "../src/proxy/index.js";
import { C2000_INVOCATION_SCOPE, C2000_SERVER_INSTRUCTIONS } from "../src/mcp/invocationScope.js";
import { c2000ToolDefinitions } from "../src/mcp/tools.js";

vi.mock("../src/daemon/DaemonBootstrap.js", () => ({
  ensureDaemon: vi.fn(async () => ({ client: { request: vi.fn() } }))
}));

const config = c2000McpConfigSchema.parse({
  adapter: "mock",
  ccs: { scriptingMode: "mock" },
  target: {
    name: "F28P65x",
    coreMap: [{ coreId: 0, coreName: "C28xx_CPU1", corePattern: "C28xx_CPU1" }]
  },
  logging: { level: "error" }
});

describe("MCP invocation scope", () => {
  test.each([
    ["direct", createC2000McpRuntime],
    ["proxy", createC2000McpProxyRuntime]
  ] as const)("%s publishes scope at initialization and on every visible tool", async (_name, createRuntime) => {
    const runtime = await createRuntime(config);
    const client = new Client({ name: "scope-test", version: "test" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await runtime.server.connect(serverTransport);
      await client.connect(clientTransport);
      expect(client.getInstructions()).toBe(C2000_SERVER_INSTRUCTIONS);
      expect(client.getInstructions()).toContain("do not trigger environment, health, board, or target preflight");
      const { tools } = await client.listTools();
      expect(tools.length).toBeGreaterThan(0);
      for (const tool of tools) {
        expect(tool.description, tool.name).toMatch(/^Use only when the user explicitly requests/);
      }
      expect(tools.map(tool => tool.name)).toContain("c2000_launchAndRunIpcAcceptance");
    } finally {
      await client.close();
      await runtime.server.close();
      await runtime.dispose();
    }
  });

  test("advanced and compatibility definitions retain the same invocation boundary", () => {
    for (const tool of c2000ToolDefinitions) {
      expect(tool.description.startsWith(C2000_INVOCATION_SCOPE), tool.name).toBe(true);
    }
  });
});
