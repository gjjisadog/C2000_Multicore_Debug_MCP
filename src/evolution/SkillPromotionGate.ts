import { z } from "zod";
import { skillVerificationSetsSchema, type SkillVerificationSets } from "./EvolutionSchemas.js";

export const promotionGateInputSchema = z.object({
  baselineScore: z.number().finite(),
  candidateScore: z.number().finite().nullable(),
  criticalRegressionCount: z.number().int().nonnegative(),
  requiredHardGatesPass: z.boolean(),
  trainingVerificationIds: z.array(z.string().min(1)).default([]),
  validationVerificationIds: z.array(z.string().min(1)).min(1),
  holdoutVerificationIds: z.array(z.string().min(1)).default([]),
  validationComplete: z.boolean().default(true),
  requireHoldout: z.boolean().default(false)
});

export type PromotionGateInput = z.infer<typeof promotionGateInputSchema>;
export interface PromotionGateResult {
  decision: "PROMOTABLE" | "REJECTED";
  reasons: string[];
  baselineScore: number;
  candidateScore: number | null;
  criticalRegressionCount: number;
  requiredHardGatesPass: boolean;
}

export function evaluatePromotion(rawInput: unknown): PromotionGateResult {
  const input = promotionGateInputSchema.parse(rawInput);
  const sets: SkillVerificationSets = skillVerificationSetsSchema.parse({
    trainingVerificationIds: input.trainingVerificationIds,
    validationVerificationIds: input.validationVerificationIds,
    holdoutVerificationIds: input.holdoutVerificationIds
  });
  const reasons: string[] = [];
  if (input.candidateScore === null) reasons.push("candidate score is missing");
  else if (!(input.candidateScore > input.baselineScore)) reasons.push("candidate score does not strictly improve the baseline");
  if (input.criticalRegressionCount !== 0) reasons.push(`critical regression count is ${input.criticalRegressionCount}`);
  if (!input.requiredHardGatesPass) reasons.push("required hard gates did not pass");
  if (!input.validationComplete) reasons.push("validation evidence is incomplete");
  if (input.requireHoldout && input.holdoutVerificationIds.length === 0) reasons.push("holdout verification set is required");
  if (sets.validationVerificationIds.length === 0) reasons.push("validation set is empty");
  return {
    decision: reasons.length === 0 ? "PROMOTABLE" : "REJECTED",
    reasons,
    baselineScore: input.baselineScore,
    candidateScore: input.candidateScore,
    criticalRegressionCount: input.criticalRegressionCount,
    requiredHardGatesPass: input.requiredHardGatesPass
  };
}

export class SkillPromotionGate {
  evaluate(input: unknown): PromotionGateResult { return evaluatePromotion(input); }
}
