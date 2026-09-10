import type {
  CoreConfig,
  CoreId,
  CoreInfo,
  EvaluateResult,
  ExpressionAssignmentValue,
  ResolveResult,
  ResetType,
  ResetEvidence,
  TargetRunState
} from "../debug/types.js";

export interface AdapterSession {
  adapterSessionId: string;
  sessionName: string;
  ccxmlPath?: string;
  coreMap: CoreConfig[];
}

export interface AdapterCreateSessionOptions {
  sessionName: string;
  ccxmlPath?: string;
  coreMap: CoreConfig[];
}

export interface DebugAdapter {
  readonly name: string;
  readonly supportsSimultaneousOperations?: boolean;
  ownedProcesses?(): Record<string, unknown>[];
  createSession(options: AdapterCreateSessionOptions): Promise<AdapterSession>;
  disposeSession?(session: AdapterSession): Promise<void>;
  /**
   * Return the adapter session that must be used for the next program load.
   * Adapters may replace a poisoned physical debugger session while preserving
   * the caller-visible logical session.
   */
  refreshSessionForProgramLoad?(session: AdapterSession, coreId: CoreId): Promise<AdapterSession>;
  listCores(session: AdapterSession): Promise<CoreInfo[]>;
  connect(session: AdapterSession, coreId: CoreId): Promise<void>;
  disconnect(session: AdapterSession, coreId: CoreId): Promise<void>;
  run(session: AdapterSession, coreId: CoreId): Promise<void>;
  halt(session: AdapterSession, coreId: CoreId): Promise<void>;
  reset(session: AdapterSession, coreId: CoreId, resetType: ResetType): Promise<ResetEvidence | void>;
  /** Remove connect-time GEL callbacks before firmware-owned CPU2 release. */
  prepareFirmwareHandoff?(session: AdapterSession, coreId: CoreId): Promise<void>;
  loadProgram(session: AdapterSession, coreId: CoreId, programUri: string): Promise<{
    flashLoadEvidence?: Record<string, unknown>;
  } | void>;
  loadSymbols?(session: AdapterSession, coreId: CoreId, programUri: string): Promise<void>;
  prepareFlashLoad?(session: AdapterSession, coreId: CoreId, flashBanks: number[]): Promise<void>;
  writeMemory(session: AdapterSession, coreId: CoreId, page: string, address: number, value: number, typeSize: number): Promise<void>;
  readMemory?(session: AdapterSession, coreId: CoreId, page: string, address: number, typeSize: number): Promise<number>;
  /** Read connection/run state only; use readPc for an explicit PC read. */
  getState(session: AdapterSession, coreId: CoreId): Promise<TargetRunState>;
  readPc(session: AdapterSession, coreId: CoreId): Promise<string>;
  evaluateExpression(session: AdapterSession, coreId: CoreId, expression: string): Promise<EvaluateResult>;
  evaluateExpressions?(
    session: AdapterSession,
    coreId: CoreId,
    expressions: string[],
    timeoutMs?: number,
    options?: { diagnostics?: "full" | "errors-only" }
  ): Promise<EvaluateResult[]>;
  assignExpression(session: AdapterSession, coreId: CoreId, expression: string, value: ExpressionAssignmentValue): Promise<{ success: boolean; value?: string }>;
  resolveAddress(session: AdapterSession, coreId: CoreId, address: string): Promise<ResolveResult>;
}
