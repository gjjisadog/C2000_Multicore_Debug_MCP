import type { CoreId, CoreSnapshot, TargetStateName } from "./types.js";
import type { ParsedLinkerMap } from "../hardware/mapOwnership.js";
import { toStructuredError, type StructuredError } from "../utils/errors.js";
import { sleep } from "../utils/async.js";

export interface ApplicationCodeRange {
  name: string;
  origin: number;
  length: number;
  endExclusive: number;
  memoryRegion?: string;
}

export interface ApplicationEntryPlan {
  configured: boolean;
  coreId: CoreId;
  entryAddress?: number;
  entryAddressHex?: string;
  source: "explicit" | "linker-map" | "unavailable";
  codeRanges: ApplicationCodeRange[];
  reason?: string;
}

export interface ApplicationEntrySample {
  at: string;
  pc?: string;
  pcValue?: number;
  state?: TargetStateName;
  connected?: boolean;
  inApplicationCode: boolean;
  error?: StructuredError;
}

export interface ApplicationEntryCheck {
  configured: boolean;
  reached: boolean;
  timedOut: boolean;
  method: "pc-in-application-code" | "not-configured";
  coreId: CoreId;
  entryAddress?: string;
  source: ApplicationEntryPlan["source"];
  codeRanges: ApplicationCodeRange[];
  timeoutMs: number;
  intervalMs: number;
  pollIterations: number;
  durationMs: number;
  samples: ApplicationEntrySample[];
  lastPc?: string;
  lastError?: StructuredError;
  reason?: string;
}

/** Resolve an application-entry contract without target access or mutation. */
export function createApplicationEntryPlan(input: {
  coreId: CoreId;
  explicitAddress?: string | number;
  map?: ParsedLinkerMap;
}): ApplicationEntryPlan {
  const explicitAddress = parseAddress(input.explicitAddress);
  const codeRanges = executableRanges(input.map);
  const mapEntry = input.map?.sections
    .filter(section => section.length > 0)
    .filter(section => /^(codestart|\.reset|reset|entry)$/i.test(section.name))
    .sort((left, right) => left.origin - right.origin)[0]
    ?? codeRanges
      .filter(section => /^\.text$/i.test(section.name))
      .sort((left, right) => left.origin - right.origin)[0]
      ?? codeRanges.slice().sort((left, right) => left.origin - right.origin)[0];
  const mapEntryAddress = mapEntry?.origin;
  const entryAddress = explicitAddress ?? mapEntryAddress;
  const ranges = explicitAddress !== undefined && !codeRanges.some(range => contains(range, explicitAddress))
    ? [{
      name: "explicit-entry-address",
      origin: explicitAddress,
      length: 1,
      endExclusive: explicitAddress + 1
    }, ...codeRanges]
    : codeRanges;

  if (entryAddress === undefined || ranges.length === 0) {
    return {
      configured: false,
      coreId: input.coreId,
      source: "unavailable",
      codeRanges: ranges,
      reason: "CPU1 application entry and executable code ranges were not found in the linker map; provide cpu1EntryAddress explicitly."
    };
  }
  return {
    configured: true,
    coreId: input.coreId,
    entryAddress,
    entryAddressHex: formatAddress(entryAddress),
    source: explicitAddress !== undefined ? "explicit" : "linker-map",
    codeRanges: ranges
  };
}

/**
 * Poll only the requested core's PC. The caller controls the failure action;
 * this helper never touches another core.
 */
export async function waitForApplicationEntry(
  manager: {
    getMulticoreSnapshot(sessionId: string, coreIds?: CoreId[]): Promise<{ cores: CoreSnapshot[] }>;
  },
  options: {
    sessionId: string;
    plan: ApplicationEntryPlan;
    timeoutMs: number;
    intervalMs: number;
  }
): Promise<ApplicationEntryCheck> {
  const startedAt = performance.now();
  const samples: ApplicationEntrySample[] = [];
  if (!options.plan.configured) {
    return {
      configured: false,
      reached: false,
      timedOut: false,
      method: "not-configured",
      coreId: options.plan.coreId,
      source: options.plan.source,
      codeRanges: options.plan.codeRanges,
      timeoutMs: options.timeoutMs,
      intervalMs: options.intervalMs,
      pollIterations: 0,
      durationMs: performance.now() - startedAt,
      samples: [],
      reason: options.plan.reason
    };
  }

  const deadline = startedAt + options.timeoutMs;
  let pollIterations = 0;
  let lastPc: string | undefined;
  let lastError: StructuredError | undefined;
  while (performance.now() <= deadline) {
    pollIterations += 1;
    try {
      const snapshot = await manager.getMulticoreSnapshot(options.sessionId, [options.plan.coreId]);
      const core = snapshot.cores.find(candidate => candidate.coreId === options.plan.coreId);
      const pc = core?.pc;
      const pcValue = parseAddress(pc);
      const inApplicationCode = core?.connected === true
        && pcValue !== undefined
        && options.plan.codeRanges.some(range => contains(range, pcValue));
      lastPc = pc;
      lastError = undefined;
      samples.push({
        at: new Date().toISOString(),
        ...(pc ? { pc } : {}),
        ...(pcValue !== undefined ? { pcValue } : {}),
        ...(core?.state ? { state: core.state } : {}),
        ...(core?.connected !== undefined ? { connected: core.connected } : {}),
        inApplicationCode
      });
      if (inApplicationCode) {
        return {
          configured: true,
          reached: true,
          timedOut: false,
          method: "pc-in-application-code",
          coreId: options.plan.coreId,
          entryAddress: options.plan.entryAddressHex,
          source: options.plan.source,
          codeRanges: options.plan.codeRanges,
          timeoutMs: options.timeoutMs,
          intervalMs: options.intervalMs,
          pollIterations,
          durationMs: performance.now() - startedAt,
          samples,
          lastPc
        };
      }
    } catch (error) {
      lastError = toStructuredError(error);
      samples.push({
        at: new Date().toISOString(),
        inApplicationCode: false,
        error: lastError
      });
    }
    const remainingMs = deadline - performance.now();
    if (remainingMs <= 0) break;
    await sleep(Math.min(options.intervalMs, remainingMs));
  }
  return {
    configured: true,
    reached: false,
    timedOut: true,
    method: "pc-in-application-code",
    coreId: options.plan.coreId,
    entryAddress: options.plan.entryAddressHex,
    source: options.plan.source,
    codeRanges: options.plan.codeRanges,
    timeoutMs: options.timeoutMs,
    intervalMs: options.intervalMs,
    pollIterations,
    durationMs: performance.now() - startedAt,
    samples,
    ...(lastPc ? { lastPc } : {}),
    ...(lastError ? { lastError } : {}),
    reason: lastError
      ? "The CPU1 application-entry read could not complete before the bounded check expired."
      : "CPU1 PC remained outside the declared application code ranges."
  };
}

export function parseAddress(value: string | number | undefined): number | undefined {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  }
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (!normalized) return undefined;
  const parsed = /^0x[0-9a-f]+$/i.test(normalized)
    ? Number.parseInt(normalized.slice(2), 16)
    : /^[0-9a-f]+$/i.test(normalized) && (/[a-f]/i.test(normalized) || normalized.length >= 6)
      ? Number.parseInt(normalized, 16)
      : Number(normalized);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

export function formatAddress(value: number | undefined): string | undefined {
  return value === undefined ? undefined : `0x${value.toString(16).padStart(8, "0")}`;
}

function executableRanges(map: ParsedLinkerMap | undefined): ApplicationCodeRange[] {
  if (!map) return [];
  return map.sections
    .filter(section => section.length > 0)
    .filter(section => {
      const memory = map.memoryRegions.find(region => region.name === section.memoryRegion);
      return /(?:^|\.)(?:text|cinit|pinit|reset|codestart|TI\.ramfunc|ramfunc|init_array)(?:$|[.:])/i.test(section.name)
        || memory?.attr?.includes("X") === true;
    })
    .map(section => ({
      name: section.name,
      origin: section.origin,
      length: section.length,
      endExclusive: section.origin + section.length,
      ...(section.memoryRegion ? { memoryRegion: section.memoryRegion } : {})
    }))
    .sort((left, right) => left.origin - right.origin);
}

function contains(range: ApplicationCodeRange, address: number): boolean {
  return address >= range.origin && address < range.endExclusive;
}
