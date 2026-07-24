import { DebugMcpError } from "../utils/errors.js";
import { randomUUID } from "node:crypto";
import type { CanAdapterInfo, CanAdapterSession, CanAdapterState, CanAdapterStatistics, CanBusAdapter, CanCapture, CanCaptureFilter, CanFrame } from "./CanBusAdapter.js";
import type { CanFaultScenario } from "./CanProfileSchema.js";

/** Deterministic in-process bus used only for CI and profile validation. */
export class MockCanBusAdapter implements CanBusAdapter {
  readonly kind = "mock" as const;
  readonly name = "deterministic-mock-can";
  readonly independentBusVerification = false;
  private readonly queues = new Map<string, CanFrame[]>();
  private readonly history: CanCapture[] = [];
  private faults: CanFaultScenario[] = [];
  private sentCount = 0;
  private opened = false;
  private currentSession?: CanAdapterSession;
  private readonly offlineBoards = new Set<string>();
  private captureStartedAt?: string;
  private captureFinishedAt?: string;

  info(): CanAdapterInfo {
    return { name: this.name, independentBusVerification: this.independentBusVerification, availability: "available", transport: "mock", reason: "Simulation adapter; no physical CAN capture is available" };
  }

  async openSession(input: { jobId: string; boardIds: string[]; faults: CanFaultScenario[] }): Promise<CanAdapterSession> {
    await this.open(input);
    this.currentSession = { sessionId: `mock-can-${randomUUID()}`, jobId: input.jobId, boardIds: [...input.boardIds], openedAt: new Date().toISOString() };
    return this.currentSession;
  }

  session(): CanAdapterSession | undefined { return this.currentSession ? { ...this.currentSession, boardIds: [...this.currentSession.boardIds] } : undefined; }
  state(): CanAdapterState { return { opened: this.opened, captureActive: this.opened, offlineBoardIds: [...this.offlineBoards].sort(), captureCount: this.history.length }; }

  async open(input: { jobId: string; boardIds: string[]; faults: CanFaultScenario[] }): Promise<void> {
    if (new Set(input.boardIds).size !== input.boardIds.length) throw new DebugMcpError("CanProfileInvalid", "CAN adapter received duplicate board endpoints");
    this.faults = input.faults;
    this.opened = true;
    this.offlineBoards.clear();
  }

  async send(input: { sourceBoardId: string; targetBoardId: string; frame: CanFrame }): Promise<CanCapture> {
    this.requireOpen();
    this.sentCount += 1;
    const fault = this.matchFault(input.sourceBoardId, input.targetBoardId);
    if (fault?.kind === "bus_off") {
      throw new DebugMcpError("CanBusFaultInjected", `Mock CAN bus-off fault: ${fault.name}`, { fault, ...input });
    }
    if (fault?.kind === "node_leave") this.offlineBoards.add(input.targetBoardId);
    if (fault?.kind === "node_rejoin") this.offlineBoards.delete(input.targetBoardId);
    const delayMs = fault?.kind === "delay" ? (fault.delayMs ?? 0) : fault?.kind === "jitter" ? deterministicJitter(this.sentCount, fault.jitterMs ?? fault.delayMs ?? 0) : 0;
    if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
    const offline = this.offlineBoards.has(input.sourceBoardId) || this.offlineBoards.has(input.targetBoardId);
    const duplicated = fault?.kind === "duplicate";
    const now = new Date().toISOString();
    const capture: CanCapture = {
      direction: { sourceBoardId: input.sourceBoardId, targetBoardId: input.targetBoardId },
      frame: cloneFrame(input.frame), timestamp: now, hostReceivedAt: now,
      delivery: offline || fault?.kind === "drop" ? "DROPPED" : "QUEUED_TO_ADAPTER",
      ...(fault ? { fault: fault.name } : {})
    };
    this.history.push(capture);
    if (capture.delivery === "QUEUED_TO_ADAPTER") {
      const key = routeKey(input.sourceBoardId, input.targetBoardId);
      const queue = this.queues.get(key) ?? [];
      const delivered = fault?.kind === "crc_error" ? corruptCrc(input.frame) : cloneFrame(input.frame);
      queue.push(delivered);
      if (duplicated) queue.push(cloneFrame(delivered));
      this.queues.set(key, queue);
    }
    return capture;
  }

  async receive(input: { sourceBoardId: string; targetBoardId: string; timeoutMs: number }): Promise<CanFrame | undefined> {
    this.requireOpen();
    const deadline = Date.now() + input.timeoutMs;
    const key = routeKey(input.sourceBoardId, input.targetBoardId);
    while (Date.now() <= deadline) {
      const frame = this.queues.get(key)?.shift();
      if (frame) {
        const capture = [...this.history].reverse().find(item =>
          item.direction.sourceBoardId === input.sourceBoardId &&
          item.direction.targetBoardId === input.targetBoardId &&
          item.delivery === "QUEUED_TO_ADAPTER" &&
          framesEqual(item.frame, frame)
        );
        if (capture) capture.delivery = "OBSERVED_ON_BUS";
        return cloneFrame(frame);
      }
      await new Promise(resolve => setTimeout(resolve, Math.min(10, Math.max(1, deadline - Date.now()))));
    }
    return undefined;
  }

  async startCapture(input?: { filter?: CanCaptureFilter; signal?: AbortSignal }): Promise<{ captureId: string; startedAt: string }> {
    this.requireOpen();
    input?.signal?.throwIfAborted();
    this.captureStartedAt = new Date().toISOString();
    this.captureFinishedAt = undefined;
    return { captureId: `mock-capture-${randomUUID()}`, startedAt: this.captureStartedAt };
  }

  async stopCapture(): Promise<{ stoppedAt: string; captures: CanCapture[] }> {
    this.captureFinishedAt = new Date().toISOString();
    return { stoppedAt: this.captureFinishedAt, captures: this.captures() };
  }

  async receiveFrames(filter?: CanCaptureFilter): Promise<CanCapture[]> {
    return this.captures().filter(capture => matchesFilter(capture, filter));
  }

  async waitForFrame(input: { filter: CanCaptureFilter; timeoutMs: number; signal?: AbortSignal }): Promise<CanCapture | undefined> {
    const deadline = Date.now() + input.timeoutMs;
    while (Date.now() <= deadline) {
      input.signal?.throwIfAborted();
      const capture = [...this.history].reverse().find(item => item.delivery !== "DROPPED" && matchesFilter(item, input.filter));
      if (capture) {
        capture.delivery = "OBSERVED_ON_BUS";
        return cloneCapture(capture);
      }
      await new Promise(resolve => setTimeout(resolve, Math.min(10, Math.max(1, deadline - Date.now()))));
    }
    return undefined;
  }

  async getStatistics(): Promise<CanAdapterStatistics> {
    const timestamps = this.history.map(item => Date.parse(item.hostReceivedAt ?? item.timestamp)).filter(Number.isFinite);
    const periods = timestamps.slice(1).map((value, index) => value - timestamps[index]!);
    const mean = periods.length ? periods.reduce((sum, value) => sum + value, 0) / periods.length : undefined;
    return {
      captureStartedAt: this.captureStartedAt,
      captureFinishedAt: this.captureFinishedAt,
      frameCount: this.history.length,
      busWarning: false,
      busPassive: false,
      busOff: false,
      ...(mean !== undefined ? {
        framePeriodMs: mean,
        jitterMs: Math.max(...periods.map(value => Math.abs(value - mean)), 0)
      } : {})
    };
  }

  captures(): CanCapture[] { return this.history.map(capture => ({ ...capture, frame: cloneFrame(capture.frame), direction: { ...capture.direction } })); }
  capture(): CanCapture[] { return this.captures(); }

  async close(): Promise<void> {
    this.opened = false;
    this.queues.clear();
    this.offlineBoards.clear();
    this.currentSession = undefined;
  }

  private matchFault(sourceBoardId: string, targetBoardId: string): CanFaultScenario | undefined {
    return this.faults.find(fault =>
      (!fault.sourceBoardId || fault.sourceBoardId === sourceBoardId) &&
      (!fault.targetBoardId || fault.targetBoardId === targetBoardId) &&
      (!fault.everyNth || this.sentCount % fault.everyNth === 0)
    );
  }

  private requireOpen(): void {
    if (!this.opened) throw new DebugMcpError("CanAdapterUnavailable", "Mock CAN adapter is not open");
  }
}

function routeKey(sourceBoardId: string, targetBoardId: string): string { return `${sourceBoardId}\u0000${targetBoardId}`; }
function cloneFrame(frame: CanFrame): CanFrame { return { id: frame.id, data: [...frame.data], extended: frame.extended, ...(frame.sequence !== undefined ? { sequence: frame.sequence } : {}), ...(frame.crc !== undefined ? { crc: frame.crc } : {}) }; }
function cloneCapture(capture: CanCapture): CanCapture { return { ...capture, frame: cloneFrame(capture.frame), direction: { ...capture.direction } }; }
function framesEqual(left: CanFrame, right: CanFrame): boolean { return left.id === right.id && left.extended === right.extended && left.data.length === right.data.length && left.data.every((value, index) => value === right.data[index]); }
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
function deterministicJitter(count: number, maximum: number): number { return maximum === 0 ? 0 : (count * 17) % (maximum + 1); }
function corruptCrc(frame: CanFrame): CanFrame { return { ...cloneFrame(frame), crc: (frame.crc ?? 0) ^ 0x1 }; }
