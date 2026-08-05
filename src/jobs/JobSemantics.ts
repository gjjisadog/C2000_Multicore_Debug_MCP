import type { TestPlan, TestPlanStep } from "./TestPlanSchema.js";
import type { TestStepRecord } from "../storage/repositories/TestRunRepository.js";

export type StepCondition = "always" | "success" | "failure";

export function conditionForStep(step: TestPlanStep): StepCondition {
  if (step.on) return step.on;
  if (step.type === "cleanup") return "always";
  if (step.type === "runFullDebugBundle") return "failure";
  return "success";
}

export function conditionMatches(condition: StepCondition, previousOutcome: "success" | "failure"): boolean {
  return condition === "always" || condition === previousOutcome;
}

export function retryPolicyFor(plan: TestPlan, stepType: string): {
  maxAttempts: number;
  backoffMs: number;
  maxBackoffMs: number;
  jitter: boolean;
  retryableErrors: string[];
} {
  const value = plan.retryPolicy[stepType];
  if (typeof value === "number") return { maxAttempts: Math.max(1, value), backoffMs: 0, maxBackoffMs: 30000, jitter: false, retryableErrors: [] };
  return value ?? { maxAttempts: 1, backoffMs: 0, maxBackoffMs: 30000, jitter: false, retryableErrors: [] };
}

export function decideRetry(input: {
  step: Pick<TestStepRecord, "idempotencyClass">;
  attempt: number;
  policy: ReturnType<typeof retryPolicyFor>;
  errorCode: string;
}): { retry: boolean; reason: string; backoffMs: number; requiresReconcile: boolean } {
  if (input.errorCode === "SafetyGuardViolation") return { retry: false, reason: "SAFETY_GUARD_VIOLATION", backoffMs: 0, requiresReconcile: false };
  if (new Set([
    "LeaseExpired",
    "LeaseInvalidated",
    "LeaseFencingRejected",
    "LeaseGenerationChanged",
    "LeaseWorkerMismatch",
    "WorkerGenerationChanged",
    "WorkerIdentityMismatch"
  ]).has(input.errorCode)) {
    return { retry: false, reason: "STALE_WORKER_OR_LEASE_CONTEXT", backoffMs: 0, requiresReconcile: false };
  }
  if (input.step.idempotencyClass === "NON_IDEMPOTENT") return { retry: false, reason: "NON_IDEMPOTENT", backoffMs: 0, requiresReconcile: false };
  if (input.attempt >= input.policy.maxAttempts) return { retry: false, reason: "MAX_ATTEMPTS", backoffMs: 0, requiresReconcile: false };
  if (input.policy.retryableErrors.length > 0 && !input.policy.retryableErrors.includes(input.errorCode)) {
    return { retry: false, reason: "ERROR_NOT_RETRYABLE", backoffMs: 0, requiresReconcile: false };
  }
  const exponential = Math.min(input.policy.maxBackoffMs, input.policy.backoffMs * (2 ** Math.max(0, input.attempt - 1)));
  const backoffMs = input.policy.jitter && exponential > 0 ? Math.floor(Math.random() * (exponential + 1)) : exponential;
  return { retry: true, reason: input.step.idempotencyClass === "RECONCILABLE" ? "RECONCILE_THEN_RETRY" : "SAFE_AUTOMATIC_RETRY", backoffMs, requiresReconcile: input.step.idempotencyClass === "RECONCILABLE" };
}
