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
  const checkedFields = new Set<CheckedPeerField>();
  for (const beforePeer of input.before.cores) {
    if (beforePeer.coreId === input.targetCoreId) {
      continue;
    }
    const afterPeer = findCore(input.after, beforePeer.coreId, input.label, "after");
    const peerFields = peerFieldsToCheck(beforePeer);
    for (const field of peerFields) {
      checkedFields.add(field);
    }
    assertPeerUnchanged(input.label, beforePeer, afterPeer, peerFields);
    peerCoreIds.push(beforePeer.coreId);
  }

  return {
    label: input.label,
    targetCoreId: beforeTarget.coreId,
    expectedTargetState: input.expectedTargetState,
    peerCoreIds,
    checkedPeerFields: CHECKED_PEER_FIELDS.filter(field => checkedFields.has(field)),
    success: true
  };
}

/**
 * Running peers freely advance PC; only compare PC when the peer was Halted
 * (or otherwise not Running) so isolation checks stay meaningful on hardware.
 */
export function peerFieldsToCheck(beforePeer: CoreSnapshot): CheckedPeerField[] {
  if (beforePeer.state === "Running") {
    return CHECKED_PEER_FIELDS.filter(field => field !== "pc");
  }
  return [...CHECKED_PEER_FIELDS];
}

function findCore(snapshot: MulticoreSnapshotLike, coreId: CoreId, label: string, phase: string): CoreSnapshot {
  const core = snapshot.cores.find(item => item.coreId === coreId);
  if (!core) {
    throw new Error(`${label}: core ${coreId} missing in ${phase} snapshot.`);
  }
  return core;
}

function assertPeerUnchanged(
  label: string,
  before: CoreSnapshot,
  after: CoreSnapshot,
  fields: readonly CheckedPeerField[]
) {
  const changedFields: CheckedPeerField[] = fields
    .filter(field => field !== "loadedProgramInfo")
    .filter(field => before[field] !== after[field]);
  if (fields.includes("loadedProgramInfo") && stableJson(before.loadedProgramInfo) !== stableJson(after.loadedProgramInfo)) {
    changedFields.push("loadedProgramInfo");
  }
  if (changedFields.length > 0) {
    throw new Error(`${label}: peer core ${before.coreId} changed fields: ${changedFields.join(", ")}.`);
  }
}

function stableJson(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  return JSON.stringify(canonicalizeJson(value));
}

/** Recursively sort object keys so nested loadedProgramInfo comparisons are order-stable. */
function canonicalizeJson(value: unknown): unknown {
  if (value === undefined || value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(item => canonicalizeJson(item));
  }
  const record = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    sorted[key] = canonicalizeJson(record[key]);
  }
  return sorted;
}
