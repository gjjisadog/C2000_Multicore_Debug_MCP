#!/usr/bin/env node
/**
 * Transparent stdio MCP supervisor.
 *
 * It restarts an unexpectedly terminated child MCP server, replays the
 * initialize handshake, and then resumes forwarding requests. Diagnostic
 * output is written only to stderr so stdout remains an MCP JSON-RPC stream.
 */
import { spawn } from "node:child_process";
import { readFile, access } from "node:fs/promises";
import path from "node:path";

const defaults = {
  initialDelayMs: 500,
  maxDelayMs: 10_000,
  maxRestarts: 5,
  restartWindowMs: 60_000,
  pointerPollMs: 1000,
  currentPointer: undefined
};

function fail(message) {
  process.stderr.write(`[c2000-mcp-supervisor] ${message}\n`);
  process.exitCode = 64;
}

function parsePositiveInteger(name, value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer; received ${JSON.stringify(value)}`);
  }
  return parsed;
}

function parseArguments(argv) {
  const separator = argv.indexOf("--");
  if (separator === -1 || separator === argv.length - 1) {
    throw new Error("usage: node scripts/mcp-supervisor.mjs [options] -- <command> [args...]");
  }

  const options = { ...defaults };
  for (let index = 0; index < separator; index += 1) {
    const option = argv[index];
    const value = argv[index + 1];
    if (!option.startsWith("--") || value === undefined) {
      throw new Error(`invalid supervisor option ${JSON.stringify(option)}`);
    }
    index += 1;
    switch (option) {
      case "--initial-delay-ms":
        options.initialDelayMs = parsePositiveInteger(option, value);
        break;
      case "--max-delay-ms":
        options.maxDelayMs = parsePositiveInteger(option, value);
        break;
      case "--max-restarts":
        options.maxRestarts = parsePositiveInteger(option, value);
        break;
      case "--restart-window-ms":
        options.restartWindowMs = parsePositiveInteger(option, value);
        break;
      case "--pointer-poll-ms":
        options.pointerPollMs = parsePositiveInteger(option, value);
        break;
      case "--current-pointer":
        options.currentPointer = path.resolve(value);
        break;
      default:
        throw new Error(`unknown supervisor option ${JSON.stringify(option)}`);
    }
  }
  if (options.maxDelayMs < options.initialDelayMs) {
    throw new Error("--max-delay-ms must be greater than or equal to --initial-delay-ms");
  }
  if (options.currentPointer && options.pointerPollMs < 100) {
    throw new Error("--pointer-poll-ms must be at least 100 when --current-pointer is used");
  }
  return { options, command: argv.slice(separator + 1) };
}

function sameJsonRpcId(left, right) {
  return (typeof left === "string" || typeof left === "number" || left === null)
    && left === right;
}

class McpSupervisor {
  constructor(command, options) {
    this.command = command;
    this.options = options;
    this.child = undefined;
    this.stopping = false;
    this.replayingInitialization = false;
    this.awaitingReplayInitialized = false;
    this.initializeRequest = undefined;
    this.initializeId = undefined;
    this.initializeResponseDelivered = false;
    this.initializedNotification = undefined;
    this.pendingClientLines = [];
    this.restartTimes = [];
    this.childOutputBuffer = "";
    this.clientInputBuffer = "";
    this.inFlight = new Map();
    this.toolCatalog = undefined;
    this.catalogRequestId = undefined;
    this.pendingCommand = undefined;
    this.previousCommand = undefined;
    this.switching = false;
    this.verifyingSwitch = false;
    this.rejectedPointerKey = undefined;
    this.activeCommandKey = JSON.stringify(command);
    this.pointerReadInProgress = false;
    this.internalRequestSequence = 0;
  }

  log(message) {
    process.stderr.write(`[c2000-mcp-supervisor] ${message}\n`);
  }

  start() {
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => this.receiveClientChunk(chunk));
    process.stdin.once("end", () => this.stop("stdin closed", 0));
    process.stdin.once("error", error => this.stop(`stdin error: ${error.message}`, 1));
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
      process.once(signal, () => this.stop(signal, signal === "SIGINT" ? 130 : signal === "SIGHUP" ? 129 : 143));
    }
    this.launchChild();
    if (this.options.currentPointer) {
      const poll = setInterval(() => { void this.checkCurrentPointer(); }, this.options.pointerPollMs);
      poll.unref();
      void this.checkCurrentPointer();
    }
  }

  receiveClientChunk(chunk) {
    this.clientInputBuffer += chunk;
    let newlineIndex;
    while ((newlineIndex = this.clientInputBuffer.indexOf("\n")) !== -1) {
      const line = this.clientInputBuffer.slice(0, newlineIndex + 1);
      this.clientInputBuffer = this.clientInputBuffer.slice(newlineIndex + 1);
      this.receiveClientLine(line);
    }
  }

  receiveClientLine(line) {
    const message = this.parseMessage(line);
    if (message?.method === "initialize" && Object.hasOwn(message, "id")) {
      this.initializeRequest = line;
      this.initializeId = message.id;
    } else if (message?.method === "notifications/initialized") {
      this.initializedNotification = line;
      if (this.awaitingReplayInitialized) {
        this.awaitingReplayInitialized = false;
        this.forwardToChild(line);
        this.requestToolCatalog();
        this.flushClientQueue();
        return;
      }
    }

    if (this.switching || this.verifyingSwitch || this.replayingInitialization || this.awaitingReplayInitialized || !this.child?.stdin.writable) {
      this.pendingClientLines.push(line);
      return;
    }
    this.forwardToChild(line);
    if (message?.method === "notifications/initialized") this.requestToolCatalog();
  }

  parseMessage(line) {
    try {
      return JSON.parse(line);
    } catch {
      return undefined;
    }
  }

  forwardToChild(line) {
    if (!this.child?.stdin.writable) {
      this.pendingClientLines.push(line);
      return;
    }
    const message = this.parseMessage(line);
    if (message?.method && Object.hasOwn(message, "id") && message.method !== "initialize") {
      this.inFlight.set(JSON.stringify(message.id), message.method);
    }
    this.child.stdin.write(line);
  }

  launchChild() {
    if (this.stopping) return;
    const [file, ...args] = this.command;
    this.childOutputBuffer = "";
    const replay = this.initializeResponseDelivered && this.initializeRequest !== undefined;
    const resumeInitialHandshake = !this.initializeResponseDelivered && this.initializeRequest !== undefined;
    this.replayingInitialization = replay;
    this.awaitingReplayInitialized = false;
    const child = spawn(file, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["pipe", "pipe", "inherit"],
      windowsHide: true
    });
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => this.receiveChildChunk(chunk));
    child.once("error", error => this.log(`child spawn error: ${error.message}`));
    child.once("close", (code, signal) => this.handleChildClose(code, signal));

    if (replay) {
      this.log("child restarted; replaying MCP initialize handshake");
      this.forwardToChild(this.initializeRequest);
    } else if (resumeInitialHandshake) {
      this.log("child restarted before MCP initialize completed; resuming handshake");
      this.forwardToChild(this.initializeRequest);
    } else {
      this.flushClientQueue();
    }
  }

  receiveChildChunk(chunk) {
    this.childOutputBuffer += chunk;
    let newlineIndex;
    while ((newlineIndex = this.childOutputBuffer.indexOf("\n")) !== -1) {
      const line = this.childOutputBuffer.slice(0, newlineIndex + 1);
      this.childOutputBuffer = this.childOutputBuffer.slice(newlineIndex + 1);
      this.receiveChildLine(line);
    }
  }

  receiveChildLine(line) {
    const message = this.parseMessage(line);
    const isInitializeResponse = message
      && Object.hasOwn(message, "id")
      && sameJsonRpcId(message.id, this.initializeId);

    if (this.replayingInitialization) {
      if (!isInitializeResponse) return;
      this.replayingInitialization = false;
      if (this.initializedNotification) {
        this.forwardToChild(this.initializedNotification);
        this.requestToolCatalog();
        this.flushClientQueue();
      } else {
        this.awaitingReplayInitialized = true;
      }
      return;
    }

    if (isInitializeResponse) this.initializeResponseDelivered = true;
    if (message && Object.hasOwn(message, "id") && sameJsonRpcId(message.id, this.catalogRequestId)) {
      this.catalogRequestId = undefined;
      if (Array.isArray(message.result?.tools)) {
        if (this.verifyingSwitch) {
          this.completeSwitch(message.result.tools);
        } else {
          this.toolCatalog = canonicalJson(message.result.tools);
          this.maybeSwitch();
        }
      } else if (this.verifyingSwitch) {
        this.rejectSwitch("new runtime did not return a tool catalog");
      }
      return;
    }
    if (this.verifyingSwitch) return;
    if (message && Object.hasOwn(message, "id")) {
      const method = this.inFlight.get(JSON.stringify(message.id));
      this.inFlight.delete(JSON.stringify(message.id));
      if (method === "tools/list" && Array.isArray(message.result?.tools)) {
        this.toolCatalog = canonicalJson(message.result.tools);
      }
    }
    if (message?.method === "notifications/tools/list_changed") {
      this.toolCatalog = undefined;
      this.requestToolCatalog();
    }
    process.stdout.write(line);
    this.maybeSwitch();
  }

  flushClientQueue() {
    if (!this.child?.stdin.writable || this.switching || this.verifyingSwitch || this.replayingInitialization || this.awaitingReplayInitialized) return;
    const queued = this.pendingClientLines;
    this.pendingClientLines = [];
    for (const line of queued) this.forwardToChild(line);
  }

  requestToolCatalog() {
    if (!this.options.currentPointer || !this.initializedNotification || !this.child?.stdin.writable || this.catalogRequestId !== undefined) return;
    this.catalogRequestId = `c2000-supervisor-tools-${process.pid}-${++this.internalRequestSequence}`;
    this.child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0", id: this.catalogRequestId, method: "tools/list", params: {}
    })}\n`);
  }

  async checkCurrentPointer() {
    if (this.stopping || this.pointerReadInProgress) return;
    this.pointerReadInProgress = true;
    try {
      const pointer = JSON.parse(await readFile(this.options.currentPointer, "utf8"));
      const versionsRoot = path.resolve(path.dirname(this.options.currentPointer), "versions");
      const installDirectory = path.resolve(pointer.installDirectory);
      const entrypoint = path.resolve(pointer.entrypoint);
      const runtimeExecutable = path.resolve(pointer.runtimeExecutable);
      if (!isWithin(installDirectory, versionsRoot)
        || !isWithin(entrypoint, path.join(installDirectory, "dist", "src"))
        || ![".js", ".mjs"].includes(path.extname(entrypoint).toLowerCase())) {
        throw new Error("current.json contains a runtime path outside its immutable version slot");
      }
      await Promise.all([access(entrypoint), access(runtimeExecutable)]);
      const command = [runtimeExecutable, entrypoint];
      const key = JSON.stringify(command);
      if (key === this.activeCommandKey || key === this.rejectedPointerKey) return;
      this.pendingCommand = command;
      this.pendingCommandKey = key;
      this.maybeSwitch();
    } catch (error) {
      // An install may be publishing a pointer, or this supervisor may have
      // started before the first installation. Keep the current child alive.
      if (this.lastPointerError !== String(error)) {
        this.lastPointerError = String(error);
        this.log(`current pointer unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      this.pointerReadInProgress = false;
    }
  }

  maybeSwitch() {
    if (!this.pendingCommand || this.switching || this.verifyingSwitch || this.stopping
      || this.inFlight.size > 0 || !this.initializeResponseDelivered || !this.initializedNotification) return;
    if (this.toolCatalog === undefined) {
      this.requestToolCatalog();
      return;
    }
    this.previousCommand = this.command;
    this.switchCommand = this.pendingCommand;
    this.switchTargetKey = this.pendingCommandKey;
    this.switching = true;
    this.log("current.json changed; draining MCP requests before runtime switch");
    this.child?.stdin.end();
    this.switchKillTimer = setTimeout(() => this.child?.kill(), 5000);
    this.switchKillTimer.unref();
  }

  completeSwitch(tools) {
    if (canonicalJson(tools) !== this.toolCatalog) {
      this.rejectSwitch("tool catalog changed; a new Codex session is required to discover the new tools");
      return;
    }
    this.command = this.switchCommand;
    this.activeCommandKey = this.switchTargetKey;
    this.previousCommand = undefined;
    this.pendingCommand = undefined;
    this.verifyingSwitch = false;
    clearTimeout(this.switchStartupTimer);
    this.log("runtime switched with the existing MCP tool catalog");
    this.flushClientQueue();
  }

  rejectSwitch(reason) {
    this.log(`runtime switch rejected: ${reason}; restoring previous runtime`);
    this.rejectedPointerKey = this.switchTargetKey;
    this.pendingCommand = undefined;
    this.verifyingSwitch = false;
    clearTimeout(this.switchStartupTimer);
    this.switching = true;
    this.child?.stdin.end();
    this.switchKillTimer = setTimeout(() => this.child?.kill(), 5000);
    this.switchKillTimer.unref();
  }

  handleChildClose(code, signal) {
    this.child = undefined;
    this.catalogRequestId = undefined;
    if (this.stopping) {
      this.finish();
      return;
    }
    if (this.switching) {
      clearTimeout(this.switchKillTimer);
      this.switching = false;
      if (this.previousCommand && this.rejectedPointerKey === this.switchTargetKey) {
        this.command = this.previousCommand;
        this.previousCommand = undefined;
        this.verifyingSwitch = false;
      } else {
        this.command = this.switchCommand;
        this.verifyingSwitch = true;
      }
      this.launchChild();
      if (this.verifyingSwitch) {
        this.switchStartupTimer = setTimeout(() => {
          this.log("new runtime did not complete MCP startup within 30 seconds; restoring previous runtime");
          this.child?.kill();
        }, 30_000);
        this.switchStartupTimer.unref();
      }
      return;
    }
    if (this.verifyingSwitch) {
      clearTimeout(this.switchStartupTimer);
      this.log("runtime switch rejected: new runtime exited before its tool catalog was verified; restoring previous runtime");
      this.rejectedPointerKey = this.switchTargetKey;
      this.pendingCommand = undefined;
      this.verifyingSwitch = false;
      this.command = this.previousCommand;
      this.previousCommand = undefined;
      this.launchChild();
      return;
    }
    for (const [id] of this.inFlight) {
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(id), error: {
        code: -32000,
        message: "MCP runtime stopped; request outcome is unknown and was not retried"
      } })}\n`);
    }
    this.inFlight.clear();
    if (code === 0 && signal === null) {
      this.log("child exited cleanly; supervisor is stopping");
      process.exitCode = 0;
      this.finish();
      return;
    }

    const now = Date.now();
    this.restartTimes = this.restartTimes.filter(time => now - time <= this.options.restartWindowMs);
    if (this.restartTimes.length >= this.options.maxRestarts) {
      this.log(`restart limit reached after child exit (code=${code ?? "null"}, signal=${signal ?? "none"})`);
      process.exitCode = code && code !== 0 ? code : 1;
      this.finish();
      return;
    }

    const attempt = this.restartTimes.length + 1;
    const delay = Math.min(this.options.initialDelayMs * 2 ** (attempt - 1), this.options.maxDelayMs);
    this.restartTimes.push(now);
    this.log(`child exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "none"}); restart ${attempt}/${this.options.maxRestarts} in ${delay}ms`);
    setTimeout(() => this.launchChild(), delay).unref();
  }

  stop(reason, exitCode) {
    if (this.stopping) return;
    this.stopping = true;
    this.log(`stopping: ${reason}`);
    process.exitCode = exitCode;
    if (this.child && !this.child.killed) {
      this.child.kill();
      return;
    }
    this.finish();
  }

  finish() {
    if (this.childOutputBuffer.length > 0 && !this.replayingInitialization) {
      process.stdout.write(this.childOutputBuffer);
    }
    process.exit(process.exitCode ?? 0);
  }
}

function isWithin(child, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

try {
  const { options, command } = parseArguments(process.argv.slice(2));
  new McpSupervisor(command, options).start();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
