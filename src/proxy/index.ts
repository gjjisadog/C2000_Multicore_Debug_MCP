import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { C2000McpConfig } from "../config/config.schema.js";
import { registerC2000Tools } from "../mcp/tools.js";
import { ensureDaemon } from "../daemon/DaemonBootstrap.js";
import { McpDaemonClient } from "./McpDaemonClient.js";
import { SERVER_NAME, SERVER_VERSION } from "../runtimeInfo.js";
import path from "node:path";
import { withAdditionalReadRoots } from "../security/pathPolicy.js";
import { CapabilitySessionManager } from "../mcp/capabilities.js";
import { Logger } from "../utils/logger.js";
import { capabilityAuditToOutcomeEvent } from "../analytics/OutcomeAnalyticsService.js";

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
  const logger = new Logger(config.logging.level, config.logging.logFile);
  const capabilitySessions = new CapabilitySessionManager({
    logger,
    onAudit: event => {
      const analyticsEvent = capabilityAuditToOutcomeEvent(
        event,
        config.toolProfile ?? "safe",
        config.toolSurfaceProfile ?? "agent",
        capabilitySessions.activeCapabilities()
      );
      void client.recordOutcomeEvent(analyticsEvent).catch(error => {
        logger.warn("c2000 capability analytics audit forwarding failed", { error });
      });
    }
  });
  const registration = registerC2000Tools(
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
    {
      getServerHealth: () => client.invokeTool("c2000_getServerHealth", {})
    },
    config.toolSurfaceProfile ?? "agent",
    { capabilitySessions }
  );
  return {
    server,
    dispose: async () => {
      registration.dispose();
      await client.close();
    }
  };
}
