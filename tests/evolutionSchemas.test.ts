import { describe, expect, it } from "vitest";
import { candidateSkillSchema, experienceSchema, evolutionRunSchema, lessonSchema, skillVerificationSetsSchema } from "../src/evolution/EvolutionSchemas.js";

describe("evolution schemas", () => {
  it("versions candidates and keeps training/validation/holdout sets disjoint", () => {
    const sets = skillVerificationSetsSchema.parse({ trainingVerificationIds: ["V1"], validationVerificationIds: ["V2"], holdoutVerificationIds: ["V3"] });
    expect(sets.validationVerificationIds).toEqual(["V2"]);
    const candidate = candidateSkillSchema.parse({
      schemaVersion: 1,
      candidateSkillId: "candidate-1",
      skillName: "c2000-multicore-debug",
      baseSkillVersion: "12",
      candidateSkillVersion: "12-c1",
      edits: [{ operation: "ADD", section: "Verification", content: "Run map checks.", reason: "Repeated evidence", evidenceIds: ["V1", "V2"] }],
      policy: {},
      createdAt: "2026-08-31T00:00:00.000Z"
    });
    expect(candidate.policy.maxChangedTokens).toBe(200);
  });

  it("keeps candidate evaluation sets disjoint and models experience-to-lesson evidence", () => {
    expect(() => candidateSkillSchema.parse({
      schemaVersion: 1,
      candidateSkillId: "candidate-overlap",
      skillName: "skill",
      baseSkillVersion: "1",
      candidateSkillVersion: "1-c1",
      edits: [],
      policy: {},
      trainingVerificationIds: ["V1"],
      validationVerificationIds: ["V1"],
      createdAt: "2026-08-31T00:00:00.000Z"
    })).toThrow();

    const experience = experienceSchema.parse({
      schemaVersion: 1,
      experienceId: "X1",
      verificationId: "V1",
      status: "FAILED",
      evidenceClassification: "UNKNOWN",
      createdAt: "2026-08-31T00:00:00.000Z"
    });
    const lesson = lessonSchema.parse({
      schemaVersion: 1,
      lessonId: "L1",
      skillName: "skill",
      experienceIds: [experience.experienceId, "X2"],
      pattern: "Map evidence must be checked after a successful build.",
      evidenceIds: [experience.verificationId],
      createdAt: "2026-08-31T00:00:00.000Z"
    });
    expect(lesson.experienceIds).toHaveLength(2);
  });

  it("rejects overlapping validation data", () => {
    expect(() => evolutionRunSchema.parse({
      schemaVersion: 1,
      evolutionRunId: "E1",
      skillName: "skill",
      baseSkillVersion: "1",
      trainingVerificationIds: ["V1"],
      validationVerificationIds: ["V1"],
      candidateEdits: [],
      baselineScore: 1,
      candidateScore: 2,
      hardGateFailures: [],
      requiredHardGatesPass: true,
      decision: "REJECTED",
      createdAt: "2026-08-31T00:00:00.000Z"
    })).toThrow();
  });
});
