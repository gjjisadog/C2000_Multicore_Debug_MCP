import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

export const DEBUG_BOUNDARY_SCAN_ROOTS = ["src", "scripts"] as const;

const forbiddenPatterns = [
  /callTool\s*\([^)]*["'](?:continue|pause|reset|connectTarget|disconnectTarget|getTargetState)["']/,
  /mcp__[^"'\s]+__(?:continue|pause|reset|connectTarget|disconnectTarget|getTargetState)/,
  new RegExp("\\b(?:get|set)?Active" + "Target\\b", "i"),
  new RegExp("\\b(?:get|set)?Current" + "Target\\b", "i"),
  /\bactive\s+target\b/i,
  /\bcurrent\s+target\b/i,
  /\bui\s+focus\b/i,
  /\bselected\s+cpu\b/i
] as const;

export async function findDebugBoundarySourceOffenders(roots: readonly string[] = DEBUG_BOUNDARY_SCAN_ROOTS): Promise<string[]> {
  const files = (await Promise.all(roots.map(root => listTypeScriptFiles(root)))).flat();
  const offenders: string[] = [];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    for (const pattern of forbiddenPatterns) {
      if (pattern.test(source)) {
        offenders.push(`${path.relative(process.cwd(), file)} matches ${pattern}`);
      }
    }
  }
  return offenders;
}

async function listTypeScriptFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async entry => {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      return listTypeScriptFiles(fullPath);
    }
    return entry.isFile() && entry.name.endsWith(".ts") ? [fullPath] : [];
  }));
  return nested.flat();
}
