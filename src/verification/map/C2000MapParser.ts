import {
  mapParseDocumentSchema,
  type MapParseDocument,
  type MapRegion,
  type MapSection
} from "./MapSchemas.js";

/** Parser for the memory and section tables emitted by TI C2000 linkers. */
export class C2000MapParser {
  parse(text: string): MapParseDocument {
    const lines = text.split(/\r?\n/);
    const memoryIndex = lines.findIndex(line => /MEMORY\s+CONFIGURATION/i.test(line));
    const sectionIndex = lines.findIndex(line => /SECTION\s+ALLOCATION\s+MAP/i.test(line));
    const regions: MapRegion[] = [];
    const sections: MapSection[] = [];
    const errors: string[] = [];
    const warnings: string[] = [];

    let page: number | null = null;
    if (memoryIndex < 0) errors.push("MEMORY CONFIGURATION table was not found");
    if (memoryIndex >= 0) {
      const end = sectionIndex > memoryIndex ? sectionIndex : lines.length;
      for (const line of lines.slice(memoryIndex + 1, end)) {
        const pageMatch = /^\s*PAGE\s+(\d+)\s*:?/i.exec(line);
        if (pageMatch) {
          page = Number(pageMatch[1]);
          continue;
        }
        const parsed = parseMemoryLine(line, page);
        if (parsed) regions.push(parsed);
      }
      if (regions.length === 0) errors.push("MEMORY CONFIGURATION table contains no parseable memory regions");
    }

    if (sectionIndex < 0) warnings.push("SECTION ALLOCATION MAP table was not found");
    if (sectionIndex >= 0) {
      for (const line of lines.slice(sectionIndex + 1)) {
        // PAGE headings belong to the memory table. Section rows either carry
        // their own page column or are mapped back to a region by address.
        const parsed = parseSectionLine(line, null);
        if (parsed) sections.push(parsed);
      }
      if (sections.length === 0) warnings.push("SECTION ALLOCATION MAP table contains no parseable output sections");
    }

    const mappedSections = sections.map(section => ({
      ...section,
      region: section.region ?? findRegion(section.runAddress ?? section.loadAddress, regions)?.name ?? null,
      page: section.page ?? findRegion(section.runAddress ?? section.loadAddress, regions)?.page ?? null
    }));
    const format = inferFormat(text);
    return mapParseDocumentSchema.parse({
      schemaVersion: 1,
      format,
      complete: memoryIndex >= 0 && regions.length > 0 && sectionIndex >= 0 && sections.length > 0 && errors.length === 0,
      memoryTablePresent: memoryIndex >= 0,
      sectionTablePresent: sectionIndex >= 0,
      errors,
      warnings,
      regions: deduplicateRegions(regions),
      sections: deduplicateSections(mappedSections)
    });
  }
}

export function parseC2000Map(text: string): MapParseDocument {
  return new C2000MapParser().parse(text);
}

function parseMemoryLine(line: string, page: number | null): MapRegion | undefined {
  const match = /^\s*([A-Za-z_.$][A-Za-z0-9_.$-]*)\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)(?:\s+([^\s]+))?(?:\s+|$)/.exec(line);
  if (!match) return undefined;
  const origin = parseNumber(match[2]);
  const length = parseNumber(match[3]);
  const used = parseNumber(match[4]);
  const fourth = match[5] ? parseNumber(match[5]) : undefined;
  if (origin === undefined || length === undefined || used === undefined) return undefined;
  // TI tables normally expose both Used and Unused. If a legacy table omits
  // Unused, deriving it from length keeps the machine result conservative.
  const unused = fourth === undefined ? Math.max(0, length - used) : Math.max(0, fourth);
  return {
    name: match[1]!,
    origin,
    length,
    used,
    unused,
    page,
    utilizationPct: length === 0 ? 0 : (used / length) * 100
  };
}

function parseSectionLine(line: string, page: number | null): MapSection | undefined {
  const nameMatch = /^\s*(\.[A-Za-z0-9_.$-]+)\s+(.+)$/.exec(line);
  if (!nameMatch) return undefined;
  const tokens = nameMatch[2]!.split(/\s+/).filter(Boolean);
  const values = tokens
    .filter(token => /^(?:0x)?[0-9A-Fa-f]+$/.test(token))
    .map(token => parseNumber(token))
    .filter((value): value is number => value !== undefined);
  if (values.length === 0) return undefined;
  const hasPageColumn = values.length >= 4 && /^(?:0x)?[0-3]$/i.test(tokens[0] ?? "");
  const sectionPage = hasPageColumn ? values[0]! : page;
  const offset = hasPageColumn ? 1 : 0;
  const loadAddress = values[offset] ?? null;
  const size = values.length > offset + 1 ? values[offset + 1]! : 0;
  const runAddress = values.length > offset + 2 ? values[offset + 2]! : loadAddress;
  const region = extractRegionName(nameMatch[2]!);
  return { name: nameMatch[1]!, size, loadAddress, runAddress, region, page: sectionPage };
}

function extractRegionName(value: string): string | null {
  const match = /\b((?:RAM|FLASH|CLA|MSGRAM|GS|LS|M0|M1)[A-Za-z0-9_.-]*)\b/i.exec(value);
  return match?.[1] ?? null;
}

function findRegion(address: number | null, regions: MapRegion[]): MapRegion | undefined {
  if (address === null) return undefined;
  return regions.find(region => address >= region.origin && address < region.origin + region.length);
}

function parseNumber(value: string | undefined): number | undefined {
  if (!value || !/^(?:0x)?[0-9A-Fa-f]+$/.test(value)) return undefined;
  const parsed = Number.parseInt(value.replace(/^0x/i, ""), 16);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function inferFormat(text: string): MapParseDocument["format"] {
  if (/EABI|tiarmclang|ELF|GNU\s+EABI/i.test(text)) return "TI_EABI";
  if (/COFF|TMS470|C28xx_.*COFF/i.test(text)) return "TI_COFF";
  return "UNKNOWN";
}

function deduplicateRegions(values: MapRegion[]): MapRegion[] {
  const seen = new Set<string>();
  return values.filter(value => {
    const key = `${value.name}:${value.page ?? "-"}:${value.origin}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function deduplicateSections(values: MapSection[]): MapSection[] {
  const seen = new Set<string>();
  return values.filter(value => {
    const key = `${value.name}:${value.loadAddress ?? "-"}:${value.runAddress ?? "-"}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
