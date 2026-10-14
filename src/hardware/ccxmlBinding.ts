import { readFile } from "node:fs/promises";
import { DebugMcpError } from "../utils/errors.js";

export type CcxmlProbeType = "XDS100" | "XDS110" | "XDS2xx" | "unknown";

/** Read the debug-probe serial explicitly selected in a CCS target configuration. */
export async function readCcxmlProbeSerial(ccxmlPath: string): Promise<string | undefined> {
  const text = await readFile(ccxmlPath, "utf8");
  return readCcxmlProbeSerialFromText(text);
}

export async function assertCcxmlProbeBinding(ccxmlPath: string, expectedProbeSerial: string): Promise<void> {
  const actualProbeSerial = await readCcxmlProbeSerial(ccxmlPath);
  if (!actualProbeSerial) {
    throw new DebugMcpError("ProbeBindingMissing", "CCXML does not select a debug probe by serial number", { ccxmlPath, expectedProbeSerial });
  }
  if (actualProbeSerial !== expectedProbeSerial) {
    throw new DebugMcpError("ProbeBindingInvalid", "CCXML probe serial does not match the registered board", { ccxmlPath, expectedProbeSerial, actualProbeSerial });
  }
}

export function readCcxmlProbeSerialFromText(text: string): string | undefined {
  const tags = text.match(/<property\b[^>]*>/gi) ?? [];
  for (const tag of tags) {
    const id = readAttribute(tag, "id") ?? readAttribute(tag, "ID");
    const name = readAttribute(tag, "Name");
    if (id !== "-- Enter the serial number" && id !== "USCIF.ECOM_SERIAL" && id !== "SEPK.POD_SERIAL" && name !== "-- Enter the serial number") continue;
    const value = readAttribute(tag, "Value");
    if (value?.trim() && !/^(?:use\s+xds2xx_conf\b|run\s+xds100serial\b|REPLACE_WITH_)/i.test(value.trim())) return value.trim();
  }
  return undefined;
}

export function readCcxmlProbeTypeFromText(text: string): CcxmlProbeType {
  if (/TIXDS2XX(?:USB|LAN)/i.test(text)) return "XDS2xx";
  if (/TIXDS110/i.test(text)) return "XDS110";
  if (/TIXDS100/i.test(text)) return "XDS100";
  return "unknown";
}

function readAttribute(tag: string, attribute: string): string | undefined {
  const match = tag.match(new RegExp(`\\b${attribute}\\s*=\\s*(["'])(.*?)\\1`, "i"));
  return match?.[2];
}
