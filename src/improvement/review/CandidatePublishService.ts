import { DebugMcpError } from "../../utils/errors.js";
import type { ImprovementImplementationRunStore } from "../implementation/ImplementationRunRepository.js";
import { ImprovementWorktreeManager } from "../implementation/ImprovementWorktreeManager.js";
import { processSucceeded, type ProcessRunResult } from "../implementation/ProcessRunner.js";
import { CandidateReviewService } from "./CandidateReviewService.js";
import type { CandidateReviewResult, ReviewPolicyConfig } from "./ReviewSchemas.js";

export interface CandidatePublishResult {
  repository: string;
  remote: string;
  branch: string;
  candidateSha: string;
  baselineSha: string;
  pushed: boolean;
  idempotent: boolean;
  candidateReview: CandidateReviewResult;
}

export interface CandidatePublishServiceOptions {
  runs: ImprovementImplementationRunStore;
  worktrees: ImprovementWorktreeManager;
  candidateReview: CandidateReviewService;
  review: ReviewPolicyConfig;
  repositoryRoot?: string;
  git?: (cwd: string, args: readonly string[]) => Promise<ProcessRunResult>;
}

/**
 * Git-only publication boundary. It is deliberately unable to create a PR,
 * change a base branch, force-push, rebase, merge, or invoke a coding agent.
 */
export class CandidatePublishService {
  private readonly repositoryRoot: string;
  private readonly git: (cwd: string, args: readonly string[]) => Promise<ProcessRunResult>;

  constructor(private readonly options: CandidatePublishServiceOptions) {
    this.repositoryRoot = options.repositoryRoot ?? options.worktrees.repositoryRoot;
    this.git = options.git ?? ((cwd, args) => options.worktrees.runGitAt(cwd, args, "CandidateCommitFailed"));
  }

  async publish(runId: string): Promise<CandidatePublishResult> {
    const review = await this.options.candidateReview.assertPublishable(runId);
    const run = this.options.runs.get(runId);
    if (!run) throw new DebugMcpError("ImprovementRunNotFound", `Improvement implementation run not found: ${runId}`, { runId });
    const branch = run.branchName;
    if (!/^(?:improve|auto-improve)\/[A-Za-z0-9._-]{1,220}$/.test(branch)) {
      throw new DebugMcpError("CandidatePublishFailed", "Only controlled improvement candidate branches may be published", { runId, branch });
    }
    if (isProtectedBranch(branch, this.options.review.protectedBranches)) {
      throw new DebugMcpError("CandidatePublishFailed", "Protected branches cannot be used as improvement candidate branches", {
        runId,
        branch,
        protectedBranches: this.options.review.protectedBranches
      });
    }
    const remote = this.options.review.remote;
    const remoteUrlResult = await this.git(this.repositoryRoot, ["remote", "get-url", "--push", remote]);
    if (!processSucceeded(remoteUrlResult)) {
      throw new DebugMcpError("CandidatePublishFailed", "Configured improvement Git remote is unavailable", {
        runId,
        remote,
        repository: this.options.review.repository,
        exitCode: remoteUrlResult.exitCode
      });
    }
    const actualRepository = repositoryFromRemote(remoteUrlResult.stdout.trim());
    if (actualRepository !== this.options.review.repository.toLowerCase()) {
      throw new DebugMcpError("RemoteRepositoryMismatch", "Configured Git remote does not point to the expected C2000 repository", {
        runId,
        remote,
        expectedRepository: this.options.review.repository,
        actualRepository: actualRepository ?? "unknown"
      });
    }

    const remoteSha = await this.remoteBranchSha(remote, branch);
    if (remoteSha) {
      if (remoteSha.toLowerCase() !== review.candidateSha.toLowerCase()) {
        throw new DebugMcpError("RemoteBranchMismatch", "The remote candidate branch already points at a different commit", {
          runId,
          remote,
          branch,
          expectedCandidateSha: review.candidateSha,
          actualRemoteSha: remoteSha
        });
      }
      return {
        repository: this.options.review.repository,
        remote,
        branch,
        candidateSha: review.candidateSha,
        baselineSha: review.baselineSha,
        pushed: false,
        idempotent: true,
        candidateReview: review
      };
    }

    // Intentionally no --force, --force-with-lease, --mirror, or --all.
    const pushed = await this.git(this.repositoryRoot, ["push", remote, branch]);
    if (!processSucceeded(pushed)) {
      throw new DebugMcpError("CandidatePublishFailed", "Git could not publish the candidate branch", {
        runId,
        remote,
        branch,
        candidateSha: review.candidateSha,
        exitCode: pushed.exitCode,
        timedOut: pushed.timedOut,
        stderr: pushed.stderr.slice(-2048)
      });
    }
    const verifiedSha = await this.remoteBranchSha(remote, branch);
    if (!verifiedSha || verifiedSha.toLowerCase() !== review.candidateSha.toLowerCase()) {
      throw new DebugMcpError("CandidatePublishFailed", "Published candidate branch did not resolve to the expected commit", {
        runId,
        remote,
        branch,
        expectedCandidateSha: review.candidateSha,
        actualRemoteSha: verifiedSha ?? null
      });
    }
    return {
      repository: this.options.review.repository,
      remote,
      branch,
      candidateSha: review.candidateSha,
      baselineSha: review.baselineSha,
      pushed: true,
      idempotent: false,
      candidateReview: review
    };
  }

  /** Publish a revision branch onto the existing PR branch using a normal FF refspec. */
  async publishRevision(runId: string, remoteBranch: string, parentCandidateSha: string): Promise<CandidatePublishResult> {
    const review = await this.options.candidateReview.assertPublishable(runId);
    const run = this.options.runs.get(runId);
    if (!run) throw new DebugMcpError("ImprovementRunNotFound", `Improvement implementation run not found: ${runId}`, { runId });
    if (run.runKind !== "revision" || !run.revisionProposalId) throw new DebugMcpError("CandidatePublishFailed", "Only a revision implementation run may use revision publication", { runId, runKind: run.runKind });
    if (!/^(?:improve|auto-improve)\/[A-Za-z0-9._-]{1,220}$/.test(remoteBranch)) throw new DebugMcpError("CandidatePublishFailed", "The controlled PR branch is invalid", { runId, remoteBranch });
    if (isProtectedBranch(remoteBranch, this.options.review.protectedBranches)) throw new DebugMcpError("CandidatePublishFailed", "Protected branches cannot receive an improvement revision", { runId, remoteBranch });
    if (run.baselineSha.toLowerCase() !== parentCandidateSha.toLowerCase() || run.parentCandidateSha?.toLowerCase() !== parentCandidateSha.toLowerCase()) {
      throw new DebugMcpError("RevisionRemoteDrift", "Revision parent candidate does not match the implementation baseline", { runId, parentCandidateSha, baselineSha: run.baselineSha, recordedParentCandidateSha: run.parentCandidateSha });
    }
    const remote = this.options.review.remote;
    const remoteUrlResult = await this.git(this.repositoryRoot, ["remote", "get-url", "--push", remote]);
    if (!processSucceeded(remoteUrlResult)) throw new DebugMcpError("CandidatePublishFailed", "Configured improvement Git remote is unavailable", { runId, remote });
    const actualRepository = repositoryFromRemote(remoteUrlResult.stdout.trim());
    if (actualRepository !== this.options.review.repository.toLowerCase()) throw new DebugMcpError("RemoteRepositoryMismatch", "Configured Git remote does not point to the expected C2000 repository", { runId, remote, expectedRepository: this.options.review.repository, actualRepository: actualRepository ?? "unknown" });
    const existingSha = await this.remoteBranchSha(remote, remoteBranch);
    if (!existingSha) throw new DebugMcpError("RevisionRemoteDrift", "The existing PR branch is missing; a revision cannot create a replacement branch", { runId, remoteBranch, parentCandidateSha });
    if (existingSha.toLowerCase() !== parentCandidateSha.toLowerCase()) throw new DebugMcpError("RemoteBranchAdvanced", "The existing PR branch advanced since the revision was approved", { runId, remoteBranch, expectedParentCandidateSha: parentCandidateSha, actualRemoteSha: existingSha });
    const pushed = await this.git(this.repositoryRoot, ["push", remote, `${run.branchName}:${remoteBranch}`]);
    if (!processSucceeded(pushed)) throw new DebugMcpError("CandidatePublishFailed", "Git could not fast-forward the existing improvement pull request branch", { runId, remote, localBranch: run.branchName, remoteBranch, candidateSha: review.candidateSha, exitCode: pushed.exitCode, timedOut: pushed.timedOut, stderr: pushed.stderr.slice(-2048) });
    const verifiedSha = await this.remoteBranchSha(remote, remoteBranch);
    if (!verifiedSha || verifiedSha.toLowerCase() !== review.candidateSha.toLowerCase()) throw new DebugMcpError("CandidatePublishFailed", "The revision push did not resolve the PR branch to the validated candidate", { runId, remoteBranch, expectedCandidateSha: review.candidateSha, actualRemoteSha: verifiedSha ?? null });
    return { repository: this.options.review.repository, remote, branch: remoteBranch, candidateSha: review.candidateSha, baselineSha: review.baselineSha, pushed: true, idempotent: false, candidateReview: review };
  }

  private async remoteBranchSha(remote: string, branch: string): Promise<string | undefined> {
    const result = await this.git(this.repositoryRoot, ["ls-remote", "--heads", remote, `refs/heads/${branch}`]);
    if (!processSucceeded(result)) {
      throw new DebugMcpError("CandidatePublishFailed", "Unable to inspect the remote candidate branch", {
        remote,
        branch,
        exitCode: result.exitCode,
        timedOut: result.timedOut
      });
    }
    const sha = result.stdout.trim().split(/\s+/)[0];
    return sha && /^[0-9a-f]{7,64}$/i.test(sha) ? sha : undefined;
  }
}

function isProtectedBranch(branch: string, protectedBranches: readonly string[]): boolean {
  return protectedBranches.some(pattern => pattern.endsWith("/*")
    ? branch.startsWith(pattern.slice(0, -1))
    : branch === pattern);
}

function repositoryFromRemote(value: string): string | undefined {
  const normalized = value.trim().replace(/\\/g, "/").replace(/\/+$/, "").replace(/\.git$/, "");
  const match = normalized.match(/(?:^|@|\/)(github\.com)[/:]([^/]+)\/([^/]+)$/i);
  if (!match) return undefined;
  return `${match[2]}/${match[3]}`.toLowerCase();
}
