import path from "node:path";
import type { C2000McpConfig } from "../config/config.schema.js";
import { PcanBasicCanBusAdapter } from "../can/pcan/PcanBasicCanBusAdapter.js";
import { CanChannelLeaseManager, type CanChannelLeaseContext } from "../can/CanChannelLeaseManager.js";
import { SqliteStore } from "../storage/SqliteStore.js";
import { DebugMcpError } from "../utils/errors.js";
import type { CanWorkerHeartbeat } from "./CanWorkerHeartbeat.js";

export interface CanWorkerLaunchOptions {
  canWorkerInstanceId: string;
  daemonInstanceId: string;
  authToken: string;
  processStartTime: string;
  adapterIndex: number;
}

export class CanWorkerRuntime {
  private readonly adapter;
  private store?: SqliteStore;
  private leases?: CanChannelLeaseManager;
  private lease?: CanChannelLeaseContext;
  private currentCaptureId?: string;
  private currentJobId?: string;

  constructor(private readonly options: CanWorkerLaunchOptions, private readonly config: C2000McpConfig) {
    const adapterConfig = config.canAdapters?.[options.adapterIndex];
    if (!adapterConfig) throw new DebugMcpError("CanAdapterUnavailable", "CAN worker adapter configuration is missing", { adapterIndex: options.adapterIndex });
    this.adapter = new PcanBasicCanBusAdapter(adapterConfig);
  }

  async start(): Promise<void> {
    const sqlitePath = path.resolve(this.config.storage?.sqlitePath ?? "./runtime/c2000-debugd.sqlite");
    this.store = await SqliteStore.open(sqlitePath);
    this.leases = new CanChannelLeaseManager(this.store);
  }

  async invoke(method: string, argument: any, context?: CanChannelLeaseContext): Promise<Record<string, unknown>> {
    if (method === "info") return { value: this.adapter.info() };
    if (method === "state") return { value: this.adapter.state() };
    if (method === "session") return { value: this.adapter.session() };
    if (method === "captures" || method === "capture") return { value: this.adapter.captures() };
    if (method === "openSession") {
      this.currentJobId = String(argument.jobId);
      const info = this.adapter.info();
      this.lease = this.leases!.acquire({
        adapterId: info.name,
        channel: String(info.channel),
        ownerJobId: this.currentJobId,
        daemonInstanceId: this.options.daemonInstanceId,
        canWorkerInstanceId: this.options.canWorkerInstanceId,
        pid: process.pid,
        processStartTime: this.options.processStartTime,
        ttlMs: 30000
      });
      try {
        return { value: await this.adapter.openSession(argument), leaseContext: this.lease };
      } catch (error) {
        this.leases!.release(this.lease);
        this.lease = undefined;
        throw error;
      }
    }
    this.assertLease(context);
    this.leases!.renew(this.lease!, 30000);
    switch (method) {
      case "send": return { value: await this.adapter.send(argument) };
      case "receive": return { value: await this.adapter.receive(argument) };
      case "startCapture": {
        const value = await this.adapter.startCapture(argument);
        this.currentCaptureId = value.captureId;
        return { value };
      }
      case "stopCapture": {
        const value = await this.adapter.stopCapture();
        this.currentCaptureId = undefined;
        return { value };
      }
      case "receiveFrames": return { value: await this.adapter.receiveFrames(argument) };
      case "waitForFrame": return { value: await this.adapter.waitForFrame(argument) };
      case "getStatistics": return { value: await this.adapter.getStatistics() };
      case "close": {
        try { await this.adapter.close(); }
        finally {
          if (this.lease) this.leases!.release(this.lease);
          this.lease = undefined;
          this.currentJobId = undefined;
          this.currentCaptureId = undefined;
        }
        return { value: null };
      }
      default: throw new DebugMcpError("DaemonProtocolError", `Unsupported CAN worker method: ${method}`);
    }
  }

  heartbeat(): CanWorkerHeartbeat {
    const info = this.adapter.info();
    return {
      canWorkerInstanceId: this.options.canWorkerInstanceId,
      pid: process.pid,
      processStartTime: this.options.processStartTime,
      adapterId: info.name,
      channel: String(info.channel),
      currentJobId: this.currentJobId,
      currentCaptureId: this.currentCaptureId,
      status: this.currentJobId ? "BUSY" : "READY",
      timestamp: new Date().toISOString()
    };
  }

  async stop(): Promise<void> {
    try { await this.adapter.close(); } catch { /* process exit is the final isolation boundary */ }
    if (this.lease) {
      try { this.leases?.release(this.lease); } catch { /* lease expires and fences this worker */ }
    }
    this.store?.close();
  }

  private assertLease(context?: CanChannelLeaseContext): void {
    if (!context || !this.lease || context.leaseId !== this.lease.leaseId) throw new DebugMcpError("LeaseFencingRejected", "CAN worker command has no current channel fencing context");
    this.leases!.validate(context);
  }
}
