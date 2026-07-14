#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config/config.loader.js";
import { createC2000McpServer } from "./server.js";

async function main() {
  const config = await loadConfig();
  const server = await createC2000McpServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
