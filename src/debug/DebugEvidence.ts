import type { CoreId, Cpu2FaultEvidence, EvaluateResult, LoadedProgramInfo, ResolveResult } from "./types.js";

export interface DebugEvidence {
  sessionId: string;
  capturedAt: string;
  cores: Array<{
    coreId: CoreId;
    coreName?: string;
    connected?: boolean;
    state?: string;
    pc?: ResolveResult;
    loadedProgramInfo?: LoadedProgramInfo;
    expressions?: EvaluateResult[];
  }>;
  ramOwnership?: unknown;
  runtimeRamOwnership?: unknown;
  elfFreshness?: unknown;
  cpu2FaultEvidence?: Cpu2FaultEvidence;
  commandStats: { total: number; byOperation: Record<string, number> };
}
