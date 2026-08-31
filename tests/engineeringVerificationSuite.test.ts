import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { VerificationService } from "../src/verification/VerificationService.js";
import { RegressionVerifier, type RegressionRunner } from "../src/verification/regression/RegressionVerifier.js";

class PassingRunner implements RegressionRunner {
  run() { return { status: "PASSED" as const, message: "pass", stdout: "ok", stderr: "" }; }
}

async function service(root: string): Promise<VerificationService> {
  return new VerificationService({
    rootDirectory: root,
    regressionVerifier: new RegressionVerifier({ rootDirectory: root, runners: [new PassingRunner()] })
  });
}

describe("Engineering Verification Suite", () => {
  it("runs related child verifiers and persists a final gate", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "c2000-suite-"));
    const mapPath = path.join(root, "cpu1.map");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(mapPath, "TI C2000 EABI linker map\nMEMORY CONFIGURATION\nPAGE 0:\n FLASH 00080000 00001000 00000800 00000800\nSECTION ALLOCATION MAP\n.text 00080000 00000100 00080000\n.stack 00008000 00000040 00008000\n");
    const output = await (await service(root)).runEngineeringVerification({
      verificationId: "V-suite-pass",
      build: { buildLogText: "Build Finished. 0 errors.", mapPath },
      regression: { suites: ["unit" ] },
      review: { diffText: "diff --git a/src/main.c b/src/main.c\n--- a/src/main.c\n+++ b/src/main.c\n@@ -1 +1,2 @@\n old\n+new\n" }
    });
    expect(output.finalGate.decision).toBe("PASS");
    expect(output.verification.status).toBe("PASSED");
    expect(output.verification.children?.map(child => child.verificationId)).toEqual(["V-suite-pass/build", "V-suite-pass/map", "V-suite-pass/regression", "V-suite-pass/review"]);
    expect(output.artifactManifestPath).toContain(path.join("V-suite-pass", "suite", "manifest.json"));
    const fetched = await (await service(root)).getVerificationResult({ verificationId: "V-suite-pass" });
    expect((fetched.verification as { status: string }).status).toBe("PASSED");
  });

  it("blocks map and regression after a failed build instead of reusing stale evidence", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "c2000-suite-"));
    const output = await (await service(root)).runEngineeringVerification({
      verificationId: "V-suite-fail",
      build: { buildLogText: "src/main.c:2: error: compile failure", mapPath: path.join(root, "old.map") },
      map: { mapText: "old map" },
      regression: { suites: ["unit"] },
      review: { changedFiles: ["src/main.c"] }
    });
    expect(output.finalGate.decision).toBe("REJECT");
    expect(output.verification.status).toBe("FAILED");
    expect(output.verification.children?.find(child => child.verifierType === "map")?.status).toBe("BLOCKED");
    expect(output.verification.children?.find(child => child.verifierType === "regression")?.status).toBe("BLOCKED");
  });

  it("does not pass when every requested stage is disabled", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "c2000-suite-"));
    const output = await (await service(root)).runEngineeringVerification({ verificationId: "V-suite-empty", stages: { build: false, map: false, regression: false, review: false } });
    expect(output.verification.status).toBe("BLOCKED");
    expect(output.finalGate.decision).toBe("BLOCK");
  });

  it("loads project-specific JSON rules through the configured read-root policy", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "c2000-suite-rules-"));
    const rulesPath = path.join(root, "verification.rules.json");
    const mapPath = path.join(root, "cpu1.map");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(rulesPath, JSON.stringify({ schemaVersion: 1, map: { rules: { maxRegionUtilization: { FLASH: 49 } } } }));
    await writeFile(mapPath, "TI C2000 EABI linker map\nMEMORY CONFIGURATION\nPAGE 0:\n FLASH 00080000 00001000 00000800 00000800\nSECTION ALLOCATION MAP\n.text 00080000 00000100 00080000\n");
    const verification = new VerificationService({
      rootDirectory: root,
      filesystem: { allowedReadRoots: [root], allowedWriteRoots: [root] },
      config: { rulesFile: rulesPath },
      regressionVerifier: new RegressionVerifier({ rootDirectory: root, runners: [new PassingRunner()] })
    });
    const output = await verification.runEngineeringVerification({
      verificationId: "V-project-rules",
      build: { buildLogText: "Build Finished. 0 errors.", mapPath },
      regression: { suites: ["unit"] },
      review: { changedFiles: ["src/main.c"] }
    });
    expect(output.map?.verification.checks.find(check => check.id === "region-utilization:FLASH")?.status).toBe("FAILED");
    expect(output.finalGate.decision).toBe("REJECT");
  });
});
