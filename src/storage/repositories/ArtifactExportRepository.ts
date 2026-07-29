import type { SqliteStore } from "../SqliteStore.js";

export interface ArtifactExportRecord {
  jobId: string;
  rootPath: string;
  schemaVersion: number;
  status: "EXPORTING" | "EXPORTED" | "FAILED";
  completeness: "COMPLETE" | "INCOMPLETE" | "ARTIFACT_FAILED";
  lastError?: Record<string, unknown>;
  updatedAt: string;
}

export class ArtifactExportRepository {
  constructor(private readonly store: SqliteStore) {}

  upsert(record: ArtifactExportRecord): void {
    this.store.run(`
      INSERT INTO artifact_exports(job_id, root_path, schema_version, status, completeness, last_error_json, updated_at)
      VALUES(?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(job_id) DO UPDATE SET
        root_path = excluded.root_path,
        schema_version = excluded.schema_version,
        status = excluded.status,
        completeness = excluded.completeness,
        last_error_json = excluded.last_error_json,
        updated_at = excluded.updated_at
    `, [record.jobId, record.rootPath, record.schemaVersion, record.status, record.completeness, record.lastError ? JSON.stringify(record.lastError) : null, record.updatedAt]);
  }

  get(jobId: string): ArtifactExportRecord | undefined {
    const row = this.store.get<Record<string, unknown>>("SELECT * FROM artifact_exports WHERE job_id = ?", [jobId]);
    if (!row) return undefined;
    return {
      jobId: String(row.job_id),
      rootPath: String(row.root_path),
      schemaVersion: Number(row.schema_version),
      status: String(row.status) as ArtifactExportRecord["status"],
      completeness: String(row.completeness) as ArtifactExportRecord["completeness"],
      ...(row.last_error_json ? { lastError: JSON.parse(String(row.last_error_json)) as Record<string, unknown> } : {}),
      updatedAt: String(row.updated_at)
    };
  }
}
