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

type StartupPresetCandidate = {
  resetType?: unknown;
  loadSequence?: unknown;
  runSequence?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Compare only fields supplied by the caller against a preset contract.
 *
 * The MCP schema fills nested defaults after this resolver runs, so comparing
 * whole JSON objects here made harmless inputs such as
 * `{ mode: "cpu1-then-cpu2" }` look contradictory to the preset.
 */
function matchesSuppliedFields(candidate: unknown, expected: unknown): boolean {
  if (!isRecord(candidate) || !isRecord(expected)) {
    return JSON.stringify(candidate) === JSON.stringify(expected);
  }
  return Object.entries(candidate).every(([key, value]) =>
    Object.prototype.hasOwnProperty.call(expected, key) &&
    JSON.stringify(value) === JSON.stringify(expected[key])
  );
}

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
  candidate: StartupPresetCandidate
): string[] {
  const expected = ipcStartupPreset(name);
  const mismatched: string[] = [];

  // `default` means "let the selected startup contract choose". For the
  // paired Flash contract that canonical choice is a CPU reset, while system
  // and restart resets remain explicit contradictions.
  if (candidate.resetType !== undefined &&
      candidate.resetType !== "default" &&
      candidate.resetType !== expected.resetType) {
    mismatched.push("resetType");
  }

  if (candidate.loadSequence !== undefined &&
      !matchesSuppliedFields(candidate.loadSequence, expected.loadSequence)) {
    mismatched.push("loadSequence");
  }

  // Flash programming and application startup are separate phases. The
  // paired Flash preset must pin the programming order, but the caller must
  // be able to select debugger-owned or firmware-owned CPU2 startup after the
  // boundary closes. Keep the historical DK9 preset fully pinned for
  // compatibility because its load sequence and run authority are one legacy
  // RAM bring-up contract.
  if (name !== "f28p65x-paired-flash" &&
      candidate.runSequence !== undefined &&
      !matchesSuppliedFields(candidate.runSequence, expected.runSequence)) {
    mismatched.push("runSequence");
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

  const suppliedLoadSequence = isRecord(input.loadSequence) ? input.loadSequence : undefined;
  const suppliedRunSequence = isRecord(input.runSequence) ? input.runSequence : undefined;
  const resolvedRunSequence = input.runSequence === undefined
    ? expected.runSequence
    : name === "f28p65x-paired-flash"
      ? input.runSequence
      : { ...expected.runSequence, ...(suppliedRunSequence ?? {}) };

  return {
    ...input,
    // A paired Flash write is only preparation. Keep the current session for
    // manifest verification and the explicit five-second power-cycle boundary.
    ...(name === "f28p65x-paired-flash" && input.programPreparation !== "symbols-only" ? {
      stopAfterFlashPreparation: input.stopAfterFlashPreparation ?? true,
      sessionMode: input.sessionMode ?? "interactive"
    } : {}),
    // Normalize the generic adapter default to the preset's explicit reset
    // contract before the Zod schema materializes the remaining defaults.
    resetType: input.resetType === undefined || input.resetType === "default"
      ? expected.resetType
      : input.resetType,
    // Merge nested programming defaults so callers can specify only the
    // meaningful mode while retaining the contract's bounded settle time.
    loadSequence: suppliedLoadSequence === undefined
      ? expected.loadSequence
      : { ...expected.loadSequence, ...suppliedLoadSequence },
    // For paired Flash, preserve an explicitly selected post-program startup
    // mode; otherwise use the historical debugger-owned default.
    runSequence: resolvedRunSequence,
    startupPreset: name
  };
}

export function workflowPollIterations(timeoutMs: number, intervalMs: number): number {
  return Math.ceil(timeoutMs / intervalMs);
}
import { DebugMcpError } from "../utils/errors.js";
