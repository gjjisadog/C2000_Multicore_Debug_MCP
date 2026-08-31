import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

describe("Skill source of truth", () => {
  it("keeps the canonical base Skill and generated mirror byte-identical", async () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const canonical = await readFile(path.join(root, "skills", "c2000-multicore-debug", "SKILL.md"), "utf8");
    const mirror = await readFile(path.join(root, ".skills", "c2000-multicore-debug", "SKILL.md"), "utf8");
    expect(mirror).toBe(canonical);
  });
});
