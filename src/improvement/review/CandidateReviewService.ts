import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { DebugMcpError } from "../../utils/errors.js";
import type { ImprovementProposalStore } from "../ProposalRepository.js";
import type { ImprovementProposal } from "../ProposalSchemas.js";
import type { ImprovementImplementationRunStore } from "../implementation/ImplementationRunRepository.js";
import type { ImprovementImplementationRun } from "../implementation/ImplementationSchemas.js";
import { ImprovementWorktreeManager } from "../implementation/ImprovementWorktreeManager.js";
import { processSucceeded, type ProcessRunResult } from "../implementation/ProcessRunner.js";
import {
  BASE_DRIFT_CLASSIFICATIONS,
  candidateReviewResultSchema,
  type BaseDriftClassification,
  type CandidateReviewResult,
  type RevalidationPolicy
} from "./ReviewSchemas.js";

const SHA_PATTERN = /^[0-9a-f]{7,64}$/i;
const CANDIDATE_BRANCH = /^(?:improve|auto-improve)\/[A-Za-z0-9._-]{1,220}$/;

export interface CandidateReviewServiceOptions {
  runs: ImprovementImplementationRunStore;
  proposals: ImprovementProposalStore;
  worktrees: ImprovementWorktreeManager;
  artifactRoot: string;
  baseRef?: string;
  currentBaseSha?: string | (() => string | undefined | Promise<string | undefined>);
  revalidationPolicy?: RevalidationPolicy;
  now?: () => number;
  git?: (cwd: string, args: readonly string[]) => Promise<ProcessRunResult>;
}

/**
 * Re-checks the immutable Round6 candidate before any external publication.
 * This class performs Git/artifact inspection only; it never edits, pushes,
 * creates a PR, merges, or invokes a target/debug service.
 */
export class CandidateReviewService {
  private readonly artifactRoot: string;
  private readonly baseRef: string;
  private readonly now: () => number;
  private readonly policy: RevalidationPolicy;
  private readonly git: (cwd: string, args: readonly string[]) => Promise<ProcessRunResult>;

  constructor(private readonly options: CandidateReviewServiceOptions) {
    this.artifactRoot = path.resolve(options.artifactRoot);
    this.baseRef = options.baseRef ?? "master";
    this.now = options.now ?? (() => Date.now());
    this.policy = options.revalidationPolicy ?? "on-significant-base-change";
    this.git = options.git ?? ((cwd, args) => options.worktrees.runGitAt(cwd, args, "CandidateCommitFailed"));
  }

  async review(runId: string): Promise<CandidateReviewResult> {
    const run = this.options.runs.get(runId);
    if (!run) throw new DebugMcpError("ImprovementRunNotFound", `Improvement implementation run not found: ${runId}`, { runId });
    const proposal = this.options.proposals.get(run.proposalId);
    if (!proposal) throw new DebugMcpError("ProposalNotFound", `Improvement Proposal not found: ${run.proposalId}`, { proposalId: run.proposalId, runId });
    if (!run.candidateCommitSha) {
      throw new DebugMcpError("CandidateNotReady", `Implementation run ${runId} has no candidate commit`, {
        runId,
        status: run.status,
        requiredStatus: "candidate-ready"
      });
    }

    let snapshot;
    try {
      snapshot = await this.options.worktrees.snapshot(run.worktreePath, run.baselineSha);
    } catch (error) {
      throw new DebugMcpError("CandidateNotReady", "The candidate worktree cannot be inspected", {
        runId,
        candidateWorktreeAvailable: false,
        cause: error instanceof Error ? error.message : String(error)
      });
    }
    // A revision candidate is validated as the next link after its parent
    // candidate. The PR branch drift gate is handled by CandidatePublishService;
    // comparing C2 directly with master here would incorrectly reject a valid
    // C1 -> C2 chain when master advanced independently.
    const currentBaseSha = run.runKind === "revision" ? run.baselineSha : await this.resolveCurrentBaseSha();
    const baseDrift = await this.classifyBaseDrift(run.baselineSha, currentBaseSha, proposal);
    const artifactCheck = await this.verifyArtifacts(run);
    const validationPassed = validationPassedForCandidate(run.validationResult, proposal);
    const clean = snapshot.clean;
    const headMatches = snapshot.headSha.toLowerCase() === run.candidateCommitSha.toLowerCase();
    const branchMatches = snapshot.branchName === run.branchName;
    const branchValid = CANDIDATE_BRANCH.test(run.branchName);
    const commitCheck = await this.verifyCandidateHistory(run, snapshot.headSha);
    const proposalLifecycleAllowed = ["candidate-ready", "validated", "pr-open", "merge-recommended", "closed-without-merge", "merged"].includes(proposal.status);
    const issues: string[] = [];
    let failureCode: string | undefined;
    const addIssue = (code: string, message: string) => {
      failureCode ??= code;
      issues.push(message);
    };
    if (run.status !== "candidate-ready") addIssue("CandidateNotReady", `implementation run status is ${run.status}`);
    if (!proposalLifecycleAllowed) addIssue("CandidateNotReady", `proposal lifecycle status is ${proposal.status}`);
    if (!branchValid) addIssue("CandidateNotReady", "candidate branch is outside the improve/auto-improve namespace");
    if (!branchMatches) addIssue("CandidateHeadChanged", "candidate worktree branch does not match the recorded candidate branch");
    if (!headMatches) addIssue("CandidateHeadChanged", "candidate worktree HEAD does not match the recorded candidate SHA");
    if (!clean) addIssue("CandidateDirtyAfterValidation", "candidate worktree has uncommitted changes after validation");
    if (!commitCheck.ok) addIssue(commitCheck.failureCode, commitCheck.reason);
    if (!validationPassed) addIssue("CandidateNotReady", "independent candidate validation is not fully passing");
    if (!artifactCheck.valid) addIssue("CandidateNotReady", "candidate artifacts are missing or hash-invalid");
    if (!artifactCheck.candidateReportPresent) addIssue("CandidateNotReady", "candidate-report artifact is missing");
    if (baseDrift.classification !== "NO_DRIFT") {
      addIssue("CandidateRevalidationRequired", `base ${this.baseRef} changed: ${baseDrift.classification}`);
    }
    const valid = issues.length === 0;
    const parsed = candidateReviewResultSchema.parse({
      valid,
      publishAllowed: valid && baseDrift.classification === "NO_DRIFT",
      runId,
      proposalId: proposal.proposalId,
      branch: run.branchName,
      baselineSha: run.baselineSha,
      candidateSha: run.candidateCommitSha,
      currentBaseSha,
      changedFiles: snapshot.changedFiles,
      commitCount: commitCheck.count,
      validationPassed,
      artifactsValid: artifactCheck.valid,
      candidateReportPresent: artifactCheck.candidateReportPresent,
      clean,
      baseDrift,
      issues,
      ...(failureCode ? { failureCode } : {})
    });
    return parsed;
  }

  async assertPublishable(runId: string): Promise<CandidateReviewResult> {
    const result = await this.review(runId);
    if (!result.valid) {
      const code = isDebugErrorCode(result.failureCode) ? result.failureCode : "CandidateNotReady";
      throw new DebugMcpError(code, `Candidate ${runId} is not publishable`, {
        runId,
        candidateSha: result.candidateSha,
        baselineSha: result.baselineSha,
        issues: result.issues,
        candidateReview: result
      });
    }
    if (result.baseDrift.classification !== "NO_DRIFT") {
      throw new DebugMcpError("CandidateRevalidationRequired", "The candidate base has drifted since implementation validation", {
        runId,
        baseDrift: result.baseDrift,
        candidateSha: result.candidateSha,
        baselineSha: result.baselineSha,
        currentBaseSha: result.currentBaseSha,
        policy: this.policy
      });
    }
    return result;
  }

  private async resolveCurrentBaseSha(): Promise<string> {
    const configured = typeof this.options.currentBaseSha === "function" ? await this.options.currentBaseSha() : this.options.currentBaseSha;
    const resolved = configured ?? await this.options.worktrees.resolveRef(this.baseRef);
    if (!SHA_PATTERN.test(resolved)) {
      throw new DebugMcpError("BaselineUnavailable", `Base ref does not resolve to a valid commit: ${this.baseRef}`, { baseRef: this.baseRef });
    }
    return resolved;
  }

  private async verifyCandidateHistory(run: ImprovementImplementationRun, headSha: string): Promise<{ ok: boolean; count: number; failureCode: "CandidateHistoryUnexpected" | "CandidateHeadChanged"; reason: string }> {
    const countResult = await this.git(run.worktreePath, ["rev-list", "--count", `${run.baselineSha}..${headSha}`]);
    const count = processSucceeded(countResult) ? Number.parseInt(countResult.stdout.trim(), 10) : Number.NaN;
    if (!Number.isInteger(count)) {
      return { ok: false, count: 0, failureCode: "CandidateHistoryUnexpected", reason: "unable to verify candidate commit history" };
    }
    if (count !== 1) {
      return { ok: false, count, failureCode: "CandidateHistoryUnexpected", reason: `candidate history contains ${count} commit(s), expected exactly one` };
    }
    const parentResult = await this.git(run.worktreePath, ["rev-list", "--parents", "-n", "1", headSha]);
    const fields = parentResult.stdout.trim().split(/\s+/).filter(Boolean);
    if (!processSucceeded(parentResult) || fields.length !== 2 || fields[1]!.toLowerCase() !== run.baselineSha.toLowerCase()) {
      return { ok: false, count, failureCode: "CandidateHistoryUnexpected", reason: "candidate commit parent is not the recorded baseline" };
    }
    return { ok: true, count, failureCode: "CandidateHistoryUnexpected", reason: "" };
  }

  private async verifyArtifacts(run: ImprovementImplementationRun): Promise<{ valid: boolean; candidateReportPresent: boolean }> {
    const artifacts = run.artifacts ?? [];
    let valid = artifacts.length > 0;
    let candidateReportPresent = false;
    for (const artifact of artifacts) {
      if (artifact.kind === "candidate-report") candidateReportPresent = true;
      const absolute = path.resolve(artifact.path);
      const relative = path.relative(this.artifactRoot, absolute).replace(/\\/g, "/");
      if (relative.startsWith("..") || path.isAbsolute(relative) || !relative.startsWith(`${run.runId}/`)) {
        valid = false;
        continue;
      }
      try {
        const info = await lstat(absolute);
        if (!info.isFile() || info.size !== artifact.bytes) {
          valid = false;
          continue;
        }
        const content = await readFile(absolute);
        const actual = createHash("sha256").update(content).digest("hex");
        if (actual.toLowerCase() !== artifact.sha256.toLowerCase()) valid = false;
      } catch {
        valid = false;
      }
    }
    return { valid, candidateReportPresent };
  }

  private async classifyBaseDrift(baselineSha: string, currentBaseSha: string, proposal: ImprovementProposal): Promise<CandidateReviewResult["baseDrift"]> {
    if (baselineSha.toLowerCase() === currentBaseSha.toLowerCase()) {
      return { classification: "NO_DRIFT", changedFiles: [], significant: false, revalidationRequired: false };
    }
    const changedFiles = await this.changedFilesBetween(baselineSha, currentBaseSha);
    const significant = changedFiles.some(file => isRelevantBaseChange(file, proposal));
    const ancestor = await this.git(this.options.worktrees.repositoryRoot, ["merge-base", "--is-ancestor", baselineSha, currentBaseSha]);
    let classification: BaseDriftClassification;
    if (processSucceeded(ancestor)) classification = significant ? "SIGNIFICANT_DRIFT" : "FAST_FORWARD_DRIFT";
    else classification = significant ? "SIGNIFICANT_DRIFT" : "CONFLICTING_DRIFT";
    const revalidationRequired = this.policy === "on-base-change"
      ? true
      : this.policy === "on-significant-base-change"
        ? significant
        : false;
    // A publication is conservative even for an unrelated fast-forward. The
    // policy still records whether the configured policy requires re-running
    // validation, while CandidatePublish blocks every non-NO_DRIFT base.
    return { classification, changedFiles, significant, revalidationRequired };
  }

  private async changedFilesBetween(left: string, right: string): Promise<string[]> {
    const result = await this.git(this.options.worktrees.repositoryRoot, ["diff", "--name-only", left, right, "--"]);
    if (!processSucceeded(result)) return [];
    return Array.from(new Set(result.stdout.split(/\r?\n/).map(value => value.trim().replace(/\\/g, "/")).filter(Boolean))).sort();
  }
}

function validationPassedForCandidate(result: ImprovementImplementationRun["validationResult"], proposal: ImprovementProposal): boolean {
  if (!result || !result.implementationComplete || !result.candidate) return false;
  const verdictAllowed = result.verdict === "improved" || (result.verdict === "neutral" && ["documentation", "test-coverage", "skill"].includes(proposal.category));
  return verdictAllowed
    && result.tests.length > 0
    && result.tests.every(test => test.status === "passed")
    && result.regressions.length === 0
    && result.safetyChecks.length > 0
    && result.safetyChecks.every(check => check.passed);
}

function isRelevantBaseChange(file: string, proposal: ImprovementProposal): boolean {
  const normalized = file.replace(/\\/g, "/");
  const areas = [...proposal.proposedChange.allowedAreas, ...proposal.proposedChange.forbiddenAreas].map(area => area.replace(/\\/g, "/").replace(/^\.\//, ""));
  return areas.some(area => normalized === area || normalized.startsWith(`${area}/`))
    || normalized.startsWith("tests/")
    || normalized === "package.json"
    || normalized === "package-lock.json"
    || normalized.startsWith("src/");
}

function isDebugErrorCode(value: string | undefined): value is ConstructorParameters<typeof DebugMcpError>[0] {
  return value !== undefined;
}
