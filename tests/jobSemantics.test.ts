import { describe, expect, test } from "vitest";
import { conditionForStep, conditionMatches, decideRetry, retryPolicyFor } from "../src/jobs/JobSemantics.js";
import { testPlanSchema } from "../src/jobs/TestPlanSchema.js";

describe("job step semantics", () => {
  test("implements explicit on conditions and safe defaults", () => {
    expect(conditionForStep({ type: "cleanup" })).toBe("always");
    expect(conditionForStep({ type: "runFullDebugBundle" })).toBe("failure");
    expect(conditionForStep({ type: "preflight" })).toBe("success");
    expect(conditionForStep({ type: "cleanup", on: "success" })).toBe("success");
    expect(conditionMatches("failure", "failure")).toBe(true);
    expect(conditionMatches("success", "failure")).toBe(false);
    expect(conditionMatches("always", "failure")).toBe(true);
  });

  test("filters retryable errors and never directly retries non-idempotent work", () => {
    const policy = { maxAttempts: 3, backoffMs: 10, maxBackoffMs: 100, jitter: false, retryableErrors: ["RpcRequestTimeout"] };
    expect(decideRetry({ step: { idempotencyClass: "READ_ONLY" }, attempt: 1, policy, errorCode: "RpcRequestTimeout" })).toMatchObject({ retry: true, backoffMs: 10 });
    expect(decideRetry({ step: { idempotencyClass: "READ_ONLY" }, attempt: 1, policy, errorCode: "InvalidInput" })).toMatchObject({ retry: false, reason: "ERROR_NOT_RETRYABLE" });
    expect(decideRetry({ step: { idempotencyClass: "NON_IDEMPOTENT" }, attempt: 1, policy, errorCode: "RpcRequestTimeout" })).toMatchObject({ retry: false, reason: "NON_IDEMPOTENT" });
    expect(decideRetry({ step: { idempotencyClass: "RECONCILABLE" }, attempt: 1, policy, errorCode: "RpcRequestTimeout" })).toMatchObject({ retry: true, requiresReconcile: true });
  });

  test("parses structured retry policy", () => {
    const plan = testPlanSchema.parse({
      planVersion: 1,
      name: "retry",
      boardIds: ["board-a"],
      retryPolicy: { preflight: { maxAttempts: 3, backoffMs: 500, maxBackoffMs: 5000, jitter: true, retryableErrors: ["RpcRequestTimeout"] } },
      steps: [{ type: "preflight" }]
    });
    expect(retryPolicyFor(plan, "preflight")).toEqual({ maxAttempts: 3, backoffMs: 500, maxBackoffMs: 5000, jitter: true, retryableErrors: ["RpcRequestTimeout"] });
  });
});
