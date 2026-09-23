import { access, readdir } from "node:fs/promises";
import path from "node:path";
import { DebugMcpError } from "../../utils/errors.js";

export interface PcanLibraryResolverOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  env?: NodeJS.ProcessEnv;
  searchDirectories?: string[];
}

export function isSupportedPcanBasicPlatform(platform: NodeJS.Platform, arch: string): boolean {
  return (platform === "win32" && arch === "x64")
    || (platform === "darwin" && (arch === "x64" || arch === "arm64"));
}

export async function resolvePcanBasicLibrary(
  explicitPath?: string,
  options: PcanLibraryResolverOptions = {}
): Promise<string> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const env = options.env ?? process.env;
  const pathApi = platform === "win32" ? path.win32 : path.posix;

  if (!isSupportedPcanBasicPlatform(platform, arch)) {
    throw new DebugMcpError("PcanPlatformUnsupported", "PCAN-Basic is supported on Windows x64 and macOS x64/ARM64", { platform, arch });
  }

  const pathEntries = (env.PATH ?? "").split(platform === "win32" ? ";" : ":").filter(Boolean);
  const explicitCandidates = [explicitPath, env.C2000_PCAN_BASIC_LIBRARY].filter((value): value is string => Boolean(value));
  const directories = [...new Set([
    ...(options.searchDirectories ?? []),
    ...pathEntries,
    ...(platform === "darwin" ? [
      "/opt/homebrew/lib",
      "/usr/local/lib",
      env.HOME ? pathApi.join(env.HOME, "lib") : undefined
    ].filter((value): value is string => Boolean(value)) : [])
  ])];

  const candidates = platform === "win32"
    ? [
      ...explicitCandidates,
      "C:\\Windows\\System32\\PCANBasic.dll",
      env.ProgramFiles ? pathApi.join(env.ProgramFiles, "PEAK-System", "PCAN-Basic API", "x64", "PCANBasic.dll") : undefined,
      ...directories.map(directory => pathApi.join(directory, "PCANBasic.dll"))
    ].filter((value): value is string => Boolean(value))
    : [
      ...explicitCandidates,
      ...await macLibraryCandidates(directories)
    ];

  const normalizedCandidates = [...new Set(candidates.map(value => pathApi.resolve(value)))];
  for (const candidate of normalizedCandidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Keep searching and include every attempted path in the final error.
    }
  }

  if (platform === "darwin") {
    throw new DebugMcpError(
      "PcanLibraryNotFound",
      "MacCAN libPCBUSB was not found; install MacCAN PCBUSB v0.13 or newer for a supported PCAN-USB device, or set C2000_PCAN_BASIC_LIBRARY",
      { attempts: normalizedCandidates, platform, arch }
    );
  }
  throw new DebugMcpError("PcanLibraryNotFound", "PCANBasic.dll was not found; install the official PEAK PCAN-Basic package", { attempts: normalizedCandidates, platform, arch });
}

async function macLibraryCandidates(directories: string[]): Promise<string[]> {
  const candidates: string[] = [];
  for (const directory of directories) {
    try {
      const names = await readdir(directory);
      const matches = names.filter(name => /^libPCBUSB(?:\.[0-9]+(?:\.[0-9]+)*)?\.dylib$/i.test(name));
      matches.sort((a, b) => compareLibraryVersion(b, a));
      candidates.push(...matches.map(name => path.posix.join(directory, name)));
    } catch {
      // Missing/unreadable search directories are expected on many installations.
    }
  }
  return candidates;
}

function compareLibraryVersion(left: string, right: string): number {
  const leftVersion = left.match(/^libPCBUSB(?:\.([0-9]+(?:\.[0-9]+)*))?\.dylib$/i)?.[1];
  const rightVersion = right.match(/^libPCBUSB(?:\.([0-9]+(?:\.[0-9]+)*))?\.dylib$/i)?.[1];
  if (!leftVersion) return rightVersion ? -1 : 0;
  if (!rightVersion) return 1;
  const leftParts = leftVersion.split(".").map(Number);
  const rightParts = rightVersion.split(".").map(Number);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
}
