import { describe, expect, test } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { assertCcxmlProbeBinding, readCcxmlProbeSerial, readCcxmlProbeTypeFromText } from "../src/hardware/ccxmlBinding.js";

const ccxmlPath = fileURLToPath(new URL("../examples/targetConfigs/F28P650DK9_XDS110_CL650001.ccxml", import.meta.url));
const xds2xxCcxmlPath = fileURLToPath(new URL("../examples/targetConfigs/F28P650DK8_XDS2XX_S200-1A2F00022635.ccxml", import.meta.url));

describe("CCXML probe binding", () => {
  test("extracts the explicitly selected XDS110 serial", async () => {
    expect(await readCcxmlProbeSerial(ccxmlPath)).toBe("CL650001");
    await expect(assertCcxmlProbeBinding(ccxmlPath, "CL650001")).resolves.toBeUndefined();
  });

  test("fails closed when the board registration serial does not match", async () => {
    await expect(assertCcxmlProbeBinding(ccxmlPath, "CL650002")).rejects.toMatchObject({ code: "ProbeBindingInvalid" });
  });

  test("extracts an explicitly selected XDS2xx serial for the DK8 target", async () => {
    expect(await readCcxmlProbeSerial(xds2xxCcxmlPath)).toBe("S200-1A2F00022635");
    await expect(assertCcxmlProbeBinding(xds2xxCcxmlPath, "S200-1A2F00022635")).resolves.toBeUndefined();
    expect(readCcxmlProbeTypeFromText(await readFile(xds2xxCcxmlPath, "utf8"))).toBe("XDS2xx");
  });
});
