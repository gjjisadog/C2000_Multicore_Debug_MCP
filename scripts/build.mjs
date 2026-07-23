#!/usr/bin/env node
/**
 * Reliable TypeScript build entry.
 * Avoids broken `tsc` shims by invoking the package's real CLI (_tsc.js / tsc.js)
 * with createRequire so project `"type":"module"` does not break CJS loading.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function resolveTscEntry() {
  const tsPackageJson = require.resolve("typescript/package.json");
  const tsRoot = path.dirname(tsPackageJson);
  const candidates = [
    path.join(tsRoot, "lib", "_tsc.js"),
    path.join(tsRoot, "lib", "tsc.js"),
    path.join(tsRoot, "bin", "tsc")
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(`Could not locate TypeScript CLI under ${tsRoot}`);
}

const tscEntry = resolveTscEntry();
const userArgs = process.argv.slice(2);
const args = userArgs.length > 0 ? userArgs : ["-p", "tsconfig.src.json"];

const result = spawnSync(process.execPath, [tscEntry, ...args], {
  cwd: projectRoot,
  stdio: "inherit",
  env: process.env
});

if (result.error) {
  console.error(result.error);
  process.exit(1);
}
const code = typeof result.status === "number" ? result.status : 1;
if (code !== 0) {
  console.error(`[build] tsc exited with code ${code} (entry: ${tscEntry})`);
}
process.exit(code);
