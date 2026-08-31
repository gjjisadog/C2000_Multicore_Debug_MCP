import { describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RejectedEditBuffer } from "../src/evolution/RejectedEditBuffer.js";

describe("rejected edit buffer", () => {
  it("persists rejected candidates and surfaces them to the improver", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "c2000-evolution-"));
    const buffer = new RejectedEditBuffer({ rootDirectory: root });
    await buffer.append({ skillName: "c2000-multicore-debug", baseSkillVersion: "1", candidateSkillVersion: "1-c1", edit: { operation: "ADD", section: "Rules", content: "bad", reason: "failed", evidenceIds: ["V1"] }, reason: "critical regression", baselineScore: 0.8, candidateScore: 0.9, validationVerificationIds: ["V2"], hardGateFailures: [] });
    expect((await buffer.list("c2000-multicore-debug"))).toHaveLength(1);
    expect(JSON.parse(await readFile(buffer.path(), "utf8")).schemaVersion).toBe(1);
  });
});
