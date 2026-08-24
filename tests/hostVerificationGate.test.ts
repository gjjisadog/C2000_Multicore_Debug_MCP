import { describe, expect, test } from "vitest";
import { buildAcceptanceEvidencePlan } from "../src/debug/boundary.js";
import { evaluateHostVerificationGate, type HostVerificationStepResult } from "../src/hostVerificationGate.js";

function passedStep(name: string): HostVerificationStepResult {
  return {
    name,
    command: `npm run ${name}`,
    exitCode: 0,
    status: "passed"
  };
}

describe("host verification gate evaluation", () => {
  test("treats malformed acceptance evidence as a host-side failure", () => {
    const result = evaluateHostVerificationGate([
      passedStep("debug-boundary-source-scan"),
      passedStep("typescript-build"),
      passedStep("unit-and-contract-tests"),
      passedStep("mcp-stdio-smoke"),
      {
        name: "hardware-acceptance-readiness",
        command: "npm run acceptance:ready",
        exitCode: 2,
        status: "blocked",
        readinessJson: {
          readyForHardwareAcceptance: false,
          blockers: ["probe is already owned"],
          acceptanceEvidence: {
            success: true,
            evidence: "c2000_multicore_acceptance_evidence_plan",
            requirements: []
          }
        }
      }
    ]);

    expect(result.hostChecksPassed).toBe(false);
    expect(result.acceptanceEvidenceValid).toBe(false);
    expect(result.readyForHardwareAcceptance).toBe(false);
    expect(result.readinessBlocked).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.acceptanceEvidenceError).toContain("acceptanceEvidence.hostReadinessTool");
  });

  test("keeps readiness blockers separate when host evidence is valid", () => {
    const result = evaluateHostVerificationGate([
      passedStep("debug-boundary-source-scan"),
      passedStep("typescript-build"),
      passedStep("unit-and-contract-tests"),
      passedStep("mcp-stdio-smoke"),
      {
        name: "hardware-acceptance-readiness",
        command: "npm run acceptance:ready",
        exitCode: 2,
        status: "blocked",
        readinessJson: {
          readyForHardwareAcceptance: false,
          blockers: ["probe is already owned"],
          acceptanceEvidence: buildAcceptanceEvidencePlan()
        }
      }
    ]);

    expect(result.hostChecksPassed).toBe(true);
    expect(result.acceptanceEvidenceValid).toBe(true);
    expect(result.readyForHardwareAcceptance).toBe(false);
    expect(result.readinessBlocked).toBe(true);
    expect(result.exitCode).toBe(2);
  });

  test("treats an explicit no-hardware skip as a readiness blocker after MCP smoke validates host evidence", () => {
    const result = evaluateHostVerificationGate([
      passedStep("debug-boundary-source-scan"),
      passedStep("typescript-build"),
      passedStep("unit-and-contract-tests"),
      passedStep("mcp-stdio-smoke"),
      {
        name: "hardware-acceptance-readiness",
        command: "npm run acceptance:ready",
        exitCode: 0,
        status: "passed",
        readinessJson: {
          status: "SKIPPED_NO_HARDWARE",
          targetAccessAttempted: false,
          reason: "C2000_HARDWARE_TEST=1 required"
        }
      }
    ]);

    expect(result.hostChecksPassed).toBe(true);
    expect(result.acceptanceEvidenceValid).toBe(true);
    expect(result.readyForHardwareAcceptance).toBe(false);
    expect(result.readinessBlocked).toBe(true);
    expect(result.exitCode).toBe(2);
    expect(result.acceptanceEvidenceError).toBeUndefined();
  });

  test("accepts readiness reports nested under acceptanceReadiness", () => {
    const result = evaluateHostVerificationGate([
      passedStep("debug-boundary-source-scan"),
      passedStep("typescript-build"),
      passedStep("unit-and-contract-tests"),
      passedStep("mcp-stdio-smoke"),
      {
        name: "hardware-acceptance-readiness",
        command: "npm run acceptance:ready",
        exitCode: 0,
        status: "passed",
        readinessJson: {
          acceptanceReadiness: {
            readyForHardwareAcceptance: true,
            acceptanceEvidence: buildAcceptanceEvidencePlan(),
            preflight: { debugProcessDetails: [] },
            uiIndependenceEvidence: { evidence: "c2000_debug_boundary_ui_independence" },
            nextCommand: "npm run acceptance:ccs:mcp"
          }
        }
      }
    ]);

    expect(result.hostChecksPassed).toBe(true);
    expect(result.acceptanceEvidenceValid).toBe(true);
    expect(result.readyForHardwareAcceptance).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.nextCommand).toBe("npm run acceptance:ccs:mcp");
  });
});
