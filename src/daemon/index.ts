#!/usr/bin/env node
import { loadConfig } from "../config/config.loader.js";
import { DebugDaemon } from "./DebugDaemon.js";

async function main(): Promise<void> {
  const daemon = new DebugDaemon(await loadConfig());
  await daemon.start();
  let stopping: Promise<void> | undefined;
  const stop = (exitCode: number) => (stopping ??= daemon.stop().finally(() => {
    process.exitCode = exitCode;
  }));
  process.once("SIGINT", () => { void stop(130); });
  process.once("SIGTERM", () => { void stop(143); });
  process.once("SIGHUP", () => { void stop(129); });
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
