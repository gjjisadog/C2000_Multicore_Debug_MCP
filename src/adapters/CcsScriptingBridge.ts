import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile, type ExecFileOptions } from "node:child_process";
import { promisify } from "node:util";
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
  | "writeMemory"
  | "getState"
  | "readPc"
  | "evaluateExpression"
  | "evaluateExpressions"
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
  expressions?: string[];
  valueExpression?: string;
  page?: string;
  address?: string | number;
  value?: number;
  typeSize?: number;
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
    const launch = resolveDssLaunch(dssScriptPath, this.options.ccsInstallPath);
    const tempDir = await mkdtemp(path.join(tmpdir(), "c2000-dss-"));
    const commandPath = path.join(tempDir, "command.json");
    const scriptPath = path.join(tempDir, "c2000-dss-command.js");
    try {
      await writeFile(commandPath, JSON.stringify({ ...command, timeoutMs: command.timeoutMs ?? this.options.timeoutMs ?? 15000 }), "utf8");
      await writeFile(scriptPath, dssCommandScriptSource(resolveDssJson2Path(this.options.ccsInstallPath)), "utf8");
      const { stdout, stderr } = await execFileAsync(launch.command, [...launch.args, scriptPath, commandPath], {
        timeout: command.timeoutMs ?? this.options.timeoutMs ?? 30000,
        maxBuffer: 1024 * 1024 * 8,
        env: launch.env
      });
      return parseDssResult(stdout, stderr);
    } catch (error) {
      throw new DebugMcpError("AdapterNotAvailable", "DSS command execution failed", {
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

function resolveDssScriptPath(ccsInstallPath?: string): string {
  const ccsRoot = requireCcsRoot(ccsInstallPath);
  return path.join(ccsRoot, "ccs_base", "scripting", "bin", process.platform === "win32" ? "dss.bat" : "dss.sh");
}

export function resolveDssJson2Path(ccsInstallPath?: string): string {
  const ccsRoot = requireCcsRoot(ccsInstallPath);
  return path.join(ccsRoot, "ccs_base", "scripting", "examples", "TestServer", "json2.js");
}

export interface DssLaunch {
  command: string;
  args: string[];
  env: ExecFileOptions["env"];
}

export function resolveDssLaunch(dssScriptPath: string, ccsInstallPath?: string): DssLaunch {
  const env = { ...process.env };
  const ccsRoot = requireCcsRoot(ccsInstallPath);
  const debugServerBin = path.join(ccsRoot, "ccs_base", "DebugServer", "bin");
  const commonBin = path.join(ccsRoot, "ccs_base", "common", "bin");
  env.DYLD_LIBRARY_PATH = [debugServerBin, commonBin, env.DYLD_LIBRARY_PATH].filter(Boolean).join(":");

  const bundledJavaHome = path.join(ccsRoot, "ccs-server.app", "jre", "Contents", "Home");
  env.JAVA_HOME = env.C2000_MCP_JAVA_HOME ?? bundledJavaHome;
  env.PATH = [path.join(env.JAVA_HOME, "bin"), env.PATH].filter(Boolean).join(":");

  if (process.platform === "darwin" && process.arch === "arm64") {
    return { command: "arch", args: ["-x86_64", dssScriptPath], env };
  }
  return { command: dssScriptPath, args: [], env };
}

function requireCcsRoot(ccsInstallPath?: string): string {
  const ccsRoot = ccsInstallPath ?? process.env.C2000_MCP_CCS_INSTALL_PATH;
  if (!ccsRoot) throw new DebugMcpError("AdapterNotAvailable", "CCS install path is unresolved; run c2000_getEnvironment or set C2000_MCP_CCS_INSTALL_PATH");
  return ccsRoot;
}

async function assertExecutableExists(filePath: string) {
  try {
    await access(filePath);
  } catch {
    throw new DebugMcpError("AdapterNotAvailable", `DSS launcher was not found: ${filePath}`, { dssScriptPath: filePath });
  }
}

function parseDssResult(stdout: string, stderr: string): Record<string, unknown> {
  const marker = "__C2000_MCP_RESULT__";
  const line = stdout.split(/\r?\n/).find(item => item.startsWith(marker));
  if (!line) {
    throw new DebugMcpError("AdapterNotAvailable", "DSS command did not return a structured result", { stdout, stderr });
  }
  const payload = JSON.parse(line.slice(marker.length));
  if (payload.success === false) {
    throw new DebugMcpError("AdapterNotAvailable", String(payload.error ?? "DSS command failed"), { payload, stdout, stderr });
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
    debugSession.target.reset();
    result = { state: "Halted" };
  } else if (command.operation === "loadProgram") {
    debugSession.memory.loadProgram(command.programUri);
    result = { symbolsLoaded: true };
  } else if (command.operation === "writeMemory") {
    debugSession.memory.writeData(resolveMemoryPage(command.page), command.address, command.value, command.typeSize);
    result = { page: command.page, address: command.address, value: command.value, typeSize: command.typeSize };
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
    result = { success: true, address: command.address, pc: command.address, partial: true };
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
