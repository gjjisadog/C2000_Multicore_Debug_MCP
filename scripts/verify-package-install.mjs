import { mkdtemp, readdir, access, rm } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const root = process.cwd();
const tarball = (await readdir(root)).find(name => /^c2000-multicore-mcp-.*\.tgz$/.test(name));
if (!tarball) throw new Error("npm pack tarball not found");
const temporary = await mkdtemp(path.join(os.tmpdir(), "c2000-package-"));
try {
  const npmCli = process.env.npm_execpath;
  const install = npmCli
    ? spawnSync(process.execPath, [npmCli, "install", path.join(root, tarball), "--ignore-scripts"], { cwd: temporary, stdio: "inherit" })
    : spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["install", path.join(root, tarball), "--ignore-scripts"], { cwd: temporary, stdio: "inherit", shell: process.platform === "win32" });
  if (install.error || install.status !== 0) throw new Error(`temporary package installation failed: ${install.error?.message ?? `exit ${install.status}`}`);
  const packageRoot = path.join(temporary, "node_modules", "c2000-multicore-mcp");
  for (const entry of ["dist/src/index.js", "dist/src/daemon/index.js", "dist/src/worker/index.js", "dist/src/can-worker/index.js", "dist/src/installer/index.js", "dist/src/runtime-manifest.json", "scripts/c2000-mcp-doctor.mjs", "python/pyproject.toml", "python/src/c2000_hil/client.py", "python/src/c2000_hil/pytest_plugin.py"]) {
    await access(path.join(packageRoot, entry));
  }
  const python = spawnSync(process.platform === "win32" ? "python.exe" : "python3", [
    "-c",
    "import c2000_hil; assert c2000_hil.__version__ == '0.7.0'; print(c2000_hil.__version__)"
  ], {
    cwd: temporary,
    encoding: "utf8",
    env: { ...process.env, PYTHONPATH: path.join(packageRoot, "python", "src"), PYTHONDONTWRITEBYTECODE: "1" }
  });
  if (python.error || python.status !== 0) {
    throw new Error(`Python SDK offline import verification failed: ${python.stderr || python.stdout || python.error?.message || `exit ${python.status}`}`);
  }
  const durableRoot = path.join(temporary, "durable-install");
  const setupCommand = process.platform === "win32"
    ? path.join(temporary, "node_modules", ".bin", "c2000-multicore-setup.cmd")
    : path.join(temporary, "node_modules", ".bin", "c2000-multicore-setup");
  const setup = spawnSync(setupCommand, [
    "install",
    "--install-root", durableRoot,
    "--workspace", temporary,
    "--no-register",
    "--no-skill",
    "--json"
  ], {
    cwd: temporary,
    encoding: "utf8",
    shell: process.platform === "win32"
  });
  if (setup.error || setup.status !== 0) {
    throw new Error(`one-command setup verification failed: ${setup.stderr || setup.stdout || setup.error?.message || `exit ${setup.status}`}`);
  }
  const setupResult = JSON.parse(setup.stdout);
  await access(setupResult.entrypoint);
  await access(setupResult.configPath);
  for (const entry of ["worker/index.js", "can-worker/index.js"]) {
    const child = spawn(process.execPath, [path.join(packageRoot, "dist", "src", entry)], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); resolve(); }, 300);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", code => { if (code && code !== 0) { clearTimeout(timer); reject(new Error(`${entry} exited ${code}`)); } });
    });
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
