import { readdir, stat } from "node:fs/promises";
import path from "node:path";

export type ProgramDiscoverySource = "env" | "discovered" | "missing";
export type ProgramConfiguration = "RAM" | "FLASH";

export interface ProgramArtifactIdentity {
  path: string;
  core?: "cpu1" | "cpu2";
  device?: string;
  configuration?: ProgramConfiguration;
  example?: string;
}

export interface ProgramPairValidation {
  complete: boolean;
  compatible: boolean;
  cpu1?: ProgramArtifactIdentity;
  cpu2?: ProgramArtifactIdentity;
  issues: string[];
}

export interface ProgramDiscoveryEntry {
  selected?: string;
  source: ProgramDiscoverySource;
  candidates: string[];
}

export interface ProgramDiscoveryResult {
  cpu1: ProgramDiscoveryEntry;
  cpu2: ProgramDiscoveryEntry;
  pairing?: ProgramPairValidation;
  searchRoots: string[];
}

export interface ProgramDiscoveryOptions {
  cpu1Program?: string;
  cpu2Program?: string;
  searchRoots?: string[];
  maxDepth?: number;
  expectedDevice?: string;
}

export async function discoverAcceptancePrograms(options: ProgramDiscoveryOptions = {}): Promise<ProgramDiscoveryResult> {
  const searchRoots = uniqueStrings((options.searchRoots ?? []).filter(Boolean).map(item => path.resolve(item)));
  const candidates = await collectOutFiles(searchRoots, options.maxDepth ?? 5);
  const cpu1Candidates = rankCandidates(candidates, "cpu1");
  const cpu2Candidates = rankCandidates(candidates, "cpu2");
  const selection = selectCompatiblePair(
    options.cpu1Program ? [options.cpu1Program] : cpu1Candidates,
    options.cpu2Program ? [options.cpu2Program] : cpu2Candidates,
    options.expectedDevice ?? "F28P65x"
  );
  const cpu1Selected = options.cpu1Program ?? selection.cpu1;
  const cpu2Selected = options.cpu2Program ?? selection.cpu2;

  return {
    searchRoots,
    cpu1: selectEntry(options.cpu1Program, cpu1Candidates, cpu1Selected),
    cpu2: selectEntry(options.cpu2Program, cpu2Candidates, cpu2Selected),
    pairing: validateProgramPair(cpu1Selected, cpu2Selected, options.expectedDevice ?? "F28P65x")
  };
}

export function describeProgramArtifact(artifactPath: string): ProgramArtifactIdentity {
  const normalized = artifactPath.toLowerCase().replace(/\\/g, "/");
  const filename = path.basename(normalized, path.extname(normalized));
  const core = /(?:^|[^a-z0-9])(?:cpu1|c28x1)(?:[^a-z0-9]|$)/.test(normalized)
    ? "cpu1"
    : /(?:^|[^a-z0-9])(?:cpu2|c28x2)(?:[^a-z0-9]|$)/.test(normalized)
      ? "cpu2"
      : undefined;
  const device = normalized.match(/(?:^|[^a-z0-9])((?:f28p|f283|f280)\d+[a-z0-9]*)(?:[^a-z0-9]|$)/)?.[1];
  const configurationMatch = normalized.match(/(?:^|[\/_-])(ram|flash)(?:[\/_-]|$)/)?.[1];
  const example = filename
    .replace(/(?:cpu1|cpu2|c28x1|c28x2)/g, "")
    .replace(/(?:f28p|f283|f280)\d+[a-z0-9]*/g, "")
    .replace(/(?:^|[_-])(?:ram|flash)(?:[_-]|$)/g, "_")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return {
    path: artifactPath,
    ...(core ? { core } : {}),
    ...(device ? { device } : {}),
    ...(configurationMatch ? { configuration: configurationMatch.toUpperCase() as ProgramConfiguration } : {}),
    ...(example ? { example } : {})
  };
}

export function validateProgramPair(cpu1Path?: string, cpu2Path?: string, expectedDevice?: string): ProgramPairValidation {
  const cpu1 = cpu1Path ? describeProgramArtifact(cpu1Path) : undefined;
  const cpu2 = cpu2Path ? describeProgramArtifact(cpu2Path) : undefined;
  const issues: string[] = [];
  if (!cpu1) {
    issues.push("CPU1 artifact is missing");
  }
  if (!cpu2) {
    issues.push("CPU2 artifact is missing");
  }
  if (cpu1 && cpu2) {
    if (path.resolve(cpu1.path) === path.resolve(cpu2.path)) {
      issues.push("CPU1 and CPU2 resolve to the same artifact");
    }
    if (cpu1.core && cpu1.core !== "cpu1") {
      issues.push(`CPU1 selection is labeled for ${cpu1.core.toUpperCase()}`);
    }
    if (cpu2.core && cpu2.core !== "cpu2") {
      issues.push(`CPU2 selection is labeled for ${cpu2.core.toUpperCase()}`);
    }
    compareKnownIdentity("device", cpu1.device, cpu2.device, issues);
    compareKnownIdentity("configuration", cpu1.configuration, cpu2.configuration, issues);
    if (cpu1.core && cpu2.core) {
      compareKnownIdentity("example", cpu1.example, cpu2.example, issues);
    }
  }
  const normalizedExpectedDevice = expectedDevice?.toLowerCase();
  if (normalizedExpectedDevice) {
    for (const [label, artifact] of [["CPU1", cpu1], ["CPU2", cpu2]] as const) {
      if (artifact?.device && artifact.device !== normalizedExpectedDevice) {
        issues.push(`${label} device ${artifact.device} does not match expected ${normalizedExpectedDevice}`);
      }
    }
  }
  const complete = cpu1 !== undefined && cpu2 !== undefined;
  return { complete, compatible: complete && issues.length === 0, ...(cpu1 ? { cpu1 } : {}), ...(cpu2 ? { cpu2 } : {}), issues };
}

function compareKnownIdentity(label: string, left: string | undefined, right: string | undefined, issues: string[]): void {
  if (left && right && left !== right) {
    issues.push(`CPU1/CPU2 ${label} mismatch: ${left} vs ${right}`);
  }
}

function selectCompatiblePair(cpu1Candidates: string[], cpu2Candidates: string[], expectedDevice: string): { cpu1?: string; cpu2?: string } {
  for (const cpu1 of cpu1Candidates) {
    for (const cpu2 of cpu2Candidates) {
      if (validateProgramPair(cpu1, cpu2, expectedDevice).compatible) {
        return { cpu1, cpu2 };
      }
    }
  }
  return { cpu1: cpu1Candidates[0], cpu2: cpu2Candidates[0] };
}

function selectEntry(explicitProgram: string | undefined, candidates: string[], selected?: string): ProgramDiscoveryEntry {
  if (explicitProgram) {
    return { selected: explicitProgram, source: "env", candidates: uniqueStrings([explicitProgram, ...candidates]) };
  }
  if (selected) {
    return { selected, source: "discovered", candidates };
  }
  return { source: "missing", candidates: [] };
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
  const identity = describeProgramArtifact(candidate);
  if (identity.core && identity.core !== core) {
    return 0;
  }
  let score = identity.core === core ? 10 : 0;
  if (identity.configuration) {
    score += 6;
  }
  if (identity.device === "f28p65x") {
    score += 2;
  }
  if (candidate.toLowerCase().includes("ipc")) {
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
