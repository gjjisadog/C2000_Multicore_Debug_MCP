import { randomUUID } from "node:crypto";
import { SqliteStore } from "../storage/SqliteStore.js";
import { DebugMcpError } from "../utils/errors.js";

export interface CanChannelLeaseContext {
  leaseId: string;
  adapterId: string;
  channel: string;
  ownerJobId: string;
  daemonInstanceId: string;
  canWorkerInstanceId: string;
  pid: number;
  processStartTime: string;
  fencingToken: number;
}

interface LeaseRow {
  lease_id: string;
  adapter_id: string;
  channel: string;
  owner_job_id: string;
  daemon_instance_id: string;
  can_worker_instance_id: string;
  pid: number;
  process_start_time: string;
  expires_at: string;
  released_at: string | null;
  fencing_token: number;
}

export class CanChannelLeaseManager {
  constructor(private readonly store: SqliteStore) {}

  acquire(input: Omit<CanChannelLeaseContext, "leaseId" | "fencingToken"> & { ttlMs: number }): CanChannelLeaseContext {
    return this.store.transaction(() => {
      const now = new Date();
      const active = this.store.get<LeaseRow>("SELECT * FROM can_adapter_leases WHERE adapter_id = ? AND channel = ? AND released_at IS NULL", [input.adapterId, input.channel]);
      if (active && Date.parse(active.expires_at) > now.getTime()) {
        throw new DebugMcpError("PcanChannelInUse", "PCAN channel already has an active cross-process lease", {
          adapterId: input.adapterId, channel: input.channel, ownerJobId: active.owner_job_id, canWorkerInstanceId: active.can_worker_instance_id
        });
      }
      if (active) this.store.run("UPDATE can_adapter_leases SET released_at = ? WHERE lease_id = ?", [now.toISOString(), active.lease_id]);
      const fencingToken = Number(this.store.get<{ token: number }>("SELECT MAX(fencing_token) AS token FROM can_adapter_leases WHERE adapter_id = ? AND channel = ?", [input.adapterId, input.channel])?.token ?? 0) + 1;
      const context: CanChannelLeaseContext = { ...input, leaseId: `can-lease-${randomUUID()}`, fencingToken };
      this.store.run(
        "INSERT INTO can_adapter_leases(lease_id, adapter_id, channel, owner_job_id, daemon_instance_id, can_worker_instance_id, pid, process_start_time, acquired_at, renewed_at, expires_at, fencing_token) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [context.leaseId, context.adapterId, context.channel, context.ownerJobId, context.daemonInstanceId, context.canWorkerInstanceId, context.pid, context.processStartTime, now.toISOString(), now.toISOString(), new Date(now.getTime() + input.ttlMs).toISOString(), context.fencingToken]
      );
      return context;
    });
  }

  validate(context: CanChannelLeaseContext): void {
    const row = this.store.get<LeaseRow>("SELECT * FROM can_adapter_leases WHERE lease_id = ?", [context.leaseId]);
    const latest = Number(this.store.get<{ token: number }>("SELECT MAX(fencing_token) AS token FROM can_adapter_leases WHERE adapter_id = ? AND channel = ?", [context.adapterId, context.channel])?.token ?? 0);
    if (!row || row.released_at || Date.parse(row.expires_at) <= Date.now() || row.fencing_token !== context.fencingToken || latest !== context.fencingToken) {
      throw new DebugMcpError("LeaseFencingRejected", "CAN channel lease is missing, expired, released, or fenced", { leaseId: context.leaseId, expectedFencingToken: latest, receivedFencingToken: context.fencingToken });
    }
    if (row.can_worker_instance_id !== context.canWorkerInstanceId || row.pid !== context.pid || row.process_start_time !== context.processStartTime) {
      throw new DebugMcpError("LeaseWorkerMismatch", "CAN channel lease identity does not match the worker process", { leaseId: context.leaseId });
    }
  }

  renew(context: CanChannelLeaseContext, ttlMs: number): void {
    this.validate(context);
    const now = new Date();
    this.store.run("UPDATE can_adapter_leases SET renewed_at = ?, expires_at = ? WHERE lease_id = ?", [now.toISOString(), new Date(now.getTime() + ttlMs).toISOString(), context.leaseId]);
  }

  release(context: CanChannelLeaseContext): void {
    this.validate(context);
    this.store.run("UPDATE can_adapter_leases SET released_at = ? WHERE lease_id = ?", [new Date().toISOString(), context.leaseId]);
  }
}
