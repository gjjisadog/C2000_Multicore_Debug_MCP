import path from "node:path";
import { fileURLToPath } from "node:url";

export type RuntimeEntrypointName = "daemon" | "worker" | "can-worker";

export interface RuntimeEntrypointCandidates {
  compiled: string[];
  source: string[];
  packageRoots: string[];
}

/**
 * Locates sibling runtime entrypoints from the executing module/entrypoint,
 * never from the MCP host's current working directory. `cwd` remains available
 * to configuration as the caller's project context, but is not an install path.
 */
export function runtimeEntrypointCandidates(
  name: RuntimeEntrypointName,
  moduleUrl?: string,
  argvEntrypoint = process.argv[1]
): RuntimeEntrypointCandidates {
  const roots = unique([
    ...(argvEntrypoint ? runtimeRoots(path.resolve(argvEntrypoint)) : []),
    ...(typeof moduleUrl === "string" ? runtimeRoots(fileURLToPath(moduleUrl)) : [])
  ], root => root.packageRoot);
  return {
    compiled: unique(roots.map(root => path.join(root.compiledRoot, name, "index.js"))),
    source: unique(roots.map(root => path.join(root.sourceRoot, name, "index.ts"))),
    packageRoots: unique(roots.map(root => root.packageRoot))
  };
}

interface RuntimeRoots {
  packageRoot: string;
  compiledRoot: string;
  sourceRoot: string;
}

function runtimeRoots(filePath: string): RuntimeRoots[] {
  const sourceRoot = findSourceRoot(path.dirname(filePath));
  if (!sourceRoot) return [];
  const parent = path.dirname(sourceRoot);
  if (path.basename(parent).toLowerCase() === "dist") {
    const packageRoot = path.dirname(parent);
    return [{
      packageRoot,
      compiledRoot: sourceRoot,
      sourceRoot: path.join(packageRoot, "src")
    }];
  }
  return [{
    packageRoot: parent,
    compiledRoot: path.join(parent, "dist", "src"),
    sourceRoot
  }];
}

function findSourceRoot(directory: string): string | undefined {
  let current = directory;
  while (true) {
    if (path.basename(current).toLowerCase() === "src") return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function unique<T>(values: T[], key: (value: T) => string = value => String(value)): T[] {
  const seen = new Set<string>();
  return values.filter(value => {
    const normalized = key(value);
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}
