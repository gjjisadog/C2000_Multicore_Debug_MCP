import type { SqliteStore } from "../../storage/SqliteStore.js";
import {
  crossImprovementSnapshotSchema,
  engineeringPolicyRecommendationSchema,
  engineeringPolicySnapshotSchema,
  type CrossImprovementSnapshot,
  type EngineeringPolicyRecommendation,
  type EngineeringPolicySnapshot,
  type MetaRecommendationCategory,
  type MetaRecommendationStatus
} from "./MetaSchemas.js";

export interface EngineeringPolicyRecommendationListQuery {
  status?: MetaRecommendationStatus;
  category?: MetaRecommendationCategory;
  target?: string;
  limit?: number;
}

export interface EngineeringPolicyRecommendationStore {
  get(recommendationId: string): EngineeringPolicyRecommendation | undefined;
  findByFingerprint(fingerprint: string): EngineeringPolicyRecommendation | undefined;
  list(query?: EngineeringPolicyRecommendationListQuery): EngineeringPolicyRecommendation[];
  upsert(value: EngineeringPolicyRecommendation): void;
}

export interface EngineeringPolicySnapshotStore {
  get(snapshotId: string): EngineeringPolicySnapshot | undefined;
  list(limit?: number): EngineeringPolicySnapshot[];
  upsert(value: EngineeringPolicySnapshot): void;
}

export interface CrossImprovementSnapshotStore {
  get(snapshotId: string): CrossImprovementSnapshot | undefined;
  list(limit?: number): CrossImprovementSnapshot[];
  append(value: CrossImprovementSnapshot): void;
}

interface RecommendationRow {
  recommendation_id: string;
  fingerprint: string;
  category: string;
  target: string;
  status: string;
  created_at: string;
  updated_at: string;
  last_observed_at: string;
  record_json: string;
}

interface PolicySnapshotRow {
  snapshot_id: string;
  policy_regime: string;
  engineering_policy_hash: string;
  captured_at: string;
  record_json: string;
}

interface CrossSnapshotRow {
  snapshot_id: string;
  generated_at: string;
  policy_regime: string;
  engineering_policy_hash: string;
  history_status: string;
  sample_size: number;
  record_json: string;
}

export class EngineeringPolicyRecommendationRepository implements EngineeringPolicyRecommendationStore {
  constructor(private readonly store: SqliteStore) {}

  get(recommendationId: string): EngineeringPolicyRecommendation | undefined {
    const row = this.store.get<RecommendationRow>("SELECT * FROM engineering_policy_recommendations WHERE recommendation_id = ?", [recommendationId]);
    return row ? decodeRecommendation(row) : undefined;
  }

  findByFingerprint(fingerprint: string): EngineeringPolicyRecommendation | undefined {
    const row = this.store.get<RecommendationRow>("SELECT * FROM engineering_policy_recommendations WHERE fingerprint = ?", [fingerprint]);
    return row ? decodeRecommendation(row) : undefined;
  }

  list(query: EngineeringPolicyRecommendationListQuery = {}): EngineeringPolicyRecommendation[] {
    const clauses: string[] = [];
    const parameters: unknown[] = [];
    if (query.status) { clauses.push("status = ?"); parameters.push(query.status); }
    if (query.category) { clauses.push("category = ?"); parameters.push(query.category); }
    if (query.target) { clauses.push("target = ?"); parameters.push(query.target); }
    const limit = clampLimit(query.limit);
    return this.store.all<RecommendationRow>(`
      SELECT * FROM engineering_policy_recommendations
      ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY updated_at DESC, recommendation_id ASC LIMIT ?
    `, [...parameters, limit]).flatMap(row => {
      const value = decodeRecommendation(row);
      return value ? [value] : [];
    });
  }

  upsert(value: EngineeringPolicyRecommendation): void {
    const parsed = engineeringPolicyRecommendationSchema.parse(value);
    this.store.run(`
      INSERT INTO engineering_policy_recommendations(
        recommendation_id, fingerprint, category, target, status,
        created_at, updated_at, last_observed_at, record_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(recommendation_id) DO UPDATE SET
        fingerprint = excluded.fingerprint,
        category = excluded.category,
        target = excluded.target,
        status = excluded.status,
        updated_at = excluded.updated_at,
        last_observed_at = excluded.last_observed_at,
        record_json = excluded.record_json
    `, [
      parsed.recommendationId,
      parsed.fingerprint,
      parsed.category,
      parsed.target,
      parsed.status,
      parsed.createdAt,
      parsed.updatedAt,
      parsed.lastObservedAt,
      JSON.stringify(parsed)
    ]);
  }
}

export class EngineeringPolicySnapshotRepository implements EngineeringPolicySnapshotStore {
  constructor(private readonly store: SqliteStore) {}

  get(snapshotId: string): EngineeringPolicySnapshot | undefined {
    const row = this.store.get<PolicySnapshotRow>("SELECT * FROM engineering_policy_snapshots WHERE snapshot_id = ?", [snapshotId]);
    return row ? decodePolicySnapshot(row) : undefined;
  }

  list(limit = 100): EngineeringPolicySnapshot[] {
    return this.store.all<PolicySnapshotRow>("SELECT * FROM engineering_policy_snapshots ORDER BY captured_at DESC, snapshot_id ASC LIMIT ?", [clampLimit(limit)]).flatMap(row => {
      const value = decodePolicySnapshot(row);
      return value ? [value] : [];
    });
  }

  upsert(value: EngineeringPolicySnapshot): void {
    const parsed = engineeringPolicySnapshotSchema.parse(value);
    this.store.run(`
      INSERT INTO engineering_policy_snapshots(
        snapshot_id, policy_regime, engineering_policy_hash, captured_at, record_json
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(snapshot_id) DO UPDATE SET
        policy_regime = excluded.policy_regime,
        engineering_policy_hash = excluded.engineering_policy_hash,
        captured_at = excluded.captured_at,
        record_json = excluded.record_json
    `, [parsed.snapshotId, parsed.policyRegime, parsed.engineeringPolicyHash, parsed.capturedAt, JSON.stringify(parsed)]);
  }
}

export class CrossImprovementSnapshotRepository implements CrossImprovementSnapshotStore {
  constructor(private readonly store: SqliteStore) {}

  get(snapshotId: string): CrossImprovementSnapshot | undefined {
    const row = this.store.get<CrossSnapshotRow>("SELECT * FROM cross_improvement_snapshots WHERE snapshot_id = ?", [snapshotId]);
    return row ? decodeCrossSnapshot(row) : undefined;
  }

  list(limit = 100): CrossImprovementSnapshot[] {
    return this.store.all<CrossSnapshotRow>("SELECT * FROM cross_improvement_snapshots ORDER BY generated_at DESC, snapshot_id ASC LIMIT ?", [clampLimit(limit)]).flatMap(row => {
      const value = decodeCrossSnapshot(row);
      return value ? [value] : [];
    });
  }

  append(value: CrossImprovementSnapshot): void {
    const parsed = crossImprovementSnapshotSchema.parse(value);
    this.store.run(`
      INSERT OR REPLACE INTO cross_improvement_snapshots(
        snapshot_id, generated_at, policy_regime, engineering_policy_hash,
        history_status, sample_size, record_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [parsed.snapshotId, parsed.generatedAt, parsed.policyRegime, parsed.engineeringPolicyHash, parsed.historyStatus, parsed.sampleSize, JSON.stringify(parsed)]);
  }
}

export class InMemoryEngineeringPolicyRecommendationStore implements EngineeringPolicyRecommendationStore {
  private readonly values = new Map<string, EngineeringPolicyRecommendation>();
  get(recommendationId: string): EngineeringPolicyRecommendation | undefined {
    const value = this.values.get(recommendationId);
    return value ? structuredClone(value) : undefined;
  }
  findByFingerprint(fingerprint: string): EngineeringPolicyRecommendation | undefined {
    const value = [...this.values.values()].find(item => item.fingerprint === fingerprint);
    return value ? structuredClone(value) : undefined;
  }
  list(query: EngineeringPolicyRecommendationListQuery = {}): EngineeringPolicyRecommendation[] {
    return [...this.values.values()]
      .filter(item => !query.status || item.status === query.status)
      .filter(item => !query.category || item.category === query.category)
      .filter(item => !query.target || item.target === query.target)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.recommendationId.localeCompare(right.recommendationId))
      .slice(0, clampLimit(query.limit))
      .map(value => structuredClone(value));
  }
  upsert(value: EngineeringPolicyRecommendation): void {
    this.values.set(value.recommendationId, structuredClone(engineeringPolicyRecommendationSchema.parse(value)));
  }
}

export class InMemoryEngineeringPolicySnapshotStore implements EngineeringPolicySnapshotStore {
  private readonly values = new Map<string, EngineeringPolicySnapshot>();
  get(snapshotId: string): EngineeringPolicySnapshot | undefined {
    const value = this.values.get(snapshotId);
    return value ? structuredClone(value) : undefined;
  }
  list(limit = 100): EngineeringPolicySnapshot[] {
    return [...this.values.values()].sort((left, right) => right.capturedAt.localeCompare(left.capturedAt) || left.snapshotId.localeCompare(right.snapshotId)).slice(0, clampLimit(limit)).map(value => structuredClone(value));
  }
  upsert(value: EngineeringPolicySnapshot): void {
    this.values.set(value.snapshotId, structuredClone(engineeringPolicySnapshotSchema.parse(value)));
  }
}

export class InMemoryCrossImprovementSnapshotStore implements CrossImprovementSnapshotStore {
  private readonly values = new Map<string, CrossImprovementSnapshot>();
  get(snapshotId: string): CrossImprovementSnapshot | undefined {
    const value = this.values.get(snapshotId);
    return value ? structuredClone(value) : undefined;
  }
  list(limit = 100): CrossImprovementSnapshot[] {
    return [...this.values.values()].sort((left, right) => right.generatedAt.localeCompare(left.generatedAt) || left.snapshotId.localeCompare(right.snapshotId)).slice(0, clampLimit(limit)).map(value => structuredClone(value));
  }
  append(value: CrossImprovementSnapshot): void {
    this.values.set(value.snapshotId, structuredClone(crossImprovementSnapshotSchema.parse(value)));
  }
}

function decodeRecommendation(row: RecommendationRow): EngineeringPolicyRecommendation | undefined {
  try {
    const parsed = engineeringPolicyRecommendationSchema.safeParse(JSON.parse(row.record_json));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function decodePolicySnapshot(row: PolicySnapshotRow): EngineeringPolicySnapshot | undefined {
  try {
    const parsed = engineeringPolicySnapshotSchema.safeParse(JSON.parse(row.record_json));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function decodeCrossSnapshot(row: CrossSnapshotRow): CrossImprovementSnapshot | undefined {
  try {
    const parsed = crossImprovementSnapshotSchema.safeParse(JSON.parse(row.record_json));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function clampLimit(value = 100): number {
  return Math.max(1, Math.min(500, Math.trunc(value)));
}
