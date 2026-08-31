import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { C2000MapParser } from "../src/verification/map/C2000MapParser.js";

const fixture = (name: string) => path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", name);

describe("C2000MapParser", () => {
  it("parses memory regions, sections, pages, and ABI format", async () => {
    const parsed = new C2000MapParser().parse(await readFile(fixture("cpu1-good.map"), "utf8"));
    expect(parsed).toMatchObject({ complete: true, format: "TI_EABI", memoryTablePresent: true, sectionTablePresent: true });
    expect(parsed.regions.find(region => region.name === "RAMLS0")).toMatchObject({ origin: 0x8000, length: 0x800, used: 0x760, unused: 0xA0, page: 1 });
    expect(parsed.sections.find(section => section.name === ".stack")).toMatchObject({ size: 0x80, region: "RAMLS0" });
  });

  it("supports a COFF map and reports malformed input as incomplete", async () => {
    const coff = new C2000MapParser().parse(await readFile(fixture("cpu2-good.map"), "utf8"));
    const malformed = new C2000MapParser().parse(await readFile(fixture("malformed.map"), "utf8"));
    expect(coff.format).toBe("TI_COFF");
    expect(coff.complete).toBe(true);
    expect(malformed.complete).toBe(false);
    expect(malformed.errors.length).toBeGreaterThan(0);
  });

  it("does not inherit the last memory PAGE and understands section page columns", () => {
    const parsed = new C2000MapParser().parse([
      "MEMORY CONFIGURATION",
      "PAGE 0:",
      "  FLASH 00080000 00001000 00000800 00000800",
      "PAGE 1:",
      "  RAMLS0 00008000 00000800 00000400 00000400",
      "SECTION ALLOCATION MAP",
      ".text 0 00080000 00000100 00080000",
      ".stack 1 00008000 00000040 00008000"
    ].join("\n"));
    expect(parsed.complete).toBe(true);
    expect(parsed.sections).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: ".text", page: 0, size: 0x100, region: "FLASH" }),
      expect.objectContaining({ name: ".stack", page: 1, size: 0x40, region: "RAMLS0" })
    ]));
  });
});
