import { z } from "zod";
import { LocalRpcServer } from "../rpc/RpcServer.js";
import type { C2000ToolInvoker } from "../mcp/tools.js";
import { DebugMcpError } from "../utils/errors.js";

const invokeToolParamsSchema = z.object({
  requestId: z.string().uuid(),
  toolName: z.string().min(1),
  arguments: z.unknown()
});

export class DaemonRpcServer {
  private readonly server: LocalRpcServer;

  constructor(options: {
    authToken: string;
    port: number;
    toolInvoker: C2000ToolInvoker;
    health: () => Record<string, unknown>;
  }) {
    this.server = new LocalRpcServer({
      host: "127.0.0.1",
      port: options.port,
      authToken: options.authToken,
      handle: async (method, params) => {
        if (method === "health") {
          return options.health();
        }
        if (method === "invokeTool") {
          const request = invokeToolParamsSchema.parse(params);
          const result = await options.toolInvoker.invokeTool(request.toolName, request.arguments);
          return { requestId: request.requestId, result };
        }
        throw new DebugMcpError("DaemonProtocolError", `Unsupported daemon RPC method: ${method}`);
      }
    });
  }

  listen(): Promise<{ host: "127.0.0.1"; port: number }> {
    return this.server.listen();
  }

  close(): Promise<void> {
    return this.server.close();
  }
}
