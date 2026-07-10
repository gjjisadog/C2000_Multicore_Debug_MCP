import { readdir, stat } from "node:fs/promises";
import path from "node:path";

export type ProgramDiscoverySource = "env" | "discovered" | "missing";

export interface ProgramDiscoveryEntry {
  selected?: string;
  source: ProgramDiscoverySource;
  candidates: string[];
}

export interface ProgramDiscoveryResult {
  cpu1: ProgramDiscoveryEntry;
  cpu2: ProgramDiscoveryEntry;
  searchRoots: string[];
}

export interface ProgramDiscoveryOptions {
  cpu1Program?: string;
  cpu2Program?: string;
  searchRoots?: string[];
  maxDepth?: number;
}

export async function discoverAcceptancePrograms(options: ProgramDiscoveryOptions = {}): Promise<ProgramDiscoveryResult> {
  const searchRoots = uniqueStrings((options.searchRoots ?? []).filter(Boolean).map(item => path.resolve(item)));
  const candidates = await collectOutFiles(searchRoots, options.maxDepth ?? 5);
  const cpu1Candidates = rankCandidates(candidates, "cpu1");
  const cpu2Candidates = rankCandidates(candidates, "cpu2");

  return {
    searchRoots,
    cpu1: selectEntry(options.cpu1Program, cpu1Candidates),
    cpu2: selectEntry(options.cpu2Program, cpu2Candidates)
  };
}

function selectEntry(explicitProgram: string | undefined, candidates: string[]): ProgramDiscoveryEntry {
  if (explicitProgram) {
    return {
      selected: explicitProgram,
      source: "env",
      candidates: uniqueStrings([explicitProgram, ...candidates])
    };
  }
  if (candidates.length > 0) {
    return {
      selected: candidates[0],
      source: "discovered",
      candidates
    };
  }
  return {
    source: "missing",
    candidates: []
  };
}

async function collectOutFiles(searchRoots: string[], maxDepth: number): Promise<string[]> {
  const collected: string[] = [];
  for (const root of searchRoots) {
    collected.push(...await collectOutFilesFromRoot(root, maxDepth));
  }
  return uniqueStrings(collected).sort();
}

async function collectOutFilesFromRoot(root: string, maxDepth: number): Promise<string[]> {
  try {
    const info = await stat(root);
    if (info.isFile()) {
      return root.toLowerCase().endsWith(".out") ? [root] : [];
    }
    if (!info.isDirectory()) {
      return [];
    }
  } catch {
    return [];
  }
  return walk(root, maxDepth);
}

async function walk(directory: string, depthRemaining: number): Promise<string[]> {
  if (depthRemaining < 0) {
    return [];
  }
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const results: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".out")) {
      results.push(fullPath);
    } else if (entry.isDirectory() && !shouldSkipDirectory(entry.name)) {
      results.push(...await walk(fullPath, depthRemaining - 1));
    }
  }
  return results;
}

function rankCandidates(candidates: string[], core: "cpu1" | "cpu2"): string[] {
  return candidates
    .filter(candidate => candidateScore(candidate, core) > 0)
    .sort((left, right) => candidateScore(right, core) - candidateScore(left, core) || left.localeCompare(right));
}

function candidateScore(candidate: string, core: "cpu1" | "cpu2"): number {
  const normalized = candidate.toLowerCase();
  const otherCore = core === "cpu1" ? "cpu2" : "cpu1";
  if (normalized.includes(otherCore)) {
    return 0;
  }
  let score = 0;
  if (normalized.includes(core)) {
    score += 10;
  }
  if (normalized.includes(core === "cpu1" ? "cpu1_ram" : "cpu2_ram")) {
    score += 6;
  }
  if (normalized.includes("f28p65x")) {
    score += 2;
  }
  if (normalized.includes("ipc")) {
    score += 1;
  }
  return score;
}

function shouldSkipDirectory(name: string): boolean {
  return [".git", "node_modules", "dist", "DebugServer", ".metadata"].includes(name);
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}
