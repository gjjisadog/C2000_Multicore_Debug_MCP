import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { C2000McpConfig } from "../config/config.schema.js";
import { DebugMcpError } from "../utils/errors.js";

export interface LabPowerCycleRequest {
  device: "lab_power";
  off_seconds: number;
  mode: "auto" | "manual" | "auto_or_manual";
  reason: "after_flash" | "connection_recovery";
}

export interface LabPowerCycleClient {
  powercycle(request: LabPowerCycleRequest): Promise<Record<string, unknown>>;
}

/** Calls only the fixed powercycle tool on the configured local stdio MCP. */
export class BleLabPowerMcpClient implements LabPowerCycleClient {
  constructor(private readonly config: NonNullable<C2000McpConfig["powerCycle"]>["bleLabPowerMcp"]) {}

  async powercycle(request: LabPowerCycleRequest): Promise<Record<string, unknown>> {
    if (!this.config) throw new DebugMcpError("PowerCycleUnavailable", "ble-lab-power MCP is not configured");
    const transport = new StdioClientTransport({
      command: this.config.command,
      args: this.config.args,
      ...(this.config.cwd ? { cwd: this.config.cwd } : {})
    });
    const client = new Client({ name: "c2000-multicore-power-cycle", version: "1.0.0" });
    try {
      await client.connect(transport);
      const response = await client.callTool({ name: "powercycle", arguments: { ...request } });
      if (response.isError) throw new DebugMcpError("PowerCycleMcpFailed", "ble-lab-power MCP reported an error", { response: response.content });
      const structured = object(response.structuredContent);
      const payload = structured.status ? structured : object(structured.result);
      if (payload.status) return payload;
      const blocks = Array.isArray(response.content) ? response.content : [];
      const text = blocks.find(item => object(item).type === "text" && typeof object(item).text === "string");
      if (text && typeof object(text).text === "string") {
        try {
          const parsed = object(JSON.parse(object(text).text as string));
          const unwrapped = parsed.status ? parsed : object(parsed.result);
          if (unwrapped.status) return unwrapped;
        } catch {
          // A non-JSON MCP response cannot prove either OFF or ON.
        }
      }
      throw new DebugMcpError("PowerCycleMcpInvalid", "ble-lab-power MCP returned no recognizable powercycle status");
    } finally {
      await client.close().catch(() => undefined);
    }
  }
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
