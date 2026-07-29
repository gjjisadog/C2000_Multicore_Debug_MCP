import os from "node:os";
import path from "node:path";

const SECRET_KEY = /(token|secret|password|authorization|credential|private.?key|github|daemon.?rpc|lease.?token|environment|env)/i;

export function sanitizeEvidence<T>(value: T): T {
  return sanitizeValue(value) as T;
}

function sanitizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).flatMap(([key, item]) =>
      SECRET_KEY.test(key) ? [] : [[key, sanitizeValue(item)]]
    ));
  }
  if (typeof value === "string") return normalizePath(value);
  return value;
}

function normalizePath(value: string): string {
  const home = path.resolve(os.homedir());
  const resolved = path.resolve(value);
  if (path.isAbsolute(value) && (resolved === home || resolved.startsWith(`${home}${path.sep}`))) {
    return `<home>${resolved.slice(home.length)}`;
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
