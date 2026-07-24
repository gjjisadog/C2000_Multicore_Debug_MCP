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
}

export class LeaseRepository {
  constructor(private readonly store: SqliteStore) {}

  activeForBoard(boardId: string): (BoardLease & { leaseTokenHash: string }) | undefined {
    const row = this.store.get<LeaseRow>("SELECT * FROM board_leases WHERE board_id = ? AND released_at IS NULL ORDER BY acquired_at DESC LIMIT 1", [boardId]);
    return row ? mapLease(row) : undefined;
  }

  activeForBoardByLeaseId(leaseId: string): (BoardLease & { leaseTokenHash: string }) | undefined {
    const row = this.store.get<LeaseRow>("SELECT * FROM board_leases WHERE lease_id = ? AND released_at IS NULL", [leaseId]);
    return row ? mapLease(row) : undefined;
  }

  insert(lease: BoardLease, tokenHash: string): void {
    this.store.run("INSERT INTO board_leases(lease_id, board_id, probe_serial, owner_job_id, worker_instance_id, acquired_at, expires_at, renewed_at, released_at, lease_token_hash) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [lease.leaseId, lease.boardId, lease.probeSerial, lease.ownerJobId ?? null, lease.workerInstanceId ?? null, lease.acquiredAt, lease.expiresAt, lease.renewedAt, lease.releasedAt ?? null, tokenHash]);
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
    leaseTokenHash: row.lease_token_hash
  };
}
