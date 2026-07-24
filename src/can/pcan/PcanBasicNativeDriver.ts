import { DebugMcpError } from "../../utils/errors.js";
import type { PcanBasicDriver } from "./PcanBasicDriver.js";
import type { PcanDriverFrame, PcanStatus } from "./PcanBasicTypes.js";
import { resolvePcanBasicLibrary } from "./PcanBasicLibraryResolver.js";
import { PCAN_ERROR_QRCVEMPTY, PCAN_MESSAGE_EXTENDED, PCAN_MESSAGE_STANDARD } from "./PcanBasicConstants.js";

/**
 * Isolated native boundary. The optional `koffi` package is loaded only when a
 * real PCAN adapter is selected, so CI and Mock CAN never require native FFI.
 */
export class PcanBasicNativeDriver implements PcanBasicDriver {
  libraryPath?: string;
  private api?: Record<string, (...args: any[]) => any>;
  private messageType?: any;
  private activeChannel?: number;
  constructor(private readonly configuredLibraryPath?: string) {}

  async initialize(channel: number, bitrate: number): Promise<void> {
    await this.ensureApi();
    await this.check("PcanInitializeFailed", this.api!.initialize(channel, bitrate, 0, 0, 0));
    this.activeChannel = channel;
  }
  async uninitialize(channel: number): Promise<void> { if (this.api) await this.check("PcanInitializeFailed", this.api.uninitialize(channel)); }
  async reset(channel: number): Promise<void> { await this.ensureApi(); await this.check("PcanInitializeFailed", this.api!.reset(channel)); }
  async getStatus(channel: number): Promise<PcanStatus> {
    await this.ensureApi();
    const code = Number(this.api!.status(channel));
    return { code, busWarning: Boolean(code & 0x4), busPassive: Boolean(code & 0x8), busOff: Boolean(code & 0x10) };
  }
  async write(channel: number, frame: PcanDriverFrame): Promise<void> {
    await this.ensureApi();
    const status = Number(this.api!.write(channel, {
      ID: frame.id,
      MSGTYPE: frame.extended ? PCAN_MESSAGE_EXTENDED : PCAN_MESSAGE_STANDARD,
      LEN: frame.data.length,
      DATA: [...frame.data, ...Array(8 - frame.data.length).fill(0)]
    }));
    if (status !== 0) throw await this.error("PcanWriteFailed", status);
  }
  async read(channel: number): Promise<PcanDriverFrame | undefined> {
    await this.ensureApi();
    const message: any = {};
    const timestamp: any = {};
    const status = Number(this.api!.read(channel, message, timestamp));
    if (status === PCAN_ERROR_QRCVEMPTY) return undefined;
    if (status !== 0) throw await this.error(status & 0x10 ? "PcanBusOff" : "PcanReadFailed", status);
    const micros = (Number(timestamp.millis ?? 0) + Number(timestamp.millis_overflow ?? 0) * 0x100000000) * 1000 + Number(timestamp.micros ?? 0);
    return {
      id: Number(message.ID),
      data: Array.from(message.DATA as ArrayLike<number>).slice(0, Number(message.LEN)),
      extended: Boolean(Number(message.MSGTYPE) & PCAN_MESSAGE_EXTENDED),
      timestampMicros: micros
    };
  }
  async getErrorText(errorCode: number): Promise<string> {
    await this.ensureApi();
    const buffer = Buffer.alloc(256);
    const status = Number(this.api!.errorText(errorCode, 0, buffer));
    return status === 0 ? buffer.toString("utf8").replace(/\0.*$/s, "").trim() : `PCAN error 0x${errorCode.toString(16)}`;
  }
  async versions(): Promise<{ dllVersion?: string; driverVersion?: string }> {
    await this.ensureApi();
    const channel = this.activeChannel ?? 0;
    return {
      dllVersion: this.readValue(channel, 0x05),
      driverVersion: this.readValue(channel, 0x06)
    };
  }

  private async ensureApi(): Promise<void> {
    if (this.api) return;
    this.libraryPath = await resolvePcanBasicLibrary(this.configuredLibraryPath);
    let koffi: any;
    try {
      const dynamicImport = Function("specifier", "return import(specifier)") as (specifier: string) => Promise<any>;
      koffi = await dynamicImport("koffi");
    } catch (error) {
      throw new DebugMcpError("PcanLibraryNotFound", "PCANBasic.dll exists but optional native binding 'koffi' is unavailable", { libraryPath: this.libraryPath, cause: error instanceof Error ? error.message : String(error) });
    }
    const library = koffi.load(this.libraryPath);
    this.messageType = koffi.struct("TPCANMsg", {
      ID: "uint32",
      MSGTYPE: "uint8",
      LEN: "uint8",
      DATA: koffi.array("uint8", 8)
    });
    koffi.struct("TPCANTimestamp", {
      millis: "uint32",
      millis_overflow: "uint16",
      micros: "uint16"
    });
    this.api = {
      initialize: library.func("uint32 __stdcall CAN_Initialize(uint16, uint16, uint32, uint32, uint16)"),
      uninitialize: library.func("uint32 __stdcall CAN_Uninitialize(uint16)"),
      reset: library.func("uint32 __stdcall CAN_Reset(uint16)"),
      status: library.func("uint32 __stdcall CAN_GetStatus(uint16)"),
      write: library.func("uint32 __stdcall CAN_Write(uint16, const TPCANMsg *)"),
      read: library.func("uint32 __stdcall CAN_Read(uint16, _Out_ TPCANMsg *, _Out_ TPCANTimestamp *)"),
      errorText: library.func("uint32 __stdcall CAN_GetErrorText(uint32, uint16, _Out_ char *)"),
      getValue: library.func("uint32 __stdcall CAN_GetValue(uint16, uint8, _Out_ void *, uint32)")
    };
  }

  private async check(code: "PcanInitializeFailed", status: unknown): Promise<void> {
    const numeric = Number(status);
    if (numeric === 0) return;
    throw new DebugMcpError(code, await this.getErrorText(numeric), { pcanErrorCode: numeric, libraryPath: this.libraryPath });
  }

  private async error(code: "PcanWriteFailed" | "PcanReadFailed" | "PcanBusOff", status: number): Promise<DebugMcpError> {
    return new DebugMcpError(code, await this.getErrorText(status), { pcanErrorCode: status, libraryPath: this.libraryPath });
  }

  private readValue(channel: number, parameter: number): string | undefined {
    const buffer = Buffer.alloc(256);
    const status = Number(this.api!.getValue(channel, parameter, buffer, buffer.length));
    return status === 0 ? buffer.toString("utf8").replace(/\0.*$/s, "").trim() || undefined : undefined;
  }
}
