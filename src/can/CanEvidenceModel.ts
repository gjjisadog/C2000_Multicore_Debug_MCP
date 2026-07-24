import type { CanCapture, CanDeliveryStatus, CanEvidenceLevel, CanFrame, CanTrafficMode } from "./CanBusAdapter.js";

export interface FirmwareCanEvidence {
  status: "SUPPORTED" | "UNSUPPORTED";
  txCountBefore?: number;
  txCountAfter?: number;
  txCountDelta?: number;
  txSequence?: number;
  txCanId?: number;
  txPayload?: number[];
  txTimestamp?: string;
  txResult?: unknown;
  controllerState?: unknown;
  rxCountBefore?: number;
  rxCountAfter?: number;
  rxCountDelta?: number;
  rxSequence?: number;
  lastRxCanId?: number;
  lastRxPayload?: number[];
  crcErrorCount?: number;
  sequenceErrorCount?: number;
  peerOnline?: unknown;
  applicationState?: unknown;
  processingResult?: unknown;
  missingExpressions?: string[];
}

export interface CanDirectionEvidence {
  trafficMode: CanTrafficMode;
  simulation: boolean;
  expectedFrame: CanFrame;
  firmwareTx?: FirmwareCanEvidence;
  busCapture?: CanCapture;
  firmwareRx?: FirmwareCanEvidence;
  applicationAssertionsRequested: boolean;
  applicationMatched?: boolean;
}

export function evaluateCanDirectionEvidence(input: CanDirectionEvidence): {
  evidenceLevel: CanEvidenceLevel;
  delivery: CanDeliveryStatus;
  firmwareTxMatched: boolean;
  busFrameMatched: boolean;
  firmwareRxMatched: boolean;
  applicationProcessed: boolean;
  passed: boolean;
} {
  const firmwareTxMatched = input.trafficMode !== "adapter-injected" &&
    input.firmwareTx?.status === "SUPPORTED" &&
    (input.firmwareTx.txCountDelta ?? 0) > 0 &&
    input.firmwareTx.txCanId === input.expectedFrame.id &&
    arraysEqual(input.firmwareTx.txPayload, input.expectedFrame.data);
  const busFrameMatched = Boolean(input.busCapture && framesEqual(input.busCapture.frame, input.expectedFrame));
  const firmwareRxMatched = input.firmwareRx?.status === "SUPPORTED" &&
    (input.firmwareRx.rxCountDelta ?? 0) > 0 &&
    input.firmwareRx.lastRxCanId === input.expectedFrame.id &&
    arraysEqual(input.firmwareRx.lastRxPayload, input.expectedFrame.data);
  const applicationProcessed = !input.applicationAssertionsRequested || input.applicationMatched === true;
  const passed = input.simulation
    ? busFrameMatched
    : firmwareTxMatched && busFrameMatched && firmwareRxMatched && applicationProcessed;
  const evidenceLevel: CanEvidenceLevel = input.simulation
    ? "SIMULATION_EVIDENCE"
    : firmwareTxMatched && busFrameMatched && firmwareRxMatched && applicationProcessed
      ? "FULL_HARDWARE_EVIDENCE"
      : busFrameMatched && (firmwareTxMatched || firmwareRxMatched)
        ? "BUS_AND_DEBUG_EVIDENCE"
        : firmwareTxMatched || firmwareRxMatched
          ? "DEBUG_ONLY_EVIDENCE"
          : busFrameMatched
            ? "BUS_ONLY_EVIDENCE"
            : "INSUFFICIENT_EVIDENCE";
  const delivery: CanDeliveryStatus = input.applicationAssertionsRequested && applicationProcessed && firmwareRxMatched
    ? "PROCESSED_BY_PEER"
    : firmwareRxMatched
      ? "RECEIVED_BY_PEER"
      : busFrameMatched
        ? "OBSERVED_ON_BUS"
        : input.busCapture?.delivery ?? "TIMED_OUT";
  return { evidenceLevel, delivery, firmwareTxMatched, busFrameMatched, firmwareRxMatched, applicationProcessed, passed };
}

function framesEqual(left: CanFrame, right: CanFrame): boolean {
  return left.id === right.id && left.extended === right.extended &&
    left.data.length === right.data.length && left.data.every((value, index) => value === right.data[index]);
}
function arraysEqual(actual: number[] | undefined, expected: number[]): boolean {
  return actual !== undefined && actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}
