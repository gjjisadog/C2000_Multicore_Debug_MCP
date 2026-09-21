import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { resolveAddressFromMap } from "../src/hardware/mapSymbols.js";

const mapText = `
MEMORY CONFIGURATION
  RAMD1                 0000d000   00001000  00000800  00000800  RWIX

SECTION ALLOCATION MAP
.text      0    0000d000    00001000

GLOBAL SYMBOLS: SORTED ALPHABETICALLY BY Name
       0    0000dd4e  IPC_isFlagBusyRtoL
       0    0000dd67  SysCtl_setPLLSysClk
`;

const runtimeMapText = `
MEMORY CONFIGURATION
  FLASH_BANK0  00080000  00001000  00000400  00000c00  RWIX
  RAMD0        0000c000  00001000  00000400  00000c00  RWIX

SECTION ALLOCATION MAP
.TI.ramfunc  0  00080008  00000040  0000c000

GLOBAL SYMBOLS: SORTED BY Symbol Address
       0    0000c010  ramFunction
       0    0000c020  nextFunction
`;

describe("linker map symbol resolution", () => {
  test("resolves a decimal PC to the nearest preceding symbol in its linker section", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "c2000-map-symbols-"));
    const mapPath = path.join(tempDir, "cpu2.map");
    await writeFile(mapPath, mapText);

    await expect(resolveAddressFromMap(mapPath, "56664")).resolves.toEqual({
      success: true,
      address: "0xDD58",
      function: "IPC_isFlagBusyRtoL",
      offset: "0xA",
      memoryRegion: "RAMD1",
      partial: true,
      resolutionSource: "linker-map"
    });
  });

  test("fails closed when the address is outside allocated sections", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "c2000-map-symbols-outside-"));
    const mapPath = path.join(tempDir, "cpu2.map");
    await writeFile(mapPath, mapText);

    await expect(resolveAddressFromMap(mapPath, "0x300000")).resolves.toEqual(expect.objectContaining({
      success: false,
      partial: true,
      resolutionSource: "linker-map",
      error: expect.objectContaining({ code: "AddressResolveFailed" })
    }));
  });

  test("treats a zero-padded C28x PC as hexadecimal and switches names at the exact map boundary", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "c2000-map-symbols-hex-"));
    const mapPath = path.join(tempDir, "cpu2.map");
    await writeFile(mapPath, mapText);

    await expect(resolveAddressFromMap(mapPath, "0000DD58")).resolves.toEqual(expect.objectContaining({
      address: "0xDD58",
      function: "IPC_isFlagBusyRtoL",
      offset: "0xA"
    }));
    await expect(resolveAddressFromMap(mapPath, "0xDD67")).resolves.toEqual(expect.objectContaining({
      address: "0xDD67",
      function: "SysCtl_setPLLSysClk",
      offset: "0x0"
    }));
  });

  test("resolves a copy-to-RAM function against its RUN ADDR range", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "c2000-map-symbols-run-"));
    const mapPath = path.join(tempDir, "cpu1.map");
    await writeFile(mapPath, runtimeMapText);

    await expect(resolveAddressFromMap(mapPath, "0x0000C012")).resolves.toEqual(expect.objectContaining({
      address: "0xC012",
      function: "ramFunction",
      offset: "0x2",
      memoryRegion: "RAMD0"
    }));
  });
});
