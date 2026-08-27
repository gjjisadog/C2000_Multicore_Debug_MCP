import { access, chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outdir = process.env.C2000_BUILD_RUNTIME_OUTDIR
  ? path.resolve(process.env.C2000_BUILD_RUNTIME_OUTDIR)
  : path.join(projectRoot, "dist", "src");
const fixedRuntimeBuild = process.env.C2000_FIXED_RUNTIME_BUILD === "1";
const runtimeConfig = JSON.parse(await readFile(
  path.join(projectRoot, "config", "runtime-manifest.json"),
  "utf8"
));
const configuredRuntime = runtimeConfig.runtime;
if (!configuredRuntime || typeof configuredRuntime !== "object") {
  throw new Error("config/runtime-manifest.json is missing the runtime configuration");
}
if (fixedRuntimeBuild) {
  if (configuredRuntime.platform !== "win32" || configuredRuntime.arch !== "x64") {
    throw new Error("The fixed runtime build target must be win32-x64.");
  }
  if (process.platform !== configuredRuntime.platform || process.arch !== configuredRuntime.arch) {
    throw new Error(
      `The fixed runtime build requires ${configuredRuntime.platform}-${configuredRuntime.arch}; `
      + `detected ${process.platform}-${process.arch}.`
    );
  }
  if (process.version !== configuredRuntime.nodeVersion || process.versions.modules !== configuredRuntime.modulesAbi) {
    throw new Error(
      `The fixed runtime build requires Node ${configuredRuntime.nodeVersion} (ABI ${configuredRuntime.modulesAbi}); `
      + `detected ${process.version} (ABI ${process.versions.modules}).`
    );
  }
}
const builtAt = new Date().toISOString();
const sourceState = readSourceState(projectRoot);

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await build({
  absWorkingDir: projectRoot,
  entryPoints: {
    index: "src/index.ts",
    "daemon/index": "src/daemon/index.ts",
    "worker/index": "src/worker/index.ts",
    "can-worker/index": "src/can-worker/index.ts",
    "installer/index": "src/installer/index.ts",
    "installer/runtime-check": "src/installer/runtimeCheck.ts"
  },
  outdir,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  sourcemap: true,
  define: {
    __C2000_RUNTIME_BUNDLED__: "true",
    __C2000_RUNTIME_BUILT_AT__: JSON.stringify(builtAt),
    __C2000_RUNTIME_SOURCE_REVISION__: JSON.stringify(sourceState.revision),
    __C2000_RUNTIME_SOURCE_DIRTY__: JSON.stringify(sourceState.dirty),
    // Source execution uses import.meta.url; published CJS uses argv[1].
    "import.meta.url": "undefined"
  }
});

// better-sqlite3 is CommonJS/native. A CJS runtime directory lets esbuild
// preserve its Node require semantics without relying on the package root.
await writeFile(path.join(outdir, "package.json"), `${JSON.stringify({ type: "commonjs" })}\n`);
const nativeBindings = [await copyNativeSqliteBinding(projectRoot, outdir)];
const koffiBinding = await copyKoffiPackage(projectRoot, outdir);
if (koffiBinding) nativeBindings.push(koffiBinding);
await writeRuntimeManifest(projectRoot, outdir, builtAt, sourceState, nativeBindings);

await Promise.all([
  chmod(path.join(outdir, "index.js"), 0o755),
  chmod(path.join(outdir, "daemon", "index.js"), 0o755),
  chmod(path.join(outdir, "worker", "index.js"), 0o755),
  chmod(path.join(outdir, "can-worker", "index.js"), 0o755),
  chmod(path.join(outdir, "installer", "index.js"), 0o755),
  chmod(path.join(outdir, "installer", "runtime-check.js"), 0o755)
]);

async function copyNativeSqliteBinding(root, runtimeDirectory) {
  const require = createRequire(import.meta.url);
  try {
    const Database = require("better-sqlite3");
    const database = new Database(":memory:");
    database.close();
  } catch (error) {
    throw new Error(
      `better-sqlite3 is incompatible with the active Node ${process.version} (ABI ${process.versions.modules}). `
      + `Run npm ci with this Node version before npm run build. Cause: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const source = path.join(root, "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node");
  try {
    await access(source);
  } catch {
    throw new Error(`better-sqlite3 native binding is missing: ${source}. Run npm ci before npm run build.`);
  }
  const destination = path.join(runtimeDirectory, "build", "Release", "better_sqlite3.node");
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination);
  const binding = await readFile(destination);
  return {
    name: "better_sqlite3.node",
    sha256: createHash("sha256").update(binding).digest("hex"),
    path: path.relative(runtimeDirectory, destination).replaceAll("\\", "/"),
    abi: process.versions.modules,
    packageVersion: JSON.parse(await readFile(path.join(root, "node_modules", "better-sqlite3", "package.json"), "utf8")).version
  };
}

async function copyKoffiPackage(root, runtimeDirectory) {
  const sourceRoot = path.join(root, "node_modules", "koffi");
  try {
    await access(path.join(sourceRoot, "package.json"));
  } catch {
    return undefined;
  }

  const triplet = `${process.platform}_${process.arch}`;
  const sourceBinding = path.join(sourceRoot, "build", "koffi", triplet, "koffi.node");
  try {
    await access(sourceBinding);
  } catch {
    throw new Error(`koffi is installed but its ${triplet} native binding is missing: ${sourceBinding}`);
  }

  const destinationRoot = path.join(runtimeDirectory, "node_modules", "koffi");
  await mkdir(path.join(destinationRoot, "build", "koffi", triplet), { recursive: true });
  for (const file of ["index.js", "indirect.js", "package.json", "LICENSE.txt"]) {
    const source = path.join(sourceRoot, file);
    try {
      await access(source);
      await copyFile(source, path.join(destinationRoot, file));
    } catch {
      if (file === "LICENSE.txt") continue;
      throw new Error(`koffi runtime file is missing: ${source}`);
    }
  }
  const destinationBinding = path.join(destinationRoot, "build", "koffi", triplet, "koffi.node");
  await copyFile(sourceBinding, destinationBinding);
  try {
    const requireFromRuntime = createRequire(path.join(runtimeDirectory, "package.json"));
    requireFromRuntime("./node_modules/koffi");
  } catch (error) {
    throw new Error(
      `The copied koffi ${triplet} native binding could not be loaded by the active Node ${process.version}: `
      + `${error instanceof Error ? error.message : String(error)}`
    );
  }
  const packageMetadata = JSON.parse(await readFile(path.join(sourceRoot, "package.json"), "utf8"));
  const binding = await readFile(destinationBinding);
  return {
    name: "koffi.node",
    sha256: createHash("sha256").update(binding).digest("hex"),
    path: path.relative(runtimeDirectory, destinationBinding).replaceAll("\\", "/"),
    abi: "napi",
    packageVersion: packageMetadata.version
  };
}

async function writeRuntimeManifest(root, runtimeDirectory, runtimeBuiltAt, runtimeSourceState, nativeBindings) {
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const sqlitePackage = JSON.parse(await readFile(path.join(root, "node_modules", "better-sqlite3", "package.json"), "utf8"));
  const runtime = fixedRuntimeBuild
    ? {
        name: configuredRuntime.name,
        version: configuredRuntime.version,
        nodeVersion: configuredRuntime.nodeVersion,
        platform: configuredRuntime.platform,
        arch: configuredRuntime.arch,
        modulesAbi: configuredRuntime.modulesAbi,
        archiveName: configuredRuntime.archiveName,
        source: configuredRuntime.source,
        checksumSource: configuredRuntime.checksumSource,
        archiveSha256: configuredRuntime.archiveSha256,
        bundledNode: false,
        executable: "runtime/node.exe"
      }
    : {
        name: "node",
        version: process.versions.node,
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        modulesAbi: process.versions.modules,
        bundledNode: false
      };
  const manifest = {
    schemaVersion: 2,
    version: packageJson.version,
    builtAt: runtimeBuiltAt,
    sourceRevision: runtimeSourceState.revision,
    sourceDirty: runtimeSourceState.dirty,
    platform: process.platform,
    arch: process.arch,
    nodeVersion: runtime.nodeVersion,
    nodeModulesAbi: runtime.modulesAbi,
    runtime,
    betterSqlite3Version: sqlitePackage.version,
    entrypoints: {
      proxy: "index.js",
      daemon: "daemon/index.js",
      worker: "worker/index.js",
      canWorker: "can-worker/index.js",
      installer: "installer/index.js",
      runtimeCheck: "installer/runtime-check.js"
    },
    nativeBindings
  };
  await writeFile(path.join(runtimeDirectory, "runtime-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

function readSourceState(root) {
  const revision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", windowsHide: true });
  const status = spawnSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: root, encoding: "utf8", windowsHide: true });
  return {
    revision: revision.status === 0 ? revision.stdout.trim() : "unknown",
    dirty: status.status === 0 ? status.stdout.trim().length > 0 : null
  };
}
