import { DebugMcpError } from "../../utils/errors.js";
import type { PcanBasicDriver } from "./PcanBasicDriver.js";
import type { PcanDriverFrame, PcanStatus } from "./PcanBasicTypes.js";

export class FakePcanBasicDriver implements PcanBasicDriver {
  readonly libraryPath = "fake://PCANBasic.dll";
  readonly writes: PcanDriverFrame[] = [];
  readonly reads: PcanDriverFrame[] = [];
  initialized = false;
  status: PcanStatus = { code: 0, busWarning: false, busPassive: false, busOff: false };
  initializeError?: Error;

  async initialize(): Promise<void> { if (this.initializeError) throw this.initializeError; this.initialized = true; }
  async uninitialize(): Promise<void> { this.initialized = false; }
  async reset(): Promise<void> { this.status = { code: 0, busWarning: false, busPassive: false, busOff: false }; }
  async getStatus(): Promise<PcanStatus> { return { ...this.status }; }
  async write(_channel: number, frame: PcanDriverFrame): Promise<void> {
    if (!this.initialized) throw new DebugMcpError("PcanWriteFailed", "Fake PCAN channel is closed");
    if (this.status.busOff) throw new DebugMcpError("PcanBusOff", "Fake PCAN channel is bus-off");
    this.writes.push({ ...frame, data: [...frame.data] });
  }
  async read(): Promise<PcanDriverFrame | undefined> {
    const frame = this.reads.shift();
    return frame ? { ...frame, data: [...frame.data] } : undefined;
  }
  async getErrorText(errorCode: number): Promise<string> { return `Fake PCAN error 0x${errorCode.toString(16)}`; }
  async versions(): Promise<{ dllVersion: string; driverVersion: string }> { return { dllVersion: "fake", driverVersion: "fake" }; }
}
