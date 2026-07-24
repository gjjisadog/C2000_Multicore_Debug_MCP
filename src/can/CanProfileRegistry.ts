import { createHash } from "node:crypto";
import { DebugMcpError } from "../utils/errors.js";
import { CanProfileRepository, type StoredCanProfile } from "../storage/repositories/CanProfileRepository.js";
import { canAcceptanceProfileSchema, type CanAcceptanceProfile } from "./CanProfileSchema.js";

export interface RegisteredCanProfile extends StoredCanProfile {
  parsed: CanAcceptanceProfile;
}

/** Canonicalizes profile declarations so the job and group can cite immutable evidence. */
export class CanProfileRegistry {
  constructor(private readonly profiles: CanProfileRepository) {}

  register(input: unknown): RegisteredCanProfile {
    const parsed = canAcceptanceProfileSchema.parse(input);
    const hash = stableHash(parsed);
    // Legacy callers did not name profiles. Give those declarations a stable
    // content-addressed identity so unrelated inline submissions can coexist.
    const profileId = parsed.profileId === "inline-can-acceptance" ? `inline-${hash.slice(0, 16)}` : parsed.profileId;
    const version = parsed.version;
    const existing = this.profiles.get(profileId, version);
    if (existing && existing.hash !== hash) {
      throw new DebugMcpError("CanProfileInvalid", "A profile id/version already exists with different content", { profileId, version, existingHash: existing.hash, submittedHash: hash });
    }
    const stored = existing ?? this.profiles.put({
      profileId,
      version,
      hash,
      profile: { ...parsed, profileId } as unknown as Record<string, unknown>,
      capabilities: profileCapabilities(parsed),
      status: "ACTIVE"
    });
    return { ...stored, parsed: canAcceptanceProfileSchema.parse(stored.profile) };
  }

  list(input: { profileId?: string; includeRetired?: boolean } = {}): StoredCanProfile[] {
    return this.profiles.list(input);
  }

  require(profileId: string, version: number): RegisteredCanProfile {
    const stored = this.profiles.require(profileId, version);
    return { ...stored, parsed: canAcceptanceProfileSchema.parse(stored.profile) };
  }
}

function profileCapabilities(profile: CanAcceptanceProfile): Record<string, unknown> {
  return {
    safetyGateDeclared: profile.safety.gates.length > 0,
    testHooks: profile.testHooks.map(hook => hook.name),
    sequence: profile.evidence.sequence.enabled,
    crc: profile.evidence.crc.enabled,
    heartbeat: profile.evidence.heartbeat.enabled,
    independentBusVerificationRequired: profile.requireIndependentBusVerification
  };
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(sortValue(value))).digest("hex");
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, sortValue(item)]));
  }
  return value;
}
