import { z } from "zod";
import { coreConfigSchema } from "../mcp/toolSchemas.js";
import { verificationConfigSchema } from "../verification/VerificationConfigSchemas.js";
import { skillEvolutionConfigSchema } from "../evolution/EvolutionSchemas.js";
import { reviewPolicyConfigSchema } from "../improvement/review/ReviewSchemas.js";

const boardConfigSchema = z.object({
  boardId: z.string().min(1),
  probeSerial: z.string().min(1),
  device: z.string().min(1).default("F28P65x"),
  ccxmlPath: z.string().min(1),
  tags: z.array(z.string().min(1)).default([])
});

const improvementCodingAgentConfigSchema = z.object({
  provider: z.string().trim().min(1).max(128).default("configured-agent"),
  command: z.string().trim().min(1).max(1024).optional(),
  args: z.array(z.string().max(2048)).max(64).default([]),
  timeoutMs: z.number().int().min(1_000).max(60 * 60 * 1000).default(15 * 60 * 1000)
});

export const improvementConfigSchema = z.object({
  /** Disabled by default until an administrator configures an agent command. */
  enabled: z.boolean().default(false),
  repositoryRoot: z.string().trim().min(1).optional(),
  worktreeRoot: z.string().trim().min(1).default("../.c2000-improvement-worktrees"),
  artifactRoot: z.string().trim().min(1).default("./runtime/improvement-artifacts"),
  baseRef: z.string().regex(/^[A-Za-z0-9._/-]+$/).default("master"),
  maxActiveRuns: z.number().int().positive().max(8).default(1),
  codingAgent: improvementCodingAgentConfigSchema.default({}),
  review: reviewPolicyConfigSchema.default({})
});

export const c2000McpConfigSchema = z.object({
  toolProfile: z.enum(["readonly", "safe", "full"]).default("safe"),
  toolSurfaceProfile: z.enum(["agent", "advanced", "compatibility"]).default("agent"),
  adapter: z.enum(["auto", "mock", "ccs"]).default("auto"),
  ccs: z.object({
    installPath: z.string().optional(),
    c2000WarePath: z.string().optional(),
    workspacePath: z.string().optional(),
    ccxmlPath: z.string().optional(),
    dssTimeoutMs: z.number().int().positive().optional(),
    timeouts: z.object({
      startupMs: z.number().int().positive().default(60000),
      connectMs: z.number().int().positive().default(30000),
      stateReadMs: z.number().int().positive().default(5000),
      expressionReadMs: z.number().int().positive().default(5000),
      addressResolveMs: z.number().int().positive().default(5000),
      resetMs: z.number().int().positive().default(30000),
      programLoadMs: z.number().int().positive().default(300000),
      memoryWriteMs: z.number().int().positive().default(10000),
      shutdownRequestMs: z.number().int().positive().default(3000),
      processExitMs: z.number().int().positive().default(5000)
    }).default({}),
    scriptingMode: z.enum(["auto", "mock", "ccs"]).default("auto")
  }).default({ scriptingMode: "auto" }),
  target: z.object({
    name: z.string().default("F28P65x"),
    coreMap: z.array(coreConfigSchema).min(1)
  }),
  /** Optional roots used by host-only CPU1/CPU2 .out discovery. */
  programSearchRoots: z.array(z.string().min(1)).optional(),
  diagnostics: z.object({
    cpu1BootExpressions: z.array(z.string().min(1)).optional(),
    cpu2BootExpressions: z.array(z.string().min(1)).optional()
  }).default({}),
  logging: z.object({
    level: z.enum(["debug", "info", "warn", "error"]).default("info"),
    logFile: z.string().optional()
  }).default({ level: "info" }),
  filesystem: z.object({
    allowedReadRoots: z.array(z.string().min(1)).default([]),
    allowedWriteRoots: z.array(z.string().min(1)).default([])
  }).default({ allowedReadRoots: [], allowedWriteRoots: [] }),
  verification: verificationConfigSchema.default({}),
  skillEvolution: skillEvolutionConfigSchema.default({}),
  improvement: improvementConfigSchema.optional(),
  debugProbe: z.object({
    queueDir: z.string().min(1).default("runtime/debug-probe-queue"),
    queueTimeoutMs: z.number().int().positive().default(600000),
    /** Host-side preflight/recovery envelope included in the outer worker timeout. */
    startupPreparationMs: z.number().int().positive().default(90000),
    recoveryPolicy: z.enum(["block", "owned-and-stale", "terminate-external"]).default("owned-and-stale"),
    multiBoardEnabled: z.boolean().default(false),
    probes: z.array(z.object({
      probeId: z.string().min(1),
      serialNumber: z.string().min(1),
      ccxmlPath: z.string().min(1),
      enabled: z.boolean().default(true)
    })).optional()
  }).superRefine((value, context) => {
    if (value.multiBoardEnabled && (value.probes?.filter(probe => probe.enabled).length ?? 0) < 2) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "multiBoardEnabled requires at least two enabled probes", path: ["probes"] });
    }
  }).default({ queueDir: "runtime/debug-probe-queue", queueTimeoutMs: 600000, startupPreparationMs: 90000, recoveryPolicy: "owned-and-stale", multiBoardEnabled: false }),
  /** Optional in the output type so existing programmatic configs remain valid. loadConfig supplies safe defaults. */
  daemon: z.object({
    enabled: z.boolean().default(true),
    host: z.literal("127.0.0.1").default("127.0.0.1"),
    port: z.number().int().min(0).max(65535).default(0),
    runtimeDir: z.string().min(1).default("./runtime"),
    autoStart: z.boolean().default(true),
    startupTimeoutMs: z.number().int().positive().default(15000)
  }).optional(),
  storage: z.object({
    sqlitePath: z.string().min(1).default("./runtime/c2000-debugd.sqlite"),
    wal: z.boolean().default(true)
  }).optional(),
  workers: z.object({
    heartbeatIntervalMs: z.number().int().positive().default(1000),
    heartbeatTimeoutMs: z.number().int().positive().default(5000),
    defaultCommandTimeoutMs: z.number().int().positive().default(60000),
    restartLimit: z.number().int().nonnegative().default(5),
    restartWindowMs: z.number().int().positive().default(60000)
  }).optional(),
  scheduler: z.object({
    maxActiveJobs: z.number().int().positive().default(16),
    maxParallelBoards: z.number().int().positive().default(4),
    agingThresholdMs: z.number().int().nonnegative().default(30000),
    starvationTimeoutMs: z.number().int().positive().default(300000),
    pollIntervalMs: z.number().int().positive().default(250)
  }).optional(),
  canAdapters: z.array(z.object({
    adapterId: z.string().min(1),
    type: z.literal("pcan-basic"),
    channel: z.string().regex(/^PCAN_USBBUS(?:[1-9]|1[0-6])$/),
    bitrate: z.union([z.literal(125000), z.literal(250000), z.literal(500000), z.literal(1000000)]),
    libraryPath: z.string().min(1).optional(),
    receivePollIntervalMs: z.number().int().positive().default(1),
    captureBufferFrames: z.number().int().positive().default(100000),
    busOffRecovery: z.enum(["manual", "reinitialize"]).default("manual")
  })).optional(),
  boards: z.array(boardConfigSchema).optional()
});

export type C2000McpConfig = z.infer<typeof c2000McpConfigSchema>;
