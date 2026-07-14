export type DebugErrorCode =
  | "SessionNotFound"
  | "CoreNotFound"
  | "DuplicateCoreId"
  | "DuplicateCoreTarget"
  | "CoreIdentityMissing"
  | "CoreIdentityMismatch"
  | "CoreNotConnected"
  | "OwnerCoreNotConnected"
  | "ProgramFileNotFound"
  | "ProgramLoadFailed"
  | "LaunchProgramMissing"
  | "MemoryReadFailed"
  | "RamOwnershipVerifyFailed"
  | "TargetConnectFailed"
  | "TargetRunFailed"
  | "TargetHaltFailed"
  | "SymbolNotFound"
  | "ExpressionEvaluateFailed"
  | "ExpressionAssignFailed"
  | "ExpressionVerifyFailed"
  | "AddressResolveFailed"
  | "AdapterNotAvailable"
  | "DssNotFound"
  | "DssLaunchFailed"
  | "DssCommandFailed"
  | "DssTimeout"
  | "DssTransportFailed"
  | "UnsupportedResetType"
  | "PostLaunchActionFailed"
  | "PostLaunchCheckFailed";

export interface StructuredError {
  code: DebugErrorCode | string;
  message: string;
  details?: Record<string, unknown>;
}

export class DebugMcpError extends Error {
  readonly code: DebugErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: DebugErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = code;
    this.code = code;
    this.details = details;
  }
}

export function toStructuredError(error: unknown): StructuredError {
  if (error instanceof DebugMcpError) {
    return { code: error.code, message: error.message, details: error.details };
  }
  if (error instanceof Error) {
    return { code: "UnknownError", message: error.message };
  }
  return { code: "UnknownError", message: String(error) };
}
