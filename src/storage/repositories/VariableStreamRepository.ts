import type { VariableMetadata, VariableSample, VariableStreamStats } from "../../observability/VariableStreamSchemas.js";
import type { SqliteStore } from "../SqliteStore.js";

export type VariableStreamStatus = "STARTING" | "RUNNING" | "STOPPING" | "COMPLETED" | "STOPPED" | "CANCELLED" | "INTERRUPTED" | "FAILED";

export interface VariableStreamRecord {
  streamId: string;
  boardId: string;
  sessionId: string;
  adapterSessionId: string;
  coreId: number;
  coreName: string;
  workerInstanceId: string;
  workerGeneration: number;
  leaseId: string;
  leaseGeneration: number;
  fencingToken: number;
  config: Record<string, unknown>;
  metadata: VariableMetadata[];
  status: VariableStreamStatus;
  stats: VariableStreamStats;
  startedAt: string;
  endedAt?: string;
  stopReason?: string;
  error?: Record<string, unknown>;
  artifactDirectory: string;
  evidenceLevel: "MOCK" | "HARDWARE_TARGET" | "UNKNOWN";
  artifactBytes: number;
  artifactStatus: "PENDING" | "EXPORTED" | "FAILED";
  artifactError?: Record<string, unknown>;
}

export class VariableStreamRepository {
  constructor(private readonly store: SqliteStore) {}

  create(record: VariableStreamRecord): void {
    this.store.run(`
      INSERT INTO variable_streams(
        stream_id, board_id, session_id, adapter_session_id, core_id, core_name,
        worker_instance_id, worker_generation, lease_id, lease_generation, fencing_token,
        config_json, metadata_json, status, stats_json, started_at, ended_at, stop_reason,
        error_json, artifact_directory, evidence_level, artifact_bytes, artifact_status, artifact_error_json
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      record.streamId, record.boardId, record.sessionId, record.adapterSessionId, record.coreId, record.coreName,
      record.workerInstanceId, record.workerGeneration, record.leaseId, record.leaseGeneration, record.fencingToken,
      JSON.stringify(record.config), JSON.stringify(record.metadata), record.status, JSON.stringify(record.stats),
      record.startedAt, record.endedAt ?? null, record.stopReason ?? null,
      record.error ? JSON.stringify(record.error) : null, record.artifactDirectory, record.evidenceLevel, record.artifactBytes,
      record.artifactStatus, record.artifactError ? JSON.stringify(record.artifactError) : null
    ]);
  }

  get(streamId: string): VariableStreamRecord | undefined {
    const row = this.store.get<Record<string, unknown>>("SELECT * FROM variable_streams WHERE stream_id = ?", [streamId]);
    return row ? mapStream(row) : undefined;
  }

  activeForBoard(boardId: string): VariableStreamRecord | undefined {
    const row = this.store.get<Record<string, unknown>>("SELECT * FROM variable_streams WHERE board_id = ? AND status IN ('STARTING','RUNNING','STOPPING') ORDER BY started_at DESC LIMIT 1", [boardId]);
    return row ? mapStream(row) : undefined;
  }

  update(record: VariableStreamRecord): void {
    this.store.run(`
      UPDATE variable_streams SET
        status = ?, stats_json = ?, metadata_json = ?, ended_at = ?, stop_reason = ?,
        error_json = ?, artifact_bytes = ?, artifact_status = ?, artifact_error_json = ?
      WHERE stream_id = ?
    `, [
      record.status, JSON.stringify(record.stats), JSON.stringify(record.metadata), record.endedAt ?? null,
      record.stopReason ?? null, record.error ? JSON.stringify(record.error) : null,
      record.artifactBytes, record.artifactStatus,
      record.artifactError ? JSON.stringify(record.artifactError) : null, record.streamId
    ]);
  }

  appendSample(streamId: string, sample: VariableSample): void {
    this.store.run("INSERT INTO variable_stream_samples(stream_id, sequence, sample_json, created_at) VALUES(?, ?, ?, ?)", [
      streamId, sample.sequence, JSON.stringify(sample), sample.timestamp
    ]);
  }

  samples(streamId: string, afterSequence = 0, limit = 100): VariableSample[] {
    return this.store.all<{ sample_json: string }>(
      "SELECT sample_json FROM variable_stream_samples WHERE stream_id = ? AND sequence > ? ORDER BY sequence LIMIT ?",
      [streamId, afterSequence, limit]
    ).map(row => JSON.parse(row.sample_json) as VariableSample);
  }

  allSamples(streamId: string): VariableSample[] {
    return this.samples(streamId, 0, 100_000);
  }

  markInterruptedOnStartup(): string[] {
    const rows = this.store.all<{ stream_id: string }>("SELECT stream_id FROM variable_streams WHERE status IN ('STARTING','RUNNING','STOPPING')");
    const now = new Date().toISOString();
    for (const row of rows) {
      this.store.run("UPDATE variable_streams SET status = 'INTERRUPTED', ended_at = ?, stop_reason = 'DAEMON_RESTART' WHERE stream_id = ?", [now, row.stream_id]);
    }
    return rows.map(row => row.stream_id);
  }
}

function mapStream(row: Record<string, unknown>): VariableStreamRecord {
  return {
    streamId: String(row.stream_id),
    boardId: String(row.board_id),
    sessionId: String(row.session_id),
    adapterSessionId: String(row.adapter_session_id),
    coreId: Number(row.core_id),
    coreName: String(row.core_name),
    workerInstanceId: String(row.worker_instance_id),
    workerGeneration: Number(row.worker_generation),
    leaseId: String(row.lease_id),
    leaseGeneration: Number(row.lease_generation),
    fencingToken: Number(row.fencing_token),
    config: parseJson(String(row.config_json), {}),
    metadata: parseJson(String(row.metadata_json), []),
    status: String(row.status) as VariableStreamStatus,
    stats: parseJson<VariableStreamStats>(String(row.stats_json), {
      requestedSamplePeriodMs: 10,
      actualHostIntervalMs: { last: null, min: null, max: null, mean: null },
      missedPollCount: 0,
      overrunCount: 0,
      readErrorCount: 0,
      droppedSampleCount: 0,
      totalSamples: 0
    }),
    startedAt: String(row.started_at),
    ...(row.ended_at ? { endedAt: String(row.ended_at) } : {}),
    ...(row.stop_reason ? { stopReason: String(row.stop_reason) } : {}),
    ...(row.error_json ? { error: parseJson(String(row.error_json), {}) } : {}),
    artifactDirectory: String(row.artifact_directory),
    evidenceLevel: String(row.evidence_level) as VariableStreamRecord["evidenceLevel"],
    artifactBytes: Number(row.artifact_bytes),
    artifactStatus: String(row.artifact_status) as VariableStreamRecord["artifactStatus"],
    ...(row.artifact_error_json ? { artifactError: parseJson(String(row.artifact_error_json), {}) } : {})
  };
}

function parseJson<T>(value: string, fallback: T): T {
  try { return JSON.parse(value) as T; } catch { return fallback; }
}
