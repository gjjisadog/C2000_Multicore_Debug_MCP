import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import type { CcsBridgeCreateSessionOptions, CcsScriptingBridge, CcsScriptingCommand } from "./CcsScriptingBridge.js";
import { resolveDssJson2Path, resolveDssLaunch, resolveDssScriptPath } from "./CcsScriptingBridge.js";
import { DebugMcpError } from "../utils/errors.js";

const execFileAsync = promisify(execFile);

export interface DssServerHandle {
  host: string;
  portsByCoreId: Map<number, number>;
  diagnostics?(): Record<string, unknown>;
  dispose(): Promise<void>;
}

export interface DssServerLauncher {
  launch(options: CcsBridgeCreateSessionOptions): Promise<DssServerHandle>;
}

export interface PersistentDssBridgeOptions {
  launcher?: DssServerLauncher;
  ccsInstallPath?: string;
  dssScriptPath?: string;
  basePort?: number;
  host?: string;
  timeoutMs?: number;
}

export class PersistentDssBridge implements CcsScriptingBridge {
  private readonly launcher: DssServerLauncher;
  private readonly sessions = new Map<string, DssServerHandle>();

  constructor(private readonly options: PersistentDssBridgeOptions = {}) {
    this.launcher = options.launcher ?? new DefaultDssServerLauncher(options);
  }

  async createSession(options: CcsBridgeCreateSessionOptions): Promise<void> {
    if (this.sessions.has(options.adapterSessionId)) {
      return;
    }
    const handle = await this.launcher.launch(options);
    this.sessions.set(options.adapterSessionId, handle);
  }

  async disposeSession(adapterSessionId: string): Promise<void> {
    const handle = this.sessions.get(adapterSessionId);
    if (!handle) {
      return;
    }
    this.sessions.delete(adapterSessionId);
    await this.shutdownSession(handle);
    await handle.dispose();
  }

  async execute(command: CcsScriptingCommand): Promise<Record<string, unknown>> {
    const handle = this.sessions.get(command.adapterSessionId);
    if (!handle) {
      throw new DebugMcpError("SessionNotFound", `Persistent DSS session was not found: ${command.adapterSessionId}`, {
        adapterSessionId: command.adapterSessionId
      });
    }
    const port = handle.portsByCoreId.get(command.coreId);
    if (!port) {
      throw new DebugMcpError("CoreNotFound", `Persistent DSS session has no port for core ${command.coreId}`, {
        adapterSessionId: command.adapterSessionId,
        coreId: command.coreId
      });
    }
    const dssCommand = toDssCommand(command);
    const response = await sendJsonLine(
      handle.host,
      port,
      dssCommand,
      this.options.timeoutMs ?? command.timeoutMs ?? 15000,
      () => ({
        adapterSessionId: command.adapterSessionId,
        operation: command.operation,
        dssCommandName: dssCommand.name,
        coreId: command.coreId,
        coreName: command.coreName,
        diagnostics: handle.diagnostics?.()
      })
    );
    if (response.status === "FAIL") {
      throw new DebugMcpError("AdapterNotAvailable", String(response.message ?? "DSS command failed"), {
        command: command.operation,
        coreId: command.coreId,
        response
      });
    }
    const result = typeof response.value === "object" && response.value !== null
      ? response.value as Record<string, unknown>
      : response as Record<string, unknown>;
    validateResponseCoreIdentity(command, result);
    return result;
  }

  private async shutdownSession(handle: DssServerHandle): Promise<void> {
    const firstPort = handle.portsByCoreId.values().next().value as number | undefined;
    if (typeof firstPort !== "number") {
      return;
    }
    try {
      await requestDssServerShutdown(handle.host, firstPort, this.options.timeoutMs ?? 5000);
    } catch {
      // Disposal still has a fallback kill path in the default launcher.
    }
  }
}

class DefaultDssServerLauncher implements DssServerLauncher {
  constructor(private readonly options: PersistentDssBridgeOptions) {}

  async launch(options: CcsBridgeCreateSessionOptions): Promise<DssServerHandle> {
    const host = this.options.host ?? "127.0.0.1";
    const basePort = this.options.basePort ?? 45600 + Math.floor(Math.random() * 5000);
    const tempDir = await mkdtemp(path.join(tmpdir(), "c2000-dss-server-"));
    const configPath = path.join(tempDir, "server-config.json");
    const scriptPath = path.join(tempDir, "c2000-persistent-server.js");
    const dssScriptPath = this.options.dssScriptPath ?? resolveDssScriptPath(this.options.ccsInstallPath);
    const launch = resolveDssLaunch(dssScriptPath, this.options.ccsInstallPath);
    await writeFile(configPath, JSON.stringify({ ...options, host, basePort, timeoutMs: this.options.timeoutMs ?? 15000 }), "utf8");
    await writeFile(scriptPath, persistentServerScriptSource(resolveDssJson2Path(this.options.ccsInstallPath)), "utf8");
    const child = spawn(launch.command, [...launch.args, scriptPath, configPath], {
      stdio: ["ignore", "pipe", "pipe"],
      env: launch.env,
      shell: launch.shell,
      windowsHide: true
    });
    const output = createProcessOutputBuffer();
    await waitForReady(child, this.options.timeoutMs ?? 20000, output);
    return {
      host,
      portsByCoreId: new Map(options.coreMap.map((core, index) => [core.coreId, basePort + index])),
      diagnostics: () => ({
        pid: child.pid,
        exitCode: child.exitCode,
        signalCode: child.signalCode,
        stdoutTail: output.stdoutTail(),
        stderrTail: output.stderrTail()
      }),
      dispose: async () => {
        try {
          await waitForExit(child, this.options.timeoutMs ?? 10000);
        } catch {
          if (!hasExited(child)) {
            await terminateProcessTree(child);
          }
          try {
            await waitForExit(child, 5000);
          } catch {
            if (!hasExited(child)) {
              await terminateProcessTree(child, true);
            }
          }
        } finally {
          await rm(tempDir, { recursive: true, force: true });
        }
      }
    };
  }
}

async function terminateProcessTree(child: ChildProcess, force = false): Promise<void> {
  if (hasExited(child)) {
    return;
  }
  if (process.platform === "win32" && child.pid !== undefined) {
    try {
      await execFileAsync("taskkill.exe", ["/PID", String(child.pid), "/T", ...(force ? ["/F"] : [])], {
        timeout: 5000,
        windowsHide: true
      });
      return;
    } catch {
      // Fall through to Node's direct child termination if taskkill cannot run.
    }
  }
  child.kill(force ? "SIGKILL" : undefined);
}

function validateResponseCoreIdentity(command: CcsScriptingCommand, result: Record<string, unknown>): void {
  if (!("coreId" in result) || !("coreName" in result)) {
    throw new DebugMcpError("CoreIdentityMissing", "DSS response did not include requested core identity", {
      requestedCoreId: command.coreId,
      requestedCoreName: command.coreName,
      responseCoreId: result.coreId,
      responseCoreName: result.coreName
    });
  }
  if (typeof result.coreId !== "number" || result.coreId !== command.coreId) {
    throw new DebugMcpError("CoreIdentityMismatch", "DSS response coreId did not match requested coreId", {
      requestedCoreId: command.coreId,
      responseCoreId: result.coreId,
      requestedCoreName: command.coreName,
      responseCoreName: result.coreName
    });
  }
  if (typeof result.coreName !== "string" || result.coreName !== command.coreName) {
    throw new DebugMcpError("CoreIdentityMismatch", "DSS response coreName did not match requested coreName", {
      requestedCoreId: command.coreId,
      responseCoreId: result.coreId,
      requestedCoreName: command.coreName,
      responseCoreName: result.coreName
    });
  }
}

function toDssCommand(command: CcsScriptingCommand): Record<string, unknown> {
  const base = { coreId: command.coreId, coreName: command.coreName };
  switch (command.operation) {
    case "connect":
      return { ...base, name: "connect" };
    case "disconnect":
      return { ...base, name: "disconnect" };
    case "run":
      return { ...base, name: "runAsynch" };
    case "halt":
      return { ...base, name: "halt" };
    case "reset":
      return { ...base, name: "reset", resetType: command.resetType };
    case "loadProgram":
      return { ...base, name: "load", program: command.programUri };
    case "prepareFlashLoad":
      return { ...base, name: "prepareFlashLoad", flashBanks: command.flashBanks };
    case "writeMemory":
      return { ...base, name: "writeData", page: command.page, address: command.address, value: command.value, typeSize: command.typeSize };
    case "readPc":
      return { ...base, name: "evaluateExpression", expression: "PC" };
    case "getState":
      return { ...base, name: "getState" };
    case "evaluateExpression":
      return { ...base, name: "evaluateExpression", expression: command.expression };
    case "assignExpression":
      return { ...base, name: "assignExpression", expression: command.expression, valueExpression: command.valueExpression };
    case "resolveAddress":
      return { ...base, name: "resolveAddress", address: command.address };
  }
}

async function sendJsonLine(
  host: string,
  port: number,
  command: Record<string, unknown>,
  timeoutMs: number,
  context?: () => Record<string, unknown>
): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const errorDetails = (details: Record<string, unknown>) => ({
      host,
      port,
      ...context?.(),
      ...details
    });
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("close", onClose);
    };
    const resolveOnce = (value: Record<string, any>) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(value);
    };
    const rejectOnce = (error: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };
    const timer = setTimeout(() => {
      settled = true;
      socket.destroy();
      cleanup();
      reject(new DebugMcpError("AdapterNotAvailable", `Timed out waiting for DSS server on ${host}:${port}`, {
        ...errorDetails({
        rawResponse: buffer
        })
      }));
    }, timeoutMs);
    let buffer = "";
    const onError = (error: Error) => {
      rejectOnce(new DebugMcpError("AdapterNotAvailable", `DSS socket error on ${host}:${port}`, {
        ...errorDetails({
        error: error.message
        })
      }));
    };
    const onClose = () => {
      if (settled) {
        return;
      }
      rejectOnce(new DebugMcpError("AdapterNotAvailable", "DSS server closed the socket before returning a JSON line", {
        ...errorDetails({
        rawResponse: buffer
        })
      }));
    };
    socket.on("connect", () => {
      socket.write(`${JSON.stringify(command)}\n`);
    });
    socket.on("data", chunk => {
      buffer += chunk.toString("utf8");
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) {
        return;
      }
      clearTimeout(timer);
      socket.end();
      const rawResponse = buffer.slice(0, newlineIndex);
      try {
        resolveOnce(JSON.parse(rawResponse));
      } catch (error) {
        rejectOnce(new DebugMcpError("AdapterNotAvailable", "DSS server returned malformed JSON", {
          ...errorDetails({
          rawResponse,
          error: error instanceof Error ? error.message : String(error)
          })
        }));
      }
    });
    socket.on("error", onError);
    socket.on("close", onClose);
  });
}

async function requestDssServerShutdown(host: string, port: number, timeoutMs: number): Promise<void> {
  await sendJsonLine(host, port, { name: "shutdown" }, timeoutMs);
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (hasExited(child)) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new DebugMcpError("AdapterNotAvailable", "Timed out waiting for persistent DSS server exit", {
        pid: child.pid
      }));
    }, timeoutMs);
    const onExit = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off("exit", onExit);
    };
    child.once("exit", onExit);
  });
}

function createProcessOutputBuffer(limit = 12000) {
  let stdout = "";
  let stderr = "";
  const trim = (value: string) => value.length > limit ? value.slice(value.length - limit) : value;
  return {
    appendStdout(chunk: string) {
      stdout = trim(stdout + chunk);
    },
    appendStderr(chunk: string) {
      stderr = trim(stderr + chunk);
    },
    stdoutTail() {
      return stdout;
    },
    stderrTail() {
      return stderr;
    }
  };
}

async function waitForReady(child: ChildProcess, timeoutMs: number, output = createProcessOutputBuffer()): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new DebugMcpError(
      "AdapterNotAvailable",
      "Timed out waiting for persistent DSS server readiness",
      {
        pid: child.pid,
        stdout: output.stdoutTail(),
        stderr: output.stderrTail()
      }
    ))), timeoutMs);
    child.stdout?.on("data", chunk => {
      output.appendStdout(chunk.toString("utf8"));
      if (output.stdoutTail().includes("C2000_DSS_SERVER_READY")) {
        finish(() => resolve());
      }
    });
    child.stderr?.on("data", chunk => {
      output.appendStderr(chunk.toString("utf8"));
    });
    child.on("exit", code => {
      finish(() => reject(new DebugMcpError("AdapterNotAvailable", `Persistent DSS server exited before ready: ${code}`, {
        exitCode: code,
        stdout: output.stdoutTail(),
        stderr: output.stderrTail()
      })));
    });
  });
}

export function persistentServerScriptSource(json2Path: string): string {
  return String.raw`
importPackage(Packages.com.ti.debug.engine.scripting);
importPackage(Packages.com.ti.ccstudio.scripting.environment);
importPackage(Packages.java.lang);
importPackage(Packages.java.net);
importPackage(Packages.java.io);
importClass(java.lang.Thread, java.lang.Runnable);
importClass(java.lang.Runtime);

load("${escapeForDssString(json2Path)}");

function readText(filePath) {
  var reader = new BufferedReader(new FileReader(filePath));
  var line;
  var text = "";
  while ((line = reader.readLine()) != null) text += line;
  reader.close();
  return text;
}

function writeResponse(output, response) {
  output.println(JSON.stringify(response));
}

function logDiagnostic(event, details) {
  try {
    var payload = { event: event };
    for (var key in details) {
      payload[key] = details[key];
    }
    java.lang.System.err.println("C2000_DSS_SERVER_EVENT " + JSON.stringify(payload));
  } catch (ignoreDiagnostic) {}
}

var args = this.arguments;
var config = JSON.parse(readText(String(args[0])));
var script = ScriptingEnvironment.instance();
script.setScriptTimeout(config.timeoutMs || 15000);
var debugServer = script.getServer("DebugServer.1");
debugServer.setConfig(config.ccxmlPath);
var threads = [];
var sessions = [];
var sessionsByCoreId = {};
var coreNamesByCoreId = {};
var sockets = [];
var cleanupDone = false;

function cleanupPersistentDebugServer() {
  if (cleanupDone) {
    return;
  }
  cleanupDone = true;
  for (var socketIndex = 0; socketIndex < sockets.length; socketIndex++) {
    try {
      sockets[socketIndex].close();
    } catch (ignoreSocket) {}
  }
  for (var cleanupIndex = 0; cleanupIndex < sessions.length; cleanupIndex++) {
    try {
      sessions[cleanupIndex].terminate();
    } catch (ignoreSession) {}
  }
  try {
    debugServer.stop();
  } catch (ignoreServer) {}
}

Runtime.getRuntime().addShutdownHook(new Thread(new Runnable({
  run: function() {
    cleanupPersistentDebugServer();
  }
})));

function getSessionForCommand(command) {
  var coreIdKey = String(command.coreId);
  var session = sessionsByCoreId[coreIdKey];
  if (!session) {
    throw "No DebugSession for coreId " + coreIdKey;
  }
  return session;
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

function handleCommand(command) {
  if (command.name === "shutdown") {
    return { status: "OK", value: { shutdown: true } };
  }
  var session = getSessionForCommand(command);
  if (command.name === "connect") {
    session.target.connect();
    return { status: "OK", value: withCoreIdentity(command, { connected: true }) };
  } else if (command.name === "disconnect") {
    session.target.disconnect();
    return { status: "OK", value: withCoreIdentity(command, { connected: false }) };
  } else if (command.name === "runAsynch") {
    session.target.runAsynch();
    return { status: "OK", value: withCoreIdentity(command, { state: "Running" }) };
  } else if (command.name === "halt") {
    session.target.halt();
    return { status: "OK", value: withCoreIdentity(command, { state: "Halted" }) };
  } else if (command.name === "reset") {
    session.target.reset();
    return { status: "OK", value: withCoreIdentity(command, { state: "Halted" }) };
  } else if (command.name === "load") {
    session.memory.loadProgram(command.program);
    return { status: "OK", value: withCoreIdentity(command, { symbolsLoaded: true }) };
  } else if (command.name === "prepareFlashLoad") {
    var cpu1Session = sessionsByCoreId["0"];
    if (!cpu1Session) {
      throw "CPU1 DebugSession is required to configure F28P65x Flash banks";
    }
    var selectedBanks = {};
    for (var selectedIndex = 0; selectedIndex < command.flashBanks.length; selectedIndex++) {
      selectedBanks[String(command.flashBanks[selectedIndex])] = true;
    }
    for (var bankIndex = 0; bankIndex <= 4; bankIndex++) {
      cpu1Session.flash.options.setString("FlashMapC28Bank" + bankIndex, selectedBanks[String(bankIndex)] ? "1" : "0");
      session.flash.options.setBoolean("FlashC28Bank" + bankIndex, selectedBanks[String(bankIndex)] === true);
    }
    session.flash.options.setString("FlashEraseSelection", "Selected Banks Only");
    cpu1Session.flash.performOperation("ConfigureClock");
    cpu1Session.flash.performOperation("ConfigureBanks");
    return { status: "OK", value: withCoreIdentity(command, { flashBanks: command.flashBanks, configured: true }) };
  } else if (command.name === "writeData") {
    session.memory.writeData(resolveMemoryPage(command.page), command.address, command.value, command.typeSize);
    return { status: "OK", value: withCoreIdentity(command, { page: command.page, address: command.address, value: command.value, typeSize: command.typeSize }) };
  } else if (command.name === "evaluateExpression") {
    var value = session.expression.evaluate(command.expression);
    return { status: "OK", value: withCoreIdentity(command, { expression: command.expression, success: true, value: String(value) }) };
  } else if (command.name === "assignExpression") {
    var assignment = String(command.expression) + " = " + String(command.valueExpression);
    var assigned = session.expression.evaluate(assignment);
    return { status: "OK", value: withCoreIdentity(command, { expression: command.expression, assignedValue: String(command.valueExpression), success: true, value: String(assigned) }) };
  } else if (command.name === "getState") {
    var pc = "0x0";
    try { pc = String(session.expression.evaluate("PC")); } catch (ignore) {}
    var connected = session.target.isConnected();
    var state = connected ? (session.target.isHalted() ? "Halted" : "Running") : "Disconnected";
    return { status: "OK", value: withCoreIdentity(command, { connected: connected, state: state, pc: pc }) };
  } else if (command.name === "resolveAddress") {
    return { status: "OK", value: withCoreIdentity(command, { success: true, address: command.address, pc: command.address, partial: true }) };
  }
  return { status: "FAIL", message: "Unsupported command: " + command.name };
}

function resolveMemoryPage(page) {
  if (page === "PROGRAM") {
    return Memory.Page.PROGRAM;
  }
  return Memory.Page.DATA;
}

function startCoreThread(port, boundCoreId) {
  var socket = new ServerSocket(port);
  var boundCoreName = coreNamesByCoreId[String(boundCoreId)];
  sockets.push(socket);
  var thread = new Thread(new Runnable({
    run: function() {
      while (true) {
        var client = socket.accept();
        var input = new BufferedReader(new InputStreamReader(client.getInputStream()));
        var output = new PrintWriter(client.getOutputStream(), true);
        var line = input.readLine();
        while (line != null) {
          try {
            var command = JSON.parse(String(line));
            var shouldShutdown = command.name === "shutdown";
            logDiagnostic("command:start", {
              boundCoreId: boundCoreId,
              boundCoreName: boundCoreName,
              commandCoreId: command.coreId,
              commandCoreName: command.coreName,
              commandName: command.name
            });
            if (command.name !== "shutdown" && String(command.coreId) !== String(boundCoreId)) {
              logDiagnostic("command:failure", {
                boundCoreId: boundCoreId,
                boundCoreName: boundCoreName,
                commandCoreId: command.coreId,
                commandCoreName: command.coreName,
                commandName: command.name,
                message: "Command coreId does not match bound core socket"
              });
              writeResponse(output, {
                status: "FAIL",
                message: "Command coreId does not match bound core socket",
                boundCoreId: boundCoreId,
                commandCoreId: command.coreId
              });
              line = input.readLine();
              continue;
            }
            if (command.name !== "shutdown" && command.coreName !== boundCoreName) {
              logDiagnostic("command:failure", {
                boundCoreId: boundCoreId,
                boundCoreName: boundCoreName,
                commandCoreId: command.coreId,
                commandCoreName: command.coreName,
                commandName: command.name,
                message: "Command coreName does not match bound core mapping"
              });
              writeResponse(output, {
                status: "FAIL",
                message: "Command coreName does not match bound core socket",
                boundCoreId: boundCoreId,
                boundCoreName: boundCoreName,
                commandCoreId: command.coreId,
                commandCoreName: command.coreName
              });
              line = input.readLine();
              continue;
            }
            var response = handleCommand(command);
            writeResponse(output, response);
            logDiagnostic("command:success", {
              boundCoreId: boundCoreId,
              boundCoreName: boundCoreName,
              commandCoreId: command.coreId,
              commandCoreName: command.coreName,
              commandName: command.name,
              status: response.status
            });
            if (shouldShutdown) {
              cleanupPersistentDebugServer();
              java.lang.System.exit(0);
            }
          } catch (ex) {
            logDiagnostic("command:failure", {
              boundCoreId: boundCoreId,
              boundCoreName: boundCoreName,
              commandName: command && command.name,
              message: String(ex)
            });
            writeResponse(output, { status: "FAIL", message: String(ex) });
          }
          line = input.readLine();
        }
        input.close();
        output.close();
        client.close();
      }
    }
  }));
  thread.start();
  return thread;
}

for (var i = 0; i < config.coreMap.length; i++) {
  var core = config.coreMap[i];
  var pattern = core.corePattern || core.coreName;
  var session = debugServer.openSession("*", pattern);
  sessions.push(session);
  sessionsByCoreId[String(core.coreId)] = session;
  coreNamesByCoreId[String(core.coreId)] = core.coreName;
  threads.push(startCoreThread(config.basePort + i, core.coreId));
}

java.lang.System.out.println("C2000_DSS_SERVER_READY");
for (var j = 0; j < threads.length; j++) threads[j].join();
`;
}

function escapeForDssString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}
