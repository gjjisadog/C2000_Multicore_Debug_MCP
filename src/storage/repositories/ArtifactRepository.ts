import { randomUUID } from "node:crypto";
import { SqliteStore } from "../SqliteStore.js";

export interface ArtifactRecord {
  artifactId?: string;
  jobId: string;
  boardId?: string;
  artifactType: string;
  path: string;
  sha256: string;
  size: number;
  createdAt?: string;
}

export class ArtifactRepository {
  constructor(private readonly store: SqliteStore) {}

  add(artifact: ArtifactRecord): string {
    const artifactId = artifact.artifactId ?? randomUUID();
    this.store.run("INSERT INTO artifacts(artifact_id, job_id, board_id, artifact_type, path, sha256, size, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)", [artifactId, artifact.jobId, artifact.boardId ?? null, artifact.artifactType, artifact.path, artifact.sha256, artifact.size, artifact.createdAt ?? new Date().toISOString()]);
    return artifactId;
  }

  upsert(artifact: ArtifactRecord): string {
    const existing = this.store.get<{ artifact_id: string }>("SELECT artifact_id FROM artifacts WHERE job_id = ? AND artifact_type = ? AND path = ? ORDER BY created_at LIMIT 1", [artifact.jobId, artifact.artifactType, artifact.path]);
    if (!existing) return this.add(artifact);
    this.store.run("UPDATE artifacts SET board_id = ?, sha256 = ?, size = ?, created_at = ? WHERE artifact_id = ?", [artifact.boardId ?? null, artifact.sha256, artifact.size, artifact.createdAt ?? new Date().toISOString(), existing.artifact_id]);
    return existing.artifact_id;
  }

  list(jobId: string): Required<ArtifactRecord>[] {
    return this.store.all<Record<string, unknown>>("SELECT * FROM artifacts WHERE job_id = ? ORDER BY created_at", [jobId]).map(row => ({ artifactId: String(row.artifact_id), jobId: String(row.job_id), boardId: row.board_id ? String(row.board_id) : "", artifactType: String(row.artifact_type), path: String(row.path), sha256: String(row.sha256), size: Number(row.size), createdAt: String(row.created_at) }));
  }
}
