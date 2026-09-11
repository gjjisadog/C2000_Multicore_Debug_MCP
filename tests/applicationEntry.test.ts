import { describe, expect, test } from "vitest";
import {
  createApplicationEntryPlan,
  formatAddress,
  parseAddress,
  waitForApplicationEntry
} from "../src/debug/applicationEntry.js";

const cpu1Map = {
  coreId: 0,
  mapPath: "cpu1.map",
  memoryRegions: [{
    name: "FLASH_BANK0",
    origin: 0x00080000,
    length: 0x1000,
    used: 0x100,
    unused: 0xf00,
    attr: "RWIX"
  }],
  sections: [
    { name: "codestart", page: 0, origin: 0x00080000, length: 2, memoryRegion: "FLASH_BANK0" },
    { name: ".text", page: 0, origin: 0x00080002, length: 0x100, memoryRegion: "FLASH_BANK0" }
  ],
  usedGsRam: [],
  usedFlashBanks: []
};

describe("application-entry verification", () => {
  test("uses the linker-map codestart/text range and preserves C28x address formatting", () => {
    const plan = createApplicationEntryPlan({ coreId: 0, map: cpu1Map });

    expect(plan).toEqual(expect.objectContaining({
      configured: true,
      coreId: 0,
      entryAddress: 0x00080000,
      entryAddressHex: "0x00080000",
      source: "linker-map",
      codeRanges: expect.arrayContaining([
        expect.objectContaining({ name: "codestart", origin: 0x00080000 }),
        expect.objectContaining({ name: ".text", origin: 0x00080002 })
      ])
    }));
    expect(parseAddress("00080000")).toBe(0x00080000);
    expect(formatAddress(0x80000)).toBe("0x00080000");
  });

  test("accepts an explicit entry when the map has no executable sections", () => {
    const plan = createApplicationEntryPlan({ coreId: 0, explicitAddress: "0x80000" });

    expect(plan).toEqual(expect.objectContaining({
      configured: true,
      source: "explicit",
      entryAddress: 0x80000,
      codeRanges: [expect.objectContaining({ name: "explicit-entry-address", origin: 0x80000 })]
    }));
  });

  test("polls only the requested core until its PC enters application code", async () => {
    const requestedCoreIds: number[][] = [];
    let reads = 0;
    const result = await waitForApplicationEntry({
      async getMulticoreSnapshot(_sessionId, coreIds) {
        requestedCoreIds.push([...(coreIds ?? [])]);
        reads += 1;
        return {
          cores: [{
            coreId: 0,
            coreName: "C28xx_CPU1",
            name: "C28xx_CPU1",
            connected: true,
            state: "Running",
            pc: reads === 1 ? "0x00000000" : "0x00080010"
          }]
        };
      }
    }, {
      sessionId: "dbg-entry-test",
      plan: createApplicationEntryPlan({ coreId: 0, map: cpu1Map }),
      timeoutMs: 20,
      intervalMs: 1
    });

    expect(result).toEqual(expect.objectContaining({ reached: true, timedOut: false, method: "pc-in-application-code" }));
    expect(result.samples.length).toBeGreaterThanOrEqual(2);
    expect(requestedCoreIds.every(coreIds => coreIds.length === 1 && coreIds[0] === 0)).toBe(true);
  });

  test("returns bounded evidence when application entry is not configured", async () => {
    let reads = 0;
    const result = await waitForApplicationEntry({
      async getMulticoreSnapshot() {
        reads += 1;
        return { cores: [] };
      }
    }, {
      sessionId: "dbg-entry-not-configured",
      plan: createApplicationEntryPlan({ coreId: 0 }),
      timeoutMs: 20,
      intervalMs: 1
    });

    expect(result).toEqual(expect.objectContaining({ configured: false, reached: false, timedOut: false, method: "not-configured" }));
    expect(reads).toBe(0);
  });
});
