import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { DebugMcpError, type DebugErrorCode } from "../utils/errors.js";

export interface FilesystemPolicy { allowedReadRoots: string[]; allowedWriteRoots: string[] }

export async function assertAllowedReadPath(candidate: string, policy: FilesystemPolicy): Promise<string> {
  return assertAllowedPath(candidate, policy.allowedReadRoots, "PathOutsideAllowedReadRoots", true);
}

export async function assertAllowedWritePath(candidate: string, policy: FilesystemPolicy): Promise<string> {
  return assertAllowedPath(candidate, policy.allowedWriteRoots, "PathOutsideAllowedWriteRoots", true);
}

async function assertAllowedPath(candidate: string, roots: string[], code: DebugErrorCode, allowMissingLeaf: boolean): Promise<string> {
  try {
    const resolved = path.resolve(candidate);
    const canonical = allowMissingLeaf ? await canonicalizeMissingPath(resolved) : await realpath(resolved);
    const canonicalRoots = await Promise.all(roots.map(root => canonicalizeMissingPath(path.resolve(root))));
    if (!canonicalRoots.some(root => isWithin(canonical, root))) {
      throw new DebugMcpError(code, `Path is outside configured filesystem roots: ${candidate}`, { path: candidate, resolved: canonical, allowedRoots: canonicalRoots });
    }
    return canonical;
  } catch (error) {
    if (error instanceof DebugMcpError) throw error;
    throw new DebugMcpError("PathResolutionFailed", `Unable to securely resolve path: ${candidate}`, { path: candidate, cause: String(error) });
  }
}

async function canonicalizeMissingPath(candidate: string): Promise<string> {
  let cursor = candidate;
  const suffix: string[] = [];
  while (true) {
    try {
      await lstat(cursor);
      return path.join(await realpath(cursor), ...suffix.reverse());
    } catch {
      const parent = path.dirname(cursor);
      if (parent === cursor) throw new Error(`No existing parent for ${candidate}`);
      suffix.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

function isWithin(candidate: string, root: string): boolean {
  const normalize = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
  const relative = path.relative(normalize(root), normalize(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function validateToolPaths(input: unknown, policy: FilesystemPolicy): Promise<void> {
  await visit(input, async (key, value) => {
    if (["outputDir", "logFile"].includes(key)) await assertAllowedWritePath(value, policy);
    if (["ccxmlPath", "programUri", "mapUri", "mapPath", "cpu1Program", "cpu2Program", "cpu1OutPath", "cpu2OutPath", "cpu1MapPath", "cpu2MapPath", "ccsInstallPath"].includes(key)) await assertAllowedReadPath(value, policy);
    if (key === "searchRoots") await assertAllowedReadPath(value, policy);
  });
}

async function visit(value: unknown, check: (key: string, value: string) => Promise<void>, parentKey = ""): Promise<void> {
  if (typeof value === "string") { if (parentKey) await check(parentKey, value); return; }
  if (Array.isArray(value)) { for (const item of value) await visit(item, check, parentKey); return; }
  if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) await visit(child, check, key);
}
