import type { CoreId } from "./types.js";

/** Default Hybrid30k-style boot/IPC symbols used when callers omit expression lists. */
export const DEFAULT_CPU1_BOOT_EXPRESSIONS = [
  "g_emHybrid30kCpu1Stage",
  "g_ulHybrid30kIpcPass",
  "g_ulHybrid30kMsgRamPass",
  "g_ulHybrid30kParamPass"
] as const;

export const DEFAULT_CPU2_BOOT_EXPRESSIONS = ["g_emHybrid30kCpu2Stage"] as const;

export interface DefaultIpcReadyCondition {
  label: string;
  coreId: CoreId;
  expression: string;
  expected: number;
}

export function defaultIpcReadyConditions(cpu1CoreId: CoreId, cpu2CoreId: CoreId): DefaultIpcReadyCondition[] {
  return [
    { label: "cpu1-ipc-pass", coreId: cpu1CoreId, expression: "g_ulHybrid30kIpcPass", expected: 1 },
    { label: "cpu1-msgram-pass", coreId: cpu1CoreId, expression: "g_ulHybrid30kMsgRamPass", expected: 1 },
    { label: "cpu1-param-pass", coreId: cpu1CoreId, expression: "g_ulHybrid30kParamPass", expected: 1 },
    { label: "cpu2-stage-ready", coreId: cpu2CoreId, expression: "g_emHybrid30kCpu2Stage", expected: 1 }
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
