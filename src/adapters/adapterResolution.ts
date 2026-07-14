import type { C2000McpConfig } from "../config/config.schema.js";
import { isCcsDssAvailable } from "./CcsScriptingBridge.js";
import { resolveCcsInstallPath, resolveCcsInstallPathSync } from "./ccsInstallPath.js";

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
  if (requested === "ccs") {
    const install = await resolveCcsInstallPath({ installPath: config.ccs.installPath });
    return {
      mode: "ccs",
      requested,
      reason: "explicit ccs adapter selection",
      ccsInstallPath: install.installPath,
      ccsInstallSource: install.source
    };
  }
  if (requested === "mock") {
    return { mode: "mock", requested, reason: "explicit mock adapter selection" };
  }
  const install = await resolveCcsInstallPath({ installPath: config.ccs.installPath });
  const available = await isCcsDssAvailable(install.installPath);
  if (available) {
    return {
      mode: "ccs",
      requested,
      reason: `auto: DSS launcher found (${install.reason})`,
      ccsInstallPath: install.installPath,
      ccsInstallSource: install.source
    };
  }
  return {
    mode: "mock",
    requested,
    reason: `auto: DSS launcher not found (${install.reason}); falling back to mock adapter`,
    ccsInstallPath: install.installPath,
    ccsInstallSource: install.source
  };
}

export function resolveAdapterModeSync(config: C2000McpConfig): AdapterResolution {
  const requested = config.adapter === "auto" ? config.ccs.scriptingMode : config.adapter;
  const install = resolveCcsInstallPathSync({ installPath: config.ccs.installPath });
  if (requested === "ccs") {
    return {
      mode: "ccs",
      requested,
      reason: "explicit ccs adapter selection",
      ccsInstallPath: install.installPath,
      ccsInstallSource: install.source
    };
  }
  if (requested === "mock") {
    return {
      mode: "mock",
      requested,
      reason: "explicit mock adapter selection",
      ccsInstallPath: install.installPath,
      ccsInstallSource: install.source
    };
  }
  return {
    mode: "mock",
    requested,
    reason: "auto: synchronous construction without DSS probe; defaulting to mock (use async server bootstrap for auto detect)",
    ccsInstallPath: install.installPath,
    ccsInstallSource: install.source
  };
}
