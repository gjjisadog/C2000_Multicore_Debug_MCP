import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BuildVerifier } from "../src/verification/build/BuildVerifier.js";

describe("BuildVerifier", () => {
  it("returns structured pass evidence and keeps the complete log", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "c2000-build-"));
    const mapPath = path.join(root, "cpu1.map");
    await writeFile(mapPath, "map-output");
    const log = "Build Finished. 0 errors, 1 warnings.\nwarning #1234: note";
    const output = await new BuildVerifier({ rootDirectory: root }).verify({ buildLogText: log, mapPath, target: "F28P65x", configuration: "FLASH" }, { verificationId: "V-build-pass", artifactDirectory: path.join(root, "V-build-pass") });
    expect(output.verification.status).toBe("PASSED");
    expect(output.build.counts).toEqual({ errors: 0, warnings: 1 });
    expect(output.build.artifacts.map?.sha256).toMatch(/^[a-f0-9]{64}$/);
    const saved = await readFile(path.join(root, "V-build-pass", "logs", "build.log"), "utf8");
    expect(saved).toBe(log);
  });

  it("fails closed on compiler/linker errors", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "c2000-build-"));
    const output = await new BuildVerifier({ rootDirectory: root }).verify({ buildLogText: "src/main.c:3: error: missing symbol", target: "F28P65x", configuration: "FLASH" }, { verificationId: "V-build-fail", artifactDirectory: path.join(root, "V-build-fail") });
    expect(output.verification.status).toBe("FAILED");
    expect(output.build.errors[0]?.category).toBe("COMPILE_ERROR");
    expect(await stat(path.join(root, "V-build-fail", "logs", "build.log"))).toBeTruthy();
  });

  it("blocks empty build evidence instead of reporting a false pass", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "c2000-build-"));
    const output = await new BuildVerifier({ rootDirectory: root }).verify({ buildLogText: "   ", target: "F28P65x", configuration: "FLASH" }, { verificationId: "V-build-empty", artifactDirectory: path.join(root, "V-build-empty") });
    expect(output.verification.status).toBe("BLOCKED");
    expect(output.verification.completeness.status).toBe("INCOMPLETE");
  });
});
