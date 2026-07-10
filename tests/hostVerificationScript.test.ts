import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";

describe("host verification gate script contract", () => {
  test("provides a single non-target-touching host gate command", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as { scripts: Record<string, string> };
    const source = await readFile("scripts/verify-host-gate.ts", "utf8");

    expect(packageJson.scripts["verify:host"]).toBe("tsx scripts/verify-host-gate.ts");
    expect(source).toContain("verify:debug-boundary");
    expect(source).toContain("npm run build --silent");
    expect(source).toContain("npm test -- --reporter=dot");
    expect(source).toContain("npm run smoke:mcp");
    expect(source).toContain("npm run acceptance:ready");
    expect(source).not.toContain("acceptance:ccs");
    expect(source).not.toContain("acceptance:ccs:mcp");
    expect(source).not.toContain("C2000_RUN_LAUNCH");
    expect(source).not.toContain("C2000_RUN_ISOLATION");
  });

  test("reports readiness blockers separately from host-side failures", async () => {
    const source = await readFile("scripts/verify-host-gate.ts", "utf8");
    const gateSource = await readFile("src/hostVerificationGate.ts", "utf8");

    expect(source).toContain("evaluateHostVerificationGate");
    expect(source).toContain("evaluateHostVerificationGate(results)");
    expect(source).toContain("acceptanceEvidenceError");
    expect(gateSource).toContain("hostChecksPassed");
    expect(gateSource).toContain("readyForHardwareAcceptance");
    expect(gateSource).toContain("readinessBlocked");
    expect(gateSource).toContain("readinessJson");
    expect(gateSource).toContain("debugProcessDetails");
    expect(gateSource).toContain("uiIndependenceEvidence");
    expect(gateSource).toContain("acceptanceEvidence");
    expect(gateSource).toContain("readinessJson?.readiness");
    expect(gateSource).toContain("readinessJson?.acceptanceReadiness");
    expect(gateSource).toContain("readinessReport?.acceptanceEvidence");
    expect(gateSource).toContain("assertAcceptanceEvidence(acceptanceEvidence");
    expect(gateSource).toContain("acceptanceEvidenceValid");
    expect(gateSource).toContain("const hostChecksPassed = nonReadinessStepsPassed && mcpSmokeRan && acceptanceEvidenceResult.valid");
    expect(source).toContain("c2000_multicore_acceptance_evidence_plan");
    expect(source).toContain("process.exitCode = exitCode");
  });
});
