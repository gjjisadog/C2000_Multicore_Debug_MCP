import type { CoreId } from "./types.js";

/** Default Hybrid30K core-communication watch symbols used when callers omit expression lists. */
export const DEFAULT_CPU1_BOOT_EXPRESSIONS = [
  "g_stCoreCommCpu1Watch.emStage",
  "g_stCoreCommCpu1Watch.ulIpcPass",
  "g_stCoreCommCpu1Watch.ulCpu2Ready",
  "g_stCoreCommCpu1Watch.ulCpu2BootLastError"
] as const;

export const DEFAULT_CPU2_BOOT_EXPRESSIONS = [
  "g_stCoreCommCpu2Watch.emStage",
  "g_stCoreCommCpu2Watch.ulInitialParameterSnapshotSeq",
  "g_stCoreCommCpu2Watch.ulInitialParameterApplied"
] as const;

export interface DefaultIpcReadyCondition {
  label: string;
  coreId: CoreId;
  expression: string;
  expected: number;
}

export function defaultIpcReadyConditions(cpu1CoreId: CoreId, cpu2CoreId: CoreId): DefaultIpcReadyCondition[] {
  return [
    { label: "cpu1-stage-running", coreId: cpu1CoreId, expression: "g_stCoreCommCpu1Watch.emStage", expected: 5 },
    { label: "cpu1-ipc-pass", coreId: cpu1CoreId, expression: "g_stCoreCommCpu1Watch.ulIpcPass", expected: 1 },
    { label: "cpu1-cpu2-ready", coreId: cpu1CoreId, expression: "g_stCoreCommCpu1Watch.ulCpu2Ready", expected: 1 },
    { label: "cpu1-boot-error-clear", coreId: cpu1CoreId, expression: "g_stCoreCommCpu1Watch.ulCpu2BootLastError", expected: 0 },
    { label: "cpu2-stage-running", coreId: cpu2CoreId, expression: "g_stCoreCommCpu2Watch.emStage", expected: 5 },
    { label: "cpu2-initial-param-published", coreId: cpu2CoreId, expression: "g_stCoreCommCpu2Watch.ulInitialParameterSnapshotSeq", expected: 1 },
    { label: "cpu2-initial-param-applied", coreId: cpu2CoreId, expression: "g_stCoreCommCpu2Watch.ulInitialParameterApplied", expected: 1 }
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
