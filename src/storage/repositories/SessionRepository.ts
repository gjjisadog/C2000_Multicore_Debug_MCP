import { SqliteStore } from "../SqliteStore.js";

export interface PersistedSession {
  sessionId: string;
  boardId: string;
  workerInstanceId?: string;
  sessionName: string;
  adapterSessionId?: string;
  ccxmlPath?: string;
  coreMap: unknown[];
  status: string;
  createdAt: string;
  closedAt?: string;
  lastSnapshot?: Record<string, unknown>;
}

export class SessionRepository {
  constructor(private readonly store: SqliteStore) {}

  upsert(session: PersistedSession): void {
    this.store.run(`
      INSERT INTO debug_sessions(session_id, board_id, worker_instance_id, session_name, adapter_session_id, ccxml_path, core_map_json, status, created_at, closed_at, last_snapshot_json)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        worker_instance_id = excluded.worker_instance_id,
        adapter_session_id = excluded.adapter_session_id,
        status = excluded.status,
        closed_at = excluded.closed_at,
        last_snapshot_json = excluded.last_snapshot_json
    `, [session.sessionId, session.boardId, session.workerInstanceId ?? null, session.sessionName, session.adapterSessionId ?? null, session.ccxmlPath ?? null, JSON.stringify(session.coreMap), session.status, session.createdAt, session.closedAt ?? null, session.lastSnapshot ? JSON.stringify(session.lastSnapshot) : null]);
  }

  listOpen(): PersistedSession[] {
    return this.store.all<SessionRow>("SELECT * FROM debug_sessions WHERE closed_at IS NULL ORDER BY created_at").map(mapSession);
  }

  get(sessionId: string): PersistedSession | undefined {
    const row = this.store.get<SessionRow>("SELECT * FROM debug_sessions WHERE session_id = ?", [sessionId]);
    return row ? mapSession(row) : undefined;
  }

  close(sessionId: string): void {
    this.store.run("UPDATE debug_sessions SET status = 'CLOSED', closed_at = ? WHERE session_id = ?", [new Date().toISOString(), sessionId]);
  }
}

interface SessionRow {
  session_id: string;
  board_id: string;
  worker_instance_id: string | null;
  session_name: string;
  adapter_session_id: string | null;
  ccxml_path: string | null;
  core_map_json: string;
  status: string;
  created_at: string;
  closed_at: string | null;
  last_snapshot_json: string | null;
}

function mapSession(row: SessionRow): PersistedSession {
  return {
      sessionId: row.session_id,
      boardId: row.board_id,
      ...(row.worker_instance_id ? { workerInstanceId: row.worker_instance_id } : {}),
      sessionName: row.session_name,
      ...(row.adapter_session_id ? { adapterSessionId: row.adapter_session_id } : {}),
      ...(row.ccxml_path ? { ccxmlPath: row.ccxml_path } : {}),
      coreMap: parseJson(row.core_map_json, []),
      status: row.status,
      createdAt: row.created_at,
      ...(row.closed_at ? { closedAt: row.closed_at } : {}),
      ...(row.last_snapshot_json ? { lastSnapshot: parseJson(row.last_snapshot_json, {}) } : {})
  };
}

function parseJson<T>(value: string, fallback: T): T { try { return JSON.parse(value) as T; } catch { return fallback; } }
