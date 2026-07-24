import { access, mkdir, open } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { health, readInstance, runtimeDir } from "./daemon-control.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entrypoint = path.resolve(process.env.C2000_DAEMON_ENTRYPOINT || path.join(root, "dist", "src", "daemon", "index.js"));
try { await access(entrypoint); } catch {
  console.error("Built daemon entrypoint is missing. Run npm run build first.");
  process.exit(1);
}

const existing = await readInstance();
const existingHealth = existing && await health(existing);
if (existingHealth) {
  console.log(JSON.stringify({ alreadyRunning: true, instance: existing, health: existingHealth }, null, 2));
  process.exit(0);
}

await mkdir(runtimeDir(), { recursive: true });
const log = await open(path.join(runtimeDir(), "c2000-debugd.log"), "a");
const child = spawn(process.execPath, [entrypoint], {
  cwd: path.resolve(process.env.C2000_DAEMON_CWD || root),
  detached: true,
  windowsHide: true,
  stdio: ["ignore", log.fd, log.fd],
  env: process.env
});
child.unref();
await log.close();

const deadline = Date.now() + 15000;
while (Date.now() < deadline) {
  const instance = await readInstance();
  const ready = instance && await health(instance);
  if (ready) {
    console.log(JSON.stringify({ instanceId: instance.instanceId, pid: instance.pid, host: instance.host, port: instance.port }, null, 2));
    process.exit(0);
  }
  await new Promise(resolve => setTimeout(resolve, 100));
}
console.error(`Detached daemon did not become healthy (pid ${child.pid ?? "unknown"}). See runtime/c2000-debugd.log.`);
process.exit(1);
