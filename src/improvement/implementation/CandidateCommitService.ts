import type { ImprovementProposal } from "../ProposalSchemas.js";
import { DebugMcpError } from "../../utils/errors.js";
import { proposalValidationResultSchema, type ProposalValidationResult } from "../ProposalSchemas.js";
import { ImprovementWorktreeManager } from "./ImprovementWorktreeManager.js";
import type { GitSnapshot } from "./ImplementationSchemas.js";

export interface CandidateCommitResult {
  candidateCommitSha: string;
  postImplementationStatus: GitSnapshot;
  validationResult: ProposalValidationResult;
}

/** Creates the only commit in the Round6 lifecycle, on the candidate branch. */
export class CandidateCommitService {
  constructor(private readonly worktrees: ImprovementWorktreeManager) {}

  async commit(input: {
    proposal: ImprovementProposal;
    runId: string;
    worktreePath: string;
    baselineSha: string;
    validationResult: ProposalValidationResult;
  }): Promise<CandidateCommitResult> {
    assertValidationAcceptable(input.proposal, input.validationResult);
    const before = await this.worktrees.snapshot(input.worktreePath, input.baselineSha);
    if (before.headSha.toLowerCase() !== input.baselineSha.toLowerCase()) {
      throw new DebugMcpError("AgentCommittedChanges", "The coding agent changed HEAD; only the candidate commit service may commit", {
        proposalId: input.proposal.proposalId,
        runId: input.runId,
        baselineSha: input.baselineSha,
        actualHeadSha: before.headSha
      });
    }
    const scope = await this.worktrees.validateScope(input.proposal, input.worktreePath, input.baselineSha);
    if (scope.changedFiles.length === 0) {
      throw new DebugMcpError("NoCandidateChanges", "The coding agent completed without producing an approved candidate change", {
        proposalId: input.proposal.proposalId,
        runId: input.runId
      });
    }
    const staged = await this.worktrees.runGitAt(input.worktreePath, ["add", "--", ...scope.changedFiles], "CandidateCommitFailed");
    if (staged.exitCode !== 0 || staged.timedOut) {
      throw new DebugMcpError("CandidateCommitFailed", "Git could not stage the approved candidate files", {
        proposalId: input.proposal.proposalId,
        runId: input.runId,
        changedFiles: scope.changedFiles,
        exitCode: staged.exitCode,
        timedOut: staged.timedOut,
        stderr: staged.stderr.slice(-4096)
      });
    }
    const subject = `improve(${safeSubject(input.proposal.target)}): ${safeSubject(input.proposal.title)}`.slice(0, 120);
    const message = [
      subject,
      "",
      `Proposal: ${input.proposal.proposalId}`,
      `Implementation-Run: ${input.runId}`,
      `Baseline: ${input.baselineSha}`
    ].join("\n");
    const committed = await this.worktrees.runGitAt(input.worktreePath, ["commit", "-m", message], "CandidateCommitFailed");
    if (committed.exitCode !== 0 || committed.timedOut) {
      throw new DebugMcpError("CandidateCommitFailed", "Git could not create the validated candidate commit", {
        proposalId: input.proposal.proposalId,
        runId: input.runId,
        exitCode: committed.exitCode,
        timedOut: committed.timedOut,
        stdout: committed.stdout.slice(-4096),
        stderr: committed.stderr.slice(-4096)
      });
    }
    const after = await this.worktrees.snapshot(input.worktreePath, input.baselineSha);
    if (after.headSha.toLowerCase() === input.baselineSha.toLowerCase() || !after.clean) {
      throw new DebugMcpError("CandidateCommitFailed", "Candidate commit did not leave a clean, advanced candidate branch", {
        proposalId: input.proposal.proposalId,
        runId: input.runId,
        baselineSha: input.baselineSha,
        actualHeadSha: after.headSha,
        clean: after.clean,
        statusShort: after.statusShort
      });
    }
    const validationResult = proposalValidationResultSchema.parse({
      ...input.validationResult,
      candidate: after.headSha
    });
    return { candidateCommitSha: after.headSha, postImplementationStatus: after, validationResult };
  }
}

function assertValidationAcceptable(proposal: ImprovementProposal, result: ProposalValidationResult): void {
  const passiveNeutral = ["documentation", "test-coverage", "skill"].includes(proposal.category);
  const verdictAllowed = result.verdict === "improved" || (result.verdict === "neutral" && passiveNeutral);
  if (!result.implementationComplete || !verdictAllowed || !result.candidate || result.tests.length === 0 || result.tests.some(test => test.status !== "passed") || result.regressions.length > 0 || result.safetyChecks.length === 0 || result.safetyChecks.some(check => !check.passed)) {
    throw new DebugMcpError("CandidateNotReady", "Candidate commit requires independently validated implementation, tests, safety checks, and an acceptable verdict", {
      proposalId: proposal.proposalId,
      verdict: result.verdict,
      implementationComplete: result.implementationComplete,
      candidate: result.candidate,
      failedTests: result.tests.filter(test => test.status !== "passed").map(test => test.name),
      regressions: result.regressions,
      failedSafetyChecks: result.safetyChecks.filter(check => !check.passed).map(check => check.name)
    });
  }
}

function safeSubject(value: string): string {
  return value.replace(/\s+/g, " ").replace(/[\r\n]/g, " ").trim() || "approved change";
}
