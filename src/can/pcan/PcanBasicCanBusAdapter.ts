import { randomUUID } from "node:crypto";
import { DebugMcpError } from "../../utils/errors.js";
import type { CanAdapterInfo, CanAdapterSession, CanAdapterState, CanAdapterStatistics, CanBusAdapter, CanCapture, CanCaptureFilter, CanFrame } from "../CanBusAdapter.js";
import type { PcanBasicDriver } from "./PcanBasicDriver.js";
import { PCAN_BITRATES, PCAN_CHANNELS } from "./PcanBasicConstants.js";
import type { PcanBasicConfiguration } from "./PcanBasicTypes.js";
import { PcanBasicNativeDriver } from "./PcanBasicNativeDriver.js";

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
  private captureStartedAt?: string;
  private captureFinishedAt?: string;
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

  async open(input: { jobId: string; boardIds: string[]; faults: unknown[] }): Promise<void> {
    if (process.platform !== "win32" && !(this.driver.libraryPath?.startsWith("fake:"))) {
      throw new DebugMcpError("PcanPlatformUnsupported", "PCAN-Basic is supported only on Windows", { platform: process.platform, arch: process.arch });
    }
    if (input.faults.length) throw new DebugMcpError("CanTestHookUnsupported", "Physical PCAN mode does not simulate bus faults");
    try {
      await this.driver.initialize(this.channel, this.bitrate);
      this.versionInfo = await this.driver.versions();
      this.opened = true;
      this.cancelled = false;
    } catch (error) {
      throw error;
    }
  }

  async send(input: { sourceBoardId: string; targetBoardId: string; frame: CanFrame }): Promise<CanCapture> {
    this.requireOpen();
    validateFrame(input.frame);
    const status = await this.driver.getStatus(this.channel);
    if (status.busOff) throw new DebugMcpError("PcanBusOff", "PCAN channel is bus-off", { channel: this.config.channel, pcanErrorCode: status.code });
    await this.driver.write(this.channel, { id: input.frame.id, data: [...input.frame.data], extended: input.frame.extended });
    const now = new Date().toISOString();
    const capture: CanCapture = { direction: { sourceBoardId: input.sourceBoardId, targetBoardId: input.targetBoardId }, frame: { ...input.frame, data: [...input.frame.data] }, timestamp: now, hostReceivedAt: now, delivery: "QUEUED_TO_ADAPTER" };
    this.history.push(capture);
    this.trimCapture();
    return capture;
  }

  async receive(input: { sourceBoardId: string; targetBoardId: string; timeoutMs: number }): Promise<CanFrame | undefined> {
    this.requireOpen();
    const deadline = Date.now() + input.timeoutMs;
    while (!this.cancelled && Date.now() <= deadline) {
      const frame = await this.driver.read(this.channel);
      if (frame) return { id: frame.id, data: [...frame.data], extended: frame.extended };
      await new Promise(resolve => setTimeout(resolve, this.config.receivePollIntervalMs ?? 1));
    }
    return undefined;
  }

  async startCapture(input?: { filter?: CanCaptureFilter; signal?: AbortSignal }): Promise<{ captureId: string; startedAt: string }> {
    this.requireOpen();
    input?.signal?.throwIfAborted();
    this.cancelled = false;
    this.captureStartedAt = new Date().toISOString();
    this.captureFinishedAt = undefined;
    return { captureId: `pcan-capture-${randomUUID()}`, startedAt: this.captureStartedAt };
  }

  async stopCapture(): Promise<{ stoppedAt: string; captures: CanCapture[] }> {
    this.captureFinishedAt = new Date().toISOString();
    return { stoppedAt: this.captureFinishedAt, captures: this.captures() };
  }

  async receiveFrames(filter?: CanCaptureFilter): Promise<CanCapture[]> {
    return this.captures().filter(capture => matchesFilter(capture, filter));
  }

  async waitForFrame(input: { filter: CanCaptureFilter; timeoutMs: number; signal?: AbortSignal }): Promise<CanCapture | undefined> {
    this.requireOpen();
    const deadline = Date.now() + input.timeoutMs;
    while (!this.cancelled && Date.now() <= deadline) {
      input.signal?.throwIfAborted();
      const frame = await this.driver.read(this.channel);
      if (frame) {
        const hostReceivedAt = new Date().toISOString();
        const capture: CanCapture = {
          direction: {
            sourceBoardId: input.filter.sourceBoardId ?? "bus",
            targetBoardId: input.filter.targetBoardId ?? "observer"
          },
          frame: { id: frame.id, data: [...frame.data], extended: frame.extended },
          timestamp: hostReceivedAt,
          hostReceivedAt,
          hardwareTimestamp: frame.timestampMicros,
          delivery: "OBSERVED_ON_BUS"
        };
        this.history.push(capture);
        this.trimCapture();
        if (matchesFilter(capture, input.filter)) return { ...capture, direction: { ...capture.direction }, frame: { ...capture.frame, data: [...capture.frame.data] } };
      }
      await new Promise(resolve => setTimeout(resolve, this.config.receivePollIntervalMs ?? 1));
    }
    return undefined;
  }

  async getStatistics(): Promise<CanAdapterStatistics> {
    this.requireOpen();
    const status = await this.driver.getStatus(this.channel);
    const timestamps = this.history
      .filter(item => item.delivery === "OBSERVED_ON_BUS")
      .map(item => item.hardwareTimestamp !== undefined ? item.hardwareTimestamp / 1000 : Date.parse(item.hostReceivedAt ?? item.timestamp));
    const periods = timestamps.slice(1).map((value, index) => value - timestamps[index]!);
    const mean = periods.length ? periods.reduce((sum, value) => sum + value, 0) / periods.length : undefined;
    return {
      captureStartedAt: this.captureStartedAt,
      captureFinishedAt: this.captureFinishedAt,
      frameCount: timestamps.length,
      busWarning: status.busWarning,
      busPassive: status.busPassive,
      busOff: status.busOff,
      ...(mean !== undefined ? {
        framePeriodMs: mean,
        jitterMs: Math.max(...periods.map(value => Math.abs(value - mean)), 0)
      } : {})
    };
  }

  captures(): CanCapture[] { return this.history.map(item => ({ ...item, direction: { ...item.direction }, frame: { ...item.frame, data: [...item.frame.data] } })); }
  capture(): CanCapture[] { return this.captures(); }
  async close(): Promise<void> {
    this.cancelled = true;
    try { if (this.opened) await this.driver.uninitialize(this.channel); }
    finally {
      this.opened = false;
      this.currentSession = undefined;
    }
  }

  private requireOpen(): void { if (!this.opened) throw new DebugMcpError("PcanInitializeFailed", "PCAN channel is not open"); }
  private trimCapture(): void {
    const limit = this.config.captureBufferFrames ?? 100000;
    if (this.history.length > limit) this.history.splice(0, this.history.length - limit);
  }
}

function matchesFilter(capture: CanCapture, filter?: CanCaptureFilter): boolean {
  if (!filter) return true;
  if (filter.id !== undefined && capture.frame.id !== filter.id) return false;
  if (filter.extended !== undefined && capture.frame.extended !== filter.extended) return false;
  if (filter.sourceBoardId && capture.direction.sourceBoardId !== filter.sourceBoardId) return false;
  if (filter.targetBoardId && capture.direction.targetBoardId !== filter.targetBoardId) return false;
  if (filter.startedAt && capture.timestamp < filter.startedAt) return false;
  if (filter.finishedAt && capture.timestamp > filter.finishedAt) return false;
  if (filter.payload && filter.payload.some((value, index) => {
    const mask = filter.payloadMask?.[index] ?? 0xff;
    return ((capture.frame.data[index] ?? -1) & mask) !== (value & mask);
  })) return false;
  return true;
}

function validateFrame(frame: CanFrame): void {
  const maxId = frame.extended ? 0x1fffffff : 0x7ff;
  if (!Number.isInteger(frame.id) || frame.id < 0 || frame.id > maxId || frame.data.length > 8 || frame.data.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
    throw new DebugMcpError("CanProfileInvalid", "PCAN Classical CAN frame is invalid", { frame });
  }
}
