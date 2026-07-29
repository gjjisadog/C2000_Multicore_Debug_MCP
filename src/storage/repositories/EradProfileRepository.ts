import type { EradProfileResult, EradResourceSelection } from "../../observability/EradSchemas.js";
import type { SqliteStore } from "../SqliteStore.js";

export type EradProfileStatus =
  | "CONFIGURED"
  | "RUNNING"
  | "COMPLETED"
  | "STOPPED"
  | "CANCELLED"
  | "TIMED_OUT"
  | "INTERRUPTED"
  | "INVALIDATED"
  | "FAILED";

export interface EradProfileRecord {
  profileId: string;
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
  device: string;
  config: Record<string, unknown>;
  resources: EradResourceSelection;
  savedConfiguration: Record<string, unknown>;
  status: EradProfileStatus;
  configuredAt: string;
  startedAt?: string;
  endedAt?: string;
  stopReason?: string;
  result?: EradProfileResult;
  error?: Record<string, unknown>;
  artifactDirectory: string;
  artifactStatus: "PENDING" | "EXPORTED" | "FAILED";
  artifactError?: Record<string, unknown>;
}

export class EradProfileRepository {
  constructor(private readonly store: SqliteStore) {}

  create(record: EradProfileRecord): void {
    this.store.run(`
      INSERT INTO erad_profiles(
        profile_id, board_id, session_id, adapter_session_id, core_id, core_name,
        worker_instance_id, worker_generation, lease_id, lease_generation, fencing_token,
        device, config_json, resources_json, saved_configuration_json, status,
        configured_at, started_at, ended_at, stop_reason, result_json, error_json,
        artifact_directory, artifact_status, artifact_error_json
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      record.profileId, record.boardId, record.sessionId, record.adapterSessionId, record.coreId, record.coreName,
      record.workerInstanceId, record.workerGeneration, record.leaseId, record.leaseGeneration, record.fencingToken,
      record.device, JSON.stringify(record.config), JSON.stringify(record.resources),
      JSON.stringify(record.savedConfiguration), record.status, record.configuredAt, record.startedAt ?? null,
      record.endedAt ?? null, record.stopReason ?? null, record.result ? JSON.stringify(record.result) : null,
      record.error ? JSON.stringify(record.error) : null, record.artifactDirectory, record.artifactStatus,
      record.artifactError ? JSON.stringify(record.artifactError) : null
    ]);
  }

  get(profileId: string): EradProfileRecord | undefined {
    const row = this.store.get<Record<string, unknown>>("SELECT * FROM erad_profiles WHERE profile_id = ?", [profileId]);
    return row ? mapRecord(row) : undefined;
  }

  activeForBoard(boardId: string): EradProfileRecord | undefined {
    const row = this.store.get<Record<string, unknown>>(
      "SELECT * FROM erad_profiles WHERE board_id = ? AND status IN ('CONFIGURED','RUNNING') ORDER BY configured_at DESC LIMIT 1",
      [boardId]
    );
    return row ? mapRecord(row) : undefined;
  }

  update(record: EradProfileRecord): void {
    this.store.run(`
      UPDATE erad_profiles SET
        status = ?, started_at = ?, ended_at = ?, stop_reason = ?, result_json = ?,
        error_json = ?, artifact_status = ?, artifact_error_json = ?
      WHERE profile_id = ?
    `, [
      record.status, record.startedAt ?? null, record.endedAt ?? null, record.stopReason ?? null,
      record.result ? JSON.stringify(record.result) : null,
      record.error ? JSON.stringify(record.error) : null,
      record.artifactStatus, record.artifactError ? JSON.stringify(record.artifactError) : null,
      record.profileId
    ]);
  }

  markInterruptedOnStartup(): string[] {
    const rows = this.store.all<{ profile_id: string }>(
      "SELECT profile_id FROM erad_profiles WHERE status IN ('CONFIGURED','RUNNING')"
    );
    const now = new Date().toISOString();
    for (const row of rows) {
      this.store.run(
        "UPDATE erad_profiles SET status = 'INTERRUPTED', ended_at = ?, stop_reason = 'DAEMON_RESTART' WHERE profile_id = ?",
        [now, row.profile_id]
      );
    }
    return rows.map(row => row.profile_id);
  }
}

function mapRecord(row: Record<string, unknown>): EradProfileRecord {
  return {
    profileId: String(row.profile_id),
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
    device: String(row.device),
    config: parseJson(String(row.config_json), {}),
    resources: parseJson(String(row.resources_json), {
      startBusComparator: 1,
      endBusComparator: 2,
      maxCounter: 1,
      cumulativeCounter: 2,
      eventCounter: 3
    }),
    savedConfiguration: parseJson(String(row.saved_configuration_json), {}),
    status: String(row.status) as EradProfileStatus,
    configuredAt: String(row.configured_at),
    ...(row.started_at ? { startedAt: String(row.started_at) } : {}),
    ...(row.ended_at ? { endedAt: String(row.ended_at) } : {}),
    ...(row.stop_reason ? { stopReason: String(row.stop_reason) } : {}),
    ...(row.result_json ? { result: parseJson(String(row.result_json), undefined) } : {}),
    ...(row.error_json ? { error: parseJson(String(row.error_json), {}) } : {}),
    artifactDirectory: String(row.artifact_directory),
    artifactStatus: String(row.artifact_status) as EradProfileRecord["artifactStatus"],
    ...(row.artifact_error_json ? { artifactError: parseJson(String(row.artifact_error_json), {}) } : {})
  };
}

function parseJson<T>(value: string, fallback: T): T {
  try { return JSON.parse(value) as T; } catch { return fallback; }
}
