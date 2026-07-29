import { spawnSync } from "node:child_process";
import path from "node:path";
import { requireHardwareOptIn, requireSupportedHardwareRuntime } from "./hardware-opt-in.js";

const options = parseArguments(process.argv.slice(2));
requireHardwareOptIn({ operation: options.operation });
requireSupportedHardwareRuntime(options.operation);

const build = spawnSync(process.execPath, [
  path.resolve("scripts/build.mjs"),
  "-p",
  "tsconfig.src.json"
], {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit"
});
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);

const run = spawnSync(process.execPath, [
  path.resolve("node_modules/tsx/dist/cli.mjs"),
  path.resolve(options.script)
], {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit"
});
if (run.error) throw run.error;
process.exit(run.status ?? 1);

function parseArguments(args: string[]): { operation: string; script: string } {
  let operation = "";
  let script = "";
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--operation") operation = args[++index] ?? "";
    else if (arg === "--script") script = args[++index] ?? "";
    else throw new Error(`Unknown gated hardware argument: ${arg}`);
  }
  if (!operation || !script) throw new Error("--operation and --script are required");
  return { operation, script };
}
