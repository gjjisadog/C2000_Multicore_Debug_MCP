import { z } from "zod";

export const daemonRpcMethodSchema = z.enum(["health", "invokeTool", "shutdown"]);
export type DaemonRpcMethod = z.infer<typeof daemonRpcMethodSchema>;

export const rpcRequestSchema = z.object({
  type: z.literal("request"),
  id: z.string().uuid(),
  method: daemonRpcMethodSchema,
  authToken: z.string().min(1),
  params: z.unknown()
});

export type RpcRequest = z.infer<typeof rpcRequestSchema>;

export interface RpcSuccessResponse {
  type: "response";
  id: string;
  ok: true;
  result: unknown;
}

export interface RpcFailureResponse {
  type: "response";
  id: string;
  ok: false;
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

export type RpcResponse = RpcSuccessResponse | RpcFailureResponse;

export function stringifyRpcMessage(message: RpcRequest | RpcResponse): string {
  return `${JSON.stringify(message)}\n`;
}
