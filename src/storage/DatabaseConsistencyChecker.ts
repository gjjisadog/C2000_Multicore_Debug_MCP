import { SqliteStore } from "./SqliteStore.js";

export interface ConsistencyIssue {
  code: string;
  entity: string;
  details: Record<string, unknown>;
}

export interface DatabaseConsistencyReport {
  healthy: boolean;
  checkedAt: string;
  issues: ConsistencyIssue[];
}

/** Read-only invariant checker. It deliberately reports rather than "repairing" uncertain ownership state. */
export class DatabaseConsistencyChecker {
  constructor(private readonly store: SqliteStore) {}

  check(): DatabaseConsistencyReport {
    const issues: ConsistencyIssue[] = [];
    for (const row of this.store.all<Record<string, unknown>>(`
      SELECT b.board_id, b.current_worker_instance_id
      FROM boards b LEFT JOIN workers w ON w.worker_instance_id = b.current_worker_instance_id AND w.board_id = b.board_id
      WHERE b.current_worker_instance_id IS NOT NULL AND w.worker_instance_id IS NULL
    `)) issues.push({ code: "BOARD_WORKER_REFERENCE_STALE", entity: String(row.board_id), details: { workerInstanceId: row.current_worker_instance_id } });
    for (const row of this.store.all<Record<string, unknown>>(`
      SELECT b.board_id, b.current_lease_id
      FROM boards b LEFT JOIN board_leases l ON l.lease_id = b.current_lease_id AND l.released_at IS NULL
      WHERE b.current_lease_id IS NOT NULL AND l.lease_id IS NULL
    `)) issues.push({ code: "BOARD_LEASE_REFERENCE_STALE", entity: String(row.board_id), details: { leaseId: row.current_lease_id } });
    for (const row of this.store.all<Record<string, unknown>>(`
      SELECT s.session_id, s.board_id FROM debug_sessions s LEFT JOIN boards b ON b.board_id = s.board_id WHERE b.board_id IS NULL
    `)) issues.push({ code: "SESSION_BOARD_MISSING", entity: String(row.session_id), details: { boardId: row.board_id } });
    for (const row of this.store.all<Record<string, unknown>>(`
      SELECT r.job_id, r.progress_current, r.progress_total
      FROM test_runs r
      WHERE r.progress_current > r.progress_total OR r.progress_current < 0 OR r.progress_total < 0
    `)) issues.push({ code: "JOB_PROGRESS_INVALID", entity: String(row.job_id), details: { current: row.progress_current, total: row.progress_total } });
    for (const row of this.store.all<Record<string, unknown>>(`
      SELECT g.group_id, COUNT(m.board_id) AS members FROM board_groups g LEFT JOIN board_group_members m ON m.group_id = g.group_id
      WHERE g.group_type = 'CAN_PAIR' GROUP BY g.group_id HAVING COUNT(m.board_id) <> 2
    `)) issues.push({ code: "CAN_GROUP_MEMBER_COUNT_INVALID", entity: String(row.group_id), details: { members: Number(row.members) } });
    return { healthy: issues.length === 0, checkedAt: new Date().toISOString(), issues };
  }
}
