import { DebugMcpError } from "../utils/errors.js";
import type { CanBusAdapter, CanCapture, CanFrame } from "./CanBusAdapter.js";
import type { CanFaultScenario } from "./CanProfileSchema.js";

/** Fails closed until an integration supplies a real USB/CAN, PCAN, Vector, or firmware-backed adapter. */
export class UnavailableCanBusAdapter implements CanBusAdapter {
  readonly kind = "hardware" as const;
  async open(_input: { jobId: string; boardIds: string[]; faults: CanFaultScenario[] }): Promise<void> {
    throw new DebugMcpError("CanAdapterUnavailable", "No physical CAN bus adapter is configured; use adapter=mock only for simulation", { required: "CanBusAdapter" });
  }
  async send(_input: { sourceBoardId: string; targetBoardId: string; frame: CanFrame }): Promise<CanCapture> { throw unavailable(); }
  async receive(_input: { sourceBoardId: string; targetBoardId: string; timeoutMs: number }): Promise<CanFrame | undefined> { throw unavailable(); }
  captures(): CanCapture[] { return []; }
  async close(): Promise<void> {}
}

function unavailable(): DebugMcpError { return new DebugMcpError("CanAdapterUnavailable", "No physical CAN bus adapter is configured"); }
