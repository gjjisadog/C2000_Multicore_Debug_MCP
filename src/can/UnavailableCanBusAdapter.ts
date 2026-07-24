import { DebugMcpError } from "../utils/errors.js";
import type { CanAdapterInfo, CanAdapterSession, CanAdapterState, CanBusAdapter, CanCapture, CanFrame } from "./CanBusAdapter.js";
import type { CanFaultScenario } from "./CanProfileSchema.js";

/** Fails closed until an integration supplies a real USB/CAN, PCAN, Vector, or firmware-backed adapter. */
export class UnavailableCanBusAdapter implements CanBusAdapter {
  readonly kind = "hardware" as const;
  readonly name: string = "unavailable-hardware-can";
  readonly independentBusVerification: boolean = false;
  info(): CanAdapterInfo {
    return { name: this.name, independentBusVerification: this.independentBusVerification, availability: "unavailable", transport: "hardware", reason: "No physical CAN bus adapter is configured" };
  }
  async openSession(_input: { jobId: string; boardIds: string[]; faults: CanFaultScenario[] }): Promise<CanAdapterSession> { throw unavailable(); }
  session(): CanAdapterSession | undefined { return undefined; }
  state(): CanAdapterState { return { opened: false, captureActive: false, offlineBoardIds: [], captureCount: 0 }; }
  async open(_input: { jobId: string; boardIds: string[]; faults: CanFaultScenario[] }): Promise<void> {
    throw new DebugMcpError("CanAdapterUnavailable", "No physical CAN bus adapter is configured; use adapter=mock only for simulation", { required: "CanBusAdapter" });
  }
  async send(_input: { sourceBoardId: string; targetBoardId: string; frame: CanFrame }): Promise<CanCapture> { throw unavailable(); }
  async receive(_input: { sourceBoardId: string; targetBoardId: string; timeoutMs: number }): Promise<CanFrame | undefined> { throw unavailable(); }
  captures(): CanCapture[] { return []; }
  capture(): CanCapture[] { return []; }
  async close(): Promise<void> {}
}

function unavailable(): DebugMcpError { return new DebugMcpError("CanAdapterUnavailable", "No physical CAN bus adapter is configured"); }
