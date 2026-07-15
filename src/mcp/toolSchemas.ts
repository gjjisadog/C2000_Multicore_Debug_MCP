import { z } from "zod";

export const coreConfigSchema = z.object({
  coreId: z.number().int(),
  coreName: z.string().min(1),
  corePattern: z.string().min(1).optional()
});

export const createDebugSessionSchema = z.object({
  sessionName: z.string().min(1).optional(),
  ccxmlPath: z.string().min(1).optional(),
  coreMap: z.array(coreConfigSchema).min(1).optional()
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
  allowExistingDebugProcesses: z.boolean().optional()
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

export const debugBoundarySchema = z.object({});

export const acceptanceEvidenceSchema = z.object({});

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
  mapUri: z.string().min(1).optional()
});

export const loadProgramsSchema = z.object({
  sessionId: z.string().min(1),
  programs: z.array(z.object({ coreId: z.number().int(), programUri: z.string().min(1), mapUri: z.string().min(1).optional() })).min(1)
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
  resetType: z.enum(["cpu", "system", "restart", "default"]).default("default"),
  settleMs: z.number().int().nonnegative().default(250)
});

export const workflowRunSequenceSchema = z.object({
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
  runSequence: workflowRunSequenceSchema,
  ipcReadyExpressions: z.array(expressionConditionSchema).min(1).optional(),
  timeoutMs: z.number().int().positive(),
  intervalMs: z.number().int().positive().default(100),
  verifyRuntimeRamOwnership: z.boolean().default(false),
  collectDebugBundle: z.boolean().default(false),
  outputDir: z.string().min(1).optional()
});

export const launchAndRunIpcAcceptanceSchema = runIpcAcceptanceSchema.omit({ sessionId: true }).extend({
  sessionName: z.string().min(1).optional(),
  ccxmlPath: z.string().min(1).optional(),
  autoCloseOnComplete: z.boolean().default(false),
  autoCloseIdleTimeoutMs: z.number().int().positive().default(60000),
  cpu1CoreName: z.string().min(1).default("C28xx_CPU1"),
  cpu1CorePattern: z.string().min(1).optional(),
  cpu2CoreName: z.string().min(1).default("C28xx_CPU2"),
  cpu2CorePattern: z.string().min(1).optional()
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
  resetType: z.enum(["cpu", "system", "restart", "default"]).default("default"),
  runCpu1: z.boolean().default(true),
  runCpu2: z.boolean().default(false),
  waitExpressions: z.array(expressionConditionSchema).min(1).optional(),
  timeoutMs: z.number().int().positive().optional(),
  intervalMs: z.number().int().positive().default(100),
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

export const launchMulticoreDebugSchema = z.object({
  sessionName: z.string().min(1).optional(),
  targetConfigurationName: z.string().min(1).optional(),
  ccxmlPath: z.string().min(1).optional(),
  autoCloseOnComplete: z.boolean().default(false),
  autoCloseIdleTimeoutMs: z.number().int().positive().default(60000),
  programDiscovery: z.object({
    enabled: z.boolean().default(false),
    cpu1Program: z.string().min(1).optional(),
    cpu2Program: z.string().min(1).optional(),
    searchRoots: z.array(z.string().min(1)).optional(),
    maxDepth: z.number().int().nonnegative().optional()
  }).optional(),
  cores: z.array(z.object({
    coreId: z.number().int(),
    coreName: z.string().min(1),
    corePattern: z.string().min(1).optional(),
    programUri: z.string().min(1).optional(),
    connect: z.boolean().default(true),
    load: z.boolean().default(true),
    haltAtEntry: z.boolean().default(true)
  })).min(1),
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
