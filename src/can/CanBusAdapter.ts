import type { CanFaultScenario } from "./CanProfileSchema.js";

export interface CanFrame {
  id: number;
  data: number[];
  extended: boolean;
  sequence?: number;
  crc?: number;
}

export interface CanCapture {
  direction: { sourceBoardId: string; targetBoardId: string };
  frame: CanFrame;
  timestamp: string;
  delivery: "DELIVERED" | "DROPPED" | "DUPLICATED" | "NODE_OFFLINE";
  fault?: string;
}

export interface CanAdapterInfo {
  name: string;
  /** True only when an external physical-bus capture path independently observes frames. */
  independentBusVerification: boolean;
  availability: "available" | "unavailable";
  transport: "mock" | "hardware";
  reason?: string;
  channel?: string;
  bitrate?: number;
  libraryPath?: string;
  dllVersion?: string;
  driverVersion?: string;
  platform?: string;
  architecture?: string;
}

export interface CanAdapterSession {
  sessionId: string;
  jobId: string;
  boardIds: string[];
  openedAt: string;
}

export interface CanAdapterState {
  opened: boolean;
  captureActive: boolean;
  offlineBoardIds: string[];
  captureCount: number;
}

export interface CanBusAdapter {
  /** `mock` is simulation-only; `hardware` must correspond to a physical bus adapter. */
  readonly kind: "mock" | "hardware";
  readonly name: string;
  readonly independentBusVerification: boolean;
  info(): CanAdapterInfo;
  /** Opens a named adapter session; it never creates or controls board power. */
  openSession(input: { jobId: string; boardIds: string[]; faults: CanFaultScenario[] }): Promise<CanAdapterSession>;
  session(): CanAdapterSession | undefined;
  state(): CanAdapterState;
  open(input: { jobId: string; boardIds: string[]; faults: CanFaultScenario[] }): Promise<void>;
  send(input: { sourceBoardId: string; targetBoardId: string; frame: CanFrame }): Promise<CanCapture>;
  receive(input: { sourceBoardId: string; targetBoardId: string; timeoutMs: number }): Promise<CanFrame | undefined>;
  captures(): CanCapture[];
  capture(): CanCapture[];
  close(): Promise<void>;
}
