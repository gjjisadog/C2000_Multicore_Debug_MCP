import { SqliteStore } from "../SqliteStore.js";

export interface WorkerRecord {
  workerInstanceId: string;
  boardId: string;
  pid: number;
  processStartTime: string;
  daemonInstanceId: string;
  status: string;
  startedAt: string;
  lastHeartbeatAt?: string;
  currentCommandId?: string;
  ownedDssProcesses: Record<string, unknown>[];
  lastError?: Record<string, unknown>;
}

interface WorkerRow {
  worker_instance_id: string;
  board_id: string;
  pid: number;
  process_start_time: string;
  daemon_instance_id: string;
  status: string;
  started_at: string;
  last_heartbeat_at: string | null;
  current_command_id: string | null;
  owned_dss_processes_json: string;
  last_error_json: string | null;
}

export class WorkerRepository {
  constructor(private readonly store: SqliteStore) {}

  upsert(worker: WorkerRecord): void {
    this.store.run(`
      INSERT INTO workers(worker_instance_id, board_id, pid, process_start_time, daemon_instance_id, status, started_at, last_heartbeat_at, current_command_id, owned_dss_processes_json, last_error_json)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(worker_instance_id) DO UPDATE SET
        status = excluded.status,
        last_heartbeat_at = excluded.last_heartbeat_at,
        current_command_id = excluded.current_command_id,
        owned_dss_processes_json = excluded.owned_dss_processes_json,
        last_error_json = excluded.last_error_json
    `, [worker.workerInstanceId, worker.boardId, worker.pid, worker.processStartTime, worker.daemonInstanceId, worker.status, worker.startedAt, worker.lastHeartbeatAt ?? null, worker.currentCommandId ?? null, JSON.stringify(worker.ownedDssProcesses), worker.lastError ? JSON.stringify(worker.lastError) : null]);
  }

  heartbeat(workerInstanceId: string, status: string, currentCommandId?: string): void {
    this.store.run("UPDATE workers SET status = ?, last_heartbeat_at = ?, current_command_id = ? WHERE worker_instance_id = ?", [status, new Date().toISOString(), currentCommandId ?? null, workerInstanceId]);
  }

  list(): WorkerRecord[] {
    return this.store.all<WorkerRow>("SELECT * FROM workers ORDER BY started_at").map(mapWorker);
  }

  countHealthy(): { total: number; healthy: number; unhealthy: number } {
    const total = Number(this.store.get<{ count: number }>("SELECT COUNT(*) AS count FROM workers")?.count ?? 0);
    const healthy = Number(this.store.get<{ count: number }>("SELECT COUNT(*) AS count FROM workers WHERE status IN ('STARTING', 'READY', 'RUNNING')")?.count ?? 0);
    return { total, healthy, unhealthy: total - healthy };
  }
}

function mapWorker(row: WorkerRow): WorkerRecord {
  return {
    workerInstanceId: row.worker_instance_id,
    boardId: row.board_id,
    pid: row.pid,
    processStartTime: row.process_start_time,
    daemonInstanceId: row.daemon_instance_id,
    status: row.status,
    startedAt: row.started_at,
    ...(row.last_heartbeat_at ? { lastHeartbeatAt: row.last_heartbeat_at } : {}),
    ...(row.current_command_id ? { currentCommandId: row.current_command_id } : {}),
    ownedDssProcesses: parseJson<Record<string, unknown>[]>(row.owned_dss_processes_json, []),
    ...(row.last_error_json ? { lastError: parseJson<Record<string, unknown>>(row.last_error_json, {}) } : {})
  };
}

function parseJson<T>(value: string, fallback: T): T {
  try { return JSON.parse(value) as T; } catch { return fallback; }
}
