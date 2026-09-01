import type { SqliteStore } from "../storage/SqliteStore.js";
import { outcomeEventSchema, type OutcomeEvent, type OutcomeEventKind } from "./OutcomeSchemas.js";

export interface OutcomeEventQuery {
  from?: string;
  to?: string;
  kinds?: readonly OutcomeEventKind[];
  names?: readonly string[];
  jobId?: string;
  limit?: number;
}
export interface OutcomeEventStore {
  append(event: OutcomeEvent): void;
  list(query?: OutcomeEventQuery): OutcomeEvent[];
  deleteBefore(timestamp: string): number;
}

interface OutcomeEventRow {
  event_id: string;
  timestamp: string;
  kind: string;
  name: string;
  outcome: string;
  duration_ms: number | null;
  stage: string | null;
  error_code: string | null;
  failure_class: string | null;
  tool_profile: string;
  tool_surface_profile: string;
  active_capabilities_json: string;
  board_count: number | null;
  core_count: number | null;
  job_id: string | null;
  session_id: string | null;
  escalation_from: string | null;
  escalation_to: string | null;
  metadata_json: string;
}

/** SQLite-backed analytics event store. It is deliberately separate from formal evidence events. */
export class OutcomeEventRepository implements OutcomeEventStore {
  constructor(private readonly store: SqliteStore) {}

  append(event: OutcomeEvent): void {
    const parsed = outcomeEventSchema.parse(event);
    this.store.run(`
      INSERT OR REPLACE INTO outcome_events(
        event_id, timestamp, kind, name, outcome, duration_ms, stage, error_code,
        failure_class, tool_profile, tool_surface_profile, active_capabilities_json,
        board_count, core_count, job_id, session_id, escalation_from, escalation_to,
        metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      parsed.eventId,
      parsed.timestamp,
      parsed.kind,
      parsed.name,
      parsed.outcome,
      parsed.durationMs ?? null,
      parsed.stage ?? null,
      parsed.errorCode ?? null,
      parsed.failureClass ?? null,
      parsed.toolProfile,
      parsed.toolSurfaceProfile,
      JSON.stringify(parsed.activeCapabilities),
      parsed.boardCount ?? null,
      parsed.coreCount ?? null,
      parsed.jobId ?? null,
      parsed.sessionId ?? null,
      parsed.escalationFrom ?? null,
      parsed.escalationTo ?? null,
      JSON.stringify(parsed.metadata ?? {})
    ]);
  }

  list(query: OutcomeEventQuery = {}): OutcomeEvent[] {
    const clauses: string[] = [];
    const parameters: unknown[] = [];
    if (query.from) {
      clauses.push("timestamp >= ?");
      parameters.push(query.from);
    }
    if (query.to) {
      clauses.push("timestamp <= ?");
      parameters.push(query.to);
    }
    if (query.jobId) {
      clauses.push("job_id = ?");
      parameters.push(query.jobId);
    }
    if (query.kinds && query.kinds.length > 0) {
      clauses.push(`kind IN (${query.kinds.map(() => "?").join(",")})`);
      parameters.push(...query.kinds);
    }
    if (query.names && query.names.length > 0) {
      clauses.push(`name IN (${query.names.map(() => "?").join(",")})`);
      parameters.push(...query.names);
    }
    const limit = Math.max(1, Math.min(50_000, Math.trunc(query.limit ?? 10_000)));
    const rows = this.store.all<OutcomeEventRow>(`
      SELECT event_id, timestamp, kind, name, outcome, duration_ms, stage, error_code,
             failure_class, tool_profile, tool_surface_profile, active_capabilities_json,
             board_count, core_count, job_id, session_id, escalation_from, escalation_to,
             metadata_json
      FROM outcome_events
      ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY timestamp ASC, event_id ASC
      LIMIT ?
    `, [...parameters, limit]);
    return rows.flatMap(row => decodeRow(row));
  }

  deleteBefore(timestamp: string): number {
    return this.store.run("DELETE FROM outcome_events WHERE timestamp < ?", [timestamp]).changes;
  }
}

/** Small deterministic store used by host-only tests and standalone embeddings. */
export class InMemoryOutcomeEventStore implements OutcomeEventStore {
  private readonly events = new Map<string, OutcomeEvent>();

  append(event: OutcomeEvent): void {
    this.events.set(event.eventId, structuredClone(event));
  }

  list(query: OutcomeEventQuery = {}): OutcomeEvent[] {
    return Array.from(this.events.values())
      .filter(event => !query.from || event.timestamp >= query.from)
      .filter(event => !query.to || event.timestamp <= query.to)
      .filter(event => !query.jobId || event.jobId === query.jobId)
      .filter(event => !query.kinds?.length || query.kinds.includes(event.kind))
      .filter(event => !query.names?.length || query.names.includes(event.name))
      .sort((left, right) => left.timestamp.localeCompare(right.timestamp) || left.eventId.localeCompare(right.eventId))
      .slice(0, Math.max(1, Math.min(50_000, Math.trunc(query.limit ?? 10_000))))
      .map(event => structuredClone(event));
  }

  deleteBefore(timestamp: string): number {
    let deleted = 0;
    for (const [eventId, event] of this.events) {
      if (event.timestamp >= timestamp) continue;
      this.events.delete(eventId);
      deleted += 1;
    }
    return deleted;
  }
}

function decodeRow(row: OutcomeEventRow): OutcomeEvent[] {
  try {
    const event = outcomeEventSchema.parse({
      eventId: row.event_id,
      timestamp: row.timestamp,
      kind: row.kind,
      name: row.name,
      outcome: row.outcome,
      ...(row.duration_ms === null ? {} : { durationMs: row.duration_ms }),
      ...(row.stage === null ? {} : { stage: row.stage }),
      ...(row.error_code === null ? {} : { errorCode: row.error_code }),
      ...(row.failure_class === null ? {} : { failureClass: row.failure_class }),
      toolProfile: row.tool_profile,
      toolSurfaceProfile: row.tool_surface_profile,
      activeCapabilities: JSON.parse(row.active_capabilities_json),
      ...(row.board_count === null ? {} : { boardCount: row.board_count }),
      ...(row.core_count === null ? {} : { coreCount: row.core_count }),
      ...(row.job_id === null ? {} : { jobId: row.job_id }),
      ...(row.session_id === null ? {} : { sessionId: row.session_id }),
      ...(row.escalation_from === null ? {} : { escalationFrom: row.escalation_from }),
      ...(row.escalation_to === null ? {} : { escalationTo: row.escalation_to }),
      metadata: JSON.parse(row.metadata_json)
    });
    return [event];
  } catch {
    // A malformed optional analytics row must not make the debug daemon fail.
    return [];
  }
}
