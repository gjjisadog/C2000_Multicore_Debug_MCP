export interface OwnedProcessIdentity {
  pid: number;
  processStartTime: string;
  probeSerial: string;
  workerInstanceId: string;
  daemonInstanceId: string;
  commandLineHash: string;
  status?: string;
  [key: string]: unknown;
}

export type ProcessOwnershipDecision = "OWNED_MATCH" | "PID_REUSED" | "PROBE_MISMATCH" | "EXTERNAL_OWNER" | "NOT_FOUND";

/** Identity matching is deliberately strict; PID alone never authorizes termination. */
export class ProbeOwnershipInspector {
  inspect(expected: OwnedProcessIdentity, actual?: Partial<OwnedProcessIdentity>): { decision: ProcessOwnershipDecision; expected: OwnedProcessIdentity; actual?: Partial<OwnedProcessIdentity> } {
    if (!actual) return { decision: "NOT_FOUND", expected };
    if (actual.pid !== expected.pid) return { decision: "EXTERNAL_OWNER", expected, actual };
    if (actual.processStartTime !== expected.processStartTime) return { decision: "PID_REUSED", expected, actual };
    if (actual.probeSerial !== expected.probeSerial) return { decision: "PROBE_MISMATCH", expected, actual };
    if (actual.workerInstanceId !== expected.workerInstanceId || actual.daemonInstanceId !== expected.daemonInstanceId || actual.commandLineHash !== expected.commandLineHash) {
      return { decision: "EXTERNAL_OWNER", expected, actual };
    }
    return { decision: "OWNED_MATCH", expected, actual };
  }
}

export class OwnedProcessLedger {
  private readonly entries = new Map<string, OwnedProcessIdentity>();
  record(identity: OwnedProcessIdentity): void { this.entries.set(key(identity), { ...identity }); }
  list(): OwnedProcessIdentity[] { return [...this.entries.values()].map(item => ({ ...item })); }
}

export class ProbeRecoveryManager {
  constructor(private readonly inspector = new ProbeOwnershipInspector()) {}
  decide(expected: OwnedProcessIdentity, actual?: Partial<OwnedProcessIdentity>): { mayTerminate: boolean; evidence: ReturnType<ProbeOwnershipInspector["inspect"]> } {
    const evidence = this.inspector.inspect(expected, actual);
    return { mayTerminate: evidence.decision === "OWNED_MATCH", evidence };
  }
}

function key(identity: OwnedProcessIdentity): string { return `${identity.pid}:${identity.processStartTime}:${identity.probeSerial}`; }
