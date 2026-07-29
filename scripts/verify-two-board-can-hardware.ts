import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { requireHardwareOptIn, requireSupportedHardwareRuntime } from "./hardware-opt-in.js";

/**
 * Hardware-safe preflight only. It validates the two-board configuration and
 * deliberately performs no debug target, power-stage, PWM, contactor, or CAN
 * traffic action. A real adapter/operator must submit an explicit job later.
 */
async function main(): Promise<void> {
  requireHardwareOptIn({ operation: "acceptance:can:hardware", pcan: true, twoBoard: true });
  requireSupportedHardwareRuntime("acceptance:can:hardware");
  const configPath = process.env.C2000_MCP_CONFIG;
  if (!configPath) throw new Error("C2000_MCP_CONFIG must point to a two-board daemon config");
  const resolved = path.resolve(configPath);
  await access(resolved);
  const config = JSON.parse(await readFile(resolved, "utf8")) as { boards?: Array<{ boardId?: string; probeSerial?: string; device?: string; ccxmlPath?: string }> };
  const boards = config.boards ?? [];
  if (boards.length !== 2) throw new Error(`Expected exactly two configured boards; found ${boards.length}`);
  if (new Set(boards.map(board => board.boardId)).size !== 2 || new Set(boards.map(board => board.probeSerial)).size !== 2) throw new Error("Both boardId and probeSerial must be unique");
  if (boards.some(board => board.device !== "F28P65x" || !board.ccxmlPath)) throw new Error("Both boards require device F28P65x and explicit ccxmlPath");
  console.log(JSON.stringify({
    success: true,
    mode: "HARDWARE_PREFLIGHT_ONLY",
    configPath: resolved,
    boards: boards.map(board => ({ boardId: board.boardId, probeSerial: board.probeSerial, ccxmlPath: board.ccxmlPath })),
    safety: {
      powerControlPerformed: false,
      pwmTripModified: false,
      contactorModified: false,
      canTrafficTransmitted: false,
      nextStep: "Configure a real independent CAN adapter and submit an explicit hardware job; do not report this preflight as acceptance."
    }
  }, null, 2));
}

main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
