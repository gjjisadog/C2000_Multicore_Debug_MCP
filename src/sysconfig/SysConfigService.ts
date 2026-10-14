import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { z } from "zod";
import type { ResolveTiEnvironmentOptions } from "../config/tiPaths.js";
import { resolveTiEnvironment } from "../config/tiPaths.js";
import { assertAllowedReadPath, assertAllowedWritePath, type FilesystemPolicy } from "../security/pathPolicy.js";
import { DebugMcpError } from "../utils/errors.js";
import { inspectSysConfigSchema, updateSysConfigSchema, sysConfigConfigSchema, type InspectSysConfigInput, type UpdateSysConfigInput } from "./SysConfigSchemas.js";
import { changesScript, inspectionScript } from "./scripts.js";

const runFile = promisify(execFile);
const hash = (source: string) => createHash("sha256").update(source).digest("hex");
const activeEdits = new Set<string>();

export interface SysConfigServiceOptions {
  filesystem: FilesystemPolicy;
  tiEnvironment?: ResolveTiEnvironmentOptions;
  config?: z.input<typeof sysConfigConfigSchema>;
}

/** Host-only .syscfg editing through TI's CLI, independent of CCS/JTAG. */
export class SysConfigService {
  constructor(private readonly options: SysConfigServiceOptions) {}

  async inspect(raw: z.input<typeof inspectSysConfigSchema>): Promise<Record<string, unknown>> {
    const input = inspectSysConfigSchema.parse(raw);
    const file = await this.sourceFile(input.syscfgPath);
    const source = await this.readSource(file);
    const result = await this.validate(input, file);
    if (await this.readSource(file) !== source) throw this.conflict(file);
    return { syscfgPath: file, sha256: hash(source), ...result, backend: "ti-sysconfig-cli", requiresCcs: false };
  }

  async update(raw: z.input<typeof updateSysConfigSchema>): Promise<Record<string, unknown>> {
    const input = updateSysConfigSchema.parse(raw);
    const file = await this.sourceFile(input.syscfgPath);
    await assertAllowedWritePath(file, this.options.filesystem);
    if (activeEdits.has(file)) throw new DebugMcpError("SysConfigBusy", "Another SysConfig edit is in progress", { syscfgPath: file });
    activeEdits.add(file);
    let pending: string | undefined;
    try {
      const source = await this.readSource(file);
      if (hash(source) !== input.expectedSha256.toLowerCase()) throw this.conflict(file);
      const suffix = changesScript(input.changes);
      const selected = input.instances ?? [...new Map(input.changes.map(change => [
        JSON.stringify([change.moduleId, change.moduleInstanceId]),
        { moduleId: change.moduleId, moduleInstanceId: change.moduleInstanceId }
      ])).values()];
      const instances = selected.map(ref => {
        let moduleInstanceId = ref.moduleInstanceId;
        for (const change of input.changes) {
          if (change.moduleId === ref.moduleId && change.moduleInstanceId === ref.moduleInstanceId && change.configurable === "$name" && typeof change.value === "string") moduleInstanceId = change.value;
        }
        return { ...ref, moduleInstanceId };
      });
      const updated = source + suffix;
      if (Buffer.byteLength(updated, "utf8") > 1024 * 1024) throw new DebugMcpError("SysConfigInvalidInput", "Updated SysConfig would exceed the 1 MiB input limit");
      const validation = await this.validate({ ...input, instances }, file, suffix);
      if (!input.dryRun) {
        pending = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
        await writeFile(pending, updated, { flag: "wx", mode: (await stat(file)).mode });
        // Recheck both the allowlist and bytes after the slow official engine run.
        if (await this.sourceFile(input.syscfgPath) !== file || await this.readSource(file) !== source) throw this.conflict(file);
        await assertAllowedWritePath(file, this.options.filesystem);
        await rename(pending, file);
      } else if (await this.readSource(file) !== source) throw this.conflict(file);
      return {
        syscfgPath: file, backend: "ti-sysconfig-cli", requiresCcs: false,
        saved: !input.dryRun, dryRun: input.dryRun, sha256: input.dryRun ? hash(source) : hash(updated),
        proposedSha256: hash(updated), changes: input.changes, ...validation,
        requiresRebuild: !input.dryRun,
        nextAction: "Regenerate project artifacts with the normal project build before loading firmware. If this file is open in an editor, reload it from disk first."
      };
    } finally {
      activeEdits.delete(file);
      if (pending) await rm(pending, { force: true });
    }
  }

  private async sourceFile(candidate: string): Promise<string> {
    const file = await assertAllowedReadPath(candidate, this.options.filesystem);
    if (path.extname(file).toLowerCase() !== ".syscfg") throw new DebugMcpError("SysConfigInvalidInput", "Expected an existing .syscfg configuration file", { syscfgPath: file });
    return file;
  }

  private async readSource(file: string): Promise<string> {
    const info = await stat(file);
    if (!info.isFile() || info.size > 1024 * 1024) throw new DebugMcpError("SysConfigInvalidInput", "SysConfig input must be a file of at most 1 MiB", { syscfgPath: file });
    return readFile(file, "utf8");
  }

  private conflict(file: string): DebugMcpError {
    return new DebugMcpError("SysConfigConflict", "Configuration changed; inspect it again before saving", { syscfgPath: file, saved: false });
  }

  private async validate(input: InspectSysConfigInput | UpdateSysConfigInput, file: string, suffix = ""): Promise<Record<string, unknown>> {
    const config = sysConfigConfigSchema.parse(this.options.config ?? {});
    const environment = await resolveTiEnvironment(this.options.tiEnvironment);
    const cliPath = config.cliPath ?? await this.discoverCli(environment.ccs.path);
    const product = input.productPath ?? (environment.c2000Ware.path ? path.join(environment.c2000Ware.path, ".metadata", "sdk.json") : undefined);
    if (!product) throw new DebugMcpError("SysConfigUnavailable", "Configure C2000Ware or provide productPath for the official SysConfig CLI");
    const productPath = await assertAllowedReadPath(product, this.options.filesystem);
    const directory = await mkdtemp(path.join(os.tmpdir(), "c2000-sysconfig-"));
    try {
      const marker = `C2000_SYSCONFIG_${randomUUID()}:`;
      const dependent = path.join(directory, "operation.syscfg");
      await writeFile(dependent, suffix + inspectionScript(input, marker));
      const args = [cliPath, "--product", productPath, "--script", file];
      // TI associates script-specific options (including context) with the
      // preceding --script and rejects --script after those options.
      for (const key of ["device", "package", "part", "context"] as const) {
        if (input[key]) args.push(`--${key}`, input[key]!);
      }
      args.push("--dependentScript", dependent, "--output", directory);
      let stdout: string, stderr: string;
      try {
        ({ stdout, stderr } = await runFile(config.nodePath ?? process.execPath, args, {
          cwd: path.dirname(file), timeout: config.timeoutMs, maxBuffer: 4 * 1024 * 1024,
          encoding: "utf8", windowsHide: true
        }));
      } catch (error) {
        const failure = error as Error & { stdout?: string; stderr?: string; killed?: boolean };
        throw new DebugMcpError("SysConfigValidationFailed", "TI SysConfig rejected the configuration or could not complete validation; no configuration was saved", {
          syscfgPath: file, saved: false, message: failure.message,
          stdout: failure.stdout?.slice(-16000), stderr: failure.stderr?.slice(-16000), timedOut: failure.killed === true
        });
      }
      const line = stdout.split(/\r?\n/).find(line => line.startsWith(marker));
      if (!line) throw new DebugMcpError("SysConfigValidationFailed", "Official CLI returned no configuration snapshot; no configuration was saved", { saved: false });
      const snapshot = JSON.parse(line.slice(marker.length)) as Record<string, unknown>;
      const generatedFiles = (await readdir(directory, { recursive: true, withFileTypes: true }))
        .filter(entry => entry.isFile() && entry.name !== "operation.syscfg")
        .map(entry => path.relative(directory, path.join(entry.parentPath, entry.name)));
      return { ...snapshot, validation: { passed: true, cliPath, generatedFiles, diagnostics: [stdout.split(/\r?\n/).filter(line => !line.startsWith(marker)).join("\n"), stderr].filter(Boolean).join("\n").slice(-16000), artifactsPublished: false } };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private async discoverCli(ccsPath?: string): Promise<string> {
    if (ccsPath) {
      const utils = path.join(ccsPath, "utils");
      const versions = await readdir(utils).catch(() => [] as string[]);
      versions.sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
      for (const version of versions.filter(name => /^sysconfig_\d/.test(name))) {
        const cli = path.join(utils, version, "dist", "cli.js");
        try { await access(cli); return cli; } catch { /* Try the next installed version. */ }
      }
    }
    throw new DebugMcpError("SysConfigUnavailable", "Official SysConfig CLI not found; configure sysconfig.cliPath or install CCS/SysConfig");
  }
}
