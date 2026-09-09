import type { BoardLease } from "../../boards/types.js";
import { SqliteStore } from "../SqliteStore.js";

interface LeaseRow {
  lease_id: string;
  board_id: string;
  probe_serial: string;
  owner_job_id: string | null;
  worker_instance_id: string | null;
  acquired_at: string;
  expires_at: string;
  renewed_at: string;
  released_at: string | null;
  lease_token_hash: string;
  fencing_token: number;
  lease_generation: number;
  last_validated_at: string | null;
  invalidated_at: string | null;
  invalidation_reason: string | null;
}

export class LeaseRepository {
  constructor(private readonly store: SqliteStore) {}

  activeForBoard(boardId: string): (BoardLease & { leaseTokenHash: string }) | undefined {
    const row = this.store.get<LeaseRow>("SELECT * FROM board_leases WHERE board_id = ? AND released_at IS NULL AND invalidated_at IS NULL ORDER BY fencing_token DESC LIMIT 1", [boardId]);
    return row ? mapLease(row) : undefined;
  }

  /**
   * Return every unreleased generation, including invalidated generations.
   * Invalidated rows are no longer active, but they still need terminal
   * release bookkeeping so recovery cannot leave `released_at` NULL forever.
   */
  unreleasedForBoard(boardId: string): Array<BoardLease & { leaseTokenHash: string }> {
    return this.store
      .all<LeaseRow>("SELECT * FROM board_leases WHERE board_id = ? AND released_at IS NULL ORDER BY fencing_token DESC", [boardId])
      .map(mapLease);
  }

  activeForBoardByLeaseId(leaseId: string): (BoardLease & { leaseTokenHash: string }) | undefined {
    const row = this.store.get<LeaseRow>("SELECT * FROM board_leases WHERE lease_id = ? AND released_at IS NULL AND invalidated_at IS NULL", [leaseId]);
    return row ? mapLease(row) : undefined;
  }

  insert(lease: BoardLease, tokenHash: string): void {
    this.store.run("INSERT INTO board_leases(lease_id, board_id, probe_serial, owner_job_id, worker_instance_id, acquired_at, expires_at, renewed_at, released_at, lease_token_hash, fencing_token, lease_generation, last_validated_at, invalidated_at, invalidation_reason) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [lease.leaseId, lease.boardId, lease.probeSerial, lease.ownerJobId ?? null, lease.workerInstanceId ?? null, lease.acquiredAt, lease.expiresAt, lease.renewedAt, lease.releasedAt ?? null, tokenHash, lease.fencingToken, lease.leaseGeneration, lease.lastValidatedAt ?? null, lease.invalidatedAt ?? null, lease.invalidationReason ?? null]);
  }

  latestFencingToken(boardId: string): number {
    return Number(this.store.get<{ token: number }>("SELECT COALESCE(MAX(fencing_token), 0) AS token FROM board_leases WHERE board_id = ?", [boardId])?.token ?? 0);
  }

  validate(leaseId: string, validatedAt: string): void {
    this.store.run("UPDATE board_leases SET last_validated_at = ? WHERE lease_id = ? AND released_at IS NULL AND invalidated_at IS NULL", [validatedAt, leaseId]);
  }

  invalidate(leaseId: string, invalidatedAt: string, reason: string): void {
    // Invalidating a lease fences it immediately; releasing it in the same
    // transaction makes the lifecycle terminal and prevents stale rows from
    // remaining apparently owned forever after worker/session recovery.
    this.store.run("UPDATE board_leases SET invalidated_at = ?, invalidation_reason = ?, released_at = COALESCE(released_at, ?) WHERE lease_id = ? AND invalidated_at IS NULL", [invalidatedAt, reason, invalidatedAt, leaseId]);
  }

  renew(leaseId: string, expiresAt: string, renewedAt: string): void {
    this.store.run("UPDATE board_leases SET expires_at = ?, renewed_at = ? WHERE lease_id = ? AND released_at IS NULL", [expiresAt, renewedAt, leaseId]);
  }

  release(leaseId: string, releasedAt: string): void {
    this.store.run("UPDATE board_leases SET released_at = ? WHERE lease_id = ? AND released_at IS NULL", [releasedAt, leaseId]);
  }
}

function mapLease(row: LeaseRow): BoardLease & { leaseTokenHash: string } {
  return {
    leaseId: row.lease_id,
    boardId: row.board_id,
    probeSerial: row.probe_serial,
    ...(row.owner_job_id ? { ownerJobId: row.owner_job_id } : {}),
    ...(row.worker_instance_id ? { workerInstanceId: row.worker_instance_id } : {}),
    acquiredAt: row.acquired_at,
    expiresAt: row.expires_at,
    renewedAt: row.renewed_at,
    ...(row.released_at ? { releasedAt: row.released_at } : {}),
    fencingToken: row.fencing_token,
    leaseGeneration: row.lease_generation,
    ...(row.last_validated_at ? { lastValidatedAt: row.last_validated_at } : {}),
    ...(row.invalidated_at ? { invalidatedAt: row.invalidated_at } : {}),
    ...(row.invalidation_reason ? { invalidationReason: row.invalidation_reason } : {}),
    leaseTokenHash: row.lease_token_hash
  };
}
