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
  expressions: Map<string, Omit<EvaluateResult, "expression" | "success">>;
  memory: Map<string, string>;
}

export interface MockDebugAdapterOptions {
  expressionValues?: Record<string, Omit<EvaluateResult, "expression" | "success">>;
}

export class MockDebugAdapter implements DebugAdapter {
  readonly name = "mock";
  readonly supportsSimultaneousOperations = false;
  private readonly sessions = new Map<string, Map<CoreId, MockCoreState>>();
  private readonly expressionValues: Record<string, Omit<EvaluateResult, "expression" | "success">>;

  constructor(options: MockDebugAdapterOptions = {}) {
    this.expressionValues = options.expressionValues ?? {};
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
        memory: new Map()
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

  async writeMemory(session: AdapterSession, coreId: CoreId, page: string, address: number, value: number, typeSize: number): Promise<void> {
    const state = this.requireConnected(session, coreId);
    state.memory.set(`${page}:${address}:${typeSize}`, String(value));
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
    const value = this.getCoreState(session, coreId).expressions.get(expression);
    if (!value) {
      throw new DebugMcpError("SymbolNotFound", `Symbol not found: ${expression}`, { expression });
    }
    return { expression, success: true, ...value };
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
      success: true,
      address,
      pc: address,
      partial: true
    };
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
