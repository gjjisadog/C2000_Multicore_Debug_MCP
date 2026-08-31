import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RegressionVerifier, type RegressionRunner } from "../src/verification/regression/RegressionVerifier.js";

class FakeRunner implements RegressionRunner {
  async run(suite: { id: string; kind: "host" | "mock" | "hardware" }): Promise<{
    status: "PASSED" | "FAILED" | "SKIPPED" | "BLOCKED" | "UNSUPPORTED";
    message: string;
    stdout: string;
    stderr: string;
    evidenceClassification?: "MOCK" | "UNKNOWN" | "HARDWARE_TARGET" | "HARDWARE_BUS" | "MIXED";
    evidenceComplete?: boolean;
  }> {
    if (suite.id === "failed") return { status: "FAILED", message: "expected failure", stdout: "expected=1", stderr: "actual=0" };
    if (suite.id === "incomplete") return { status: "PASSED", message: "missing evidence", stdout: "ok", stderr: "", evidenceComplete: false };
    return { status: "PASSED", message: "passed", stdout: "ok", stderr: "", evidenceClassification: suite.kind === "mock" ? "MOCK" : "UNKNOWN" };
  }
}

describe("RegressionVerifier", () => {
  it("preserves pass/fail, Mock classification, and incomplete evidence", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "c2000-regression-"));
    const verifier = new RegressionVerifier({ rootDirectory: root, runners: [new FakeRunner()] });
    const output = await verifier.verify({ suites: [{ id: "host", kind: "host" }, { id: "mock-case", kind: "mock" }, { id: "incomplete", kind: "host" }] }, { verificationId: "V-regression", artifactDirectory: path.join(root, "V-regression") });
    expect(output.regression).toMatchObject({ total: 3, passed: 3, failed: 0 });
    expect(output.verification.completeness.status).toBe("INCOMPLETE");
    expect(output.regression.suites.find(suite => suite.id === "mock-case")?.evidenceClassification).toBe("MOCK");
  });

  it("blocks required hardware when no durable hardware runner is configured", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "c2000-regression-"));
    const output = await new RegressionVerifier({ rootDirectory: root }).verify({ suites: [{ id: "hardware-acceptance", kind: "hardware", required: true }], requireHardware: true }, { verificationId: "V-hardware", artifactDirectory: path.join(root, "V-hardware") });
    expect(output.regression.status).toBe("BLOCKED");
    expect(output.regression.suites[0]).toMatchObject({ status: "BLOCKED", evidenceClassification: "UNKNOWN" });
  });

  it("does not turn a skipped required suite into a pass", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "c2000-regression-"));
    const output = await new RegressionVerifier({ rootDirectory: root, runners: [new FakeRunner()] }).verify({ suites: [{ id: "hardware", kind: "hardware", required: true }], requireHardware: false }, { verificationId: "V-skipped", artifactDirectory: path.join(root, "V-skipped") });
    expect(output.regression.status).toBe("BLOCKED");
    expect(output.regression.suites[0]?.evidenceClassification).toBe("UNKNOWN");
  });
});
