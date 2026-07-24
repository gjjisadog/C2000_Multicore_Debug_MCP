import { SqliteStore } from "../SqliteStore.js";

export type BoardGroupType = "CAN_PAIR";
export type BoardGroupStatus = "READY" | "RUNNING" | "FAILED" | "QUARANTINED";

export interface BoardGroupMember {
  boardId: string;
  role: "A" | "B";
  index: number;
}

export interface BoardGroupRecord {
  groupId: string;
  groupType: BoardGroupType;
  name: string;
  status: BoardGroupStatus;
  metadata: Record<string, unknown>;
  members: BoardGroupMember[];
  createdAt: string;
  updatedAt: string;
}

export class BoardGroupRepository {
  constructor(private readonly store: SqliteStore) {}

  createCanPair(input: {
    groupId: string;
    name: string;
    boardIds: readonly [string, string];
    metadata?: Record<string, unknown>;
  }): BoardGroupRecord {
    if (input.boardIds[0] === input.boardIds[1]) throw new Error("A CAN pair requires two distinct boards");
    const now = new Date().toISOString();
    this.store.transaction(() => {
      this.store.run(
        "INSERT INTO board_groups(group_id, group_type, name, status, metadata_json, created_at, updated_at) VALUES(?, 'CAN_PAIR', ?, 'READY', ?, ?, ?)",
        [input.groupId, input.name, JSON.stringify(input.metadata ?? {}), now, now]
      );
      input.boardIds.forEach((boardId, index) => {
        this.store.run(
          "INSERT INTO board_group_members(group_id, board_id, member_role, member_index) VALUES(?, ?, ?, ?)",
          [input.groupId, boardId, index === 0 ? "A" : "B", index]
        );
      });
    });
    return this.require(input.groupId);
  }

  require(groupId: string): BoardGroupRecord {
    const group = this.store.get<Record<string, unknown>>("SELECT * FROM board_groups WHERE group_id = ?", [groupId]);
    if (!group) throw new Error(`Board group not found: ${groupId}`);
    const members = this.store.all<Record<string, unknown>>("SELECT * FROM board_group_members WHERE group_id = ? ORDER BY member_index", [groupId]);
    return {
      groupId: String(group.group_id),
      groupType: String(group.group_type) as BoardGroupType,
      name: String(group.name),
      status: String(group.status) as BoardGroupStatus,
      metadata: parseJson(String(group.metadata_json), {}),
      members: members.map(member => ({
        boardId: String(member.board_id),
        role: String(member.member_role) as BoardGroupMember["role"],
        index: Number(member.member_index)
      })),
      createdAt: String(group.created_at),
      updatedAt: String(group.updated_at)
    };
  }

  setStatus(groupId: string, status: BoardGroupStatus): void {
    this.store.run("UPDATE board_groups SET status = ?, updated_at = ? WHERE group_id = ?", [status, new Date().toISOString(), groupId]);
  }

  list(): BoardGroupRecord[] {
    return this.store.all<{ group_id: string }>("SELECT group_id FROM board_groups ORDER BY created_at DESC")
      .map(group => this.require(group.group_id));
  }
}

function parseJson<T>(value: string, fallback: T): T {
  try { return JSON.parse(value) as T; } catch { return fallback; }
}
