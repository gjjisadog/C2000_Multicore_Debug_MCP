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
  lastHeartbeatAt?: string;
  lastSeenAt?: string;
  lastError?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
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
