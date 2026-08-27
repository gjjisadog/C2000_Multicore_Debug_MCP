import { access, cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeConfigPath = path.join(projectRoot, "config", "runtime-manifest.json");
const runtimeConfig = JSON.parse(await readFile(runtimeConfigPath, "utf8"));
const configuredRuntime = runtimeConfig.runtime;
const packageMetadata = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
const { outputDirectory, runtimeArchive, runtimeChecksumFile } = parseArguments(process.argv.slice(2));

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("The Windows offline bundle must be built on win32-x64.");
}
if (!configuredRuntime || configuredRuntime.platform !== "win32" || configuredRuntime.arch !== "x64") {
  throw new Error("config/runtime-manifest.json does not describe a win32-x64 runtime.");
}
if (!/^\d+\.\d+\.\d+$/.test(configuredRuntime.version)) {
  throw new Error("The fixed runtime version must be a complete semver value.");
}
if (!/^[0-9a-f]{64}$/i.test(configuredRuntime.archiveSha256)) {
  throw new Error("The fixed runtime archive SHA-256 is missing or invalid.");
}

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "c2000-offline-bundle-"));
try {
  const archivePath = runtimeArchive
    ? path.resolve(runtimeArchive)
    : path.join(temporaryRoot, configuredRuntime.archiveName);
  if (!runtimeArchive) await downloadRuntimeArchive(archivePath);
  await verifyRuntimeArchive(archivePath, runtimeChecksumFile);

  const extractRoot = path.join(temporaryRoot, "node-extract");
  await mkdir(extractRoot, { recursive: true });
  extractZip(archivePath, extractRoot);
  const nodeRoot = path.join(extractRoot, `node-v${configuredRuntime.version}-win-x64`);
  const nodePath = path.join(nodeRoot, "node.exe");
  const licensePath = path.join(nodeRoot, "LICENSE");
  await access(nodePath);
  await access(licensePath);
  const nodeHash = hashFile(nodePath);
  const nodeProbe = probeNode(nodePath);
  if (nodeProbe.nodeVersion !== configuredRuntime.nodeVersion
    || String(nodeProbe.nodeModulesAbi) !== String(configuredRuntime.modulesAbi)
    || nodeProbe.platform !== "win32"
    || nodeProbe.arch !== "x64") {
    throw new Error(`Official Node runtime probe does not match config: ${JSON.stringify(nodeProbe)}`);
  }

  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(outputDirectory, { recursive: true });
  await copyBundleFiles(outputDirectory, nodePath, licensePath, nodeRoot);

  const mcpManifestPath = path.join(outputDirectory, "mcp", "dist", "src", "runtime-manifest.json");
  const mcpManifest = JSON.parse(await readFile(mcpManifestPath, "utf8"));
  if (mcpManifest.nodeVersion !== configuredRuntime.nodeVersion
    || String(mcpManifest.nodeModulesAbi) !== String(configuredRuntime.modulesAbi)
    || mcpManifest.runtime?.nodeVersion !== configuredRuntime.nodeVersion
    || String(mcpManifest.runtime?.modulesAbi) !== String(configuredRuntime.modulesAbi)) {
    throw new Error(
      "dist/src was not built by the fixed runtime. Run the Windows build with "
      + "C2000_FIXED_RUNTIME_BUILD=1 before preparing the offline bundle."
    );
  }
  const sqliteBinding = (mcpManifest.nativeBindings ?? []).find(binding => binding.name === "better_sqlite3.node");
  if (!sqliteBinding || String(sqliteBinding.abi) !== String(configuredRuntime.modulesAbi)) {
    throw new Error(
      `better_sqlite3.node ABI ${sqliteBinding?.abi ?? "missing"} does not match the fixed Node ABI ${configuredRuntime.modulesAbi}.`
    );
  }
  mcpManifest.nodeVersion = configuredRuntime.nodeVersion;
  mcpManifest.nodeModulesAbi = configuredRuntime.modulesAbi;
  mcpManifest.platform = "win32";
  mcpManifest.arch = "x64";
  mcpManifest.runtime = {
    ...mcpManifest.runtime,
    name: "node",
    version: configuredRuntime.version,
    nodeVersion: configuredRuntime.nodeVersion,
    platform: "win32",
    arch: "x64",
    modulesAbi: configuredRuntime.modulesAbi,
    archiveName: configuredRuntime.archiveName,
    source: configuredRuntime.source,
    checksumSource: configuredRuntime.checksumSource,
    archiveSha256: configuredRuntime.archiveSha256,
    bundledNode: true,
    executable: "runtime/node.exe",
    executableSha256: nodeHash
  };
  await writeFile(mcpManifestPath, `${JSON.stringify(mcpManifest, null, 2)}\n`);

  const offlineManifest = {
    schemaVersion: 1,
    product: {
      name: packageMetadata.name,
      version: packageMetadata.version
    },
    artifact: {
      target: "offline-win32-x64",
      platform: "win32",
      arch: "x64",
      fileName: `${packageMetadata.name}-${packageMetadata.version}-offline-win32-x64.zip`
    },
    runtime: {
      name: "node",
      version: configuredRuntime.version,
      nodeVersion: configuredRuntime.nodeVersion,
      platform: "win32",
      arch: "x64",
      modulesAbi: configuredRuntime.modulesAbi,
      executable: "runtime/node.exe",
      sha256: nodeHash,
      license: "runtime/LICENSE",
      distribution: {
        archiveName: configuredRuntime.archiveName,
        source: configuredRuntime.source,
        checksumSource: configuredRuntime.checksumSource,
        archiveSha256: configuredRuntime.archiveSha256
      }
    },
    mcp: {
      root: "mcp",
      entrypoint: "mcp/dist/src/index.js",
      installer: "mcp/dist/src/installer/index.js",
      runtimeManifest: "mcp/dist/src/runtime-manifest.json",
      nativeBindings: mcpManifest.nativeBindings ?? []
    },
    offline: {
      noNodeInstallationRequired: true,
      noNpmRequired: true,
      noGitHubCliRequired: true,
      noNetworkRequired: true
    }
  };
  await writeFile(path.join(outputDirectory, "manifest.json"), `${JSON.stringify(offlineManifest, null, 2)}\n`);
  await writeChecksums(outputDirectory);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    outputDirectory,
    manifest: offlineManifest,
    nodeProbe,
    nodeSha256: nodeHash,
    nativeBindings: mcpManifest.nativeBindings ?? []
  }, null, 2)}\n`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

function parseArguments(args) {
  let outputDirectory = path.join(projectRoot, "offline-bundle-win32-x64");
  let runtimeArchive;
  let runtimeChecksumFile;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--output") {
      const value = args[++index];
      if (!value) throw new Error("--output requires a directory path");
      outputDirectory = path.resolve(value);
    } else if (arg === "--runtime-archive") {
      runtimeArchive = args[++index];
      if (!runtimeArchive) throw new Error("--runtime-archive requires a file path");
    } else if (arg === "--runtime-checksum-file") {
      runtimeChecksumFile = args[++index];
      if (!runtimeChecksumFile) throw new Error("--runtime-checksum-file requires a file path");
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write("Usage: node scripts/prepare-offline-bundle.mjs [--output DIR] [--runtime-archive ZIP] [--runtime-checksum-file SHASUMS256.txt]\n");
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return { outputDirectory, runtimeArchive, runtimeChecksumFile };
}

async function downloadRuntimeArchive(destination) {
  const response = await fetch(configuredRuntime.source);
  if (!response.ok) throw new Error(`Node runtime download failed with HTTP ${response.status}`);
  await writeFile(destination, Buffer.from(await response.arrayBuffer()));
}

async function verifyRuntimeArchive(archivePath, runtimeChecksumFile) {
  const actual = hashFile(archivePath);
  if (actual.toLowerCase() !== configuredRuntime.archiveSha256.toLowerCase()) {
    throw new Error(`Node runtime archive SHA-256 mismatch: ${actual}`);
  }
  const checksums = runtimeChecksumFile
    ? await readFile(path.resolve(runtimeChecksumFile), "utf8")
    : await fetchOfficialChecksums();
  const line = checksums.split(/\r?\n/).find(candidate => candidate.trimEnd().endsWith(`  ${configuredRuntime.archiveName}`));
  if (!line) throw new Error(`Official checksum source does not list ${configuredRuntime.archiveName}`);
  const officialHash = line.trim().split(/\s+/)[0];
  if (officialHash.toLowerCase() !== configuredRuntime.archiveSha256.toLowerCase()) {
    throw new Error("config/runtime-manifest.json disagrees with the official Node checksum source.");
  }
}

async function fetchOfficialChecksums() {
  const checksumResponse = await fetch(configuredRuntime.checksumSource);
  if (!checksumResponse.ok) throw new Error(`Node runtime checksum source failed with HTTP ${checksumResponse.status}`);
  return checksumResponse.text();
}

function extractZip(archivePath, destination) {
  const shell = process.env.SystemRoot ? "powershell.exe" : "pwsh";
  const result = spawnSync(shell, [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    "$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath $env:C2000_RUNTIME_ARCHIVE -DestinationPath $env:C2000_RUNTIME_EXTRACT -Force"
  ], {
    env: { ...process.env, C2000_RUNTIME_ARCHIVE: archivePath, C2000_RUNTIME_EXTRACT: destination },
    stdio: "inherit",
    windowsHide: true
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Unable to extract the official Node ZIP: ${result.error?.message ?? `exit ${result.status}`}`);
  }
}

function probeNode(nodePath) {
  const result = spawnSync(nodePath, ["-p", "JSON.stringify({nodeVersion:process.version,nodeModulesAbi:process.versions.modules,platform:process.platform,arch:process.arch})"], {
    encoding: "utf8",
    windowsHide: true
  });
  if (result.error || result.status !== 0) throw new Error(`The downloaded Node runtime could not run: ${result.stderr || result.error?.message || result.status}`);
  return JSON.parse(result.stdout.trim());
}

async function copyBundleFiles(outputDirectory, nodePath, licensePath, nodeRoot) {
  await mkdir(path.join(outputDirectory, "runtime"), { recursive: true });
  await cp(nodePath, path.join(outputDirectory, "runtime", "node.exe"));
  await cp(licensePath, path.join(outputDirectory, "runtime", "LICENSE"));
  const nodeReadme = path.join(nodeRoot, "README.md");
  if (await exists(nodeReadme)) await cp(nodeReadme, path.join(outputDirectory, "runtime", "README.md"));

  await cp(path.join(projectRoot, "scripts", "install-offline.ps1"), path.join(outputDirectory, "install.ps1"));
  await cp(path.join(projectRoot, "scripts", "uninstall.ps1"), path.join(outputDirectory, "uninstall.ps1"));
  await cp(path.join(projectRoot, "README-OFFLINE.md"), path.join(outputDirectory, "README-OFFLINE.md"));

  const mcpRoot = path.join(outputDirectory, "mcp");
  await mkdir(mcpRoot, { recursive: true });
  await cp(path.join(projectRoot, "dist", "src"), path.join(mcpRoot, "dist", "src"), { recursive: true });
  await cp(path.join(projectRoot, "package.json"), path.join(mcpRoot, "package.json"));
  await cp(path.join(projectRoot, "README.md"), path.join(mcpRoot, "README.md"));
  await cp(path.join(projectRoot, "CHANGELOG.md"), path.join(mcpRoot, "CHANGELOG.md"));
  await mkdir(path.join(mcpRoot, "scripts"), { recursive: true });
  for (const file of ["c2000-mcp-doctor.mjs", "verify-offline-acceptance.mjs"]) {
    await cp(path.join(projectRoot, "scripts", file), path.join(mcpRoot, "scripts", file));
  }
  await cp(path.join(projectRoot, "skills"), path.join(mcpRoot, "skills"), { recursive: true });
  if (await exists(path.join(projectRoot, "python"))) {
    await cp(path.join(projectRoot, "python"), path.join(mcpRoot, "python"), {
      recursive: true,
      filter(source) {
        const normalized = source.replaceAll("\\", "/");
        return !/(^|\/)(?:__pycache__|\.pytest_cache|[^/]+\.egg-info)(?:\/|$)/.test(normalized)
          && !/\.(?:pyc|pyo)$/.test(normalized);
      }
    });
  }
}

async function writeChecksums(root) {
  const files = await listFiles(root);
  const entries = [];
  for (const relative of files.filter(file => file !== "SHA256SUMS.json")) {
    const absolute = path.join(root, relative.replaceAll("/", path.sep));
    const content = await readFile(absolute);
    entries.push({
      file: relative,
      sha256: createHash("sha256").update(content).digest("hex"),
      size: content.length
    });
  }
  await writeFile(path.join(root, "SHA256SUMS.json"), `${JSON.stringify({ target: "win32-x64", files: entries }, null, 2)}\n`);
}

async function listFiles(root, prefix = "") {
  const entries = (await readdir(path.join(root, prefix), { withFileTypes: true }))
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  const files = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await listFiles(root, relative));
    else if (entry.isFile()) files.push(relative);
    else throw new Error(`Offline bundle contains an unsupported filesystem entry: ${relative}`);
  }
  return files;
}

function hashFile(filePath) {
  return createHash("sha256").update(requireFile(filePath)).digest("hex");
}

function requireFile(filePath) {
  // The bundle is assembled only from regular files. The synchronous read
  // keeps hashing/probing deterministic without introducing another package.
  return readFileSync(filePath);
}

async function exists(filePath) {
  try { await access(filePath); return true; } catch { return false; }
}
