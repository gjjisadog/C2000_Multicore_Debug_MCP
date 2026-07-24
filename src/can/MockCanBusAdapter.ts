import { DebugMcpError } from "../utils/errors.js";
import { randomUUID } from "node:crypto";
import type { CanAdapterInfo, CanAdapterSession, CanAdapterState, CanBusAdapter, CanCapture, CanFrame } from "./CanBusAdapter.js";
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
    const capture: CanCapture = {
      direction: { sourceBoardId: input.sourceBoardId, targetBoardId: input.targetBoardId },
      frame: cloneFrame(input.frame), timestamp: new Date().toISOString(),
      delivery: offline ? "NODE_OFFLINE" : fault?.kind === "drop" ? "DROPPED" : duplicated ? "DUPLICATED" : "DELIVERED",
      ...(fault ? { fault: fault.name } : {})
    };
    this.history.push(capture);
    if (capture.delivery === "DELIVERED" || capture.delivery === "DUPLICATED") {
      const key = routeKey(input.sourceBoardId, input.targetBoardId);
      const queue = this.queues.get(key) ?? [];
      const delivered = fault?.kind === "crc_error" ? corruptCrc(input.frame) : cloneFrame(input.frame);
      queue.push(delivered);
      if (capture.delivery === "DUPLICATED") queue.push(cloneFrame(delivered));
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
      if (frame) return cloneFrame(frame);
      await new Promise(resolve => setTimeout(resolve, Math.min(10, Math.max(1, deadline - Date.now()))));
    }
    return undefined;
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
function deterministicJitter(count: number, maximum: number): number { return maximum === 0 ? 0 : (count * 17) % (maximum + 1); }
function corruptCrc(frame: CanFrame): CanFrame { return { ...cloneFrame(frame), crc: (frame.crc ?? 0) ^ 0x1 }; }
