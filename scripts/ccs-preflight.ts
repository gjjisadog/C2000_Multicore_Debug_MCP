import { runHardwarePreflight } from "../src/hardware/preflight.js";
import { requireHardwareOptIn, requireSupportedHardwareRuntime } from "./hardware-opt-in.js";

requireHardwareOptIn({ operation: "acceptance:preflight" });
requireSupportedHardwareRuntime("acceptance:preflight");
const preflight = await runHardwarePreflight({ ccsInstallPath: process.env.C2000_MCP_CCS_INSTALL_PATH });
console.log(JSON.stringify(preflight, null, 2));
