import type {
  CoreConfig,
  CoreId,
  CoreInfo,
  EvaluateResult,
  ExpressionAssignmentValue,
  ResolveResult,
  ResetType,
  TargetState
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
  listCores(session: AdapterSession): Promise<CoreInfo[]>;
  connect(session: AdapterSession, coreId: CoreId): Promise<void>;
  disconnect(session: AdapterSession, coreId: CoreId): Promise<void>;
  run(session: AdapterSession, coreId: CoreId): Promise<void>;
  halt(session: AdapterSession, coreId: CoreId): Promise<void>;
  reset(session: AdapterSession, coreId: CoreId, resetType: ResetType): Promise<void>;
  loadProgram(session: AdapterSession, coreId: CoreId, programUri: string): Promise<void>;
  loadSymbols?(session: AdapterSession, coreId: CoreId, programUri: string): Promise<void>;
  prepareFlashLoad?(session: AdapterSession, coreId: CoreId, flashBanks: number[]): Promise<void>;
  writeMemory(session: AdapterSession, coreId: CoreId, page: string, address: number, value: number, typeSize: number): Promise<void>;
  readMemory?(session: AdapterSession, coreId: CoreId, page: string, address: number, typeSize: number): Promise<number>;
  getState(session: AdapterSession, coreId: CoreId): Promise<TargetState>;
  readPc(session: AdapterSession, coreId: CoreId): Promise<string>;
  evaluateExpression(session: AdapterSession, coreId: CoreId, expression: string): Promise<EvaluateResult>;
  evaluateExpressions?(session: AdapterSession, coreId: CoreId, expressions: string[]): Promise<EvaluateResult[]>;
  assignExpression(session: AdapterSession, coreId: CoreId, expression: string, value: ExpressionAssignmentValue): Promise<{ success: boolean; value?: string }>;
  resolveAddress(session: AdapterSession, coreId: CoreId, address: string): Promise<ResolveResult>;
}
