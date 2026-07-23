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
});
