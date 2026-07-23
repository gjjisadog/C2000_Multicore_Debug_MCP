import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

const macosCcsInstallPath = "/Applications/ti/ccs2100/ccs";
const macosCcxmlPath = "/Applications/ti/C2000Ware_26_01_00_00_STS/device_support/f28p65x/common/targetConfigs/TMS320F28P650DK9.ccxml";
const windowsCcsInstallPath = "C:\\ti\\ccs2100\\ccs";
const windowsCcxmlRelativePath = [
  "device_support",
  "f28p65x",
  "common",
  "targetConfigs",
  "TMS320F28P650DK9.ccxml"
];

export function defaultCcsInstallPath(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? windowsCcsInstallPath : macosCcsInstallPath;
}

export function resolveCcsInstallPath(
  ccsInstallPath?: string,
  platform: NodeJS.Platform = process.platform
): string {
  if (ccsInstallPath ?? process.env.C2000_MCP_CCS_INSTALL_PATH) {
    return ccsInstallPath ?? process.env.C2000_MCP_CCS_INSTALL_PATH!;
  }
  return platform === "win32"
    ? discoverWindowsCcsInstallPath() ?? defaultCcsInstallPath(platform)
    : defaultCcsInstallPath(platform);
}

export function resolveCcxmlPath(ccxmlPath?: string, platform: NodeJS.Platform = process.platform): string {
  if (ccxmlPath ?? process.env.C2000_MCP_CCXML_PATH) {
    return ccxmlPath ?? process.env.C2000_MCP_CCXML_PATH!;
  }
  return platform === "win32"
    ? discoverWindowsCcxmlPath() ?? path.win32.join("C:\\ti\\c2000", "C2000Ware_26_01_00_00", ...windowsCcxmlRelativePath)
    : macosCcxmlPath;
}

export function resolveXdsdfuPath(ccsInstallPath: string, platform: NodeJS.Platform = process.platform): string {
  const platformPath = platform === "win32" ? path.win32 : path.posix;
  return platformPath.join(
    ccsInstallPath,
    "ccs_base",
    "common",
    "uscif",
    "xds110",
    platform === "win32" ? "xdsdfu.exe" : "xdsdfu"
  );
}

function discoverWindowsCcsInstallPath(): string | undefined {
  for (const root of windowsSearchRoots()) {
    for (const base of [root, path.win32.join(root, "ti")]) {
      for (const candidate of ccsInstallCandidates(base)) {
        if (existsSync(path.win32.join(candidate, "ccs_base"))) {
          return candidate;
        }
      }
    }
  }
  return undefined;
}

function discoverWindowsCcxmlPath(): string | undefined {
  for (const root of windowsSearchRoots()) {
    for (const base of [path.win32.join(root, "ti", "c2000"), path.win32.join(root, "ti")]) {
      for (const c2000WareDirectory of matchingDirectories(base, /^C2000Ware_/i)) {
        const candidate = path.win32.join(base, c2000WareDirectory, ...windowsCcxmlRelativePath);
        if (existsSync(candidate)) {
          return candidate;
        }
      }
    }
  }
  return undefined;
}

function windowsSearchRoots(): string[] {
  return Array.from({ length: 26 }, (_, index) => `${String.fromCharCode("C".charCodeAt(0) + index)}:\\`)
    .filter(root => existsSync(root));
}

function ccsInstallCandidates(base: string): string[] {
  return matchingDirectories(base, /^ccs/i).flatMap(directory => [
    path.win32.join(base, directory),
    path.win32.join(base, directory, "ccs")
  ]);
}

function matchingDirectories(base: string, namePattern: RegExp): string[] {
  try {
    return readdirSync(base, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && namePattern.test(entry.name))
      .map(entry => entry.name)
      .sort((left, right) => right.localeCompare(left));
  } catch {
    return [];
  }
}
