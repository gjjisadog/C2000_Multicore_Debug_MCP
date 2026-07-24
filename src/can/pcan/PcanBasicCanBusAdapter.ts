import { randomUUID } from "node:crypto";
import { DebugMcpError } from "../../utils/errors.js";
import type { CanAdapterInfo, CanAdapterSession, CanAdapterState, CanBusAdapter, CanCapture, CanFrame } from "../CanBusAdapter.js";
import type { PcanBasicDriver } from "./PcanBasicDriver.js";
import { PCAN_BITRATES, PCAN_CHANNELS } from "./PcanBasicConstants.js";
import type { PcanBasicConfiguration } from "./PcanBasicTypes.js";
import { PcanBasicNativeDriver } from "./PcanBasicNativeDriver.js";

const channelOwners = new Map<number, string>();

export class PcanBasicCanBusAdapter implements CanBusAdapter {
  readonly kind = "hardware" as const;
  readonly name: string;
  readonly independentBusVerification = true;
  private readonly channel: number;
  private readonly bitrate: number;
  private readonly history: CanCapture[] = [];
  private currentSession?: CanAdapterSession;
  private opened = false;
  private cancelled = false;
  private versionInfo: { dllVersion?: string; driverVersion?: string } = {};

  constructor(
    private readonly config: PcanBasicConfiguration,
    private readonly driver: PcanBasicDriver = new PcanBasicNativeDriver(config.libraryPath)
  ) {
    this.name = config.adapterId;
    this.channel = PCAN_CHANNELS[config.channel] ?? -1;
    this.bitrate = PCAN_BITRATES[config.bitrate] ?? -1;
    if (this.channel < 0 || this.bitrate < 0) throw new DebugMcpError("CanProfileInvalid", "Unsupported PCAN channel or bitrate", { channel: config.channel, bitrate: config.bitrate });
  }

  info(): CanAdapterInfo {
    return {
      name: this.name,
      independentBusVerification: true,
      availability: process.platform === "win32" ? "available" : "unavailable",
      transport: "hardware",
      channel: this.config.channel,
      bitrate: this.config.bitrate,
      ...(this.driver.libraryPath ? { libraryPath: this.driver.libraryPath } : {}),
      ...this.versionInfo,
      platform: process.platform,
      architecture: process.arch,
      reason: process.platform === "win32"
        ? `${this.config.channel} at ${this.config.bitrate} bit/s; ${this.driver.libraryPath ?? this.config.libraryPath ?? "library pending resolution"}`
        : `PCAN-Basic is unsupported on ${process.platform}/${process.arch}`
    };
  }

  async openSession(input: { jobId: string; boardIds: string[]; faults: never[] }): Promise<CanAdapterSession> {
    await this.open(input);
    this.currentSession = { sessionId: `pcan-${randomUUID()}`, jobId: input.jobId, boardIds: [...input.boardIds], openedAt: new Date().toISOString() };
    return this.currentSession;
  }
  session(): CanAdapterSession | undefined { return this.currentSession && { ...this.currentSession, boardIds: [...this.currentSession.boardIds] }; }
  state(): CanAdapterState { return { opened: this.opened, captureActive: this.opened && !this.cancelled, offlineBoardIds: [], captureCount: this.history.length }; }

  async open(input: { jobId: string; faults: unknown[] }): Promise<void> {
    if (process.platform !== "win32" && !(this.driver.libraryPath?.startsWith("fake:"))) {
      throw new DebugMcpError("PcanPlatformUnsupported", "PCAN-Basic is supported only on Windows", { platform: process.platform, arch: process.arch });
    }
    if (input.faults.length) throw new DebugMcpError("CanTestHookUnsupported", "Physical PCAN mode does not simulate bus faults");
    const owner = channelOwners.get(this.channel);
    if (owner && owner !== input.jobId) throw new DebugMcpError("PcanChannelInUse", "PCAN channel is already leased", { channel: this.config.channel, ownerJobId: owner });
    channelOwners.set(this.channel, input.jobId);
    try {
      await this.driver.initialize(this.channel, this.bitrate);
      this.versionInfo = await this.driver.versions();
      this.opened = true;
      this.cancelled = false;
    } catch (error) {
      channelOwners.delete(this.channel);
      throw error;
    }
  }

  async send(input: { sourceBoardId: string; targetBoardId: string; frame: CanFrame }): Promise<CanCapture> {
    this.requireOpen();
    validateFrame(input.frame);
    const status = await this.driver.getStatus(this.channel);
    if (status.busOff) throw new DebugMcpError("PcanBusOff", "PCAN channel is bus-off", { channel: this.config.channel, pcanErrorCode: status.code });
    await this.driver.write(this.channel, { id: input.frame.id, data: [...input.frame.data], extended: input.frame.extended });
    const capture: CanCapture = { direction: { sourceBoardId: input.sourceBoardId, targetBoardId: input.targetBoardId }, frame: { ...input.frame, data: [...input.frame.data] }, timestamp: new Date().toISOString(), delivery: "DELIVERED" };
    this.history.push(capture);
    this.trimCapture();
    return capture;
  }

  async receive(input: { timeoutMs: number }): Promise<CanFrame | undefined> {
    this.requireOpen();
    const deadline = Date.now() + input.timeoutMs;
    while (!this.cancelled && Date.now() <= deadline) {
      const frame = await this.driver.read(this.channel);
      if (frame) return { id: frame.id, data: [...frame.data], extended: frame.extended };
      await new Promise(resolve => setTimeout(resolve, this.config.receivePollIntervalMs ?? 1));
    }
    return undefined;
  }

  captures(): CanCapture[] { return this.history.map(item => ({ ...item, direction: { ...item.direction }, frame: { ...item.frame, data: [...item.frame.data] } })); }
  capture(): CanCapture[] { return this.captures(); }
  async close(): Promise<void> {
    this.cancelled = true;
    try { if (this.opened) await this.driver.uninitialize(this.channel); }
    finally {
      this.opened = false;
      this.currentSession = undefined;
      channelOwners.delete(this.channel);
    }
  }

  private requireOpen(): void { if (!this.opened) throw new DebugMcpError("PcanInitializeFailed", "PCAN channel is not open"); }
  private trimCapture(): void {
    const limit = this.config.captureBufferFrames ?? 100000;
    if (this.history.length > limit) this.history.splice(0, this.history.length - limit);
  }
}

function validateFrame(frame: CanFrame): void {
  const maxId = frame.extended ? 0x1fffffff : 0x7ff;
  if (!Number.isInteger(frame.id) || frame.id < 0 || frame.id > maxId || frame.data.length > 8 || frame.data.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
    throw new DebugMcpError("CanProfileInvalid", "PCAN Classical CAN frame is invalid", { frame });
  }
}
