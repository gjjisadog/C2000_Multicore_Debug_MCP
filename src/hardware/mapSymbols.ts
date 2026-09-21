import { readFile } from "node:fs/promises";
import type { ResolveResult } from "../debug/types.js";
import { parseC2000Map } from "../verification/map/C2000MapParser.js";

interface MapSymbol {
  address: number;
  name: string;
}

interface SectionAddressRange {
  name: string;
  origin: number;
  endExclusive: number;
  loadOrigin: number;
  runOrigin: number;
  runtime: boolean;
  memoryRegion?: string;
}

interface ResolvedMapSymbol {
  name: string;
  address: number;
}

export async function resolveAddressFromMap(mapPath: string, address: string): Promise<ResolveResult> {
  const text = await readFile(mapPath, "utf8");
  const ranges = resolutionRanges(text);
  const numericAddress = chooseAddress(parseAddressCandidates(address), ranges);
  if (numericAddress === undefined) return unresolved(address, `Address is not numeric: ${address}`);
  const sections = ranges.filter(section => contains(section, numericAddress));
  if (sections.length === 0) return unresolved(address, `Address ${formatHex(numericAddress)} is outside allocated executable linker sections`);
  const symbols = parseMapSymbols(text);
  const matches = sections
    .map(section => ({ section, symbol: symbolAtAddress(symbols, section, numericAddress) }))
    .filter((item): item is { section: SectionAddressRange; symbol: ResolvedMapSymbol } => item.symbol !== undefined)
    // Prefer a runtime (RUN ADDR) range and then the narrowest exact range
    // when a load and run section overlap in a linker map.
    .sort((left, right) => Number(right.section.runtime) - Number(left.section.runtime)
      || (left.section.endExclusive - left.section.origin) - (right.section.endExclusive - right.section.origin));
  const match = matches[0];
  if (!match) {
    const section = sections[0]!;
    return unresolved(address, `No map function range contains address ${formatHex(numericAddress)} in section ${section.name}`);
  }
  const { section, symbol } = match;
  return {
    success: true,
    address: formatHex(numericAddress),
    function: symbol.name,
    offset: formatHex(numericAddress - symbol.address),
    ...(section.memoryRegion ? { memoryRegion: section.memoryRegion } : {}),
    partial: true,
    resolutionSource: "linker-map"
  };
}

export function parseMapSymbols(text: string): MapSymbol[] {
  const byAddress = new Map<string, MapSymbol>();
  for (const line of text.split(/\r?\n/)) {
    // TI COFF maps commonly prefix the address with a page column (`0
    // 0000dd4e symbol`), while newer EABI maps often omit that column
    // (`0000dd4e symbol`). Accept both forms and keep the parser independent
    // of whether the symbol table is sorted by name or address.
    const match = line.match(/^\s*(?:(?:\d+)\s+)?(0x[0-9a-fA-F]+|[0-9a-fA-F]{4,})\s+([A-Za-z_.$?@][A-Za-z0-9_.$?@:]*?)\s*$/);
    if (!match) continue;
    const address = Number.parseInt(match[1]!.replace(/^0x/i, ""), 16);
    if (Number.isFinite(address)) byAddress.set(`${address}:${match[2]}`, { address, name: match[2]! });
  }
  return [...byAddress.values()].sort((left, right) => left.address - right.address);
}

/**
 * Resolve one exact symbol without loading debugger symbols into the target.
 * A resident-image verifier uses this only to locate a firmware-declared
 * identity marker; the value itself is still read through the raw-memory
 * adapter path.
 */
export async function resolveSymbolAddressFromMap(mapPath: string, symbolName: string): Promise<number> {
  const text = await readFile(mapPath, "utf8");
  const matches = parseMapSymbols(text).filter(symbol => symbol.name === symbolName);
  if (matches.length === 0) {
    throw new Error(`Map symbol not found: ${symbolName}`);
  }
  if (matches.length > 1) {
    throw new Error(`Map symbol is ambiguous: ${symbolName}`);
  }
  return matches[0]!.address;
}

function resolutionRanges(text: string): SectionAddressRange[] {
  const parsed = parseC2000Map(text);
  return parsed.sections
    .filter(section => section.loadAddress !== null && section.size > 0 && isExecutableSection(section.name))
    .flatMap(section => {
      const loadOrigin = section.loadAddress!;
      const runOrigin = section.runAddress ?? loadOrigin;
      const base = {
        name: section.name,
        loadOrigin,
        runOrigin,
        memoryRegion: section.region ?? undefined
      };
      const loadRange: SectionAddressRange = {
        ...base,
        origin: loadOrigin,
        endExclusive: loadOrigin + section.size,
        runtime: false
      };
      if (runOrigin === loadOrigin) return [loadRange];
      return [loadRange, {
        ...base,
        origin: runOrigin,
        endExclusive: runOrigin + section.size,
        runtime: true
      }];
    })
    .sort((left, right) => left.origin - right.origin || Number(right.runtime) - Number(left.runtime));
}

function isExecutableSection(name: string): boolean {
  return /(?:^|\.)(?:text|TI\.ramfunc|ramfunc|codestart|reset|cinit|pinit|init|fini|init_array|switch)(?:$|[.:])/i.test(name);
}

function contains(section: SectionAddressRange, address: number): boolean {
  return address >= section.origin && address < section.endExclusive;
}

function symbolAtAddress(symbols: MapSymbol[], section: SectionAddressRange, address: number): ResolvedMapSymbol | undefined {
  const projected = symbols
    .flatMap(symbol => projectSymbol(symbol, section))
    .sort((left, right) => left.address - right.address || left.name.localeCompare(right.name));
  let selectedIndex = -1;
  for (let index = 0; index < projected.length; index += 1) {
    if (projected[index]!.address > address) break;
    selectedIndex = index;
  }
  if (selectedIndex < 0) return undefined;
  const candidate = projected[selectedIndex]!;
  const next = projected.slice(selectedIndex + 1).find(item => item.address > candidate.address)?.address ?? section.endExclusive;
  return address < Math.min(next, section.endExclusive) ? candidate : undefined;
}

function projectSymbol(symbol: MapSymbol, section: SectionAddressRange): ResolvedMapSymbol[] {
  const loadEnd = section.loadOrigin + (section.endExclusive - section.origin);
  const runEnd = section.runOrigin + (section.endExclusive - section.origin);
  if (section.runtime && symbol.address >= section.origin && symbol.address < section.endExclusive) {
    return [{ name: symbol.name, address: symbol.address }];
  }
  if (symbol.address < section.loadOrigin || symbol.address >= loadEnd) return [];
  return [{
    name: symbol.name,
    address: section.runtime ? section.runOrigin + (symbol.address - section.loadOrigin) : symbol.address
  }].filter(item => item.address >= section.origin && item.address < section.endExclusive
    && item.address < runEnd);
}

function parseAddressCandidates(value: string): number[] {
  const trimmed = value.trim();
  if (/^0x[0-9a-f]+$/i.test(trimmed)) return [Number.parseInt(trimmed.slice(2), 16)];
  if (/^[0-9]+$/.test(trimmed)) {
    const decimal = Number.parseInt(trimmed, 10);
    const hexadecimal = trimmed.length >= 6 ? Number.parseInt(trimmed, 16) : undefined;
    // CCS commonly prints a zero-padded C28x PC without the `0x` prefix.
    // Prefer that hexadecimal interpretation for six-or-more digits, while
    // retaining the decimal form as a fallback for the legacy API contract.
    return [...new Set([hexadecimal, decimal].filter((item): item is number => Number.isFinite(item)))];
  }
  if (/^[0-9a-f]+$/i.test(trimmed)) return [Number.parseInt(trimmed, 16)];
  return [];
}

function chooseAddress(candidates: number[], ranges: SectionAddressRange[]): number | undefined {
  return candidates.find(candidate => ranges.some(range => contains(range, candidate))) ?? candidates[0];
}

function formatHex(value: number): string {
  return `0x${value.toString(16).toUpperCase()}`;
}

function unresolved(address: string, message: string): ResolveResult {
  return { success: false, address, partial: true, resolutionSource: "linker-map", error: { code: "AddressResolveFailed", message } };
}
