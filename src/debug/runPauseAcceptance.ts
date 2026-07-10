import assert from "node:assert/strict";
import { CHECKED_PEER_FIELDS } from "./isolationAssertions.js";
import type { CheckedPeerField } from "./isolationAssertions.js";

export const RUN_PAUSE_ACCEPTANCE_EVIDENCE = "c2000_verifyRunPauseIsolation";

export type RunPauseExpectedState = "Running" | "Halted";

export type RunPauseAcceptanceStepSpec = Readonly<{
  label: string;
  targetCoreId: number;
  targetCoreName: string;
  expectedTargetState: RunPauseExpectedState;
  peerCoreIds: readonly number[];
}>;

export type RunPauseAcceptanceSummaryStep = {
  label: string;
  success: boolean;
  commandCoreId?: unknown;
  commandCoreName?: unknown;
  targetCoreId: unknown;
  expectedTargetState: unknown;
  peerCoreIds: unknown;
  checkedPeerFields: unknown;
  commandError?: unknown;
  failures: unknown[];
};

export type RunPauseAcceptanceSummary = {
  success: boolean;
  evidence: typeof RUN_PAUSE_ACCEPTANCE_EVIDENCE;
  requiredLabels: string[];
  acceptanceCriteria: RunPauseAcceptanceCriterion[];
  steps: RunPauseAcceptanceSummaryStep[];
};

export type RunPauseAcceptanceCriterion = {
  requirement: string;
  label: string;
  targetCoreId: number;
  peerCoreIds: number[];
  expectedTargetState: RunPauseExpectedState;
};

export type RunPauseAcceptanceCoreOptions = {
  cpu1CoreId?: number;
  cpu2CoreId?: number;
  cpu1CoreName?: string;
  cpu2CoreName?: string;
};

export type RunPauseIsolationStepInput = {
  label: string;
  commandResult?: unknown;
  assertion?: {
    success?: unknown;
    targetCoreId?: unknown;
    expectedTargetState?: unknown;
    peerCoreIds?: unknown;
    checkedPeerFields?: unknown;
    failures?: unknown;
  };
};

export const RUN_PAUSE_ACCEPTANCE_STEPS = [
  { label: "c2000_continue(cpu1)", targetCoreId: 0, targetCoreName: "C28xx_CPU1", expectedTargetState: "Running", peerCoreIds: [2] },
  { label: "c2000_pause(cpu1)", targetCoreId: 0, targetCoreName: "C28xx_CPU1", expectedTargetState: "Halted", peerCoreIds: [2] },
  { label: "c2000_continue(cpu2)", targetCoreId: 2, targetCoreName: "C28xx_CPU2", expectedTargetState: "Running", peerCoreIds: [0] },
  { label: "c2000_pause(cpu2)", targetCoreId: 2, targetCoreName: "C28xx_CPU2", expectedTargetState: "Halted", peerCoreIds: [0] }
] as const satisfies readonly RunPauseAcceptanceStepSpec[];

export function buildRunPauseAcceptanceSummary(steps: RunPauseIsolationStepInput[], options: RunPauseAcceptanceCoreOptions = {}): RunPauseAcceptanceSummary {
  const expectedSteps = expectedRunPauseAcceptanceSteps(options);
  const requiredLabels = expectedSteps.map(step => step.label);
  const summarySteps = expectedSteps.map(required => {
    const step = steps.find(candidate => candidate.label === required.label);
    const reportedFailures = Array.isArray(step?.assertion?.failures) ? step.assertion.failures : [];
    const consistencyFailures = stepConsistencyFailures(step, required);
    return {
      label: required.label,
      success: step?.assertion?.success === true && reportedFailures.length === 0 && consistencyFailures.length === 0,
      ...commandCoreIdentity(step?.commandResult),
      targetCoreId: step?.assertion?.targetCoreId,
      expectedTargetState: step?.assertion?.expectedTargetState,
      peerCoreIds: step?.assertion?.peerCoreIds ?? [],
      checkedPeerFields: checkedPeerFields(step?.assertion?.checkedPeerFields),
      ...(commandError(step?.commandResult) ? { commandError: commandError(step?.commandResult) } : {}),
      failures: [...reportedFailures, ...consistencyFailures]
    };
  });
  return {
    success: summarySteps.every(step => step.success),
    evidence: RUN_PAUSE_ACCEPTANCE_EVIDENCE,
    requiredLabels,
    acceptanceCriteria: runPauseAcceptanceCriteria(options),
    steps: summarySteps
  };
}

export function assertRunPauseAcceptanceSummary(value: unknown, options: RunPauseAcceptanceCoreOptions = {}) {
  const expectedSteps = expectedRunPauseAcceptanceSteps(options);
  const acceptanceSummary = asRecord(value);
  if (acceptanceSummary.success !== true) {
    throw new Error(`Run/pause isolation acceptance failed: ${JSON.stringify(value, null, 2)}`);
  }
  assert.equal(acceptanceSummary.evidence, RUN_PAUSE_ACCEPTANCE_EVIDENCE);
  assert.deepEqual(acceptanceSummary.requiredLabels, expectedSteps.map(step => step.label));
  assert.deepEqual(acceptanceSummary.acceptanceCriteria, runPauseAcceptanceCriteria(options));
  const steps = Array.isArray(acceptanceSummary.steps) ? acceptanceSummary.steps : [];
  for (const { label, targetCoreId, targetCoreName, expectedTargetState, peerCoreIds } of expectedSteps) {
    const step = steps.find(candidate => isRecord(candidate) && candidate.label === label);
    if (!step || step.success !== true) {
      throw new Error(`Run/pause isolation acceptance step failed: ${label}`);
    }
    if (step.targetCoreId !== targetCoreId || step.expectedTargetState !== expectedTargetState) {
      throw new Error(`Run/pause isolation acceptance step mismatch: ${JSON.stringify({ label, step, targetCoreId, expectedTargetState }, null, 2)}`);
    }
    if (step.commandCoreId !== targetCoreId) {
      throw new Error(`Run/pause isolation acceptance commandCoreId mismatch: ${JSON.stringify({ label, step, targetCoreId }, null, 2)}`);
    }
    assert.equal(typeof step.commandCoreName, "string", `${label} commandCoreName`);
    assert.notEqual(step.commandCoreName.length, 0, `${label} commandCoreName`);
    if (step.commandCoreName !== targetCoreName) {
      throw new Error(`Run/pause isolation acceptance commandCoreName mismatch: ${JSON.stringify({ label, step, targetCoreName }, null, 2)}`);
    }
    assert.deepEqual(step.peerCoreIds, [...peerCoreIds], `${label} peerCoreIds`);
    assert.deepEqual(step.checkedPeerFields, [...CHECKED_PEER_FIELDS], `${label} checkedPeerFields`);
    assert(Array.isArray(step.failures), `${label} failures must be an array`);
    assert.equal(step.failures.length, 0, `${label} failures`);
  }
}

export function runPauseAcceptanceCriteria(options: RunPauseAcceptanceCoreOptions = {}): RunPauseAcceptanceCriterion[] {
  const cpu1CoreId = options.cpu1CoreId ?? 0;
  const cpu2CoreId = options.cpu2CoreId ?? 2;
  return [
    {
      requirement: `c2000_continue({ sessionId, coreId: ${cpu1CoreId} }) only runs CPU1`,
      label: "c2000_continue(cpu1)",
      targetCoreId: cpu1CoreId,
      peerCoreIds: [cpu2CoreId],
      expectedTargetState: "Running"
    },
    {
      requirement: `c2000_continue({ sessionId, coreId: ${cpu2CoreId} }) only runs CPU2`,
      label: "c2000_continue(cpu2)",
      targetCoreId: cpu2CoreId,
      peerCoreIds: [cpu1CoreId],
      expectedTargetState: "Running"
    },
    {
      requirement: `c2000_pause({ sessionId, coreId: ${cpu1CoreId} }) only pauses CPU1`,
      label: "c2000_pause(cpu1)",
      targetCoreId: cpu1CoreId,
      peerCoreIds: [cpu2CoreId],
      expectedTargetState: "Halted"
    },
    {
      requirement: `c2000_pause({ sessionId, coreId: ${cpu2CoreId} }) only pauses CPU2`,
      label: "c2000_pause(cpu2)",
      targetCoreId: cpu2CoreId,
      peerCoreIds: [cpu1CoreId],
      expectedTargetState: "Halted"
    }
  ];
}

function expectedRunPauseAcceptanceSteps(options: RunPauseAcceptanceCoreOptions): readonly RunPauseAcceptanceStepSpec[] {
  const cpu1CoreId = options.cpu1CoreId ?? 0;
  const cpu2CoreId = options.cpu2CoreId ?? 2;
  const cpu1CoreName = options.cpu1CoreName ?? "C28xx_CPU1";
  const cpu2CoreName = options.cpu2CoreName ?? "C28xx_CPU2";
  if (cpu1CoreId === 0 && cpu2CoreId === 2 && cpu1CoreName === "C28xx_CPU1" && cpu2CoreName === "C28xx_CPU2") {
    return RUN_PAUSE_ACCEPTANCE_STEPS;
  }
  return [
    { label: "c2000_continue(cpu1)", targetCoreId: cpu1CoreId, targetCoreName: cpu1CoreName, expectedTargetState: "Running", peerCoreIds: [cpu2CoreId] },
    { label: "c2000_pause(cpu1)", targetCoreId: cpu1CoreId, targetCoreName: cpu1CoreName, expectedTargetState: "Halted", peerCoreIds: [cpu2CoreId] },
    { label: "c2000_continue(cpu2)", targetCoreId: cpu2CoreId, targetCoreName: cpu2CoreName, expectedTargetState: "Running", peerCoreIds: [cpu1CoreId] },
    { label: "c2000_pause(cpu2)", targetCoreId: cpu2CoreId, targetCoreName: cpu2CoreName, expectedTargetState: "Halted", peerCoreIds: [cpu1CoreId] }
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`Run/pause isolation acceptance summary must be an object: ${JSON.stringify(value)}`);
  }
  return value;
}

function checkedPeerFields(value: unknown): CheckedPeerField[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is CheckedPeerField => {
    return typeof item === "string" && (CHECKED_PEER_FIELDS as readonly string[]).includes(item);
  });
}

function commandError(commandResult: unknown): unknown {
  if (!isRecord(commandResult) || !isRecord(commandResult.error)) {
    return undefined;
  }
  return commandResult.error;
}

function stepConsistencyFailures(step: RunPauseIsolationStepInput | undefined, required: RunPauseAcceptanceStepSpec): string[] {
  if (!step) {
    return [`step ${required.label} missing`];
  }

  const failures: string[] = [];
  if (step.assertion?.targetCoreId !== required.targetCoreId) {
    failures.push(`targetCoreId expected ${required.targetCoreId}, got ${String(step.assertion?.targetCoreId)}`);
  }
  const commandCore = commandCoreIdentity(step.commandResult);
  if (!("commandCoreId" in commandCore) || !("commandCoreName" in commandCore)) {
    failures.push("command core identity missing");
  } else if (typeof commandCore.commandCoreId !== "number" || commandCore.commandCoreId !== required.targetCoreId) {
    failures.push(`commandCoreId expected ${required.targetCoreId}, got ${String(commandCore.commandCoreId)}`);
  } else if (commandCore.commandCoreName !== required.targetCoreName) {
    failures.push(`commandCoreName expected ${required.targetCoreName}, got ${String(commandCore.commandCoreName)}`);
  }
  if ("commandCoreName" in commandCore && (typeof commandCore.commandCoreName !== "string" || commandCore.commandCoreName.length === 0)) {
    failures.push(`commandCoreName must be a non-empty string, got ${String(commandCore.commandCoreName)}`);
  }
  if (step.assertion?.expectedTargetState !== required.expectedTargetState) {
    failures.push(`expectedTargetState expected ${required.expectedTargetState}, got ${String(step.assertion?.expectedTargetState)}`);
  }
  if (!arrayEqual(asNumberArray(step.assertion?.peerCoreIds), [...required.peerCoreIds])) {
    failures.push(`peerCoreIds expected ${JSON.stringify([...required.peerCoreIds])}, got ${JSON.stringify(step.assertion?.peerCoreIds ?? [])}`);
  }
  if (!arrayEqual(asStringArray(step.assertion?.checkedPeerFields), [...CHECKED_PEER_FIELDS])) {
    failures.push(`checkedPeerFields expected ${JSON.stringify([...CHECKED_PEER_FIELDS])}, got ${JSON.stringify(step.assertion?.checkedPeerFields ?? [])}`);
  }
  return failures;
}

function asNumberArray(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((item): item is number => typeof item === "number") : [];
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function arrayEqual<T>(left: T[], right: T[]) {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function commandCoreIdentity(commandResult: unknown): { commandCoreId?: unknown; commandCoreName?: unknown } {
  if (!isRecord(commandResult)) {
    return {};
  }
  return {
    ...("coreId" in commandResult ? { commandCoreId: commandResult.coreId } : {}),
    ...("coreName" in commandResult ? { commandCoreName: commandResult.coreName } : {})
  };
}
