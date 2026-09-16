export const IPC_STARTUP_PRESET_NAMES = ["hybrid30k-dk9-owner-first", "f28p65x-paired-flash"] as const;
export type IpcStartupPresetName = typeof IPC_STARTUP_PRESET_NAMES[number];

/**
 * Historical Hybrid30K DK9 bring-up. CPU1 is started before the CPU2 image is
 * loaded because that flow was built for a CPU2 RAM image and owner-side
 * initialization. It is NOT a paired Flash programming preset: with a CPU2
 * Flash image it would start the Flash Plugin owner before the shared Flash
 * clock and bank mapping are prepared.
 */
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

/**
 * Official F28P65x dual-core Flash programming contract.
 *
 * Both images are programmed while every application core stays halted. The
 * CPU1 on-chip Flash Plugin prepares the shared Flash clock and bank mapping
 * with CPU1 held, and no application core is started until both Flash images
 * have been programmed. Application startup belongs to the run stage that
 * follows this boundary.
 */
export const F28P65X_PAIRED_FLASH_STARTUP = {
  resetType: "cpu" as const,
  loadSequence: {
    mode: "cpu1-then-cpu2" as const,
    cpu1SettleMs: 250
  },
  runSequence: {
    runMode: "debugger_runs_both" as const,
    runCpu1First: true,
    runCpu2: true,
    settleMs: 500
  }
};

/** Presets that program both Flash images before any application core runs. */
export const PAIRED_FLASH_PRESET_NAMES = ["f28p65x-paired-flash"] as const;

export function isPairedFlashPreset(name: string | undefined | null): boolean {
  return name !== undefined && name !== null && (PAIRED_FLASH_PRESET_NAMES as readonly string[]).includes(name);
}

export function ipcStartupPreset(name: IpcStartupPresetName) {
  if (name === "f28p65x-paired-flash") {
    return structuredClone(F28P65X_PAIRED_FLASH_STARTUP);
  }
  return structuredClone(HYBRID30K_DK9_OWNER_FIRST_STARTUP);
}

/**
 * Names of explicitly supplied fields that contradict the selected preset.
 * A preset is a contract, so a caller may not silently override part of it.
 */
export function mismatchedStartupPresetFields(
  name: IpcStartupPresetName,
  candidate: { resetType?: unknown; loadSequence?: unknown; runSequence?: unknown }
): string[] {
  const expected = ipcStartupPreset(name);
  const mismatched: string[] = [];
  for (const key of ["resetType", "loadSequence", "runSequence"] as const) {
    if (candidate[key] !== undefined && JSON.stringify(candidate[key]) !== JSON.stringify(expected[key])) {
      mismatched.push(key);
    }
  }
  return mismatched;
}

export const MAX_WORKFLOW_POLL_ITERATIONS = 10_000;

export function resolveIpcStartupPreset(input: Record<string, unknown>): Record<string, unknown> {
  const name = input.startupPreset;
  if (name !== "hybrid30k-dk9-owner-first" && name !== "f28p65x-paired-flash") {
    return input;
  }
  const expected = ipcStartupPreset(name);
  const mismatched = mismatchedStartupPresetFields(name, input);
  if (mismatched.length > 0) {
    const field = mismatched[0]!;
    throw new DebugMcpError("EvidenceLimitExceeded", `startupPreset ${name} conflicts with explicit ${field}`, {
      startupPreset: name,
      field,
      expected: expected[field as "resetType" | "loadSequence" | "runSequence"],
      actual: input[field]
    });
  }
  return { ...input, ...expected, startupPreset: name };
}

export function workflowPollIterations(timeoutMs: number, intervalMs: number): number {
  return Math.ceil(timeoutMs / intervalMs);
}
import { DebugMcpError } from "../utils/errors.js";
