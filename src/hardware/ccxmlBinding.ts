import { readFile } from "node:fs/promises";
import { DebugMcpError } from "../utils/errors.js";

/** Read the XDS110 serial explicitly selected in a CCS target configuration. */
export async function readCcxmlProbeSerial(ccxmlPath: string): Promise<string | undefined> {
  const text = await readFile(ccxmlPath, "utf8");
  const match = text.match(/id="-- Enter the serial number"\s*\/?>\s*<\/property>|<property[^>]*Value="([^"]+)"[^>]*id="-- Enter the serial number"/i);
  if (match?.[1]) return match[1].trim();
  const alternate = text.match(/-- Enter the serial number"[^>]*Value="([^"]+)"/i);
  return alternate?.[1]?.trim();
}

export async function assertCcxmlProbeBinding(ccxmlPath: string, expectedProbeSerial: string): Promise<void> {
  const actualProbeSerial = await readCcxmlProbeSerial(ccxmlPath);
  if (!actualProbeSerial) {
    throw new DebugMcpError("ProbeBindingMissing", "CCXML does not select an XDS110 by serial number", { ccxmlPath, expectedProbeSerial });
  }
  if (actualProbeSerial !== expectedProbeSerial) {
    throw new DebugMcpError("ProbeBindingInvalid", "CCXML probe serial does not match the registered board", { ccxmlPath, expectedProbeSerial, actualProbeSerial });
  }
}
