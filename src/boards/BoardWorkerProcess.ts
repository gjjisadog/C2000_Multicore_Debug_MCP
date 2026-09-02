import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import type { BoardWorkerLaunchOptions } from "../worker/BoardWorkerRuntime.js";
import type { WorkerHeartbeat } from "../worker/WorkerHeartbeat.js";
import { DebugMcpError } from "../utils/errors.js";
import type { BoardWorkerClient } from "./BoardWorkerClient.js";
import { runtimeEntrypointCandidates } from "../runtimePaths.js";

interface PendingRequest {
  resolve(value: Record<string, unknown>): void;
  reject(reason: unknown): void;
  timer: NodeJS.Timeout;
}

/** Parent-side owner of a directly spawned worker process. */
export class BoardWorkerProcess implements BoardWorkerClient {
  readonly processStartTime = new Date().toISOString();
  readonly workerInstanceId: string;
  readonly boardId: string;
  readonly probeSerial: string;
  readonly pid?: number;
  effectiveAdapterType?: "ccs" | "mock";
  lastHeartbeatAt?: number;
  onHeartbeat?: (heartbeat: WorkerHeartbeat) => void;
  private child?: ChildProcess;
  private readonly pending = new Map<string, PendingRequest>();

  constructor(
    private readonly options: BoardWorkerLaunchOptions,
    private readonly config: unknown
  ) {
    this.workerInstanceId = options.workerInstanceId;
    this.boardId = options.boardId;
    this.probeSerial = options.probeSerial;
  }

  async start(): Promise<void> {
    if (this.child) return;
    const { command, args } = await resolveWorkerCommand();
    const child = spawn(command, args, {
      // Preserve caller-relative configuration while locating the worker from
      // the installed runtime, not from this working directory.
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      windowsHide: true,
      env: process.env
    });
    this.child = child;
    Object.defineProperty(this, "pid", { value: child.pid, configurable: false });
    child.stdout?.on("data", chunk => process.stderr.write(`[c2000-board-worker:${this.boardId}] ${String(chunk)}`));
    child.stderr?.on("data", chunk => process.stderr.write(`[c2000-board-worker:${this.boardId}] ${String(chunk)}`));
    child.on("message", message => this.onMessage(message));
    child.once("exit", (code, signal) => this.onExit(code, signal));
    child.once("error", error => this.rejectAll(error));
    await new Promise<void>((resolve, reject) => {
      const readyTimer = setTimeout(() => reject(new DebugMcpError("WorkerHeartbeatTimeout", "Board worker did not report ready", { boardId: this.boardId })), 15000);
      const onReady = (message: unknown) => {
        if (!isMessage(message) || message.type !== "ready" || message.workerInstanceId !== this.workerInstanceId) return;
        if (message.effectiveAdapterType === "ccs" || message.effectiveAdapterType === "mock") {
          this.effectiveAdapterType = message.effectiveAdapterType;
        }
        clearTimeout(readyTimer);
        child.off("message", onReady);
        resolve();
      };
      child.on("message", onReady);
      this.send({ type: "initialize", token: this.options.authToken, options: this.options, config: this.config });
      child.once("error", error => {
        clearTimeout(readyTimer);
        child.off("message", onReady);
        reject(error);
      });
    });
  }

  invokeTool(toolName: string, input: unknown, timeoutMs: number): Promise<Record<string, unknown>> {
    const requestId = randomUUID();
    const startedAtMs = Date.now();
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new DebugMcpError("WorkerCommandTimeout", `Board worker command timed out: ${toolName}`, {
          boardId: this.boardId,
          workerInstanceId: this.workerInstanceId,
          requestId,
          toolName,
          timeoutMs,
          elapsedMs: Math.max(0, Date.now() - startedAtMs),
          timeoutLayer: "outer-worker-command",
          lastHeartbeatAt: this.lastHeartbeatAt ? new Date(this.lastHeartbeatAt).toISOString() : undefined,
          innerStage: "unknown"
        }));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      this.send({ type: "invoke", token: this.options.authToken, requestId, toolName, arguments: input });
    });
  }

  async stop(timeoutMs = 10000): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill();
        resolve();
      }, timeoutMs);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      this.send({ type: "shutdown", token: this.options.authToken });
    });
  }

  private send(message: Record<string, unknown>): void {
    if (!this.child?.connected) throw new DebugMcpError("WorkerHeartbeatTimeout", "Board worker IPC channel is unavailable", { boardId: this.boardId });
    this.child.send(message);
  }

  private onMessage(message: unknown): void {
    if (!isMessage(message)) return;
    if (message.type === "heartbeat" && isHeartbeat(message.heartbeat)) {
      this.lastHeartbeatAt = Date.now();
      this.onHeartbeat?.(message.heartbeat);
      return;
    }
    const requestId = typeof message.requestId === "string" ? message.requestId : undefined;
    if (!requestId) return;
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    clearTimeout(pending.timer);
    if (message.type === "result" && isRecord(message.result)) {
      pending.resolve(message.result);
      return;
    }
    const error = isRecord(message.error) ? message.error : { code: "DaemonProtocolError", message: "Board worker returned an invalid error" };
    pending.reject(new DebugMcpError(String(error.code) as DebugMcpError["code"], String(error.message), isRecord(error.details) ? error.details : {}));
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.rejectAll(new DebugMcpError("WorkerHeartbeatTimeout", "Board worker exited", { boardId: this.boardId, workerInstanceId: this.workerInstanceId, code, signal }));
  }

  private rejectAll(error: unknown): void {
    for (const [requestId, pending] of this.pending) {
      this.pending.delete(requestId);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }
}

async function resolveWorkerCommand(): Promise<{ command: string; args: string[] }> {
  const entries = runtimeEntrypointCandidates("worker", import.meta.url);
  for (const compiled of entries.compiled) {
    if (await exists(compiled)) return { command: process.execPath, args: [compiled] };
  }
  for (const source of entries.source) {
    if (await exists(source)) {
      try {
        return { command: process.execPath, args: [resolveTsxCli(), source] };
      } catch (error) {
        throw new DebugMcpError("WorkerEntrypointNotFound", "The source board worker entrypoint requires the tsx development dependency", {
          cause: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }
  throw new DebugMcpError("WorkerEntrypointNotFound", "Unable to locate the c2000 board worker runtime entrypoint", {
    compiledCandidates: entries.compiled,
    sourceCandidates: entries.source,
    packageRoots: entries.packageRoots
  });
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function resolveTsxCli(): string {
  let lastError: unknown;
  const requireCandidates = [
    ...(typeof import.meta.url === "string" ? [createRequire(import.meta.url)] : []),
    createRequire(path.resolve(process.argv[1] ?? process.execPath))
  ];
  for (const requireFromRuntime of requireCandidates) {
    try {
      return requireFromRuntime.resolve("tsx/cli");
    } catch (error) {
      lastError = error;
    }
  }
  throw new DebugMcpError("WorkerEntrypointNotFound", "The source board worker entrypoint requires the tsx development dependency", {
    cause: lastError instanceof Error ? lastError.message : String(lastError)
  });
}

function isMessage(value: unknown): value is Record<string, unknown> { return isRecord(value); }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function isHeartbeat(value: unknown): value is WorkerHeartbeat {
  return isRecord(value) && typeof value.workerInstanceId === "string" && typeof value.boardId === "string" && typeof value.probeSerial === "string" && typeof value.timestamp === "string";
}
