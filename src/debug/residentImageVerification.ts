import { readFile } from "node:fs/promises";
import { residentImageManifestSchema } from "../mcp/toolSchemas.js";
import { resolveSymbolAddressFromMap } from "../hardware/mapSymbols.js";
import { DebugMcpError } from "../utils/errors.js";
import { fileMetadata } from "../utils/fileHash.js";
import {
  decodeF28P65xBankMuxSel,
  F28P65X_CPU1_CORE_ID,
  F28P65X_CPU2_CORE_ID,
  F28P65X_DEVCFG_BANKMUXSEL_ADDRESS,
  F28P65X_FLASH_BANK_COUNT
} from "../hardware/mapOwnership.js";

export interface ResidentImageVerificationCheck {
  coreId: number;
  programUri: string;
  manifestUri: string;
  mapUri?: string;
}

export interface ResidentImageVerificationManager {
  normalizeArtifactUri(uri: string): string;
  getTargetState(sessionId: string, coreId: number): Promise<{ coreId: number; coreName: string; connected: boolean }>;
  connectTarget(sessionId: string, coreId: number): Promise<unknown>;
  readMemory(sessionId: string, coreId: number, page: string, address: number, typeSize: number): Promise<number>;
}

/**
 * Verify firmware-declared resident markers without programming, symbol
 * loading, reset, run, or target-memory writes.  Both the existing-session
 * and no-session resident workflows call this function before symbols are
 * loaded when manifests are supplied.
 */
export async function verifyResidentImageForSession(
  manager: ResidentImageVerificationManager,
  options: {
    sessionId: string;
    checks: ResidentImageVerificationCheck[];
    connectIfNeeded?: boolean;
  }
): Promise<Record<string, unknown>> {
  const connectedCoreIds = new Set<number>();
  const results: Record<string, unknown>[] = [];
  const connectIfNeeded = options.connectIfNeeded !== false;

  for (const request of options.checks) {
    const programUri = manager.normalizeArtifactUri(request.programUri);
    const manifestUri = manager.normalizeArtifactUri(request.manifestUri);
    const manifestMetadata = await fileMetadata(manifestUri);
    const manifest = residentImageManifestSchema.parse(JSON.parse(await readFile(manifestUri, "utf8")));
    const programMetadata = await fileMetadata(programUri);
    if (programMetadata.sha256.toLowerCase() !== manifest.programSha256.toLowerCase()) {
      throw new DebugMcpError("ResidentImageManifestMismatch", "Resident-image manifest does not bind to the requested .out artifact", {
        sessionId: options.sessionId,
        coreId: request.coreId,
        programUri,
        manifestUri,
        programSha256: programMetadata.sha256,
        manifestProgramSha256: manifest.programSha256,
        targetMemoryWritten: false,
        nextAction: "Regenerate the manifest from the exact .out artifact and retry the read-only verification."
      });
    }

    const state = await manager.getTargetState(options.sessionId, request.coreId);
    if (connectIfNeeded && !state.connected && !connectedCoreIds.has(request.coreId)) {
      await manager.connectTarget(options.sessionId, request.coreId);
      connectedCoreIds.add(request.coreId);
    }

    const identity = manifest.identity;
    const mapUri = request.mapUri === undefined ? undefined : manager.normalizeArtifactUri(request.mapUri);
    const address = identity.address !== undefined
      ? parseStrictAddress(identity.address)
      : mapUri === undefined
        ? (() => {
          throw new DebugMcpError("ResidentImageManifestInvalid", "A mapUri is required when the manifest identifies its marker by symbol", {
            manifestUri,
            coreId: request.coreId,
            targetMemoryWritten: false
          });
        })()
        : await resolveSymbolAddressFromMap(mapUri, identity.symbol!);
    const route = await resolveResidentReadRoute(manager, options.sessionId, request.coreId, address, connectIfNeeded, connectedCoreIds);
    const expectedValue = normalizeIdentityValue(identity.expectedValue, identity.typeSize);
    let rawValue: number;
    try {
      rawValue = await manager.readMemory(options.sessionId, route.readCoreId, identity.page, address, identity.typeSize);
    } catch (error) {
      if (route.flashBank === undefined) throw error;
      throw residentAccessUnavailable(options.sessionId, request.coreId, route.flashBank, address,
        `Resident marker could not be read through ${route.bankOwner}`, error);
    }
    if (route.flashBank !== undefined && (!Number.isInteger(rawValue) ||
        rawValue < -2147483648 || rawValue > 0xffffffff || (rawValue >>> 0) === 0x0BAD0BAD)) {
      throw residentAccessUnavailable(options.sessionId, request.coreId, route.flashBank, address,
        `Resident marker read through ${route.bankOwner} returned an invalid value`);
    }
    const unsignedValue = rawValue < 0
      ? identity.typeSize === 8 ? rawValue & 0xff : identity.typeSize === 16 ? rawValue & 0xffff : rawValue >>> 0
      : rawValue;
    const actualValue = normalizeIdentityValue(unsignedValue, identity.typeSize);
    results.push({
      coreId: request.coreId,
      coreName: state.coreName,
      imageCoreId: request.coreId,
      readCoreId: route.readCoreId,
      ...(route.flashBank !== undefined ? {
        flashBank: route.flashBank,
        bankOwner: route.bankOwner,
        bankMuxSel: formatHexAddress(route.bankMuxSel!)
      } : {}),
      programUri,
      manifestUri,
      manifestSha256: manifestMetadata.sha256,
      programSha256: programMetadata.sha256,
      marker: {
        ...(identity.symbol !== undefined ? { symbol: identity.symbol } : {}),
        address: formatHexAddress(address),
        page: identity.page,
        typeSize: identity.typeSize,
        expectedValue,
        actualValue,
        matched: actualValue === expectedValue
      }
    });
  }

  const verified = results.every(result => record(result.marker).matched === true);
  const evidence = {
    sessionId: options.sessionId,
    verified,
    verificationMethod: "resident-image-manifest-raw-memory",
    targetAccess: {
      connection: connectIfNeeded ? "connect-if-needed" : "existing-session-only",
      programming: false,
      symbolLoad: false,
      reset: false,
      run: false,
      targetMemoryWrite: false
    },
    checks: results
  };
  if (!verified) {
    return {
      ...evidence,
      success: false,
      timestamp: new Date().toISOString(),
      error: {
        code: "ResidentImageMismatch",
        message: "One or more resident-image identity markers did not match the manifest",
        details: { sessionId: options.sessionId, targetMemoryWritten: false }
      }
    };
  }
  return { ...evidence, success: true, timestamp: new Date().toISOString() };
}

/** F28P65x has five contiguous 0x20000-word Flash banks beginning at 0x80000. */
function f28p65xFlashBank(address: number): number | undefined {
  const first = 0x80000;
  const size = 0x20000;
  return address >= first && address < first + F28P65X_FLASH_BANK_COUNT * size
    ? Math.floor((address - first) / size)
    : undefined;
}

async function resolveResidentReadRoute(
  manager: ResidentImageVerificationManager,
  sessionId: string,
  imageCoreId: number,
  address: number,
  connectIfNeeded: boolean,
  connectedCoreIds: Set<number>
): Promise<{ readCoreId: number; flashBank?: number; bankOwner?: "CPU1" | "CPU2"; bankMuxSel?: number }> {
  const flashBank = f28p65xFlashBank(address);
  if (flashBank === undefined || (imageCoreId !== F28P65X_CPU1_CORE_ID && imageCoreId !== F28P65X_CPU2_CORE_ID)) {
    return { readCoreId: imageCoreId };
  }

  let ownerState: Awaited<ReturnType<ResidentImageVerificationManager["getTargetState"]>>;
  try {
    ownerState = await manager.getTargetState(sessionId, F28P65X_CPU1_CORE_ID);
  } catch (error) {
    throw residentAccessUnavailable(sessionId, imageCoreId, flashBank, address, "CPU1 is unavailable for BANKMUXSEL readback", error);
  }
  if (!ownerState.connected && !connectedCoreIds.has(F28P65X_CPU1_CORE_ID)) {
    if (!connectIfNeeded) {
      throw residentAccessUnavailable(sessionId, imageCoreId, flashBank, address, "CPU1 is disconnected and connectIfNeeded is false");
    }
    await manager.connectTarget(sessionId, F28P65X_CPU1_CORE_ID);
    connectedCoreIds.add(F28P65X_CPU1_CORE_ID);
  }

  let bankMuxSel: number;
  try {
    bankMuxSel = await manager.readMemory(sessionId, F28P65X_CPU1_CORE_ID, "DATA", F28P65X_DEVCFG_BANKMUXSEL_ADDRESS, 32);
  } catch (error) {
    throw residentAccessUnavailable(sessionId, imageCoreId, flashBank, address, "BANKMUXSEL could not be read through CPU1", error);
  }
  if (!Number.isInteger(bankMuxSel) || bankMuxSel < -2147483648 || bankMuxSel > 0xffffffff || (bankMuxSel >>> 0) === 0x0BAD0BAD) {
    throw residentAccessUnavailable(sessionId, imageCoreId, flashBank, address, "BANKMUXSEL returned an invalid value");
  }
  const bankOwner = decodeF28P65xBankMuxSel(bankMuxSel)[flashBank].owner;
  if (bankOwner === "unknown") {
    throw residentAccessUnavailable(sessionId, imageCoreId, flashBank, address, "BANKMUXSEL does not identify a readable bank owner");
  }
  const readCoreId = bankOwner === "CPU1" ? F28P65X_CPU1_CORE_ID : F28P65X_CPU2_CORE_ID;
  let readState: Awaited<ReturnType<ResidentImageVerificationManager["getTargetState"]>>;
  try {
    readState = await manager.getTargetState(sessionId, readCoreId);
  } catch (error) {
    throw residentAccessUnavailable(sessionId, imageCoreId, flashBank, address, `${bankOwner} is unavailable for resident marker readback`, error);
  }
  if (!readState.connected && !connectedCoreIds.has(readCoreId)) {
    if (!connectIfNeeded) {
      throw residentAccessUnavailable(sessionId, imageCoreId, flashBank, address, `${bankOwner} is disconnected and connectIfNeeded is false`);
    }
    await manager.connectTarget(sessionId, readCoreId);
    connectedCoreIds.add(readCoreId);
  }
  return { readCoreId, flashBank, bankOwner, bankMuxSel: bankMuxSel >>> 0 };
}

function residentAccessUnavailable(sessionId: string, imageCoreId: number, flashBank: number, address: number, reason: string, cause?: unknown): DebugMcpError {
  return new DebugMcpError("ResidentImageAccessUnavailable", reason, {
    sessionId, imageCoreId, flashBank, address: formatHexAddress(address),
    targetMemoryWritten: false,
    ...(cause ? { cause: cause instanceof Error ? cause.message : String(cause) } : {})
  });
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function parseStrictAddress(value: string): number {
  const trimmed = value.trim();
  const isHex = /^0x[0-9a-f]+$/i.test(trimmed);
  const isDecimal = /^[0-9]+$/.test(trimmed);
  if (!isHex && !isDecimal) throw new Error(`Invalid resident-image marker address: ${value}`);
  const parsed = isHex ? Number.parseInt(trimmed.slice(2), 16) : Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`Invalid resident-image marker address: ${value}`);
  return parsed;
}

function normalizeIdentityValue(value: string | number, typeSize: 8 | 16 | 32): number {
  const parsed = typeof value === "number"
    ? value
    : /^0x/i.test(value) ? Number.parseInt(value.slice(2), 16) : Number.parseInt(value, 10);
  const max = typeSize === 8 ? 0xff : typeSize === 16 ? 0xffff : 0xffffffff;
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > max) {
    throw new Error(`Resident-image marker value is outside uint${typeSize}: ${String(value)}`);
  }
  return parsed;
}

function formatHexAddress(value: number): string {
  return `0x${value.toString(16).toUpperCase()}`;
}
