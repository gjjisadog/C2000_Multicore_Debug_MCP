import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ReviewVerifier } from "../src/verification/review/ReviewVerifier.js";

const diff = (file: string, body: string) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1,1 +1,2 @@\n old\n+${body}\n`;

describe("ReviewVerifier", () => {
  it("passes an ordinary diff in diffText mode without Git", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "c2000-review-"));
    const output = await new ReviewVerifier({ rootDirectory: root }).verify({ diffText: diff("src/main.c", "return 0;") }, { verificationId: "V-review-pass", artifactDirectory: path.join(root, "V-review-pass") });
    expect(output.review.status).toBe("PASSED");
    expect(output.review.changedFiles).toEqual(["src/main.c"]);
    expect(output.verification.artifacts).toHaveLength(1);
  });

  it("fails configured patterns and blocks missing companion evidence", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "c2000-review-"));
    const output = await new ReviewVerifier({ rootDirectory: root }).verify({
      diffText: diff("src/isr.c", "blocking_call(); // TODO"),
      rules: { forbiddenPatterns: [{ id: "blocking", pattern: "blocking_call", severity: "CRITICAL" }], highFrequencyPaths: ["src/isr.c"] }
    }, { verificationId: "V-review-fail", artifactDirectory: path.join(root, "V-review-fail") });
    expect(output.review.status).toBe("BLOCKED");
    expect(output.review.checks.some(check => check.id.startsWith("forbidden-pattern") && check.status === "FAILED")).toBe(true);
    expect(output.review.checks.some(check => check.id === "realtime-review" && check.status === "BLOCKED")).toBe(true);
  });

  it("requires map evidence when a linker command changes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "c2000-review-"));
    const output = await new ReviewVerifier({ rootDirectory: root }).verify({ diffText: diff("linker.cmd", "RAMLS0 : origin = 0x8000") }, { verificationId: "V-review-linker", artifactDirectory: path.join(root, "V-review-linker") });
    expect(output.review.checks.find(check => check.id === "map-verification")?.status).toBe("BLOCKED");
  });

  it("blocks an unreadable diff when no file metadata is available", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "c2000-review-"));
    const output = await new ReviewVerifier({ rootDirectory: root }).verify({ diffPath: path.join(root, "missing.diff") }, { verificationId: "V-review-missing", artifactDirectory: path.join(root, "V-review-missing") });
    expect(output.verification.status).toBe("BLOCKED");
    expect(output.review.decision).toBe("BLOCK");
  });
});
