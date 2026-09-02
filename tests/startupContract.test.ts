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
});
