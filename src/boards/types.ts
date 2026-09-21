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
 * physical target. UNKNOWN is deliberate only when target-side state may have
 * changed or become ambiguous: a real worker restart, external target access,
 * or a failed/partial target mutation. Control-plane transitions such as a
 * new MCP lease or worker startup do not touch the target and preserve this
 * evidence.
 */
export interface BoardTargetIdentity {
  status: "UNKNOWN" | "KNOWN";
  generation: number;
  updatedAt: string;
  reason?: string;
  programs: Record<string, TargetProgramIdentity>;
  /**
   * The last host-side image evidence is retained when a target-side event
   * invalidates the current identity. It is never treated as proof that the
   * target is unchanged; it only lets an explicit
   * operator-confirmed resident attach reject an obviously different .out
   * pair without forcing a reprogram.
   */
  lastKnownPrograms?: Record<string, TargetProgramIdentity>;
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
