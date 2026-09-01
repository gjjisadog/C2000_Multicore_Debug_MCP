import { classifyDebugFailure } from "../debug/DebugFailureClassifier.js";
import { toStructuredError } from "../utils/errors.js";
import type { OutcomeFailureClass } from "./OutcomeSchemas.js";

export interface OutcomeFailureClassification {
  failureClass: OutcomeFailureClass;
  stage?: string;
}

/** Adapter from the existing debug failure truth to bounded analytics labels. */
export function classifyOutcomeFailure(input: {
  code?: string;
  message?: string;
  details?: Record<string, unknown>;
}): OutcomeFailureClassification {
  const code = input.code ?? "";
  const message = input.message ?? "";
  const text = `${code} ${message} ${JSON.stringify(input.details ?? {})}`.toLowerCase();
  const feedback = classifyDebugFailure(input);
  const stage = boundedStage(input.details?.stage);

  if (/capability|required|expired|safetyguard|safety-fence/.test(text)) return { failureClass: "capability", ...(stage ? { stage } : {}) };
  if (/expressionwaittimeout|ipc_ready_timeout|ipc readiness timed out/i.test(text) || feedback.failureSignature === "IPC_HANDSHAKE_TIMEOUT") return { failureClass: "ipc-timeout", ...(stage ? { stage } : {}) };
  if (/path|filesystem|file.?not.?found|artifact|ccxml|map/.test(text) && !/programload|program-load/.test(text)) return { failureClass: "filesystem", ...(stage ? { stage } : {}) };
  if (/probe|xds110|dssnotfound|adapternotavailable/.test(text) || feedback.failureSignature === "PROBE_TRANSIENT_UNAVAILABLE") return { failureClass: "probe", ...(stage ? { stage } : {}) };
  if (/worker|heartbeat|daemonunavailable|workerunavailable/.test(text)) return { failureClass: "worker", ...(stage ? { stage } : {}) };
  if (/lease|boardleased|boardlease|fencing/.test(text)) return { failureClass: "board-lease", ...(stage ? { stage } : {}) };
  if (/\bcan\b|pcan|bus.?off|frame.?mismatch/.test(text)) return { failureClass: "can", ...(stage ? { stage } : {}) };
  if (/dlog/.test(text)) return { failureClass: "dlog", ...(stage ? { stage } : {}) };
  if (/erad/.test(text)) return { failureClass: "erad", ...(stage ? { stage } : {}) };
  if (/\bram\b|ownership/.test(text)) return { failureClass: "ram-ownership", ...(stage ? { stage } : {}) };
  if (/flash|destructiveflash|resident/.test(text)) return { failureClass: "flash-protection", ...(stage ? { stage } : {}) };
  if (/program|symbol|load/.test(text) || feedback.failureSignature === "HOST_ARTIFACT_INVALID" || feedback.failureSignature === "PRELOADED_LOAD_SEMANTICS") return { failureClass: "program-load", ...(stage ? { stage } : {}) };
  if (/boot|handoff|startupcontract/.test(text) || feedback.failureSignature === "STARTUP_CONTRACT_INVALID") return { failureClass: "boot-handoff", ...(stage ? { stage } : {}) };
  if (/ipc|timeout/.test(text)) return { failureClass: text.includes("ipc") ? "ipc-timeout" : "connection", ...(stage ? { stage } : {}) };
  if (/expression|symbolnotfound|evaluate/.test(text)) return { failureClass: "expression", ...(stage ? { stage } : {}) };
  if (/connect|disconnect|connection/.test(text)) return { failureClass: "connection", ...(stage ? { stage } : {}) };
  if (/reset|run|halt|state|target/.test(text)) return { failureClass: "core-state", ...(stage ? { stage } : {}) };
  if (/environment|ccs|c2000ware/.test(text)) return { failureClass: "environment", ...(stage ? { stage } : {}) };
  return { failureClass: "unknown", ...(stage ? { stage } : {}) };
}

export function structuredFailure(error: unknown): OutcomeFailureClassification & { code?: string; message?: string; details?: Record<string, unknown> } {
  const structured = toStructuredError(error);
  return {
    ...classifyOutcomeFailure(structured),
    code: structured.code,
    message: structured.message,
    details: structured.details
  };
}

function boundedStage(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return /^[A-Za-z0-9._:-]{1,96}$/.test(normalized) ? normalized : undefined;
}
