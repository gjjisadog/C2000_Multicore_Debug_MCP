import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { AtomicArtifactWriter } from "../../artifacts/AtomicArtifactWriter.js";
import { SERVER_VERSION } from "../../runtimeInfo.js";
import type { VerificationCheck, VerificationArtifact, VerificationResult } from "../VerificationSchemas.js";
import type { VerificationExecutionContext } from "../VerificationResultBuilder.js";
import {
  createVerificationResult,
  incomplete,
  gateFailuresFromChecks
} from "../VerificationResultBuilder.js";
import {
  buildResultSchema,
  buildVerificationInputSchema,
  type BuildArtifact,
  type BuildDiagnostic,
  type BuildResult,
  type BuildVerificationInput
} from "./BuildSchemas.js";
import { parseBuildLog, type ParsedBuildLog } from "./BuildLogParser.js";

export interface BuildProviderRequest {
  input: BuildVerificationInput;
  artifactDirectory: string;
}

export interface BuildProviderOutput {
  status?: "PASSED" | "FAILED" | "BLOCKED" | "UNSUPPORTED" | "ERROR";
  logText?: string;
  outPath?: string;
  mapPath?: string;
  providerDiagnostics?: BuildDiagnostic[];
}

export interface BuildProvider {
  readonly id: string;
  inspect?(request: BuildProviderRequest): Promise<BuildProviderOutput> | BuildProviderOutput;
  build?(request: BuildProviderRequest): Promise<BuildProviderOutput> | BuildProviderOutput;
}

export interface ProcessBuildProviderConfig {
  id: string;
  executablePath: string;
  args: string[];
  workingDirectory?: string;
  timeoutMs?: number;
  environment?: Record<string, string>;
}

/**
 * A process provider is configured by the trusted project configuration. The
 * MCP request selects only its provider id; it cannot submit a shell command.
 */
export class ConfiguredProcessBuildProvider implements BuildProvider {
  readonly id: string;

  constructor(private readonly config: ProcessBuildProviderConfig) {
    this.id = config.id;
  }

  async build(request: BuildProviderRequest): Promise<BuildProviderOutput> {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const child = spawn(this.config.executablePath, this.config.args, {
      cwd: this.config.workingDirectory ?? request.input.projectPath,
      env: { ...process.env, ...this.config.environment },
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout?.on("data", chunk => stdout.push(Buffer.from(chunk).toString("utf8")));
    child.stderr?.on("data", chunk => stderr.push(Buffer.from(chunk).toString("utf8")));
    const timeoutMs = this.config.timeoutMs ?? 15 * 60 * 1000;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      // This is the child created by the configured provider, never a CCS or
      // DebugServer process discovered elsewhere on the host.
      child.kill();
    }, timeoutMs);
    const exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", code => resolve(code ?? 1));
    }).finally(() => clearTimeout(timeout));
    const logText = [...stdout, ...stderr].join("");
    return {
      status: timedOut ? "FAILED" : exitCode === 0 ? "PASSED" : "FAILED",
      logText,
      ...(request.input.outPath ? { outPath: request.input.outPath } : {}),
      ...(request.input.mapPath ? { mapPath: request.input.mapPath } : {}),
      ...(timedOut ? {
        providerDiagnostics: [diagnostic("build", "TIMEOUT", "TIMEOUT", `Build provider timed out after ${timeoutMs} ms`)]
      } : {})
    };
  }
}

/** Reads a previously produced log/out/map set without invoking a toolchain. */
export class ArtifactBuildProvider implements BuildProvider {
  readonly id = "artifact";

  async inspect(request: BuildProviderRequest): Promise<BuildProviderOutput> {
    if (request.input.buildLogText !== undefined) return {
      status: "PASSED",
      logText: request.input.buildLogText,
      ...(request.input.outPath ? { outPath: request.input.outPath } : {}),
      ...(request.input.mapPath ? { mapPath: request.input.mapPath } : {})
    };
    if (!request.input.buildLogPath) return { status: "UNSUPPORTED" };
    try {
      return {
        status: "PASSED",
        logText: await readFile(request.input.buildLogPath, "utf8"),
        ...(request.input.outPath ? { outPath: request.input.outPath } : {}),
        ...(request.input.mapPath ? { mapPath: request.input.mapPath } : {})
      };
    } catch (error) {
      return {
        status: "FAILED",
        logText: `Unable to read build log: ${String(error)}`,
        providerDiagnostics: [diagnostic("build", "MISSING_FILE", "MISSING_FILE", `Unable to read build log: ${String(error)}`)]
      };
    }
  }
}

export interface BuildVerifierOptions {
  rootDirectory: string;
  writer?: AtomicArtifactWriter;
  providers?: Record<string, BuildProvider>;
}

export interface BuildVerificationOutput {
  verification: VerificationResult;
  build: BuildResult;
}

export class BuildVerifier {
  private readonly writer: AtomicArtifactWriter;
  private readonly providers: Map<string, BuildProvider>;

  constructor(private readonly options: BuildVerifierOptions) {
    this.writer = options.writer ?? new AtomicArtifactWriter();
    const configured = Object.values(options.providers ?? {});
    this.providers = new Map<string, BuildProvider>([["artifact", new ArtifactBuildProvider()], ...configured.map(provider => [provider.id, provider] as const)]);
  }

  async verify(rawInput: unknown, context: VerificationExecutionContext): Promise<BuildVerificationOutput> {
    const input = buildVerificationInputSchema.parse(rawInput);
    const started = new Date();
    const provider = this.providers.get(input.providerId);
    const artifactDirectory = path.resolve(contextArtifactDirectory(context, this.options.rootDirectory));
    await this.writer.ensureDirectory(artifactDirectory);
    const checks: VerificationCheck[] = [];
    const diagnostics: VerificationResult["diagnostics"] = [];
    let providerOutput: BuildProviderOutput = { status: "UNSUPPORTED" };
    if (!provider) {
      checks.push(check("provider-available", "provider", "UNSUPPORTED", "ERROR", `Build provider is not configured: ${input.providerId}`));
      diagnostics.push({ code: "BUILD_PROVIDER_UNAVAILABLE", severity: "ERROR", message: `Build provider is not configured: ${input.providerId}`, source: input.providerId });
    } else {
      try {
        const request = { input, artifactDirectory };
        providerOutput = provider.build ? await provider.build(request) : provider.inspect ? await provider.inspect(request) : { status: "UNSUPPORTED" };
      } catch (error) {
        providerOutput = { status: "ERROR", logText: `Build provider failed: ${String(error)}`, providerDiagnostics: [diagnostic("build", "UNKNOWN", "UNKNOWN", `Build provider failed: ${String(error)}`)] };
      }
    }

    const logText = providerOutput.logText;
    const parsed = logText === undefined ? emptyParsedLog() : parseBuildLog(logText);
    if (logText !== undefined) {
      const logPath = path.join(artifactDirectory, "logs", "build.log");
      await this.writer.writeText(logPath, logText);
    }
    const logArtifact = logText === undefined ? null : await artifactFor(path.join(artifactDirectory, "logs", "build.log"), "log");
    const outPath = providerOutput.outPath ?? input.outPath;
    const mapPath = providerOutput.mapPath ?? input.mapPath;
    const outArtifact = outPath ? await artifactFor(outPath, "out") : null;
    const mapArtifact = mapPath ? await artifactFor(mapPath, "map") : null;
    const buildId = buildIdFor(input, parsed, outArtifact, mapArtifact, logArtifact);
    const withBuildId = (artifact: BuildArtifact | null): BuildArtifact | null => artifact ? { ...artifact, buildId } : null;
    const artifacts = {
      out: withBuildId(outArtifact),
      map: withBuildId(mapArtifact),
      log: withBuildId(logArtifact)
    };
    const errors = [...parsed.errors, ...(providerOutput.providerDiagnostics ?? [])].filter(item => item.category !== "UNKNOWN" || providerOutput.status === "FAILED" || providerOutput.status === "ERROR");
    const warnings = parsed.warnings;
    if (provider) checks.push(check("provider-available", "provider", "PASSED", "INFO", `Build provider selected: ${provider.id}`));
    if (providerOutput.status === "UNSUPPORTED") checks.push(check("build-provider-support", "provider", "UNSUPPORTED", "ERROR", `Build provider ${input.providerId} did not provide build evidence`));
    else checks.push(check("build-log-parsed", "diagnostics", errors.length === 0 ? "PASSED" : "FAILED", errors.length === 0 ? "INFO" : "CRITICAL", errors.length === 0 ? "Build log contains no errors" : `Build log contains ${errors.length} error(s)`, { expected: 0, actual: errors.length }));
    checks.push(parsed.complete
      ? check("build-log-complete", "diagnostics", "PASSED", "INFO", "Complete build log evidence is present")
      : check("build-log-complete", "diagnostics", "BLOCKED", "CRITICAL", "Complete build log evidence is missing", { expected: "non-empty build log", actual: logText ?? null }));
    if (input.outPath) checks.push(fileCheck("out-artifact", outArtifact, "out"));
    if (input.mapPath) checks.push(fileCheck("map-artifact", mapArtifact, "map"));
    const ended = new Date();
    const status = providerOutput.status === "UNSUPPORTED" ? "UNSUPPORTED"
      : providerOutput.status === "BLOCKED" ? "BLOCKED"
      : !parsed.complete ? "BLOCKED"
      : errors.length > 0 || providerOutput.status === "FAILED" ? "FAILED"
        : providerOutput.status === "ERROR" ? "ERROR"
          : "PASSED";
    const identity = {
      ...context.identity,
      project: input.projectPath ?? input.project ?? context.identity?.project ?? null,
      target: input.target,
      configuration: input.configuration,
      device: input.device ?? context.identity?.device ?? null,
      ccsVersion: input.ccsVersion ?? context.identity?.ccsVersion ?? null,
      compilerVersion: input.compilerVersion ?? context.identity?.compilerVersion ?? null,
      abi: input.abi ?? context.identity?.abi ?? null,
      gitCommit: input.gitCommit ?? context.identity?.commitSha ?? null,
      sourceIdentity: input.sourceIdentity ?? context.identity?.sourceIdentity ?? null,
      toolVersion: SERVER_VERSION,
      startedAt: started.toISOString(),
      endedAt: ended.toISOString()
    };
    const build = buildResultSchema.parse({
      schemaVersion: 1,
      status,
      stage: parsed.stage,
      target: input.target,
      configuration: input.configuration,
      errors,
      warnings,
      counts: { errors: errors.length, warnings: warnings.length },
      artifacts,
      durationMs: Math.max(0, ended.getTime() - started.getTime()),
      identity,
      providerId: input.providerId,
      logComplete: parsed.complete
    });
    const completeness = logArtifact && parsed.complete
      ? { status: "COMPLETE" as const, reason: null, requiredArtifacts: ["build.log"], presentArtifacts: [outArtifact, mapArtifact, logArtifact].filter((artifact): artifact is BuildArtifact => artifact !== null).map(artifact => artifact.path) }
      : incomplete("BUILD_LOG_MISSING");
    const hardGateFailures = gateFailuresFromChecks("build", checks);
    const verification = createVerificationResult({
      context: { ...context, identity: identityForVerification(identity) },
      verifierType: "build",
      status,
      startedAt: started.toISOString(),
      endedAt: ended.toISOString(),
      checks,
      diagnostics,
      artifacts: [outArtifact, mapArtifact, logArtifact]
        .filter((artifact): artifact is BuildArtifact => artifact !== null)
        .map(artifact => verificationArtifactFromBuildArtifact(artifact)),
      completeness,
      hardGateFailures,
      inputs: {
        providerId: input.providerId,
        target: input.target,
        configuration: input.configuration,
        ...(input.projectPath ? { projectPath: input.projectPath } : {}),
        ...(input.outPath ? { outPath: input.outPath } : {}),
        ...(input.mapPath ? { mapPath: input.mapPath } : {})
      },
      details: { build }
    });
    return { verification, build };

    async function artifactFor(filePath: string, kind: BuildArtifact["kind"]): Promise<BuildArtifact | null> {
      try {
        const [metadata, bytes] = await Promise.all([stat(filePath), readFile(filePath)]);
        if (!metadata.isFile()) return null;
        return { path: path.resolve(filePath), kind, sha256: createHash("sha256").update(bytes).digest("hex"), size: metadata.size, mtimeMs: metadata.mtimeMs };
      } catch {
        return null;
      }
    }
  }
}

function contextArtifactDirectory(context: VerificationExecutionContext, rootDirectory: string): string {
  if (contextArtifactPath(context)) return contextArtifactPath(context)!;
  return path.join(path.resolve(rootDirectory), "verification", safePath(context.verificationId));
}

function contextArtifactPath(context: VerificationExecutionContext): string | undefined {
  const value = (context as VerificationExecutionContext & { artifactDirectory?: unknown }).artifactDirectory;
  return typeof value === "string" ? value : undefined;
}

function safePath(value: string): string {
  return value.split("/").map(part => part.replace(/[^A-Za-z0-9._-]/g, "_")).filter(Boolean).join(path.sep);
}

function emptyParsedLog(): ParsedBuildLog {
  return { stage: "unknown", errors: [], warnings: [], lines: 0, complete: false };
}

function buildIdFor(input: BuildVerificationInput, parsed: ParsedBuildLog, out: BuildArtifact | null, map: BuildArtifact | null, log: BuildArtifact | null): string {
  return `build-${createHash("sha256").update(JSON.stringify({
    project: input.projectPath ?? input.project ?? null,
    target: input.target,
    configuration: input.configuration,
    providerId: input.providerId,
    stage: parsed.stage,
    out: out?.sha256 ?? null,
    map: map?.sha256 ?? null,
    log: log?.sha256 ?? null
  })).digest("hex").slice(0, 24)}`;
}

function check(
  id: string,
  category: string,
  status: VerificationCheck["status"],
  severity: VerificationCheck["severity"],
  message: string,
  values: { expected?: unknown; actual?: unknown } = {}
): VerificationCheck {
  return { id, category, status, severity, message, ...values };
}

function fileCheck(id: string, artifact: BuildArtifact | null, kind: string): VerificationCheck {
  return artifact
    ? check(id, "artifact", "PASSED", "INFO", `${kind} artifact is present`, { actual: artifact.path })
    : check(id, "artifact", "FAILED", "CRITICAL", `${kind} artifact is missing`, { expected: "file", actual: null });
}

function diagnostic(tool: string, category: BuildDiagnostic["category"], code: string | null, message: string): BuildDiagnostic {
  return { tool, code, category, message, file: null, line: null, column: null, raw: message };
}

function verificationArtifactFromBuildArtifact(artifact: BuildArtifact): VerificationArtifact {
  return {
    path: artifact.path,
    artifactType: `build:${artifact.kind}`,
    sha256: artifact.sha256,
    size: artifact.size,
    mtimeMs: artifact.mtimeMs,
    completeness: "COMPLETE",
    role: artifact.kind === "log" ? "evidence" : "build-output"
  };
}

function identityForVerification(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null));
}
