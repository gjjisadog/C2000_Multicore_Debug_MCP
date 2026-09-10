import { describe, expect, test } from "vitest";
import { classifyDebugFailure, classifyIpcAcceptance } from "../src/debug/DebugFailureClassifier.js";

describe("classifyIpcAcceptance", () => {
  test("prioritizes host artifact repair over a misleading IPC timeout", () => {
    const result = classifyIpcAcceptance({
      elfFreshness: { allFresh: false },
      ipcReady: { timedOut: true, matched: false, conditions: [{ coreId: 0, expression: "g_stage", matched: false }] },
      runPlan: { mode: "debugger_runs_both", coreOrder: [0, 2] }
    });

    expect(result).toEqual(expect.objectContaining({
      failureSignature: "ELF_STALE",
      nextAction: "host-artifact-repair",
      automaticRetry: "never"
    }));
  });

  test("keeps unreadable expressions in the feedback record", () => {
    const result = classifyIpcAcceptance({
      ipcReady: {
        matched: false,
        conditions: [{ coreId: 2, expression: "g_missing", matched: false, result: { success: false, error: { code: "SymbolNotFound" } } }],
        firstFailure: { pollIteration: 1 }
      },
      runPlan: { coreOrder: [0, 2] }
    });

    expect(result).toEqual(expect.objectContaining({
      failureSignature: "IPC_EXPRESSION_UNREADABLE",
      failedConditions: [{ coreId: 2, expression: "g_missing", errorCode: "SymbolNotFound" }],
      evidencePriority: expect.arrayContaining(["firstFailure"])
    }));
  });

  test("returns an explicit no-retry success record", () => {
    expect(classifyIpcAcceptance({
      ipcReady: { matched: true, conditions: [{ coreId: 0, expression: "g_ready", matched: true }] },
      elfFreshness: { allFresh: true },
      runPlan: { coreOrder: [0, 2] }
    })).toEqual(expect.objectContaining({
      failureSignature: "IPC_ACCEPTANCE_READY",
      nextAction: "accept",
      automaticRetry: "never"
    }));
  });
});

describe("classifyDebugFailure", () => {
  test("separates transient XDS110 loss from target firmware failure", () => {
    expect(classifyDebugFailure({
      code: "DssLaunchFailed",
      message: "XDS110 Error -260: Found 0 devices"
    })).toEqual(expect.objectContaining({
      failureSignature: "PROBE_TRANSIENT_UNAVAILABLE",
      nextAction: "readiness-recheck",
      automaticRetry: "never"
    }));
  });

  test("identifies synchronization-sensitive preload timeout", () => {
    expect(classifyDebugFailure({
      code: "ProgramLoadFailed",
      message: "CPU2 load timed out while waiting to stop at main"
    })).toEqual(expect.objectContaining({
      failureSignature: "PRELOADED_LOAD_SEMANTICS",
      nextAction: "read-only-diagnosis"
    }));
  });

  test("separates TI Flash programmer state from permanent target protection", () => {
    expect(classifyDebugFailure({
      code: "ProgramLoadFailed",
      message: "Flash Programmer: Error erasing Bank 3 Flash registers are locked; Operation Cancelled (3)."
    })).toEqual(expect.objectContaining({
      failureSignature: "FLASH_PROGRAMMER_STATE",
      nextAction: "read-only-diagnosis",
      automaticRetry: "never"
    }));
  });

  test("requires a fresh session after a quarantined CPU2 Flash load", () => {
    expect(classifyDebugFailure({
      code: "FlashLoadSessionQuarantined",
      message: "no further CPU2 program load was attempted"
    })).toEqual(expect.objectContaining({
      failureSignature: "FLASH_LOAD_SESSION_QUARANTINED",
      nextAction: "read-only-diagnosis",
      automaticRetry: "never"
    }));
  });

  test("classifies host path and startup-contract failures without target retry", () => {
    expect(classifyDebugFailure({ code: "PathOutsideAllowedReadRoots", message: "artifact path rejected" })).toEqual(expect.objectContaining({
      failureSignature: "HOST_ARTIFACT_INVALID",
      nextAction: "host-artifact-repair",
      automaticRetry: "never"
    }));
    expect(classifyDebugFailure({ code: "StartupContractInvalid", message: "contradictory load/run sequence" })).toEqual(expect.objectContaining({
      failureSignature: "STARTUP_CONTRACT_INVALID",
      nextAction: "read-only-diagnosis",
      automaticRetry: "never"
    }));
  });

  test("classifies wrapped workflow causes instead of losing the actionable root error", () => {
    expect(classifyDebugFailure({
      code: "PostLaunchCheckFailed",
      message: "Launch and IPC acceptance workflow failed",
      details: { cause: { code: "StartupContractInvalid", details: { issues: ["contradictory"] } } }
    })).toEqual(expect.objectContaining({
      failureSignature: "STARTUP_CONTRACT_INVALID",
      nextAction: "read-only-diagnosis"
    }));
    expect(classifyDebugFailure({
      code: "BatchOperationFailed",
      details: { failed: [{ error: { code: "ArtifactHashMismatch" } }] }
    })).toEqual(expect.objectContaining({
      failureSignature: "HOST_ARTIFACT_INVALID",
      nextAction: "host-artifact-repair"
    }));
  });
});
