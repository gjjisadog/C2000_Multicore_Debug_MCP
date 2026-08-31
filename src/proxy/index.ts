import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { C2000McpConfig } from "../config/config.schema.js";
import { registerC2000Tools } from "../mcp/tools.js";
import { ensureDaemon } from "../daemon/DaemonBootstrap.js";
import { McpDaemonClient } from "./McpDaemonClient.js";
import { SERVER_NAME, SERVER_VERSION } from "../runtimeInfo.js";
import path from "node:path";
import { withAdditionalReadRoots } from "../security/pathPolicy.js";

export interface C2000McpProxyRuntime {
  server: McpServer;
  dispose(): Promise<void>;
}

export async function createC2000McpProxyRuntime(config: C2000McpConfig): Promise<C2000McpProxyRuntime> {
  const daemon = await ensureDaemon(config);
  const client = new McpDaemonClient(
    daemon.client,
    async () => (await ensureDaemon(config)).client
  );
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { logging: {} } }
  );
  registerC2000Tools(
    server,
    client,
    {},
    config.toolProfile,
    withAdditionalReadRoots(config.filesystem ?? {
      allowedReadRoots: [process.cwd()],
      allowedWriteRoots: []
    }, {
      roots: [
        config.ccs.installPath,
        config.ccs.c2000WarePath,
        ...(config.programSearchRoots ?? []),
        ...(config.boards ?? []).map(board => path.dirname(board.ccxmlPath)),
        ...(config.debugProbe?.probes ?? []).map(probe => path.dirname(probe.ccxmlPath))
      ],
      files: [config.ccs.ccxmlPath]
    }),
    {},
    {},
    config.toolSurfaceProfile ?? "agent"
  );
  return {
    server,
    dispose: () => client.close()
  };
}
