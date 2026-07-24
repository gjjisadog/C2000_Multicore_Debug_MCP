import { DebugMcpError } from "../utils/errors.js";
import type { CanBusAdapter, CanCapture, CanFrame } from "./CanBusAdapter.js";
import type { CanFaultScenario } from "./CanProfileSchema.js";

/** Deterministic in-process bus used only for CI and profile validation. */
export class MockCanBusAdapter implements CanBusAdapter {
  readonly kind = "mock" as const;
  private readonly queues = new Map<string, CanFrame[]>();
  private readonly history: CanCapture[] = [];
  private faults: CanFaultScenario[] = [];
  private sentCount = 0;
  private opened = false;

  async open(input: { jobId: string; boardIds: string[]; faults: CanFaultScenario[] }): Promise<void> {
    if (new Set(input.boardIds).size !== input.boardIds.length) throw new DebugMcpError("CanProfileInvalid", "CAN adapter received duplicate board endpoints");
    this.faults = input.faults;
    this.opened = true;
  }

  async send(input: { sourceBoardId: string; targetBoardId: string; frame: CanFrame }): Promise<CanCapture> {
    this.requireOpen();
    this.sentCount += 1;
    const fault = this.matchFault(input.sourceBoardId, input.targetBoardId);
    if (fault?.kind === "bus_off") {
      throw new DebugMcpError("CanBusFaultInjected", `Mock CAN bus-off fault: ${fault.name}`, { fault, ...input });
    }
    if (fault?.kind === "delay" && fault.delayMs) await new Promise(resolve => setTimeout(resolve, fault.delayMs));
    const capture: CanCapture = {
      direction: { sourceBoardId: input.sourceBoardId, targetBoardId: input.targetBoardId },
      frame: cloneFrame(input.frame), timestamp: new Date().toISOString(),
      delivery: fault?.kind === "drop" ? "DROPPED" : "DELIVERED",
      ...(fault ? { fault: fault.name } : {})
    };
    this.history.push(capture);
    if (capture.delivery === "DELIVERED") {
      const key = routeKey(input.sourceBoardId, input.targetBoardId);
      const queue = this.queues.get(key) ?? [];
      queue.push(cloneFrame(input.frame));
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

  async close(): Promise<void> {
    this.opened = false;
    this.queues.clear();
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
function cloneFrame(frame: CanFrame): CanFrame { return { id: frame.id, data: [...frame.data], extended: frame.extended }; }
