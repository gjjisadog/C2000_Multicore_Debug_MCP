import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile, type ExecFileOptions } from "node:child_process";
import { promisify } from "node:util";
import { resolveCcsInstallPath } from "../ccs/paths.js";
import type { CoreConfig, CoreId, ExpressionAssignmentValue, ResetType } from "../debug/types.js";
import { DebugMcpError } from "../utils/errors.js";

const execFileAsync = promisify(execFile);

export type CcsScriptingOperation =
  | "connect"
  | "disconnect"
  | "run"
  | "halt"
  | "reset"
  | "loadProgram"
  | "prepareFlashLoad"
  | "writeMemory"
  | "readMemory"
  | "getState"
  | "readPc"
  | "evaluateExpression"
  | "assignExpression"
  | "resolveAddress";

export interface CcsScriptingCommand {
  adapterSessionId: string;
  operation: CcsScriptingOperation;
  ccxmlPath?: string;
  coreId: CoreId;
  coreName: string;
  corePattern: string;
  resetType?: ResetType;
  programUri?: string;
  expression?: string;
  valueExpression?: string;
  page?: string;
  address?: string | number;
  value?: number;
  typeSize?: number;
  flashBanks?: number[];
  timeoutMs?: number;
}

export interface CcsBridgeCreateSessionOptions {
  adapterSessionId: string;
  sessionName: string;
  ccxmlPath: string;
  coreMap: CoreConfig[];
}

export interface CcsScriptingBridge {
  createSession?(options: CcsBridgeCreateSessionOptions): Promise<void>;
  disposeSession?(adapterSessionId: string): Promise<void>;
  execute(command: CcsScriptingCommand): Promise<Record<string, unknown>>;
}

export interface DssCliBridgeOptions {
  ccsInstallPath?: string;
  workspacePath?: string;
  dssScriptPath?: string;
  timeoutMs?: number;
}

export class DssCliBridge implements CcsScriptingBridge {
  constructor(private readonly options: DssCliBridgeOptions = {}) {}

  async createSession(_options: CcsBridgeCreateSessionOptions): Promise<void> {
    // Stateless compatibility bridge. Persistent bridges use this hook to keep
    // per-core DebugSession objects alive across commands.
  }

  async execute(command: CcsScriptingCommand): Promise<Record<string, unknown>> {
    const dssScriptPath = this.options.dssScriptPath ?? resolveDssScriptPath(this.options.ccsInstallPath);
    await assertExecutableExists(dssScriptPath);
    const launch = resolveDssLaunch(dssScriptPath, this.options.ccsInstallPath, this.options.workspacePath);
    const tempDir = await mkdtemp(path.join(tmpdir(), "c2000-dss-"));
    const commandPath = path.join(tempDir, "command.json");
    const scriptPath = path.join(tempDir, "c2000-dss-command.js");
    try {
      await writeFile(commandPath, JSON.stringify({ ...command, timeoutMs: command.timeoutMs ?? this.options.timeoutMs ?? 15000 }), "utf8");
      await writeFile(scriptPath, dssCommandScriptSource(resolveDssJson2Path(this.options.ccsInstallPath)), "utf8");
      const { stdout, stderr } = await execFileAsync(launch.command, dssLaunchArguments(launch, [scriptPath, commandPath]), {
        timeout: command.timeoutMs ?? this.options.timeoutMs ?? 30000,
        maxBuffer: 1024 * 1024 * 8,
        env: launch.env,
        cwd: launch.cwd
      });
      return parseDssResult(stdout, stderr);
    } catch (error) {
      if (error instanceof DebugMcpError) {
        throw error;
      }
      throw new DebugMcpError("DssCommandFailed", "DSS command execution failed", {
        operation: command.operation,
        coreId: command.coreId,
        coreName: command.coreName,
        error: error instanceof Error ? error.message : String(error)
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}

export function resolveCcsRoot(ccsInstallPath?: string, platform: NodeJS.Platform = process.platform): string {
  return resolveCcsInstallPath(ccsInstallPath, platform);
}

export function resolveDssScriptPath(ccsInstallPath?: string, platform: NodeJS.Platform = process.platform): string {
  const ccsRoot = resolveCcsRoot(ccsInstallPath, platform);
  const platformPath = platform === "win32" ? path.win32 : path.posix;
  return platformPath.join(ccsRoot, "ccs_base", "scripting", "bin", platform === "win32" ? "dss.bat" : "dss.sh");
}

export async function isCcsDssAvailable(ccsInstallPath?: string): Promise<boolean> {
  try {
    await access(resolveDssScriptPath(ccsInstallPath));
    return true;
  } catch {
    return false;
  }
}

export function resolveDssJson2Path(ccsInstallPath?: string, platform: NodeJS.Platform = process.platform): string {
  const ccsRoot = resolveCcsRoot(ccsInstallPath, platform);
  const platformPath = platform === "win32" ? path.win32 : path.posix;
  return platformPath.join(ccsRoot, "ccs_base", "scripting", "examples", "TestServer", "json2.js");
}

export interface DssLaunch {
  command: string;
  args: string[];
  env: ExecFileOptions["env"];
  cwd?: string;
  /** True when the launcher is a Windows batch file invoked through cmd.exe. */
  windowsBatch?: boolean;
  /** Validated path to the batch launcher when `windowsBatch` is true. */
  windowsBatchScript?: string;
}

export function resolveDssLaunch(
  dssScriptPath: string,
  ccsInstallPath?: string,
  workspacePathOrPlatform?: string,
  platformOrArchitecture?: NodeJS.Platform | string,
  architecture = process.arch
): DssLaunch {
  const platform = isPlatform(workspacePathOrPlatform)
    ? workspacePathOrPlatform
    : isPlatform(platformOrArchitecture)
      ? platformOrArchitecture
      : process.platform;
  const workspacePath = isPlatform(workspacePathOrPlatform) ? undefined : workspacePathOrPlatform;
  const resolvedArchitecture = isPlatform(workspacePathOrPlatform) && typeof platformOrArchitecture === "string"
    ? platformOrArchitecture
    : architecture;
  const env = { ...process.env };
  const ccsRoot = resolveCcsRoot(ccsInstallPath, platform);
  const platformPath = platform === "win32" ? path.win32 : path.posix;
  const debugServerBin = platformPath.join(ccsRoot, "ccs_base", "DebugServer", "bin");
  const commonBin = platformPath.join(ccsRoot, "ccs_base", "common", "bin");
  const pathDelimiter = platform === "win32" ? ";" : ":";
  if (platform === "darwin") {
    env.DYLD_LIBRARY_PATH = [debugServerBin, commonBin, env.DYLD_LIBRARY_PATH].filter(Boolean).join(pathDelimiter);
    env.JAVA_HOME = env.C2000_MCP_JAVA_HOME ?? platformPath.join(ccsRoot, "ccs-server.app", "jre", "Contents", "Home");
  } else if (env.C2000_MCP_JAVA_HOME) {
    env.JAVA_HOME = env.C2000_MCP_JAVA_HOME;
  }
  env.PATH = [
    debugServerBin,
    commonBin,
    ...(env.JAVA_HOME ? [platformPath.join(env.JAVA_HOME, "bin")] : []),
    env.PATH ?? env.Path
  ].filter(Boolean).join(pathDelimiter);
  env.C2000_MCP_CCS_INSTALL_PATH = ccsRoot;
  if (workspacePath && workspacePath.length > 0) {
    env.C2000_MCP_WORKSPACE_PATH = workspacePath;
    // Common CCS Scripting / Eclipse-style workspace hints used by tooling and relative path resolution.
    env.WORKSPACE = workspacePath;
    env.CCS_WORKSPACE = workspacePath;
  }

  const launch: DssLaunch = platform === "win32"
    ? {
        // Node cannot execute .bat files directly without shell:true.  Invoke a
        // fixed cmd.exe explicitly and reject cmd metacharacters in all dynamic
        // paths before they are passed to its command parser.
        command: process.env.ComSpec ?? "cmd.exe",
        args: ["/d", "/s", "/c"],
        env,
        windowsBatch: true,
        windowsBatchScript: assertSafeWindowsCmdPath(dssScriptPath)
      }
    : platform === "darwin" && resolvedArchitecture === "arm64"
      ? { command: "arch", args: ["-x86_64", dssScriptPath], env }
      : { command: dssScriptPath, args: [], env };
  if (workspacePath && workspacePath.length > 0) {
    launch.cwd = workspacePath;
  }
  return launch;
}

/**
 * Appends generated DSS script/config paths to a launch command without ever
 * enabling Node's implicit shell.  Windows batch launchers still need cmd.exe,
 * so inputs that could alter cmd parsing are rejected rather than quoted
 * optimistically.
 */
export function dssLaunchArguments(launch: DssLaunch, dssArguments: string[]): string[] {
  if (!launch.windowsBatch) {
    return [...launch.args, ...dssArguments];
  }
  if (!launch.windowsBatchScript) {
    throw new DebugMcpError("UnsafeDssLaunchPath", "Windows batch launch is missing its DSS launcher path");
  }
  // Do not assemble `call "…" "…"` into one argument. Node correctly
  // escapes embedded quotes while constructing the process command line, but
  // cmd.exe then receives the backslashes as part of the batch-file path.
  // Separate arguments let Node quote paths containing spaces once, at the
  // Windows process boundary.
  return [
    ...launch.args,
    "call",
    assertSafeWindowsCmdPath(launch.windowsBatchScript),
    ...dssArguments.map(assertSafeWindowsCmdPath)
  ];
}

function assertSafeWindowsCmdPath(filePath: string): string {
  if (/["&|<>^()%!]/.test(filePath)) {
    throw new DebugMcpError(
      "UnsafeDssLaunchPath",
      "DSS launcher paths containing cmd.exe metacharacters are not supported",
      { filePath }
    );
  }
  return filePath;
}

function isPlatform(value: string | undefined): value is NodeJS.Platform {
  return value === "darwin" || value === "win32" || value === "linux" || value === "aix" || value === "android" || value === "freebsd" || value === "haiku" || value === "openbsd" || value === "sunos" || value === "cygwin" || value === "netbsd";
}

async function assertExecutableExists(filePath: string) {
  try {
    await access(filePath);
  } catch {
    throw new DebugMcpError("DssNotFound", `DSS launcher was not found: ${filePath}`, { dssScriptPath: filePath });
  }
}

function parseDssResult(stdout: string, stderr: string): Record<string, unknown> {
  const marker = "__C2000_MCP_RESULT__";
  const line = stdout.split(/\r?\n/).find(item => item.startsWith(marker));
  if (!line) {
    throw new DebugMcpError("DssCommandFailed", "DSS command did not return a structured result", { stdout, stderr });
  }
  const payload = JSON.parse(line.slice(marker.length));
  if (payload.success === false) {
    throw new DebugMcpError("DssCommandFailed", String(payload.error ?? "DSS command failed"), { payload, stdout, stderr });
  }
  return payload.result ?? {};
}

export function dssCommandScriptSource(json2Path: string): string {
  return String.raw`
importPackage(Packages.com.ti.debug.engine.scripting);
importPackage(Packages.com.ti.ccstudio.scripting.environment);
importPackage(Packages.java.lang);
importPackage(Packages.java.io);

load("${escapeForDssString(json2Path)}");

function readText(filePath) {
  var reader = new BufferedReader(new FileReader(filePath));
  var line;
  var text = "";
  while ((line = reader.readLine()) != null) {
    text += line;
  }
  reader.close();
  return text;
}

function printResult(result) {
  java.lang.System.out.println("__C2000_MCP_RESULT__" + JSON.stringify({ success: true, result: result }));
}

function printError(error) {
  java.lang.System.out.println("__C2000_MCP_RESULT__" + JSON.stringify({ success: false, error: String(error) }));
}

function withCoreIdentity(command, value) {
  var result = {};
  for (var key in value) {
    result[key] = value[key];
  }
  result.coreId = command.coreId;
  result.coreName = command.coreName;
  return result;
}

var debugServer = null;
var debugSession = null;

try {
  var args = this.arguments;
  var command = JSON.parse(readText(String(args[0])));
  var script = ScriptingEnvironment.instance();
  if (command.timeoutMs) {
    script.setScriptTimeout(command.timeoutMs);
  }
  debugServer = script.getServer("DebugServer.1");
  debugServer.setConfig(command.ccxmlPath);
  debugSession = debugServer.openSession("*", command.corePattern || command.coreName);

  var result = {};
  if (command.operation === "connect") {
    debugSession.target.connect();
    result = { connected: true };
  } else if (command.operation === "disconnect") {
    debugSession.target.disconnect();
    result = { connected: false };
  } else if (command.operation === "run") {
    debugSession.target.runAsynch();
    result = { state: "Running" };
  } else if (command.operation === "halt") {
    debugSession.target.halt();
    result = { state: "Halted" };
  } else if (command.operation === "reset") {
    applyTargetReset(debugSession, command.resetType);
    result = { state: "Halted", resetType: command.resetType || "default" };
  } else if (command.operation === "loadProgram") {
    debugSession.memory.loadProgram(command.programUri);
    result = { symbolsLoaded: true };
  } else if (command.operation === "writeMemory") {
    debugSession.memory.writeData(resolveMemoryPage(command.page), command.address, command.value, command.typeSize);
    result = { page: command.page, address: command.address, value: command.value, typeSize: command.typeSize };
  } else if (command.operation === "readMemory") {
    var readValue = debugSession.memory.readData(resolveMemoryPage(command.page), command.address, command.typeSize);
    result = { page: command.page, address: command.address, value: Number(readValue), typeSize: command.typeSize };
  } else if (command.operation === "readPc") {
    result = { pc: String(debugSession.expression.evaluate("PC")) };
  } else if (command.operation === "getState") {
    var pc = "0x0";
    try {
      pc = String(debugSession.expression.evaluate("PC"));
    } catch (ignore) {}
    var connected = debugSession.target.isConnected();
    var state = connected ? (debugSession.target.isHalted() ? "Halted" : "Running") : "Disconnected";
    result = { connected: connected, state: state, pc: pc };
  } else if (command.operation === "evaluateExpression") {
    var value = debugSession.expression.evaluate(command.expression);
    result = { expression: command.expression, success: true, value: String(value) };
  } else if (command.operation === "assignExpression") {
    var assignment = String(command.expression) + " = " + String(command.valueExpression);
    var assigned = debugSession.expression.evaluate(assignment);
    result = { expression: command.expression, assignedValue: String(command.valueExpression), success: true, value: String(assigned) };
  } else if (command.operation === "resolveAddress") {
    result = {
      success: false,
      address: command.address,
      pc: command.address,
      partial: true,
      error: "Address-to-source mapping is not implemented by the CCS scripting adapter"
    };
  } else {
    throw "Unsupported operation: " + command.operation;
  }

  printResult(withCoreIdentity(command, result));
} catch (ex) {
  printError(ex);
} finally {
  try {
    if (debugSession != null) {
      debugSession.terminate();
    }
  } catch (ignoreSession) {}
  try {
    if (debugServer != null) {
      debugServer.stop();
    }
  } catch (ignoreServer) {}
}

function applyTargetReset(session, resetType) {
  var type = resetType || "default";
  if (type === "system") {
    try {
      session.target.systemReset();
      return;
    } catch (systemResetError) {
      try {
        session.expression.evaluate("GEL_SystemReset()");
        return;
      } catch (gelSystemResetError) {}
    }
  } else if (type === "restart") {
    try {
      session.target.restart();
      return;
    } catch (restartError) {}
  }
  session.target.reset();
}

function resolveMemoryPage(page) {
  if (page === "PROGRAM") {
    return Memory.Page.PROGRAM;
  }
  return Memory.Page.DATA;
}
`;
}

export function formatExpressionAssignmentValue(value: ExpressionAssignmentValue): string {
  if (typeof value === "boolean") {
    return value ? "1" : "0";
  }
  return String(value);
}

function escapeForDssString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}
