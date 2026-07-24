import { randomBytes, randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import type { C2000McpConfig } from "../config/config.schema.js";
import type { CanAdapterInfo, CanAdapterSession, CanAdapterState, CanAdapterStatistics, CanBusAdapter, CanCapture, CanCaptureFilter, CanFrame } from "../can/CanBusAdapter.js";
import type { CanFaultScenario } from "../can/CanProfileSchema.js";
import type { CanChannelLeaseContext } from "../can/CanChannelLeaseManager.js";
import { DebugMcpError } from "../utils/errors.js";
import { runtimeEntrypointCandidates } from "../runtimePaths.js";

interface Pending { resolve(value: any): void; reject(error: unknown): void; timer: NodeJS.Timeout; }

/** Daemon-side proxy. Native PCAN/Koffi code is loaded only by its child process. */
export class CanWorkerProcess implements CanBusAdapter {
  readonly kind = "hardware" as const;
  readonly name: string;
  readonly independentBusVerification = true;
  private child?: ChildProcess;
  private readonly pending = new Map<string, Pending>();
  private readonly token = randomBytes(32).toString("base64url");
  private readonly canWorkerInstanceId = `can-worker-${randomUUID()}`;
  private readonly processStartTime = new Date().toISOString();
  private leaseContext?: CanChannelLeaseContext;
  private cachedCaptures: CanCapture[] = [];

  constructor(private readonly config: C2000McpConfig, private readonly daemonInstanceId: string, private readonly adapterIndex = 0) {
    const adapter = config.canAdapters?.[adapterIndex];
    this.name = adapter?.adapterId ?? "unconfigured-can-worker";
  }

  info(): CanAdapterInfo {
    const adapter = this.config.canAdapters?.[this.adapterIndex];
    return { name: this.name, independentBusVerification: true, availability: adapter ? "available" : "unavailable", transport: "hardware", channel: adapter?.channel, bitrate: adapter?.bitrate, reason: "PCAN native access isolated in c2000-can-worker" };
  }
  session(): CanAdapterSession | undefined { return undefined; }
  state(): CanAdapterState { return { opened: Boolean(this.leaseContext), captureActive: Boolean(this.leaseContext), offlineBoardIds: [], captureCount: this.cachedCaptures.length }; }
  async open(input: { jobId: string; boardIds: string[]; faults: CanFaultScenario[] }): Promise<void> { await this.openSession(input); }
  async openSession(input: { jobId: string; boardIds: string[]; faults: CanFaultScenario[] }): Promise<CanAdapterSession> {
    await this.start();
    const result = await this.call("openSession", input);
    this.leaseContext = result.leaseContext;
    return result.value;
  }
  async send(input: { sourceBoardId: string; targetBoardId: string; frame: CanFrame }): Promise<CanCapture> { return (await this.call("send", input)).value; }
  async receive(input: { sourceBoardId: string; targetBoardId: string; timeoutMs: number }): Promise<CanFrame | undefined> { return (await this.call("receive", input)).value; }
  async startCapture(input?: { filter?: CanCaptureFilter; signal?: AbortSignal }): Promise<{ captureId: string; startedAt: string }> {
    input?.signal?.throwIfAborted();
    return (await this.call("startCapture", { filter: input?.filter })).value;
  }
  async stopCapture(): Promise<{ stoppedAt: string; captures: CanCapture[] }> {
    const value = (await this.call("stopCapture", undefined)).value;
    this.cachedCaptures = value.captures;
    return value;
  }
  async receiveFrames(filter?: CanCaptureFilter): Promise<CanCapture[]> {
    const value = (await this.call("receiveFrames", filter)).value;
    this.cachedCaptures = value;
    return value;
  }
  async waitForFrame(input: { filter: CanCaptureFilter; timeoutMs: number; signal?: AbortSignal }): Promise<CanCapture | undefined> {
    input.signal?.throwIfAborted();
    const request = this.call("waitForFrame", { filter: input.filter, timeoutMs: input.timeoutMs }, input.timeoutMs + 1000).then(result => result.value);
    return input.signal ? raceAbort(request, input.signal) : request;
  }
  async getStatistics(): Promise<CanAdapterStatistics> { return (await this.call("getStatistics", undefined)).value; }
  captures(): CanCapture[] { return this.cachedCaptures.map(item => ({ ...item, direction: { ...item.direction }, frame: { ...item.frame, data: [...item.frame.data] } })); }
  capture(): CanCapture[] { return this.captures(); }
  async close(): Promise<void> {
    if (this.child && this.leaseContext) await this.call("close", undefined).catch(() => undefined);
    this.leaseContext = undefined;
    await this.stopChild();
  }

  private async start(): Promise<void> {
    if (this.child) return;
    const command = await resolveCommand();
    const child = spawn(command.command, command.args, { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true, env: process.env });
    this.child = child;
    child.stderr?.on("data", chunk => process.stderr.write(`[c2000-can-worker] ${String(chunk)}`));
    child.on("message", message => this.onMessage(message));
    child.once("exit", (code, signal) => {
      this.child = undefined;
      this.leaseContext = undefined;
      this.rejectAll(new DebugMcpError("WorkerUnavailable", "CAN worker exited; capture is interrupted and cannot be resumed", { code, signal, canWorkerInstanceId: this.canWorkerInstanceId }));
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new DebugMcpError("WorkerHeartbeatTimeout", "CAN worker did not report ready")), 15000);
      const ready = (message: unknown) => {
        if (!isRecord(message) || message.type !== "ready" || message.canWorkerInstanceId !== this.canWorkerInstanceId) return;
        clearTimeout(timer);
        child.off("message", ready);
        resolve();
      };
      child.on("message", ready);
      child.send({ type: "initialize", token: this.token, options: { canWorkerInstanceId: this.canWorkerInstanceId, daemonInstanceId: this.daemonInstanceId, authToken: this.token, processStartTime: this.processStartTime, adapterIndex: this.adapterIndex }, config: this.config });
    });
  }

  private call(method: string, argument: unknown, timeoutMs = 15000): Promise<any> {
    if (!this.child?.connected) return Promise.reject(new DebugMcpError("WorkerUnavailable", "CAN worker IPC channel is unavailable"));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new DebugMcpError("WorkerCommandTimeout", `CAN worker command timed out: ${method}`, { requestId, timeoutMs })); }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      this.child!.send({ type: "invoke", token: this.token, requestId, method, argument, leaseContext: this.leaseContext });
    });
  }
  private onMessage(message: unknown): void {
    if (!isRecord(message) || typeof message.requestId !== "string") return;
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    this.pending.delete(message.requestId);
    clearTimeout(pending.timer);
    if (message.type === "result") pending.resolve(message.result);
    else {
      const error = isRecord(message.error) ? message.error : {};
      pending.reject(new DebugMcpError(String(error.code ?? "DaemonProtocolError") as DebugMcpError["code"], String(error.message ?? "CAN worker error"), isRecord(error.details) ? error.details : {}));
    }
  }
  private rejectAll(error: unknown): void { for (const [id, pending] of this.pending) { clearTimeout(pending.timer); pending.reject(error); this.pending.delete(id); } }
  private async stopChild(): Promise<void> {
    const child = this.child;
    if (!child) return;
    if (child.connected) child.send({ type: "shutdown", token: this.token });
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); resolve(); }, 5000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
    this.child = undefined;
  }
}

async function resolveCommand(): Promise<{ command: string; args: string[] }> {
  const entries = runtimeEntrypointCandidates("can-worker", import.meta.url);
  for (const file of entries.compiled) if (await exists(file)) return { command: process.execPath, args: [file] };
  for (const file of entries.source) if (await exists(file)) return { command: process.execPath, args: [createRequire(import.meta.url).resolve("tsx/cli"), file] };
  throw new DebugMcpError("WorkerEntrypointNotFound", "Unable to locate c2000-can-worker", { entries });
}
async function exists(file: string): Promise<boolean> { try { await access(file); return true; } catch { return false; } }
function isRecord(value: unknown): value is Record<string, any> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function raceAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason ?? new DOMException("Operation aborted", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
    void operation.then(value => {
      signal.removeEventListener("abort", abort);
      resolve(value);
    }, error => {
      signal.removeEventListener("abort", abort);
      reject(error);
    });
  });
}
