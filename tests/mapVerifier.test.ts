import { describe, expect, it } from "vitest";
import { readFile, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MapVerifier } from "../src/verification/map/MapVerifier.js";

const mapText = async (name: string) => readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", name), "utf8");

describe("MapVerifier", () => {
  it("emits deterministic metrics and enforces region hard gates", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "c2000-map-"));
    const output = await new MapVerifier({ rootDirectory: root }).verify({ mapText: await mapText("cpu1-good.map"), rules: { maxRegionUtilization: { RAMLS0: 90 }, requireSections: [".text", ".stack"] } }, { verificationId: "V-map-good", artifactDirectory: path.join(root, "V-map-good") });
    expect(output.verification.status).toBe("FAILED");
    expect(output.verification.metrics.some(metric => metric.name === "flash.used")).toBe(true);
    expect(output.verification.metrics.some(metric => metric.name === "stack.static.bytes" && metric.value === 128)).toBe(true);
    expect(output.verification.artifacts[0]?.path).toContain("evidence");
  });

  it("blocks malformed maps and rejects stale metadata", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "c2000-map-"));
    const mapPath = path.join(root, "cpu1.map");
    await writeFile(mapPath, await mapText("cpu1-good.map"));
    const stale = await new MapVerifier({ rootDirectory: root }).verify({ mapPath, expectedArtifact: { path: mapPath, sha256: "0".repeat(64), buildId: "build-current" }, expectedBuildId: "build-current" }, { verificationId: "V-map-stale", artifactDirectory: path.join(root, "V-map-stale") });
    const malformed = await new MapVerifier({ rootDirectory: root }).verify({ mapText: await mapText("malformed.map") }, { verificationId: "V-map-malformed", artifactDirectory: path.join(root, "V-map-malformed") });
    expect(stale.verification.status).toBe("BLOCKED");
    expect(stale.verification.hardGateFailures.some(failure => failure.check === "artifact-freshness")).toBe(true);
    expect(malformed.verification.status).toBe("BLOCKED");
    expect(malformed.verification.completeness.status).toBe("INCOMPLETE");
  });
});
