import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseBuildLog } from "../src/verification/build/BuildLogParser.js";

const fixture = (name: string) => path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", name);

describe("BuildLogParser", () => {
  it("classifies compile errors and preserves location", async () => {
    const parsed = parseBuildLog(await readFile(fixture("compile-fail.log"), "utf8"));
    expect(parsed.stage).toBe("compile");
    expect(parsed.errors[0]).toMatchObject({ category: "COMPILE_ERROR", file: "src/main.c", line: 42 });
  });

  it.each([
    ["abi-mismatch.log", "ABI_MISMATCH"],
    ["link-fail.log", "SECTION_OVERFLOW"],
    ["section-overflow.log", "SECTION_OVERFLOW"]
  ] as const)("classifies %s deterministically", async (name, category) => {
    const parsed = parseBuildLog(await readFile(fixture(name), "utf8"));
    expect(parsed.errors.some(error => error.category === category)).toBe(true);
  });
});
