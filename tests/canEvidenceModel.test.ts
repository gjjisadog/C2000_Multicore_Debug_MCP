import { describe, expect, it } from "vitest";
import { evaluateCanDirectionEvidence } from "../src/can/CanEvidenceModel.js";
import type { CanCapture, CanFrame } from "../src/can/CanBusAdapter.js";

const frame: CanFrame = { id: 0x321, data: [1, 2, 3], extended: false };
const capture: CanCapture = {
  direction: { sourceBoardId: "board-a", targetBoardId: "board-b" },
  frame,
  timestamp: "2026-01-01T00:00:00.000Z",
  hardwareTimestamp: 1234,
  hostReceivedAt: "2026-01-01T00:00:00.001Z",
  delivery: "OBSERVED_ON_BUS"
};
const tx = { status: "SUPPORTED" as const, txCountDelta: 1, txCanId: frame.id, txPayload: frame.data };
const rx = { status: "SUPPORTED" as const, rxCountDelta: 1, lastRxCanId: frame.id, lastRxPayload: frame.data };

describe("CAN evidence model", () => {
  it("requires firmware TX, independent bus capture, and firmware RX for a full hardware pass", () => {
    expect(evaluateCanDirectionEvidence({
      trafficMode: "firmware-driven", simulation: false, expectedFrame: frame,
      firmwareTx: tx, busCapture: capture, firmwareRx: rx, applicationAssertionsRequested: false
    })).toMatchObject({ passed: true, evidenceLevel: "FULL_HARDWARE_EVIDENCE", delivery: "RECEIVED_BY_PEER" });
  });

  it("does not grant full evidence without bus or peer RX evidence", () => {
    expect(evaluateCanDirectionEvidence({
      trafficMode: "firmware-driven", simulation: false, expectedFrame: frame,
      firmwareTx: tx, firmwareRx: rx, applicationAssertionsRequested: false
    })).toMatchObject({ passed: false, evidenceLevel: "DEBUG_ONLY_EVIDENCE" });
    expect(evaluateCanDirectionEvidence({
      trafficMode: "firmware-driven", simulation: false, expectedFrame: frame,
      firmwareTx: tx, busCapture: capture, applicationAssertionsRequested: false
    })).toMatchObject({ passed: false, evidenceLevel: "BUS_AND_DEBUG_EVIDENCE", delivery: "OBSERVED_ON_BUS" });
  });

  it("never treats adapter-injected traffic as firmware TX", () => {
    expect(evaluateCanDirectionEvidence({
      trafficMode: "adapter-injected", simulation: false, expectedFrame: frame,
      firmwareTx: tx, busCapture: capture, firmwareRx: rx, applicationAssertionsRequested: false
    })).toMatchObject({ passed: false, firmwareTxMatched: false, evidenceLevel: "BUS_AND_DEBUG_EVIDENCE" });
  });

  it("labels mock evidence as simulation and upgrades application delivery explicitly", () => {
    expect(evaluateCanDirectionEvidence({
      trafficMode: "firmware-driven", simulation: true, expectedFrame: frame,
      busCapture: capture, firmwareRx: rx, applicationAssertionsRequested: true, applicationMatched: true
    })).toMatchObject({ passed: true, evidenceLevel: "SIMULATION_EVIDENCE", delivery: "PROCESSED_BY_PEER" });
  });
});
