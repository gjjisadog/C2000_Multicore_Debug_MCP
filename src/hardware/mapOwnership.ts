import { readFile } from "node:fs/promises";

export const F28P65X_CPU1_CORE_ID = 0;
export const F28P65X_CPU2_CORE_ID = 2;
export const F28P65X_MEMCFG_GSXMSEL_ADDRESS = 0x0005F444;
export const F28P65X_DEVCFG_BANKMUXSEL_ADDRESS = 0x0005D060;

export interface MapOwnershipInput {
  maps: Array<{
    coreId: number;
    coreName?: string;
    mapPath: string;
  }>;
}

export interface LinkerMapMemoryRegion {
  name: string;
  origin: number;
  length: number;
  used: number;
  unused: number;
  attr?: string;
}

export interface LinkerMapSection {
  name: string;
  page: number;
  origin: number;
  length: number;
  memoryRegion?: string;
}

export interface UsedGsRamRegion extends LinkerMapMemoryRegion {
  gsIndex: number;
  ownerCoreId: number;
}

export interface UsedFlashBankRegion extends LinkerMapMemoryRegion {
  bankIndex: number;
  ownerCoreId: number;
}

export interface ParsedLinkerMap {
  coreId: number;
  coreName?: string;
  mapPath: string;
  memoryRegions: LinkerMapMemoryRegion[];
  sections: LinkerMapSection[];
  usedGsRam: UsedGsRamRegion[];
  usedFlashBanks: UsedFlashBankRegion[];
}

export interface RamOwnershipAction {
  ownerCoreId: number;
  targetCoreId: number;
  targetCoreName?: string;
  memoryRegion: string;
  gsIndex: number;
  page: "DATA";
  address: number;
  value: number;
  typeSize: 32;
  reason: string;
}

export interface RamOwnershipAnalysis {
  success: true;
  target: "F28P65x";
  memcfgGsxmSelAddress: number;
  flashBankMuxSelAddress: number;
  maps: ParsedLinkerMap[];
  ownershipActions: RamOwnershipAction[];
  flashOwnershipActions: FlashOwnershipAction[];
}

export interface FlashOwnershipAction {
  ownerCoreId: number;
  targetCoreId: number;
  targetCoreName?: string;
  memoryRegions: string[];
  flashBanks: number[];
  page: "DATA";
  address: number;
  value: number;
  typeSize: 32;
  reason: string;
}

export function parseLinkerMap(
  text: string,
  options: { coreId: number; coreName?: string; mapPath: string }
): ParsedLinkerMap {
  const memoryRegions = parseMemoryRegions(text);
  const sections = parseSections(text, memoryRegions);
  const usedGsRam = memoryRegions
    .map(region => {
      const match = /^RAMGS(\d+)$/i.exec(region.name);
      if (!match || region.used === 0) {
        return undefined;
      }
      return {
        ...region,
        gsIndex: Number.parseInt(match[1], 10),
        ownerCoreId: options.coreId
      };
    })
    .filter((region): region is UsedGsRamRegion => region !== undefined);
  const usedFlashBanks = memoryRegions
    .map(region => {
      const match = /^FLASH_BANK(\d+)$/i.exec(region.name);
      if (!match || region.used === 0) {
        return undefined;
      }
      return {
        ...region,
        bankIndex: Number.parseInt(match[1], 10),
        ownerCoreId: options.coreId
      };
    })
    .filter((region): region is UsedFlashBankRegion => region !== undefined);
  return {
    ...options,
    memoryRegions,
    sections,
    usedGsRam,
    usedFlashBanks
  };
}

export async function analyzeRamOwnership(input: MapOwnershipInput): Promise<RamOwnershipAnalysis> {
  const maps = await Promise.all(input.maps.map(async map => parseLinkerMap(await readFile(map.mapPath, "utf8"), map)));
  return {
    success: true,
    target: "F28P65x",
    memcfgGsxmSelAddress: F28P65X_MEMCFG_GSXMSEL_ADDRESS,
    flashBankMuxSelAddress: F28P65X_DEVCFG_BANKMUXSEL_ADDRESS,
    maps,
    ownershipActions: maps.flatMap(map => ownershipActionsForMap(map)),
    flashOwnershipActions: maps.flatMap(map => flashOwnershipActionsForMap(map))
  };
}

export function flashOwnershipActionsForMap(map: ParsedLinkerMap): FlashOwnershipAction[] {
  if (map.coreId !== F28P65X_CPU2_CORE_ID || map.usedFlashBanks.length === 0) {
    return [];
  }
  const banks = [...new Set(map.usedFlashBanks.map(region => region.bankIndex))].sort((left, right) => left - right);
  const invalidBanks = banks.filter(bank => bank < 0 || bank > 4);
  if (invalidBanks.length > 0) {
    throw new Error(`Unsupported F28P65x flash bank index: ${invalidBanks.join(", ")}`);
  }
  const value = banks.reduce((combined, bank) => combined | (0x3 << (bank * 2)), 0);
  return [{
    ownerCoreId: F28P65X_CPU1_CORE_ID,
    targetCoreId: map.coreId,
    targetCoreName: map.coreName,
    memoryRegions: map.usedFlashBanks.map(region => region.name),
    flashBanks: banks,
    page: "DATA",
    address: F28P65X_DEVCFG_BANKMUXSEL_ADDRESS,
    value,
    typeSize: 32,
    reason: `CPU2 map uses ${banks.map(bank => `FLASH_BANK${bank}`).join(", ")}; CPU1 must assign those flash banks to CPU2 before CPU2 program load.`
  }];
}

export function ownershipActionsForMap(map: ParsedLinkerMap): RamOwnershipAction[] {
  if (map.coreId !== F28P65X_CPU2_CORE_ID) {
    return [];
  }
  return map.usedGsRam.map(region => ({
    ownerCoreId: F28P65X_CPU1_CORE_ID,
    targetCoreId: map.coreId,
    targetCoreName: map.coreName,
    memoryRegion: region.name,
    gsIndex: region.gsIndex,
    page: "DATA",
    address: F28P65X_MEMCFG_GSXMSEL_ADDRESS,
    value: 1 << region.gsIndex,
    typeSize: 32,
    reason: `CPU2 map uses ${region.name}; CPU1 must assign this GS RAM block to CPU2 before CPU2 program load.`
  }));
}

/**
 * Collapse ownership actions that target the same MEMCFG register into a single
 * OR-combined write. Sequential per-bit writes would overwrite earlier GS bits.
 */
export function mergeOwnershipActions(actions: RamOwnershipAction[]): RamOwnershipAction[] {
  const merged = new Map<string, RamOwnershipAction>();
  for (const action of actions) {
    const key = `${action.ownerCoreId}:${action.page}:${action.address}:${action.typeSize}:${action.targetCoreId}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...action });
      continue;
    }
    const regions = new Set(
      `${existing.memoryRegion}+${action.memoryRegion}`
        .split("+")
        .map(region => region.trim())
        .filter(Boolean)
    );
    merged.set(key, {
      ...existing,
      value: existing.value | action.value,
      gsIndex: Math.min(existing.gsIndex, action.gsIndex),
      memoryRegion: Array.from(regions).join("+"),
      reason: `${existing.reason} ${action.reason}`
    });
  }
  return Array.from(merged.values());
}

export function mapPathForProgram(programUri: string): string | undefined {
  if (!/\.out$/i.test(programUri)) {
    return undefined;
  }
  return programUri.replace(/\.out$/i, ".map");
}

function parseMemoryRegions(text: string): LinkerMapMemoryRegion[] {
  const regions: LinkerMapMemoryRegion[] = [];
  let inMemoryConfiguration = false;
  for (const line of text.split(/\r?\n/)) {
    if (/MEMORY\s+CONFIGURATION/i.test(line)) {
      inMemoryConfiguration = true;
      continue;
    }
    if (
      inMemoryConfiguration &&
      /^(SECTION\s+ALLOCATION\s+MAP|GLOBAL\s+SYMBOLS|DATA\s+TABLES|LINKER\s+GENERATED|HOLE\s+REPORT)/i.test(line.trim())
    ) {
      break;
    }
    if (!inMemoryConfiguration) {
      continue;
    }
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s+([0-9a-fA-F]{8})\s+([0-9a-fA-F]{8})\s+([0-9a-fA-F]{8})\s+([0-9a-fA-F]{8})\s+([A-Z]+)?/.exec(line);
    if (!match) {
      continue;
    }
    regions.push({
      name: match[1],
      origin: Number.parseInt(match[2], 16),
      length: Number.parseInt(match[3], 16),
      used: Number.parseInt(match[4], 16),
      unused: Number.parseInt(match[5], 16),
      attr: match[6]
    });
  }
  return regions;
}

function parseSections(text: string, regions: LinkerMapMemoryRegion[]): LinkerMapSection[] {
  const sections: LinkerMapSection[] = [];
  const lines = text.split(/\r?\n/);
  let inSectionMap = false;
  for (const line of lines) {
    if (line.includes("SECTION ALLOCATION MAP")) {
      inSectionMap = true;
      continue;
    }
    if (!inSectionMap) {
      continue;
    }
    const match = /^([.$A-Za-z_][.$A-Za-z0-9_:]*)\s+\*?\s*(\d+)\s+([0-9a-fA-F]{8})\s+([0-9a-fA-F]{8})/.exec(line);
    if (!match) {
      continue;
    }
    const origin = Number.parseInt(match[3], 16);
    sections.push({
      name: match[1],
      page: Number.parseInt(match[2], 10),
      origin,
      length: Number.parseInt(match[4], 16),
      memoryRegion: regionForAddress(origin, regions)?.name
    });
  }
  return sections;
}

function regionForAddress(address: number, regions: LinkerMapMemoryRegion[]): LinkerMapMemoryRegion | undefined {
  return regions.find(region => address >= region.origin && address < region.origin + region.length);
}
