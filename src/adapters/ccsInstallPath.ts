import { access, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface CcsInstallResolution {
  installPath: string;
  source: "explicit" | "env" | "discovered" | "default-fallback";
  dssLauncherPath: string;
  candidates: string[];
  reason: string;
}

/** Well-known roots where TI CCS is commonly installed. */
export function defaultCcsSearchRoots(platform: NodeJS.Platform = process.platform): string[] {
  if (platform === "win32") {
    return ["C:\\ti", "D:\\ti", path.join(os.homedir(), "ti")];
  }
  if (platform === "darwin") {
    return ["/Applications/ti", path.join(os.homedir(), "ti")];
  }
  return ["/opt/ti", "/usr/local/ti", path.join(os.homedir(), "ti")];
}

export function dssLauncherRelativePath(platform: NodeJS.Platform = process.platform): string {
  return path.join("ccs_base", "scripting", "bin", platform === "win32" ? "dss.bat" : "dss.sh");
}

export function dssLauncherPathForInstall(installPath: string, platform: NodeJS.Platform = process.platform): string {
  return path.join(installPath, dssLauncherRelativePath(platform));
}

export function isCcsInstallPath(installPath: string, platform: NodeJS.Platform = process.platform): boolean {
  return existsSync(dssLauncherPathForInstall(installPath, platform));
}

/**
 * Score CCS install paths so newer product trees win.
 * Examples: ccs2100 > ccs2000 > ccs1281 > bare "ccs".
 */
export function scoreCcsInstallPath(installPath: string): number {
  const normalized = installPath.replace(/\\/g, "/");
  const match = /ccs[_-]?(\d{3,4})/i.exec(normalized);
  if (match) {
    return Number.parseInt(match[1], 10);
  }
  if (/\/ccs$/i.test(normalized) || /\\ccs$/i.test(installPath)) {
    return 1;
  }
  return 0;
}

export function sortCcsInstallCandidates(candidates: string[]): string[] {
  return [...new Set(candidates.map(item => path.resolve(item)))].sort((left, right) => {
    const scoreDiff = scoreCcsInstallPath(right) - scoreCcsInstallPath(left);
    if (scoreDiff !== 0) {
      return scoreDiff;
    }
    return right.localeCompare(left);
  });
}

/**
 * Expand a search root into possible CCS install directories that contain DSS.
 * Accepts either `.../ccs2100/ccs` or `.../ccs2100` layouts.
 */
export async function discoverCcsInstallCandidates(
  searchRoots: string[] = defaultCcsSearchRoots(),
  platform: NodeJS.Platform = process.platform
): Promise<string[]> {
  const found: string[] = [];
  for (const root of searchRoots) {
    if (!existsSync(root)) {
      continue;
    }
    if (isCcsInstallPath(root, platform)) {
      found.push(path.resolve(root));
    }
    let entries: string[] = [];
    try {
      entries = await readdir(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!/^ccs/i.test(entry)) {
        continue;
      }
      const productDir = path.join(root, entry);
      const nestedCcs = path.join(productDir, "ccs");
      if (isCcsInstallPath(nestedCcs, platform)) {
        found.push(path.resolve(nestedCcs));
      } else if (isCcsInstallPath(productDir, platform)) {
        found.push(path.resolve(productDir));
      }
    }
  }
  return sortCcsInstallCandidates(found);
}

export async function resolveCcsInstallPath(options: {
  installPath?: string;
  envInstallPath?: string;
  searchRoots?: string[];
  platform?: NodeJS.Platform;
  allowMissingFallback?: boolean;
} = {}): Promise<CcsInstallResolution> {
  const platform = options.platform ?? process.platform;
  const envInstallPath = options.envInstallPath ?? process.env.C2000_MCP_CCS_INSTALL_PATH;
  const candidates = await discoverCcsInstallCandidates(options.searchRoots, platform);
  const fallbackDefault = platform === "win32" ? "C:\\ti\\ccs\\ccs" : "/Applications/ti/ccs2100/ccs";

  if (options.installPath) {
    const installPath = path.resolve(options.installPath);
    return {
      installPath,
      source: "explicit",
      dssLauncherPath: dssLauncherPathForInstall(installPath, platform),
      candidates,
      reason: isCcsInstallPath(installPath, platform)
        ? "using explicit ccs.installPath"
        : "using explicit ccs.installPath (DSS launcher not found at that path)"
    };
  }

  if (envInstallPath) {
    const installPath = path.resolve(envInstallPath);
    return {
      installPath,
      source: "env",
      dssLauncherPath: dssLauncherPathForInstall(installPath, platform),
      candidates,
      reason: isCcsInstallPath(installPath, platform)
        ? "using C2000_MCP_CCS_INSTALL_PATH"
        : "using C2000_MCP_CCS_INSTALL_PATH (DSS launcher not found at that path)"
    };
  }

  if (candidates.length > 0) {
    const installPath = candidates[0]!;
    return {
      installPath,
      source: "discovered",
      dssLauncherPath: dssLauncherPathForInstall(installPath, platform),
      candidates,
      reason: `discovered CCS install with DSS among ${candidates.length} candidate(s); preferred highest version score`
    };
  }

  return {
    installPath: fallbackDefault,
    source: "default-fallback",
    dssLauncherPath: dssLauncherPathForInstall(fallbackDefault, platform),
    candidates,
    reason: `no CCS install discovered; falling back to ${fallbackDefault}`
  };
}

/** Synchronous resolve for places that cannot await (uses existsSync discovery only). */
export function resolveCcsInstallPathSync(options: {
  installPath?: string;
  envInstallPath?: string;
  searchRoots?: string[];
  platform?: NodeJS.Platform;
} = {}): CcsInstallResolution {
  const platform = options.platform ?? process.platform;
  const envInstallPath = options.envInstallPath ?? process.env.C2000_MCP_CCS_INSTALL_PATH;
  const searchRoots = options.searchRoots ?? defaultCcsSearchRoots(platform);
  const candidates: string[] = [];
  for (const root of searchRoots) {
    if (!existsSync(root)) {
      continue;
    }
    if (isCcsInstallPath(root, platform)) {
      candidates.push(path.resolve(root));
    }
    try {
      // readdirSync would be better but keep deps light with exists heuristics for common layouts.
      const common = [
        path.join(root, "ccs2100", "ccs"),
        path.join(root, "ccs2000", "ccs"),
        path.join(root, "ccs1281", "ccs"),
        path.join(root, "ccs1271", "ccs"),
        path.join(root, "ccs1260", "ccs"),
        path.join(root, "ccs1200", "ccs"),
        path.join(root, "ccs", "ccs"),
        path.join(root, "ccs")
      ];
      for (const candidate of common) {
        if (isCcsInstallPath(candidate, platform)) {
          candidates.push(path.resolve(candidate));
        }
      }
    } catch {
      // ignore
    }
  }
  const sorted = sortCcsInstallCandidates(candidates);
  const fallbackDefault = platform === "win32" ? "C:\\ti\\ccs\\ccs" : "/Applications/ti/ccs2100/ccs";

  if (options.installPath) {
    const installPath = path.resolve(options.installPath);
    return {
      installPath,
      source: "explicit",
      dssLauncherPath: dssLauncherPathForInstall(installPath, platform),
      candidates: sorted,
      reason: "using explicit ccs.installPath"
    };
  }
  if (envInstallPath) {
    const installPath = path.resolve(envInstallPath);
    return {
      installPath,
      source: "env",
      dssLauncherPath: dssLauncherPathForInstall(installPath, platform),
      candidates: sorted,
      reason: "using C2000_MCP_CCS_INSTALL_PATH"
    };
  }
  if (sorted.length > 0) {
    const installPath = sorted[0]!;
    return {
      installPath,
      source: "discovered",
      dssLauncherPath: dssLauncherPathForInstall(installPath, platform),
      candidates: sorted,
      reason: "synchronously discovered CCS install path"
    };
  }
  return {
    installPath: fallbackDefault,
    source: "default-fallback",
    dssLauncherPath: dssLauncherPathForInstall(fallbackDefault, platform),
    candidates: sorted,
    reason: `no CCS install discovered; falling back to ${fallbackDefault}`
  };
}

export async function assertPathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
