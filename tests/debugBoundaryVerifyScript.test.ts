import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";

describe("debug boundary verify script contract", () => {
  test("provides a standalone source-boundary verification command", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as { scripts: Record<string, string> };
    const source = await readFile("scripts/verify-debug-boundary.ts", "utf8");

    expect(packageJson.scripts["verify:debug-boundary"]).toBe("tsx scripts/verify-debug-boundary.ts");
    expect(source).toContain("findDebugBoundarySourceOffenders");
    expect(source).toContain("DEBUG_BOUNDARY_SCAN_ROOTS");
    expect(source).toContain("process.exitCode = 1");
    expect(source).toContain("debugBoundarySourceScan");
    expect(source).toContain("offenders");
    expect(source).toContain("console.log(JSON.stringify");
  });
});
