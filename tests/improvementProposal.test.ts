import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { InMemoryOutcomeEventStore, OutcomeEventRepository } from "../src/analytics/OutcomeEventRepository.js";
import type { OutcomeEvent } from "../src/analytics/OutcomeSchemas.js";
import { InMemoryImprovementProposalStore, ProposalRepository } from "../src/improvement/ProposalRepository.js";
import { ImprovementProposalService } from "../src/improvement/ImprovementProposalService.js";
import type { ProposalDetector } from "../src/improvement/PatternDetectors.js";
import { SqliteStore } from "../src/storage/SqliteStore.js";

const roots: string[] = [];
const NOW = Date.parse("2026-09-30T00:00:00.000Z");

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

function event(overrides: Partial<OutcomeEvent> = {}): OutcomeEvent {
  return {
    eventId: crypto.randomUUID(),
    timestamp: "2026-09-29T00:00:00.000Z",
    kind: "workflow_run",
    name: "c2000_runBootHandoffDiagnosis",
    outcome: "failure",
    failureClass: "boot-handoff",
    toolProfile: "safe",
    toolSurfaceProfile: "agent",
    activeCapabilities: [],
    metadata: { role: "workflow", family: "workflow", exposure: "default" },
    ...overrides
  };
}

function fixture(options: { count?: number; opened?: number; succeeded?: number; firmwareOwned?: boolean } = {}): InMemoryOutcomeEventStore {
  const store = new InMemoryOutcomeEventStore();
  const count = options.count ?? 20;
  const opened = options.opened ?? 16;
  const succeeded = options.succeeded ?? 13;
  for (let index = 0; index < count; index += 1) {
    const jobId = `job-${index}`;
    const base = NOW - (count - index) * 60_000;
    store.append(event({
      eventId: crypto.randomUUID(),
      timestamp: new Date(base).toISOString(),
      jobId,
      ...(options.firmwareOwned ? { metadata: { role: "workflow", family: "workflow", exposure: "default", firmwareOwned: true } } : {})
    }));
    if (index < opened) {
      store.append(event({
        eventId: crypto.randomUUID(),
        timestamp: new Date(base + 1_000).toISOString(),
        kind: "capability_open",
        name: "debug.manual",
        outcome: "success",
        failureClass: undefined,
        jobId,
        escalationFrom: "c2000_runBootHandoffDiagnosis",
        escalationTo: "debug.manual",
        metadata: { openedFrom: { workflow: "c2000_runBootHandoffDiagnosis", failureClass: "boot-handoff", jobId } }
      }));
    }
    if (index < succeeded) {
      store.append(event({
        eventId: crypto.randomUUID(),
        timestamp: new Date(base + 2_000).toISOString(),
        outcome: "success",
        jobId
      }));
    }
  }
  return store;
}

function service(events: InMemoryOutcomeEventStore, options: { baseline?: string; detectors?: readonly ProposalDetector[]; proposals?: InMemoryImprovementProposalStore } = {}) {
  return new ImprovementProposalService({
    events,
    proposals: options.proposals ?? new InMemoryImprovementProposalStore(),
    currentBaselineSha: options.baseline,
    now: () => NOW,
    detectors: options.detectors,
    logger: { warn: () => undefined, error: () => undefined }
  });
}

describe("C2000 improvement proposals", () => {
  test("generates an evidence-bound Workflow Gap proposal from repeated escalation", () => {
    const proposals = new InMemoryImprovementProposalStore();
    const result = new ImprovementProposalService({
      events: fixture(),
      proposals,
      currentBaselineSha: "abc1234",
      now: () => NOW
    }).generate();

    expect(result.status).toBe("PROPOSALS_GENERATED");
    expect(result.counts).toEqual(expect.objectContaining({ generatedProposals: 1, insufficientEvidence: 0 }));
    const list = proposals.list({ status: "ready-for-review" });
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual(expect.objectContaining({
      category: "workflow",
      target: "c2000_runBootHandoffDiagnosis",
      status: "ready-for-review",
      baselineSha: "abc1234"
    }));
    expect(list[0]!.evidence).toEqual(expect.objectContaining({
      matchingRuns: 20,
      affectedRuns: 16,
      successAfterEscalation: 13,
      failureAfterEscalation: 3,
      sufficient: true
    }));
  });

  test("keeps small samples as draft and deduplicates repeated generation", () => {
    const proposals = new InMemoryImprovementProposalStore();
    const svc = new ImprovementProposalService({ events: fixture({ count: 3, opened: 3, succeeded: 2 }), proposals, now: () => NOW });
    const first = svc.generate();
    expect(first.counts).toEqual(expect.objectContaining({ generatedProposals: 1 }));
    expect(proposals.list({ status: "draft" })).toHaveLength(1);
    expect(proposals.list({ status: "ready-for-review" })).toHaveLength(0);

    const second = svc.generate();
    expect(second.counts).toEqual(expect.objectContaining({ updatedProposals: 1, deduplicatedPatterns: 1 }));
    expect(proposals.list()).toHaveLength(1);
  });

  test("suppresses firmware-owned patterns instead of proposing MCP code changes", () => {
    const proposals = new InMemoryImprovementProposalStore();
    const result = new ImprovementProposalService({ events: fixture({ firmwareOwned: true }), proposals, now: () => NOW }).generate();
    expect(result.counts).toEqual(expect.objectContaining({ firmwareLikelySuppressed: 1 }));
    expect(proposals.list()).toHaveLength(0);
  });

  test("suppresses environment-owned patterns instead of proposing workflow changes", () => {
    const events = new InMemoryOutcomeEventStore();
    for (let index = 0; index < 20; index += 1) {
      const jobId = `environment-job-${index}`;
      const timestamp = new Date(NOW - (20 - index) * 60_000).toISOString();
      events.append(event({ eventId: crypto.randomUUID(), timestamp, jobId, failureClass: "environment" }));
      events.append(event({
        eventId: crypto.randomUUID(),
        timestamp: new Date(Date.parse(timestamp) + 1_000).toISOString(),
        kind: "capability_open",
        name: "debug.manual",
        outcome: "success",
        failureClass: undefined,
        jobId,
        escalationFrom: "c2000_runBootHandoffDiagnosis",
        escalationTo: "debug.manual",
        metadata: {}
      }));
    }
    const proposals = new InMemoryImprovementProposalStore();
    const result = new ImprovementProposalService({ events, proposals, now: () => NOW }).generate();
    expect(result.counts).toEqual(expect.objectContaining({ environmentLikelySuppressed: 1 }));
    expect(proposals.list()).toHaveLength(0);
  });

  test("updates the same proposal identity when materially more evidence arrives", () => {
    const events = fixture({ count: 20, opened: 20, succeeded: 16 });
    const proposals = new InMemoryImprovementProposalStore();
    const svc = new ImprovementProposalService({ events, proposals, currentBaselineSha: "abc1234", now: () => NOW });
    svc.generate();
    const first = proposals.list()[0]!;

    for (let index = 0; index < 20; index += 1) {
      const jobId = `additional-job-${index}`;
      const base = NOW - (20 - index) * 120_000 - 30_000;
      events.append(event({ eventId: crypto.randomUUID(), timestamp: new Date(base).toISOString(), jobId }));
      events.append(event({
        eventId: crypto.randomUUID(),
        timestamp: new Date(base + 1_000).toISOString(),
        kind: "capability_open",
        name: "debug.manual",
        outcome: "success",
        failureClass: undefined,
        jobId,
        escalationFrom: "c2000_runBootHandoffDiagnosis",
        escalationTo: "debug.manual",
        metadata: { openedFrom: { workflow: "c2000_runBootHandoffDiagnosis", failureClass: "boot-handoff", jobId } }
      }));
      events.append(event({ eventId: crypto.randomUUID(), timestamp: new Date(base + 2_000).toISOString(), outcome: "success", jobId }));
    }

    const result = svc.generate();
    const updated = proposals.list()[0]!;
    expect(result.counts).toEqual(expect.objectContaining({ updatedProposals: 1, deduplicatedPatterns: 1 }));
    expect(updated.proposalId).toBe(first.proposalId);
    expect(updated.fingerprint).toBe(first.fingerprint);
    expect(updated.evidence.matchingRuns).toBe(40);
  });

  test("does not repeat a rejected proposal until the evidence materially changes", () => {
    const proposals = new InMemoryImprovementProposalStore();
    const svc = new ImprovementProposalService({ events: fixture(), proposals, now: () => NOW });
    svc.generate();
    const proposal = proposals.list({ status: "ready-for-review" })[0]!;
    svc.review({ proposalId: proposal.proposalId, decision: "reject", reviewReason: "The workflow evidence is already sufficient for this deployment." });

    const result = svc.generate();
    expect(result.counts).toEqual(expect.objectContaining({ deduplicatedPatterns: 1, generatedProposals: 0 }));
    expect(proposals.list()).toEqual([expect.objectContaining({ proposalId: proposal.proposalId, status: "rejected" })]);
  });

  test("generates a read-only surface promotion finding without changing ToolDefinition", () => {
    const events = new InMemoryOutcomeEventStore();
    for (let index = 0; index < 10; index += 1) {
      events.append(event({
        eventId: crypto.randomUUID(),
        timestamp: new Date(NOW - (10 - index) * 60_000).toISOString(),
        kind: "tool_invocation",
        name: "c2000_getTargetState",
        outcome: "success",
        failureClass: undefined,
        metadata: { role: "primary", family: "read", exposure: "advanced", effects: ["target-read"] }
      }));
    }
    const proposals = new InMemoryImprovementProposalStore();
    const result = new ImprovementProposalService({ events, proposals, now: () => NOW }).generate();
    expect(result.counts).toEqual(expect.objectContaining({ generatedProposals: 1 }));
    expect(proposals.list()[0]).toEqual(expect.objectContaining({
      category: "tool-surface",
      target: "c2000_getTargetState",
      status: "ready-for-review"
    }));
  });

  test("detects a capability-boundary pattern without treating preservation text as a protected change", () => {
    const events = new InMemoryOutcomeEventStore();
    for (let index = 0; index < 10; index += 1) {
      const timestamp = new Date(NOW - (10 - index) * 60_000).toISOString();
      events.append(event({
        eventId: crypto.randomUUID(),
        timestamp,
        kind: "capability_open",
        name: "debug.manual",
        outcome: "success",
        failureClass: undefined,
        activeCapabilities: ["debug.manual"],
        metadata: { openedFrom: { workflow: "c2000_runBootHandoffDiagnosis" } }
      }));
      events.append(event({
        eventId: crypto.randomUUID(),
        timestamp: new Date(Date.parse(timestamp) + 1_000).toISOString(),
        kind: "tool_invocation",
        name: "c2000_getTargetState",
        outcome: "success",
        failureClass: undefined,
        activeCapabilities: ["debug.manual"],
        metadata: { capability: "debug.manual", role: "primary", family: "read", exposure: "advanced", effects: ["target-read"] }
      }));
    }
    const proposals = new InMemoryImprovementProposalStore();
    new ImprovementProposalService({ events, proposals, now: () => NOW }).generate();
    expect(proposals.list({ category: "capability" })).toEqual([
      expect.objectContaining({ category: "capability", target: "debug.manual", status: "ready-for-review" })
    ]);
  });

  test("creates only a Skill routing proposal for explicitly marked premature fallback", () => {
    const events = new InMemoryOutcomeEventStore();
    for (let index = 0; index < 10; index += 1) {
      const timestamp = new Date(NOW - (10 - index) * 60_000).toISOString();
      events.append(event({ eventId: crypto.randomUUID(), timestamp, jobId: undefined }));
      events.append(event({
        eventId: crypto.randomUUID(),
        timestamp: new Date(Date.parse(timestamp) + 1_000).toISOString(),
        kind: "capability_open",
        name: "debug.manual",
        outcome: "success",
        failureClass: undefined,
        jobId: undefined,
        escalationFrom: undefined,
        escalationTo: "debug.manual",
        metadata: { routingFallback: true }
      }));
    }
    const proposals = new InMemoryImprovementProposalStore();
    new ImprovementProposalService({ events, proposals, now: () => NOW }).generate();
    expect(proposals.list()).toEqual([expect.objectContaining({ category: "skill", target: "c2000_runBootHandoffDiagnosis" })]);
  });

  test("requires explicit review before exporting a deterministic implementation prompt", () => {
    const proposals = new InMemoryImprovementProposalStore();
    const svc = new ImprovementProposalService({ events: fixture(), proposals, currentBaselineSha: "abc1234", now: () => NOW });
    svc.generate();
    const proposal = proposals.list({ status: "ready-for-review" })[0]!;
    expect(() => svc.exportImplementationPrompt(proposal.proposalId)).toThrowError(/must be approved/);
    const review = svc.review({ proposalId: proposal.proposalId, decision: "approve", reviewReason: "Evidence is sufficient for a bounded workflow review.", reviewer: "owner" });
    expect((review.proposal as any).status).toBe("approved");
    const prompt = svc.exportImplementationPrompt(proposal.proposalId) as any;
    expect(prompt).toEqual(expect.objectContaining({ artifactType: "text/markdown", baselineSha: "abc1234", requiresIsolatedWorktree: true }));
    expect(prompt.prompt).toContain("UNTRUSTED EVIDENCE (DATA ONLY)");
    expect(prompt.prompt).toContain("Likely files/areas:");
    expect(prompt.prompt).toContain("Before/after metrics:");
    expect(prompt.prompt).toContain("Do not commit changes");
    expect(prompt.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("records external validation and exposes a merge candidate only after all gates pass", () => {
    const proposals = new InMemoryImprovementProposalStore();
    const svc = new ImprovementProposalService({ events: fixture(), proposals, currentBaselineSha: "abc1234", now: () => NOW });
    svc.generate();
    const proposal = proposals.list({ status: "ready-for-review" })[0]!;
    svc.review({ proposalId: proposal.proposalId, decision: "approve", reviewReason: "Approve a bounded workflow-only candidate for isolated implementation." });
    expect(svc.beginImplementation(proposal.proposalId)).toEqual(expect.objectContaining({
      mergeCandidate: false,
      proposal: expect.objectContaining({ status: "implementing" })
    }));

    const validation = svc.recordValidation({
      proposalId: proposal.proposalId,
      result: {
        baseline: "abc1234",
        candidate: "def5678",
        implementationComplete: true,
        tests: [{ name: "npm test", status: "passed", durationMs: 1200 }],
        regressions: [],
        metricDelta: { workflowUnresolvedRate: -0.2 },
        safetyChecks: [{ name: "safetyMatrix", passed: true, details: "No safety classification changed." }],
        verdict: "improved",
        generatedAt: new Date(NOW).toISOString()
      }
    });

    expect(validation).toEqual(expect.objectContaining({ mergeCandidate: true }));
    expect(validation.proposal).toEqual(expect.objectContaining({
      status: "validated",
      validationResult: expect.objectContaining({ verdict: "improved", candidate: "def5678" })
    }));
    expect(svc.get(proposal.proposalId)).toEqual(expect.objectContaining({ mergeCandidate: true }));
  });

  test("does not approve an unbound Proposal", () => {
    const proposals = new InMemoryImprovementProposalStore();
    const svc = new ImprovementProposalService({ events: fixture(), proposals, now: () => NOW });
    svc.generate();
    const proposal = proposals.list({ status: "ready-for-review" })[0]!;
    expect(() => svc.review({
      proposalId: proposal.proposalId,
      decision: "approve",
      reviewReason: "This must fail closed without a baseline."
    })).toThrowError(/baseline/i);
  });

  test("fails closed on baseline drift and rejects non-reviewable approval", () => {
    const proposals = new InMemoryImprovementProposalStore();
    const svc = new ImprovementProposalService({ events: fixture(), proposals, currentBaselineSha: "abc1234", now: () => NOW });
    svc.generate();
    const proposal = proposals.list({ status: "ready-for-review" })[0]!;
    expect(() => svc.review({ proposalId: proposal.proposalId, decision: "approve", reviewReason: "too early" })).not.toThrow();
    const drifted = new ImprovementProposalService({ events: fixture(), proposals, currentBaselineSha: "def5678", now: () => NOW });
    expect(() => drifted.exportImplementationPrompt(proposal.proposalId)).toThrowError(/baseline/);
  });

  test("does not create a dangerous surface promotion proposal", () => {
    const dangerousDetector: ProposalDetector = {
      name: "dangerous-fixture",
      detect: () => ({
        detector: "dangerous-fixture",
        insufficientEvidenceCount: 0,
        findings: [{
          detector: "dangerous-fixture",
          fingerprint: "0123456789abcdef01234567",
          category: "tool-surface",
          target: "c2000_assignExpression",
          title: "Promote memory write",
          summary: "A request to promote target-memory-write.",
          evidence: {
            matchingRuns: 20, affectedRuns: 20, successAfterEscalation: 10, failureAfterEscalation: 10,
            sampleWindow: "30d", patternRatio: 1, failureRate: 0.5, sufficient: true,
            minimumMatchingRuns: 10, minimumPatternRatio: 0.2, supportingTools: ["c2000_assignExpression"],
            supportingCapabilities: [], context: { effects: "target-memory-write" },
            rootCause: "likely-mcp-deficiency", rootCauseReason: "fixture", observedAt: new Date(NOW).toISOString()
          },
          proposedChange: {
            kind: "surface-promotion", target: "c2000_assignExpression", description: "Promote target-memory-write to agent.",
            allowedAreas: ["src/mcp/tools.ts"], forbiddenAreas: [], changeScope: "small", implementationMode: "auto-eligible",
            fromExposure: "advanced", toExposure: "default", suggestedTools: ["c2000_assignExpression"]
          },
          expectedBenefit: { summary: "fixture", metrics: [{ name: "agentToolCount", direction: "increase", rationale: "fixture" }] },
          risks: [{ level: "high", description: "fixture", mitigation: "fixture" }],
          validationPlan: {
            existingTests: ["tests/toolSafety.test.ts"], newRegressionTestRequired: true, mockValidation: true,
            hardwareRequired: false, replayFixtures: [], beforeAfterMetrics: ["agentToolCount"], rollbackCondition: "fixture",
            acceptanceCriteria: ["fixture"]
          },
          confidence: 0.9, generatedBy: "static-rule"
        }]
      })
    };
    const proposals = new InMemoryImprovementProposalStore();
    const result = service(new InMemoryOutcomeEventStore(), { detectors: [dangerousDetector], proposals }).generate();
    expect(result.counts).toEqual(expect.objectContaining({ protectedInvariantSuppressed: 1 }));
    expect(proposals.list()).toHaveLength(0);
  });

  test("round-trips Proposal history through the existing SQLite migration", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "c2000-improvement-proposals-"));
    roots.push(directory);
    const store = await SqliteStore.open(path.join(directory, "proposals.sqlite"));
    try {
    expect(store.schemaVersion).toBe(17);
      const eventStore = fixture();
      const proposalStore = new ProposalRepository(store);
      const svc = new ImprovementProposalService({ events: eventStore, proposals: proposalStore, currentBaselineSha: "abc1234", now: () => NOW });
      svc.generate();
      const proposal = proposalStore.list({ status: "ready-for-review" })[0]!;
      expect(proposalStore.get(proposal.proposalId)).toEqual(proposal);
      svc.review({ proposalId: proposal.proposalId, decision: "defer", reviewReason: "Wait for one more controlled replay." });
      expect(proposalStore.get(proposal.proposalId)?.status).toBe("deferred");
      svc.review({ proposalId: proposal.proposalId, decision: "approve", reviewReason: "The controlled replay is now approved." });
      svc.beginImplementation(proposal.proposalId);
      svc.recordValidation({
        proposalId: proposal.proposalId,
        result: {
          baseline: "abc1234",
          candidate: "def5678",
          implementationComplete: true,
          tests: [{ name: "npm test", status: "passed" }],
          regressions: [],
          metricDelta: {},
          safetyChecks: [{ name: "safetyMatrix", passed: true, details: "Preserved." }],
          verdict: "neutral",
          generatedAt: new Date(NOW).toISOString()
        }
      });
      expect(proposalStore.get(proposal.proposalId)).toEqual(expect.objectContaining({
        status: "validated",
        validationResult: expect.objectContaining({ candidate: "def5678", verdict: "neutral" })
      }));
    } finally {
      store.close();
    }
  });
});
