import { sha256Json } from "../review/ReviewSchemas.js";
import { MIN_PATTERN_RATIO, MIN_PROPOSAL_MATCHING_RUNS, PROPOSAL_COOLDOWN_MS } from "../ProposalPolicy.js";
import {
  engineeringPolicySnapshotSchema,
  type EngineeringPolicySnapshot
} from "./MetaSchemas.js";

/**
 * The identity is a snapshot of governance inputs, not an executable policy.
 * It lets meta analytics separate legacy records from comparable regimes.
 */
export const DEFAULT_ENGINEERING_POLICY = {
  regime: "engineering-policy-v1",
  proposal: {
    minimumMatchingRuns: MIN_PROPOSAL_MATCHING_RUNS,
    minimumPatternRatio: MIN_PATTERN_RATIO,
    cooldownMs: PROPOSAL_COOLDOWN_MS
  },
  implementation: { maxAgentAttempts: 2 },
  review: { humanMergeRequired: true, forcePushAllowed: false, autoMergeAllowed: false },
  validation: { hardwareGateReductionAutomatic: false, postMergeEvaluationRequired: true },
  toolSurface: { defaultSurface: "agent", defaultAdvancedExposure: "advanced", maxAgentToolCount: 28 },
  capability: { temporaryOnly: true, defaultTtlSeconds: 900, maxTtlSeconds: 1800 },
  protectedFloors: {
    safetyProfileHighestBoundary: true,
    cpu1CoreId: 0,
    cpu2CoreId: 2,
    flashReloadProtection: true,
    boardLeaseFencing: true,
    metaPolicyGuardSelfChange: false
  }
} as const;

export interface EngineeringPolicySnapshotInput {
  regime?: string;
  policy?: Record<string, unknown>;
  capturedAt?: string;
}

export function currentEngineeringPolicySnapshot(input: EngineeringPolicySnapshotInput = {}): EngineeringPolicySnapshot {
  const policy = input.policy ?? structuredClone(DEFAULT_ENGINEERING_POLICY) as unknown as Record<string, unknown>;
  const regime = input.regime ?? DEFAULT_ENGINEERING_POLICY.regime;
  const engineeringPolicyHash = sha256Json({ regime, policy });
  const capturedAt = input.capturedAt ?? new Date().toISOString();
  return engineeringPolicySnapshotSchema.parse({
    snapshotId: `policy-${engineeringPolicyHash.slice(0, 32)}`,
    policyRegime: regime,
    engineeringPolicyHash,
    capturedAt,
    policy,
    legacy: false
  });
}

export function policyRegimeForHash(hash: string | undefined): string {
  return hash ? "engineering-policy-hashed" : "legacy";
}
