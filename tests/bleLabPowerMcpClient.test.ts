import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { BleLabPowerMcpClient } from "../src/power/BleLabPowerMcpClient.js";

describe("ble-lab-power MCP client", () => {
  test("calls the fixed powercycle tool over stdio and reads its structured status", async () => {
    const fixture = fileURLToPath(new URL("./fixtures/mockLabPowerMcp.mjs", import.meta.url));
    const client = new BleLabPowerMcpClient({
      command: process.execPath,
      args: [fixture],
      cwd: path.dirname(path.dirname(fixture))
    });
    const result = await client.powercycle({
      device: "lab_power", off_seconds: 5, mode: "auto_or_manual", reason: "after_flash"
    });
    expect(result).toMatchObject({
      device: "lab_power", status: "completed", trigger: "after_flash",
      off_hold_seconds: 5, protocol_verified: true, physical_state: null
    });
  });
});
