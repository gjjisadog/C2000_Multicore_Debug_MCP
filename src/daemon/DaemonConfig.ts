import path from "node:path";
import type { C2000McpConfig } from "../config/config.schema.js";

export interface ResolvedDaemonConfig {
  enabled: boolean;
  host: "127.0.0.1";
  port: number;
  runtimeDir: string;
  autoStart: boolean;
  startupTimeoutMs: number;
}

export function resolveDaemonConfig(config: C2000McpConfig): ResolvedDaemonConfig {
  const daemon = config.daemon;
  return {
    enabled: daemon?.enabled ?? true,
    host: "127.0.0.1",
    port: daemon?.port ?? 0,
    runtimeDir: path.resolve(daemon?.runtimeDir ?? "./runtime"),
    autoStart: daemon?.autoStart ?? true,
    startupTimeoutMs: daemon?.startupTimeoutMs ?? 15000
  };
}
