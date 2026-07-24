import type { CanFaultScenario } from "./CanProfileSchema.js";

export interface CanFrame {
  id: number;
  data: number[];
  extended: boolean;
}

export interface CanCapture {
  direction: { sourceBoardId: string; targetBoardId: string };
  frame: CanFrame;
  timestamp: string;
  delivery: "DELIVERED" | "DROPPED";
  fault?: string;
}

export interface CanBusAdapter {
  /** `mock` is simulation-only; `hardware` must correspond to a physical bus adapter. */
  readonly kind: "mock" | "hardware";
  open(input: { jobId: string; boardIds: string[]; faults: CanFaultScenario[] }): Promise<void>;
  send(input: { sourceBoardId: string; targetBoardId: string; frame: CanFrame }): Promise<CanCapture>;
  receive(input: { sourceBoardId: string; targetBoardId: string; timeoutMs: number }): Promise<CanFrame | undefined>;
  captures(): CanCapture[];
  close(): Promise<void>;
}
