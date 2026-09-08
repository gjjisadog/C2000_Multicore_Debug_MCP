export interface IpcOptimizationInput {
  ipcReady?: {
    matched?: boolean;
    timedOut?: boolean;
    conditions?: Array<{
      coreId?: number;
      expression?: string;
      matched?: boolean;
      result?: { success?: boolean; error?: { code?: string } };
    }>;
    firstFailure?: Record<string, unknown>;
  };
  elfFreshness?: { allFresh?: boolean };
  runtimeRamOwnership?: { requested?: boolean; matched?: boolean; supported?: boolean };
  runPlan?: { mode?: string; coreOrder?: number[] };
}

export interface IpcOptimizationFeedback {
  schemaVersion: 1;
  failureSignature:
    | "IPC_ACCEPTANCE_READY"
    | "RUN_PLAN_EMPTY"
    | "ELF_STALE"
    | "RAM_OWNERSHIP_UNVERIFIED"
    | "IPC_EXPRESSION_UNREADABLE"
    | "IPC_READY_TIMEOUT"
    | "IPC_CONDITION_MISMATCH";
  evidencePriority: string[];
  nextAction: "accept" | "host-artifact-repair" | "read-only-diagnosis" | "manual-firmware-review";
  automaticRetry: "never";
  reason: string;
  failedConditions: Array<{ coreId?: number; expression?: string; errorCode?: string }>;
}

export interface DebugFailureFeedback {
  schemaVersion: 1;
  failureSignature:
    | "PROBE_TRANSIENT_UNAVAILABLE"
    | "PRELOADED_LOAD_SEMANTICS"
    | "HOST_ARTIFACT_INVALID"
    | "STARTUP_CONTRACT_INVALID"
    | "SAFETY_FENCE"
    | "IPC_HANDSHAKE_TIMEOUT"
    | "TARGET_OPERATION_FAILED";
  nextAction: "readiness-recheck" | "host-artifact-repair" | "read-only-diagnosis" | "manual-intervention";
  automaticRetry: "never";
  reason: string;
}

/** Classify a durable-step failure without authorizing another target action. */
export function classifyDebugFailure(input: {
  code?: string;
  message?: string;
  details?: Record<string, unknown>;
}): DebugFailureFeedback {
  const text = `${input.code ?? ""} ${input.message ?? ""} ${JSON.stringify(input.details ?? {})}`;
  const nestedCodes = collectErrorCodes(input.details);
  const hasCode = (...codes: string[]) => codes.some(code => input.code === code || nestedCodes.has(code));
  if (hasCode("ProbeNotFound", "ProbeNotConnected", "ProbeSelectionRequired")
    || /Error\s*-260|Found 0 devices|XDS110|IcePick_C_0|probe(?:Id| serial)?.*(?:missing|not found|unavailable)/i.test(text)) {
    return failureFeedback("PROBE_TRANSIENT_UNAVAILABLE", "readiness-recheck", "The debug probe was not available to the host; re-run read-only daemon/board/probe readiness before interpreting target evidence.");
  }
  if (hasCode("ArtifactPairInvalid", "LaunchArtifactsMissing", "ArtifactHashMismatch", "ProgramFileNotFound", "PathOutsideAllowedReadRoots", "PathResolutionFailed", "RamOwnershipMapUnavailable")) {
    return failureFeedback("HOST_ARTIFACT_INVALID", "host-artifact-repair", "The artifact set is incomplete, stale, or semantically incompatible; repair or rebuild the exact CPU1/CPU2 pair before touching the target.");
  }
  if (hasCode("StartupContractInvalid")) {
    return failureFeedback("STARTUP_CONTRACT_INVALID", "read-only-diagnosis", "The requested CPU1/CPU2 load and run sequence is contradictory; select one explicit startup contract before touching the target.");
  }
  if (hasCode("ProgramLoadFailed") && /main|preload|halt|timeout|stop/i.test(text)) {
    return failureFeedback("PRELOADED_LOAD_SEMANTICS", "read-only-diagnosis", "The adapter could not complete a halted preload of a synchronization-sensitive image; inspect the load/run contract rather than changing PC or firmware watch fields.");
  }
  if (hasCode("SafetyGuardViolation")) {
    return failureFeedback("SAFETY_FENCE", "manual-intervention", "A safety guard or fenced halt failed; preserve the board quarantine and require an explicit safety review before another target action.");
  }
  if (hasCode("ExpressionWaitTimeout") || /IPC_READY_TIMEOUT|IPC readiness timed out/i.test(text)) {
    return failureFeedback("IPC_HANDSHAKE_TIMEOUT", "read-only-diagnosis", "The IPC handshake did not reach its declared conditions; inspect first-failure evidence and final PC before any retry.");
  }
  return failureFeedback("TARGET_OPERATION_FAILED", "read-only-diagnosis", "The target operation failed without a safe automatic recovery classification; retain the session evidence and diagnose before retrying.");
}

function collectErrorCodes(details: Record<string, unknown> | undefined): Set<string> {
  const codes = new Set<string>();
  const visit = (value: unknown, depth: number): void => {
    if (depth > 6 || value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(item => visit(item, depth + 1));
      return;
    }
    const record = value as Record<string, unknown>;
    if (typeof record.code === "string") codes.add(record.code);
    Object.values(record).forEach(item => visit(item, depth + 1));
  };
  visit(details, 0);
  return codes;
}

function failureFeedback(
  failureSignature: DebugFailureFeedback["failureSignature"],
  nextAction: DebugFailureFeedback["nextAction"],
  reason: string
): DebugFailureFeedback {
  return { schemaVersion: 1, failureSignature, nextAction, automaticRetry: "never", reason };
}

/**
 * Turn a workflow result into a stable, auditable feedback record. The
 * classifier deliberately has no target-control capability: it can select a
 * safer next diagnostic, but it cannot decide to reset/load/run again.
 */
export function classifyIpcAcceptance(input: IpcOptimizationInput): IpcOptimizationFeedback {
  const conditions = input.ipcReady?.conditions ?? [];
  const failedConditions = conditions
    .filter(condition => condition.matched !== true)
    .map(condition => ({
      coreId: condition.coreId,
      expression: condition.expression,
      ...(condition.result?.error?.code ? { errorCode: condition.result.error.code } : {})
    }));

  if (input.runPlan?.coreOrder?.length === 0) {
    return feedback("RUN_PLAN_EMPTY", "manual-firmware-review", "The resolved run plan starts no core; verify runMode or legacy run flags before touching the target.", ["runPlan", "loadSequence"] , failedConditions);
  }
  if (input.elfFreshness?.allFresh === false) {
    return feedback("ELF_STALE", "host-artifact-repair", "The loaded program metadata does not match the host artifact; rebuild or reload the exact .out before interpreting IPC state.", ["elfFreshness", "artifactPair", "programSha256"], failedConditions);
  }
  if (failedConditions.some(condition => condition.errorCode)) {
    return feedback("IPC_EXPRESSION_UNREADABLE", "manual-firmware-review", "At least one IPC condition was not readable; verify symbols, map/output pairing, and the firmware diagnostic profile.", ["firstFailure", "ipcReady.conditions", "elfFreshness"], failedConditions);
  }
  if (input.ipcReady?.timedOut) {
    return feedback("IPC_READY_TIMEOUT", "read-only-diagnosis", "IPC readiness timed out; use the first-failure snapshot and final PC as evidence, then inspect the first unmet condition before any retry.", ["firstFailure", "ipcReady.conditions", "timeoutRecovery.pc", "runPlan"], failedConditions);
  }
  if (input.runtimeRamOwnership?.requested && input.runtimeRamOwnership.matched === false) {
    return feedback("RAM_OWNERSHIP_UNVERIFIED", "manual-firmware-review", "Runtime GS/flash ownership verification did not match; inspect linker-map ownership and startup assignment before another run.", ["ramOwnership", "runtimeRamOwnership", "firstFailure"], failedConditions);
  }
  if (input.ipcReady?.matched === false) {
    return feedback("IPC_CONDITION_MISMATCH", "read-only-diagnosis", "IPC conditions did not match; compare the first and final condition values and keep the current session halted for diagnosis.", ["firstFailure", "ipcReady.conditions", "runPlan"], failedConditions);
  }
  return feedback("IPC_ACCEPTANCE_READY", "accept", "All declared IPC conditions matched with fresh artifacts and no requested ownership mismatch.", ["ipcReady.conditions", "elfFreshness", "runPlan"], failedConditions);
}

function feedback(
  failureSignature: IpcOptimizationFeedback["failureSignature"],
  nextAction: IpcOptimizationFeedback["nextAction"],
  reason: string,
  evidencePriority: string[],
  failedConditions: IpcOptimizationFeedback["failedConditions"]
): IpcOptimizationFeedback {
  return {
    schemaVersion: 1,
    failureSignature,
    evidencePriority,
    nextAction,
    automaticRetry: "never",
    reason,
    failedConditions
  };
}
