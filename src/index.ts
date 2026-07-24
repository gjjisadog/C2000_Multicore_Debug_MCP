#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config/config.loader.js";
import { createC2000McpProxyRuntime } from "./proxy/index.js";

async function main() {
  const config = await loadConfig();
  const runtime = await createC2000McpProxyRuntime(config);
  const transport = new StdioServerTransport();
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (reason: string, exitCode?: number) =>
    (shutdownPromise ??= (async () => {
      // The stdio process owns only its RPC client. The daemon owns sessions,
      // workers, DSS children, and submitted jobs across proxy reconnects.
      await runtime.dispose();
      await runtime.server.close();
      if (exitCode !== undefined) {
        process.exitCode = exitCode;
      }
    })());

  transport.onclose = () => {
    void shutdown("transport-close");
  };
  process.stdin.once("end", () => {
    void shutdown("stdin-end");
  });
  process.stdin.once("close", () => {
    void shutdown("stdin-close");
  });
  process.once("SIGINT", () => {
    void shutdown("SIGINT", 130);
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM", 143);
  });
  process.once("SIGHUP", () => {
    void shutdown("SIGHUP", 129);
  });
  process.once("beforeExit", () => {
    void shutdown("beforeExit");
  });

  await runtime.server.connect(transport);
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
