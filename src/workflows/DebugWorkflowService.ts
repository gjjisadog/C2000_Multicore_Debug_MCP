import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { z } from "zod";
import type { DebugSessionManager } from "../debug/DebugSessionManager.js";
import type { CoreId, EvaluateResult, LoadedProgramInfo, ResetType } from "../debug/types.js";
import { analyzeRamOwnership as analyzeRamOwnershipDefault, type MapOwnershipInput, type RamOwnershipAnalysis } from "../hardware/mapOwnership.js";
import { fileMetadata } from "../utils/fileHash.js";
import type {
  expressionConditionSchema,
  expressionReadSetSchema,
  launchAndRunIpcAcceptanceSchema,
  runBootHandoffDiagnosisSchema,
  runFullDebugBundleSchema,
  runIpcAcceptanceSchema,
  runReloadAndDiagnoseSchema
} from "../mcp/toolSchemas.js";
import { DebugMcpError, toStructuredError } from "../utils/errors.js";

type ToolResult = Record<string, any>;
type ExpressionCondition = z.infer<typeof expressionConditionSchema>;
type ExpressionReadSet = z.infer<typeof expressionReadSetSchema>;

export class DebugWorkflowService {
  constructor(
    private readonly manager: DebugSessionManager,
    private readonly analyzeRamOwnership: typeof analyzeRamOwnershipDefault = analyzeRamOwnershipDefault
  ) {}

  async launchAndRunIpcAcceptance(input: z.infer<typeof launchAndRunIpcAcceptanceSchema>): Promise<ToolResult> {
    const sessionName = input.sessionName ?? "launch-and-run-ipc-acceptance";
    const coreIds = [input.cpu1CoreId, input.cpu2CoreId];
    let sessionId: string | undefined;

    try {
      const created = await this.manager.createDebugSession({
        sessionName,
        ccxmlPath: input.ccxmlPath,
        probeId: input.probeId,
        preferredProbeIds: input.preferredProbeIds,
        allowAutoProbeAllocation: input.allowAutoProbeAllocation,
        coreMap: [
          { coreId: input.cpu1CoreId, coreName: input.cpu1CoreName, corePattern: input.cpu1CorePattern },
          { coreId: input.cpu2CoreId, coreName: input.cpu2CoreName, corePattern: input.cpu2CorePattern }
        ]
      });
      sessionId = created.sessionId;
      const connected = await this.manager.connectCores(sessionId, coreIds);
      const acceptance = await this.runIpcAcceptance({
        ...input,
        sessionId
      });

      return {
        ...acceptance,
        workflow: "c2000_launchAndRunIpcAcceptance",
        orchestration: "server-internal",
        mcpToolCalls: [],
        approvalClass: "workflow-confirmation",
        launch: {
          sessionName,
          ...(input.ccxmlPath ? { ccxmlPath: input.ccxmlPath } : {}),
          coreMap: created.cores.map(core => ({
            coreId: core.coreId,
            coreName: core.coreName,
            corePattern: core.corePattern
          })),
          connectedCoreIds: coreIds,
          created,
          connected
        }
      };
    } catch (error) {
      const launch: ToolResult = { sessionName, coreIds };
      if (sessionId) {
        launch.sessionId = sessionId;
        try {
          await this.manager.closeDebugSession(sessionId);
          launch.cleanedUp = true;
        } catch (cleanupError) {
          launch.cleanedUp = false;
          launch.cleanupError = toStructuredError(cleanupError);
        }
      }
      throw new DebugMcpError(
        "PostLaunchCheckFailed",
        "Launch and IPC acceptance workflow failed",
        { launch, cause: toStructuredError(error) }
      );
    }
  }

  async runIpcAcceptance(input: z.infer<typeof runIpcAcceptanceSchema>): Promise<ToolResult> {
    const coreIds = [input.cpu1CoreId, input.cpu2CoreId];
    const performedSteps: string[] = [];
    const maps = mapsFromPaths(input);

    const initialHalt = await this.manager.haltCores(input.sessionId, coreIds);
    performedSteps.push("haltCores");
    const reset = await this.manager.resetCores(input.sessionId, coreIds, input.resetType as ResetType);
    performedSteps.push("resetCores");
    const load = await this.manager.loadPrograms(input.sessionId, [
      { coreId: input.cpu1CoreId, programUri: input.cpu1OutPath, mapUri: input.cpu1MapPath },
      { coreId: input.cpu2CoreId, programUri: input.cpu2OutPath, mapUri: input.cpu2MapPath }
    ]);
    performedSteps.push("loadPrograms");
    const postLoadHalt = await this.manager.haltCores(input.sessionId, coreIds);
    performedSteps.push("haltCoresAfterLoad");
    const snapshot = await this.manager.getMulticoreSnapshot(input.sessionId, coreIds);
    performedSteps.push("getMulticoreSnapshot");
    const ramOwnership = await this.analyzeRamOwnership({ maps });
    performedSteps.push("analyzeRamOwnership");
    const elfFreshness = await this.checkElfFreshness(input.sessionId, [
      { coreId: input.cpu1CoreId, outPath: input.cpu1OutPath },
      { coreId: input.cpu2CoreId, outPath: input.cpu2OutPath }
    ]);
    performedSteps.push("checkElfFreshness");
    const runtimeRamOwnership = this.runtimeRamOwnershipStatus(input.verifyRuntimeRamOwnership);
    if (input.runSequence.runCpu1First) {
      await this.manager.runCore(input.sessionId, input.cpu1CoreId);
      performedSteps.push("runCpu1");
      await sleep(input.runSequence.settleMs);
    }
    if (input.runSequence.runCpu2) {
      await this.manager.runCore(input.sessionId, input.cpu2CoreId);
      performedSteps.push("runCpu2");
      await sleep(input.runSequence.settleMs);
    }
    const conditions = input.ipcReadyExpressions ?? defaultIpcReadyConditions(input.cpu1CoreId, input.cpu2CoreId);
    const ipcReady = await this.waitForExpressionSet(input.sessionId, conditions, input.timeoutMs, input.intervalMs);
    performedSteps.push("waitForIpcReady");
    const timeoutRecovery = ipcReady.timedOut
      ? await this.haltAndResolvePc(input.sessionId, coreIds)
      : undefined;
    if (timeoutRecovery) {
      performedSteps.push("haltAndResolvePcOnTimeout");
    }
    const diagnosis = await this.buildBootHandoffDiagnosis({
      sessionId: input.sessionId,
      device: input.device,
      cpu1CoreId: input.cpu1CoreId,
      cpu2CoreId: input.cpu2CoreId,
      ramOwnership,
      elfFreshness,
      runtimeRamOwnership,
      ipcReady,
      ipcAcceptance: true
    });
    performedSteps.push("diagnoseBootHandoff");
    const result: ToolResult = {
      workflow: "c2000_runIpcAcceptance",
      orchestration: "server-internal",
      mcpToolCalls: [],
      approvalClass: "workflow-confirmation",
      effectsApplied: ["target-halt", "target-reset", "program-load", "ram-ownership-change", "target-run", "target-read"],
      sessionId: input.sessionId,
      device: input.device,
      cpu1CoreId: input.cpu1CoreId,
      cpu2CoreId: input.cpu2CoreId,
      success: ipcReady.matched === true && load.results.every((item: ToolResult) => item.success === true) && elfFreshness.allFresh === true,
      performedSteps,
      initialHalt,
      reset,
      load,
      postLoadHalt,
      snapshot,
      ramOwnership,
      elfFreshness,
      runtimeRamOwnership,
      ipcReady,
      ...(timeoutRecovery ? { timeoutRecovery } : {}),
      diagnosis
    };
    if (input.collectDebugBundle) {
      result.debugBundle = await this.writeDebugBundle(input.outputDir ?? defaultBundleDir("ipc-acceptance"), result);
    }
    return result;
  }

  async runBootHandoffDiagnosis(input: z.infer<typeof runBootHandoffDiagnosisSchema>): Promise<ToolResult> {
    const maps = input.maps ?? mapsFromPaths(input);
    const ramOwnership = maps.length > 0 ? await this.analyzeRamOwnership({ maps }) : undefined;
    const elfFreshness = await this.checkElfFreshness(input.sessionId, [
      { coreId: input.cpu1CoreId, outPath: input.cpu1OutPath },
      { coreId: input.cpu2CoreId, outPath: input.cpu2OutPath }
    ]);
    const runtimeRamOwnership = this.runtimeRamOwnershipStatus(input.verifyRuntimeRamOwnership);
    return this.buildBootHandoffDiagnosis({
      sessionId: input.sessionId,
      device: input.device,
      cpu1CoreId: input.cpu1CoreId,
      cpu2CoreId: input.cpu2CoreId,
      ramOwnership,
      elfFreshness,
      runtimeRamOwnership,
      extraExpressions: input.expressions
    });
  }

  async runReloadAndDiagnose(input: z.infer<typeof runReloadAndDiagnoseSchema>): Promise<ToolResult> {
    const coreIds = [input.cpu1CoreId, input.cpu2CoreId];
    const performedSteps: string[] = [];
    const maps = mapsFromPaths(input);
    const halt = await this.manager.haltCores(input.sessionId, coreIds);
    performedSteps.push("haltCores");
    const reset = await this.manager.resetCores(input.sessionId, coreIds, input.resetType as ResetType);
    performedSteps.push("resetCores");
    const load = await this.manager.loadPrograms(input.sessionId, [
      { coreId: input.cpu1CoreId, programUri: input.cpu1OutPath, mapUri: input.cpu1MapPath },
      { coreId: input.cpu2CoreId, programUri: input.cpu2OutPath, mapUri: input.cpu2MapPath, ramOwnershipPolicy: input.ramOwnershipPolicy, fallbackGsRegions: input.fallbackGsRegions }
    ]);
    performedSteps.push("loadPrograms");
    const postLoadHalt = await this.manager.haltCores(input.sessionId, coreIds);
    performedSteps.push("haltCoresAfterLoad");
    const snapshot = await this.manager.getMulticoreSnapshot(input.sessionId, coreIds);
    performedSteps.push("getMulticoreSnapshot");
    const ramOwnership = maps.length > 0 ? await this.analyzeRamOwnership({ maps }) : undefined;
    const elfFreshness = await this.checkElfFreshness(input.sessionId, [
      { coreId: input.cpu1CoreId, outPath: input.cpu1OutPath },
      { coreId: input.cpu2CoreId, outPath: input.cpu2OutPath }
    ]);
    if (input.runCpu1) {
      await this.manager.runCore(input.sessionId, input.cpu1CoreId);
      performedSteps.push("runCpu1");
    }
    if (input.runCpu2) {
      await this.manager.runCore(input.sessionId, input.cpu2CoreId);
      performedSteps.push("runCpu2");
    }
    const wait = input.waitExpressions && input.timeoutMs
      ? await this.waitForExpressionSet(input.sessionId, input.waitExpressions, input.timeoutMs, input.intervalMs)
      : undefined;
    if (wait) {
      performedSteps.push("waitExpressions");
    }
    const runtimeRamOwnership = this.runtimeRamOwnershipStatus(input.verifyRuntimeRamOwnership);
    const diagnosis = await this.buildBootHandoffDiagnosis({
      sessionId: input.sessionId,
      device: input.device,
      cpu1CoreId: input.cpu1CoreId,
      cpu2CoreId: input.cpu2CoreId,
      ramOwnership,
      elfFreshness,
      runtimeRamOwnership,
      ipcReady: wait
    });
    const result: ToolResult = {
      workflow: "c2000_runReloadAndDiagnose",
      orchestration: "server-internal",
      mcpToolCalls: [],
      approvalClass: "workflow-confirmation",
      effectsApplied: ["target-halt", "target-reset", "program-load", "ram-ownership-change", "target-run", "target-read"],
      sessionId: input.sessionId,
      device: input.device,
      cpu1CoreId: input.cpu1CoreId,
      cpu2CoreId: input.cpu2CoreId,
      success: load.results.every((item: ToolResult) => item.success === true) && (!wait || wait.matched === true),
      performedSteps,
      halt,
      reset,
      load,
      postLoadHalt,
      snapshot,
      ...(ramOwnership ? { ramOwnership } : {}),
      elfFreshness,
      runtimeRamOwnership,
      ...(wait ? { wait } : {}),
      diagnosis
    };
    if (input.collectDebugBundle) {
      result.debugBundle = await this.writeDebugBundle(input.outputDir ?? defaultBundleDir("reload-diagnose"), result);
    }
    return result;
  }

  async runFullDebugBundle(input: z.infer<typeof runFullDebugBundleSchema>): Promise<ToolResult> {
    const coreIds = input.coreIds ?? [input.cpu1CoreId, input.cpu2CoreId];
    const maps = input.maps ?? mapsFromPaths(input);
    const snapshot = await this.manager.getMulticoreSnapshot(input.sessionId, coreIds);
    const loadedPrograms = await Promise.all(coreIds.map(async coreId => ({
      coreId,
      loadedProgramInfo: await this.manager.getLoadedProgramInfo(input.sessionId, coreId)
    })));
    const expressions = await this.evaluateReadSets(input.sessionId, input.expressions ?? defaultExpressionReadSets(input.cpu1CoreId, input.cpu2CoreId));
    const pc = await Promise.all(coreIds.map(async coreId => ({ coreId, ...(await this.manager.resolvePc(input.sessionId, coreId)) })));
    const ramOwnership = maps.length > 0 ? await this.analyzeRamOwnership({ maps }) : undefined;
    const elfFreshness = await this.checkElfFreshness(input.sessionId, [
      { coreId: input.cpu1CoreId, outPath: input.cpu1OutPath },
      { coreId: input.cpu2CoreId, outPath: input.cpu2OutPath }
    ]);
    const runtimeRamOwnership = this.runtimeRamOwnershipStatus(input.verifyRuntimeRamOwnership);
    const bootHandoff = await this.buildBootHandoffDiagnosis({
      sessionId: input.sessionId,
      device: input.device,
      cpu1CoreId: input.cpu1CoreId,
      cpu2CoreId: input.cpu2CoreId,
      ramOwnership,
      elfFreshness,
      runtimeRamOwnership
    });
    const result: ToolResult = {
      workflow: "c2000_runFullDebugBundle",
      orchestration: "server-internal",
      mcpToolCalls: [],
      approvalClass: "workflow-confirmation",
      effectsApplied: ["target-read", "bundle-write"],
      sessionId: input.sessionId,
      device: input.device,
      cpu1CoreId: input.cpu1CoreId,
      cpu2CoreId: input.cpu2CoreId,
      success: true,
      snapshot,
      loadedPrograms,
      expressions,
      pc,
      ...(ramOwnership ? { ramOwnership } : {}),
      elfFreshness,
      runtimeRamOwnership,
      bootHandoff
    };
    result.bundle = await this.writeDebugBundle(input.outputDir, result);
    return result;
  }

  private async buildBootHandoffDiagnosis(options: {
    sessionId: string;
    device: string;
    cpu1CoreId: CoreId;
    cpu2CoreId: CoreId;
    ramOwnership?: RamOwnershipAnalysis;
    elfFreshness?: ToolResult;
    runtimeRamOwnership?: ToolResult;
    ipcReady?: ToolResult;
    extraExpressions?: ExpressionCondition[];
    ipcAcceptance?: boolean;
  }): Promise<ToolResult> {
    const boot = await this.manager.diagnoseCpu2Boot({
      sessionId: options.sessionId,
      cpu1CoreId: options.cpu1CoreId,
      cpu2CoreId: options.cpu2CoreId
    });
    const extraExpressions = options.extraExpressions
      ? await this.evaluateConditions(options.sessionId, options.extraExpressions)
      : undefined;
    const verdict = buildBootHandoffVerdict(boot, options.ramOwnership);
    const ipcTimedOut = options.ipcReady?.timedOut === true;
    const diagnosisCode = ipcTimedOut
      ? "IPC_READY_TIMEOUT"
      : verdict.ready
        ? (options.ipcAcceptance ? "IPC_ACCEPTANCE_READY" : "BOOT_HANDOFF_READY")
        : "BOOT_HANDOFF_NOT_READY";
    const severity = diagnosisCode === "IPC_READY_TIMEOUT"
      ? "error"
      : diagnosisCode === "BOOT_HANDOFF_NOT_READY"
        ? "warning"
        : "info";
    return {
      workflow: "c2000_runBootHandoffDiagnosis",
      orchestration: "server-internal",
      mcpToolCalls: [],
      approvalClass: "read-only",
      performedSteps: ["snapshot", "loadedPrograms", "expressions", "pc", "ramOwnership", "elfFreshness", "diagnosis"],
      effectsApplied: ["target-read"],
      device: options.device,
      diagnosisCode,
      severity,
      recommendedActions: recommendedActions(diagnosisCode, verdict, options.ramOwnership),
      evidence: {
        explicitCores: { cpu1CoreId: options.cpu1CoreId, cpu2CoreId: options.cpu2CoreId },
        noCcsUiFocusRequired: true,
        managerRoute: "sessionId -> coreId -> DebugSession",
        verdict
      },
      ...boot,
      verdict,
      ...(options.ramOwnership ? { ramOwnership: options.ramOwnership } : {}),
      ...(options.elfFreshness ? { elfFreshness: options.elfFreshness } : {}),
      ...(options.runtimeRamOwnership ? { runtimeRamOwnership: options.runtimeRamOwnership } : {}),
      ...(extraExpressions ? { expressions: extraExpressions } : {})
    };
  }

  private async evaluateReadSets(sessionId: string, readSets: ExpressionReadSet[]) {
    return Promise.all(readSets.map(async readSet => ({
      label: readSet.label,
      coreId: readSet.coreId,
      results: await this.manager.evaluateMany(sessionId, readSet.coreId, readSet.expressions)
    })));
  }

  private async evaluateConditions(sessionId: string, conditions: ExpressionCondition[]) {
    return Promise.all(conditions.map(async condition => {
      const [result] = await this.manager.evaluateMany(sessionId, condition.coreId, [condition.expression]);
      return conditionResult(condition, result);
    }));
  }

  private async waitForExpressionSet(sessionId: string, conditions: ExpressionCondition[], timeoutMs: number, intervalMs: number) {
    const deadline = Date.now() + timeoutMs;
    let lastConditions: ToolResult[] = [];
    while (Date.now() <= deadline) {
      lastConditions = await this.evaluateConditions(sessionId, conditions);
      if (lastConditions.every(condition => condition.matched)) {
        return { sessionId, matched: true, timedOut: false, conditions: lastConditions };
      }
      await sleep(intervalMs);
    }
    return { sessionId, matched: false, timedOut: true, conditions: lastConditions };
  }

  private async haltAndResolvePc(sessionId: string, coreIds: CoreId[]) {
    const halt = await this.manager.haltCores(sessionId, coreIds);
    const pc = await Promise.all(coreIds.map(async coreId => ({ coreId, ...(await this.manager.resolvePc(sessionId, coreId)) })));
    return { halt, pc };
  }

  private async checkElfFreshness(sessionId: string, programs: Array<{ coreId: CoreId; outPath?: string }>) {
    const checked = await Promise.all(programs
      .filter((program): program is { coreId: CoreId; outPath: string } => typeof program.outPath === "string" && program.outPath.length > 0)
      .map(async program => {
        const loadedProgramInfo = await this.manager.getLoadedProgramInfo(sessionId, program.coreId);
        const metadata = await fileMetadata(program.outPath);
        const fresh = loadedProgramInfo?.programUri === program.outPath
          && loadedProgramInfo.fileSize === metadata.fileSize
          && loadedProgramInfo.sha256 === metadata.sha256;
        return {
          coreId: program.coreId,
          expectedPath: program.outPath,
          fresh,
          hostFile: metadata,
          loadedProgramInfo
        };
      }));
    return {
      allFresh: checked.every(item => item.fresh),
      programs: checked
    };
  }

  private runtimeRamOwnershipStatus(requested: boolean) {
    return {
      requested,
      supported: false,
      skipped: true,
      reason: "Current DebugAdapter contract exposes GS RAM ownership writes but no runtime MEMCFG read API yet."
    };
  }

  private async writeDebugBundle(outputDir: string, result: ToolResult) {
    await mkdir(outputDir, { recursive: true });
    const files: string[] = [];
    const writeJson = async (fileName: string, body: unknown) => {
      const filePath = path.join(outputDir, fileName);
      await writeFile(filePath, `${JSON.stringify(body, null, 2)}\n`);
      files.push(filePath);
    };
    await writeJson("snapshot.json", result.snapshot ?? result.diagnosis?.snapshot ?? result.bootHandoff?.snapshot);
    await writeJson("ram-ownership.json", result.ramOwnership ?? result.diagnosis?.ramOwnership ?? result.bootHandoff?.ramOwnership ?? null);
    await writeJson("elf-freshness.json", result.elfFreshness ?? result.diagnosis?.elfFreshness ?? result.bootHandoff?.elfFreshness ?? null);
    await writeJson("boot-handoff.json", result.diagnosis ?? result.bootHandoff ?? result);
    const summaryPath = path.join(outputDir, "summary.md");
    await writeFile(summaryPath, summaryMarkdown(result));
    files.unshift(summaryPath);
    return { outputDir, files };
  }
}

function mapsFromPaths(input: { cpu1CoreId: CoreId; cpu2CoreId: CoreId; cpu1MapPath?: string; cpu2MapPath?: string }): MapOwnershipInput["maps"] {
  const maps: Array<MapOwnershipInput["maps"][number] | undefined> = [
    input.cpu1MapPath ? { coreId: input.cpu1CoreId, coreName: "C28xx_CPU1", mapPath: input.cpu1MapPath } : undefined,
    input.cpu2MapPath ? { coreId: input.cpu2CoreId, coreName: "C28xx_CPU2", mapPath: input.cpu2MapPath } : undefined
  ];
  return maps.filter((map): map is MapOwnershipInput["maps"][number] => map !== undefined);
}

function defaultIpcReadyConditions(cpu1CoreId: CoreId, cpu2CoreId: CoreId): ExpressionCondition[] {
  return [
    { label: "cpu1-ipc-pass", coreId: cpu1CoreId, expression: "g_ulHybrid30kIpcPass", expected: 1 },
    { label: "cpu1-msgram-pass", coreId: cpu1CoreId, expression: "g_ulHybrid30kMsgRamPass", expected: 1 },
    { label: "cpu1-param-pass", coreId: cpu1CoreId, expression: "g_ulHybrid30kParamPass", expected: 1 },
    { label: "cpu2-stage-ready", coreId: cpu2CoreId, expression: "g_emHybrid30kCpu2Stage", expected: 1 }
  ];
}

function defaultExpressionReadSets(cpu1CoreId: CoreId, cpu2CoreId: CoreId): ExpressionReadSet[] {
  return [
    { label: "cpu1-boot-ipc", coreId: cpu1CoreId, expressions: ["g_emHybrid30kCpu1Stage", "g_ulHybrid30kIpcPass", "g_ulHybrid30kMsgRamPass", "g_ulHybrid30kParamPass"] },
    { label: "cpu2-boot-stage", coreId: cpu2CoreId, expressions: ["g_emHybrid30kCpu2Stage"] }
  ];
}

function conditionResult(condition: ExpressionCondition, result?: EvaluateResult): ToolResult {
  return {
    label: condition.label,
    coreId: condition.coreId,
    expression: condition.expression,
    expected: condition.expected,
    matched: result?.success === true && valuesEqual(result.value, condition.expected),
    result
  };
}

function buildBootHandoffVerdict(boot: ToolResult, ramOwnership?: RamOwnershipAnalysis) {
  const cpu1Expressions = Array.isArray(boot.cpu1?.expressions) ? boot.cpu1.expressions as ToolResult[] : [];
  const cpu2Expressions = Array.isArray(boot.cpu2?.expressions) ? boot.cpu2.expressions as ToolResult[] : [];
  const cpu1Ready = cpu1Expressions.length > 0 && cpu1Expressions.every(result => result.success === true && !["0", "false", "undefined"].includes(String(result.value)));
  const cpu2Ready = cpu2Expressions.length > 0 && cpu2Expressions.every(result => result.success === true && !["0", "false", "undefined"].includes(String(result.value)));
  const ramOwnershipReady = !ramOwnership || Array.isArray(ramOwnership.ownershipActions);
  return {
    cpu1Ready,
    cpu2Ready,
    ramOwnershipReady,
    ready: cpu1Ready && cpu2Ready && ramOwnershipReady
  };
}

function recommendedActions(diagnosisCode: string, verdict: ToolResult, ramOwnership?: RamOwnershipAnalysis): string[] {
  if (diagnosisCode === "IPC_READY_TIMEOUT") {
    return [
      "Halt both cores and inspect CPU1 IPC pass flags and CPU2 stage expression.",
      "Verify CPU1 runs first and releases CPU2 boot handoff before CPU2 is expected to report IPC ready."
    ];
  }
  if (diagnosisCode === "BOOT_HANDOFF_NOT_READY") {
    const actions = ["Check CPU1 IPC/pass expressions and CPU2 boot stage before rerunning acceptance."];
    if (!verdict.ramOwnershipReady || (ramOwnership?.ownershipActions.length ?? 0) === 0) {
      actions.push("Review CPU2 .map RAMGS usage and CPU1 MEMCFG_GSXMSEL ownership setup.");
    }
    return actions;
  }
  return ["Evidence indicates CPU1/CPU2 boot handoff and IPC-ready state are consistent."];
}

function summaryMarkdown(result: ToolResult): string {
  const diagnosis = result.diagnosis ?? result.bootHandoff ?? result;
  return [
    `# ${result.workflow ?? "c2000 workflow"} Debug Bundle`,
    "",
    `- sessionId: ${result.sessionId ?? "unknown"}`,
    `- device: ${result.device ?? "unknown"}`,
    `- success: ${String(result.success)}`,
    `- diagnosisCode: ${diagnosis.diagnosisCode ?? "n/a"}`,
    `- severity: ${diagnosis.severity ?? "n/a"}`,
    `- orchestration: ${result.orchestration ?? "server-internal"}`,
    `- mcpToolCalls: ${JSON.stringify(result.mcpToolCalls ?? [])}`,
    ""
  ].join("\n");
}

function defaultBundleDir(label: string): string {
  return path.join(process.cwd(), ".c2000-debug-bundles", `${label}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
}

function valuesEqual(actual: unknown, expected: unknown): boolean {
  if (typeof expected === "number") {
    return Number(actual) === expected;
  }
  if (typeof expected === "boolean") {
    return String(actual).toLowerCase() === String(expected);
  }
  return String(actual) === String(expected);
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise(resolve => setTimeout(resolve, ms));
}
