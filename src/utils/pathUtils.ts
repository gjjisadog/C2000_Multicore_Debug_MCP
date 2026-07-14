import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Normalize a program/map path from tool input.
 * Handles surrounding quotes, file:// URLs, ~ expansion, and relative paths.
 * Relative paths resolve against `baseDir` when provided (CCS workspace), else cwd.
 */
export function normalizeProgramUri(programUri: string, baseDir?: string): string {
  let value = programUri.trim();
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1).trim();
  }
  if (value.startsWith("file:")) {
    try {
      value = fileURLToPath(value);
    } catch {
      // Keep original text so access() fails with a clear path later.
    }
  }
  if (value === "~") {
    value = os.homedir();
  } else if (value.startsWith("~/") || value.startsWith("~\\")) {
    value = path.join(os.homedir(), value.slice(2));
  }
  if (value.length > 0 && !path.isAbsolute(value)) {
    value = path.resolve(baseDir && baseDir.length > 0 ? baseDir : process.cwd(), value);
  }
  return value;
}

/** Normalize an optional workspace directory the same way as program paths. */
export function normalizeWorkspacePath(workspacePath: string | undefined): string | undefined {
  if (workspacePath === undefined || workspacePath.trim().length === 0) {
    return undefined;
  }
  return normalizeProgramUri(workspacePath);
}
