#!/usr/bin/env node
/**
 * Transparent stdio MCP supervisor.
 *
 * It restarts an unexpectedly terminated child MCP server, replays the
 * initialize handshake, and then resumes forwarding requests. Diagnostic
 * output is written only to stderr so stdout remains an MCP JSON-RPC stream.
 */
import { spawn } from "node:child_process";

const defaults = {
  initialDelayMs: 500,
  maxDelayMs: 10_000,
  maxRestarts: 5,
  restartWindowMs: 60_000
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
      default:
        throw new Error(`unknown supervisor option ${JSON.stringify(option)}`);
    }
  }
  if (options.maxDelayMs < options.initialDelayMs) {
    throw new Error("--max-delay-ms must be greater than or equal to --initial-delay-ms");
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
        this.flushClientQueue();
        return;
      }
    }

    if (this.replayingInitialization || this.awaitingReplayInitialized || !this.child?.stdin.writable) {
      this.pendingClientLines.push(line);
      return;
    }
    this.forwardToChild(line);
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
        this.flushClientQueue();
      } else {
        this.awaitingReplayInitialized = true;
      }
      return;
    }

    if (isInitializeResponse) this.initializeResponseDelivered = true;
    process.stdout.write(line);
  }

  flushClientQueue() {
    if (!this.child?.stdin.writable || this.replayingInitialization || this.awaitingReplayInitialized) return;
    const queued = this.pendingClientLines;
    this.pendingClientLines = [];
    for (const line of queued) this.forwardToChild(line);
  }

  handleChildClose(code, signal) {
    this.child = undefined;
    if (this.stopping) {
      this.finish();
      return;
    }
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

try {
  const { options, command } = parseArguments(process.argv.slice(2));
  new McpSupervisor(command, options).start();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
