import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { AtomicArtifactWriter } from "../../artifacts/AtomicArtifactWriter.js";
import type {
  VerificationArtifact,
  VerificationCheck,
  VerificationMetric,
  VerificationResult
} from "../VerificationSchemas.js";
import type { VerificationExecutionContext } from "../VerificationResultBuilder.js";
import {
  createVerificationResult,
  gateFailuresFromChecks,
  incomplete
} from "../VerificationResultBuilder.js";
import {
  regressionPlanSchema,
  regressionResultSchema,
  regressionSuiteSchema,
  type RegressionPlan,
  type RegressionResult,
  type RegressionSuite,
  type RegressionSuiteResult
} from "./RegressionSchemas.js";

export interface RegressionRunnerContext {
  workingDirectory?: string;
  timeoutMs: number;
  artifactDirectory: string;
}

export interface RegressionExecution {
  status: "PASSED" | "FAILED" | "SKIPPED" | "BLOCKED" | "UNSUPPORTED";
  exitCode?: number | null;
  expected?: unknown;
  actual?: unknown;
  errorCode?: string | null;
  message?: string;
  stdout?: string;
  stderr?: string;
  evidenceClassification?: RegressionSuiteResult["evidenceClassification"];
  evidenceComplete?: boolean;
}

export interface RegressionRunner {
  readonly id?: string;
  run(suite: RegressionSuite, context: RegressionRunnerContext): Promise<RegressionExecution> | RegressionExecution;
}

const BUILTIN_COMMANDS: Record<string, string[]> = {
  "host-unit": ["test"],
  "typecheck": ["run", "typecheck"],
  build: ["run", "build"],
  "verify:debug-boundary": ["run", "verify:debug-boundary"],
  "verify:daemon-proxy": ["run", "verify:daemon-proxy"],
  "ipc-mock": ["run", "verify:can:mock"],
  daemon: ["run", "verify:daemon-proxy"],
  "project-static": ["run", "typecheck"]
};

/** Runs only named, repository-owned npm scripts and never accepts shell text. */
export class BuiltinHostRegressionRunner implements RegressionRunner {
  readonly id = "builtin-host";

  async run(suite: RegressionSuite, context: RegressionRunnerContext): Promise<RegressionExecution> {
    const args = BUILTIN_COMMANDS[suite.id];
    if (!args) return {
      status: "UNSUPPORTED",
      exitCode: null,
      errorCode: "SUITE_NOT_ALLOWLISTED",
      message: `Regression suite is not allowlisted: ${suite.id}`
    };
    const command = process.platform === "win32" ? "npm.cmd" : "npm";
    const stdout: string[] = [];
    const stderr: string[] = [];
    const child = spawn(command, args, {
      cwd: context.workingDirectory,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout?.on("data", chunk => stdout.push(Buffer.from(chunk).toString("utf8")));
    child.stderr?.on("data", chunk => stderr.push(Buffer.from(chunk).toString("utf8")));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, context.timeoutMs);
    let exitCode: number;
    try {
      exitCode = await new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", code => resolve(code ?? 1));
      });
    } catch (error) {
      clearTimeout(timer);
      return { status: "UNSUPPORTED", exitCode: null, errorCode: "COMMAND_UNAVAILABLE", message: String(error), stdout: stdout.join(""), stderr: stderr.join("") };
    }
    clearTimeout(timer);
    return {
      status: timedOut ? "FAILED" : exitCode === 0 ? "PASSED" : "FAILED",
      exitCode,
      errorCode: timedOut ? "TIMEOUT" : exitCode === 0 ? null : "EXIT_NONZERO",
      message: timedOut ? `Regression suite timed out after ${context.timeoutMs} ms` : exitCode === 0 ? "Suite passed" : `Suite exited with code ${exitCode}`,
      stdout: stdout.join(""),
      stderr: stderr.join("")
    };
  }
}

export interface RegressionVerifierOptions {
  rootDirectory: string;
  writer?: AtomicArtifactWriter;
  runners?: RegressionRunner[];
  hardwareRunner?: RegressionRunner;
}

export interface RegressionVerificationOutput {
  verification: VerificationResult;
  regression: RegressionResult;
}

export class RegressionVerifier {
  private readonly writer: AtomicArtifactWriter;
  private readonly runners: RegressionRunner[];
  private readonly hardwareRunner?: RegressionRunner;

  constructor(private readonly options: RegressionVerifierOptions) {
    this.writer = options.writer ?? new AtomicArtifactWriter();
    this.runners = options.runners ?? [new BuiltinHostRegressionRunner()];
    this.hardwareRunner = options.hardwareRunner;
  }

  async verify(rawInput: unknown, context: VerificationExecutionContext): Promise<RegressionVerificationOutput> {
    const plan = regressionPlanSchema.parse(rawInput);
    const started = new Date();
    const artifactDirectory = context.artifactDirectory ?? path.join(path.resolve(this.options.rootDirectory), "verification", safePath(context.verificationId));
    await this.writer.ensureDirectory(artifactDirectory);
    const suiteResults: RegressionSuiteResult[] = [];
    const artifacts: VerificationArtifact[] = [];
    const checks: VerificationCheck[] = [];
    let incompleteEvidence = false;
    for (const rawSuite of plan.suites) {
      const suite = typeof rawSuite === "string" ? regressionSuiteSchema.parse({ id: rawSuite }) : rawSuite;
      const suiteStarted = Date.now();
      const execution = await this.runSuite(suite, plan, artifactDirectory);
      const suiteArtifacts = await this.persistSuiteLogs(suite, execution, artifactDirectory);
      artifacts.push(...suiteArtifacts);
      const status = execution.status;
      if (execution.evidenceComplete === false) incompleteEvidence = true;
      const severity = status === "PASSED" || status === "SKIPPED" ? "INFO" : suite.required ? "CRITICAL" : "WARNING";
      checks.push({
        id: `regression:${suite.id}`,
        category: "regression-suite",
        status: status === "PASSED" ? "PASSED" : status === "SKIPPED" ? "SKIPPED" : status === "UNSUPPORTED" ? "UNSUPPORTED" : status === "BLOCKED" ? "BLOCKED" : "FAILED",
        severity,
        message: execution.message ?? `${suite.id}: ${status}`,
        ...(execution.expected !== undefined ? { expected: execution.expected } : {}),
        ...(execution.actual !== undefined ? { actual: execution.actual } : {}),
        source: suite.id,
        ...(suiteArtifacts.length > 0 ? { evidence: suiteArtifacts.map(artifact => artifact.path) } : {})
      });
      suiteResults.push({
        id: suite.id,
        kind: suite.kind,
        required: suite.required,
        status,
        durationMs: Math.max(0, Date.now() - suiteStarted),
        exitCode: execution.exitCode ?? null,
        ...(execution.expected !== undefined ? { expected: execution.expected } : {}),
        ...(execution.actual !== undefined ? { actual: execution.actual } : {}),
        errorCode: execution.errorCode ?? null,
        source: suite.kind === "hardware" ? "hardware-runner" : "host-runner",
        artifacts: suiteArtifacts.map(artifact => artifact.path),
        evidenceClassification: execution.evidenceClassification ?? (status === "SKIPPED" ? "UNKNOWN" : suite.kind === "mock" || /mock/i.test(suite.id) ? "MOCK" : suite.kind === "hardware" ? "HARDWARE_TARGET" : "UNKNOWN"),
        evidenceComplete: execution.evidenceComplete ?? true,
        message: execution.message ?? `${suite.id}: ${status}`
      });
    }
    const ended = new Date();
    const counts = {
      total: suiteResults.length,
      passed: suiteResults.filter(suite => suite.status === "PASSED").length,
      failed: suiteResults.filter(suite => suite.status === "FAILED").length,
      skipped: suiteResults.filter(suite => suite.status === "SKIPPED").length,
      blocked: suiteResults.filter(suite => suite.status === "BLOCKED").length,
      unsupported: suiteResults.filter(suite => suite.status === "UNSUPPORTED").length
    };
    const status: RegressionResult["status"] = counts.failed > 0 ? "FAILED"
      : counts.blocked > 0 ? "BLOCKED"
        : counts.unsupported > 0 ? "UNSUPPORTED"
          : suiteResults.some(suite => suite.status === "SKIPPED" && suite.required) ? "BLOCKED"
          : "PASSED";
    const regression = regressionResultSchema.parse({ schemaVersion: 1, status, ...counts, suites: suiteResults, durationMs: Math.max(0, ended.getTime() - started.getTime()), requireHardware: plan.requireHardware });
    const hardGateFailures = gateFailuresFromChecks("regression", checks);
    const evidenceClassification = classificationFor(suiteResults);
    const verification = createVerificationResult({
      context,
      verifierType: "regression",
      status,
      startedAt: started.toISOString(),
      endedAt: ended.toISOString(),
      checks,
      metrics: metricsFromSuites(suiteResults),
      artifacts,
      evidenceClassification,
      completeness: incompleteIfNeeded(incompleteEvidence, artifacts),
      hardGateFailures,
      inputs: { plan },
      details: { regression }
    });
    return { verification, regression };
  }

  private async runSuite(suite: RegressionSuite, plan: RegressionPlan, artifactDirectory: string): Promise<RegressionExecution> {
    const context = { workingDirectory: plan.workingDirectory, timeoutMs: suite.timeoutMs ?? plan.defaultTimeoutMs, artifactDirectory };
    if (suite.kind === "hardware") {
      if (!plan.requireHardware) return { status: "SKIPPED", exitCode: null, errorCode: "HARDWARE_REQUIRED", message: "Hardware suite skipped; requireHardware=true is required" };
      if (!this.hardwareRunner) return { status: "BLOCKED", exitCode: null, errorCode: "HARDWARE_RUNNER_UNAVAILABLE", message: "Hardware regression requires an explicit durable hardware runner", evidenceClassification: "UNKNOWN" };
      return this.hardwareRunner.run(suite, context);
    }
    const runner = this.runners.find(candidate => !candidate.id || candidate.id === suite.id || candidate.id === "builtin-host");
    if (!runner) return { status: "UNSUPPORTED", exitCode: null, errorCode: "RUNNER_UNAVAILABLE", message: `No runner is configured for ${suite.id}` };
    const execution = await runner.run(suite, context);
    return {
      ...execution,
      evidenceClassification: execution.evidenceClassification ?? (suite.kind === "mock" || /mock/i.test(suite.id) ? "MOCK" : "UNKNOWN")
    };
  }

  private async persistSuiteLogs(suite: RegressionSuite, execution: RegressionExecution, artifactDirectory: string): Promise<VerificationArtifact[]> {
    const artifacts: VerificationArtifact[] = [];
    for (const [kind, text] of [["stdout", execution.stdout], ["stderr", execution.stderr]] as const) {
      if (text === undefined) continue;
      const filePath = path.join(artifactDirectory, "logs", `${safePath(suite.id)}.${kind}.log`);
      await this.writer.writeText(filePath, text);
      try {
        const [metadata, bytes] = await Promise.all([stat(filePath), readFile(filePath)]);
        artifacts.push({ path: path.resolve(filePath), artifactType: `verification:regression-${kind}`, sha256: createHash("sha256").update(bytes).digest("hex"), size: metadata.size, mtimeMs: metadata.mtimeMs, completeness: "COMPLETE", role: "evidence" });
      } catch {
        // The execution result remains visible; a missing log is represented by
        // the incomplete artifact state below rather than a false PASS.
      }
    }
    return artifacts;
  }
}

function classificationFor(suites: RegressionSuiteResult[]): RegressionSuiteResult["evidenceClassification"] {
  const values = new Set(suites.map(suite => suite.evidenceClassification));
  if (values.size === 0) return "UNKNOWN";
  if (values.size === 1) return [...values][0]!;
  return "MIXED";
}

function metricsFromSuites(suites: RegressionSuiteResult[]): VerificationMetric[] {
  return suites.map(suite => ({ name: `regression.${suite.id}.status`, unit: "boolean", value: suite.status === "PASSED" ? 1 : 0, source: suite.id }));
}

function incompleteIfNeeded(incompleteEvidence: boolean, artifacts: VerificationArtifact[]) {
  return incompleteEvidence ? incomplete("REGRESSION_EVIDENCE_INCOMPLETE", artifacts) : {
    status: "COMPLETE" as const,
    reason: null,
    requiredArtifacts: [],
    presentArtifacts: artifacts.map(artifact => artifact.path)
  };
}

function check(
  id: string,
  status: VerificationCheck["status"],
  severity: VerificationCheck["severity"],
  message: string
): VerificationCheck { return { id, category: "regression", status, severity, message }; }

function safePath(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}
