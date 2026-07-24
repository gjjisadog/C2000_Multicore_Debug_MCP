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
  /** Backward-compatible host timestamp. Prefer hardwareTimestamp + hostReceivedAt. */
  timestamp: string;
  hardwareTimestamp?: number;
  hostReceivedAt?: string;
  delivery: CanDeliveryStatus;
  fault?: string;
}

export type CanDeliveryStatus =
  | "REQUESTED"
  | "QUEUED_TO_ADAPTER"
  | "OBSERVED_ON_BUS"
  | "RECEIVED_BY_PEER"
  | "PROCESSED_BY_PEER"
  | "DROPPED"
  | "TIMED_OUT"
  | "BUS_ERROR"
  | "UNKNOWN";

export type CanTrafficMode = "firmware-driven" | "adapter-injected" | "passive-capture";
export type CanEvidenceLevel =
  | "FULL_HARDWARE_EVIDENCE"
  | "BUS_AND_DEBUG_EVIDENCE"
  | "DEBUG_ONLY_EVIDENCE"
  | "BUS_ONLY_EVIDENCE"
  | "INSUFFICIENT_EVIDENCE"
  | "SIMULATION_EVIDENCE";

export interface CanCaptureFilter {
  id?: number;
  extended?: boolean;
  payloadMask?: number[];
  payload?: number[];
  startedAt?: string;
  finishedAt?: string;
  minimumCount?: number;
  sourceBoardId?: string;
  targetBoardId?: string;
}

export interface CanAdapterStatistics {
  captureStartedAt?: string;
  captureFinishedAt?: string;
  frameCount: number;
  busWarning: boolean;
  busPassive: boolean;
  busOff: boolean;
  framePeriodMs?: number;
  jitterMs?: number;
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
  startCapture(input?: { filter?: CanCaptureFilter; signal?: AbortSignal }): Promise<{ captureId: string; startedAt: string }>;
  stopCapture(): Promise<{ stoppedAt: string; captures: CanCapture[] }>;
  receiveFrames(filter?: CanCaptureFilter): Promise<CanCapture[]>;
  waitForFrame(input: { filter: CanCaptureFilter; timeoutMs: number; signal?: AbortSignal }): Promise<CanCapture | undefined>;
  getStatistics(): Promise<CanAdapterStatistics>;
  captures(): CanCapture[];
  capture(): CanCapture[];
  close(): Promise<void>;
}
