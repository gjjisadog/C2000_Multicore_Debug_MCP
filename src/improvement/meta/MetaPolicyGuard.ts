import { DebugMcpError } from "../../utils/errors.js";
import type { MetaRecommendationCategory } from "./MetaSchemas.js";

export interface MetaPolicyRecommendationCandidate {
  category: MetaRecommendationCategory;
  target: string;
  title: string;
  summary: string;
  currentPolicy: unknown;
  recommendedPolicyChange: unknown;
  expectedEffect: string[];
  risks: string[];
}

export interface MetaPolicyGuardResult {
  allowed: boolean;
  suppressedByProtectedPolicy: boolean;
  reasons: string[];
}

const PROTECTED_FLOORS = [
  "safety profile remains the highest permission boundary",
  "high-risk target mutation remains manual-only",
  "human merge gate remains required",
  "hardware safety gates cannot be removed automatically",
  "force push and automatic merge remain disabled",
  "automatic rollback remains disabled",
  "agent attempts remain bounded",
  "review text is never executable",
  "cpu identity, flash protection, leases, and fencing remain unchanged",
  "MetaPolicyGuard cannot rewrite itself"
] as const;

/** Permanent meta-governance floors. This class has no mutation API. */
export class MetaPolicyGuard {
  assess(candidate: MetaPolicyRecommendationCandidate): MetaPolicyGuardResult {
    const current = asRecord(candidate.currentPolicy);
    const recommended = asRecord(candidate.recommendedPolicyChange);
    const text = [
      candidate.category,
      candidate.target,
      candidate.title,
      candidate.summary,
      ...candidate.expectedEffect,
      ...candidate.risks,
      safeJson(candidate.currentPolicy),
      safeJson(candidate.recommendedPolicyChange)
    ].join(" ").toLowerCase();
    const reasons: string[] = [];

    if (hasActiveDirective(text, /(?:auto(?:matic|matically)?|enable).{0,40}(?:merge|rollback|revert|approve)/i)) {
      reasons.push("Automatic merge, rollback, and approval are protected floors.");
    }
    if (hasActiveDirective(text, /(?:force[-_ ]?push|force[-_ ]?update|rewrite protected branch)/i)) {
      reasons.push("Force-push and protected-branch rewrite policy cannot be recommended.");
    }
    if (hasActiveDirective(text, /(?:bypass|disable|remove|relax|weaken).{0,60}(?:safety|approval|human review|human merge|validation|hardware gate|flash protection|lease|fencing)/i)) {
      reasons.push("Safety, approval, validation, hardware, Flash, lease, and fencing floors cannot be weakened.");
    }
    if (hasActiveDirective(text, /(?:unlimited|infinite|no limit).{0,40}(?:agent|attempt|retry|loop)/i)) {
      reasons.push("Coding-agent retries must retain a hard upper bound.");
    }
    if (/(?:modify|rewrite|disable|remove|bypass).{0,50}(?:metapolicyguard|protected floor)/i.test(text)) {
      reasons.push("MetaPolicyGuard and its protected floors require manual architecture review.");
    }
    if (/metapolicyguard/i.test(candidate.target) || /protected[- ]floor/i.test(candidate.target)) {
      reasons.push("MetaPolicyGuard and its protected floors are manual-only governance code.");
    }
    if (/(?:promot|expos).{0,60}(?:agent|default).{0,80}(?:reset|load|run|halt|write|fault|memory|destructive)/i.test(text)) {
      reasons.push("Dangerous target-control tools cannot be automatically promoted to the Agent surface.");
    }
    if (isHighRisk(candidate, recommended) && hasTruthyKey(recommended, /auto|automatic|eligible|promotion|enable/i)) {
      reasons.push("High-risk target mutation and program-load policy remains manual-only.");
    }
    if (hasTruthyKey(recommended, /review(?:er)?[_ -]?(?:comment|text)|comment.*execut|reviewText/i)) {
      reasons.push("Reviewer comments and review text are untrusted evidence, never executable policy.");
    }

    const currentValues = flattenPolicy(current);
    const recommendedValues = flattenPolicy(recommended);
    for (const [key, recommendedValue] of Object.entries(recommendedValues)) {
      const currentValue = currentValues[key];
      if (recommendedValue === undefined) continue;
      if (isProtectedBooleanKey(key) && currentValue === true && recommendedValue === false) {
        reasons.push(`${key} cannot be changed from enabled to disabled by meta analytics.`);
      }
      if (/max.*(?:attempt|retry|revision)/i.test(key) && typeof recommendedValue === "string" && /unlimited|infinite|none/i.test(recommendedValue)) {
        reasons.push(`${key} must remain a finite integer.`);
      }
      if (isProtectedIdentityKey(key) && !sameProtectedIdentity(key, recommendedValue)) {
        reasons.push(`${key} is a protected CPU identity or ownership/fencing invariant.`);
      }
      if (/hardware.*required|hardware.*gate/i.test(key) && recommendedValue === false) {
        reasons.push(`${key} cannot be reduced automatically.`);
      }
      if (/target.*mutation|destructive/i.test(key) && recommendedValue === false) {
        reasons.push(`${key} must remain explicit for target mutations.`);
      }
    }

    return {
      allowed: reasons.length === 0,
      suppressedByProtectedPolicy: reasons.length > 0,
      reasons: reasons.length > 0 ? reasons : ["No protected policy floor was crossed."]
    };
  }

  assertAllowed(candidate: MetaPolicyRecommendationCandidate): void {
    const result = this.assess(candidate);
    if (!result.allowed) {
      throw new DebugMcpError("MetaPolicyGuardSuppressed", "Engineering policy recommendation crossed a protected floor", {
        category: candidate.category,
        target: candidate.target,
        reasons: result.reasons,
        protectedFloors: PROTECTED_FLOORS
      });
    }
  }
}

export const META_PROTECTED_POLICY_FLOORS = PROTECTED_FLOORS;

function safeJson(value: unknown): string {
  try { return JSON.stringify(value); } catch { return ""; }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function isProtectedBooleanKey(key: string): boolean {
  return /safety|approval|human|merge|hardware|validation|flash|lease|fenc|force[-_ ]?push|forcePush|autoMerge|autoRollback|target.*mutation/i.test(key);
}

function isProtectedIdentityKey(key: string): boolean {
  return /cpu[12].*core.?id|core.?id.*cpu[12]|flash|lease|fenc/i.test(key);
}

function sameProtectedIdentity(key: string, value: unknown): boolean {
  if (/cpu1.*core.?id/i.test(key)) return value === 0;
  if (/cpu2.*core.?id/i.test(key)) return value === 2;
  return value === true || value === "preserve" || value === "unchanged";
}

function hasTruthyKey(record: Record<string, unknown>, pattern: RegExp): boolean {
  return Object.entries(flattenPolicy(record)).some(([key, value]) => pattern.test(key) && (value === true || /^(?:true|enabled|automatic|auto-eligible)$/i.test(String(value))));
}

function hasActiveDirective(text: string, pattern: RegExp): boolean {
  return text.split(/[.!?]+/).some(sentence => {
    const match = sentence.match(pattern);
    if (!match || match.index === undefined) return false;
    const prefix = sentence.slice(0, match.index);
    return !/(?:\bdo not\b|\bdoes not\b|\bnever\b|\bmust not\b|\bcannot\b|\bwithout\b|\bpreserve\b|\bretain\b|\bkeep\b|\bremain(?:s|ing)?\b)[^,;:]*$/i.test(prefix);
  });
}

function isHighRisk(candidate: MetaPolicyRecommendationCandidate, recommended: Record<string, unknown>): boolean {
  const text = `${candidate.category} ${candidate.target} ${candidate.title} ${candidate.summary} ${safeJson(recommended)}`;
  return /high[- ]risk|target[- ]mutation|program[- ]load|destructive|fault[- ]injection|memory[- ]write/i.test(text);
}

function flattenPolicy(record: Record<string, unknown>, prefix = ""): Record<string, unknown> {
  const flattened: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      Object.assign(flattened, flattenPolicy(value as Record<string, unknown>, path));
    } else {
      flattened[path] = value;
    }
  }
  return flattened;
}
