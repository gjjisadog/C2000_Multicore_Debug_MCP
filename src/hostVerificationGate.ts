import { assertAcceptanceEvidence } from "./debug/boundary.js";

export type HostVerificationStepStatus = "passed" | "failed" | "blocked";

export interface HostVerificationStepResult {
  name: string;
  command: string;
  exitCode: number;
  status: HostVerificationStepStatus;
  stdoutTail?: string;
  stderrTail?: string;
  readinessJson?: Record<string, any>;
}

export interface HostVerificationGateEvaluation {
  success: boolean;
  hostChecksPassed: boolean;
  acceptanceEvidenceValid: boolean;
  acceptanceEvidenceError?: string;
  readyForHardwareAcceptance: boolean;
  readinessBlocked: boolean;
  steps: Array<Omit<HostVerificationStepResult, "readinessJson">>;
  readinessJson?: Record<string, any>;
  debugProcessDetails?: unknown;
  uiIndependenceEvidence?: unknown;
  acceptanceEvidence?: unknown;
  nextCommand?: unknown;
  exitCode: 0 | 1 | 2;
}

export function evaluateHostVerificationGate(results: HostVerificationStepResult[]): HostVerificationGateEvaluation {
  const readinessResult = results.find(step => step.name === "hardware-acceptance-readiness");
  const readinessJson = readinessResult?.readinessJson;
  const nonReadinessStepsPassed = results
    .filter(step => step.name !== "hardware-acceptance-readiness")
    .every(step => step.status === "passed");
  const mcpSmokeRan = results.some(step => step.name === "mcp-stdio-smoke");
  const readinessReport = readinessJson?.readiness && typeof readinessJson.readiness === "object"
    ? readinessJson.readiness as Record<string, any>
    : readinessJson?.acceptanceReadiness && typeof readinessJson.acceptanceReadiness === "object"
      ? readinessJson.acceptanceReadiness as Record<string, any>
    : readinessJson;
  const debugProcessDetails = readinessReport?.preflight?.debugProcessDetails;
  const uiIndependenceEvidence = readinessReport?.uiIndependenceEvidence;
  const acceptanceEvidence = readinessReport?.acceptanceEvidence;
  const readinessSkippedWithoutHardware = readinessJson?.status === "SKIPPED_NO_HARDWARE"
    && readinessJson.targetAccessAttempted === false;
  const acceptanceEvidenceResult = readinessSkippedWithoutHardware && mcpSmokeRan
    ? { valid: true, error: undefined }
    : evaluateAcceptanceEvidence(acceptanceEvidence, readinessResult !== undefined);
  const hostChecksPassed = nonReadinessStepsPassed && mcpSmokeRan && acceptanceEvidenceResult.valid;
  const readyForHardwareAcceptance = readinessReport?.readyForHardwareAcceptance === true;
  const readinessBlocked = hostChecksPassed
    && (readinessResult?.status === "blocked" || readinessSkippedWithoutHardware)
    && !readyForHardwareAcceptance;
  const success = hostChecksPassed && readyForHardwareAcceptance;

  return {
    success,
    hostChecksPassed,
    acceptanceEvidenceValid: acceptanceEvidenceResult.valid,
    acceptanceEvidenceError: acceptanceEvidenceResult.error,
    readyForHardwareAcceptance,
    readinessBlocked,
    steps: results.map(({ readinessJson: _readinessJson, ...step }) => step),
    readinessJson,
    debugProcessDetails,
    uiIndependenceEvidence,
    acceptanceEvidence,
    nextCommand: readinessReport?.nextCommand ?? readinessJson?.nextCommand,
    exitCode: success ? 0 : hostChecksPassed ? 2 : 1
  };
}

function evaluateAcceptanceEvidence(acceptanceEvidence: unknown, shouldValidate: boolean) {
  if (!shouldValidate) {
    return { valid: false };
  }

  try {
    assertAcceptanceEvidence(acceptanceEvidence as Record<string, any>);
    return { valid: true };
  } catch (error) {
    return { valid: false, error: formatError(error) };
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
