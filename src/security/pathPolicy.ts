import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { DebugMcpError, type DebugErrorCode } from "../utils/errors.js";

export interface FilesystemPolicy { allowedReadRoots: string[]; allowedWriteRoots: string[] }

/**
 * Add paths that came from the trusted runtime configuration to the read
 * policy. Per-call paths are still checked against the resulting allowlist by
 * validateToolPaths; this helper does not broaden access based on tool input.
 */
export function withAdditionalReadRoots(
  policy: FilesystemPolicy | undefined,
  options: { roots?: Array<string | undefined>; files?: Array<string | undefined> }
): FilesystemPolicy {
  const readRoots = new Set(policy?.allowedReadRoots ?? []);
  for (const root of options.roots ?? []) {
    if (typeof root === "string" && root.length > 0) readRoots.add(root);
  }
  for (const file of options.files ?? []) {
    if (typeof file === "string" && file.length > 0) readRoots.add(path.dirname(file));
  }
  return {
    allowedReadRoots: [...readRoots],
    allowedWriteRoots: [...(policy?.allowedWriteRoots ?? [])]
  };
}

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
  const pending = new Map<string, Promise<void>>();
  await visit(input, async (key, value) => {
    const operation = ["outputDir", "logFile", "outputPath"].includes(key)
      ? "write"
      : ["ccxmlPath", "programUri", "mapUri", "mapPath", "cpu1Program", "cpu2Program", "cpu1OutPath", "cpu2OutPath", "cpu1MapPath", "cpu2MapPath", "ccsInstallPath", "offlineJsonPath", "offlineCsvPath", "offlineMarkdownPath", "searchRoots"].includes(key)
        ? "read"
        : undefined;
    if (!operation) return;
    const dedupeKey = `${operation}:${value}`;
    if (pending.has(dedupeKey)) return;
    pending.set(dedupeKey, operation === "write"
      ? assertAllowedWritePath(value, policy).then(() => undefined)
      : assertAllowedReadPath(value, policy).then(() => undefined));
  });
  await Promise.all(pending.values());
}

async function visit(value: unknown, check: (key: string, value: string) => Promise<void>, parentKey = ""): Promise<void> {
  if (typeof value === "string") { if (parentKey) await check(parentKey, value); return; }
  if (Array.isArray(value)) { for (const item of value) await visit(item, check, parentKey); return; }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const [key, child] of Object.entries(record)) {
      if (record.load === false && (key === "programUri" || key === "mapUri")) continue;
      await visit(child, check, key);
    }
  }
}
