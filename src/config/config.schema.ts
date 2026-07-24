import { z } from "zod";
import { coreConfigSchema } from "../mcp/toolSchemas.js";

const boardConfigSchema = z.object({
  boardId: z.string().min(1),
  probeSerial: z.string().min(1),
  device: z.string().min(1).default("F28P65x"),
  ccxmlPath: z.string().min(1),
  tags: z.array(z.string().min(1)).default([])
});

export const c2000McpConfigSchema = z.object({
  adapter: z.enum(["auto", "mock", "ccs"]).default("auto"),
  ccs: z.object({
    installPath: z.string().optional(),
    workspacePath: z.string().optional(),
    ccxmlPath: z.string().optional(),
    dssTimeoutMs: z.number().int().positive().optional(),
    scriptingMode: z.enum(["auto", "mock", "ccs"]).default("auto")
  }).default({ scriptingMode: "auto" }),
  target: z.object({
    name: z.string().default("F28P65x"),
    coreMap: z.array(coreConfigSchema).min(1)
  }),
  diagnostics: z.object({
    cpu1BootExpressions: z.array(z.string().min(1)).optional(),
    cpu2BootExpressions: z.array(z.string().min(1)).optional()
  }).default({}),
  logging: z.object({
    level: z.enum(["debug", "info", "warn", "error"]).default("info"),
    logFile: z.string().optional()
  }).default({ level: "info" }),
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
    defaultCommandTimeoutMs: z.number().int().positive().default(15000),
    restartLimit: z.number().int().nonnegative().default(5),
    restartWindowMs: z.number().int().positive().default(60000)
  }).optional(),
  scheduler: z.object({
    maxParallelBoards: z.number().int().positive().default(4),
    pollIntervalMs: z.number().int().positive().default(250)
  }).optional(),
  boards: z.array(boardConfigSchema).optional()
});

export type C2000McpConfig = z.infer<typeof c2000McpConfigSchema>;
