import { randomUUID } from "node:crypto";
import { SqliteStore } from "../SqliteStore.js";

export interface PersistedEvent {
  eventId?: string;
  timestamp?: string;
  level: "debug" | "info" | "warn" | "error";
  sourceType: string;
  sourceId: string;
  jobId?: string;
  boardId?: string;
  workerInstanceId?: string;
  workerGeneration?: number;
  sequence?: number;
  monotonicTimestampNs?: string;
  eventType: string;
  payload: Record<string, unknown>;
}

export class EventRepository {
  constructor(private readonly store: SqliteStore) {}

  append(event: PersistedEvent): string {
    const eventId = event.eventId ?? randomUUID();
    this.store.transaction(() => {
      const sequence = event.sequence ?? (event.jobId
        ? Number(this.store.get<{ sequence: number }>("SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM events WHERE job_id = ?", [event.jobId])?.sequence ?? 1)
        : null);
      this.store.run("INSERT INTO events(event_id, timestamp, level, source_type, source_id, job_id, board_id, worker_instance_id, worker_generation, sequence, monotonic_timestamp_ns, event_type, payload_json) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [eventId, event.timestamp ?? new Date().toISOString(), event.level, event.sourceType, event.sourceId, event.jobId ?? null, event.boardId ?? null, event.workerInstanceId ?? null, event.workerGeneration ?? null, sequence, event.monotonicTimestampNs ?? process.hrtime.bigint().toString(), event.eventType, JSON.stringify(event.payload)]);
    });
    return eventId;
  }

  list(filters: { jobId?: string; boardId?: string; limit?: number; ascending?: boolean } = {}): Array<PersistedEvent & { eventId: string; timestamp: string }> {
    const order = filters.ascending ? "ASC" : "DESC";
    const rows = this.store.all<Record<string, unknown>>(`SELECT * FROM events WHERE (? IS NULL OR job_id = ?) AND (? IS NULL OR board_id = ?) ORDER BY COALESCE(sequence, 0) ${order}, timestamp ${order} LIMIT ?`, [filters.jobId ?? null, filters.jobId ?? null, filters.boardId ?? null, filters.boardId ?? null, filters.limit ?? 100]);
    return rows.map(row => ({ eventId: String(row.event_id), timestamp: String(row.timestamp), level: String(row.level) as PersistedEvent["level"], sourceType: String(row.source_type), sourceId: String(row.source_id), ...(row.job_id ? { jobId: String(row.job_id) } : {}), ...(row.board_id ? { boardId: String(row.board_id) } : {}), ...(row.worker_instance_id ? { workerInstanceId: String(row.worker_instance_id) } : {}), ...(row.worker_generation ? { workerGeneration: Number(row.worker_generation) } : {}), ...(row.sequence ? { sequence: Number(row.sequence) } : {}), ...(row.monotonic_timestamp_ns ? { monotonicTimestampNs: String(row.monotonic_timestamp_ns) } : {}), eventType: String(row.event_type), payload: parseJson(String(row.payload_json), {}) }));
  }
}

function parseJson<T>(value: string, fallback: T): T { try { return JSON.parse(value) as T; } catch { return fallback; } }
