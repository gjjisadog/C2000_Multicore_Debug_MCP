import { z } from "zod";

const moduleId = z.string().min(1).max(256).regex(/^\/[A-Za-z0-9_./-]+$/)
  .refine(value => !value.split("/").includes(".."), "Module ID must not contain parent traversal");
const instanceId = z.string().min(1).max(256);
const configurable = z.string().min(1).max(256)
  .regex(/^(?:[A-Za-z_][A-Za-z0-9_]*|\$name|\$assign)(?:\.(?:[A-Za-z_][A-Za-z0-9_]*|\$assign)|\[\d+\])*$/)
  .refine(value => !value.split(/[.\[\]]/).some(part => ["__proto__", "prototype", "constructor"].includes(part)), "Unsafe configurable path");

export const sysConfigInstanceSchema = z.object({ moduleId, moduleInstanceId: instanceId }).strict();
export const sysConfigChangeSchema = sysConfigInstanceSchema.extend({
  configurable,
  value: z.union([
    z.string().max(4096), z.number().finite(), z.boolean(),
    z.array(z.string().max(4096)).max(256), z.array(z.number().finite()).max(256),
    sysConfigInstanceSchema
  ])
}).strict();

const sysConfigInput = z.object({
  syscfgPath: z.string().min(1).max(4096).describe("Existing .syscfg file; never a generated C/H file."),
  productPath: z.string().min(1).max(4096).optional().describe("SDK .metadata/sdk.json; defaults to configured C2000Ware."),
  device: z.string().min(1).max(128).optional(),
  package: z.string().min(1).max(128).optional(),
  part: z.string().min(1).max(128).optional(),
  context: z.string().min(1).max(128).optional().describe("Explicit SysConfig core/context, for example CPU1 or CPU2."),
  instances: z.array(sysConfigInstanceSchema).max(32).optional(),
  configurableIds: z.array(configurable).max(128).optional()
}).strict();

export const inspectSysConfigSchema = sysConfigInput.extend({
  moduleIds: z.array(moduleId).max(32).optional().describe("Filter module discovery. Pass instances to read configurable values and choices.")
}).strict();

export const updateSysConfigSchema = sysConfigInput.extend({
  changes: z.array(sysConfigChangeSchema).min(1).max(128),
  expectedSha256: z.string().regex(/^[a-fA-F0-9]{64}$/).describe("SHA-256 returned by inspect; prevents overwriting a changed file."),
  dryRun: z.boolean().default(true).describe("Preview and validate by default. Set false to atomically save the validated .syscfg.")
}).strict();

export const sysConfigConfigSchema = z.object({
  cliPath: z.string().min(1).optional().describe("Trusted path to SysConfig dist/cli.js; otherwise discovered under CCS utils."),
  nodePath: z.string().min(1).optional().describe("Trusted Node executable; defaults to this server's Node."),
  timeoutMs: z.number().int().min(1000).max(300000).default(60000)
}).strict();

export type InspectSysConfigInput = z.infer<typeof inspectSysConfigSchema>;
export type UpdateSysConfigInput = z.infer<typeof updateSysConfigSchema>;
export type SysConfigChange = z.infer<typeof sysConfigChangeSchema>;
