import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import type { CcsBridgeCreateSessionOptions, CcsScriptingBridge, CcsScriptingCommand } from "./CcsScriptingBridge.js";
import { dssLaunchArguments, resolveDssJson2Path, resolveDssLaunch, resolveDssScriptPath } from "./CcsScriptingBridge.js";
import { DebugMcpError } from "../utils/errors.js";
import { dssResetHelperSource } from "./DssResetSource.js";
import { PersistentCoreChannel } from "./PersistentCoreChannel.js";

const execFileAsync = promisify(execFile);

export interface DssServerHandle {
  host: string;
  portsByCoreId: Map<number, number>;
  /** Random per-session credential shared only with the generated DSS server. */
  authToken: string;
  diagnostics?(): Record<string, unknown>;
  dispose(): Promise<void>;
}

export interface DssServerLauncher {
  launch(options: CcsBridgeCreateSessionOptions): Promise<DssServerHandle>;
}

export interface PersistentDssBridgeOptions {
  launcher?: DssServerLauncher;
  ccsInstallPath?: string;
  workspacePath?: string;
  dssScriptPath?: string;
  basePort?: number;
  host?: string;
  timeoutMs?: number;
  probeRetryAttempts?: number;
  probeRetryBaseDelayMs?: number;
  shutdownRequestMs?: number;
  startupMs?: number;
  processExitMs?: number;
  ownership?: { boardId?: string; probeSerial?: string; workerInstanceId?: string; daemonInstanceId?: string };
}

interface PersistentBridgeSession {
  handle: DssServerHandle;
  channels: Map<number, PersistentCoreChannel>;
}

const processCleanupBridges = new Set<PersistentDssBridge>();
let processCleanupHooksInstalled = false;

export class PersistentDssBridge implements CcsScriptingBridge {
  readonly supportsFirmwareHandoff = true;
  private readonly launcher: DssServerLauncher;
  private readonly sessions = new Map<string, PersistentBridgeSession>();

  constructor(private readonly options: PersistentDssBridgeOptions = {}) {
    this.launcher = options.launcher ?? new DefaultDssServerLauncher(options);
    processCleanupBridges.add(this);
    installProcessCleanupHooks();
  }

  async createSession(options: CcsBridgeCreateSessionOptions): Promise<void> {
    if (this.sessions.has(options.adapterSessionId)) {
      return;
    }
    const handle = await this.launcher.launch(options);
    const channels = new Map(options.coreMap.flatMap(core => {
      const port = handle.portsByCoreId.get(core.coreId);
      if (!port) return [];
      return [[core.coreId, new PersistentCoreChannel({
        host: handle.host, port, coreId: core.coreId, coreName: core.coreName,
        context: () => ({ adapterSessionId: options.adapterSessionId, diagnostics: handle.diagnostics?.() })
      })] as const];
    }));
    this.sessions.set(options.adapterSessionId, { handle, channels });
  }

  async disposeSession(adapterSessionId: string): Promise<void> {
    const session = this.sessions.get(adapterSessionId);
    if (!session) {
      return;
    }
    this.sessions.delete(adapterSessionId);
    await this.shutdownSession(session);
    await session.handle.dispose();
  }

  async disposeAllSessions(): Promise<void> {
    const ids = Array.from(this.sessions.keys());
    for (const id of ids) {
      try {
        await this.disposeSession(id);
      } catch {
        // Best-effort process teardown.
      }
    }
  }

  async execute(command: CcsScriptingCommand): Promise<Record<string, unknown>> {
    const session = this.sessions.get(command.adapterSessionId);
    if (!session) {
      throw new DebugMcpError("SessionNotFound", `Persistent DSS session was not found: ${command.adapterSessionId}`, {
        adapterSessionId: command.adapterSessionId
      });
    }
    const channel = session.channels.get(command.coreId);
    if (!channel) {
      throw new DebugMcpError("CoreNotFound", `Persistent DSS session has no port for core ${command.coreId}`, {
        adapterSessionId: command.adapterSessionId,
        coreId: command.coreId
      });
    }
    const dssCommand = toDssCommand(command);
    const response = await channel.execute({ ...dssCommand, authToken: session.handle.authToken }, command.timeoutMs ?? this.options.timeoutMs ?? 15000);
    if (response.status === "FAIL") {
      throw new DebugMcpError("DssCommandFailed", String(response.message ?? "DSS command failed"), {
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

  ownedProcesses(): Record<string, unknown>[] {
    return [...this.sessions.entries()].map(([adapterSessionId, session]) => {
      const diagnostics = session.handle.diagnostics?.() ?? {};
      return {
        pid: diagnostics.pid,
        processGroupId: diagnostics.processGroupId,
        ppid: diagnostics.ppid,
        processStartTime: diagnostics.processStartTime,
        executable: diagnostics.executable,
        commandLineHash: diagnostics.commandLineHash,
        adapterSessionId,
        sessionId: diagnostics.sessionId ?? adapterSessionId,
        boardId: this.options.ownership?.boardId,
        probeSerial: this.options.ownership?.probeSerial,
        workerInstanceId: this.options.ownership?.workerInstanceId,
        daemonInstanceId: this.options.ownership?.daemonInstanceId,
        createdAt: diagnostics.createdAt ?? diagnostics.processStartTime,
        status: diagnostics.exitCode === null || diagnostics.exitCode === undefined ? "RUNNING" : "EXITED"
      };
    });
  }

  private async shutdownSession(session: PersistentBridgeSession): Promise<void> {
    const firstChannel = session.channels.values().next().value as PersistentCoreChannel | undefined;
    try {
      if (firstChannel) await firstChannel.execute({ name: "shutdown", authToken: session.handle.authToken }, this.options.shutdownRequestMs ?? 3000);
    } catch {
      // Disposal still has a fallback kill path in the default launcher.
    } finally {
      await Promise.all([...session.channels.values()].map(channel => channel.close()));
    }
  }
}

class DefaultDssServerLauncher implements DssServerLauncher {
  constructor(private readonly options: PersistentDssBridgeOptions) {}

  async launch(options: CcsBridgeCreateSessionOptions): Promise<DssServerHandle> {
    const host = this.options.host ?? "127.0.0.1";
    const coreCount = Math.max(1, options.coreMap.length);
    const attempts = this.options.basePort === undefined
      ? 12
      : Math.max(1, this.options.probeRetryAttempts ?? 3);
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const basePort = this.options.basePort
        ?? await allocateEphemeralBasePort(host, coreCount);
      try {
        return await this.launchOnPort(options, host, basePort);
      } catch (error) {
        lastError = error;
        const retryableProbeError = isRetryableXdsLaunchError(error);
        if (!retryableProbeError) {
          throw error;
        }
        if (retryableProbeError && attempt < attempts - 1) {
          await retryDelay(attempt, this.options.probeRetryBaseDelayMs ?? 250);
        }
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new DebugMcpError("DssLaunchFailed", "Failed to launch persistent DSS server after port retries");
  }

  private async launchOnPort(
    options: CcsBridgeCreateSessionOptions,
    host: string,
    basePort: number
  ): Promise<DssServerHandle> {
    const tempDir = await mkdtemp(path.join(tmpdir(), "c2000-dss-server-"));
    const configPath = path.join(tempDir, "server-config.json");
    const scriptPath = path.join(tempDir, "c2000-persistent-server.js");
    const dssScriptPath = this.options.dssScriptPath ?? resolveDssScriptPath(this.options.ccsInstallPath);
    const launch = resolveDssLaunch(dssScriptPath, this.options.ccsInstallPath, this.options.workspacePath);
    const launchArgs = dssLaunchArguments(launch, [scriptPath, configPath]);
    const processStartTime = new Date().toISOString();
    const commandLineHash = createHash("sha256").update(JSON.stringify([launch.command, ...launchArgs])).digest("hex");
    const authToken = randomBytes(32).toString("base64url");
    await writeFile(configPath, JSON.stringify({ ...options, host, basePort, authToken, timeoutMs: this.options.timeoutMs ?? 15000 }), "utf8");
    await writeFile(scriptPath, persistentServerScriptSource(resolveDssJson2Path(this.options.ccsInstallPath)), "utf8");
    const child = spawn(launch.command, launchArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      env: launch.env,
      cwd: launch.cwd,
      windowsHide: true,
      // On POSIX, keep the complete DSS launcher tree in a session-owned
      // process group.  dss.sh normally starts Java/DSLite descendants; a
      // direct child.kill() would leave those descendants attached to the
      // probe after the logical session closes.
      detached: process.platform !== "win32"
    });
    const killChildOnParentExit = () => {
      if (child.pid !== undefined) {
        void terminateProcessTree(child, true);
      }
    };
    process.once("exit", killChildOnParentExit);
    const output = createProcessOutputBuffer();
    try {
      await waitForReady(child, this.options.startupMs ?? this.options.timeoutMs ?? 60000, output);
    } catch (error) {
      process.removeListener("exit", killChildOnParentExit);
      killChildOnParentExit();
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    return {
      host,
      portsByCoreId: new Map(options.coreMap.map((core, index) => [core.coreId, basePort + index])),
      authToken,
      diagnostics: () => ({
        pid: child.pid,
        processGroupId: processGroupId(child),
        ppid: process.pid,
        processStartTime,
        createdAt: processStartTime,
        executable: launch.command,
        commandLineHash,
        sessionId: options.sessionName,
        exitCode: child.exitCode,
        signalCode: child.signalCode,
        basePort,
        stdoutTail: output.stdoutTail(),
        stderrTail: output.stderrTail()
      }),
      dispose: async () => {
        try {
          await waitForExit(child, this.options.processExitMs ?? 5000);
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
          process.removeListener("exit", killChildOnParentExit);
          // The launcher wrapper can exit before a DSS/Java descendant does.
          // A final group-scoped force cleanup closes that gap without using a
          // global process-name kill.
          await terminateProcessTree(child, true).catch(() => undefined);
          await rm(tempDir, { recursive: true, force: true });
        }
      }
    };
  }
}

async function terminateProcessTree(child: ChildProcess, force = false): Promise<void> {
  if (process.platform === "win32" && child.pid !== undefined) {
    if (hasExited(child)) {
      return;
    }
    try {
      await execFileAsync("taskkill.exe", ["/PID", String(child.pid), "/T", ...(force ? ["/F"] : [])], {
        timeout: 5000,
        windowsHide: true
      });
      return;
    } catch {
      // Fall through to Node's direct child termination if taskkill cannot run.
    }
    child.kill(force ? "SIGKILL" : "SIGTERM");
    return;
  }

  // detached:true makes the direct child the process-group leader.  Use a
  // negative PID so descendants are terminated as one session-owned unit,
  // even when the launcher wrapper has already exited.  If the group is
  // already gone, there is nothing left to clean; otherwise fall back to the
  // direct child for unusual runtimes that do not expose process groups.
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
      return;
    } catch (error) {
      if (isMissingProcessError(error)) {
        return;
      }
    }
  }
  if (!hasExited(child)) {
    child.kill(force ? "SIGKILL" : "SIGTERM");
  }
}

function processGroupId(child: ChildProcess): number | undefined {
  return process.platform === "win32" ? undefined : child.pid;
}

function isMissingProcessError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ESRCH";
}

export function isRetryableXdsLaunchError(error: unknown): boolean {
  const text = error instanceof DebugMcpError
    ? `${error.message} ${JSON.stringify(error.details ?? {})}`
    : error instanceof Error ? error.message : String(error);
  return /Error\s*-260|attempt to connect to the XDS110 failed|IcePick_C_0/i.test(text);
}

export function xdsRetryDelayMs(attempt: number, baseDelayMs = 250): number {
  return Math.min(2000, Math.max(0, baseDelayMs) * (2 ** Math.max(0, attempt)));
}

function retryDelay(attempt: number, baseDelayMs: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, xdsRetryDelayMs(attempt, baseDelayMs)));
}

function installProcessCleanupHooks() {
  if (processCleanupHooksInstalled) {
    return;
  }
  processCleanupHooksInstalled = true;
  const disposeAll = async () => {
    await Promise.allSettled(
      Array.from(processCleanupBridges, bridge => bridge.disposeAllSessions())
    );
  };
  const exitAfterCleanup = (exitCode: number) => {
    void disposeAll().finally(() => process.exit(exitCode));
  };
  process.once("SIGINT", () => exitAfterCleanup(130));
  process.once("SIGTERM", () => exitAfterCleanup(143));
  process.once("beforeExit", () => {
    void disposeAll();
  });
}

async function allocateEphemeralBasePort(host: string, coreCount: number): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = 45600 + Math.floor(Math.random() * 10000);
    const free = await portsAvailable(host, candidate, coreCount);
    if (free) {
      return candidate;
    }
  }
  return 45600 + Math.floor(Math.random() * 10000);
}

async function portsAvailable(host: string, basePort: number, count: number): Promise<boolean> {
  for (let offset = 0; offset < count; offset++) {
    const ok = await canBindPort(host, basePort + offset);
    if (!ok) {
      return false;
    }
  }
  return true;
}

async function canBindPort(host: string, port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
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
    case "loadSymbols":
      return { ...base, name: "loadSymbols", program: command.programUri };
    case "prepareFlashLoad":
      return { ...base, name: "prepareFlashLoad", flashBanks: command.flashBanks };
    case "prepareFirmwareHandoff":
      return { ...base, name: "prepareFirmwareHandoff" };
    case "writeMemory":
      return { ...base, name: "writeData", page: command.page, address: command.address, value: command.value, typeSize: command.typeSize };
    case "readMemory":
      return { ...base, name: "readData", page: command.page, address: command.address, typeSize: command.typeSize };
    case "readPc":
      return { ...base, name: "evaluateExpression", expression: "PC" };
    case "getState":
      return { ...base, name: "getState" };
    case "evaluateExpression":
      return { ...base, name: "evaluateExpression", expression: command.expression };
    case "evaluateExpressions":
      return {
        ...base,
        name: "evaluateMany",
        expressions: command.expressions,
        diagnostics: command.diagnostics ?? "full"
      };
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
      reject(new DebugMcpError("DssTimeout", `Timed out waiting for DSS server on ${host}:${port}`, {
        ...errorDetails({
        rawResponse: buffer
        })
      }));
    }, timeoutMs);
    let buffer = "";
    const onError = (error: Error) => {
      rejectOnce(new DebugMcpError("DssTransportFailed", `DSS socket error on ${host}:${port}`, {
        ...errorDetails({
        error: error.message
        })
      }));
    };
    const onClose = () => {
      if (settled) {
        return;
      }
      rejectOnce(new DebugMcpError("DssTransportFailed", "DSS server closed the socket before returning a JSON line", {
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
        rejectOnce(new DebugMcpError("DssTransportFailed", "DSS server returned malformed JSON", {
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

async function requestDssServerShutdown(host: string, port: number, authToken: string, timeoutMs: number): Promise<void> {
  await sendJsonLine(host, port, { name: "shutdown", authToken }, timeoutMs);
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
      reject(new DebugMcpError("DssTimeout", "Timed out waiting for persistent DSS server exit", {
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
      "DssTimeout",
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
      finish(() => reject(new DebugMcpError("DssLaunchFailed", `Persistent DSS server exited before ready: ${code}`, {
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
importClass(java.net.InetSocketAddress);

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

function isAuthenticated(command) {
  return command != null && typeof command.authToken === "string" &&
    command.authToken === String(config.authToken);
}

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
    return { status: "OK", value: withCoreIdentity(command, applyTargetReset(session, command.resetType)) };
  } else if (command.name === "load") {
    session.memory.loadProgram(command.program);
    return { status: "OK", value: withCoreIdentity(command, { symbolsLoaded: true }) };
  } else if (command.name === "loadSymbols") {
    session.symbol.load(command.program);
    return { status: "OK", value: withCoreIdentity(command, { symbolsLoaded: true, targetMemoryWritten: false }) };
  } else if (command.name === "prepareFirmwareHandoff") {
    // This changes debugger callbacks, not target memory. It must happen before
    // disconnect, so CPU2 reconnect cannot execute OnTargetConnect RAM init/reset.
    session.expression.evaluate("GEL_UnloadAllGels()");
    return { status: "OK", value: withCoreIdentity(command, { gelInitializationDisabled: true }) };
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
  } else if (command.name === "readData") {
    var readValue = session.memory.readData(resolveMemoryPage(command.page), command.address, command.typeSize);
    return { status: "OK", value: withCoreIdentity(command, { page: command.page, address: command.address, value: Number(readValue), typeSize: command.typeSize }) };
  } else if (command.name === "evaluateExpression") {
    var value = session.expression.evaluate(command.expression);
    return { status: "OK", value: withCoreIdentity(command, { expression: command.expression, success: true, value: String(value) }) };
  } else if (command.name === "evaluateMany") {
    var results = [];
    for (var expressionIndex = 0; expressionIndex < command.expressions.length; expressionIndex++) {
      var expression = String(command.expressions[expressionIndex]);
      try {
        var expressionValue = session.expression.evaluate(expression);
        results.push({ expression: expression, success: true, value: String(expressionValue) });
      } catch (expressionError) {
        results.push({ expression: expression, success: false, error: { code: "ExpressionEvaluationFailed", message: String(expressionError) } });
      }
    }
    return { status: "OK", value: withCoreIdentity(command, { results: results }) };
  } else if (command.name === "assignExpression") {
    var assignment = String(command.expression) + " = " + String(command.valueExpression);
    var assigned = session.expression.evaluate(assignment);
    return { status: "OK", value: withCoreIdentity(command, { expression: command.expression, assignedValue: String(command.valueExpression), success: true, value: String(assigned) }) };
  } else if (command.name === "getState") {
    var connected = session.target.isConnected();
    var state = connected ? (session.target.isHalted() ? "Halted" : "Running") : "Disconnected";
    return { status: "OK", value: withCoreIdentity(command, { connected: connected, state: state }) };
  } else if (command.name === "resolveAddress") {
    return {
      status: "OK",
      value: withCoreIdentity(command, {
        success: false,
        address: command.address,
        pc: command.address,
        partial: true,
        error: "Address-to-source mapping is not implemented by the CCS scripting adapter"
      })
    };
  }
  return { status: "FAIL", message: "Unsupported command: " + command.name };
}

${dssResetHelperSource}

function resolveMemoryPage(page) {
  if (page === "PROGRAM") {
    return Memory.Page.PROGRAM;
  }
  return Memory.Page.DATA;
}

function startCoreThread(port, boundCoreId) {
  // Constructing ServerSocket(port) binds all interfaces.  The persistent DSS
  // control protocol is intentionally explicit about its configured endpoint.
  var socket = new ServerSocket();
  socket.bind(new InetSocketAddress(String(config.host || "127.0.0.1"), port));
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
            if (!isAuthenticated(command)) {
              logDiagnostic("command:failure", {
                boundCoreId: boundCoreId,
                boundCoreName: boundCoreName,
                commandName: command && command.name,
                message: "Unauthorized DSS command"
              });
              writeResponse(output, { status: "FAIL", message: "Unauthorized DSS command" });
              line = input.readLine();
              continue;
            }
            var shouldShutdown = command.name === "shutdown";
            if (command.diagnostics !== "errors-only") {
              logDiagnostic("command:start", {
                boundCoreId: boundCoreId,
                boundCoreName: boundCoreName,
                commandCoreId: command.coreId,
                commandCoreName: command.coreName,
                commandName: command.name
              });
            }
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
            response.requestId = command.requestId;
            if (response.value && command.name !== "shutdown") {
              response.coreId = response.value.coreId;
              response.coreName = response.value.coreName;
            }
            writeResponse(output, response);
            if (command.diagnostics !== "errors-only") {
              logDiagnostic("command:success", {
                boundCoreId: boundCoreId,
                boundCoreName: boundCoreName,
                commandCoreId: command.coreId,
                commandCoreName: command.coreName,
                commandName: command.name,
                status: response.status
              });
            }
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
