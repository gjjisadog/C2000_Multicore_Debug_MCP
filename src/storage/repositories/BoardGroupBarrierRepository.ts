import { randomUUID } from "node:crypto";
import { DebugMcpError } from "../../utils/errors.js";
import { SqliteStore } from "../SqliteStore.js";

export const boardGroupBarrierNames = [
  "ALL_RESERVED",
  "ALL_WORKERS_READY",
  "ALL_CONNECTED",
  "ALL_HALTED",
  "ALL_LOADED",
  "ALL_SAFETY_READY",
  "ALL_CONFIGURED",
  "ALL_ARMED",
  "ALL_RUNNING",
  "ALL_CAN_READY",
  "ALL_TEST_COMPLETE",
  "ALL_EVIDENCE_COLLECTED",
  "ALL_CLEANED_UP"
] as const;

export type BoardGroupBarrierName = (typeof boardGroupBarrierNames)[number];
export type BoardGroupBarrierStatus = "PENDING" | "WAITING" | "SATISFIED" | "TIMED_OUT" | "FAILED" | "CANCELLED";

export interface BoardGroupBarrierRecord {
  barrierId: string;
  groupId: string;
  jobId: string;
  name: BoardGroupBarrierName;
  index: number;
  status: BoardGroupBarrierStatus;
  expectedMembers: string[];
  arrivedMembers: Record<string, Record<string, unknown>>;
  details: Record<string, unknown>;
  startedAt: string;
  deadlineAt?: string;
  satisfiedAt?: string;
  error?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/**
 * SQLite-backed group barriers. Waiting is deliberately implemented by the
 * caller; this repository only records transitions, which makes arrivals and
 * timeouts observable/recoverable across daemon lifetime changes.
 */
export class BoardGroupBarrierRepository {
  constructor(private readonly store: SqliteStore) {}

  begin(input: { groupId: string; jobId: string; name: BoardGroupBarrierName; expectedMembers: readonly string[]; timeoutMs: number; index?: number; details?: Record<string, unknown> }): BoardGroupBarrierRecord {
    if (input.expectedMembers.length === 0 || new Set(input.expectedMembers).size !== input.expectedMembers.length) {
      throw new DebugMcpError("BoardGroupBarrierInvalid", "A board-group barrier requires unique expected members", { expectedMembers: input.expectedMembers });
    }
    return this.store.transaction(() => {
      // Concurrent members must rendezvous on one in-progress named barrier.
      // A new index is reserved only after the prior barrier has finished, or
      // when a campaign explicitly asks for a specific iteration index.
      if (input.index === undefined) {
        const active = this.latest(input.groupId, input.name);
        if (active && (active.status === "PENDING" || active.status === "WAITING")) return active;
      }
      const index = input.index ?? this.nextIndex(input.groupId, input.name);
      const existing = this.find(input.groupId, input.name, index);
      if (existing) return existing;
      const now = new Date().toISOString();
      const deadlineAt = new Date(Date.now() + input.timeoutMs).toISOString();
      const barrierId = `barrier-${randomUUID()}`;
      this.store.run(
        `INSERT INTO board_group_barriers(barrier_id, group_id, job_id, barrier_name, barrier_index, status,
          expected_members_json, arrived_members_json, details_json, started_at, deadline_at, satisfied_at,
          error_json, created_at, updated_at)
         VALUES(?, ?, ?, ?, ?, 'PENDING', ?, '{}', ?, ?, ?, NULL, NULL, ?, ?)`,
        [barrierId, input.groupId, input.jobId, input.name, index, JSON.stringify(input.expectedMembers), JSON.stringify(input.details ?? {}), now, deadlineAt, now, now]
      );
      return this.require(barrierId);
    });
  }

  arrive(input: { barrierId: string; boardId: string; details?: Record<string, unknown> }): BoardGroupBarrierRecord {
    return this.store.transaction(() => {
      const current = this.require(input.barrierId);
      if (current.status === "SATISFIED") return current;
      if (["TIMED_OUT", "FAILED", "CANCELLED"].includes(current.status)) return current;
      if (!current.expectedMembers.includes(input.boardId)) {
        throw new DebugMcpError("BoardGroupBarrierInvalid", "Board is not expected by the barrier", { barrierId: current.barrierId, boardId: input.boardId, expectedMembers: current.expectedMembers });
      }
      const now = new Date().toISOString();
      if (current.deadlineAt && Date.parse(current.deadlineAt) < Date.now()) return this.timeoutInternal(current, now);
      const arrivedMembers = { ...current.arrivedMembers, [input.boardId]: input.details ?? {} };
      const satisfied = current.expectedMembers.every(boardId => Object.prototype.hasOwnProperty.call(arrivedMembers, boardId));
      const status: BoardGroupBarrierStatus = satisfied ? "SATISFIED" : "WAITING";
      this.store.run(
        "UPDATE board_group_barriers SET status = ?, arrived_members_json = ?, satisfied_at = ?, updated_at = ? WHERE barrier_id = ?",
        [status, JSON.stringify(arrivedMembers), satisfied ? now : null, now, current.barrierId]
      );
      return this.require(current.barrierId);
    });
  }

  timeoutIfExpired(barrierId: string): BoardGroupBarrierRecord {
    return this.store.transaction(() => {
      const current = this.require(barrierId);
      if (["SATISFIED", "TIMED_OUT", "FAILED", "CANCELLED"].includes(current.status)) return current;
      if (current.deadlineAt && Date.parse(current.deadlineAt) <= Date.now()) return this.timeoutInternal(current, new Date().toISOString());
      return current;
    });
  }

  fail(barrierId: string, error: Record<string, unknown>): BoardGroupBarrierRecord {
    return this.finish(barrierId, "FAILED", error);
  }

  cancel(barrierId: string, reason: string): BoardGroupBarrierRecord {
    return this.finish(barrierId, "CANCELLED", { code: "BoardGroupBarrierCancelled", reason });
  }

  latest(groupId: string, name?: BoardGroupBarrierName): BoardGroupBarrierRecord | undefined {
    const row = this.store.get<{ barrier_id: string }>(
      `SELECT barrier_id FROM board_group_barriers WHERE group_id = ?${name ? " AND barrier_name = ?" : ""} ORDER BY barrier_index DESC, created_at DESC LIMIT 1`,
      name ? [groupId, name] : [groupId]
    );
    return row ? this.require(row.barrier_id) : undefined;
  }

  list(groupId: string): BoardGroupBarrierRecord[] {
    return this.store.all<{ barrier_id: string }>("SELECT barrier_id FROM board_group_barriers WHERE group_id = ? ORDER BY created_at, barrier_index", [groupId]).map(row => this.require(row.barrier_id));
  }

  require(barrierId: string): BoardGroupBarrierRecord {
    const row = this.store.get<Record<string, unknown>>("SELECT * FROM board_group_barriers WHERE barrier_id = ?", [barrierId]);
    if (!row) throw new DebugMcpError("SessionNotFound", `Board-group barrier not found: ${barrierId}`, { barrierId });
    return mapBarrier(row);
  }

  private finish(barrierId: string, status: Extract<BoardGroupBarrierStatus, "FAILED" | "CANCELLED">, error: Record<string, unknown>): BoardGroupBarrierRecord {
    return this.store.transaction(() => {
      const current = this.require(barrierId);
      if (["SATISFIED", "TIMED_OUT", "FAILED", "CANCELLED"].includes(current.status)) return current;
      const now = new Date().toISOString();
      this.store.run("UPDATE board_group_barriers SET status = ?, error_json = ?, updated_at = ? WHERE barrier_id = ?", [status, JSON.stringify(error), now, barrierId]);
      return this.require(barrierId);
    });
  }

  private timeoutInternal(current: BoardGroupBarrierRecord, now: string): BoardGroupBarrierRecord {
    const error = {
      code: "BoardGroupBarrierTimeout",
      expectedMembers: current.expectedMembers,
      arrivedMembers: Object.keys(current.arrivedMembers),
      deadlineAt: current.deadlineAt
    };
    this.store.run("UPDATE board_group_barriers SET status = 'TIMED_OUT', error_json = ?, updated_at = ? WHERE barrier_id = ?", [JSON.stringify(error), now, current.barrierId]);
    return this.require(current.barrierId);
  }

  private find(groupId: string, name: BoardGroupBarrierName, index: number): BoardGroupBarrierRecord | undefined {
    const row = this.store.get<{ barrier_id: string }>("SELECT barrier_id FROM board_group_barriers WHERE group_id = ? AND barrier_name = ? AND barrier_index = ?", [groupId, name, index]);
    return row ? this.require(row.barrier_id) : undefined;
  }

  private nextIndex(groupId: string, name: BoardGroupBarrierName): number {
    return Number(this.store.get<{ next_index: number }>("SELECT COALESCE(MAX(barrier_index), -1) + 1 AS next_index FROM board_group_barriers WHERE group_id = ? AND barrier_name = ?", [groupId, name])?.next_index ?? 0);
  }
}

function mapBarrier(row: Record<string, unknown>): BoardGroupBarrierRecord {
  return {
    barrierId: String(row.barrier_id), groupId: String(row.group_id), jobId: String(row.job_id), name: String(row.barrier_name) as BoardGroupBarrierName,
    index: Number(row.barrier_index), status: String(row.status) as BoardGroupBarrierStatus,
    expectedMembers: parseJson(String(row.expected_members_json), []), arrivedMembers: parseJson(String(row.arrived_members_json), {}),
    details: parseJson(String(row.details_json), {}), startedAt: String(row.started_at),
    ...(row.deadline_at ? { deadlineAt: String(row.deadline_at) } : {}), ...(row.satisfied_at ? { satisfiedAt: String(row.satisfied_at) } : {}),
    ...(row.error_json ? { error: parseJson(String(row.error_json), {}) } : {}), createdAt: String(row.created_at), updatedAt: String(row.updated_at)
  };
}

function parseJson<T>(value: string, fallback: T): T { try { return JSON.parse(value) as T; } catch { return fallback; } }
