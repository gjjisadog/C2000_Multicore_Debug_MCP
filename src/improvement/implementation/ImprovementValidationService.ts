import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ImprovementProposal } from "../ProposalSchemas.js";
import { DebugMcpError } from "../../utils/errors.js";
import { ImprovementArtifactWriter } from "./ImplementationArtifacts.js";
import { ImprovementWorktreeManager, type ScopeCheckResult } from "./ImprovementWorktreeManager.js";
import { processSucceeded, runProcess } from "./ProcessRunner.js";
import {
  proposalValidationResultSchema,
  type ProposalValidationResult
} from "../ProposalSchemas.js";
import type {
  ImplementationArtifact,
  ValidationCommandResult
} from "./ImplementationSchemas.js";

export interface ValidationCommand {
  name: string;
  stage: string;
  command: string;
  args: string[];
  timeoutMs: number;
  hardwareRequired?: boolean;
}

export interface ValidationCommandRegistry {
  resolve(proposal: ImprovementProposal, baselineWorktreePath: string): Promise<ValidationCommand[]> | ValidationCommand[];
}

export interface ImprovementValidationInput {
  proposal: ImprovementProposal;
  baselineSha: string;
  baselineWorktreePath: string;
  candidateWorktreePath: string;
  scope: ScopeCheckResult;
  implementationComplete: boolean;
  validationAttempt?: number;
  now?: () => number;
}

export interface ImprovementValidationOutput {
  result: ProposalValidationResult;
  commandResults: ValidationCommandResult[];
  artifacts: ImplementationArtifact[];
  protectedInvariantPassed: boolean;
}

/**
 * Resolves validation only from repository-owned package scripts. Proposal
 * text can name tests for the prompt, but cannot smuggle arbitrary commands
 * into the implementation runner.
 */
export class PackageJsonValidationCommandRegistry implements ValidationCommandRegistry {
  constructor(private readonly timeoutMs = 15 * 60 * 1000) {}

  async resolve(proposal: ImprovementProposal, baselineWorktreePath: string): Promise<ValidationCommand[]> {
    const packagePath = path.join(baselineWorktreePath, "package.json");
    let packageJson: { scripts?: Record<string, unknown> };
    try {
      packageJson = JSON.parse(await readFile(packagePath, "utf8")) as { scripts?: Record<string, unknown> };
    } catch (error) {
      throw new DebugMcpError("ValidationConfigurationUnavailable", "Improvement validation requires a readable package.json in the approved baseline", {
        packagePath,
        proposalId: proposal.proposalId,
        error: String(error)
      });
    }
    const scripts = packageJson.scripts ?? {};
    const commands: ValidationCommand[] = [];
    const add = (name: string, stage: string) => {
      if (typeof scripts[name] !== "string" || !scripts[name]!.trim()) return;
      commands.push({
        name: `npm:${name}`,
        stage,
        command: npmExecutable(),
        args: ["run", name, "--silent"],
        timeoutMs: this.timeoutMs
      });
    };

    add("typecheck", "typescript-build");
    add("build", "typescript-build");
    if (proposal.validationPlan.mockValidation) add("test", "focused-and-full-tests");
    add("verify:debug-boundary", "safety-surface-regression");
    add("verify:skill-sync", "skill-regression");
    if (commands.length === 0) {
      throw new DebugMcpError("ValidationConfigurationUnavailable", "No approved package validation scripts are available", {
        proposalId: proposal.proposalId,
        expectedScripts: ["typecheck", "build", "test"]
      });
    }
    return commands;
  }
}

/** Runs the same host/mock commands against the approved baseline and candidate. */
export class ImprovementValidationService {
  private readonly now: () => number;
  private readonly commands: ValidationCommandRegistry;
  private readonly artifacts: ImprovementArtifactWriter;
  private readonly worktrees: ImprovementWorktreeManager;

  constructor(options: {
    worktrees: ImprovementWorktreeManager;
    artifactRoot: string;
    commands?: ValidationCommandRegistry;
    now?: () => number;
  }) {
    this.worktrees = options.worktrees;
    this.artifacts = new ImprovementArtifactWriter(options.artifactRoot);
    this.commands = options.commands ?? new PackageJsonValidationCommandRegistry();
    this.now = options.now ?? (() => Date.now());
  }

  async validate(runId: string, input: ImprovementValidationInput): Promise<ImprovementValidationOutput> {
    const commands = await this.commands.resolve(input.proposal, input.baselineWorktreePath);
    const commandResults: ValidationCommandResult[] = [];
    const artifacts: ImplementationArtifact[] = [];
    const attemptSuffix = `-attempt-${Math.max(1, Math.trunc(input.validationAttempt ?? 1))}`;
    const baselineResults: Array<{ command: ValidationCommand; status: "passed" | "failed" | "not-run"; reason?: string }> = [];
    const candidateResults: Array<{ command: ValidationCommand; status: "passed" | "failed" | "not-run"; reason?: string }> = [];
    for (const command of commands) {
      if (input.proposal.validationPlan.hardwareRequired || command.hardwareRequired) {
        baselineResults.push({ command, status: "not-run", reason: "NOT_RUN_HARDWARE" });
        candidateResults.push({ command, status: "not-run", reason: "NOT_RUN_HARDWARE" });
        commandResults.push({
          name: command.name,
          stage: command.stage,
          status: "not-run",
          command: command.command,
          args: command.args,
          reason: "NOT_RUN_HARDWARE"
        });
        continue;
      }
      const baseline = await runValidationCommand(command, input.baselineWorktreePath);
      const candidate = await runValidationCommand(command, input.candidateWorktreePath);
      const baselineStatus = processSucceeded(baseline) ? "passed" : "failed";
      const candidateStatus = processSucceeded(candidate) ? "passed" : "failed";
      const baselineLog = await this.artifacts.write(runId, "validation-log", `${safeFileName(command.name)}-baseline${attemptSuffix}.log`, formatProcessLog(command, baseline));
      const candidateLog = await this.artifacts.write(runId, "validation-log", `${safeFileName(command.name)}-candidate${attemptSuffix}.log`, formatProcessLog(command, candidate));
      artifacts.push(baselineLog, candidateLog);
      baselineResults.push({ command, status: baselineStatus, ...(baselineStatus === "failed" ? { reason: summarizeFailure(baseline) } : {}) });
      candidateResults.push({ command, status: candidateStatus, ...(candidateStatus === "failed" ? { reason: summarizeFailure(candidate) } : {}) });
      commandResults.push({
        name: command.name,
        stage: command.stage,
        status: candidateStatus,
        command: command.command,
        args: command.args,
        exitCode: candidate.exitCode,
        durationMs: candidate.durationMs,
        baselineLog: baselineLog.path,
        candidateLog: candidateLog.path,
        ...(candidateStatus === "failed" ? { reason: summarizeFailure(candidate) } : {})
      });
    }

    const protectedInvariantPassed = protectedInvariantDiffCheck(input.scope.diffPatch);
    const baselinePassed = baselineResults.every(result => result.status === "passed");
    const candidatePassed = candidateResults.every(result => result.status === "passed");
    const hardwarePending = input.proposal.validationPlan.hardwareRequired || [...baselineResults, ...candidateResults].some(result => result.status === "not-run" && result.reason === "NOT_RUN_HARDWARE");
    const regressions = [
      ...candidateResults.filter(result => result.status === "failed").map(result => `Candidate validation failed: ${result.command.name}${result.reason ? ` (${result.reason})` : ""}`),
      ...(!protectedInvariantPassed ? ["Protected invariant diff check failed"] : []),
      ...(!input.scope.snapshot.clean && input.scope.changedFiles.length === 0 ? ["Candidate workspace became dirty without a recognized change"] : [])
    ];
    const baselineFailures = baselineResults.filter(result => result.status === "failed").map(result => `Baseline validation failed: ${result.command.name}${result.reason ? ` (${result.reason})` : ""}`);
    const verdict = hardwarePending
      ? "inconclusive"
      : regressions.length > 0
        ? "regressed"
        : !baselinePassed
          ? "inconclusive"
          : candidatePassed && protectedInvariantPassed
            ? "improved"
            : "inconclusive";
    const diffSha = input.scope.diffSha256;
    const result = proposalValidationResultSchema.parse({
      baseline: input.baselineSha,
      candidate: diffSha,
      implementationComplete: input.implementationComplete,
      tests: commandResults.map(command => ({
        name: command.name,
        status: command.status,
        ...(command.durationMs !== undefined ? { durationMs: command.durationMs } : {})
      })),
      regressions: [...regressions, ...baselineFailures],
      metricDelta: {
        candidatePassed: candidateResults.filter(item => item.status === "passed").length,
        baselinePassed: baselineResults.filter(item => item.status === "passed").length,
        changedFiles: input.scope.changedFiles.length
      },
      safetyChecks: [
        { name: "candidate-scope", passed: true, details: `${input.scope.changedFiles.length} approved changed file(s)` },
        { name: "protected-invariants", passed: protectedInvariantPassed, details: protectedInvariantPassed ? "No protected invariant deletion was detected in the candidate diff" : "Candidate diff removes or changes a protected invariant without preserving it" },
        { name: "baseline-replay", passed: baselinePassed && !hardwarePending, details: hardwarePending ? "NOT_RUN_HARDWARE" : baselinePassed ? "The same registered validation commands passed on the approved baseline" : "The approved baseline did not pass the registered validation commands" }
      ],
      verdict,
      generatedAt: new Date(this.now()).toISOString()
    });
    const summaryArtifact = await this.artifacts.writeJson(runId, "validation-summary", `validation-summary${attemptSuffix}.json`, {
      proposalId: input.proposal.proposalId,
      baselineSha: input.baselineSha,
      changedFiles: input.scope.changedFiles,
      commandResults,
      baselineResults,
      candidateResults,
      protectedInvariantPassed,
      result
    });
    artifacts.push(summaryArtifact);
    return { result, commandResults, artifacts, protectedInvariantPassed };
  }
}

async function runValidationCommand(command: ValidationCommand, cwd: string) {
  return runProcess({
    command: command.command,
    args: command.args,
    cwd,
    timeoutMs: command.timeoutMs,
    env: sanitizedValidationEnvironment(),
    maxOutputBytes: 256 * 1024
  });
}

function protectedInvariantDiffCheck(diff: string): boolean {
  const protectedTokens = [
    /CPU1 coreId remains 0/i,
    /CPU2 coreId remains 2/i,
    /C28xx_CPU1/,
    /C28xx_CPU2/,
    /cpu1-run-before-cpu2/,
    /cpu1_boots_cpu2/,
    /loadSymbols/,
    /allowDestructiveFlashReload/,
    /Safety Profile/i,
    /compatibility aliases/i
  ];
  const removed = diff.split(/\r?\n/).filter(line => line.startsWith("-") && !line.startsWith("---"));
  const added = diff.split(/\r?\n/).filter(line => line.startsWith("+") && !line.startsWith("+++"));
  return protectedTokens.every(token => !removed.some(line => token.test(line)) || added.some(line => token.test(line)));
}

function sanitizedValidationEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    PATHEXT: process.env.PATHEXT,
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    ComSpec: process.env.ComSpec,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    USERPROFILE: process.env.USERPROFILE,
    CI: "1",
    GIT_TERMINAL_PROMPT: "0",
    npm_config_offline: "true"
  };
}

function npmExecutable(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function safeFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 120);
}

function formatProcessLog(command: ValidationCommand, result: { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean; durationMs: number }): string {
  return [
    `command: ${command.command} ${command.args.join(" ")}`,
    `exitCode: ${String(result.exitCode)}`,
    `timedOut: ${String(result.timedOut)}`,
    `durationMs: ${String(result.durationMs)}`,
    "",
    "--- stdout ---",
    result.stdout,
    "",
    "--- stderr ---",
    result.stderr
  ].join("\n");
}

function summarizeFailure(result: { stderr: string; stdout: string; exitCode: number | null; timedOut: boolean }): string {
  if (result.timedOut) return "timeout";
  const output = `${result.stderr}\n${result.stdout}`.trim();
  return output.slice(-1024) || `exit code ${String(result.exitCode)}`;
}
