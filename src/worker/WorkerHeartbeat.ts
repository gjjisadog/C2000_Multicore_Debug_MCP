export interface WorkerHeartbeat {
  workerInstanceId: string;
  boardId: string;
  probeSerial: string;
  timestamp: string;
  status: "STARTING" | "READY" | "RUNNING" | "STOPPING" | "FAILED";
  currentCommandId?: string;
  currentJobId?: string;
  currentStepRunId?: string;
  dssProcesses: Record<string, unknown>[];
  lastSuccessfulCommandAt?: string;
}
