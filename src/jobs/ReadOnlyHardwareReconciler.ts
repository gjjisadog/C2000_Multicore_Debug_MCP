import { DebugMcpError, toStructuredError } from "../utils/errors.js";

export interface ReadOnlyInspectionEvidence {
  probe: Record<string, unknown>;
  cores: Record<string, unknown>[];
  loadedPrograms: Record<string, unknown>[];
  safety: Record<string, unknown>;
  can: Record<string, unknown>;
  faultHooks: Record<string, unknown>;
}

/**
 * Creates a fresh inspection session and permits target reads only. It never
 * claims that a persisted DSS session was restored.
 */
export class ReadOnlyHardwareReconciler {
  constructor(private readonly inspector: {
    inspectProbe(): Promise<Record<string, unknown>>;
    createFreshInspectionSession(): Promise<{ sessionId: string }>;
    inspect(sessionId: string): Promise<ReadOnlyInspectionEvidence>;
    close(sessionId: string): Promise<void>;
  }) {}

  async reconcile(): Promise<Record<string, unknown>> {
    const stages: Record<string, unknown>[] = [];
    const probe = await this.inspector.inspectProbe();
    stages.push({ stage: "PROBE_OWNERSHIP_INSPECTION", evidence: probe });
    if (probe.externalOwner === true || probe.probeSerialMatched === false) {
      return result("MANUAL_REQUIRED", { probe, stages }, false);
    }
    let sessionId: string | undefined;
    try {
      sessionId = (await this.inspector.createFreshInspectionSession()).sessionId;
      const evidence = await this.inspector.inspect(sessionId);
      stages.push({ stage: "FRESH_SESSION_READ_ONLY_INSPECTION", sessionId, evidence });
      const safe = evidence.safety.safe === true && evidence.probe?.probeSerialMatched !== false;
      stages.push({ stage: "SAFE_RESTART_DECISION", safe });
      return result(safe ? "SAFE_RESTART_FROM_DECLARED_BOUNDARY" : "MANUAL_REQUIRED", { ownershipProbe: probe, ...evidence, stages }, true);
    } catch (error) {
      return result("MANUAL_REQUIRED", { probe, stages, error: toStructuredError(error) }, Boolean(sessionId));
    } finally {
      if (sessionId) {
        try { await this.inspector.close(sessionId); }
        catch (error) { throw new DebugMcpError("SessionClosing", "Fresh read-only inspection session could not be closed", { sessionId, cause: toStructuredError(error) }); }
      }
    }
  }
}

function result(decision: string, evidence: Record<string, unknown>, created: boolean): Record<string, unknown> {
  return {
    reconciliationMode: "READ_ONLY_HARDWARE_INSPECTION",
    oldSessionRestored: false,
    newInspectionSessionCreated: created,
    decision,
    evidence
  };
}
