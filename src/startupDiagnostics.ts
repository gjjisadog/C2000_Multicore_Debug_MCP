import process from "node:process";

export type StartupPhase = "load-config" | "create-server" | "connect-transport";

const phaseCodes: Record<StartupPhase, string> = {
  "load-config": "ConfigLoadFailed",
  "create-server": "ServerCreationFailed",
  "connect-transport": "TransportHandshakeFailed"
};

export function startupFailure(phase: StartupPhase, error: unknown) {
  const normalized = normalizeError(error);
  return {
    timestamp: new Date().toISOString(),
    level: "error",
    event: "c2000_mcp_startup_failed",
    phase,
    code: phaseCodes[phase],
    error: normalized,
    remediation: remediationFor(phase, normalized.message)
  };
}

export function startupReady(details: Record<string, unknown>) {
  return {
    timestamp: new Date().toISOString(),
    level: "info",
    event: "c2000_mcp_ready",
    ...details
  };
}

export function writeStartupDiagnostic(diagnostic: Record<string, unknown>) {
  if (process.env.C2000_MCP_STARTUP_DIAGNOSTICS === "quiet" && diagnostic.level !== "error") return;
  process.stderr.write(`${JSON.stringify(diagnostic)}\n`);
}

function normalizeError(error: unknown) {
  if (error instanceof Error) return { name: error.name, message: error.message, stack: error.stack };
  return { name: "Error", message: String(error) };
}

function remediationFor(phase: StartupPhase, message: string): string {
  if (/ERR_MODULE_NOT_FOUND|Cannot find module/i.test(message)) return "Run npm ci, npm run build, then npm run doctor.";
  if (phase === "load-config") return "Validate C2000_MCP_CONFIG and environment overrides, then run npm run doctor.";
  if (phase === "connect-transport") return "Verify the MCP command points to dist/src/index.js and that stdout is reserved for JSON-RPC.";
  return "Run npm run build and npm run doctor, then inspect this structured startup error.";
}
