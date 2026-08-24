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
    "installer/index": "src/installer/index.ts"
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
await copyNativeSqliteBinding(projectRoot, outdir);
await writeRuntimeManifest(projectRoot, outdir, builtAt, sourceState);

await Promise.all([
  chmod(path.join(outdir, "index.js"), 0o755),
  chmod(path.join(outdir, "daemon", "index.js"), 0o755),
  chmod(path.join(outdir, "worker", "index.js"), 0o755),
  chmod(path.join(outdir, "can-worker", "index.js"), 0o755),
  chmod(path.join(outdir, "installer", "index.js"), 0o755)
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
}

async function writeRuntimeManifest(root, runtimeDirectory, runtimeBuiltAt, runtimeSourceState) {
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const sqlitePackage = JSON.parse(await readFile(path.join(root, "node_modules", "better-sqlite3", "package.json"), "utf8"));
  const relativeBinding = path.join("build", "Release", "better_sqlite3.node").replaceAll("\\", "/");
  const binding = await readFile(path.join(runtimeDirectory, relativeBinding));
  const manifest = {
    version: packageJson.version,
    builtAt: runtimeBuiltAt,
    sourceRevision: runtimeSourceState.revision,
    sourceDirty: runtimeSourceState.dirty,
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    nodeModulesAbi: process.versions.modules,
    betterSqlite3Version: sqlitePackage.version,
    entrypoints: {
      proxy: "index.js",
      daemon: "daemon/index.js",
      worker: "worker/index.js",
      canWorker: "can-worker/index.js",
      installer: "installer/index.js"
    },
    nativeBindings: [{
      name: "better_sqlite3.node",
      sha256: createHash("sha256").update(binding).digest("hex"),
      path: relativeBinding
    }]
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
