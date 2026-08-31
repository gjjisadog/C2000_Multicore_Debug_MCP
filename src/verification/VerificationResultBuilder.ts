import {
  verificationResultSchema,
  type VerificationArtifact,
  type VerificationCheck,
  type VerificationCompleteness,
  type VerificationIdentity,
  type VerificationMetric,
  type VerificationResult,
  type VerificationSeverity,
  type VerificationStatus,
  type VerificationSubject,
  type VerifierType
} from "./VerificationSchemas.js";

export interface VerificationExecutionContext {
  verificationId: string;
  parentVerificationId?: string;
  jobId?: string;
  artifactDirectory?: string;
  subject?: VerificationSubject;
  identity?: VerificationIdentity;
}

export function createVerificationResult(input: {
  context: VerificationExecutionContext;
  verifierType: VerifierType;
  status: VerificationStatus;
  startedAt: string;
  endedAt: string;
  checks?: VerificationCheck[];
  metrics?: VerificationMetric[];
  diagnostics?: VerificationResult["diagnostics"];
  artifacts?: VerificationArtifact[];
  evidenceClassification?: VerificationResult["evidenceClassification"];
  completeness?: VerificationCompleteness;
  hardGateFailures?: VerificationResult["hardGateFailures"];
  children?: VerificationResult["children"];
  details?: Record<string, unknown>;
  inputs?: Record<string, unknown>;
  summaryMessage?: string;
}): VerificationResult {
  const checks = input.checks ?? [];
  const diagnostics = input.diagnostics ?? [];
  const artifacts = input.artifacts ?? [];
  const hardGateFailures = input.hardGateFailures ?? gateFailuresFromChecks(input.verifierType, checks);
  const checkCounts = {
    checks: checks.length,
    passed: checks.filter(check => check.status === "PASSED").length,
    failed: checks.filter(check => check.status === "FAILED").length,
    blocked: checks.filter(check => check.status === "BLOCKED").length,
    unsupported: checks.filter(check => check.status === "UNSUPPORTED").length
  };
  const summary = {
    message: input.summaryMessage ?? summaryMessage(input.status, checkCounts, hardGateFailures.length),
    errors: checks.filter(check => check.severity === "ERROR" || check.severity === "CRITICAL").length,
    warnings: checks.filter(check => check.severity === "WARNING").length,
    ...checkCounts,
    decision: decisionFor(input.status, hardGateFailures.length)
  };
  return verificationResultSchema.parse({
    schemaVersion: 1,
    verificationId: input.context.verificationId,
    verifierType: input.verifierType,
    ...(input.context.jobId ? { jobId: input.context.jobId } : {}),
    ...(input.context.parentVerificationId ? { parentVerificationId: input.context.parentVerificationId } : {}),
    status: input.status,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    subject: input.context.subject ?? { kind: input.verifierType, id: input.context.verificationId },
    identity: input.context.identity ?? {},
    inputs: input.inputs ?? {},
    checks,
    metrics: input.metrics ?? [],
    diagnostics,
    artifacts,
    evidenceClassification: input.evidenceClassification ?? "UNKNOWN",
    completeness: input.completeness ?? complete(artifacts),
    hardGateFailures,
    summary,
    ...(input.children ? { children: input.children } : {}),
    ...(input.details ? { details: input.details } : {})
  });
}

export function gateFailuresFromChecks(
  verifier: VerifierType,
  checks: readonly VerificationCheck[]
): VerificationResult["hardGateFailures"] {
  return checks
    .filter(check => check.status === "FAILED" || check.status === "BLOCKED" || check.status === "UNSUPPORTED")
    .filter(check => check.severity === "ERROR" || check.severity === "CRITICAL" || check.status !== "UNSUPPORTED")
    .map(check => ({
      verifier,
      check: check.id,
      severity: check.severity,
      message: check.message,
      ...(check.evidence !== undefined ? { evidence: check.evidence } : {})
    }));
}

export function complete(artifacts: readonly VerificationArtifact[] = []): VerificationCompleteness {
  return {
    status: "COMPLETE",
    reason: null,
    requiredArtifacts: [],
    presentArtifacts: artifacts.map(artifact => artifact.path)
  };
}

export function incomplete(reason: string, artifacts: readonly VerificationArtifact[] = []): VerificationCompleteness {
  return {
    status: "INCOMPLETE",
    reason,
    requiredArtifacts: [reason],
    presentArtifacts: artifacts.map(artifact => artifact.path)
  };
}

export function statusFromChecks(checks: readonly VerificationCheck[], fallback: VerificationStatus = "PASSED"): VerificationStatus {
  if (checks.some(check => check.status === "FAILED" && (check.severity === "ERROR" || check.severity === "CRITICAL"))) return "FAILED";
  if (checks.some(check => check.status === "BLOCKED")) return "BLOCKED";
  if (checks.some(check => check.status === "UNSUPPORTED")) return "UNSUPPORTED";
  if (checks.some(check => check.status === "FAILED")) return "FAILED";
  return fallback;
}

function decisionFor(status: VerificationStatus, hardGateCount: number): "PASS" | "REJECT" | "BLOCK" | "REQUIRES_REVIEW" {
  if (status === "PASSED" && hardGateCount === 0) return "PASS";
  if (status === "BLOCKED" || status === "UNSUPPORTED") return "BLOCK";
  if (status === "FAILED") return "REJECT";
  return "REQUIRES_REVIEW";
}

function summaryMessage(
  status: VerificationStatus,
  counts: { checks: number; passed: number; failed: number; blocked: number; unsupported: number },
  hardGateCount: number
): string {
  return `${status}: ${counts.passed}/${counts.checks} checks passed; ${hardGateCount} hard-gate failure(s)`;
}

export function severityForFailure(critical: boolean): VerificationSeverity {
  return critical ? "CRITICAL" : "ERROR";
}
