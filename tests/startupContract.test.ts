import { describe, expect, test } from "vitest";
import { describeWorkflowStartupContract } from "../src/debug/startupContract.js";

describe("workflow startup contract evidence", () => {
  test("identifies firmware-owned CPU2 release when the explicit run mode is selected", () => {
    expect(describeWorkflowStartupContract({
      loadMode: "cpu1-then-cpu2",
      runMode: "cpu1_boots_cpu2",
      runCpu1First: true,
      runCpu2: false
    })).toEqual(expect.objectContaining({
      runMode: "cpu1_boots_cpu2",
      cpu2StartAuthority: "firmware-owned",
      authorityEvidence: "explicit-run-mode",
      warnings: []
    }));
  });

  test("marks legacy flags as ambiguous instead of claiming CPU2 ownership", () => {
    expect(describeWorkflowStartupContract({
      loadMode: "cpu1-then-cpu2",
      runCpu1First: true,
      runCpu2: true
    })).toEqual(expect.objectContaining({
      runMode: "legacy_flags",
      cpu2StartAuthority: "unspecified",
      authorityEvidence: "legacy-flags-ambiguous",
      warnings: [expect.stringContaining("do not establish")]
    }));
  });

  test("rejects CPU1 pre-run when the legacy release flag selects firmware-owned boot", () => {
    expect(describeWorkflowStartupContract({
      loadMode: "cpu1-run-before-cpu2",
      runCpu1First: true,
      runCpu2: false,
      releaseCpu2BeforeCpu1: true
    })).toEqual(expect.objectContaining({
      cpu2StartAuthority: "firmware-owned",
      authorityEvidence: "explicit-release-flag",
      issues: [expect.stringContaining("both images to be loaded before CPU1")]
    }));
  });
});
