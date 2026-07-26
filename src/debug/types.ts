export type CoreId = number;

export type ResetType = "cpu" | "system" | "restart" | "default";

export type TargetStateName = "Disconnected" | "Connected" | "Running" | "Halted" | "Unknown";

export interface CoreConfig {
  coreId: CoreId;
  coreName: string;
  corePattern?: string;
}

export interface CoreInfo extends CoreConfig {
  connected: boolean;
  active: boolean;
}

export interface CoreTopology extends CoreConfig {
  targetSelector: string;
  debugSessionKey: string;
}

export interface SessionTopology {
  sessionId: string;
  sessionName: string;
  ccxmlPath?: string;
  workspacePath?: string;
  adapterName: string;
  adapterSessionId: string;
  debugSessionRoute: "sessionId -> adapterSessionId -> coreId -> DebugSession";
  cores: CoreTopology[];
}

export interface CreateDebugSessionOptions {
  sessionName: string;
  ccxmlPath?: string;
  /** Optional board identity retained in launch diagnostics and multi-board callers. */
  boardId?: string;
  coreMap: CoreConfig[];
  probeId?: string;
  preferredProbeIds?: string[];
  allowAutoProbeAllocation?: boolean;
}

export interface TargetState {
  coreId: CoreId;
  coreName: string;
  connected: boolean;
  state: TargetStateName;
  pc?: string;
}

export interface LoadProgramRequest {
  coreId: CoreId;
  programUri: string;
  mapUri?: string;
  ramOwnershipPolicy?: RamOwnershipPolicy;
  fallbackGsRegions?: number[];
  loadPolicy?: LoadPolicy;
}

export type LoadPolicy = "always" | "if-changed" | "verify-mcp-registry" | "verify-only";

export type RamOwnershipPolicy = "require-map" | "explicit-fallback" | "skip";

export interface RamOwnershipPreparation {
  ramOwnershipPolicy: RamOwnershipPolicy;
  ramOwnershipPrepared: boolean;
  ramOwnershipSkipped: boolean;
  fallbackUsed: boolean;
  ownershipWrites: Array<unknown>;
}

export interface LoadedProgramInfo {
  sessionId: string;
  coreId: CoreId;
  coreName: string;
  programUri: string;
  mapUri?: string;
  loadedAt: string;
  fileMTime: string;
  fileSize: number;
  sha256: string;
  symbolsLoaded: boolean;
  warning: string;
  ramOwnership?: RamOwnershipPreparation;
}

export interface EvaluateResult {
  expression: string;
  success: boolean;
  value?: string;
  type?: string;
  address?: string;
  error?: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

export type ExpressionAssignmentValue = string | number | boolean;

export interface ExpressionAssignmentResult {
  sessionId: string;
  coreId: CoreId;
  coreName: string;
  expression: string;
  assignedValue: string;
  write: {
    success: boolean;
    value?: string;
  };
  readback?: EvaluateResult;
}

export interface ExpressionAssignmentRequest {
  coreId: CoreId;
  expression: string;
  value: ExpressionAssignmentValue;
  verify?: boolean;
}

export type ExpressionAssignmentBatchItemResult = (ExpressionAssignmentResult & { success: true }) | {
  coreId: CoreId;
  expression: string;
  success: false;
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
};

export interface FaultInjectionRequest extends ExpressionAssignmentRequest {
  label?: string;
}

export type FaultInjectionBatchItemResult = (ExpressionAssignmentResult & { success: true; label?: string }) | {
  label?: string;
  coreId: CoreId;
  expression: string;
  success: false;
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
};

export interface ExpressionEndpoint {
  coreId: CoreId;
  expression: string;
}

export interface ExpressionComparisonRequest {
  label?: string;
  left: ExpressionEndpoint;
  right: ExpressionEndpoint;
}

export interface ExpressionEndpointResult extends ExpressionEndpoint {
  success: boolean;
  value?: string;
  type?: string;
  address?: string;
  error?: EvaluateResult["error"];
}

export interface ExpressionComparisonResult {
  label?: string;
  matched: boolean;
  left: ExpressionEndpointResult;
  right: ExpressionEndpointResult;
}

export interface ResolveResult {
  success: boolean;
  address: string;
  pc?: string;
  function?: string;
  sourceFile?: string;
  line?: number;
  offset?: string;
  memoryRegion?: string;
  resolutionSource?: "ccs" | "linker-map";
  partial?: boolean;
  error?: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

export interface CoreSnapshot {
  coreId: CoreId;
  coreName: string;
  name: string;
  connected: boolean;
  state: TargetStateName;
  pc?: string;
  loadedProgram?: string;
  loadedProgramInfo?: LoadedProgramInfo;
}

export interface BatchItemResult {
  coreId: CoreId;
  coreName?: string;
  success: boolean;
  programUri?: string;
  loaded?: boolean;
  skipped?: boolean;
  skipReason?: string;
  error?: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

export const defaultF28P65xCoreMap: CoreConfig[] = [
  { coreId: 0, coreName: "C28xx_CPU1", corePattern: "C28xx_CPU1" },
  { coreId: 2, coreName: "C28xx_CPU2", corePattern: "C28xx_CPU2" }
];
