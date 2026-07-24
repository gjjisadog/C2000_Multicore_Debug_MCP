import type { PcanDriverFrame, PcanStatus } from "./PcanBasicTypes.js";

export interface PcanBasicDriver {
  readonly libraryPath?: string;
  initialize(channel: number, bitrate: number): Promise<void>;
  uninitialize(channel: number): Promise<void>;
  reset(channel: number): Promise<void>;
  getStatus(channel: number): Promise<PcanStatus>;
  write(channel: number, frame: PcanDriverFrame): Promise<void>;
  read(channel: number): Promise<PcanDriverFrame | undefined>;
  getErrorText(errorCode: number, language?: number): Promise<string>;
  versions(): Promise<{ dllVersion?: string; driverVersion?: string }>;
}
