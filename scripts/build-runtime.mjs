import { access, chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outdir = process.env.C2000_BUILD_RUNTIME_OUTDIR
  ? path.resolve(process.env.C2000_BUILD_RUNTIME_OUTDIR)
  : path.join(projectRoot, "dist", "src");

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await build({
  absWorkingDir: projectRoot,
  entryPoints: {
    index: "src/index.ts",
    "daemon/index": "src/daemon/index.ts",
    "worker/index": "src/worker/index.ts"
  },
  outdir,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  sourcemap: true,
  define: {
    __C2000_RUNTIME_BUNDLED__: "true",
    // Source execution uses import.meta.url; published CJS uses argv[1].
    "import.meta.url": "undefined"
  }
});

// better-sqlite3 is CommonJS/native. A CJS runtime directory lets esbuild
// preserve its Node require semantics without relying on the package root.
await writeFile(path.join(outdir, "package.json"), `${JSON.stringify({ type: "commonjs" })}\n`);
await copyNativeSqliteBinding(projectRoot, outdir);
await writeRuntimeManifest(projectRoot, outdir);

await Promise.all([
  chmod(path.join(outdir, "index.js"), 0o755),
  chmod(path.join(outdir, "daemon", "index.js"), 0o755),
  chmod(path.join(outdir, "worker", "index.js"), 0o755)
]);

async function copyNativeSqliteBinding(root, runtimeDirectory) {
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

async function writeRuntimeManifest(root, runtimeDirectory) {
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const sqlitePackage = JSON.parse(await readFile(path.join(root, "node_modules", "better-sqlite3", "package.json"), "utf8"));
  const relativeBinding = path.join("build", "Release", "better_sqlite3.node").replaceAll("\\", "/");
  const binding = await readFile(path.join(runtimeDirectory, relativeBinding));
  const manifest = {
    version: packageJson.version,
    builtAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    nodeModulesAbi: process.versions.modules,
    betterSqlite3Version: sqlitePackage.version,
    entrypoints: {
      proxy: "index.js",
      daemon: "daemon/index.js",
      worker: "worker/index.js"
    },
    nativeBindings: [{
      name: "better_sqlite3.node",
      sha256: createHash("sha256").update(binding).digest("hex"),
      path: relativeBinding
    }]
  };
  await writeFile(path.join(runtimeDirectory, "runtime-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}
