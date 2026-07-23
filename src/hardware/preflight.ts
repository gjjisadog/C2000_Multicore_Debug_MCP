import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { defaultCcsInstallPath, resolveCcsInstallPath, resolveXdsdfuPath } from "../ccs/paths.js";

export { defaultCcsInstallPath, resolveXdsdfuPath } from "../ccs/paths.js";

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
    commandOk?: boolean;
    probeReady?: boolean;
    attempts?: number;
    stdout?: string;
    stderr?: string;
    error?: string;
    devices?: Xds110Device[];
  };
  debugProcesses: string[];
  debugProcessDetails: DebugProcessInfo[];
  processInspection?: { ok: boolean; platform: NodeJS.Platform; error?: string };
}

export interface DebugProcessInfo {
  pid: number;
  ppid?: number;
  elapsed?: string;
  command: string;
  kind: "DSLite" | "ccstudio" | "DebugServer" | "dss.sh" | "c2000-dss";
  rawLine: string;
}

const execFileAsync = promisify(execFile);

export async function runHardwarePreflight(options: {
  ccsInstallPath?: string;
  execFile?: ExecFileLike;
  platform?: NodeJS.Platform;
  enumerationAttempts?: number;
  enumerationRetryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
} = {}): Promise<HardwarePreflightResult> {
  const platform = options.platform ?? process.platform;
  const ccsRoot = resolveCcsInstallPath(options.ccsInstallPath, platform);
  const xdsdfuPath = resolveXdsdfuPath(ccsRoot, platform);
  const run = options.execFile ?? ((command, args, execOptions) => execFileAsync(command, args, execOptions));
  const enumerationAttempts = Math.max(1, options.enumerationAttempts ?? 3);
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const preflight: HardwarePreflightResult = {
    xdsdfuPath,
    xdsdfu: { ok: false, commandOk: false, probeReady: false, attempts: 0 },
    debugProcesses: [],
    debugProcessDetails: [],
    processInspection: { ok: false, platform }
  };

  for (let attempt = 1; attempt <= enumerationAttempts; attempt += 1) {
    try {
      const { stdout, stderr } = await run(xdsdfuPath, ["-e"], { timeout: 10000 });
      const devices = parseXds110Devices(stdout);
      preflight.xdsdfu = {
        ok: true,
        commandOk: true,
        probeReady: devices.length > 0,
        attempts: attempt,
        stdout,
        stderr,
        devices
      };
      if (devices.length > 0 || attempt === enumerationAttempts) {
        break;
      }
      await sleep(options.enumerationRetryDelayMs ?? 250);
    } catch (error) {
      preflight.xdsdfu = {
        ok: false,
        commandOk: false,
        probeReady: false,
        attempts: attempt,
        error: error instanceof Error ? error.message : String(error)
      };
      break;
    }
  }

  try {
    const processCommand = processListCommand(platform);
    const { stdout } = await run(processCommand.command, processCommand.args, { timeout: 10000 });
    preflight.debugProcessDetails = findDebugProcessDetails(stdout);
    preflight.debugProcesses = preflight.debugProcessDetails.map(process => process.rawLine);
    preflight.processInspection = { ok: true, platform };
  } catch (error) {
    preflight.debugProcesses = [];
    preflight.debugProcessDetails = [];
    preflight.processInspection = {
      ok: false,
      platform,
      error: error instanceof Error ? error.message : String(error)
    };
  }

  return preflight;
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
  const match = rest.match(/^(\d+)\s+((?:\d+-)?\d+:\d{2}(?::\d{2})?)\s+(.+)$/);
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
  const executable = commandExecutableBasename(command).toLowerCase().replace(/\.exe$/, "");
  const loweredCommand = command.toLowerCase();
  if (loweredCommand.includes("c2000-persistent-server.js") || loweredCommand.includes("c2000-dss-server-")) {
    return "c2000-dss";
  }
  if (executable === "dslite") {
    return "DSLite";
  }
  if (executable === "ccstudio") {
    if (/--type=|resources[\\/]app(?:\.asar)?[\\/]lib[\\/]backend|--node-ipc/i.test(command)) {
      return undefined;
    }
    return "ccstudio";
  }
  if (executable === "debugserver") {
    return "DebugServer";
  }
  if (executable === "dss.sh") {
    return "dss.sh";
  }
  return undefined;
}

function processListCommand(platform: NodeJS.Platform): { command: string; args: string[] } {
  if (platform === "win32") {
    const script = "Get-CimInstance Win32_Process | ForEach-Object { $cmd = if ($_.CommandLine) { $_.CommandLine } else { $_.ExecutablePath }; if ($cmd) { $elapsed = if ($_.CreationDate) { (Get-Date) - $_.CreationDate } else { [TimeSpan]::Zero }; $etime = '{0}:{1:00}:{2:00}' -f [Math]::Floor($elapsed.TotalHours), $elapsed.Minutes, $elapsed.Seconds; '{0} {1} {2} {3}' -f $_.ProcessId, $_.ParentProcessId, $etime, ($cmd -replace '[\\r\\n]+',' ') } }";
    return { command: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", script] };
  }
  return { command: "ps", args: ["-axo", "pid=,ppid=,etime=,command="] };
}

function commandExecutableBasename(command: string): string {
  const token = command.trim().match(/^"([^"]+)"|^'([^']+)'|^(\S+)/);
  const executable = token?.[1] ?? token?.[2] ?? token?.[3] ?? "";
  return executable.split(/[\\/]/).filter(Boolean).at(-1) ?? executable;
}
