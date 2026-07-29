import { randomUUID } from "node:crypto";
import type { DebugAdapter, AdapterCreateSessionOptions, AdapterSession } from "./types.js";
import type { CoreId, CoreInfo, EvaluateResult, ExpressionAssignmentValue, ResolveResult, ResetType, TargetState, TargetStateName } from "../debug/types.js";
import { DebugMcpError } from "../utils/errors.js";

interface MockCoreState {
  connected: boolean;
  active: boolean;
  state: TargetStateName;
  pc: string;
  loadedProgram?: string;
  loadedSymbols?: string;
  expressions: Map<string, Omit<EvaluateResult, "expression" | "success">>;
  memory: Map<string, string>;
  variableReadIndexes: Map<string, number>;
}

export interface MockVariableSequence {
  typeName: string;
  address: string;
  values: Array<string | number>;
  errorAt?: number[];
}

export interface MockDlogChannel {
  typeName: "float" | "uint16_t" | "int16_t" | "uint32_t" | "int32_t";
  address: string;
  values: Array<string | number>;
}

export interface MockDebugAdapterOptions {
  expressionValues?: Record<string, Omit<EvaluateResult, "expression" | "success">>;
  variableSequences?: Record<string, MockVariableSequence>;
  variableBatchDelayMs?: number;
  dlogChannels?: Record<string, MockDlogChannel>;
}

const DEFAULT_MOCK_VARIABLE_SEQUENCES: Record<string, MockVariableSequence> = {
  "g_stCtrl.uiState": { typeName: "uint16_t", address: "0x1000", values: [0, 1, 2, 3] },
  "g_stClaDiag.ulExecCnt": { typeName: "uint32_t", address: "0x1010", values: [100, 101, 102, 103] },
  "g_stIpcDiag.ulRxCnt": { typeName: "uint32_t", address: "0x1020", values: [10, 11, 12, 13] }
};

export class MockDebugAdapter implements DebugAdapter {
  readonly name = "mock";
  readonly supportsSimultaneousOperations = false;
  private readonly sessions = new Map<string, Map<CoreId, MockCoreState>>();
  private readonly expressionValues: Record<string, Omit<EvaluateResult, "expression" | "success">>;
  private readonly variableSequences: Record<string, MockVariableSequence>;
  private readonly variableBatchDelayMs: number;
  private readonly dlogChannels: Record<string, MockDlogChannel>;

  constructor(options: MockDebugAdapterOptions = {}) {
    this.expressionValues = options.expressionValues ?? {};
    this.variableSequences = { ...DEFAULT_MOCK_VARIABLE_SEQUENCES, ...(options.variableSequences ?? {}) };
    this.variableBatchDelayMs = options.variableBatchDelayMs ?? 0;
    this.dlogChannels = options.dlogChannels ?? {};
  }

  async createSession(options: AdapterCreateSessionOptions): Promise<AdapterSession> {
    const adapterSessionId = `mock-${randomUUID()}`;
    const states = new Map<CoreId, MockCoreState>();
    for (const core of options.coreMap) {
      states.set(core.coreId, {
        connected: false,
        active: false,
        state: "Disconnected",
        pc: "0x00000000",
        expressions: new Map(Object.entries(this.expressionValues).map(([expression, value]) => [expression, { ...value }])),
        memory: new Map(),
        variableReadIndexes: new Map()
      });
    }
    this.sessions.set(adapterSessionId, states);
    return { adapterSessionId, sessionName: options.sessionName, ccxmlPath: options.ccxmlPath, coreMap: options.coreMap };
  }

  async listCores(session: AdapterSession): Promise<CoreInfo[]> {
    const states = this.getStates(session);
    return session.coreMap.map(core => {
      const state = states.get(core.coreId);
      return {
        ...core,
        connected: state?.connected ?? false,
        active: state?.active ?? false
      };
    });
  }

  async connect(session: AdapterSession, coreId: CoreId): Promise<void> {
    const state = this.getCoreState(session, coreId);
    state.connected = true;
    state.active = true;
    state.state = "Connected";
  }

  async disconnect(session: AdapterSession, coreId: CoreId): Promise<void> {
    const state = this.getCoreState(session, coreId);
    state.connected = false;
    state.active = false;
    state.state = "Disconnected";
  }

  async run(session: AdapterSession, coreId: CoreId): Promise<void> {
    const state = this.requireConnected(session, coreId);
    state.state = "Running";
    state.active = true;
  }

  async halt(session: AdapterSession, coreId: CoreId): Promise<void> {
    const state = this.requireConnected(session, coreId);
    state.state = "Halted";
    state.active = true;
  }

  async reset(session: AdapterSession, coreId: CoreId, resetType: ResetType): Promise<void> {
    if (!["cpu", "system", "restart", "default"].includes(resetType)) {
      throw new DebugMcpError("UnsupportedResetType", `Unsupported resetType: ${resetType}`, { resetType });
    }
    const state = this.requireConnected(session, coreId);
    state.state = "Halted";
    state.pc = "0x00000000";
  }

  async loadProgram(session: AdapterSession, coreId: CoreId, programUri: string): Promise<void> {
    const state = this.requireConnected(session, coreId);
    state.loadedProgram = programUri;
    state.state = "Halted";
    state.pc = "0x00000000";
  }

  async loadSymbols(session: AdapterSession, coreId: CoreId, programUri: string): Promise<void> {
    const state = this.requireConnected(session, coreId);
    state.loadedSymbols = programUri;
  }

  async writeMemory(session: AdapterSession, coreId: CoreId, page: string, address: number, value: number, typeSize: number): Promise<void> {
    const state = this.requireConnected(session, coreId);
    state.memory.set(`${page}:${address}:${typeSize}`, String(value));
  }

  async readMemory(session: AdapterSession, coreId: CoreId, page: string, address: number, typeSize: number): Promise<number> {
    const state = this.requireConnected(session, coreId);
    const raw = state.memory.get(`${page}:${address}:${typeSize}`);
    if (raw === undefined) {
      return 0;
    }
    return Number(raw);
  }

  async getState(session: AdapterSession, coreId: CoreId): Promise<TargetState> {
    const state = this.getCoreState(session, coreId);
    const core = session.coreMap.find(item => item.coreId === coreId);
    if (!core) {
      throw new DebugMcpError("CoreNotFound", `Core ${coreId} was not found`, { coreId });
    }
    return {
      coreId,
      coreName: core.coreName,
      connected: state.connected,
      state: state.connected ? state.state : "Disconnected",
      pc: state.pc
    };
  }

  async readPc(session: AdapterSession, coreId: CoreId): Promise<string> {
    return this.getCoreState(session, coreId).pc;
  }

  async evaluateExpression(session: AdapterSession, coreId: CoreId, expression: string): Promise<EvaluateResult> {
    const state = this.getCoreState(session, coreId);
    const addressMatch = expression.match(/^&\((.+)\)$/);
    if (addressMatch) {
      const dlog = this.dlogChannels[addressMatch[1]!];
      if (dlog) return { expression, success: true, value: dlog.address, type: `${dlog.typeName} *` };
      const sequence = this.variableSequences[addressMatch[1]!];
      if (sequence) return { expression, success: true, value: sequence.address, type: `${sequence.typeName} *` };
    }
    const sizeMatch = expression.match(/^sizeof\((.+)\)$/);
    if (sizeMatch) {
      const dlogSymbol = sizeMatch[1]!.replace(/\[0\]$/, "");
      const dlog = this.dlogChannels[dlogSymbol];
      if (dlog) return { expression, success: true, value: String(c28xAddressUnits(dlog.typeName)), type: "unsigned int" };
      const sequence = this.variableSequences[sizeMatch[1]!];
      if (sequence) return { expression, success: true, value: String(c28xAddressUnits(sequence.typeName)), type: "unsigned int" };
    }
    const dlogElementMatch = expression.match(/^(.+)\[(\d+)\]$/);
    if (dlogElementMatch) {
      const dlog = this.dlogChannels[dlogElementMatch[1]!];
      const index = Number(dlogElementMatch[2]);
      if (dlog && Number.isSafeInteger(index) && index >= 0 && index < dlog.values.length) {
        return {
          expression,
          success: true,
          value: String(dlog.values[index]),
          type: dlog.typeName,
          address: dlog.address
        };
      }
    }
    const sequence = this.variableSequences[expression];
    if (sequence) {
      const index = state.variableReadIndexes.get(expression) ?? 0;
      state.variableReadIndexes.set(expression, index + 1);
      if (sequence.errorAt?.includes(index)) {
        throw new DebugMcpError("MockVariableReadError", `Injected variable read error: ${expression}`, { expression, index });
      }
      const value = sequence.values[Math.min(index, Math.max(0, sequence.values.length - 1))];
      if (value === undefined) throw new DebugMcpError("MockVariableSequenceEmpty", `Mock variable sequence is empty: ${expression}`, { expression });
      return { expression, success: true, value: String(value), type: sequence.typeName, address: sequence.address };
    }
    const value = state.expressions.get(expression);
    if (!value) {
      throw new DebugMcpError("SymbolNotFound", `Symbol not found: ${expression}`, { expression });
    }
    return { expression, success: true, ...value };
  }

  async evaluateExpressions(session: AdapterSession, coreId: CoreId, expressions: string[], _timeoutMs?: number): Promise<EvaluateResult[]> {
    if (this.variableBatchDelayMs > 0) await new Promise(resolve => setTimeout(resolve, this.variableBatchDelayMs));
    return Promise.all(expressions.map(async expression => {
      try {
        return await this.evaluateExpression(session, coreId, expression);
      } catch (error) {
        return {
          expression,
          success: false,
          error: {
            code: error instanceof DebugMcpError ? error.code : "MockVariableReadError",
            message: error instanceof Error ? error.message : String(error)
          }
        };
      }
    }));
  }

  async assignExpression(session: AdapterSession, coreId: CoreId, expression: string, value: ExpressionAssignmentValue): Promise<{ success: boolean; value?: string }> {
    const state = this.requireConnected(session, coreId);
    const assignedValue = formatAssignmentValue(value);
    const previous = state.expressions.get(expression);
    state.expressions.set(expression, {
      value: assignedValue,
      type: previous?.type,
      address: previous?.address
    });
    return { success: true, value: assignedValue };
  }

  async resolveAddress(_session: AdapterSession, _coreId: CoreId, address: string): Promise<ResolveResult> {
    return {
      success: false,
      address,
      pc: address,
      partial: true,
      error: {
        code: "AddressResolveFailed",
        message: "Address-to-source mapping is not implemented by the mock adapter"
      }
    };
  }

  async disposeSession(session: AdapterSession): Promise<void> {
    this.sessions.delete(session.adapterSessionId);
  }

  private getStates(session: AdapterSession): Map<CoreId, MockCoreState> {
    const states = this.sessions.get(session.adapterSessionId);
    if (!states) {
      throw new DebugMcpError("SessionNotFound", `Adapter session ${session.adapterSessionId} was not found`, {
        adapterSessionId: session.adapterSessionId
      });
    }
    return states;
  }

  private getCoreState(session: AdapterSession, coreId: CoreId): MockCoreState {
    const state = this.getStates(session).get(coreId);
    if (!state) {
      throw new DebugMcpError("CoreNotFound", `Core ${coreId} was not found`, { coreId });
    }
    return state;
  }

  private requireConnected(session: AdapterSession, coreId: CoreId): MockCoreState {
    const state = this.getCoreState(session, coreId);
    if (!state.connected) {
      throw new DebugMcpError("CoreNotConnected", `Core ${coreId} is not connected`, { coreId });
    }
    return state;
  }
}

function formatAssignmentValue(value: ExpressionAssignmentValue): string {
  if (typeof value === "boolean") {
    return value ? "1" : "0";
  }
  return String(value);
}

function c28xAddressUnits(typeName: string): 1 | 2 {
  const normalized = typeName.toLowerCase().replace(/\b(const|volatile)\b/g, "").replace(/\s+/g, " ").trim();
  if (["uint16_t", "int16_t", "int", "signed int", "unsigned int", "short", "signed short", "unsigned short"].includes(normalized) ||
      /^enum(?:\s|$)/.test(normalized)) return 1;
  if (["uint32_t", "int32_t", "long", "signed long", "unsigned long", "float"].includes(normalized)) return 2;
  throw new DebugMcpError("VariableTypeUnsupported", "Mock variable sequence type is unsupported", { typeName });
}
