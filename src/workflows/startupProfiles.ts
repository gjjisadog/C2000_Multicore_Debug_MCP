export const IPC_STARTUP_PRESET_NAMES = ["hybrid30k-dk9-owner-first"] as const;
export type IpcStartupPresetName = typeof IPC_STARTUP_PRESET_NAMES[number];

export const HYBRID30K_DK9_OWNER_FIRST_STARTUP = {
  resetType: "cpu" as const,
  loadSequence: {
    mode: "cpu1-run-before-cpu2" as const,
    cpu1SettleMs: 250
  },
  runSequence: {
    runMode: "debugger_runs_both" as const,
    runCpu1First: true,
    runCpu2: true,
    settleMs: 500
  }
};

export function ipcStartupPreset(name: IpcStartupPresetName) {
  if (name === "hybrid30k-dk9-owner-first") {
    return structuredClone(HYBRID30K_DK9_OWNER_FIRST_STARTUP);
  }
  return undefined;
}

export const MAX_WORKFLOW_POLL_ITERATIONS = 10_000;

export function resolveIpcStartupPreset(input: Record<string, unknown>): Record<string, unknown> {
  if (input.startupPreset !== "hybrid30k-dk9-owner-first") return input;
  const expected = ipcStartupPreset("hybrid30k-dk9-owner-first")!;
  for (const key of ["resetType", "loadSequence", "runSequence"] as const) {
    if (input[key] !== undefined && JSON.stringify(input[key]) !== JSON.stringify(expected[key])) {
      throw new DebugMcpError("EvidenceLimitExceeded", `startupPreset hybrid30k-dk9-owner-first conflicts with explicit ${key}`, {
        startupPreset: input.startupPreset,
        field: key,
        expected: expected[key],
        actual: input[key]
      });
    }
  }
  return { ...input, ...expected, startupPreset: input.startupPreset };
}

export function workflowPollIterations(timeoutMs: number, intervalMs: number): number {
  return Math.ceil(timeoutMs / intervalMs);
}
import { DebugMcpError } from "../utils/errors.js";
