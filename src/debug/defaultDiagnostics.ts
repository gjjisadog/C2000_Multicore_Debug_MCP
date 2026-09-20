import type { CoreId, Cpu2FaultEvidenceOptions } from "./types.js";

/** Default Hybrid30K core-communication watch symbols used when callers omit expression lists. */
export const DEFAULT_CPU1_BOOT_EXPRESSIONS = [
  "g_stCoreCommCpu1Watch.emStage",
  "g_stCoreCommCpu1Watch.uiCpu2Ready",
  "g_stCoreCommCpu1Watch.ulCpu2BootLastError"
] as const;

export const DEFAULT_CPU2_BOOT_EXPRESSIONS = [
  "g_stCoreCommCpu2Watch.emStage",
  "g_stCoreCommCpu2Watch.uiInitParamApplied"
] as const;

/**
 * Register expressions are deliberately overridable because a custom CCS
 * symbol/register view may use a different spelling.  The reset expressions
 * are read-only driverlib calls; the CPU2 status API is normally evaluated on
 * CPU1, where F28P65x exposes the CPU2 reset-status register.
 */
export const DEFAULT_CPU2_FAULT_EVIDENCE: Required<Omit<Cpu2FaultEvidenceOptions, "resetReasonCoreId">> = {
  cpu2SpExpression: "SP",
  cpu2IerExpression: "IER",
  cpu2IfrExpression: "IFR",
  cpu2ResetReasonExpression: "SysCtl_getCPU2ResetStatus()",
  systemResetCauseExpression: "SysCtl_getResetCause()",
  stackPage: "DATA",
  codePage: "PROGRAM",
  stackWindowWords: 16,
  illegalInstructionWindowWords: 8,
  memoryTypeSize: 16
};

export function resolveCpu2FaultEvidenceOptions(
  overrides: Cpu2FaultEvidenceOptions | undefined,
  resetReasonCoreId: CoreId
): Required<Cpu2FaultEvidenceOptions> {
  return {
    ...DEFAULT_CPU2_FAULT_EVIDENCE,
    ...(overrides ?? {}),
    resetReasonCoreId: overrides?.resetReasonCoreId ?? resetReasonCoreId
  };
}

export interface DefaultIpcReadyCondition {
  label: string;
  coreId: CoreId;
  expression: string;
  expected: number;
}

export function defaultIpcReadyConditions(cpu1CoreId: CoreId, cpu2CoreId: CoreId): DefaultIpcReadyCondition[] {
  return [
    { label: "cpu1-stage-running", coreId: cpu1CoreId, expression: "g_stCoreCommCpu1Watch.emStage", expected: 5 },
    { label: "cpu1-cpu2-ready", coreId: cpu1CoreId, expression: "g_stCoreCommCpu1Watch.uiCpu2Ready", expected: 1 },
    { label: "cpu1-boot-error-clear", coreId: cpu1CoreId, expression: "g_stCoreCommCpu1Watch.ulCpu2BootLastError", expected: 0 },
    { label: "cpu2-stage-running", coreId: cpu2CoreId, expression: "g_stCoreCommCpu2Watch.emStage", expected: 5 },
    { label: "cpu2-initial-param-applied", coreId: cpu2CoreId, expression: "g_stCoreCommCpu2Watch.uiInitParamApplied", expected: 1 }
  ];
}

export function defaultExpressionReadSets(cpu1CoreId: CoreId, cpu2CoreId: CoreId) {
  return [
    {
      label: "cpu1-boot-ipc",
      coreId: cpu1CoreId,
      expressions: [...DEFAULT_CPU1_BOOT_EXPRESSIONS]
    },
    {
      label: "cpu2-boot-stage",
      coreId: cpu2CoreId,
      expressions: [...DEFAULT_CPU2_BOOT_EXPRESSIONS]
    }
  ];
}

export interface DiagnosticsDefaults {
  cpu1BootExpressions: string[];
  cpu2BootExpressions: string[];
}

export function resolveDiagnosticsDefaults(overrides?: Partial<DiagnosticsDefaults>): DiagnosticsDefaults {
  return {
    cpu1BootExpressions: overrides?.cpu1BootExpressions?.length
      ? overrides.cpu1BootExpressions
      : [...DEFAULT_CPU1_BOOT_EXPRESSIONS],
    cpu2BootExpressions: overrides?.cpu2BootExpressions?.length
      ? overrides.cpu2BootExpressions
      : [...DEFAULT_CPU2_BOOT_EXPRESSIONS]
  };
}
