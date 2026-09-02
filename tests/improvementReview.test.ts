import { afterEach, describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { improvementProposalSchema, type ImprovementProposal } from "../src/improvement/ProposalSchemas.js";
import { InMemoryImprovementProposalStore } from "../src/improvement/ProposalRepository.js";
import { improvementImplementationRunSchema, type ImprovementImplementationRun } from "../src/improvement/implementation/ImplementationSchemas.js";
import { InMemoryImprovementImplementationRunStore } from "../src/improvement/implementation/ImplementationRunRepository.js";
import { ImprovementWorktreeManager } from "../src/improvement/implementation/ImprovementWorktreeManager.js";
import { processSucceeded, runProcess, type ProcessRunResult } from "../src/improvement/implementation/ProcessRunner.js";
import { CandidateReviewService } from "../src/improvement/review/CandidateReviewService.js";
import { CandidatePublishService } from "../src/improvement/review/CandidatePublishService.js";
import { GitHubReviewProvider, type ProviderPullRequest, type ProviderReview } from "../src/improvement/review/GitHubReviewProvider.js";
import { ImprovementPullRequestService } from "../src/improvement/review/ImprovementPullRequestService.js";
import { MergeRecommendationService } from "../src/improvement/review/MergeRecommendationService.js";
import {
  InMemoryImprovementPullRequestStore,
  InMemoryImprovementReviewEvidenceStore,
  InMemoryMergeRecommendationStore
} from "../src/improvement/review/ReviewRepositories.js";
import { reviewPolicyConfigSchema, type ReviewEvidence } from "../src/improvement/review/ReviewSchemas.js";
import { DebugMcpError } from "../src/utils/errors.js";

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
});

describe("Round7 controlled improvement review pipeline", () => {
  test("candidate review requires candidate-ready, clean exact one-commit history and intact artifacts", async () => {
    const fixture = await makeCandidateFixture();
    const review = await fixture.candidateReview.review(fixture.run.runId);

    expect(review).toEqual(expect.objectContaining({
      valid: true,
      publishAllowed: true,
      commitCount: 1,
      candidateReportPresent: true,
      artifactsValid: true,
      clean: true,
      baseDrift: expect.objectContaining({ classification: "NO_DRIFT" })
    }));

    await writeFile(path.join(fixture.repositoryRoot, "tracked.txt"), "dirty\n");
    const dirty = await fixture.candidateReview.review(fixture.run.runId);
    expect(dirty.valid).toBe(false);
    expect(dirty.failureCode).toBe("CandidateDirtyAfterValidation");
  }, 30_000);

  test("candidate publication validates the expected remote, never force-pushes, and is idempotent", async () => {
    const fixture = await makeCandidateFixture();
    const commands: string[][] = [];
    let remoteSha: string | undefined;
    const git = async (_cwd: string, args: readonly string[]): Promise<ProcessRunResult> => {
      commands.push([...args]);
      if (args[0] === "remote") return result(`https://github.com/gjjisadog/C2000_Multicore_Debug_MCP.git\n`);
      if (args[0] === "ls-remote") return result(remoteSha ? `${remoteSha}\trefs/heads/${fixture.run.branchName}\n` : "");
      if (args[0] === "push") {
        remoteSha = fixture.run.candidateCommitSha;
        return result("pushed\n");
      }
      throw new Error(`unexpected fake git command: ${args.join(" ")}`);
    };
    const publisher = new CandidatePublishService({
      runs: fixture.runs,
      worktrees: fixture.worktrees,
      candidateReview: fixture.candidateReview,
      review: fixture.policy,
      git
    });

    const first = await publisher.publish(fixture.run.runId);
    const second = await publisher.publish(fixture.run.runId);
    expect(first).toEqual(expect.objectContaining({ pushed: true, idempotent: false, candidateSha: fixture.run.candidateCommitSha }));
    expect(second).toEqual(expect.objectContaining({ pushed: false, idempotent: true }));
    expect(commands.some(args => args.includes("--force") || args.includes("--force-with-lease") || args.includes("--mirror") || args.includes("--all"))).toBe(false);
    expect(commands.filter(args => args[0] === "push")).toHaveLength(1);
  }, 30_000);

  test("PR publication creates one draft and refresh computes a blocked, candidate-bound recommendation", async () => {
    const fixture = await makeCandidateFixture();
    let publishedSha: string | undefined;
    let remote: ProviderPullRequest | undefined;
    let nextNumber = 41;
    const provider = {
      async createPullRequest(input: { title: string; body: string; branch: string; baseBranch: string; draft: boolean }) {
        remote = providerRecord(fixture, nextNumber++, input.body, true);
        return remote;
      },
      async getPullRequest() { if (!remote) throw new Error("PR missing"); return remote; },
      async findOpenPullRequest() { return remote; },
      async updatePullRequest(_number: number, input: { body?: string }) {
        if (!remote) throw new Error("PR missing");
        remote = { ...remote, ...(input.body === undefined ? {} : { body: input.body }) };
        return remote;
      },
      async listChecks(candidateSha: string) { return [{ name: "host-tests", status: "passed" as const, candidateSha }]; },
      async listReviews(_number: number): Promise<ProviderReview[]> { return [{ id: 1, login: "alice", userType: "User", state: "approved" }]; }
    };
    const publisher = new CandidatePublishService({
      runs: fixture.runs,
      worktrees: fixture.worktrees,
      candidateReview: fixture.candidateReview,
      review: fixture.policy,
      git: async (_cwd, args) => {
        if (args[0] === "remote") return result("https://github.com/gjjisadog/C2000_Multicore_Debug_MCP.git\n");
        if (args[0] === "ls-remote") return result(publishedSha ? `${publishedSha}\trefs/heads/${fixture.run.branchName}\n` : "");
        if (args[0] === "push") { publishedSha = fixture.run.candidateCommitSha; return result("pushed\n"); }
        throw new Error(`unexpected command: ${args.join(" ")}`);
      }
    });
    const service = new ImprovementPullRequestService({
      runs: fixture.runs,
      proposals: fixture.proposals,
      pullRequests: new InMemoryImprovementPullRequestStore(),
      evidence: new InMemoryImprovementReviewEvidenceStore(),
      recommendations: new InMemoryMergeRecommendationStore(),
      candidateReview: fixture.candidateReview,
      candidatePublish: publisher,
      provider,
      review: fixture.policy,
      artifactRoot: fixture.artifactRoot
    });

    const published = await service.publish({ implementationRunId: fixture.run.runId });
    expect(published).toEqual(expect.objectContaining({ created: true, draft: true, requiresHumanMerge: true }));
    const body = String((published.pullRequest as Record<string, unknown>).generatedBodyHash);
    expect(body).toMatch(/^[0-9a-f]{64}$/);
    expect(remote?.body).toContain("c2000-improvement:start");
    expect(remote?.body).not.toContain(fixture.worktreePath);

    const refreshed = await service.refresh({ implementationRunId: fixture.run.runId });
    expect(refreshed.mergeRecommendation).toEqual(expect.objectContaining({ verdict: "BLOCKED" }));
    expect((refreshed.reviewEvidence as ReviewEvidence).candidate.candidateSha).toBe(fixture.run.candidateCommitSha);
  }, 30_000);

  test("deterministic recommendations distinguish conflicts, pending gates, and all-pass human review", () => {
    const fixtureEvidence = (patch: Partial<ReviewEvidence>): ReviewEvidence => ({
      evidenceId: "evidence-test",
      pullRequestId: "pr-test",
      candidateSha: "0123456789abcdef0123456789abcdef01234567",
      checkedAt: "2026-09-02T00:00:00.000Z",
      candidate: { status: "pass", candidateSha: "0123456789abcdef0123456789abcdef01234567", checkedAt: "2026-09-02T00:00:00.000Z" },
      local: { status: "pass", candidateSha: "0123456789abcdef0123456789abcdef01234567", checkedAt: "2026-09-02T00:00:00.000Z" },
      ci: { status: "pass", candidateSha: "0123456789abcdef0123456789abcdef01234567", checkedAt: "2026-09-02T00:00:00.000Z", requiredChecks: [], optionalChecks: [] },
      reviews: { status: "pass", candidateSha: "0123456789abcdef0123456789abcdef01234567", checkedAt: "2026-09-02T00:00:00.000Z", approvals: 1, humanApprovals: 1, botApprovals: 0, changesRequested: false, humanReviewRequired: true },
      hardware: { status: "not-required", candidateSha: "0123456789abcdef0123456789abcdef01234567", checkedAt: "2026-09-02T00:00:00.000Z" },
      base: { status: "pass", candidateSha: "0123456789abcdef0123456789abcdef01234567", checkedAt: "2026-09-02T00:00:00.000Z", classification: "NO_DRIFT" },
      head: { status: "pass", candidateSha: "0123456789abcdef0123456789abcdef01234567", checkedAt: "2026-09-02T00:00:00.000Z" },
      mergeability: "mergeable",
      warnings: [],
      evidenceHash: "a".repeat(64),
      ...patch
    });
    const recommendation = new MergeRecommendationService();
    const pullRequest = {
      pullRequestId: "pr-test",
      proposalId: "proposal-test",
      implementationRunId: "run-test",
      repository: "gjjisadog/C2000_Multicore_Debug_MCP",
      branch: "improve/test-run",
      baseBranch: "master",
      candidateSha: "0123456789abcdef0123456789abcdef01234567",
      baselineSha: "abcdef0123456789abcdef0123456789abcdef01",
      number: 1,
      url: "https://github.com/gjjisadog/C2000_Multicore_Debug_MCP/pull/1",
      title: "test",
      status: "open" as const,
      draft: false,
      createdAt: "2026-09-02T00:00:00.000Z",
      updatedAt: "2026-09-02T00:00:00.000Z",
      generatedBodyHash: "b".repeat(64),
      humanBodyPreserved: true
    };
    expect(recommendation.evaluate({ pullRequest, evidence: fixtureEvidence() }).verdict).toBe("MERGE_RECOMMENDED");
    expect(recommendation.evaluate({ pullRequest: { ...pullRequest, status: "closed" }, evidence: fixtureEvidence() }).verdict).toBe("DO_NOT_MERGE");
    expect(recommendation.evaluate({ pullRequest, evidence: fixtureEvidence({ base: { ...fixtureEvidence().base, status: "stale", classification: "NO_DRIFT" } }) }).verdict).toBe("NEEDS_REVALIDATION");
    expect(recommendation.evaluate({ pullRequest, evidence: fixtureEvidence({ base: { ...fixtureEvidence().base, status: "stale", classification: "SIGNIFICANT_DRIFT" } }) }).verdict).toBe("NEEDS_REVALIDATION");
    expect(recommendation.evaluate({ pullRequest: { ...pullRequest, draft: true }, evidence: fixtureEvidence({ ci: { ...fixtureEvidence().ci, status: "pending" } }) }).verdict).toBe("BLOCKED");
    expect(recommendation.evaluate({ pullRequest, evidence: fixtureEvidence({ mergeability: "conflicting" }) }).verdict).toBe("DO_NOT_MERGE");
  });

  test("GitHub provider does not expose credentials in unavailable errors", async () => {
    const provider = new GitHubReviewProvider({
      repository: "gjjisadog/C2000_Multicore_Debug_MCP",
      apiBaseUrl: "https://api.github.com",
      githubTokenEnv: "ROUND7_TEST_MISSING_TOKEN"
    });
    await expect(provider.getPullRequest(1)).rejects.toMatchObject({ code: "GitHubCredentialsUnavailable" });
    try {
      await provider.getPullRequest(1);
    } catch (error) {
      expect(JSON.stringify((error as DebugMcpError).details)).not.toContain("ROUND7_TEST_MISSING_TOKEN_VALUE");
    }
  });
});

interface CandidateFixture {
  repositoryRoot: string;
  worktreePath: string;
  artifactRoot: string;
  worktrees: ImprovementWorktreeManager;
  runs: InMemoryImprovementImplementationRunStore;
  proposals: InMemoryImprovementProposalStore;
  run: ImprovementImplementationRun;
  proposal: ImprovementProposal;
  candidateReview: CandidateReviewService;
  policy: ReturnType<typeof reviewPolicyConfigSchema.parse>;
}

async function makeCandidateFixture(): Promise<CandidateFixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "c2000-round7-review-"));
  roots.push(root);
  const repositoryRoot = path.join(root, "repository");
  const artifactRoot = path.join(root, "artifacts");
  const worktreeRoot = path.join(root, "worktrees");
  await mkdir(repositoryRoot, { recursive: true });
  await mkdir(artifactRoot, { recursive: true });
  await git(repositoryRoot, ["init", "-b", "master"]);
  await git(repositoryRoot, ["config", "user.email", "round7@example.invalid"]);
  await git(repositoryRoot, ["config", "user.name", "Round7 Test"]);
  await writeFile(path.join(repositoryRoot, "tracked.txt"), "baseline\n");
  await git(repositoryRoot, ["add", "--", "tracked.txt"]);
  await git(repositoryRoot, ["commit", "-m", "baseline"]);
  const baselineSha = (await git(repositoryRoot, ["rev-parse", "HEAD"])).stdout.trim();
  const branch = "improve/round7-candidate";
  await git(repositoryRoot, ["switch", "-c", branch]);
  await writeFile(path.join(repositoryRoot, "tracked.txt"), "candidate\n");
  await git(repositoryRoot, ["add", "--", "tracked.txt"]);
  await git(repositoryRoot, ["commit", "-m", "candidate"]);
  const candidateSha = (await git(repositoryRoot, ["rev-parse", "HEAD"])).stdout.trim();
  const runId = "impl-round7-test";
  const candidateReportPath = path.join(artifactRoot, runId, "candidate-report.md");
  await mkdir(path.dirname(candidateReportPath), { recursive: true });
  const report = "# candidate\nvalidated\n";
  await writeFile(candidateReportPath, report);
  const artifact = {
    kind: "candidate-report" as const,
    path: candidateReportPath,
    sha256: createHash("sha256").update(report).digest("hex"),
    bytes: Buffer.byteLength(report)
  };
  const timestamp = "2026-09-02T00:00:00.000Z";
  const proposal = improvementProposalSchema.parse({
    proposalId: "proposal-round7",
    fingerprint: "abcdef0123456789abcdef01",
    status: "candidate-ready",
    category: "tool-surface",
    target: "review.pipeline",
    title: "Controlled review pipeline",
    summary: "Keep candidate publication under human review.",
    evidence: { matchingRuns: 3, affectedRuns: 3, successAfterEscalation: 0, failureAfterEscalation: 3, sampleWindow: "30d", patternRatio: 1, failureRate: 1, sufficient: true, minimumMatchingRuns: 3, minimumPatternRatio: 0.5, supportingTools: [], supportingCapabilities: [], context: {}, rootCause: "likely-mcp-deficiency", rootCauseReason: "test evidence" },
    proposedChange: { kind: "test-coverage", target: "review.pipeline", description: "Add controlled review evidence.", allowedAreas: ["src/improvement/review"], forbiddenAreas: [], changeScope: "small", implementationMode: "auto-eligible", suggestedTools: [] },
    expectedBenefit: { summary: "Safer review.", metrics: [{ name: "review.gates", direction: "increase", rationale: "more gates" }] },
    risks: [{ level: "low", description: "No target behavior changes.", mitigation: "Run host tests." }],
    validationPlan: { existingTests: ["npm test"], newRegressionTestRequired: true, mockValidation: true, hardwareRequired: false, replayFixtures: [], beforeAfterMetrics: ["review.gates"], rollbackCondition: "Any safety regression.", acceptanceCriteria: ["candidate remains bound"] },
    confidence: 0.9,
    priority: "P2",
    generatedBy: "static-rule",
    sourceWindow: "30d",
    baselineSha,
    createdAt: timestamp,
    updatedAt: timestamp,
    lastObservedAt: timestamp,
    reviewReason: "approved candidate fixture",
    reviewedAt: timestamp,
    reviewedBy: "human-reviewer"
  });
  const preImplementationStatus = { headSha: baselineSha, branchName: "master", clean: true, statusShort: [], changedFiles: [], capturedAt: timestamp };
  const run = improvementImplementationRunSchema.parse({
    runId,
    proposalId: proposal.proposalId,
    baselineSha,
    branchName: branch,
    worktreePath: repositoryRoot,
    createdAt: timestamp,
    status: "candidate-ready",
    agentAttempts: 1,
    preImplementationStatus,
    postImplementationStatus: { headSha: candidateSha, branchName: branch, clean: true, statusShort: [], changedFiles: ["tracked.txt"], capturedAt: timestamp },
    validationResult: { baseline: baselineSha, candidate: candidateSha, implementationComplete: true, tests: [{ name: "host-tests", status: "passed" }], regressions: [], metricDelta: {}, safetyChecks: [{ name: "candidate-scope", passed: true, details: "in scope" }], verdict: "improved", generatedAt: timestamp },
    artifacts: [artifact],
    candidateCommitSha: candidateSha
  });
  const runs = new InMemoryImprovementImplementationRunStore();
  runs.upsert(run);
  const proposals = new InMemoryImprovementProposalStore();
  proposals.upsert(proposal);
  const worktrees = new ImprovementWorktreeManager({ repositoryRoot, worktreeRoot });
  const policy = reviewPolicyConfigSchema.parse({ requiredChecks: [], optionalChecks: [], requireHumanReview: true, requiredApprovingReviews: 0 });
  const candidateReview = new CandidateReviewService({ runs, proposals, worktrees, artifactRoot, baseRef: "master", currentBaseSha: baselineSha });
  return { repositoryRoot, worktreePath: repositoryRoot, artifactRoot, worktrees, runs, proposals, run, proposal, candidateReview, policy };
}

function providerRecord(fixture: CandidateFixture, number: number, body: string, draft: boolean): ProviderPullRequest {
  return {
    number,
    url: `https://github.com/gjjisadog/C2000_Multicore_Debug_MCP/pull/${number}`,
    repository: fixture.policy.repository,
    title: "improve(review.pipeline): Controlled review pipeline",
    body,
    branch: fixture.run.branchName,
    baseBranch: fixture.policy.baseBranch,
    headSha: fixture.run.candidateCommitSha!,
    baseSha: fixture.run.baselineSha,
    state: "open",
    draft,
    merged: false,
    updatedAt: "2026-09-02T00:00:00.000Z",
    mergeable: "mergeable"
  };
}

function result(stdout = "", stderr = ""): ProcessRunResult {
  return { command: "git", args: [], exitCode: 0, signal: null, timedOut: false, stdout, stderr, outputTruncated: false, durationMs: 1 };
}

async function git(cwd: string, args: string[]): Promise<ProcessRunResult> {
  const value = await runProcess({ command: "git", cwd, args, timeoutMs: 30_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  if (!processSucceeded(value)) throw new Error(`git ${args.join(" ")} failed: ${value.stderr}`);
  return value;
}
