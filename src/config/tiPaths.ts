import { access, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type TiPathKind = "ccs" | "c2000ware" | "ccxml";
export type TiPathSource = "explicit" | "discovered" | "derived" | "unresolved";

export interface TiPathAttempt {
  kind: TiPathKind;
  path: string;
  source: Exclude<TiPathSource, "derived" | "unresolved"> | "derived";
  valid: boolean;
  reason: string;
  version?: string;
}

export interface ResolvedTiPath {
  path?: string;
  version?: string;
  source: TiPathSource;
  valid: boolean;
  anchor?: string;
}

export interface TiEnvironmentResolution {
  ccs: ResolvedTiPath;
  c2000Ware: ResolvedTiPath;
  ccxml: ResolvedTiPath;
  attempts: TiPathAttempt[];
}

export interface ResolveTiEnvironmentOptions {
  ccsInstallPath?: string;
  c2000WarePath?: string;
  ccxmlPath?: string;
  homeDir?: string;
  applicationRoots?: string[];
}

const F28P65X_CCXML = path.join("device_support", "f28p65x", "common", "targetConfigs", "TMS320F28P650DK9.ccxml");

export async function resolveTiEnvironment(options: ResolveTiEnvironmentOptions = {}): Promise<TiEnvironmentResolution> {
  const homeDir = options.homeDir ?? os.homedir();
  const applicationRoots = options.applicationRoots ?? (process.platform === "darwin" ? ["/Applications/ti"] : []);
  const attempts: TiPathAttempt[] = [];

  const ccsCandidates = unique([
    ...(options.ccsInstallPath ? [{ path: options.ccsInstallPath, source: "explicit" as const }] : []),
    ...(await discoverCcsCandidates(homeDir, applicationRoots)).map(candidate => ({ path: candidate, source: "discovered" as const }))
  ]);
  const ccs = await selectCcs(ccsCandidates, attempts);

  const wareCandidates = unique([
    ...(options.c2000WarePath ? [{ path: options.c2000WarePath, source: "explicit" as const }] : []),
    ...(await discoverWareCandidates(homeDir, applicationRoots)).map(candidate => ({ path: candidate, source: "discovered" as const }))
  ]);
  const c2000Ware = await selectWare(wareCandidates, attempts);

  const derivedCcxml = c2000Ware.path ? path.join(c2000Ware.path, F28P65X_CCXML) : undefined;
  const ccxmlCandidates = unique([
    ...(options.ccxmlPath ? [{ path: options.ccxmlPath, source: "explicit" as const }] : []),
    ...(derivedCcxml ? [{ path: derivedCcxml, source: "derived" as const }] : [])
  ]);
  const ccxml = await selectCcxml(ccxmlCandidates, attempts);

  return { ccs, c2000Ware, ccxml, attempts };
}

async function discoverCcsCandidates(homeDir: string, applicationRoots: string[]): Promise<string[]> {
  const roots = [path.join(homeDir, "ti"), ...applicationRoots];
  const candidates: string[] = [];
  for (const root of roots) {
    for (const entry of await directories(root)) {
      if (/^ccs\d+$/i.test(entry)) candidates.push(path.join(root, entry, "ccs"));
    }
  }
  return candidates;
}

async function discoverWareCandidates(homeDir: string, applicationRoots: string[]): Promise<string[]> {
  const roots = [path.join(homeDir, "ti", "c2000"), path.join(homeDir, "ti")];
  for (const applicationRoot of applicationRoots) roots.push(path.join(applicationRoot, "c2000"), applicationRoot);
  const candidates: string[] = [];
  for (const root of roots) {
    for (const entry of await directories(root)) {
      if (/^C2000Ware_/i.test(entry)) candidates.push(path.join(root, entry));
    }
  }
  return candidates;
}

async function selectCcs(candidates: Candidate[], attempts: TiPathAttempt[]): Promise<ResolvedTiPath> {
  const valid: Array<Candidate & { version: string; anchor: string }> = [];
  for (const candidate of candidates) {
    const anchor = path.join(candidate.path, "ccs_base", "DebugServer", "bin", process.platform === "win32" ? "DSLite.exe" : "DSLite");
    const exists = await fileExists(anchor);
    const version = ccsVersion(candidate.path);
    attempts.push({ kind: "ccs", ...candidate, valid: exists, reason: exists ? "Validated CCS DSLite anchor" : "Missing CCS DSLite anchor", version });
    if (exists) valid.push({ ...candidate, version, anchor });
  }
  const selected = choose(valid);
  return selected ? { path: selected.path, version: selected.version, source: selected.source, valid: true, anchor: selected.anchor } : unresolved();
}

async function selectWare(candidates: Candidate[], attempts: TiPathAttempt[]): Promise<ResolvedTiPath> {
  const valid: Array<Candidate & { version: string; anchor: string }> = [];
  for (const candidate of candidates) {
    const anchor = path.join(candidate.path, ".metadata", "sdk.json");
    const sdk = await readSdk(anchor);
    attempts.push({ kind: "c2000ware", ...candidate, valid: Boolean(sdk), reason: sdk ? "Validated C2000Ware sdk.json anchor" : "Missing C2000Ware sdk.json anchor", ...(sdk ? { version: sdk.version } : {}) });
    if (sdk) valid.push({ ...candidate, version: sdk.version, anchor });
  }
  const selected = choose(valid);
  return selected ? { path: selected.path, version: selected.version, source: selected.source, valid: true, anchor: selected.anchor } : unresolved();
}

async function selectCcxml(candidates: Candidate[], attempts: TiPathAttempt[]): Promise<ResolvedTiPath> {
  for (const candidate of candidates) {
    const exists = await fileExists(candidate.path);
    attempts.push({ kind: "ccxml", ...candidate, valid: exists, reason: exists ? "Validated target configuration" : "Missing target configuration" });
    if (exists) return { path: candidate.path, source: candidate.source, valid: true, anchor: candidate.path };
  }
  return unresolved();
}

interface Candidate {
  path: string;
  source: "explicit" | "discovered" | "derived";
}

function unique<T extends Candidate>(candidates: T[]): T[] {
  const seen = new Set<string>();
  return candidates.filter(candidate => {
    const normalized = path.resolve(candidate.path);
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    candidate.path = normalized;
    return true;
  });
}

function choose<T extends Candidate & { version: string }>(candidates: T[]): T | undefined {
  const explicit = candidates.find(candidate => candidate.source === "explicit");
  if (explicit) return explicit;
  return [...candidates].sort((left, right) => compareVersions(right.version, left.version))[0];
}

function compareVersions(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function ccsVersion(ccsPath: string): string {
  const match = ccsPath.match(/ccs(\d{2})(\d{2})/i);
  return match ? `${Number(match[1])}.${Number(match[2])}.0` : "0.0.0";
}

async function readSdk(sdkPath: string): Promise<{ version: string } | undefined> {
  try {
    const parsed = JSON.parse(await readFile(sdkPath, "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? { version: parsed.version } : undefined;
  } catch {
    return undefined;
  }
}

async function directories(root: string): Promise<string[]> {
  try {
    return (await readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name);
  } catch {
    return [];
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function unresolved(): ResolvedTiPath {
  return { path: undefined, source: "unresolved", valid: false };
}
