import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  analyzeRamOwnership,
  decodeF28P65xBankMuxSel,
  expectedF28P65xBankMuxSel,
  mergeOwnershipActions,
  ownershipActionsForMap,
  parseLinkerMap,
  validateF28P65xFlashBoundary
} from "../src/hardware/mapOwnership.js";

const cpu2MapText = `
MEMORY CONFIGURATION

         name            origin    length      used     unused   attr    fill
----------------------  --------  ---------  --------  --------  ----  --------
  RAMGS3                00016000   00002000  00000000  00002000  RWIX
  RAMGS4                00018000   00002000  00000871  0000178f  RWIX
  FLASH_BANK3           000e0002   0001fffe  00000872  0001f78c  RWIX
  FLASH_BANK4           00100000   00020000  00000001  0001ffff  RWIX
  CPU1TOCPU2RAM         0003a000   00000400  000000ba  00000346  RWIX

SECTION ALLOCATION MAP

 output                                  attributes/
section   page    origin      length       input sections
--------  ----  ----------  ----------   ----------------
.text      0    00018000    000007bc
                  00018363    0000003c     main_cpu2.obj (.text:main)
.bss       0    0001884c    0000001a     UNINITIALIZED
`;

describe("map RAM ownership analysis", () => {
  test("decodes F28P65x BankMux and treats only DEVCFGLOCK2 bit 2 as the lock", () => {
    expect(expectedF28P65xBankMuxSel([3])).toBe(0xC0);
    expect(decodeF28P65xBankMuxSel(0xC0)).toEqual([
      { bank: 0, selector: 0, owner: "CPU1" },
      { bank: 1, selector: 0, owner: "CPU1" },
      { bank: 2, selector: 0, owner: "CPU1" },
      { bank: 3, selector: 3, owner: "CPU2" },
      { bank: 4, selector: 0, owner: "CPU1" }
    ]);
    expect(validateF28P65xFlashBoundary(0xC0, 1, [3])).toMatchObject({
      status: "verified",
      expectedBankMuxSel: 0xC0,
      bankMuxLocked: false
    });
    expect(validateF28P65xFlashBoundary(0xC0, 4, [3])).toMatchObject({
      status: "mismatch",
      bankMuxLocked: true
    });
    expect(validateF28P65xFlashBoundary(Number.NaN, 0, [3])).toMatchObject({
      status: "unavailable",
      expectedBankMuxSel: 0xC0
    });
  });

  test("parses used RAMGS regions and section addresses from a C2000 linker map", () => {
    const parsed = parseLinkerMap(cpu2MapText, { coreId: 2, mapPath: "/tmp/cpu2.map" });

    expect(parsed.memoryRegions).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "RAMGS4", origin: 0x18000, length: 0x2000, used: 0x871 })
    ]));
    expect(parsed.usedGsRam).toEqual([
      expect.objectContaining({ name: "RAMGS4", gsIndex: 4, ownerCoreId: 2 })
    ]);
    expect(parsed.usedFlashBanks).toEqual([
      expect.objectContaining({ name: "FLASH_BANK3", bankIndex: 3, ownerCoreId: 2 }),
      expect.objectContaining({ name: "FLASH_BANK4", bankIndex: 4, ownerCoreId: 2 })
    ]);
    expect(parsed.sections).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: ".text", page: 0, origin: 0x18000, length: 0x7bc, memoryRegion: "RAMGS4" }),
      expect.objectContaining({ name: ".bss", page: 0, origin: 0x1884c, length: 0x1a, memoryRegion: "RAMGS4" })
    ]));
  });

  test("preserves TI name-only codestart rows for application-entry checks", () => {
    const parsed = parseLinkerMap(`
MEMORY CONFIGURATION
  FLASH_BANK0           00080000   00001000  00000102  00000efe  RWIX

SECTION ALLOCATION MAP
codestart
                  0    00080000    00000002
.text             0    00080002    00000100
`, { coreId: 0, mapPath: "/tmp/cpu1.map" });

    expect(parsed.sections).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "codestart", origin: 0x80000, length: 2, memoryRegion: "FLASH_BANK0" }),
      expect.objectContaining({ name: ".text", origin: 0x80002, length: 0x100 })
    ]));
  });

  test("retains the TI name-only codestart row for application-entry verification", () => {
    const parsed = parseLinkerMap(`
 MEMORY CONFIGURATION
   FLASH_BANK0          00080000   00020000  00001000  0001f000  RWIX

 SECTION ALLOCATION MAP
  codestart
                  * 0    00080000    00000002
 .text            0    000823c8    00001000
`, { coreId: 0, coreName: "C28xx_CPU1", mapPath: "/tmp/cpu1.map" });

    expect(parsed.sections).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "codestart", origin: 0x80000, length: 2, memoryRegion: "FLASH_BANK0" }),
      expect.objectContaining({ name: ".text", origin: 0x823c8, length: 0x1000 })
    ]));
  });

  test("emits CPU1 MEMCFG writes required before loading CPU2 programs that use GS RAM", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "c2000-map-ownership-"));
    const cpu2Map = path.join(tempDir, "cpu2.map");
    await writeFile(cpu2Map, cpu2MapText);

    const result = await analyzeRamOwnership({
      maps: [{ coreId: 2, coreName: "C28xx_CPU2", mapPath: cpu2Map }]
    });

    expect(result).toEqual(expect.objectContaining({
      success: true,
      target: "F28P65x",
      memcfgGsxmSelAddress: 0x0005F444,
      ownershipActions: [
        expect.objectContaining({
          ownerCoreId: 0,
          targetCoreId: 2,
          memoryRegion: "RAMGS4",
          gsIndex: 4,
          page: "DATA",
          address: 0x0005F444,
          value: 0x10,
          typeSize: 32,
          reason: expect.stringContaining("RAMGS4")
        })
      ],
      flashBankMuxSelAddress: 0x0005D060,
      flashOwnershipActions: [
        expect.objectContaining({
          ownerCoreId: 0,
          targetCoreId: 2,
          memoryRegions: ["FLASH_BANK3", "FLASH_BANK4"],
          flashBanks: [3, 4],
          page: "DATA",
          address: 0x0005D060,
          value: 0x3c0,
          typeSize: 32,
          reason: expect.stringContaining("FLASH_BANK3, FLASH_BANK4")
        })
      ]
    }));
    expect(result.maps[0]).toEqual(expect.objectContaining({
      coreId: 2,
      coreName: "C28xx_CPU2",
      mapPath: cpu2Map,
      usedGsRam: [expect.objectContaining({ name: "RAMGS4", gsIndex: 4 })]
    }));
  });

  test("merges multi-GS ownership actions into one OR-combined MEMCFG write", () => {
    const parsed = parseLinkerMap(`
MEMORY CONFIGURATION

         name            origin    length      used     unused   attr    fill
----------------------  --------  ---------  --------  --------  ----  --------
  RAMGS4                00018000   00002000  00000800  00001800  RWIX
  RAMGS5                0001a000   00002000  00000400  00001c00  RWIX
`, { coreId: 2, coreName: "C28xx_CPU2", mapPath: "/tmp/cpu2.map" });

    const merged = mergeOwnershipActions(ownershipActionsForMap(parsed));

    expect(merged).toEqual([
      expect.objectContaining({
        ownerCoreId: 0,
        targetCoreId: 2,
        address: 0x0005F444,
        value: 0x10 | 0x20,
        typeSize: 32,
        memoryRegion: expect.stringContaining("RAMGS4")
      })
    ]);
    expect(merged[0]?.memoryRegion).toContain("RAMGS5");
  });

  test("ignores MEMORY-like lines outside MEMORY CONFIGURATION", () => {
    const parsed = parseLinkerMap(`
GLOBAL SYMBOLS
  RAMGS9                00020000   00002000  00000100  00001f00  RWIX

MEMORY CONFIGURATION
  RAMGS4                00018000   00002000  00000800  00001800  RWIX

SECTION ALLOCATION MAP
  RAMGS8                0001c000   00002000  00000200  00001e00  RWIX
`, { coreId: 2, mapPath: "/tmp/cpu2.map" });

    expect(parsed.memoryRegions.map(region => region.name)).toEqual(["RAMGS4"]);
    expect(parsed.usedGsRam.map(region => region.name)).toEqual(["RAMGS4"]);
  });
});
