import { randomUUID } from "node:crypto";
import type { C2000ToolInvoker } from "../mcp/tools.js";
import { c2000ToolDefinitions } from "../mcp/tools.js";
import type { LocalRpcClient } from "../rpc/RpcServer.js";
import { DebugMcpError } from "../utils/errors.js";

/** MCP-facing adapter that validates locally, then forwards to the daemon. */
export class McpDaemonClient implements C2000ToolInvoker {
  constructor(private readonly client: LocalRpcClient) {}

  async invokeTool(toolName: string, input: unknown): Promise<Record<string, unknown>> {
    const definition = c2000ToolDefinitions.find(candidate => candidate.name === toolName);
    if (!definition) {
      throw new DebugMcpError("ToolNotFound", `Unknown C2000 tool: ${toolName}`, { toolName });
    }
    const parsedInput = definition.schema.parse(input);
    const response = await this.client.request("invokeTool", {
      requestId: randomUUID(),
      toolName,
      arguments: parsedInput
    });
    if (!response || typeof response !== "object" || Array.isArray(response)) {
      throw new DebugMcpError("DaemonProtocolError", "c2000-debugd returned a malformed tool response", { toolName });
    }
    const result = (response as { result?: unknown }).result;
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      throw new DebugMcpError("DaemonProtocolError", "c2000-debugd returned no structured tool result", { toolName });
    }
    return result as Record<string, unknown>;
  }

  async close(): Promise<void> {
    // LocalRpcClient is request-scoped; proxy shutdown never alters daemon state.
  }
}
