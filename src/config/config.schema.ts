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
  }).default({ allowedReadRoots: [], allowedWriteRoots: [] })
});

export type C2000McpConfig = z.infer<typeof c2000McpConfigSchema>;
