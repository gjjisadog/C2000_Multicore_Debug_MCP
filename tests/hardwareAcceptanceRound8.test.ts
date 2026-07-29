import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  requiredOptInReason,
  selectAcceptanceCases,
  skippedCases,
  writeHardwareAcceptanceEvidence
} from "../src/acceptance/HardwareAcceptanceEvidence.js";
import {
  hardwareAcceptanceEventSchema,
  hardwareAcceptanceManifestSchema,
  hardwareAcceptanceResultSchema
} from "../src/acceptance/HardwareAcceptanceSchemas.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    await rm(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe("Round 8 hardware acceptance evidence", () => {
  test("requires explicit general, PCAN, and two-board opt-in without ambiguity", () => {
    expect(requiredOptInReason("single-board", {})).toContain("C2000_HARDWARE_TEST=1");
    expect(requiredOptInReason("can", { C2000_HARDWARE_TEST: "1" })).toContain("C2000_PCAN_HARDWARE_TEST=1");
    expect(requiredOptInReason("two-board", {
      C2000_HARDWARE_TEST: "1",
      C2000_PCAN_HARDWARE_TEST: "1"
    })).toContain("C2000_TWO_BOARD_TEST=1");
    expect(requiredOptInReason("two-board", {
      C2000_HARDWARE_TEST: "1",
      C2000_PCAN_HARDWARE_TEST: "1",
      C2000_TWO_BOARD_TEST: "1"
    })).toBeNull();
  });

  test("never promotes an opt-out run to hardware or bus evidence", () => {
    const cases = skippedCases("all", "hardware opt-in absent", "2026-07-29T00:00:00.000Z");
    expect(cases).toHaveLength(selectAcceptanceCases("all").length);
    expect(cases.every(item => item.status === "SKIPPED_NO_HARDWARE")).toBe(true);
    expect(cases.every(item => item.evidenceLevel === "HOST_COMMAND_EVIDENCE")).toBe(true);
    expect(cases.every(item => item.details.targetAccessAttempted === false)).toBe(true);
  });

  test("atomically writes parseable result, ordered events, manifest, and generated report", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "c2000-hardware-acceptance-"));
    temporaryDirectories.push(root);
    const timestamp = "2026-07-29T00:00:00.000Z";
    const written = await writeHardwareAcceptanceEvidence({
      outputDirectory: root,
      runId: "round8-no-hardware",
      scope: "variables",
      cases: skippedCases("variables", "not opted in", timestamp),
      startedAt: timestamp,
      endedAt: timestamp
    });
    const result = hardwareAcceptanceResultSchema.parse(JSON.parse(
      await readFile(path.join(root, "hardware-acceptance-result.json"), "utf8")
    ));
    const events = (await readFile(path.join(root, "hardware-acceptance-events.jsonl"), "utf8"))
      .trim().split("\n").map(line => hardwareAcceptanceEventSchema.parse(JSON.parse(line)));
    const manifest = hardwareAcceptanceManifestSchema.parse(JSON.parse(
      await readFile(path.join(root, "hardware-acceptance-manifest.json"), "utf8")
    ));
    const report = await readFile(path.join(root, "HARDWARE_ACCEPTANCE_REPORT.md"), "utf8");

    expect(written.result.overallStatus).toBe("SKIPPED_NO_HARDWARE");
    expect(result.cases[0].caseId).toBe("C");
    expect(events.map(event => event.sequence)).toEqual(events.map((_, index) => index + 1));
    expect(events.every((event, index) => index === 0 || BigInt(event.monotonicTimestampNs) > BigInt(events[index - 1].monotonicTimestampNs))).toBe(true);
    expect(manifest.generatedFiles).toHaveLength(3);
    expect(report).toContain("SKIPPED_NO_HARDWARE");
    expect(report).not.toContain("PASS_HARDWARE");
  });

  test("does not serialize unrelated secrets", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "c2000-hardware-secret-"));
    temporaryDirectories.push(root);
    const oldToken = process.env.C2000_DAEMON_RPC_TOKEN;
    const oldGithub = process.env.GITHUB_TOKEN;
    process.env.C2000_DAEMON_RPC_TOKEN = "daemon-secret-must-not-leak";
    process.env.GITHUB_TOKEN = "github-secret-must-not-leak";
    try {
      await writeHardwareAcceptanceEvidence({
        outputDirectory: root,
        runId: "round8-redaction",
        scope: "dlog",
        cases: skippedCases("dlog", "not opted in", "2026-07-29T00:00:00.000Z"),
        startedAt: "2026-07-29T00:00:00.000Z",
        endedAt: "2026-07-29T00:00:00.000Z"
      });
      const contents = await Promise.all([
        "hardware-acceptance-result.json",
        "hardware-acceptance-events.jsonl",
        "hardware-acceptance-manifest.json",
        "HARDWARE_ACCEPTANCE_REPORT.md"
      ].map(file => readFile(path.join(root, file), "utf8")));
      expect(contents.join("\n")).not.toContain("daemon-secret-must-not-leak");
      expect(contents.join("\n")).not.toContain("github-secret-must-not-leak");
    } finally {
      if (oldToken === undefined) delete process.env.C2000_DAEMON_RPC_TOKEN;
      else process.env.C2000_DAEMON_RPC_TOKEN = oldToken;
      if (oldGithub === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = oldGithub;
    }
  });

  test("preflight exits SKIPPED before hardware discovery when opt-in is absent", () => {
    const env = { ...process.env };
    delete env.C2000_HARDWARE_TEST;
    delete env.C2000_PCAN_HARDWARE_TEST;
    delete env.C2000_TWO_BOARD_TEST;
    const run = spawnSync(process.execPath, [
      path.resolve("node_modules/tsx/dist/cli.mjs"),
      path.resolve("scripts/ccs-preflight.ts")
    ], {
      cwd: process.cwd(),
      env,
      encoding: "utf8",
      timeout: 15_000
    });
    expect(run.status).toBe(0);
    const output = JSON.parse(run.stdout);
    expect(output.status).toBe("SKIPPED_NO_HARDWARE");
    expect(output.targetAccessAttempted).toBe(false);
    expect(output.pcanOpened).toBe(false);
  });

  test("publishes every requested hardware entry point", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as { scripts: Record<string, string> };
    for (const name of [
      "acceptance:hardware:single-board",
      "acceptance:hardware:multicore",
      "acceptance:hardware:variables",
      "acceptance:hardware:dlog",
      "acceptance:hardware:erad",
      "acceptance:hardware:trace",
      "acceptance:hardware:can",
      "acceptance:hardware:two-board",
      "acceptance:hardware:soak",
      "acceptance:hardware:all"
    ]) {
      expect(packageJson.scripts[name]).toContain("scripts/hardware-acceptance.ts");
    }
  });

  test("manual hardware workflow carries the same layered opt-in gates", async () => {
    const workflow = await readFile(".github/workflows/hardware-manual.yml", "utf8");
    expect(workflow.match(/C2000_HARDWARE_TEST: "1"/g)).toHaveLength(3);
    expect(workflow.match(/C2000_PCAN_HARDWARE_TEST: "1"/g)).toHaveLength(2);
    expect(workflow.match(/C2000_TWO_BOARD_TEST: "1"/g)).toHaveLength(1);
    expect(workflow).toContain("artifacts/hardware-acceptance/**");
  });
});
