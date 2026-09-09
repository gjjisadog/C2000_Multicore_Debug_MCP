import type {
  BoardRecord,
  BoardRegistration,
  BoardStatus,
  BoardTargetIdentity,
  TargetProgramMutation
} from "../../boards/types.js";
import { SqliteStore } from "../SqliteStore.js";

interface BoardRow {
  board_id: string;
  probe_serial: string;
  device: string;
  ccxml_path: string;
  status: BoardStatus;
  tags_json: string;
  current_worker_instance_id: string | null;
  current_lease_id: string | null;
  target_generation: number;
  target_identity_json: string | null;
  last_heartbeat_at: string | null;
  last_seen_at: string | null;
  last_error_json: string | null;
  created_at: string;
  updated_at: string;
}

export class BoardRepository {
  constructor(private readonly store: SqliteStore) {}

  upsert(registration: BoardRegistration, status: BoardStatus = "AVAILABLE"): BoardRecord {
    const now = new Date().toISOString();
    this.store.run(`
      INSERT INTO boards(board_id, probe_serial, device, ccxml_path, status, tags_json, created_at, updated_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(board_id) DO UPDATE SET
        probe_serial = excluded.probe_serial,
        device = excluded.device,
        ccxml_path = excluded.ccxml_path,
        tags_json = excluded.tags_json,
        updated_at = excluded.updated_at
    `, [registration.boardId, registration.probeSerial, registration.device, registration.ccxmlPath, status, JSON.stringify(registration.tags), now, now]);
    return this.require(registration.boardId);
  }

  require(boardId: string): BoardRecord {
    const row = this.store.get<BoardRow>("SELECT * FROM boards WHERE board_id = ?", [boardId]);
    if (!row) throw new Error(`Board not found: ${boardId}`);
    return mapBoard(row);
  }

  list(filters: { status?: BoardStatus[]; tags?: string[] } = {}): BoardRecord[] {
    const rows = this.store.all<BoardRow>("SELECT * FROM boards ORDER BY board_id");
    return rows.map(mapBoard).filter(board =>
      (!filters.status || filters.status.includes(board.status)) &&
      (!filters.tags || filters.tags.every(tag => board.tags.includes(tag)))
    );
  }

  setStatus(boardId: string, status: BoardStatus, error?: Record<string, unknown>): BoardRecord {
    const now = new Date().toISOString();
    this.store.run(
      "UPDATE boards SET status = ?, last_error_json = ?, updated_at = ? WHERE board_id = ?",
      [status, error ? JSON.stringify(error) : null, now, boardId]
    );
    return this.require(boardId);
  }

  setLease(boardId: string, leaseId: string | undefined): void {
    this.store.run("UPDATE boards SET current_lease_id = ?, updated_at = ? WHERE board_id = ?", [leaseId ?? null, new Date().toISOString(), boardId]);
  }

  setWorker(boardId: string, workerInstanceId: string | undefined): void {
    this.store.run("UPDATE boards SET current_worker_instance_id = ?, updated_at = ? WHERE board_id = ?", [workerInstanceId ?? null, new Date().toISOString(), boardId]);
  }

  heartbeat(boardId: string, at = new Date().toISOString()): void {
    this.store.run("UPDATE boards SET last_heartbeat_at = ?, last_seen_at = ?, updated_at = ? WHERE board_id = ?", [at, at, at, boardId]);
  }

  /**
   * A new lease or worker generation invalidates resident-image evidence. It
   * is safer to require a fresh controlled load than to assume that an
   * external debugger did not program the target while the board was idle.
   */
  markTargetUnknown(boardId: string, reason: string): BoardRecord {
    const current = this.require(boardId);
    const now = new Date().toISOString();
    const generation = current.targetIdentity.generation + 1;
    const identity: BoardTargetIdentity = {
      status: "UNKNOWN",
      generation,
      updatedAt: now,
      reason,
      programs: {}
    };
    this.store.run(
      "UPDATE boards SET target_generation = ?, target_identity_json = ?, updated_at = ? WHERE board_id = ?",
      [generation, JSON.stringify(identity), now, boardId]
    );
    return this.require(boardId);
  }

  /** Record only images loaded by the MCP; symbol-only loads never call this. */
  recordTargetPrograms(boardId: string, programs: TargetProgramMutation[], reason = "mcp-program-load"): BoardRecord {
    const current = this.require(boardId);
    const now = new Date().toISOString();
    const generation = current.targetIdentity.generation + 1;
    const nextPrograms = { ...current.targetIdentity.programs };
    for (const program of programs) {
      nextPrograms[String(program.coreId)] = {
        coreId: program.coreId,
        programUri: program.programUri,
        sha256: program.sha256,
        loadedAt: now
      };
    }
    const identity: BoardTargetIdentity = {
      status: "KNOWN",
      generation,
      updatedAt: now,
      reason,
      programs: nextPrograms
    };
    this.store.run(
      "UPDATE boards SET target_generation = ?, target_identity_json = ?, updated_at = ? WHERE board_id = ?",
      [generation, JSON.stringify(identity), now, boardId]
    );
    return this.require(boardId);
  }
}

function mapBoard(row: BoardRow): BoardRecord {
  return {
    boardId: row.board_id,
    probeSerial: row.probe_serial,
    device: row.device,
    ccxmlPath: row.ccxml_path,
    status: row.status,
    tags: parseJson<string[]>(row.tags_json, []),
    ...(row.current_worker_instance_id ? { currentWorkerInstanceId: row.current_worker_instance_id } : {}),
    ...(row.current_lease_id ? { currentLeaseId: row.current_lease_id } : {}),
    targetIdentity: parseTargetIdentity(row.target_identity_json, row.target_generation),
    ...(row.last_heartbeat_at ? { lastHeartbeatAt: row.last_heartbeat_at } : {}),
    ...(row.last_seen_at ? { lastSeenAt: row.last_seen_at } : {}),
    ...(row.last_error_json ? { lastError: parseJson<Record<string, unknown>>(row.last_error_json, {}) } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function parseTargetIdentity(value: string | null, generation: number): BoardRecord["targetIdentity"] {
  if (value) {
    try {
      const parsed = JSON.parse(value) as Partial<BoardTargetIdentity>;
      if ((parsed.status === "UNKNOWN" || parsed.status === "KNOWN") &&
          typeof parsed.generation === "number" && Number.isInteger(parsed.generation) &&
          typeof parsed.updatedAt === "string" &&
          parsed.programs && typeof parsed.programs === "object" && !Array.isArray(parsed.programs)) {
        return {
          status: parsed.status,
          generation: parsed.generation,
          updatedAt: parsed.updatedAt,
          ...(typeof parsed.reason === "string" ? { reason: parsed.reason } : {}),
          programs: parsed.programs as BoardRecord["targetIdentity"]["programs"]
        };
      }
    } catch {
      // Fall through to a conservative unknown identity.
    }
  }
  return {
    status: "UNKNOWN",
    generation: Number.isInteger(generation) ? generation : 0,
    updatedAt: new Date(0).toISOString(),
    reason: "target-identity-not-recorded",
    programs: {}
  };
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
