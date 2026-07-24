import { stat } from "node:fs/promises";
import type { ArtifactRepository } from "../storage/repositories/ArtifactRepository.js";

/** Conservative read-only retention planning. Deletion is intentionally not automated. */
export class CanArtifactRetentionService {
  constructor(private readonly artifacts: ArtifactRepository) {}
  async preview(jobId: string, before: string): Promise<Record<string, unknown>> {
    const cutoff = Date.parse(before);
    const candidates = [] as Record<string, unknown>[];
    for (const artifact of this.artifacts.list(jobId).filter(item => item.artifactType.startsWith("can-"))) {
      const createdAtMs = Date.parse(artifact.createdAt);
      if (!Number.isNaN(cutoff) && createdAtMs < cutoff) {
        const exists = await stat(artifact.path).then(() => true).catch(() => false);
        candidates.push({ artifactId: artifact.artifactId, path: artifact.path, artifactType: artifact.artifactType, createdAt: artifact.createdAt, exists, action: "REVIEW_ONLY_NO_DELETE" });
      }
    }
    return { jobId, before, candidates, deleted: false, policy: "Retention is read-only by default; operator deletion requires separate explicit authority" };
  }
}
