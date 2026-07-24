export interface CanWorkerHeartbeat {
  canWorkerInstanceId: string;
  pid: number;
  processStartTime: string;
  adapterId: string;
  channel: string;
  currentJobId?: string;
  currentCaptureId?: string;
  status: "READY" | "BUSY" | "FAILED";
  timestamp: string;
}
