import type { C2000McpConfig } from "../config/config.schema.js";
import { existsSync } from "node:fs";
import { resolveCcsInstallPath, resolveCcsInstallPathSync, type CcsInstallResolution } from "./ccsInstallPath.js";
import { DebugMcpError } from "../utils/errors.js";

export type ResolvedAdapterMode = "ccs" | "mock";

export interface AdapterResolution {
  mode: ResolvedAdapterMode;
  requested: C2000McpConfig["adapter"] | C2000McpConfig["ccs"]["scriptingMode"];
  reason: string;
  ccsInstallPath?: string;
  ccsInstallSource?: string;
}

export async function resolveAdapterMode(config: C2000McpConfig): Promise<AdapterResolution> {
  const requested = config.adapter === "auto" ? config.ccs.scriptingMode : config.adapter;
  if (requested === "mock") {
    return { mode: "mock", requested, reason: "explicit mock adapter selection" };
  }
  return selectAdapter(requested, await resolveCcsInstallPath({ installPath: config.ccs.installPath }));
}

export function resolveAdapterModeSync(config: C2000McpConfig): AdapterResolution {
  const requested = config.adapter === "auto" ? config.ccs.scriptingMode : config.adapter;
  if (requested === "mock") {
    return { mode: "mock", requested, reason: "explicit mock adapter selection" };
  }
  return selectAdapter(requested, resolveCcsInstallPathSync({ installPath: config.ccs.installPath }));
}

function selectAdapter(requested: "auto" | "ccs", install: CcsInstallResolution): AdapterResolution {
  if (install.dssLauncherPath && existsSync(install.dssLauncherPath)) {
    return {
      mode: "ccs",
      requested,
      reason: requested === "ccs" ? "explicit ccs adapter selection" : `auto: DSS launcher found (${install.reason})`,
      ccsInstallPath: install.installPath,
      ccsInstallSource: install.source
    };
  }
  if (install.source === "explicit" || install.source === "env") {
    throw new DebugMcpError(
      "DssNotFound",
      `DSS launcher not found at ${install.dssLauncherPath}. Set ccs.installPath or C2000_MCP_CCS_INSTALL_PATH to the CCS directory containing ccs_base.`,
      { ccsInstallPath: install.installPath, dssLauncherPath: install.dssLauncherPath }
    );
  }
  if (requested === "ccs") {
    return { mode: "ccs", requested, reason: install.reason, ccsInstallSource: install.source };
  }
  return {
    mode: "mock",
    requested,
    reason: `auto: DSS launcher not found (${install.reason}); falling back to mock adapter`,
    ccsInstallSource: install.source
  };
}
