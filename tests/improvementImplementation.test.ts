import { afterEach, describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runProcess } from "../src/improvement/implementation/ProcessRunner.js";
import { InMemoryImprovementProposalStore } from "../src/improvement/ProposalRepository.js";
import { ImprovementProposalService } from "../src/improvement/ImprovementProposalService.js";
import type { ImprovementProposal } from "../src/improvement/ProposalSchemas.js";
import { CandidateCommitService } from "../src/improvement/implementation/CandidateCommitService.js";
import { ConfiguredCodingAgent, type CodingAgentRequest, type ImprovementCodingAgent } from "../src/improvement/implementation/ImprovementAgentRunner.js";
import { ImprovementImplementationService } from "../src/improvement/implementation/ImprovementImplementationService.js";
import { ImprovementValidationService, type ValidationCommandRegistry } from "../src/improvement/implementation/ImprovementValidationService.js";
import { InMemoryImprovementImplementationRunStore } from "../src/improvement/implementation/ImplementationRunRepository.js";
import { ImprovementWorktreeManager } from "../src/improvement/implementation/ImprovementWorktreeManager.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
}, 30_000);

describe("Round6 approved improvement implementation", () => {
  test("requires approval and rejects baseline drift before creating a worktree", async () => {
    const fixture = await createFixture();
    const proposal = makeProposal(fixture.baselineSha);
    fixture.proposals.upsert({ ...proposal, status: "ready-for-review" });
    const service = fixture.service(() => fixture.baselineSha);

    await expect(service.start(proposal.proposalId)).rejects.toMatchObject({ code: "ProposalNotApproved" });
    fixture.proposals.upsert({ ...proposal, status: "approved", baselineSha: "deadbeef" });
    await expect(service.start(proposal.proposalId)).rejects.toMatchObject({
      code: "BaselineDrift",
      details: expect.objectContaining({ proposalBaseline: "deadbeef", currentMasterSha: fixture.baselineSha })
    });
    expect(fixture.runs.list()).toHaveLength(0);
  }, 30_000);

  test("edits only an isolated candidate and commits only after independent validation", async () => {
    const fixture = await createFixture();
    const proposal = makeProposal(fixture.baselineSha);
    fixture.proposals.upsert(proposal);
    const service = fixture.service(() => fixture.baselineSha);

    const queued = await service.start(proposal.proposalId);
    const runId = (queued.run as { runId: string }).runId;
    const queuedRun = fixture.runs.get(runId)!;
    expect(queuedRun.status).toBe("created");
    expect(queuedRun.preImplementationStatus.headSha).toBe(fixture.baselineSha);
    expect(queuedRun.branchName).toMatch(/^improve\/imp-round6-test-/);
    expect(queuedRun.worktreePath.startsWith(fixture.worktreeRoot)).toBe(true);
    expect(queuedRun.worktreePath).not.toBe(fixture.repositoryRoot);

    const completed = await service.executeRun(runId);
    expect(completed).toEqual(expect.objectContaining({ success: true, candidateReady: true }));
    const candidate = fixture.runs.get(runId)!;
    expect(candidate.status).toBe("candidate-ready");
    expect(candidate.candidateCommitSha).toMatch(/^[0-9a-f]{40}$/i);
    expect(candidate.validationResult).toEqual(expect.objectContaining({ verdict: "improved", candidate: candidate.candidateCommitSha }));
    expect(fixture.proposals.get(proposal.proposalId)?.status).toBe("candidate-ready");
    expect(await readFile(path.join(candidate.worktreePath, "src", "approved-change.txt"), "utf8")).toBe("candidate\n");

    const commit = await runProcess({ command: "git", args: ["log", "-1", "--format=%B"], cwd: candidate.worktreePath, timeoutMs: 10_000 });
    expect(commit.exitCode).toBe(0);
    expect(commit.stdout).toContain(`Proposal: ${proposal.proposalId}`);
    expect(commit.stdout).toContain(`Implementation-Run: ${runId}`);
    expect(commit.stdout).toContain(`Baseline: ${fixture.baselineSha}`);

    const candidateResult = service.getCandidate(runId);
    expect(candidateResult.candidate).toEqual(expect.objectContaining({ candidateCommitSha: candidate.candidateCommitSha, requiresHumanMerge: true, pushesAutomatically: false }));
    await service.cleanup(runId);
    expect(fixture.runs.get(runId)?.status).toBe("cleanup-complete");
  }, 30_000);

  test("performs at most one bounded repair and writes a deterministic Markdown candidate report", async () => {
    const agent = new RepairingAgent();
    const fixture = await createFixture({
      agent,
      commands: {
        resolve: () => [{
          name: "candidate-content",
          stage: "focused",
          command: process.execPath,
          args: ["-e", "const fs=require('fs'); const p='src/approved-change.txt'; process.exit(!fs.existsSync(p) || fs.readFileSync(p,'utf8').trim()==='candidate' ? 0 : 1)"],
          timeoutMs: 10_000
        }]
      }
    });
    const proposal = makeProposal(fixture.baselineSha);
    fixture.proposals.upsert(proposal);
    const service = fixture.service(() => fixture.baselineSha);
    const queued = await service.start(proposal.proposalId);
    const runId = (queued.run as { runId: string }).runId;
    const result = await service.executeRun(runId);
    expect(result).toEqual(expect.objectContaining({ success: true, candidateReady: true }));
    const run = fixture.runs.get(runId)!;
    expect(agent.calls).toBe(2);
    expect(run.agentAttempts).toBe(2);
    expect(run.artifacts?.map(artifact => path.basename(artifact.path))).toEqual(expect.arrayContaining([
      "agent-result.json",
      "agent-result-attempt-2.json",
      "validation-summary-attempt-1.json",
      "validation-summary-attempt-2.json",
      "candidate-report.md"
    ]));
    for (const artifact of run.artifacts ?? []) {
      const content = await readFile(artifact.path);
      expect(createHash("sha256").update(content).digest("hex")).toBe(artifact.sha256);
      expect(content.byteLength).toBe(artifact.bytes);
    }
    expect(await readFile(path.join(fixture.artifactRoot, runId, "candidate-report.md"), "utf8")).toContain("Agent attempts: 2");
    await service.cleanup(runId);
  }, 30_000);

  test("rejects agent writes outside the assigned candidate worktree", async () => {
    const fixture = await createFixture({ agent: new WritingAgent(["../outside.txt"]) });
    const proposal = makeProposal(fixture.baselineSha);
    fixture.proposals.upsert(proposal);
    const service = fixture.service(() => fixture.baselineSha);
    const queued = await service.start(proposal.proposalId);
    const runId = (queued.run as { runId: string }).runId;
    const result = await service.executeRun(runId);
    expect(result.success).toBe(false);
    expect(result.run).toEqual(expect.objectContaining({
      status: "agent-failed",
      failureReason: expect.stringContaining("outside its assigned improvement worktree")
    }));
    await service.cleanup(runId);
  }, 30_000);

  test("rechecks the master baseline before creating a candidate commit", async () => {
    let currentMasterSha = "";
    const agent = new WritingAgent(["src/approved-change.txt"], () => { currentMasterSha = "deadbeef"; });
    const fixture = await createFixture({ agent });
    currentMasterSha = fixture.baselineSha;
    const proposal = makeProposal(fixture.baselineSha);
    fixture.proposals.upsert(proposal);
    const service = fixture.service(() => currentMasterSha);
    const queued = await service.start(proposal.proposalId);
    const runId = (queued.run as { runId: string }).runId;
    const result = await service.executeRun(runId);
    expect(result.success).toBe(false);
    expect(fixture.runs.get(runId)).toEqual(expect.objectContaining({ status: "rejected" }));
    expect(fixture.runs.get(runId)).not.toHaveProperty("candidateCommitSha");
    await service.cleanup(runId);
  }, 30_000);

  test("rejects dependency manifest edits unless the Proposal explicitly scopes dependency intent", async () => {
    const fixture = await createFixture({ agent: new WritingAgent(["package.json"]) });
    const proposal = makeProposal(fixture.baselineSha, { allowedAreas: ["package.json"] });
    fixture.proposals.upsert(proposal);
    const service = fixture.service(() => fixture.baselineSha);
    const queued = await service.start(proposal.proposalId);
    const runId = (queued.run as { runId: string }).runId;
    const result = await service.executeRun(runId);
    expect(result.success).toBe(false);
    expect(result.run).toEqual(expect.objectContaining({ status: "agent-failed", failureReason: expect.stringContaining("dependency manifest") }));
    await service.cleanup(runId);
  }, 30_000);

  test("scope violations and agent commits fail closed without becoming candidates", async () => {
    const fixture = await createFixture({ agent: new WritingAgent(["outside.txt"]) });
    const proposal = makeProposal(fixture.baselineSha);
    fixture.proposals.upsert(proposal);
    const service = fixture.service(() => fixture.baselineSha);
    const queued = await service.start(proposal.proposalId);
    const runId = (queued.run as { runId: string }).runId;
    const result = await service.executeRun(runId);
    expect(result.success).toBe(false);
    expect(fixture.runs.get(runId)).toEqual(expect.objectContaining({ status: "agent-failed", failureReason: expect.stringContaining("approved implementation scope") }));
    expect(fixture.proposals.get(proposal.proposalId)?.status).toBe("implementation-failed");
    await service.cleanup(runId);

    const commitAgent: ImprovementCodingAgent = {
      provider: "test-agent",
      async run(request: CodingAgentRequest) {
        await writeFile(path.join(request.worktreePath, "src", "agent-commit.txt"), "agent\n");
        await runProcess({ command: "git", args: ["add", "--", "src/agent-commit.txt"], cwd: request.worktreePath, timeoutMs: 10_000 });
        await runProcess({ command: "git", args: ["commit", "-m", "agent must not commit"], cwd: request.worktreePath, timeoutMs: 10_000 });
        return { provider: "test-agent", status: "completed", agentRunId: request.runId, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), assumptionInvalid: false };
      }
    };
    const committedFixture = await createFixture({ agent: commitAgent });
    const committedProposal = makeProposal(committedFixture.baselineSha);
    committedFixture.proposals.upsert(committedProposal);
    const committedService = committedFixture.service(() => committedFixture.baselineSha);
    const committedQueued = await committedService.start(committedProposal.proposalId);
    const committedResult = await committedService.executeRun((committedQueued.run as { runId: string }).runId);
    expect(committedResult.success).toBe(false);
    expect(committedResult.run).toEqual(expect.objectContaining({ status: "agent-failed", failureReason: expect.stringContaining("changed Git HEAD") }));
    await committedService.cleanup((committedQueued.run as { runId: string }).runId);
  }, 30_000);

  test("hardware-required validation remains pending and never creates a candidate commit", async () => {
    const fixture = await createFixture();
    const proposal = makeProposal(fixture.baselineSha, { hardwareRequired: true });
    fixture.proposals.upsert(proposal);
    const service = fixture.service(() => fixture.baselineSha);
    const queued = await service.start(proposal.proposalId);
    const runId = (queued.run as { runId: string }).runId;
    const result = await service.executeRun(runId);
    expect(result).toEqual(expect.objectContaining({ success: false, validationPending: true, hardwareStatus: "NOT_RUN_HARDWARE" }));
    expect(fixture.runs.get(runId)).toEqual(expect.objectContaining({ status: "validation-pending", validationResult: expect.objectContaining({ verdict: "inconclusive" }) }));
    expect(fixture.runs.get(runId)).not.toHaveProperty("candidateCommitSha");
    expect(fixture.proposals.get(proposal.proposalId)?.status).toBe("validation-pending");
    await expect(service.cleanup(runId)).rejects.toMatchObject({ code: "CleanupNotAllowed" });
    const run = fixture.runs.get(runId)!;
    await fixture.worktrees.remove(run.worktreePath);
  }, 30_000);

  test("restart reconciliation interrupts active runs without resuming them", async () => {
    const fixture = await createFixture();
    const proposal = makeProposal(fixture.baselineSha);
    fixture.proposals.upsert(proposal);
    const service = fixture.service(() => fixture.baselineSha);
    const queued = await service.start(proposal.proposalId);
    const runId = (queued.run as { runId: string }).runId;
    const interrupted = service.reconcileOnStartup();
    expect(interrupted.map(run => run.runId)).toContain(runId);
    expect(fixture.runs.get(runId)).toEqual(expect.objectContaining({ status: "interrupted", failureReason: expect.stringContaining("automatic resume is disabled") }));
    expect(fixture.proposals.get(proposal.proposalId)?.status).toBe("implementation-failed");
    await service.cleanup(runId);
  }, 30_000);
});

class WritingAgent implements ImprovementCodingAgent {
  readonly provider = "test-agent";

  constructor(private readonly files: string[], private readonly onRun?: () => void) {}

  async run(request: CodingAgentRequest) {
    this.onRun?.();
    for (const file of this.files) {
      const target = path.join(request.worktreePath, file);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, "candidate\n");
    }
    return { provider: this.provider, status: "completed" as const, agentRunId: request.runId, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), assumptionInvalid: false };
  }
}

class RepairingAgent implements ImprovementCodingAgent {
  readonly provider = "repairing-test-agent";
  calls = 0;

  async run(request: CodingAgentRequest) {
    this.calls += 1;
    await writeFile(path.join(request.worktreePath, "src", "approved-change.txt"), this.calls === 1 ? "fail\n" : "candidate\n");
    return {
      provider: this.provider,
      status: "completed" as const,
      agentRunId: `${request.runId}-attempt-${this.calls}`,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      assumptionInvalid: false,
      summary: request.repairContext ? "Applied one bounded repair" : "Created initial candidate"
    };
  }
}

async function createFixture(options: { agent?: ImprovementCodingAgent; commands?: ValidationCommandRegistry } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "c2000-round6-"));
  roots.push(root);
  const repositoryRoot = path.join(root, "repo");
  const worktreeRoot = path.join(root, "worktrees");
  const artifactRoot = path.join(root, "artifacts");
  await mkdir(path.join(repositoryRoot, "src"), { recursive: true });
  await writeFile(path.join(repositoryRoot, "package.json"), JSON.stringify({ name: "round6-fixture", scripts: {} }, null, 2));
  await writeFile(path.join(repositoryRoot, "src", "original.txt"), "original\n");
  await git(repositoryRoot, ["init", "-b", "master"]);
  await git(repositoryRoot, ["config", "user.email", "round6@example.invalid"]);
  await git(repositoryRoot, ["config", "user.name", "Round6 Test"]);
  await git(repositoryRoot, ["add", "."]);
  await git(repositoryRoot, ["commit", "-m", "fixture baseline"]);
  const baselineSha = (await git(repositoryRoot, ["rev-parse", "HEAD"])).stdout.trim();
  const proposals = new InMemoryImprovementProposalStore();
  const runs = new InMemoryImprovementImplementationRunStore();
  const worktrees = new ImprovementWorktreeManager({ repositoryRoot, worktreeRoot });
  const commands: ValidationCommandRegistry = { resolve: () => [{ name: "fixture-pass", stage: "mock", command: process.execPath, args: ["-e", "process.exit(0)"], timeoutMs: 10_000 }] };
  const validation = new ImprovementValidationService({ worktrees, artifactRoot, commands: options.commands ?? commands });
  const agent = options.agent ?? new WritingAgent(["src/approved-change.txt"]);
  const makeService = (currentMasterSha: () => string | Promise<string | undefined>) => {
    const proposalService = new ImprovementProposalService({ proposals, events: { list: () => [] } as any, currentBaselineSha: currentMasterSha as () => string | undefined });
    return new ImprovementImplementationService({
      proposals,
      proposalService,
      runs,
      worktrees,
      agent,
      validation,
      candidateCommits: new CandidateCommitService(worktrees),
      artifactRoot,
      currentMasterSha,
      enabled: true,
      autoStart: false
    });
  };
  const service = (currentMasterSha: () => string | Promise<string | undefined>) => makeService(currentMasterSha);
  return { root, repositoryRoot, worktreeRoot, artifactRoot, baselineSha, proposals, runs, worktrees, service };
}

function makeProposal(baselineSha: string, overrides: { hardwareRequired?: boolean; allowedAreas?: string[] } = {}): ImprovementProposal {
  const now = new Date().toISOString();
  return {
    proposalId: "imp-round6-test-001",
    fingerprint: "abcdef0123456789abcdef01",
    status: "approved",
    category: "workflow",
    target: "workflow.test",
    title: "Improve the approved workflow fixture",
    summary: "A bounded Round6 implementation fixture.",
    evidence: {
      matchingRuns: 20,
      affectedRuns: 10,
      successAfterEscalation: 8,
      failureAfterEscalation: 2,
      sampleWindow: "7d",
      patternRatio: 0.5,
      failureRate: 0.2,
      sufficient: true,
      minimumMatchingRuns: 10,
      minimumPatternRatio: 0.2,
      supportingTools: [],
      supportingCapabilities: [],
      context: {},
      rootCause: "likely-mcp-deficiency",
      rootCauseReason: "fixture"
    },
    proposedChange: {
      kind: "workflow-gap",
      target: "workflow.test",
      description: "Make the fixture workflow easier to use.",
      allowedAreas: overrides.allowedAreas ?? ["src"],
      forbiddenAreas: ["package.json", "src/protected"],
      changeScope: "small",
      implementationMode: "auto-eligible",
      suggestedTools: []
    },
    expectedBenefit: { summary: "The workflow fixture passes its validation.", metrics: [{ name: "fixture-pass", direction: "increase", rationale: "test" }] },
    risks: [{ level: "low", description: "Fixture only.", mitigation: "Run the independent validation." }],
    validationPlan: {
      existingTests: ["fixture-pass"],
      newRegressionTestRequired: false,
      mockValidation: true,
      hardwareRequired: overrides.hardwareRequired ?? false,
      replayFixtures: [],
      beforeAfterMetrics: ["fixture-pass"],
      rollbackCondition: "Any validation regression.",
      acceptanceCriteria: ["The fixture validation passes."]
    },
    confidence: 0.9,
    priority: "P2",
    generatedBy: "analytics-pattern",
    sourceWindow: "7d",
    baselineSha,
    createdAt: now,
    updatedAt: now,
    lastObservedAt: now,
    reviewReason: "Approved for the Round6 fixture.",
    reviewedAt: now,
    reviewedBy: "test-reviewer"
  };
}

async function git(cwd: string, args: string[]) {
  const result = await runProcess({ command: "git", args, cwd, timeoutMs: 20_000 });
  if (result.exitCode !== 0 || result.timedOut) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result;
}
