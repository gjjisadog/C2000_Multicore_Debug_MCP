import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CcsScriptingAdapter } from "./adapters/CcsScriptingAdapter.js";
import { MockDebugAdapter } from "./adapters/MockDebugAdapter.js";
import type { DebugAdapter } from "./adapters/types.js";
import type { C2000McpConfig } from "./config/config.schema.js";
import { DebugSessionManager } from "./debug/DebugSessionManager.js";
import { LoadedProgramRegistry } from "./debug/LoadedProgramRegistry.js";
import { definitionsForProfile, registerC2000Tools } from "./mcp/tools.js";
import { Logger } from "./utils/logger.js";
import { DebugProbePoolCoordinator, FileDebugProbeCoordinator } from "./hardware/debugProbeCoordinator.js";
import { recoverDebugProbe } from "./hardware/preflight.js";
import { runHardwarePreflight } from "./hardware/preflight.js";
import { readFile } from "node:fs/promises";
import { DebugMcpError } from "./utils/errors.js";
import { buildServerHealth, SERVER_NAME, SERVER_VERSION } from "./runtimeInfo.js";

export function createC2000McpServer(config: C2000McpConfig): McpServer {
  const startedAt = new Date().toISOString();
  const registeredToolNames = definitionsForProfile(config.toolProfile).map(tool => tool.name);
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { logging: {} } }
  );
  const logger = new Logger(config.logging.level, config.logging.logFile);
  const isCcs = (config.adapter === "auto" ? config.ccs.scriptingMode : config.adapter) === "ccs";
  const enabledProbes = config.debugProbe.probes?.filter(probe => probe.enabled);
  const probeCoordinator = !isCcs ? undefined : config.debugProbe.multiBoardEnabled
    ? new DebugProbePoolCoordinator(config.debugProbe.queueDir, enabledProbes ?? [], config.debugProbe.queueTimeoutMs)
    : new FileDebugProbeCoordinator(config.debugProbe.queueDir, config.debugProbe.queueTimeoutMs);
  const manager = new DebugSessionManager(
    createAdapter(config),
    new LoadedProgramRegistry(),
    logger,
    probeCoordinator,
    isCcs ? async lease => {
      if (lease?.probe) {
        const preflight = await runHardwarePreflight({ ccsInstallPath: config.ccs.installPath });
        const detectedSerials = preflight.xdsdfu.devices?.map(device => device.serialNumber).filter((serial): serial is string => Boolean(serial)) ?? [];
        if (!detectedSerials.includes(lease.probe.serialNumber)) {
          throw new DebugMcpError("ProbeIdentityMismatch", `Configured XDS110 is not connected: ${lease.probe.probeId}`, { expectedSerialNumber: lease.probe.serialNumber, detectedSerialNumbers: detectedSerials });
        }
        const ccxml = await readFile(lease.probe.ccxmlPath, "utf8");
        if (!ccxml.includes(lease.probe.serialNumber)) {
          throw new DebugMcpError("ProbeIdentityMismatch", `The board ccxml is not bound to its configured XDS110 serial number`, { probeId: lease.probe.probeId, serialNumber: lease.probe.serialNumber, ccxmlPath: lease.probe.ccxmlPath });
        }
      }
      const recovery = await recoverDebugProbe({ ccsInstallPath: config.ccs.installPath, policy: config.debugProbe.recoveryPolicy, targetCcxmlPath: lease?.probe?.ccxmlPath });
      if (!recovery.recovered) throw new Error(`XDS110 recovery blocked: ${JSON.stringify(recovery.remainingOwners)}`);
      return recovery;
    } : undefined
  );
  registerC2000Tools(server, manager, config.toolProfile, config.filesystem, {
    ccsInstallPath: config.ccs.installPath,
    c2000WarePath: config.ccs.c2000WarePath,
    ccxmlPath: config.ccs.ccxmlPath
  }, {
    getServerHealth: () => buildServerHealth(config, startedAt, registeredToolNames)
  });
  return server;
}

function createAdapter(config: C2000McpConfig): DebugAdapter {
  const adapterMode = config.adapter === "auto" ? config.ccs.scriptingMode : config.adapter;
  if (adapterMode === "ccs") {
    return new CcsScriptingAdapter({
      ccsInstallPath: config.ccs.installPath,
      workspacePath: config.ccs.workspacePath,
      dssTimeoutMs: config.ccs.dssTimeoutMs,
      timeouts: config.ccs.timeouts
    });
  }
  return new MockDebugAdapter();
}
