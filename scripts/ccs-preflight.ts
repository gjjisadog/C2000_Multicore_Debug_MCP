import { runHardwarePreflight } from "../src/hardware/preflight.js";

const preflight = await runHardwarePreflight({ ccsInstallPath: process.env.C2000_MCP_CCS_INSTALL_PATH });
console.log(JSON.stringify(preflight, null, 2));
