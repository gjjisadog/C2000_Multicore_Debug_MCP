export const boardStatuses = [
  "OFFLINE",
  "AVAILABLE",
  "RESERVED",
  "STARTING",
  "READY",
  "RUNNING",
  "RECOVERING",
  "QUARANTINED",
  "FAILED"
] as const;

export type BoardStatus = typeof boardStatuses[number];

export const boardLeaseStatuses = ["NONE", "ACTIVE", "STALE", "EXPIRED", "INVALIDATED"] as const;

export type BoardLeaseStatus = typeof boardLeaseStatuses[number];

export interface BoardLeaseBlocker {
  kind: "session" | "job";
  id: string;
  status?: string;
  workerInstanceId?: string;
}

export interface BoardLeaseState {
  status: BoardLeaseStatus;
  leaseId?: string;
  ownerJobId?: string;
  workerInstanceId?: string;
  currentWorkerInstanceId?: string;
  expiresAt?: string;
  invalidatedAt?: string;
  reason?: string;
  blockers?: BoardLeaseBlocker[];
}

export interface BoardLeaseReconciliationBlockers {
  activeJobs?: Array<{ jobId: string; status: string }>;
  openSessions?: Array<{ sessionId: string; workerInstanceId?: string }>;
}

export interface BoardLeaseReconciliationResult extends BoardLeaseState {
  action: "UNCHANGED" | "RECLAIMED_STALE" | "BLOCKED" | "RELEASED_EXPIRED" | "CLEARED_STALE_REFERENCE";
}

export interface BoardRegistration {
  boardId: string;
  probeSerial: string;
  device: string;
  ccxmlPath: string;
  tags: string[];
}

export interface BoardRecord extends BoardRegistration {
  status: BoardStatus;
  currentWorkerInstanceId?: string;
  currentLeaseId?: string;
  targetIdentity: BoardTargetIdentity;
  lastHeartbeatAt?: string;
  lastSeenAt?: string;
  lastError?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/**
 * Host-side identity evidence for the image currently believed to be on the
 * physical target.  UNKNOWN is deliberate: a new lease, worker restart, or
 * external target access invalidates the previous belief until MCP performs a
 * controlled program load or a manifest-bound resident-image verification
 * again under the current lease.
 */
export interface BoardTargetIdentity {
  status: "UNKNOWN" | "KNOWN";
  generation: number;
  updatedAt: string;
  reason?: string;
  programs: Record<string, TargetProgramIdentity>;
}

export interface TargetProgramIdentity {
  coreId: number;
  programUri: string;
  sha256: string;
  loadedAt: string;
}

export interface TargetProgramMutation {
  coreId: number;
  programUri: string;
  sha256: string;
}

export interface BoardLease {
  leaseId: string;
  boardId: string;
  probeSerial: string;
  ownerJobId?: string;
  workerInstanceId?: string;
  acquiredAt: string;
  expiresAt: string;
  renewedAt: string;
  releasedAt?: string;
  fencingToken: number;
  leaseGeneration: number;
  lastValidatedAt?: string;
  invalidatedAt?: string;
  invalidationReason?: string;
}

export interface BoardLeaseContext {
  leaseId: string;
  leaseToken: string;
  fencingToken: number;
  leaseGeneration: number;
  ownerJobId: string;
  boardId: string;
  probeSerial: string;
  workerInstanceId: string;
}
