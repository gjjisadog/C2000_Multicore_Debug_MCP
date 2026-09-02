import { DebugMcpError } from "../../utils/errors.js";
import { codingAgentResultSchema, type CodingAgentResult } from "./ImplementationSchemas.js";
import { processSucceeded, runProcess } from "./ProcessRunner.js";

export interface CodingAgentRequest {
  runId: string;
  proposalId: string;
  baselineSha: string;
  worktreePath: string;
  prompt: string;
  promptFile: string;
  allowedAreas: readonly string[];
  forbiddenAreas: readonly string[];
  repairContext?: {
    attempt: 2;
    failedCommands: readonly { name: string; exitCode?: number | null; reason?: string }[];
    verdict: string;
  };
}

export interface ImprovementCodingAgent {
  readonly provider: string;
  run(request: CodingAgentRequest): Promise<CodingAgentResult>;
}

export interface ConfiguredCodingAgentOptions {
  provider?: string;
  command?: string;
  args?: readonly string[];
  timeoutMs?: number;
}

/**
 * Provider-neutral boundary for the first coding-agent implementation. The
 * executable and arguments come from server configuration, never from a
 * Proposal. It is deliberately shell-free and receives a sanitized env.
 */
export class ConfiguredCodingAgent implements ImprovementCodingAgent {
  readonly provider: string;
  private readonly command?: string;
  private readonly args: readonly string[];
  private readonly timeoutMs: number;

  constructor(options: ConfiguredCodingAgentOptions = {}) {
    this.provider = options.provider?.trim() || "configured-agent";
    this.command = options.command?.trim() || undefined;
    this.args = options.args ?? [];
    this.timeoutMs = Math.max(1_000, Math.trunc(options.timeoutMs ?? 15 * 60 * 1000));
  }

  async run(request: CodingAgentRequest): Promise<CodingAgentResult> {
    if (!this.command) {
      throw new DebugMcpError("CodingAgentUnavailable", "No approved coding-agent command is configured for improvement implementation", {
        provider: this.provider,
        actionRequired: "Configure improvement.codingAgent.command; the MCP never accepts an executable from Proposal data."
      });
    }
    const args = this.args.map(argument => renderArgument(argument, request));
    const result = await runProcess({
      command: this.command,
      args,
      cwd: request.worktreePath,
      timeoutMs: this.timeoutMs,
      env: sanitizedAgentEnvironment(request),
      maxOutputBytes: 256 * 1024
    });
    const assumptionInvalid = `${result.stdout}\n${result.stderr}`.includes("PROPOSAL_ASSUMPTION_INVALID");
    const status = result.timedOut ? "timed-out" : processSucceeded(result) && !assumptionInvalid ? "completed" : "failed";
    return codingAgentResultSchema.parse({
      provider: this.provider,
      status,
      agentRunId: `${this.provider}:${request.runId}`,
      startedAt: new Date(Date.now() - result.durationMs).toISOString(),
      finishedAt: new Date().toISOString(),
      exitCode: result.exitCode,
      ...(result.stdout ? { stdout: truncate(result.stdout, 32_000) } : {}),
      ...(result.stderr ? { stderr: truncate(result.stderr, 32_000) } : {}),
      assumptionInvalid,
      summary: truncate(assumptionInvalid ? "The coding agent reported PROPOSAL_ASSUMPTION_INVALID" : result.timedOut ? "The coding agent timed out" : processSucceeded(result) ? "Coding agent completed" : "Coding agent exited unsuccessfully", 2048)
    });
  }
}

function renderArgument(argument: string, request: CodingAgentRequest): string {
  return argument
    .replaceAll("{runId}", request.runId)
    .replaceAll("{proposalId}", request.proposalId)
    .replaceAll("{baselineSha}", request.baselineSha)
    .replaceAll("{worktreePath}", request.worktreePath)
    .replaceAll("{promptFile}", request.promptFile);
}

function sanitizedAgentEnvironment(request: CodingAgentRequest): NodeJS.ProcessEnv {
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
    C2000_IMPROVEMENT_NO_NETWORK: "1",
    C2000_IMPROVEMENT_RUN_ID: request.runId,
    C2000_IMPROVEMENT_PROPOSAL_ID: request.proposalId,
    C2000_IMPROVEMENT_PROMPT_FILE: request.promptFile
  };
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 64)}\n...[truncated]`;
}
