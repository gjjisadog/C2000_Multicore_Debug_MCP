import { z } from "zod";
import { coreConfigSchema } from "../mcp/toolSchemas.js";

export const c2000McpConfigSchema = z.object({
  toolProfile: z.enum(["readonly", "safe", "full"]).default("safe"),
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
  logging: z.object({
    level: z.enum(["debug", "info", "warn", "error"]).default("info"),
    logFile: z.string().optional()
  }).default({ level: "info" }),
  filesystem: z.object({
    allowedReadRoots: z.array(z.string().min(1)).default([]),
    allowedWriteRoots: z.array(z.string().min(1)).default([])
  }).default({ allowedReadRoots: [], allowedWriteRoots: [] }),
  debugProbe: z.object({
    queueDir: z.string().min(1).default("runtime/debug-probe-queue"),
    queueTimeoutMs: z.number().int().positive().default(600000),
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
  }).default({ queueDir: "runtime/debug-probe-queue", queueTimeoutMs: 600000, recoveryPolicy: "owned-and-stale", multiBoardEnabled: false })
});

export type C2000McpConfig = z.infer<typeof c2000McpConfigSchema>;
