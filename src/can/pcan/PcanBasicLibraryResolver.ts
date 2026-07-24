import { access } from "node:fs/promises";
import path from "node:path";
import { DebugMcpError } from "../../utils/errors.js";

export async function resolvePcanBasicLibrary(explicitPath?: string): Promise<string> {
  if (process.platform !== "win32") {
    throw new DebugMcpError("PcanPlatformUnsupported", "PCAN-Basic is supported only on Windows", { platform: process.platform, arch: process.arch });
  }
  if (process.arch !== "x64") {
    throw new DebugMcpError("PcanPlatformUnsupported", "This PCAN-Basic backend requires Windows x64", { platform: process.platform, arch: process.arch });
  }
  const pathEntries = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const candidates = [
    explicitPath,
    process.env.C2000_PCAN_BASIC_LIBRARY,
    "C:\\Windows\\System32\\PCANBasic.dll",
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "PEAK-System", "PCAN-Basic API", "x64", "PCANBasic.dll") : undefined,
    ...pathEntries.map(entry => path.join(entry, "PCANBasic.dll"))
  ].filter((value): value is string => Boolean(value));
  for (const candidate of [...new Set(candidates.map(value => path.resolve(value)))]) {
    try { await access(candidate); return candidate; } catch {}
  }
  throw new DebugMcpError("PcanLibraryNotFound", "PCANBasic.dll was not found; install the official PEAK PCAN-Basic package", { attempts: candidates });
}
