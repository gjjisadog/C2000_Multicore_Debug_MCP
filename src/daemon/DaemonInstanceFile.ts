import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export interface DaemonRuntimePaths {
  runtimeDir: string;
  instanceFile: string;
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
}

export function daemonRuntimePaths(runtimeDir: string): DaemonRuntimePaths {
  return {
    runtimeDir: path.resolve(runtimeDir),
    instanceFile: path.join(path.resolve(runtimeDir), "debugd-instance.json")
  };
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
