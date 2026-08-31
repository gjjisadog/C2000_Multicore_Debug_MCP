import { describe, expect, it } from "vitest";
import { evaluatePromotion } from "../src/evolution/SkillPromotionGate.js";

const base = { baselineScore: 0.8, candidateScore: 0.9, criticalRegressionCount: 0, requiredHardGatesPass: true, validationVerificationIds: ["V-validation"], validationComplete: true };

describe("skill promotion gate", () => {
  it("promotes only a strict, complete, hard-gate-clean improvement", () => {
    expect(evaluatePromotion(base).decision).toBe("PROMOTABLE");
    expect(evaluatePromotion({ ...base, candidateScore: 0.8 }).decision).toBe("REJECTED");
    expect(evaluatePromotion({ ...base, criticalRegressionCount: 1 }).decision).toBe("REJECTED");
  });

  it("rejects incomplete validation and does not allow set overlap", () => {
    expect(evaluatePromotion({ ...base, validationComplete: false }).reasons).toContain("validation evidence is incomplete");
    expect(() => evaluatePromotion({ ...base, trainingVerificationIds: ["V-validation"] })).toThrow();
  });
});
