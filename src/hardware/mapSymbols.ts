import { readFile } from "node:fs/promises";
import type { ResolveResult } from "../debug/types.js";
import { parseLinkerMap } from "./mapOwnership.js";

interface MapSymbol {
  address: number;
  name: string;
}

export async function resolveAddressFromMap(mapPath: string, address: string): Promise<ResolveResult> {
  const numericAddress = parseAddress(address);
  if (numericAddress === undefined) return unresolved(address, `Address is not numeric: ${address}`);
  const text = await readFile(mapPath, "utf8");
  const parsedMap = parseLinkerMap(text, { coreId: -1, mapPath });
  const section = parsedMap.sections.find(item =>
    numericAddress >= item.origin && numericAddress < item.origin + item.length);
  if (!section) return unresolved(address, `Address ${formatHex(numericAddress)} is outside allocated linker sections`);
  const symbol = parseMapSymbols(text).filter(item =>
    item.address >= section.origin
      && item.address < section.origin + section.length
      && item.address <= numericAddress).at(-1);
  if (!symbol) return unresolved(address, `No map symbol precedes address ${formatHex(numericAddress)} in section ${section.name}`);
  const memoryRegion = section.memoryRegion;
  return {
    success: true,
    address: formatHex(numericAddress),
    function: symbol.name,
    offset: formatHex(numericAddress - symbol.address),
    ...(memoryRegion ? { memoryRegion } : {}),
    partial: true,
    resolutionSource: "linker-map"
  };
}

export function parseMapSymbols(text: string): MapSymbol[] {
  const byAddress = new Map<string, MapSymbol>();
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*\d+\s+([0-9a-fA-F]{4,})\s+([A-Za-z_.$][A-Za-z0-9_.$]*)\s*$/);
    if (!match) continue;
    const address = Number.parseInt(match[1]!, 16);
    if (Number.isFinite(address)) byAddress.set(`${address}:${match[2]}`, { address, name: match[2]! });
  }
  return [...byAddress.values()].sort((left, right) => left.address - right.address);
}

function parseAddress(value: string): number | undefined {
  const trimmed = value.trim();
  const parsed = /^0x/i.test(trimmed) ? Number.parseInt(trimmed.slice(2), 16) : Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function formatHex(value: number): string {
  return `0x${value.toString(16).toUpperCase()}`;
}

function unresolved(address: string, message: string): ResolveResult {
  return { success: false, address, partial: true, resolutionSource: "linker-map", error: { code: "AddressResolveFailed", message } };
}
