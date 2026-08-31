import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EvolutionService } from "../src/evolution/EvolutionService.js";

describe("EvolutionService", () => {
  it("persists candidates and sends rejected edits to the rejected buffer", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "c2000-evolution-service-"));
    const service = new EvolutionService({ rootDirectory: root });
    const candidate = await service.createCandidate({
      candidateSkillId: "candidate-1",
      skillName: "c2000-multicore-debug",
      baseSkillVersion: "1",
      candidateSkillVersion: "1-c1",
      edits: [{
        operation: "ADD",
        section: "Verification",
        content: "Run the deterministic map verifier.",
        reason: "Repeated map evidence was missing.",
        evidenceIds: ["V-map-1"]
      }],
      validationVerificationIds: ["V-validation-1"]
    });

    const run = await service.recordEvolutionRun({
      schemaVersion: 1,
      evolutionRunId: "E-rejected",
      skillName: candidate.skillName,
      baseSkillVersion: candidate.baseSkillVersion,
      candidateSkillVersion: candidate.candidateSkillVersion,
      trainingVerificationIds: ["V-training-1"],
      validationVerificationIds: candidate.validationVerificationIds,
      holdoutVerificationIds: [],
      candidateEdits: candidate.edits,
      baselineScore: 0.9,
      candidateScore: 0.8,
      hardGateFailures: [{
        verifier: "review",
        check: "critical-pattern",
        severity: "CRITICAL",
        message: "The candidate introduced an unsafe instruction."
      }],
      criticalRegressionCount: 1,
      requiredHardGatesPass: false,
      decision: "REJECTED",
      rejectedReason: "critical regression",
      createdAt: "2026-08-31T00:00:00.000Z"
    });

    expect(run.decision).toBe("REJECTED");
    expect((await service.getEvolutionRun("E-rejected")).candidateSkillVersion).toBe("1-c1");
    const rejected = await service.rejectedEdits.list(candidate.skillName);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.edit.section).toBe("Verification");
  });

  it("persists experiences and lessons as separate durable records", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "c2000-evolution-facts-"));
    const service = new EvolutionService({ rootDirectory: root });
    await service.recordExperience({
      schemaVersion: 1,
      experienceId: "X1",
      verificationId: "V1",
      taskId: "T1",
      skillName: "c2000-multicore-debug",
      skillVersion: "1",
      status: "PASSED",
      evidenceClassification: "MOCK",
      createdAt: "2026-08-31T00:00:00.000Z"
    });
    await service.recordExperience({
      schemaVersion: 1,
      experienceId: "X2",
      verificationId: "V2",
      taskId: "T2",
      skillName: "c2000-multicore-debug",
      skillVersion: "1",
      status: "FAILED",
      evidenceClassification: "UNKNOWN",
      createdAt: "2026-08-31T00:00:01.000Z"
    });
    const lesson = await service.recordLesson({
      schemaVersion: 1,
      lessonId: "L1",
      skillName: "c2000-multicore-debug",
      experienceIds: ["X1", "X2"],
      pattern: "A passed mock run does not establish hardware evidence.",
      evidenceIds: ["V1", "V2"],
      createdAt: "2026-08-31T00:00:02.000Z"
    });

    expect((await service.getExperience("X1")).verificationId).toBe("V1");
    expect((await service.getLesson(lesson.lessonId)).experienceIds).toEqual(["X1", "X2"]);
  });
});
