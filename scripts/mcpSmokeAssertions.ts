import assert from "node:assert/strict";

export function assertPartialAddressResolution(
  result: Record<string, unknown>,
  expected: { coreId: number; coreName: string; address: string }
): void {
  assert.equal(result.success, false, "unresolved addresses must report success=false");
  assert.equal(result.partial, true, "unresolved addresses must explicitly report partial=true");
  assert.equal(result.coreId, expected.coreId);
  assert.equal(result.coreName, expected.coreName);
  assert.equal(result.address, expected.address);
}
