import { describe, expect, it } from "vitest";
import { verificationResultSchema } from "../src/verification/VerificationSchemas.js";
import { createVerificationResult } from "../src/verification/VerificationResultBuilder.js";

describe("verification result contract", () => {
  it("keeps statuses, checks, identity, completeness, and hard gates machine-readable", () => {
    const result = createVerificationResult({
      context: {
        verificationId: "V-schema",
        jobId: "job-1",
        subject: { kind: "firmware", id: "cpu1" },
        identity: { project: "demo", skillName: "c2000-multicore-debug", skillVersion: "1" }
      },
      verifierType: "build",
      status: "FAILED",
      startedAt: "2026-08-31T00:00:00.000Z",
      endedAt: "2026-08-31T00:00:01.000Z",
      checks: [{ id: "compile", category: "diagnostics", status: "FAILED", severity: "CRITICAL", message: "compile failed", expected: 0, actual: 1 }]
    });
    expect(verificationResultSchema.parse(result)).toMatchObject({ schemaVersion: 1, verificationId: "V-schema", jobId: "job-1", status: "FAILED" });
    expect(result.summary.decision).toBe("REJECT");
    expect(result.hardGateFailures).toHaveLength(1);
  });
});
