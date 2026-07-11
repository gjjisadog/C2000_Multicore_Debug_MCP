import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveTiEnvironment } from "../config/tiPaths.js";

export interface CommandOutput {
  stdout: string;
  stderr: string;
}

export type ExecFileLike = (command: string, args: string[], options: { timeout: number }) => Promise<CommandOutput>;

export interface Xds110Device {
  serialNumber?: string;
  mode?: string;
  configuration?: string;
  version?: string;
  name?: string;
}

export interface HardwarePreflightResult {
  xdsdfuPath: string;
  xdsdfu: {
    ok: boolean;
    stdout?: string;
    stderr?: string;
    error?: string;
    devices?: Xds110Device[];
  };
  debugProcesses: string[];
  debugProcessDetails: DebugProcessInfo[];
}

export interface DebugProcessInfo {
  pid: number;
  ppid?: number;
  elapsed?: string;
  command: string;
  kind: "DSLite" | "ccstudio" | "DebugServer" | "dss.sh";
  rawLine: string;
}

export type ProbeRecoveryPolicy = "block" | "owned-and-stale" | "terminate-external";

export interface ProbeRecoveryResult {
  policy: ProbeRecoveryPolicy;
  attempted: boolean;
  recovered: boolean;
  terminatedPids: number[];
  remainingOwners: DebugProcessInfo[];
}

const execFileAsync = promisify(execFile);

export async function runHardwarePreflight(options: {
  ccsInstallPath?: string;
  execFile?: ExecFileLike;
} = {}): Promise<HardwarePreflightResult> {
  const ccsRoot = options.ccsInstallPath ?? process.env.C2000_MCP_CCS_INSTALL_PATH
    ?? (await resolveTiEnvironment()).ccs.path
    ?? "";
  const xdsdfuPath = `${ccsRoot}/ccs_base/common/uscif/xds110/xdsdfu`;
  const run = options.execFile ?? ((command, args, execOptions) => execFileAsync(command, args, execOptions));
  const preflight: HardwarePreflightResult = {
    xdsdfuPath,
    xdsdfu: { ok: false },
    debugProcesses: [],
    debugProcessDetails: []
  };

  try {
    const { stdout, stderr } = await run(xdsdfuPath, ["-e"], { timeout: 10000 });
    preflight.xdsdfu = {
      ok: true,
      stdout,
      stderr,
      devices: parseXds110Devices(stdout)
    };
  } catch (error) {
    preflight.xdsdfu = {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }

  try {
    const { stdout } = await run("ps", ["-axo", "pid=,ppid=,etime=,command="], { timeout: 10000 });
    preflight.debugProcessDetails = findDebugProcessDetails(stdout);
    preflight.debugProcesses = preflight.debugProcessDetails.map(process => process.rawLine);
  } catch {
    preflight.debugProcesses = [];
    preflight.debugProcessDetails = [];
  }

  return preflight;
}

export async function recoverDebugProbe(options: {
  ccsInstallPath?: string;
  policy: ProbeRecoveryPolicy;
  execFile?: ExecFileLike;
  killProcess?: (pid: number, signal: NodeJS.Signals | 0) => void;
  settleMs?: number;
  targetCcxmlPath?: string;
}): Promise<ProbeRecoveryResult> {
  const killProcess = options.killProcess ?? ((pid, signal) => process.kill(pid, signal));
  const before = await runHardwarePreflight({ ccsInstallPath: options.ccsInstallPath, execFile: options.execFile });
  const allOwners = before.debugProcessDetails.filter(isProbeOwnerProcess);
  const owners = options.targetCcxmlPath
    ? allOwners.filter(owner => owner.command.includes(options.targetCcxmlPath!))
    : allOwners;
  if (owners.length === 0) {
    return { policy: options.policy, attempted: false, recovered: true, terminatedPids: [], remainingOwners: [] };
  }
  if (options.policy !== "terminate-external") {
    return { policy: options.policy, attempted: false, recovered: false, terminatedPids: [], remainingOwners: owners };
  }
  const terminatedPids: number[] = [];
  for (const owner of owners) {
    try {
      killProcess(owner.pid, "SIGTERM");
      terminatedPids.push(owner.pid);
    } catch (error) {
      if (!isMissingProcess(error)) throw error;
    }
  }
  await delay(options.settleMs ?? 1500);
  for (const owner of owners) {
    try {
      killProcess(owner.pid, 0);
      killProcess(owner.pid, "SIGKILL");
    } catch (error) {
      if (!isMissingProcess(error)) throw error;
    }
  }
  await delay(250);
  const after = await runHardwarePreflight({ ccsInstallPath: options.ccsInstallPath, execFile: options.execFile });
  const remainingOwners = after.debugProcessDetails
    .filter(isProbeOwnerProcess)
    .filter(owner => !options.targetCcxmlPath || owner.command.includes(options.targetCcxmlPath));
  return { policy: options.policy, attempted: true, recovered: remainingOwners.length === 0, terminatedPids, remainingOwners };
}

export function isProbeOwnerProcess(processInfo: DebugProcessInfo): boolean {
  return processInfo.kind === "DSLite" || processInfo.kind === "DebugServer" || processInfo.kind === "dss.sh";
}

function isMissingProcess(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ESRCH";
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function findDebugProcesses(processList: string): string[] {
  return findDebugProcessDetails(processList).map(process => process.rawLine);
}

export function formatDebugProcessOwners(preflight: Pick<HardwarePreflightResult, "debugProcesses" | "debugProcessDetails">): string {
  const details = Array.isArray(preflight.debugProcessDetails) ? preflight.debugProcessDetails : [];
  if (details.length > 0) {
    return details.map(process => `${process.pid} ${process.kind}: ${process.command}`).join(", ");
  }
  return preflight.debugProcesses.join(", ");
}

export function findDebugProcessDetails(processList: string): DebugProcessInfo[] {
  return processList
    .split(/\r?\n/)
    .filter(line => !/ccs-hardware-acceptance|ccs-preflight|tsx/.test(line))
    .map(parseDebugProcess)
    .filter((process): process is DebugProcessInfo => process !== undefined);
}

export function parseXds110Devices(output: string): Xds110Device[] {
  return output
    .split(/<<<< Device \d+ >>>>/)
    .slice(1)
    .map(section => ({
      name: readField(section, "Device Name"),
      version: readField(section, "Version"),
      serialNumber: readField(section, "Serial Num"),
      mode: readField(section, "Mode"),
      configuration: readField(section, "Configuration")
    }));
}

function readField(section: string, fieldName: string): string | undefined {
  const match = section.match(new RegExp(`${fieldName}:\\s*([^\\n\\r]+)`));
  return match?.[1]?.trim();
}

function parseDebugProcess(rawLine: string): DebugProcessInfo | undefined {
  const match = rawLine.match(/^\s*(\d+)\s+(.+)$/);
  if (!match) {
    return undefined;
  }
  const parsed = parseProcessFields(match[2].trim());
  const command = parsed.command;
  const kind = debugProcessKind(command);
  if (!kind) {
    return undefined;
  }
  return {
    pid: Number(match[1]),
    ...(parsed.ppid !== undefined ? { ppid: parsed.ppid } : {}),
    ...(parsed.elapsed !== undefined ? { elapsed: parsed.elapsed } : {}),
    command,
    kind,
    rawLine
  };
}

function parseProcessFields(rest: string): { ppid?: number; elapsed?: string; command: string } {
  const match = rest.match(/^(\d+)\s+((?:\d+-)?\d{1,2}:\d{2}(?::\d{2})?)\s+(.+)$/);
  if (!match) {
    return { command: rest };
  }
  return {
    ppid: Number(match[1]),
    elapsed: match[2],
    command: match[3].trim()
  };
}

function debugProcessKind(command: string): DebugProcessInfo["kind"] | undefined {
  const executable = commandExecutableBasename(command);
  if (executable === "DSLite") {
    return "DSLite";
  }
  if (executable === "ccstudio") {
    return "ccstudio";
  }
  if (executable === "DebugServer") {
    return "DebugServer";
  }
  if (executable === "dss.sh") {
    return "dss.sh";
  }
  return undefined;
}

function commandExecutableBasename(command: string): string {
  const token = command.trim().match(/^"([^"]+)"|^'([^']+)'|^(\S+)/);
  const executable = token?.[1] ?? token?.[2] ?? token?.[3] ?? "";
  return executable.split(/[\\/]/).filter(Boolean).at(-1) ?? executable;
}
