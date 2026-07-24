import { c2000McpConfigSchema } from "../config/config.schema.js";
import { DebugMcpError, toStructuredError } from "../utils/errors.js";
import { CanWorkerRuntime, type CanWorkerLaunchOptions } from "./CanWorkerRuntime.js";
import type { CanChannelLeaseContext } from "../can/CanChannelLeaseManager.js";

interface Message {
  type?: string;
  token?: string;
  requestId?: string;
  options?: CanWorkerLaunchOptions;
  config?: unknown;
  method?: string;
  argument?: unknown;
  leaseContext?: CanChannelLeaseContext;
}

export class CanWorkerRpcServer {
  private runtime?: CanWorkerRuntime;
  private token?: string;
  private heartbeatTimer?: NodeJS.Timeout;

  start(): void {
    process.on("message", message => { void this.handle(message as Message); });
    process.once("disconnect", () => { void this.stop(); });
  }

  private async handle(message: Message): Promise<void> {
    try {
      if (message.type === "initialize") {
        if (this.runtime || !message.options || !message.token) throw new DebugMcpError("DaemonProtocolError", "Invalid CAN worker initialization");
        this.token = message.token;
        this.runtime = new CanWorkerRuntime(message.options, c2000McpConfigSchema.parse(message.config));
        await this.runtime.start();
        this.heartbeatTimer = setInterval(() => this.send({ type: "heartbeat", heartbeat: this.runtime?.heartbeat() }), 1000);
        this.heartbeatTimer.unref();
        this.send({ type: "ready", canWorkerInstanceId: message.options.canWorkerInstanceId });
        return;
      }
      if (!this.runtime || message.token !== this.token) throw new DebugMcpError("DaemonAuthenticationFailed", "CAN worker authentication failed");
      if (message.type === "invoke" && message.requestId && message.method) {
        const result = await this.runtime.invoke(message.method, message.argument, message.leaseContext);
        this.send({ type: "result", requestId: message.requestId, result });
        return;
      }
      if (message.type === "shutdown") {
        await this.stop();
        this.send({ type: "stopped" });
        process.disconnect();
        return;
      }
      throw new DebugMcpError("DaemonProtocolError", `Unsupported CAN worker message: ${message.type}`);
    } catch (error) {
      this.send({ type: "error", requestId: message.requestId, error: toStructuredError(error) });
    }
  }

  private async stop(): Promise<void> {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    await this.runtime?.stop();
    this.runtime = undefined;
  }
  private send(message: Record<string, unknown>): void { if (process.connected) process.send?.(message); }
}
