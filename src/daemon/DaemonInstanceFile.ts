import { chmod, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { RuntimeContract } from "../contracts/RuntimeContract.js";

export interface DaemonRuntimePaths {
  runtimeDir: string;
  instanceFile: string;
  lockFile: string;
}

export interface DebugDaemonInstance {
  instanceId: string;
  pid: number;
  startedAt: string;
  host: "127.0.0.1";
  port: number;
  authTokenFile: string;
  databasePath: string;
  version: string;
  /** Optional so an older instance file remains readable during maintenance. */
  contract?: RuntimeContract;
}

export function daemonRuntimePaths(runtimeDir: string): DaemonRuntimePaths {
  return {
    runtimeDir: path.resolve(runtimeDir),
    instanceFile: path.join(path.resolve(runtimeDir), "debugd-instance.json"),
    lockFile: path.join(path.resolve(runtimeDir), "debugd-singleton.lock")
  };
}

/** Acquire an atomic per-runtime daemon lock. A live owner is never terminated or replaced. */
export async function acquireDaemonSingletonLock(
  paths: DaemonRuntimePaths,
  instanceId: string
): Promise<() => Promise<void>> {
  await mkdir(paths.runtimeDir, { recursive: true });
  const owner = { instanceId, pid: process.pid, acquiredAt: new Date().toISOString() };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(paths.lockFile, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
      } catch (error) {
        await rm(paths.lockFile, { force: true }).catch(() => undefined);
        throw error;
      } finally {
        await handle.close().catch(() => undefined);
      }
      return async () => {
        const current = await readLockOwner(paths.lockFile);
        if (current?.instanceId === instanceId && current.pid === process.pid) {
          await rm(paths.lockFile, { force: true });
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readLockOwner(paths.lockFile);
      if (existing && isPidAlive(existing.pid)) {
        throw new Error(
          `c2000-debugd is already running for ${paths.runtimeDir} `
          + `(pid ${existing.pid}, instance ${existing.instanceId})`
        );
      }
      await rm(paths.lockFile, { force: true });
    }
  }
  throw new Error(`Unable to acquire c2000-debugd singleton lock: ${paths.lockFile}`);
}

export async function writeDaemonInstance(
  paths: DaemonRuntimePaths,
  instance: DebugDaemonInstance,
  authToken: string
): Promise<void> {
  await mkdir(paths.runtimeDir, { recursive: true });
  await writePrivateFile(instance.authTokenFile, `${authToken}\n`);
  await atomicWrite(paths.instanceFile, `${JSON.stringify(instance, null, 2)}\n`);
}

export async function readDaemonInstance(paths: DaemonRuntimePaths): Promise<DebugDaemonInstance | undefined> {
  try {
    const parsed = JSON.parse(await readFile(paths.instanceFile, "utf8")) as Partial<DebugDaemonInstance>;
    if (
      typeof parsed.instanceId !== "string" ||
      typeof parsed.pid !== "number" ||
      typeof parsed.startedAt !== "string" ||
      parsed.host !== "127.0.0.1" ||
      typeof parsed.port !== "number" ||
      typeof parsed.authTokenFile !== "string" ||
      typeof parsed.databasePath !== "string" ||
      typeof parsed.version !== "string"
    ) {
      return undefined;
    }
    return parsed as DebugDaemonInstance;
  } catch {
    return undefined;
  }
}

export async function readDaemonAuthToken(instance: DebugDaemonInstance): Promise<string | undefined> {
  try {
    const token = (await readFile(instance.authTokenFile, "utf8")).trim();
    return token || undefined;
  } catch {
    return undefined;
  }
}

/** Remove only the files authored in this runtime directory; never touch a process. */
export async function removeDaemonInstance(
  paths: DaemonRuntimePaths,
  expectedInstanceId?: string
): Promise<void> {
  const current = await readDaemonInstance(paths);
  if (expectedInstanceId && current?.instanceId && current.instanceId !== expectedInstanceId) {
    return;
  }
  if (current && isInsideRuntimeDir(current.authTokenFile, paths.runtimeDir)) {
    await rm(current.authTokenFile, { force: true }).catch(() => undefined);
  }
  await rm(paths.instanceFile, { force: true }).catch(() => undefined);
}

export function newAuthTokenFile(paths: DaemonRuntimePaths, instanceId: string): string {
  return path.join(paths.runtimeDir, `debugd-token-${instanceId}.txt`);
}

async function atomicWrite(filePath: string, data: string): Promise<void> {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, data, { encoding: "utf8", mode: 0o600 });
  try {
    await chmod(temporaryPath, 0o600);
  } catch {
    // Windows may not implement POSIX modes; the file remains local to the runtime directory.
  }
  await rename(temporaryPath, filePath);
}

async function writePrivateFile(filePath: string, data: string): Promise<void> {
  await writeFile(filePath, data, { encoding: "utf8", mode: 0o600 });
  try {
    await chmod(filePath, 0o600);
  } catch {
    // Windows may not implement POSIX modes; the file remains local to the runtime directory.
  }
}

function isInsideRuntimeDir(candidate: string, runtimeDir: string): boolean {
  const relative = path.relative(path.resolve(runtimeDir), path.resolve(candidate));
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

async function readLockOwner(lockFile: string): Promise<{ instanceId: string; pid: number } | undefined> {
  try {
    const parsed = JSON.parse(await readFile(lockFile, "utf8")) as Record<string, unknown>;
    return typeof parsed.instanceId === "string" && typeof parsed.pid === "number"
      ? { instanceId: parsed.instanceId, pid: parsed.pid }
      : undefined;
  } catch {
    return undefined;
  }
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
