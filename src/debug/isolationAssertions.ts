import type { CoreId, CoreSnapshot, TargetStateName } from "./types.js";

export const CHECKED_PEER_FIELDS = ["connected", "state", "pc", "loadedProgram", "loadedProgramInfo"] as const;
export type CheckedPeerField = (typeof CHECKED_PEER_FIELDS)[number];

export interface MulticoreSnapshotLike {
  sessionId?: string;
  cores: CoreSnapshot[];
}

export interface CoreIsolationAssertionInput {
  label: string;
  before: MulticoreSnapshotLike;
  after: MulticoreSnapshotLike;
  targetCoreId: CoreId;
  expectedTargetState: TargetStateName;
}

export interface CoreIsolationAssertion {
  label: string;
  targetCoreId: CoreId;
  expectedTargetState: TargetStateName;
  peerCoreIds: CoreId[];
  checkedPeerFields: CheckedPeerField[];
  success: true;
}

export function assertCoreIsolation(input: CoreIsolationAssertionInput): CoreIsolationAssertion {
  if (input.before.sessionId && input.after.sessionId && input.before.sessionId !== input.after.sessionId) {
    throw new Error(`${input.label}: snapshot session mismatch. Expected ${input.before.sessionId}, got ${input.after.sessionId}.`);
  }

  const beforeTarget = findCore(input.before, input.targetCoreId, input.label, "before");
  const afterTarget = findCore(input.after, input.targetCoreId, input.label, "after");
  if (afterTarget.state !== input.expectedTargetState) {
    throw new Error(`${input.label}: target core ${input.targetCoreId} state mismatch. Expected ${input.expectedTargetState}, got ${afterTarget.state}.`);
  }

  const peerCoreIds: CoreId[] = [];
  for (const beforePeer of input.before.cores) {
    if (beforePeer.coreId === input.targetCoreId) {
      continue;
    }
    const afterPeer = findCore(input.after, beforePeer.coreId, input.label, "after");
    assertPeerUnchanged(input.label, beforePeer, afterPeer);
    peerCoreIds.push(beforePeer.coreId);
  }

  return {
    label: input.label,
    targetCoreId: beforeTarget.coreId,
    expectedTargetState: input.expectedTargetState,
    peerCoreIds,
    checkedPeerFields: [...CHECKED_PEER_FIELDS],
    success: true
  };
}

function findCore(snapshot: MulticoreSnapshotLike, coreId: CoreId, label: string, phase: string): CoreSnapshot {
  const core = snapshot.cores.find(item => item.coreId === coreId);
  if (!core) {
    throw new Error(`${label}: core ${coreId} missing in ${phase} snapshot.`);
  }
  return core;
}

function assertPeerUnchanged(label: string, before: CoreSnapshot, after: CoreSnapshot) {
  const changedFields: CheckedPeerField[] = CHECKED_PEER_FIELDS
    .filter(field => field !== "loadedProgramInfo")
    .filter(field => before[field] !== after[field]);
  if (stableJson(before.loadedProgramInfo) !== stableJson(after.loadedProgramInfo)) {
    changedFields.push("loadedProgramInfo");
  }
  if (changedFields.length > 0) {
    throw new Error(`${label}: peer core ${before.coreId} changed fields: ${changedFields.join(", ")}.`);
  }
}

function stableJson(value: unknown): string {
  if (value === undefined) {
    return "";
  }
  return JSON.stringify(value, Object.keys(value as Record<string, unknown>).sort());
}
