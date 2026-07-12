import net from "node:net";
import { DebugMcpError, type DebugErrorCode } from "../utils/errors.js";

interface PendingRequest {
  resolve(value: Record<string, any>): void;
  reject(error: unknown): void;
  timer: NodeJS.Timeout;
}

export interface PersistentCoreChannelOptions {
  host: string;
  port: number;
  coreId: number;
  coreName: string;
  context?: () => Record<string, unknown>;
}

/** A request-correlated, reconnectable channel bound to one explicit DSS core. */
export class PersistentCoreChannel {
  private socket?: net.Socket;
  private connecting?: Promise<void>;
  private buffer = "";
  private requestId = 0;
  private readonly pending = new Map<number, PendingRequest>();
  private queue: Promise<unknown> = Promise.resolve();
  private closing = false;
  private connections = 0;

  constructor(private readonly options: PersistentCoreChannelOptions) {}

  get connectionCount(): number { return this.connections; }

  execute(command: Record<string, unknown>, timeoutMs: number): Promise<Record<string, any>> {
    if (this.closing) return Promise.reject(this.error("PersistentChannelDisconnected", "DSS channel is closing"));
    const operation = async () => this.executeWithReconnect(command, timeoutMs);
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => undefined);
    return result;
  }

  async close(): Promise<void> {
    this.closing = true;
    await this.queue.catch(() => undefined);
    this.destroy(this.error("PersistentChannelDisconnected", "DSS channel closed"));
  }

  private async executeWithReconnect(command: Record<string, unknown>, timeoutMs: number) {
    try {
      return await this.send(command, timeoutMs);
    } catch (firstError) {
      if (this.closing) throw firstError;
      this.destroy(firstError);
      try {
        return await this.send(command, timeoutMs);
      } catch (secondError) {
        throw this.error("PersistentChannelReconnectFailed", "DSS channel reconnect failed", {
          firstError: String(firstError), secondError: String(secondError)
        });
      }
    }
  }

  private async send(command: Record<string, unknown>, timeoutMs: number): Promise<Record<string, any>> {
    await this.connect();
    const requestId = ++this.requestId;
    const payload = { ...command, requestId, coreId: this.options.coreId, coreName: this.options.coreName };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(this.error("DssCommandTimeout", "Timed out waiting for DSS response", { requestId, timeoutMs, operation: command.name }));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      this.socket!.write(`${JSON.stringify(payload)}\n`, error => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error);
      });
    });
  }

  private async connect(): Promise<void> {
    if (this.socket && !this.socket.destroyed) return;
    if (this.connecting) return this.connecting;
    this.connecting = new Promise<void>((resolve, reject) => {
      const socket = net.createConnection({ host: this.options.host, port: this.options.port });
      const fail = (error: unknown) => { socket.destroy(); reject(error); };
      socket.once("error", fail);
      socket.once("connect", () => {
        socket.off("error", fail);
        this.socket = socket;
        this.connections++;
        socket.on("data", chunk => this.onData(chunk));
        socket.on("error", error => this.destroy(error));
        socket.on("close", () => this.destroy(this.error("PersistentChannelDisconnected", "DSS socket disconnected")));
        resolve();
      });
    }).finally(() => { this.connecting = undefined; });
    return this.connecting;
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    for (let index = this.buffer.indexOf("\n"); index >= 0; index = this.buffer.indexOf("\n")) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      try {
        const response = JSON.parse(line) as Record<string, any>;
        const requestId = response.requestId;
        const pending = typeof requestId === "number"
          ? this.pending.get(requestId)
          : this.pending.size === 1 ? this.pending.values().next().value as PendingRequest : undefined;
        if (!pending) continue;
        if (typeof requestId === "number") this.pending.delete(requestId);
        else this.pending.clear();
        clearTimeout(pending.timer);
        if (response.coreId !== undefined && (response.coreId !== this.options.coreId || response.coreName !== this.options.coreName)) {
          pending.reject(this.error("CoreIdentityMismatch", "Persistent channel response core identity mismatch", { response }));
        } else pending.resolve(response);
      } catch (error) {
        this.destroy(error);
      }
    }
  }

  private destroy(error: unknown): void {
    const socket = this.socket;
    this.socket = undefined;
    socket?.destroy();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private error(code: DebugErrorCode, message: string, details: Record<string, unknown> = {}) {
    return new DebugMcpError(code, message, { host: this.options.host, port: this.options.port, coreId: this.options.coreId, coreName: this.options.coreName, ...this.options.context?.(), ...details });
  }
}
