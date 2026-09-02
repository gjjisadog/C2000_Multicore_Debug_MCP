import { readFile } from "node:fs/promises";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CcsScriptingAdapter } from "./adapters/CcsScriptingAdapter.js";
import {
  resolveAdapterMode,
  resolveAdapterModeSync,
  type AdapterResolution,
  type ResolvedAdapterMode
} from "./adapters/adapterResolution.js";
import { MockDebugAdapter } from "./adapters/MockDebugAdapter.js";
import type { DebugAdapter } from "./adapters/types.js";
import type { C2000McpConfig } from "./config/config.schema.js";
import { DebugSessionManager } from "./debug/DebugSessionManager.js";
import { LoadedProgramRegistry } from "./debug/LoadedProgramRegistry.js";
import { DebugProbePoolCoordinator, FileDebugProbeCoordinator } from "./hardware/debugProbeCoordinator.js";
import { recoverDebugProbe, runHardwarePreflight, type HardwarePreflightResult } from "./hardware/preflight.js";
import type { StartupStageRunner } from "./debug/startupStageDiagnostics.js";
import {
  getToolExposureSummary,
  registerC2000Tools,
  type C2000ToolInvoker,
  type ToolProfile,
  type ToolSurfaceProfile
} from "./mcp/tools.js";
import { CapabilitySessionManager } from "./mcp/capabilities.js";
import type { ToolHandlerDeps } from "./mcp/toolHandlers.js";
import { buildServerHealth, SERVER_NAME, SERVER_VERSION } from "./runtimeInfo.js";
import { DebugMcpError } from "./utils/errors.js";
import { Logger } from "./utils/logger.js";
import { normalizeWorkspacePath } from "./utils/pathUtils.js";
import { withAdditionalReadRoots } from "./security/pathPolicy.js";
import { VerificationService } from "./verification/VerificationService.js";
import { InMemoryOutcomeEventStore } from "./analytics/OutcomeEventRepository.js";
import { OutcomeAnalyticsService } from "./analytics/OutcomeAnalyticsService.js";
import { InMemoryImprovementProposalStore } from "./improvement/ProposalRepository.js";
import { ImprovementProposalService } from "./improvement/ImprovementProposalService.js";

export type { AdapterResolution, ResolvedAdapterMode } from "./adapters/adapterResolution.js";
export { resolveAdapterMode, resolveAdapterModeSync } from "./adapters/adapterResolution.js";

export interface C2000McpRuntime {
  server: McpServer;
  manager: DebugSessionManager;
  toolInvoker: C2000ToolInvoker;
  /** The adapter selected after resolving config (never the literal `auto`). */
  adapterResolution: AdapterResolution;
  ownedProcesses(): Record<string, unknown>[];
  dispose(): Promise<Awaited<ReturnType<DebugSessionManager["disposeAllSessions"]>>>;
}

export async function createC2000McpRuntime(
  config: C2000McpConfig,
  toolHandlerDeps: ToolHandlerDeps = {},
  runtimeIdentity?: { boardId?: string; probeSerial?: string; workerInstanceId?: string; daemonInstanceId?: string }
): Promise<C2000McpRuntime> {
  const logger = new Logger(config.logging.level, config.logging.logFile);
  const adapterResolution = await resolveAdapterMode(config);
  logger.info("debug adapter selected", adapterResolution);
  return buildRuntime(config, adapterResolution, logger, toolHandlerDeps, runtimeIdentity);
}

/** Synchronous construction for tests/scripts that already know the adapter mode. */
export function createC2000McpRuntimeSync(
  config: C2000McpConfig,
  resolution?: AdapterResolution,
  toolHandlerDeps: ToolHandlerDeps = {}
): C2000McpRuntime {
  const logger = new Logger(config.logging.level, config.logging.logFile);
  const adapterResolution = resolution ?? resolveAdapterModeSync(config);
  logger.info("debug adapter selected", adapterResolution);
  return buildRuntime(config, adapterResolution, logger, toolHandlerDeps);
}

export async function createC2000McpServer(config: C2000McpConfig): Promise<McpServer> {
  return (await createC2000McpRuntime(config)).server;
}

export function createC2000McpServerSync(config: C2000McpConfig, resolution?: AdapterResolution): McpServer {
  return createC2000McpRuntimeSync(config, resolution).server;
}

function buildRuntime(
  config: C2000McpConfig,
  adapterResolution: AdapterResolution,
  logger: Logger,
  toolHandlerDeps: ToolHandlerDeps,
  runtimeIdentity?: { boardId?: string; probeSerial?: string; workerInstanceId?: string; daemonInstanceId?: string }
): C2000McpRuntime {
  const startedAt = new Date().toISOString();
  const toolProfile = (config.toolProfile ?? "safe") as ToolProfile;
  const toolSurfaceProfile = (config.toolSurfaceProfile ?? "agent") as ToolSurfaceProfile;
  const needsLocalAnalytics = !toolHandlerDeps.getWorkflowAnalytics
    || !toolHandlerDeps.getToolAnalytics
    || !toolHandlerDeps.getCapabilityAnalytics
    || !toolHandlerDeps.getEscalationRecommendations;
  const needsLocalProposals = !toolHandlerDeps.generateImprovementProposals
    || !toolHandlerDeps.listImprovementProposals
    || !toolHandlerDeps.getImprovementProposal
    || !toolHandlerDeps.reviewImprovementProposal
    || !toolHandlerDeps.exportImprovementImplementationPrompt;
  const localOutcomeEvents = needsLocalAnalytics || needsLocalProposals ? new InMemoryOutcomeEventStore() : undefined;
  let localAnalytics: OutcomeAnalyticsService | undefined;
  let localImprovementProposals: ImprovementProposalService | undefined;
  const capabilitySessions = new CapabilitySessionManager({
    logger,
    onAudit: event => (toolHandlerDeps.capabilityAudit ?? localAnalytics)?.recordCapabilityAudit(event)
  });
  if (needsLocalAnalytics) {
    localAnalytics = new OutcomeAnalyticsService({
      repository: localOutcomeEvents!,
      toolProfile,
      toolSurfaceProfile,
      activeCapabilities: () => capabilitySessions.activeCapabilities(),
      logger
    });
  }
  if (needsLocalProposals) {
    localImprovementProposals = new ImprovementProposalService({
      events: localOutcomeEvents ?? new InMemoryOutcomeEventStore(),
      proposals: new InMemoryImprovementProposalStore(),
      currentBaselineSha: () => process.env.C2000_MCP_BASELINE_SHA,
      logger
    });
  }
  let getExposureSummary = () => getToolExposureSummary(toolProfile, toolSurfaceProfile);
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { logging: {} } }
  );
  const effectiveInstallPath = adapterResolution.ccsInstallPath ?? config.ccs.installPath;
  const workspacePath = normalizeWorkspacePath(config.ccs.workspacePath);
  const isCcs = adapterResolution.mode === "ccs";
  // Some programmatic callers construct a config without passing through loadConfig.
  // Keep the server usable in that supported test/embedding path.
  const debugProbe = config.debugProbe ?? {
    queueDir: "runtime/debug-probe-queue",
    queueTimeoutMs: 600_000,
    startupPreparationMs: 90_000,
    recoveryPolicy: "owned-and-stale" as const,
    multiBoardEnabled: false
  };
  const enabledProbes = debugProbe.probes?.filter(probe => probe.enabled);
  const probeCoordinator = !isCcs
    ? undefined
    : debugProbe.multiBoardEnabled
      ? new DebugProbePoolCoordinator(debugProbe.queueDir, enabledProbes ?? [], debugProbe.queueTimeoutMs)
      : new FileDebugProbeCoordinator(debugProbe.queueDir, debugProbe.queueTimeoutMs);
  const tiEnvironment = {
    ccsInstallPath: effectiveInstallPath,
    c2000WarePath: config.ccs.c2000WarePath,
    ccxmlPath: config.ccs.ccxmlPath
  };
  const filesystem = withAdditionalReadRoots(config.filesystem ?? {
    allowedReadRoots: [process.cwd()],
    allowedWriteRoots: []
  }, {
    roots: [
      effectiveInstallPath,
      config.ccs.c2000WarePath,
      ...(config.programSearchRoots ?? []),
      ...(config.boards ?? []).map(board => path.dirname(board.ccxmlPath)),
      ...(debugProbe.probes ?? []).map(probe => path.dirname(probe.ccxmlPath))
    ],
    files: [config.ccs.ccxmlPath]
  });
  const getServerHealth = () => {
    const exposure = getExposureSummary();
    return buildServerHealth(config, startedAt, exposure.registered.map(tool => tool.name), {
      activeCapabilityCount: exposure.activeCapabilities.length,
      capabilityMode: "dynamic"
    });
  };
  const verificationRoot = path.join(
    config.filesystem?.allowedWriteRoots?.[0] ?? path.join(process.cwd(), "runtime"),
    "verification"
  );
  const verification = toolHandlerDeps.verification ?? new VerificationService({
    rootDirectory: verificationRoot,
    filesystem,
    config: config.verification
  });
  const adapter = createAdapterFromMode(adapterResolution.mode, config, effectiveInstallPath, workspacePath, runtimeIdentity);
  const manager = new DebugSessionManager(
    adapter,
    new LoadedProgramRegistry(),
    logger,
    {
      defaultCcxmlPath: config.ccs.ccxmlPath,
      defaultCoreMap: config.target.coreMap,
      defaultWorkspacePath: workspacePath,
      diagnostics: {
        cpu1BootExpressions: config.diagnostics?.cpu1BootExpressions,
        cpu2BootExpressions: config.diagnostics?.cpu2BootExpressions
      },
      probeCoordinator,
      prepareProbe: isCcs ? createProbePreparer(config, effectiveInstallPath) : undefined
    }
  );
  const registration = registerC2000Tools(
    server,
    manager,
    {
      ...toolHandlerDeps,
      verification,
      outcomeAnalytics: localAnalytics ?? toolHandlerDeps.outcomeAnalytics,
      getWorkflowAnalytics: toolHandlerDeps.getWorkflowAnalytics ?? (input => localAnalytics!.getWorkflowAnalytics(input)),
      getToolAnalytics: toolHandlerDeps.getToolAnalytics ?? (input => localAnalytics!.getToolAnalytics(input)),
      getCapabilityAnalytics: toolHandlerDeps.getCapabilityAnalytics ?? (input => localAnalytics!.getCapabilityAnalytics(input)),
      getEscalationRecommendations: toolHandlerDeps.getEscalationRecommendations ?? (input => localAnalytics!.getEscalationRecommendations(input)),
      generateImprovementProposals: toolHandlerDeps.generateImprovementProposals ?? (input => localImprovementProposals!.generate(input)),
      listImprovementProposals: toolHandlerDeps.listImprovementProposals ?? (input => localImprovementProposals!.list(input)),
      getImprovementProposal: toolHandlerDeps.getImprovementProposal ?? (input => localImprovementProposals!.get(input.proposalId)),
      reviewImprovementProposal: toolHandlerDeps.reviewImprovementProposal ?? (input => localImprovementProposals!.review(input)),
      exportImprovementImplementationPrompt: toolHandlerDeps.exportImprovementImplementationPrompt ?? (input => localImprovementProposals!.exportImplementationPrompt(input.proposalId)),
      effectiveAdapterType: adapterResolution.mode,
      filesystem,
      programSearchRoots: toolHandlerDeps.programSearchRoots ?? config.programSearchRoots
    },
    toolProfile,
    filesystem,
    tiEnvironment,
    { getServerHealth },
    toolSurfaceProfile,
    { capabilitySessions, logger }
  );
  const toolInvoker = registration.invoker;
  getExposureSummary = registration.getExposureSummary;

  let disposal: Promise<Awaited<ReturnType<DebugSessionManager["disposeAllSessions"]>>> | undefined;
  return {
    server,
    manager,
    toolInvoker,
    adapterResolution,
    ownedProcesses: () => adapter.ownedProcesses?.() ?? [],
    dispose: () => (disposal ??= (async () => {
      registration.dispose();
      return manager.disposeAllSessions();
    })())
  };
}

function createProbePreparer(config: C2000McpConfig, ccsInstallPath?: string) {
  const recoveryPolicy = config.debugProbe?.recoveryPolicy ?? "owned-and-stale";
  return async (
    lease?: { probe?: { probeId: string; serialNumber: string; ccxmlPath: string } },
    context?: { runStage: StartupStageRunner }
  ) => {
    const runStage = context?.runStage ?? (async <T>(_stage: string, work: () => Promise<T>) => work());
    let initialPreflight: HardwarePreflightResult | undefined;
    if (lease?.probe) {
      initialPreflight = await runStage("probe-preflight", () => runHardwarePreflight({ ccsInstallPath }));
      const detectedSerials = initialPreflight.xdsdfu.devices
        ?.map(device => device.serialNumber)
        .filter((serial): serial is string => Boolean(serial)) ?? [];
      if (!detectedSerials.includes(lease.probe.serialNumber)) {
        throw new DebugMcpError("ProbeIdentityMismatch", `Configured XDS110 is not connected: ${lease.probe.probeId}`, {
          expectedSerialNumber: lease.probe.serialNumber,
          detectedSerialNumbers: detectedSerials
        });
      }
      const ccxml = await readFile(lease.probe.ccxmlPath, "utf8");
      if (!ccxml.includes(lease.probe.serialNumber)) {
        throw new DebugMcpError("ProbeIdentityMismatch", "The board ccxml is not bound to its configured XDS110 serial number", {
          probeId: lease.probe.probeId,
          serialNumber: lease.probe.serialNumber,
          ccxmlPath: lease.probe.ccxmlPath
        });
      }
    }
    const recovery = await runStage("probe-recovery", () => recoverDebugProbe({
      ccsInstallPath,
      policy: recoveryPolicy,
      targetCcxmlPath: lease?.probe?.ccxmlPath,
      initialPreflight
    }));
    if (!recovery.recovered) {
      throw new DebugMcpError("ProbeRecoveryBlocked", "XDS110 recovery blocked by an existing debug owner", {
        policy: recovery.policy,
        remainingOwners: recovery.remainingOwners
      });
    }
    return recovery;
  };
}

function createAdapterFromMode(
  mode: ResolvedAdapterMode,
  config: C2000McpConfig,
  ccsInstallPath?: string,
  workspacePath?: string,
  runtimeIdentity?: { boardId?: string; probeSerial?: string; workerInstanceId?: string; daemonInstanceId?: string }
): DebugAdapter {
  if (mode === "ccs") {
    return new CcsScriptingAdapter({
      ccsInstallPath: ccsInstallPath ?? config.ccs.installPath,
      workspacePath: workspacePath ?? normalizeWorkspacePath(config.ccs.workspacePath),
      dssTimeoutMs: config.ccs.dssTimeoutMs,
      timeouts: config.ccs.timeouts,
      ownership: runtimeIdentity
    });
  }
  return new MockDebugAdapter();
}
