export type WorkflowRunMode = "cpu1_boots_cpu2" | "debugger_runs_both" | "cpu2_pre_running";
export type WorkflowLoadMode = "cpu1-then-cpu2" | "cpu1-run-before-cpu2";
export type Cpu2StartAuthority = "firmware-owned" | "debugger-owned" | "pre-running" | "unspecified";

export interface WorkflowStartupContractInput {
  loadMode: WorkflowLoadMode;
  runMode?: WorkflowRunMode;
  runCpu1First: boolean;
  runCpu2: boolean;
}

/**
 * Return deterministic host-side contract violations before a workflow can
 * halt, reset, load, or run a target. The load and run phases are separate
 * controls, but some combinations are physically contradictory for a
 * preloaded CPU2 image.
 */
export function workflowStartupContractIssues(input: WorkflowStartupContractInput): string[] {
  const issues: string[] = [];
  if (input.runMode === "cpu2_pre_running" && input.loadMode === "cpu1-run-before-cpu2") {
    issues.push("runMode cpu2_pre_running requires CPU2 to be loaded before it is started; loadSequence.mode cpu1-run-before-cpu2 runs CPU1 before CPU2 is loaded");
  }
  if (input.runMode === "cpu1_boots_cpu2" && input.loadMode === "cpu1-run-before-cpu2") {
    issues.push("runMode cpu1_boots_cpu2 requires the CPU2 image to be loaded before CPU1 is started; loadSequence.mode cpu1-run-before-cpu2 loads CPU2 after CPU1 has begun its release path");
  }
  if (input.runMode === "cpu1_boots_cpu2" && input.runCpu2) {
    issues.push("runMode cpu1_boots_cpu2 requires runCpu2=false because CPU1 firmware owns the CPU2 release");
  }
  if (input.runMode === "cpu2_pre_running" && input.runCpu1First) {
    issues.push("runMode cpu2_pre_running requires runCpu1First=false");
  }
  if (input.runMode === "debugger_runs_both" && (!input.runCpu1First || !input.runCpu2)) {
    issues.push("runMode debugger_runs_both requires runCpu1First=true and runCpu2=true");
  }
  return issues;
}

export function describeWorkflowStartupContract(input: WorkflowStartupContractInput) {
  const cpu2StartAuthority = input.runMode === "cpu1_boots_cpu2"
    ? "firmware-owned"
    : input.runMode === "debugger_runs_both"
      ? "debugger-owned"
      : input.runMode === "cpu2_pre_running"
        ? "pre-running"
        : "unspecified";
  return {
    loadMode: input.loadMode,
    runMode: input.runMode ?? "legacy_flags",
    cpu2StartAuthority,
    authorityEvidence: input.runMode ? "explicit-run-mode" : "legacy-flags-ambiguous",
    runCpu1First: input.runCpu1First,
    runCpu2: input.runCpu2,
    issues: workflowStartupContractIssues(input),
    warnings: input.runMode
      ? []
      : ["Legacy run flags do not establish whether CPU1 firmware releases CPU2; set runSequence.runMode explicitly before interpreting CPU2 startup evidence."]
  };
}
