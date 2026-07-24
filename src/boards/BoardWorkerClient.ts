import type { BoardWorkerLaunchOptions } from "../worker/BoardWorkerRuntime.js";
import type { WorkerHeartbeat } from "../worker/WorkerHeartbeat.js";

export interface BoardWorkerClient {
  readonly workerInstanceId: string;
  readonly boardId: string;
  readonly probeSerial: string;
  readonly pid?: number;
  readonly processStartTime: string;
  lastHeartbeatAt?: number;
  onHeartbeat?: (heartbeat: WorkerHeartbeat) => void;
  start(): Promise<void>;
  invokeTool(toolName: string, input: unknown, timeoutMs: number): Promise<Record<string, unknown>>;
  stop(timeoutMs?: number): Promise<void>;
}

export type BoardWorkerFactory = (options: BoardWorkerLaunchOptions, config: unknown) => BoardWorkerClient;
