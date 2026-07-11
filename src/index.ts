#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config/config.loader.js";
import { createC2000McpServer } from "./server.js";
import { startupFailure, startupReady, writeStartupDiagnostic, type StartupPhase } from "./startupDiagnostics.js";
import { isBundledRuntime } from "./runtimeInfo.js";

let startupPhase: StartupPhase = "load-config";
async function main() {
  const config = await loadConfig();
  startupPhase = "create-server";
  const server = createC2000McpServer(config);
  const transport = new StdioServerTransport();
  startupPhase = "connect-transport";
  await server.connect(transport);
  writeStartupDiagnostic(startupReady({
    bundled: isBundledRuntime(),
    adapterMode: config.adapter === "auto" ? config.ccs.scriptingMode : config.adapter,
    toolProfile: config.toolProfile,
    pid: process.pid
  }));
}

main().catch(error => {
  writeStartupDiagnostic(startupFailure(startupPhase, error));
  process.exit(1);
});
