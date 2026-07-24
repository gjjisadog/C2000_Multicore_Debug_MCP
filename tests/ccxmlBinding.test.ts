import { describe, expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import { assertCcxmlProbeBinding, readCcxmlProbeSerial } from "../src/hardware/ccxmlBinding.js";

const ccxmlPath = fileURLToPath(new URL("../examples/targetConfigs/F28P650DK9_XDS110_CL650001.ccxml", import.meta.url));

describe("CCXML probe binding", () => {
  test("extracts the explicitly selected XDS110 serial", async () => {
    expect(await readCcxmlProbeSerial(ccxmlPath)).toBe("CL650001");
    await expect(assertCcxmlProbeBinding(ccxmlPath, "CL650001")).resolves.toBeUndefined();
  });

  test("fails closed when the board registration serial does not match", async () => {
    await expect(assertCcxmlProbeBinding(ccxmlPath, "CL650002")).rejects.toMatchObject({ code: "ProbeBindingInvalid" });
  });
});
