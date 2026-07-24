import { DebugMcpError } from "../../utils/errors.js";
import { SqliteStore } from "../SqliteStore.js";

export type BoardGroupType = "CAN_PAIR" | "CAN_BUS";
export type BoardGroupStatus =
  | "ALLOCATING"
  | "STARTING"
  | "LOADED"
  | "ARMED"
  | "RUNNING"
  | "CAN_READY"
  | "TESTING"
  | "RECOVERING"
  | "PASSED"
  | "FAILED"
  | "PARTIAL"
  | "CANCELLING"
  | "CANCELLED"
  | "QUARANTINED";

export type BoardGroupMemberStatus = "PENDING" | "RESERVED" | "STARTING" | "LOADED" | "ARMED" | "RUNNING" | "CAN_READY" | "TESTING" | "RECOVERING" | "PASSED" | "FAILED" | "CANCELLED" | "QUARANTINED";

export interface BoardGroupMember {
  boardId: string;
  role: string;
  index: number;
  probeSerial?: string;
  nodeId?: number;
  channel?: string;
  workerInstanceId?: string;
  sessionId?: string;
  status: BoardGroupMemberStatus;
  leaseId?: string;
  heartbeatSnapshot: Record<string, unknown>;
  lastHeartbeatAt?: string;
  error?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

export interface BoardGroupRecord {
  groupId: string;
  groupType: BoardGroupType;
  name: string;
  jobId?: string;
  profileId?: string;
  profileVersion?: number;
  profileHash?: string;
  busId?: string;
  status: BoardGroupStatus;
  topology: Record<string, unknown>;
  currentBarrier?: string;
  failurePolicy: Record<string, unknown>;
  metadata: Record<string, unknown>;
  error?: Record<string, unknown>;
  statusReason?: string;
  members: BoardGroupMember[];
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface CreateCanGroupInput {
  groupId: string;
  jobId: string;
  name: string;
  boardIds: readonly [string, string];
  members?: readonly Omit<BoardGroupMember, "index" | "status" | "heartbeatSnapshot">[];
  busId?: string;
  topology?: Record<string, unknown>;
  profile?: { id?: string; version?: number; hash?: string };
  failurePolicy?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

const terminalStatuses = new Set<BoardGroupStatus>(["PASSED", "FAILED", "PARTIAL", "CANCELLED", "QUARANTINED"]);
const transitionTargets: Record<BoardGroupStatus, readonly BoardGroupStatus[]> = {
  ALLOCATING: ["STARTING", "FAILED", "CANCELLING", "CANCELLED", "QUARANTINED"],
  STARTING: ["LOADED", "FAILED", "CANCELLING", "RECOVERING", "QUARANTINED"],
  LOADED: ["ARMED", "FAILED", "CANCELLING", "RECOVERING", "QUARANTINED"],
  ARMED: ["RUNNING", "FAILED", "CANCELLING", "RECOVERING", "QUARANTINED"],
  RUNNING: ["CAN_READY", "TESTING", "FAILED", "CANCELLING", "RECOVERING", "QUARANTINED"],
  CAN_READY: ["TESTING", "FAILED", "CANCELLING", "RECOVERING", "QUARANTINED"],
  TESTING: ["PASSED", "FAILED", "PARTIAL", "CANCELLING", "RECOVERING", "QUARANTINED"],
  RECOVERING: ["STARTING", "FAILED", "PARTIAL", "CANCELLING", "QUARANTINED"],
  PASSED: [],
  FAILED: ["RECOVERING", "QUARANTINED"],
  PARTIAL: ["RECOVERING", "QUARANTINED"],
  CANCELLING: ["CANCELLED", "FAILED", "QUARANTINED"],
  CANCELLED: [],
  QUARANTINED: []
};

/** Durable physical topology and execution state. No method controls target power or CAN hardware. */
export class BoardGroupRepository {
  constructor(private readonly store: SqliteStore) {}

  createCanGroup(input: CreateCanGroupInput): BoardGroupRecord {
    const [firstBoardId, secondBoardId] = input.boardIds;
    if (firstBoardId === secondBoardId) throw new DebugMcpError("CanProfileInvalid", "A CAN group requires two distinct boards");
    const suppliedMembers = input.members ?? [
      { boardId: firstBoardId, role: "PRIMARY" },
      { boardId: secondBoardId, role: "SECONDARY" }
    ];
    if (suppliedMembers.length !== 2 || new Set(suppliedMembers.map(member => member.boardId)).size !== 2) {
      throw new DebugMcpError("CanProfileInvalid", "A CAN group requires exactly two unique member boards");
    }
    const now = new Date().toISOString();
    this.store.transaction(() => {
      this.assertBoardsNotInStatefulGroup(suppliedMembers.map(member => member.boardId));
      this.store.run(
        `INSERT INTO board_groups(group_id, group_type, name, status, metadata_json, created_at, updated_at,
          job_id, profile_id, profile_version, profile_hash, bus_id, topology_json, current_barrier,
          failure_policy_json, started_at, finished_at, error_json, status_reason)
         VALUES(?, 'CAN_PAIR', ?, 'ALLOCATING', ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, NULL, NULL)`,
        [
          input.groupId, input.name, JSON.stringify(input.metadata ?? {}), now, now, input.jobId,
          input.profile?.id ?? null, input.profile?.version ?? null, input.profile?.hash ?? null, input.busId ?? null,
          JSON.stringify(input.topology ?? {}), JSON.stringify(input.failurePolicy ?? {})
        ]
      );
      suppliedMembers.forEach((member, index) => {
        this.store.run(
          `INSERT INTO board_group_members(group_id, board_id, member_role, member_index, probe_serial, node_id, channel,
            worker_instance_id, session_id, status, lease_id, heartbeat_snapshot_json, last_heartbeat_at,
            error_json, created_at, updated_at)
           VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, '{}', NULL, NULL, ?, ?)`,
          [input.groupId, member.boardId, member.role, index, member.probeSerial ?? null, member.nodeId ?? null, member.channel ?? null,
            member.workerInstanceId ?? null, member.sessionId ?? null, member.leaseId ?? null, now, now]
        );
      });
    });
    return this.require(input.groupId);
  }

  /** Compatibility wrapper for v2 callers; new callers should include job/profile topology via createCanGroup. */
  createCanPair(input: { groupId: string; name: string; boardIds: readonly [string, string]; metadata?: Record<string, unknown> }): BoardGroupRecord {
    return this.createCanGroup({ groupId: input.groupId, jobId: String(input.metadata?.jobId ?? input.groupId), name: input.name, boardIds: input.boardIds, metadata: input.metadata });
  }

  require(groupId: string): BoardGroupRecord {
    const group = this.store.get<Record<string, unknown>>("SELECT * FROM board_groups WHERE group_id = ?", [groupId]);
    if (!group) throw new DebugMcpError("SessionNotFound", `Board group not found: ${groupId}`, { groupId });
    const members = this.store.all<Record<string, unknown>>("SELECT * FROM board_group_members WHERE group_id = ? ORDER BY member_index", [groupId]);
    return {
      groupId: String(group.group_id),
      groupType: String(group.group_type) as BoardGroupType,
      name: String(group.name),
      ...(group.job_id ? { jobId: String(group.job_id) } : {}),
      ...(group.profile_id ? { profileId: String(group.profile_id) } : {}),
      ...(group.profile_version !== null && group.profile_version !== undefined ? { profileVersion: Number(group.profile_version) } : {}),
      ...(group.profile_hash ? { profileHash: String(group.profile_hash) } : {}),
      ...(group.bus_id ? { busId: String(group.bus_id) } : {}),
      status: normalizeGroupStatus(String(group.status)),
      topology: parseJson(String(group.topology_json ?? "{}"), {}),
      ...(group.current_barrier ? { currentBarrier: String(group.current_barrier) } : {}),
      failurePolicy: parseJson(String(group.failure_policy_json ?? "{}"), {}),
      metadata: parseJson(String(group.metadata_json), {}),
      ...(group.error_json ? { error: parseJson(String(group.error_json), {}) } : {}),
      ...(group.status_reason ? { statusReason: String(group.status_reason) } : {}),
      members: members.map(mapMember),
      createdAt: String(group.created_at),
      updatedAt: String(group.updated_at),
      ...(group.started_at ? { startedAt: String(group.started_at) } : {}),
      ...(group.finished_at ? { finishedAt: String(group.finished_at) } : {})
    };
  }

  getByJob(jobId: string): BoardGroupRecord | undefined {
    const row = this.store.get<{ group_id: string }>("SELECT group_id FROM board_groups WHERE job_id = ? ORDER BY created_at DESC LIMIT 1", [jobId]);
    return row ? this.require(row.group_id) : undefined;
  }

  transition(groupId: string, next: BoardGroupStatus, input: { reason?: string; error?: Record<string, unknown>; currentBarrier?: string } = {}): BoardGroupRecord {
    return this.store.transaction(() => {
      const current = this.require(groupId);
      if (current.status !== next && !transitionTargets[current.status].includes(next)) {
        throw new DebugMcpError("BoardGroupInvalidTransition", `Cannot transition board group ${groupId} from ${current.status} to ${next}`, { groupId, current: current.status, next });
      }
      const now = new Date().toISOString();
      const startedAt = current.startedAt ?? (next === "STARTING" ? now : undefined);
      const finishedAt = terminalStatuses.has(next) ? now : current.finishedAt;
      this.store.run(
        `UPDATE board_groups SET status = ?, current_barrier = ?, status_reason = ?, error_json = ?,
          started_at = ?, finished_at = ?, updated_at = ? WHERE group_id = ?`,
        [next, input.currentBarrier ?? current.currentBarrier ?? null, input.reason ?? current.statusReason ?? null,
          input.error ? JSON.stringify(input.error) : current.error ? JSON.stringify(current.error) : null,
          startedAt ?? null, finishedAt ?? null, now, groupId]
      );
      return this.require(groupId);
    });
  }

  /** Compatibility for existing callers. New code should use transition so illegal lifecycle jumps fail closed. */
  setStatus(groupId: string, status: BoardGroupStatus): void { this.transition(groupId, status); }

  setCurrentBarrier(groupId: string, barrierName?: string): void {
    this.store.run("UPDATE board_groups SET current_barrier = ?, updated_at = ? WHERE group_id = ?", [barrierName ?? null, new Date().toISOString(), groupId]);
  }

  updateMember(groupId: string, boardId: string, patch: Partial<Omit<BoardGroupMember, "boardId" | "role" | "index" | "createdAt" | "updatedAt">>): BoardGroupMember {
    return this.store.transaction(() => {
      const current = this.requireMember(groupId, boardId);
      const now = new Date().toISOString();
      this.store.run(
        `UPDATE board_group_members SET probe_serial = ?, node_id = ?, channel = ?, worker_instance_id = ?, session_id = ?,
          status = ?, lease_id = ?, heartbeat_snapshot_json = ?, last_heartbeat_at = ?, error_json = ?, updated_at = ?
         WHERE group_id = ? AND board_id = ?`,
        [patch.probeSerial ?? current.probeSerial ?? null, patch.nodeId ?? current.nodeId ?? null, patch.channel ?? current.channel ?? null,
          patch.workerInstanceId ?? current.workerInstanceId ?? null, patch.sessionId ?? current.sessionId ?? null,
          patch.status ?? current.status, patch.leaseId ?? current.leaseId ?? null,
          JSON.stringify(patch.heartbeatSnapshot ?? current.heartbeatSnapshot), patch.lastHeartbeatAt ?? current.lastHeartbeatAt ?? null,
          patch.error ? JSON.stringify(patch.error) : current.error ? JSON.stringify(current.error) : null, now, groupId, boardId]
      );
      return this.requireMember(groupId, boardId);
    });
  }

  list(): BoardGroupRecord[] {
    return this.store.all<{ group_id: string }>("SELECT group_id FROM board_groups ORDER BY created_at DESC").map(group => this.require(group.group_id));
  }

  listByStatus(statuses: readonly BoardGroupStatus[]): BoardGroupRecord[] {
    if (statuses.length === 0) return [];
    const placeholders = statuses.map(() => "?").join(", ");
    return this.store.all<{ group_id: string }>(`SELECT group_id FROM board_groups WHERE status IN (${placeholders}) ORDER BY created_at DESC`, [...statuses])
      .map(group => this.require(group.group_id));
  }

  isTerminal(status: BoardGroupStatus): boolean { return terminalStatuses.has(status); }

  private requireMember(groupId: string, boardId: string): BoardGroupMember {
    const row = this.store.get<Record<string, unknown>>("SELECT * FROM board_group_members WHERE group_id = ? AND board_id = ?", [groupId, boardId]);
    if (!row) throw new DebugMcpError("SessionNotFound", `Board ${boardId} is not in board group ${groupId}`, { groupId, boardId });
    return mapMember(row);
  }

  private assertBoardsNotInStatefulGroup(boardIds: readonly string[]): void {
    const placeholders = boardIds.map(() => "?").join(", ");
    const terminal = [...terminalStatuses].map(() => "?").join(", ");
    const conflicts = this.store.all<{ group_id: string; board_id: string; status: string }>(
      `SELECT g.group_id, m.board_id, g.status FROM board_groups g JOIN board_group_members m ON m.group_id = g.group_id
       WHERE m.board_id IN (${placeholders}) AND g.status NOT IN (${terminal})`,
      [...boardIds, ...terminalStatuses]
    );
    if (conflicts.length > 0) {
      throw new DebugMcpError("BoardGroupBusy", "A board is already participating in a stateful board group", { conflicts });
    }
  }
}

function mapMember(member: Record<string, unknown>): BoardGroupMember {
  return {
    boardId: String(member.board_id), role: String(member.member_role), index: Number(member.member_index),
    ...(member.probe_serial ? { probeSerial: String(member.probe_serial) } : {}),
    ...(member.node_id !== null && member.node_id !== undefined ? { nodeId: Number(member.node_id) } : {}),
    ...(member.channel ? { channel: String(member.channel) } : {}),
    ...(member.worker_instance_id ? { workerInstanceId: String(member.worker_instance_id) } : {}),
    ...(member.session_id ? { sessionId: String(member.session_id) } : {}),
    status: String(member.status ?? "PENDING") as BoardGroupMemberStatus,
    ...(member.lease_id ? { leaseId: String(member.lease_id) } : {}),
    heartbeatSnapshot: parseJson(String(member.heartbeat_snapshot_json ?? "{}"), {}),
    ...(member.last_heartbeat_at ? { lastHeartbeatAt: String(member.last_heartbeat_at) } : {}),
    ...(member.error_json ? { error: parseJson(String(member.error_json), {}) } : {}),
    ...(member.created_at ? { createdAt: String(member.created_at) } : {}),
    ...(member.updated_at ? { updatedAt: String(member.updated_at) } : {})
  };
}

function normalizeGroupStatus(status: string): BoardGroupStatus {
  // `READY` is only a historical v2 state. It means setup finished but the
  // group was not testing, which maps most closely to the explicit v3 LOADED state.
  return (status === "READY" ? "LOADED" : status) as BoardGroupStatus;
}

function parseJson<T>(value: string, fallback: T): T {
  try { return JSON.parse(value) as T; } catch { return fallback; }
}
