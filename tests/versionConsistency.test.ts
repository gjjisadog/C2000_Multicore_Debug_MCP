import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { SERVER_VERSION } from "../src/runtimeInfo.js";

const root = path.resolve(".");
const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { version: string };

describe("runtime version sources", () => {
  test("uses package.json as the TypeScript runtime version source", () => {
    expect(SERVER_VERSION).toBe(packageJson.version);
  });

  test("keeps a generated release runtime manifest aligned when one is present", () => {
    const manifestPath = path.join(root, "dist", "src", "runtime-manifest.json");
    if (!existsSync(manifestPath)) return;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { version?: string };
    expect(manifest.version).toBe(packageJson.version);
  });
});
