import { c2000McpConfigSchema } from "../config/config.schema.js";
import { DebugMcpError, toStructuredError } from "../utils/errors.js";
import { BoardWorkerRuntime, type BoardWorkerLaunchOptions } from "./BoardWorkerRuntime.js";

type WorkerMessage = {
  type?: string;
  token?: string;
  requestId?: string;
  options?: BoardWorkerLaunchOptions;
  config?: unknown;
  toolName?: string;
  arguments?: unknown;
};

/** Authenticated IPC boundary inside the worker process. */
export class WorkerRpcServer {
  private runtime?: BoardWorkerRuntime;
  private heartbeatTimer?: NodeJS.Timeout;
  private token?: string;

  start(): void {
    process.on("message", message => { void this.handle(message as WorkerMessage); });
    process.once("disconnect", () => { void this.stop(); });
  }

  private async handle(message: WorkerMessage): Promise<void> {
    try {
      if (message.type === "initialize") {
        await this.initialize(message);
        return;
      }
      this.assertAuthenticated(message);
      if (message.type === "invoke") {
        if (!message.requestId || !message.toolName) throw new DebugMcpError("DaemonProtocolError", "Invalid worker invoke request");
        const result = await this.runtime!.invoke(message.requestId, message.toolName, message.arguments);
        this.send({ type: "result", requestId: message.requestId, result });
        return;
      }
      if (message.type === "health") {
        this.send({ type: "heartbeat", heartbeat: this.runtime!.heartbeat() });
        return;
      }
      if (message.type === "shutdown") {
        await this.stop();
        this.send({ type: "stopped" });
        process.disconnect();
        return;
      }
      throw new DebugMcpError("DaemonProtocolError", `Unsupported worker message: ${message.type ?? "unknown"}`);
    } catch (error) {
      this.send({ type: "error", requestId: message.requestId, error: toStructuredError(error) });
    }
  }

  private async initialize(message: WorkerMessage): Promise<void> {
    if (this.runtime || !message.options || !message.token) {
      throw new DebugMcpError("DaemonProtocolError", "Worker initialization is invalid or duplicated");
    }
    this.token = message.token;
    const config = c2000McpConfigSchema.parse(message.config);
    this.runtime = new BoardWorkerRuntime(message.options, config);
    await this.runtime.start();
    this.heartbeatTimer = setInterval(() => this.send({ type: "heartbeat", heartbeat: this.runtime?.heartbeat() }), 1000);
    this.heartbeatTimer.unref();
    this.send({
      type: "ready",
      workerInstanceId: message.options.workerInstanceId,
      configuredAdapterMode: config.adapter,
      configuredScriptingMode: config.ccs.scriptingMode,
      effectiveAdapterType: this.runtime.effectiveAdapterType
    });
  }

  private assertAuthenticated(message: WorkerMessage): void {
    if (!this.runtime || !this.token || message.token !== this.token) {
      throw new DebugMcpError("DaemonAuthenticationFailed", "Board worker authentication failed");
    }
  }

  private async stop(): Promise<void> {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    await this.runtime?.stop();
    this.runtime = undefined;
  }

  private send(message: Record<string, unknown>): void {
    if (process.connected) process.send?.(message);
  }
}
