import { randomUUID, timingSafeEqual } from "node:crypto";
import net from "node:net";
import { DebugMcpError, toStructuredError } from "../utils/errors.js";
import { rpcRequestSchema, stringifyRpcMessage, type DaemonRpcMethod, type RpcFailureResponse, type RpcRequest, type RpcResponse } from "./RpcProtocol.js";

export interface LocalRpcServerOptions {
  host: "127.0.0.1";
  port: number;
  authToken: string;
  handle(method: DaemonRpcMethod, params: unknown, request: RpcRequest): Promise<unknown>;
}

/**
 * Small newline-delimited local RPC server. It intentionally never listens on
 * a public interface and authenticates every request, including health checks.
 */
export class LocalRpcServer {
  private readonly sockets = new Set<net.Socket>();
  private server?: net.Server;

  constructor(private readonly options: LocalRpcServerOptions) {}

  async listen(): Promise<{ host: "127.0.0.1"; port: number }> {
    if (this.server) {
      const address = this.server.address();
      if (address && typeof address !== "string") {
        return { host: "127.0.0.1", port: address.port };
      }
      throw new DebugMcpError("DaemonProtocolError", "Local RPC server is already listening without a TCP address");
    }
    const server = net.createServer(socket => this.attach(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen({ host: this.options.host, port: this.options.port, exclusive: true });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      await this.close();
      throw new DebugMcpError("DaemonProtocolError", "Local RPC server did not receive a TCP address");
    }
    return { host: "127.0.0.1", port: address.port };
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) {
      socket.destroy();
    }
    this.sockets.clear();
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
  }

  private attach(socket: net.Socket): void {
    this.sockets.add(socket);
    socket.setEncoding("utf8");
    socket.setNoDelay(true);
    let buffer = "";
    socket.on("data", chunk => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim()) {
          void this.handleLine(socket, line);
        }
      }
    });
    socket.once("close", () => this.sockets.delete(socket));
    socket.once("error", () => undefined);
  }

  private async handleLine(socket: net.Socket, line: string): Promise<void> {
    let requestId: string = randomUUID();
    let response: RpcResponse;
    try {
      const request = rpcRequestSchema.parse(JSON.parse(line));
      requestId = request.id;
      if (!tokensMatch(this.options.authToken, request.authToken)) {
        throw new DebugMcpError("DaemonAuthenticationFailed", "Local daemon authentication failed");
      }
      response = {
        type: "response",
        id: request.id,
        ok: true,
        result: await this.options.handle(request.method, request.params, request)
      };
    } catch (error) {
      response = failureResponse(requestId, error);
    }
    if (!socket.destroyed) {
      socket.write(stringifyRpcMessage(response));
    }
  }
}

export class LocalRpcClient {
  constructor(
    private readonly options: { host: "127.0.0.1"; port: number; authToken: string; timeoutMs?: number }
  ) {}

  async request(method: DaemonRpcMethod, params: unknown): Promise<unknown> {
    const id = randomUUID();
    const timeoutMs = this.options.timeoutMs ?? 5000;
    return new Promise<unknown>((resolve, reject) => {
      const socket = net.createConnection({ host: this.options.host, port: this.options.port });
      let buffer = "";
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        callback();
      };
      socket.setEncoding("utf8");
      socket.setNoDelay(true);
      socket.setTimeout(timeoutMs, () => finish(() => reject(new DebugMcpError(
        "DaemonUnavailable",
        `Timed out connecting to c2000-debugd after ${timeoutMs}ms`,
        { host: this.options.host, port: this.options.port }
      ))));
      socket.once("error", error => finish(() => reject(new DebugMcpError(
        "DaemonUnavailable",
        `Unable to connect to c2000-debugd: ${error.message}`,
        { host: this.options.host, port: this.options.port }
      ))));
      socket.on("data", chunk => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const line = buffer.slice(0, newline);
        try {
          const response = JSON.parse(line) as RpcResponse;
          if (response.type !== "response" || response.id !== id || typeof response.ok !== "boolean") {
            throw new DebugMcpError("DaemonProtocolError", "Received an invalid local daemon RPC response");
          }
          if (!response.ok) {
            throw new DebugMcpError(response.error.code as DebugMcpError["code"], response.error.message, response.error.details);
          }
          finish(() => resolve(response.result));
        } catch (error) {
          finish(() => reject(error));
        }
      });
      socket.once("connect", () => {
        socket.write(stringifyRpcMessage({
          type: "request",
          id,
          method,
          authToken: this.options.authToken,
          params
        }));
      });
    });
  }
}

function failureResponse(id: string, error: unknown): RpcFailureResponse {
  return { type: "response", id, ok: false, error: toStructuredError(error) };
}

function tokensMatch(expected: string, actual: string): boolean {
  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(actual, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}
