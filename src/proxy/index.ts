import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { C2000McpConfig } from "../config/config.schema.js";
import { registerC2000Tools } from "../mcp/tools.js";
import { ensureDaemon } from "../daemon/DaemonBootstrap.js";
import { McpDaemonClient } from "./McpDaemonClient.js";

export interface C2000McpProxyRuntime {
  server: McpServer;
  dispose(): Promise<void>;
}

export async function createC2000McpProxyRuntime(config: C2000McpConfig): Promise<C2000McpProxyRuntime> {
  const daemon = await ensureDaemon(config);
  const client = new McpDaemonClient(daemon.client);
  const server = new McpServer(
    { name: "c2000-multicore-mcp", version: "0.1.0" },
    { capabilities: { logging: {} } }
  );
  registerC2000Tools(server, client);
  return {
    server,
    dispose: () => client.close()
  };
}
