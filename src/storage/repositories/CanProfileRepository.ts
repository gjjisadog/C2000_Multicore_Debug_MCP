import { SqliteStore } from "../SqliteStore.js";

export interface StoredCanProfile {
  profileId: string;
  version: number;
  hash: string;
  profile: Record<string, unknown>;
  capabilities: Record<string, unknown>;
  status: "ACTIVE" | "RETIRED";
  createdAt: string;
}

/** Versioned profile declarations, kept separately from immutable job plans. */
export class CanProfileRepository {
  constructor(private readonly store: SqliteStore) {}

  put(input: Omit<StoredCanProfile, "createdAt">): StoredCanProfile {
    const existing = this.get(input.profileId, input.version);
    if (existing) return existing;
    const now = new Date().toISOString();
    this.store.run(
      "INSERT INTO can_profiles(profile_id, version, profile_hash, profile_json, capabilities_json, status, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)",
      [input.profileId, input.version, input.hash, JSON.stringify(input.profile), JSON.stringify(input.capabilities), input.status, now]
    );
    return this.require(input.profileId, input.version);
  }

  get(profileId: string, version: number): StoredCanProfile | undefined {
    const row = this.store.get<Record<string, unknown>>("SELECT * FROM can_profiles WHERE profile_id = ? AND version = ?", [profileId, version]);
    return row ? mapProfile(row) : undefined;
  }

  require(profileId: string, version: number): StoredCanProfile {
    const value = this.get(profileId, version);
    if (!value) throw new Error(`CAN profile not found: ${profileId}@${version}`);
    return value;
  }

  list(input: { profileId?: string; includeRetired?: boolean } = {}): StoredCanProfile[] {
    const rows = this.store.all<Record<string, unknown>>(
      `SELECT * FROM can_profiles WHERE (? IS NULL OR profile_id = ?)${input.includeRetired ? "" : " AND status = 'ACTIVE'"} ORDER BY profile_id, version DESC`,
      [input.profileId ?? null, input.profileId ?? null]
    );
    return rows.map(mapProfile);
  }
}

function mapProfile(row: Record<string, unknown>): StoredCanProfile {
  return {
    profileId: String(row.profile_id), version: Number(row.version), hash: String(row.profile_hash),
    profile: parseJson(String(row.profile_json), {}), capabilities: parseJson(String(row.capabilities_json), {}),
    status: String(row.status) as StoredCanProfile["status"], createdAt: String(row.created_at)
  };
}

function parseJson<T>(value: string, fallback: T): T { try { return JSON.parse(value) as T; } catch { return fallback; } }
