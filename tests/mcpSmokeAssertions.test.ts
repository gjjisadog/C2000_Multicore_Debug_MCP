import { describe, expect, test } from "vitest";
import { assertPartialAddressResolution } from "../scripts/mcpSmokeAssertions.js";

describe("MCP stdio smoke address-resolution assertions", () => {
  test("accepts the documented partial unresolved-address response while retaining core identity", () => {
    expect(() => assertPartialAddressResolution({
      success: false,
      partial: true,
      coreId: 0,
      coreName: "C28xx_CPU1",
      address: "0x00C4E1"
    }, {
      coreId: 0,
      coreName: "C28xx_CPU1",
      address: "0x00C4E1"
    })).not.toThrow();
  });

  test("rejects an unresolved address result that omits its partial-failure semantics", () => {
    expect(() => assertPartialAddressResolution({
      success: true,
      partial: false,
      coreId: 0,
      coreName: "C28xx_CPU1",
      address: "0x00C4E1"
    }, {
      coreId: 0,
      coreName: "C28xx_CPU1",
      address: "0x00C4E1"
    })).toThrow("success=false");
  });
});
