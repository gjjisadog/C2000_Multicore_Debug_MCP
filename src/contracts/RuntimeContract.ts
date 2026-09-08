/**
 * Versions for contracts that cross the separately built MCP frontend/daemon
 * boundary. Keep this object small and bump the relevant entry whenever a
 * strict RPC/tool or durable-plan shape changes.
 */
export const runtimeContract = {
  rpcProtocolVersion: 1,
  durableTestPlanVersion: 3,
  runIpcAcceptanceVersion: 3
} as const;

export type RuntimeContract = typeof runtimeContract;

export function runtimeContractIdentity(): RuntimeContract {
  return { ...runtimeContract };
}

export interface RuntimeContractCompatibility {
  compatible: boolean;
  expected: RuntimeContract;
  actual?: Record<string, unknown>;
  mismatches: string[];
}

export function compareRuntimeContract(value: unknown): RuntimeContractCompatibility {
  const actual = isRecord(value) ? value : undefined;
  const mismatches = Object.entries(runtimeContract)
    .filter(([key, expected]) => actual?.[key] !== expected)
    .map(([key]) => key);
  return {
    compatible: mismatches.length === 0,
    expected: runtimeContractIdentity(),
    ...(actual ? { actual } : {}),
    mismatches
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
