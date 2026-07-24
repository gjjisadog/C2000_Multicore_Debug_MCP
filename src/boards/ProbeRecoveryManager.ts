import type { BoardRegistry } from "./BoardRegistry.js";
import type { EventRepository } from "../storage/repositories/EventRepository.js";

export type ProbeOwnerKind = "NO_OWNER" | "OWNED_ACTIVE" | "OWNED_STALE_WORKER" | "OWNED_STALE_DSS" | "EXTERNAL_CCS_OWNER" | "EXTERNAL_DSLITE_OWNER" | "EXTERNAL_DEBUGSERVER_OWNER" | "UNKNOWN_OWNER" | "PID_REUSED";

export interface OwnedProcessIdentity {
  pid: number;
  ppid: number;
  processStartTime: string;
  commandLine: string;
  daemonInstanceId: string;
  workerInstanceId: string;
  boardId: string;
  probeSerial: string;
  identityHash: string;
  kind: "worker" | "dss";
}

export interface ObservedProcess {
  pid: number;
  ppid?: number;
  processStartTime?: string;
  commandLine: string;
  kind: "ccstudio" | "DSLite" | "DebugServer" | "dss.sh" | "c2000-dss" | "worker";
}

export interface ProbeOwnershipReport {
  probeSerial: string;
  kind: ProbeOwnerKind;
  owned: OwnedProcessIdentity[];
  external: ObservedProcess[];
}

/** Safety-first process recovery: no PID is terminated unless every identity field matches. */
export class ProbeRecoveryManager {
  constructor(private readonly options: {
    registry: BoardRegistry;
    events: EventRepository;
    inspect: (probeSerial: string) => Promise<ObservedProcess[]>;
    owned: (probeSerial: string) => Promise<OwnedProcessIdentity[]>;
    terminate?: (process: OwnedProcessIdentity) => Promise<void>;
  }) {}

  async inspectProbeOwnership(probeSerial: string): Promise<ProbeOwnershipReport> {
    const [observed, ledger] = await Promise.all([this.options.inspect(probeSerial), this.options.owned(probeSerial)]);
    const owned = ledger.filter(entry => observed.some(process => identityMatches(entry, process)));
    const external = observed.filter(process => !ledger.some(entry => identityMatches(entry, process)));
    const reused = ledger.some(entry => observed.some(process => entry.pid === process.pid && entry.processStartTime !== process.processStartTime));
    const kind = reused
      ? "PID_REUSED"
      : external.length > 0
        ? classifyExternal(external[0]!)
      : owned.length > 0
        ? "OWNED_ACTIVE"
        : "NO_OWNER";
    return { probeSerial, kind, owned, external };
  }

  async recoverOwnedProbeProcesses(probeSerial: string, dryRun = true): Promise<ProbeOwnershipReport & { recoveredPids: number[]; dryRun: boolean }> {
    const report = await this.inspectProbeOwnership(probeSerial);
    if (report.external.length > 0) {
      await this.quarantineExternalOwner(probeSerial, report);
      return { ...report, recoveredPids: [], dryRun };
    }
    const recoveredPids: number[] = [];
    if (!dryRun) {
      for (const process of report.owned) {
        await this.options.terminate?.(process);
        recoveredPids.push(process.pid);
      }
    }
    this.options.events.append({ level: "info", sourceType: "probe-recovery", sourceId: probeSerial, eventType: "OWNED_PROBE_RECOVERY", payload: { dryRun, ownedPids: report.owned.map(process => process.pid), recoveredPids } });
    return { ...report, recoveredPids, dryRun };
  }

  async quarantineExternalOwner(probeSerial: string, report?: ProbeOwnershipReport): Promise<void> {
    const ownership = report ?? await this.inspectProbeOwnership(probeSerial);
    const board = this.options.registry.list().find(candidate => candidate.probeSerial === probeSerial);
    if (board) this.options.registry.transition(board.boardId, "QUARANTINED", { reason: "EXTERNAL_DEBUG_OWNER", owners: ownership.external });
    this.options.events.append({ level: "warn", sourceType: "probe-recovery", sourceId: probeSerial, boardId: board?.boardId, eventType: "EXTERNAL_DEBUG_OWNER", payload: { kind: ownership.kind, owners: ownership.external } });
  }
}

function identityMatches(owned: OwnedProcessIdentity, observed: ObservedProcess): boolean {
  return owned.pid === observed.pid &&
    owned.ppid === observed.ppid &&
    owned.processStartTime === observed.processStartTime &&
    owned.commandLine === observed.commandLine &&
    observed.commandLine.includes(owned.probeSerial) &&
    observed.commandLine.includes(owned.identityHash);
}

function classifyExternal(process: ObservedProcess): ProbeOwnerKind {
  if (process.kind === "ccstudio") return "EXTERNAL_CCS_OWNER";
  if (process.kind === "DSLite") return "EXTERNAL_DSLITE_OWNER";
  if (process.kind === "DebugServer") return "EXTERNAL_DEBUGSERVER_OWNER";
  return "UNKNOWN_OWNER";
}
