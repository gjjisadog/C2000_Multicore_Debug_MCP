export interface PcanBasicConfiguration {
  adapterId: string;
  channel: string;
  bitrate: 125000 | 250000 | 500000 | 1000000;
  libraryPath?: string;
  receivePollIntervalMs?: number;
  captureBufferFrames?: number;
  busOffRecovery?: "manual" | "reinitialize";
}

export interface PcanDriverFrame {
  id: number;
  data: number[];
  extended: boolean;
  timestampMicros?: number;
}

export interface PcanStatus {
  code: number;
  busWarning: boolean;
  busPassive: boolean;
  busOff: boolean;
}
