export type DebugErrorCode =
  | "SessionNotFound"
  | "CoreNotFound"
  | "DuplicateCoreId"
  | "DuplicateCoreTarget"
  | "DuplicateBoardId"
  | "DuplicateProbeAllocation"
  | "ProbeNotConnected"
  | "ProbeBindingMissing"
  | "ProbeBindingInvalid"
  | "CoreIdentityMissing"
  | "CoreIdentityMismatch"
  | "CoreNotConnected"
  | "OwnerCoreNotConnected"
  | "ProgramFileNotFound"
  | "ProgramLoadFailed"
  | "BatchOperationFailed"
  | "ArtifactPairInvalid"
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
  | "UnsafeDssLaunchPath"
  | "DssLaunchFailed"
  | "DssCommandFailed"
  | "DssTimeout"
  | "DssTransportFailed"
  | "DaemonUnavailable"
  | "DaemonEntrypointNotFound"
  | "DaemonStarting"
  | "DaemonAuthenticationFailed"
  | "DaemonProtocolError"
  | "DaemonInstanceInvalid"
  | "ToolNotFound"
  | "WorkerHeartbeatTimeout"
  | "WorkerCommandTimeout"
  | "WorkerUnavailable"
  | "WorkerEntrypointNotFound"
  | "WorkerIdentityMismatch"
  | "WorkerRestartLimitReached"
  | "DssUnresponsive"
  | "BoardQuarantined"
  | "BoardLeased"
  | "FlashLoadPreparationUnsupported"
  | "UnsupportedResetType"
  | "PostLaunchActionFailed"
  | "PostLaunchCheckFailed"
  | "CanProfileInvalid"
  | "CanAdapterUnavailable"
  | "CanBarrierTimeout"
  | "CanFrameMismatch"
  | "CanBusFaultInjected"
  | "CanDebugObservationFailed"
  | "BoardLeaseRequired"
  | "BoardGroupBusy"
  | "BoardGroupInvalidTransition"
  | "BoardGroupBarrierInvalid"
  | "BoardGroupBarrierTimeout"
  | "BoardGroupBarrierFailed"
  | "CanSafetyGateFailed"
  | "CanIndependentBusVerificationRequired"
  | "CanCrossBoardComparisonFailed"
  | "CanTestHookUnsupported"
  | "RamOwnershipEvidenceRequired"
  | "RamOwnershipMapUnavailable"
  | "RamOwnershipMapParseFailed"
  | "PathOutsideAllowedReadRoots"
  | "PathOutsideAllowedWriteRoots"
  | "PathResolutionFailed"
  | "ProbeNotFound"
  | "ProbeSelectionRequired"
  | "ProbeIdentityMismatch"
  | "ProbeRecoveryBlocked"
  | "DuplicateProbeId"
  | "ProbeQueueTimeout"
  | "SessionClosing"
  | "SessionClosed"
  | "SessionIdleTimeout"
  | "PersistentChannelDisconnected"
  | "PersistentChannelReconnectFailed"
  | "DssCommandTimeout"
  | "DssCommandRejected"
  | "DssSchedulerConflict"
  | "BatchExpressionFailed"
  | "EvidenceCaptureFailed"
  | "LoadVerificationFailed"
  | "ProgramUnchanged"
  | "WorkflowCleanupFailed";

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
