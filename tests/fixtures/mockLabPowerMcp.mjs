import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "mock-ble-lab-power", version: "1.0.0" });
server.registerTool("powercycle", {
  description: "Host-only protocol fixture; never touches BLE hardware.",
  inputSchema: {
    device: z.literal("lab_power"),
    off_seconds: z.number(),
    mode: z.enum(["auto", "manual", "auto_or_manual"]),
    reason: z.enum(["after_flash", "connection_recovery"])
  }
}, async input => ({
  content: [{
    type: "text",
    text: JSON.stringify({
      device: input.device,
      status: "completed",
      trigger: input.reason,
      mode_used: "auto",
      off_hold_seconds: input.off_seconds,
      protocol_verified: true,
      physical_state: null
    })
  }]
}));

await server.connect(new StdioServerTransport());
