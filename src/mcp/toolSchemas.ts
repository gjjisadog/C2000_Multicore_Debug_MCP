import { z } from "zod";
import { canHealthPolicySchema, testArtifactsSchema, testPlanSchema } from "../jobs/TestPlanSchema.js";
import { canAcceptanceProfileSchema } from "../can/CanProfileSchema.js";

export const coreConfigSchema = z.object({
  coreId: z.number().int(),
  coreName: z.string().min(1),
  corePattern: z.string().min(1).optional().describe("Exact CCS core selector; prefer C28xx_CPU1 or C28xx_CPU2 instead of a regular expression")
});

export const createDebugSessionSchema = z.object({
  sessionName: z.string().min(1).optional(),
  ccxmlPath: z.string().min(1).optional(),
  coreMap: z.array(coreConfigSchema).min(1).optional(),
  /** Optional routing hint for c2000-debugd; existing interactive calls remain unchanged. */
  boardId: z.string().min(1).optional(),
  probeId: z.string().min(1).optional(),
  preferredProbeIds: z.array(z.string().min(1)).min(1).optional(),
  allowAutoProbeAllocation: z.boolean().default(false)
});

export const hardwarePreflightSchema = z.object({
  ccsInstallPath: z.string().min(1).optional()
});

export const acceptanceProgramDiscoverySchema = z.object({
  cpu1Program: z.string().min(1).optional(),
  cpu2Program: z.string().min(1).optional(),
  searchRoots: z.array(z.string().min(1)).optional(),
  maxDepth: z.number().int().nonnegative().optional()
});

export const acceptanceReadinessSchema = z.object({
  ccsInstallPath: z.string().min(1).optional(),
  ccxmlPath: z.string().min(1).optional(),
  cpu1Program: z.string().min(1).optional(),
  cpu2Program: z.string().min(1).optional(),
  searchRoots: z.array(z.string().min(1)).optional(),
  maxDepth: z.number().int().nonnegative().optional(),
  allowExistingDebugProcesses: z.boolean().optional(),
  waitForProbeMs: z.number().int().nonnegative().default(0),
  probePollIntervalMs: z.number().int().positive().default(250)
});

export const ramOwnershipMapSchema = z.object({
  coreId: z.number().int(),
  coreName: z.string().min(1).optional(),
  mapPath: z.string().min(1)
});

export const ramOwnershipAnalysisSchema = z.object({
  maps: z.array(ramOwnershipMapSchema).min(1)
});

export const toolContractsSchema = z.object({});

export const serverHealthSchema = z.object({});

export const environmentSchema = z.object({});

export const debugBoundarySchema = z.object({});

export const acceptanceEvidenceSchema = z.object({});

/** Read-only daemon liveness and scheduler state. */
export const daemonHealthSchema = z.object({});

export const listBoardsSchema = z.object({
  status: z.array(z.enum(["OFFLINE", "AVAILABLE", "RESERVED", "STARTING", "READY", "RUNNING", "RECOVERING", "QUARANTINED", "FAILED"])).min(1).optional(),
  tags: z.array(z.string().min(1)).min(1).optional()
});

/** Persist a serial-bound board registration and optionally start its isolated worker. */
export const registerBoardSchema = z.object({
  boardId: z.string().min(1),
  probeSerial: z.string().min(1),
  device: z.string().min(1).default("F28P65x"),
  ccxmlPath: z.string().min(1),
  tags: z.array(z.string().min(1)).default([]),
  startWorker: z.boolean().default(true)
});

/** Restart only the daemon-owned worker for a registered board. This never terminates external CCS/DSS processes. */
export const recoverBoardSchema = z.object({
  boardId: z.string().min(1),
  dryRun: z.boolean().default(true)
});

export const submitTestPlanSchema = z.object({ plan: testPlanSchema });
export const getTestRunSchema = z.object({ jobId: z.string().min(1), includeSteps: z.boolean().default(true), includeEvents: z.boolean().default(false) });
export const listTestRunsSchema = z.object({ status: z.array(z.string().min(1)).min(1).optional() });
export const cancelTestRunSchema = z.object({ jobId: z.string().min(1) });
export const getTestArtifactsSchema = z.object({ jobId: z.string().min(1) });
export const submitMultiBoardIpcAcceptanceSchema = z.object({
  boardIds: z.array(z.string().min(1)).min(1),
  artifacts: z.object({ cpu1OutPath: z.string().min(1), cpu2OutPath: z.string().min(1), cpu1MapPath: z.string().min(1).optional(), cpu2MapPath: z.string().min(1).optional(), outputDir: z.string().min(1).optional() }),
  parallelism: z.number().int().positive().optional(),
  timeoutMs: z.number().int().positive().default(10000),
  loadPolicy: z.enum(["always", "if-changed", "verify-mcp-registry", "verify-only"]).default("always")
    .describe("verify-mcp-registry only checks artifacts previously loaded through the same MCP session; verify-only is a deprecated alias"),
  loadSequence: z.object({
    mode: z.enum(["cpu1-then-cpu2", "cpu1-run-before-cpu2"]).default("cpu1-run-before-cpu2"),
    cpu1SettleMs: z.number().int().nonnegative().default(250)
  }).default({ mode: "cpu1-run-before-cpu2", cpu1SettleMs: 250 }),
  verifyRuntimeRamOwnership: z.boolean().default(false),
  collectDebugBundle: z.boolean().default(true),
  failurePolicy: z.object({ continueHealthyBoards: z.boolean().default(true), quarantineFailedBoard: z.boolean().default(true) }).default({ continueHealthyBoards: true, quarantineFailedBoard: true })
});

const canArtifactSelectionShape = {
  artifacts: testArtifactsSchema.optional(),
  artifactsByBoard: z.record(testArtifactsSchema).optional(),
  artifactsByRole: z.record(testArtifactsSchema).optional()
};

/** Submit a durable two-board CAN acceptance job. Hardware mode fails closed until an adapter is installed. */
export const submitMultiBoardCanAcceptanceSchema = z.object({
  name: z.string().min(1).default("two-board-can-acceptance"),
  boardIds: z.array(z.string().min(1)).length(2).refine(ids => ids[0] !== ids[1], "boardIds must identify two distinct boards"),
  ...canArtifactSelectionShape,
  profile: canAcceptanceProfileSchema,
  failurePolicy: z.object({ continueHealthyBoards: z.boolean().default(false), quarantineFailedBoard: z.boolean().default(true), collectDebugBundle: z.boolean().default(true) }).default({ continueHealthyBoards: false, quarantineFailedBoard: true, collectDebugBundle: true })
});

export const listCanProfilesSchema = z.object({
  profileId: z.string().min(1).optional(),
  includeRetired: z.boolean().default(false)
});

export const getBoardGroupSnapshotSchema = z.object({
  groupId: z.string().min(1),
  includeBarriers: z.boolean().default(true),
  includeResults: z.boolean().default(true)
});

export const submitCanFaultCampaignSchema = z.object({
  name: z.string().min(1).default("two-board-can-fault-campaign"),
  boardIds: z.array(z.string().min(1)).length(2).refine(ids => ids[0] !== ids[1], "boardIds must identify two distinct boards"),
  ...canArtifactSelectionShape,
  profile: canAcceptanceProfileSchema,
  iterations: z.number().int().positive().max(10_000).default(1),
  failFast: z.boolean().default(false),
  health: canHealthPolicySchema,
  resetOrRejoinRequested: z.boolean().default(false),
  failurePolicy: z.object({ continueHealthyBoards: z.boolean().default(true), quarantineFailedBoard: z.boolean().default(true), collectDebugBundle: z.boolean().default(true) }).default({ continueHealthyBoards: true, quarantineFailedBoard: true, collectDebugBundle: true })
});

export const submitCanSoakTestSchema = z.object({
  name: z.string().min(1).default("two-board-can-soak"),
  boardIds: z.array(z.string().min(1)).length(2).refine(ids => ids[0] !== ids[1], "boardIds must identify two distinct boards"),
  ...canArtifactSelectionShape,
  profile: canAcceptanceProfileSchema,
  iterations: z.number().int().positive().max(10_000).default(1),
  durationMs: z.number().int().positive().max(86_400_000).optional(),
  health: canHealthPolicySchema,
  failurePolicy: z.object({ continueHealthyBoards: z.boolean().default(true), quarantineFailedBoard: z.boolean().default(true), collectDebugBundle: z.boolean().default(true) }).default({ continueHealthyBoards: true, quarantineFailedBoard: true, collectDebugBundle: true })
});

export const sessionCoreSchema = z.object({
  sessionId: z.string().min(1),
  coreId: z.number().int()
});

export const sessionSchema = z.object({
  sessionId: z.string().min(1)
});

export const multicoreSnapshotSchema = z.object({
  sessionId: z.string().min(1),
  coreIds: z.array(z.number().int()).min(1).optional()
});

export const resetCoreSchema = sessionCoreSchema.extend({
  resetType: z.enum(["cpu", "system", "restart", "default"]).default("default")
});

export const loadProgramSchema = sessionCoreSchema.extend({
  programUri: z.string().min(1),
  mapUri: z.string().min(1).optional(),
  ramOwnershipPolicy: z.enum(["require-map", "explicit-fallback", "skip"]).optional(),
  fallbackGsRegions: z.array(z.number().int().min(0).max(15)).min(1).optional(),
  loadPolicy: z.enum(["always", "if-changed", "verify-mcp-registry", "verify-only"]).default("always")
    .describe("verify-mcp-registry only checks artifacts previously loaded through the same MCP session; verify-only is a deprecated alias")
});

export const loadSymbolsSchema = sessionCoreSchema.extend({
  programUri: z.string().min(1)
});

export const loadProgramsSchema = z.object({
  sessionId: z.string().min(1),
  programs: z.array(loadProgramSchema.omit({ sessionId: true })).min(1)
});

export const batchCoresSchema = z.object({
  sessionId: z.string().min(1),
  coreIds: z.array(z.number().int()).min(1)
});

export const resetCoresSchema = batchCoresSchema.extend({
  resetType: z.enum(["cpu", "system", "restart", "default"]).default("default")
});

export const evaluateManySchema = sessionCoreSchema.extend({
  expressions: z.array(z.string().min(1)).min(1)
});

export const assignExpressionSchema = sessionCoreSchema.extend({
  expression: z.string().min(1),
  value: z.union([z.string(), z.number(), z.boolean()]),
  verify: z.boolean().default(true)
});

const expressionAssignmentSchema = z.object({
  coreId: z.number().int(),
  expression: z.string().min(1),
  value: z.union([z.string(), z.number(), z.boolean()]),
  verify: z.boolean().default(true)
});

const expressionEndpointSchema = z.object({
  coreId: z.number().int(),
  expression: z.string().min(1)
});

export const expressionConditionSchema = z.object({
  label: z.string().min(1).optional(),
  coreId: z.number().int(),
  expression: z.string().min(1),
  expected: z.union([z.string(), z.number(), z.boolean()])
});

export const expressionReadSetSchema = z.object({
  label: z.string().min(1).optional(),
  coreId: z.number().int(),
  expressions: z.array(z.string().min(1)).min(1)
});

export const pollingScheduleItemSchema = z.object({
  untilMs: z.number().int().positive().optional(),
  intervalMs: z.number().int().positive()
});

const expressionComparisonSchema = z.object({
  label: z.string().min(1).optional(),
  left: expressionEndpointSchema,
  right: expressionEndpointSchema
});

export const compareExpressionsSchema = z.object({
  sessionId: z.string().min(1),
  comparisons: z.array(expressionComparisonSchema).min(1)
});

export const assignExpressionsSchema = z.object({
  sessionId: z.string().min(1),
  assignments: z.array(expressionAssignmentSchema).min(1)
});

const faultInjectionSchema = expressionAssignmentSchema.extend({
  label: z.string().min(1).optional()
});

export const injectFaultsSchema = z.object({
  sessionId: z.string().min(1),
  faults: z.array(faultInjectionSchema).min(1)
});

export const resolveAddressSchema = sessionCoreSchema.extend({
  address: z.string().min(1)
});

export const waitUntilExpressionSchema = sessionCoreSchema.extend({
  expression: z.string().min(1),
  expected: z.union([z.string(), z.number(), z.boolean()]),
  timeoutMs: z.number().int().positive(),
  intervalMs: z.number().int().positive().default(100)
});

export const waitForExpressionSetSchema = z.object({
  sessionId: z.string().min(1),
  conditions: z.array(expressionConditionSchema).min(1),
  timeoutMs: z.number().int().positive(),
  intervalMs: z.number().int().positive().default(100)
});

export const diagnoseCpu2BootSchema = z.object({
  sessionId: z.string().min(1),
  cpu1CoreId: z.number().int(),
  cpu2CoreId: z.number().int(),
  cpu1Expressions: z.array(z.string().min(1)).optional(),
  cpu2Expressions: z.array(z.string().min(1)).optional()
});

export const diagnoseBootHandoffSchema = diagnoseCpu2BootSchema.extend({
  maps: z.array(ramOwnershipMapSchema).min(1).optional()
});

export const waitForIpcReadySchema = z.object({
  sessionId: z.string().min(1),
  cpu1CoreId: z.number().int(),
  cpu2CoreId: z.number().int(),
  timeoutMs: z.number().int().positive(),
  intervalMs: z.number().int().positive().default(100),
  conditions: z.array(expressionConditionSchema).min(1).optional()
});

export const reloadResetRunToMainSchema = sessionCoreSchema.extend({
  programUri: z.string().min(1),
  mapUri: z.string().min(1).optional(),
  ramOwnershipPolicy: z.enum(["require-map", "explicit-fallback", "skip"]).optional(),
  fallbackGsRegions: z.array(z.number().int().min(0).max(15)).min(1).optional(),
  resetType: z.enum(["cpu", "system", "restart", "default"]).default("default"),
  loadPolicy: z.enum(["always", "if-changed", "verify-mcp-registry", "verify-only"]).default("always")
    .describe("verify-mcp-registry only checks artifacts previously loaded through the same MCP session; verify-only is a deprecated alias"),
  settleMs: z.number().int().nonnegative().default(250)
});

export const workflowRunSequenceSchema = z.object({
  runMode: z.enum(["cpu1_boots_cpu2", "debugger_runs_both", "cpu2_pre_running"]).optional(),
  runCpu1First: z.boolean().default(true),
  runCpu2: z.boolean().default(false),
  settleMs: z.number().int().nonnegative().default(0)
}).default({ runCpu1First: true, runCpu2: false, settleMs: 0 });

export const runIpcAcceptanceSchema = z.object({
  sessionId: z.string().min(1),
  device: z.string().min(1).default("F28P65x"),
  cpu1CoreId: z.number().int(),
  cpu2CoreId: z.number().int(),
  cpu1OutPath: z.string().min(1),
  cpu2OutPath: z.string().min(1),
  cpu1MapPath: z.string().min(1),
  cpu2MapPath: z.string().min(1),
  resetType: z.enum(["cpu", "system", "restart", "default"]).default("default"),
  loadPolicy: z.enum(["always", "if-changed", "verify-mcp-registry", "verify-only"]).default("always")
    .describe("verify-mcp-registry only checks artifacts previously loaded through the same MCP session; verify-only is a deprecated alias"),
  loadSequence: z.object({
    mode: z.enum(["cpu1-then-cpu2", "cpu1-run-before-cpu2"]).default("cpu1-then-cpu2"),
    cpu1SettleMs: z.number().int().nonnegative().default(250)
  }).default({ mode: "cpu1-then-cpu2", cpu1SettleMs: 250 }),
  runSequence: workflowRunSequenceSchema,
  ipcReadyExpressions: z.array(expressionConditionSchema).min(1).optional(),
  timeoutMs: z.number().int().positive(),
  intervalMs: z.number().int().positive().default(100),
  pollingStrategy: z.enum(["fixed", "adaptive"]).default("adaptive"),
  pollingSchedule: z.array(pollingScheduleItemSchema).min(1).optional(),
  verifyRuntimeRamOwnership: z.boolean().default(false),
  collectDebugBundle: z.boolean().default(false),
  outputDir: z.string().min(1).optional()
});

export const launchAndRunIpcAcceptanceSchema = runIpcAcceptanceSchema.omit({ sessionId: true }).extend({
  boardId: z.string().min(1).optional(),
  sessionMode: z.enum(["ephemeral", "interactive"]).default("ephemeral"),
  idleTimeoutMs: z.number().int().positive().optional(),
  sessionName: z.string().min(1).optional(),
  ccxmlPath: z.string().min(1).optional(),
  autoCloseOnComplete: z.boolean().default(false),
  autoCloseIdleTimeoutMs: z.number().int().positive().default(60000),
  cpu1CoreName: z.string().min(1).default("C28xx_CPU1"),
  cpu1CorePattern: z.string().min(1).optional().describe("Exact CCS selector for CPU1; normally C28xx_CPU1"),
  cpu2CoreName: z.string().min(1).default("C28xx_CPU2"),
  cpu2CorePattern: z.string().min(1).optional().describe("Exact CCS selector for CPU2; normally C28xx_CPU2"),
  probeId: z.string().min(1).optional(),
  preferredProbeIds: z.array(z.string().min(1)).min(1).optional(),
  allowAutoProbeAllocation: z.boolean().default(false)
});

export const runBootHandoffDiagnosisSchema = z.object({
  sessionId: z.string().min(1),
  device: z.string().min(1).default("F28P65x"),
  cpu1CoreId: z.number().int(),
  cpu2CoreId: z.number().int(),
  cpu1OutPath: z.string().min(1).optional(),
  cpu2OutPath: z.string().min(1).optional(),
  cpu1MapPath: z.string().min(1).optional(),
  cpu2MapPath: z.string().min(1).optional(),
  maps: z.array(ramOwnershipMapSchema).min(1).optional(),
  expressions: z.array(expressionConditionSchema).min(1).optional(),
  verifyRuntimeRamOwnership: z.boolean().default(false),
  outputDir: z.string().min(1).optional()
});

export const runReloadAndDiagnoseSchema = z.object({
  sessionId: z.string().min(1),
  device: z.string().min(1).default("F28P65x"),
  cpu1CoreId: z.number().int(),
  cpu2CoreId: z.number().int(),
  cpu1OutPath: z.string().min(1),
  cpu2OutPath: z.string().min(1),
  cpu1MapPath: z.string().min(1).optional(),
  cpu2MapPath: z.string().min(1).optional(),
  ramOwnershipPolicy: z.enum(["require-map", "explicit-fallback", "skip"]).default("require-map"),
  loadPolicy: z.enum(["always", "if-changed", "verify-mcp-registry", "verify-only"]).default("always")
    .describe("verify-mcp-registry only checks artifacts previously loaded through the same MCP session; verify-only is a deprecated alias"),
  fallbackGsRegions: z.array(z.number().int().min(0).max(15)).min(1).optional(),
  resetType: z.enum(["cpu", "system", "restart", "default"]).default("default"),
  runCpu1: z.boolean().default(true),
  runCpu2: z.boolean().default(false),
  postLoadBoot: z.object({
    resetType: z.enum(["cpu", "system", "restart", "default"]).default("system"),
    runCpu1: z.boolean().default(true),
    cpu1SettleMs: z.number().int().nonnegative().default(250),
    runCpu2: z.boolean().default(false)
  }).optional().describe("After programming and halting, reset both cores again and start them in a controlled CPU1-first order. This does not write PC or claim target Flash verification."),
  waitExpressions: z.array(expressionConditionSchema).min(1).optional(),
  timeoutMs: z.number().int().positive().optional(),
  intervalMs: z.number().int().positive().default(100),
  pollingStrategy: z.enum(["fixed", "adaptive"]).default("adaptive"),
  pollingSchedule: z.array(pollingScheduleItemSchema).min(1).optional(),
  verifyRuntimeRamOwnership: z.boolean().default(false),
  collectDebugBundle: z.boolean().default(false),
  outputDir: z.string().min(1).optional()
});

export const runFullDebugBundleSchema = z.object({
  sessionId: z.string().min(1),
  device: z.string().min(1).default("F28P65x"),
  cpu1CoreId: z.number().int(),
  cpu2CoreId: z.number().int(),
  coreIds: z.array(z.number().int()).min(1).optional(),
  cpu1OutPath: z.string().min(1).optional(),
  cpu2OutPath: z.string().min(1).optional(),
  cpu1MapPath: z.string().min(1).optional(),
  cpu2MapPath: z.string().min(1).optional(),
  maps: z.array(ramOwnershipMapSchema).min(1).optional(),
  expressions: z.array(expressionReadSetSchema).min(1).optional(),
  verifyRuntimeRamOwnership: z.boolean().default(false),
  outputDir: z.string().min(1)
});

export const verifyRunPauseIsolationSchema = z.object({
  sessionId: z.string().min(1),
  cpu1CoreId: z.number().int().default(0),
  cpu2CoreId: z.number().int().default(2),
  settleMs: z.number().int().nonnegative().default(250)
});

export const launchCoreSchema = z.object({
  coreId: z.number().int(),
  coreName: z.string().min(1),
  corePattern: z.string().min(1).optional().describe("Exact CCS core selector; prefer C28xx_CPU1 or C28xx_CPU2 instead of a regular expression"),
  programUri: z.string().min(1).optional(),
  mapUri: z.string().min(1).optional(),
  ramOwnershipPolicy: z.enum(["require-map", "explicit-fallback", "skip"]).optional(),
  fallbackGsRegions: z.array(z.number().int().min(0).max(15)).min(1).optional(),
  connect: z.boolean().default(true),
  load: z.boolean().default(true),
  haltAtEntry: z.boolean().default(true)
});

export const launchMulticoreDebugSchema = z.object({
  boardId: z.string().min(1).optional(),
  sessionName: z.string().min(1).optional(),
  targetConfigurationName: z.string().min(1).optional(),
  ccxmlPath: z.string().min(1).optional(),
  autoCloseOnComplete: z.boolean().default(false),
  autoCloseIdleTimeoutMs: z.number().int().positive().default(60000),
  probeId: z.string().min(1).optional(),
  preferredProbeIds: z.array(z.string().min(1)).min(1).optional(),
  allowAutoProbeAllocation: z.boolean().default(false),
  programDiscovery: z.object({
    enabled: z.boolean().default(false),
    cpu1Program: z.string().min(1).optional(),
    cpu2Program: z.string().min(1).optional(),
    searchRoots: z.array(z.string().min(1)).optional(),
    maxDepth: z.number().int().nonnegative().optional()
  }).optional(),
  cores: z.array(launchCoreSchema).min(1),
  postLaunchActions: z.object({
    assignExpressions: z.array(expressionAssignmentSchema).min(1).optional(),
    injectFaults: z.array(faultInjectionSchema).min(1).optional()
  }).optional(),
  postLaunchChecks: z.object({
    waitForExpressionSet: z.object({
      conditions: z.array(expressionConditionSchema).min(1),
      timeoutMs: z.number().int().positive(),
      intervalMs: z.number().int().positive().default(100)
    }).optional(),
    compareExpressions: z.array(expressionComparisonSchema).min(1).optional(),
    diagnoseCpu2Boot: z.object({
      cpu1CoreId: z.number().int(),
      cpu2CoreId: z.number().int(),
      cpu1Expressions: z.array(z.string().min(1)).optional(),
      cpu2Expressions: z.array(z.string().min(1)).optional()
    }).optional(),
    verifyRunPauseIsolation: z.object({
      cpu1CoreId: z.number().int().default(0),
      cpu2CoreId: z.number().int().default(2),
      settleMs: z.number().int().nonnegative().default(250)
    }).optional()
  }).optional()
});

const multiBoardLaunchEntrySchema = z.object({
  boardId: z.string().min(1).optional(),
  probeSerial: z.string().min(1),
  sessionName: z.string().min(1).optional(),
  targetConfigurationName: z.string().min(1).optional(),
  ccxmlPath: z.string().min(1),
  autoCloseOnComplete: z.boolean().default(false),
  autoCloseIdleTimeoutMs: z.number().int().positive().default(60000),
  cores: z.array(launchCoreSchema).min(1)
});

export const launchMultiBoardDebugSchema = z.object({
  ccsInstallPath: z.string().min(1).optional(),
  rollbackOnFailure: z.boolean().default(true),
  boards: z.array(multiBoardLaunchEntrySchema).min(1).max(8)
});

export const launchMulticoreDebugSafeSchema = launchMulticoreDebugSchema
  .omit({ postLaunchActions: true, postLaunchChecks: true })
  .extend({ postLaunchChecks: launchMulticoreDebugSchema.shape.postLaunchChecks.unwrap().omit({ verifyRunPauseIsolation: true }).optional() });

export const launchMulticoreDebugWithActionsSchema = launchMulticoreDebugSchema;
