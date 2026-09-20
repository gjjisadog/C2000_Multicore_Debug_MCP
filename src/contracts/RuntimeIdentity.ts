export interface RuntimeBuildIdentity {
  version: string;
  sourceRevision: string | null;
  sourceDirty: boolean | null;
  builtAt: string | null;
  devBuildId?: string;
}

export interface RuntimeBuildCompatibility {
  compatible: boolean;
  expected: RuntimeBuildIdentity;
  actual?: Record<string, unknown>;
  mismatches: string[];
}

export function compareRuntimeBuildIdentity(
  expected: RuntimeBuildIdentity,
  value: unknown,
  options: { development?: boolean } = {}
): RuntimeBuildCompatibility {
  const actual = isRecord(value) ? value : undefined;
  const mismatches: string[] = [];
  const development = options.development ?? false;

  if (actual?.version !== expected.version) mismatches.push("version");

  if (development) {
    const expectedDevBuildId = expected.devBuildId;
    const actualDevBuildId = typeof actual?.devBuildId === "string" ? actual.devBuildId : undefined;
    if (expectedDevBuildId !== actualDevBuildId) mismatches.push("devBuildId");
  } else {
    if (expected.sourceRevision !== null && actual?.sourceRevision !== expected.sourceRevision) {
      mismatches.push("sourceRevision");
    }
    if (expected.sourceDirty !== null && actual?.sourceDirty !== expected.sourceDirty) {
      mismatches.push("sourceDirty");
    }
  }

  return {
    compatible: mismatches.length === 0,
    expected: { ...expected },
    ...(actual ? { actual } : {}),
    mismatches
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
