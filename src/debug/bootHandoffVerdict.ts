import type { RamOwnershipAnalysis } from "../hardware/mapOwnership.js";

export interface BootHandoffVerdict {
  cpu1Ready: boolean;
  cpu2Ready: boolean;
  ramOwnershipReady: boolean;
  ready: boolean;
  reasons: string[];
}

/**
 * Compact boot/IPC readiness heuristic.
 * - Expressions must evaluate successfully and look non-zero.
 * - When map analysis is present and CPU2 uses GS RAM, ownershipActions must be non-empty.
 */
export function buildBootHandoffVerdict(
  boot: Record<string, any>,
  ramOwnership?: RamOwnershipAnalysis
): BootHandoffVerdict {
  const cpu1Expressions = Array.isArray(boot.cpu1?.expressions) ? boot.cpu1.expressions as Array<Record<string, any>> : [];
  const cpu2Expressions = Array.isArray(boot.cpu2?.expressions) ? boot.cpu2.expressions as Array<Record<string, any>> : [];
  const reasons: string[] = [];

  const cpu1Ready = cpu1Expressions.length > 0 && cpu1Expressions.every(bootExpressionReady);
  const cpu2Ready = cpu2Expressions.length > 0 && cpu2Expressions.every(bootExpressionReady);
  if (cpu1Expressions.length === 0) {
    reasons.push("No CPU1 expressions were evaluated.");
  } else if (!cpu1Ready) {
    reasons.push("One or more CPU1 boot/IPC expressions are zero, failed, or missing.");
  }
  if (cpu2Expressions.length === 0) {
    reasons.push("No CPU2 expressions were evaluated.");
  } else if (!cpu2Ready) {
    reasons.push("One or more CPU2 boot stage expressions are zero, failed, or missing.");
  }

  let ramOwnershipReady = true;
  if (ramOwnership) {
    const cpu2NeedsGs = ramOwnership.maps.some(map => map.coreId === 2 && map.usedGsRam.length > 0);
    if (cpu2NeedsGs && ramOwnership.ownershipActions.length === 0) {
      ramOwnershipReady = false;
      reasons.push("CPU2 map uses GS RAM but no ownership actions were generated.");
    }
  }

  return {
    cpu1Ready,
    cpu2Ready,
    ramOwnershipReady,
    ready: cpu1Ready && cpu2Ready && ramOwnershipReady,
    reasons
  };
}

function bootExpressionReady(result: Record<string, any>): boolean {
  if (result.success !== true) {
    return false;
  }
  if (result.expression === "g_stCoreCommCpu1Watch.ulCpu2BootLastError") {
    return Number(result.value) === 0;
  }
  if (result.expression === "g_stCoreCommCpu1Watch.emStage" ||
      result.expression === "g_stCoreCommCpu2Watch.emStage") {
    return Number(result.value) === 5;
  }
  return !["0", "false", "undefined"].includes(String(result.value).toLowerCase());
}
