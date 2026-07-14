import type { DebugAdapter, AdapterCreateSessionOptions, AdapterSession } from "./types.js";
import type { CoreId, CoreInfo, EvaluateResult, ExpressionAssignmentValue, ResolveResult, ResetType, TargetState } from "../debug/types.js";
import type { CcsScriptingBridge, CcsScriptingCommand } from "./CcsScriptingBridge.js";
import { formatExpressionAssignmentValue } from "./CcsScriptingBridge.js";
import { PersistentDssBridge } from "./PersistentDssBridge.js";
import { DebugMcpError } from "../utils/errors.js";

export interface CcsScriptingAdapterOptions {
  ccsInstallPath?: string;
  workspacePath?: string;
  dssTimeoutMs?: number;
}

export class CcsScriptingAdapter implements DebugAdapter {
  readonly name = "ccs-scripting";
  readonly supportsSimultaneousOperations = false;

  constructor(
    private readonly options: CcsScriptingAdapterOptions = {},
    private readonly bridge: CcsScriptingBridge = new PersistentDssBridge({
      ccsInstallPath: options.ccsInstallPath,
      workspacePath: options.workspacePath,
      timeoutMs: options.dssTimeoutMs
    })
  ) {}

  /** CCS workspace used for relative program/map resolution and DSS process cwd/env. */
  get workspacePath(): string | undefined {
    return this.options.workspacePath;
  }

  async createSession(options: AdapterCreateSessionOptions): Promise<AdapterSession> {
    if (!options.ccxmlPath) {
      throw new DebugMcpError("AdapterNotAvailable", "ccxmlPath is required for the CCS Scripting adapter", {
        sessionName: options.sessionName
      });
    }
    const session = {
      adapterSessionId: `ccs-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      sessionName: options.sessionName,
      ccxmlPath: options.ccxmlPath,
      coreMap: options.coreMap
    };
    await this.bridge.createSession?.({
      adapterSessionId: session.adapterSessionId,
      sessionName: session.sessionName,
      ccxmlPath: session.ccxmlPath,
      coreMap: session.coreMap
    });
    return session;
  }

  async disposeSession(session: AdapterSession): Promise<void> {
    await this.bridge.disposeSession?.(session.adapterSessionId);
  }

  async listCores(session: AdapterSession): Promise<CoreInfo[]> {
    return session.coreMap.map(core => ({
      ...core,
      connected: false,
      active: false
    }));
  }

  async connect(session: AdapterSession, coreId: CoreId): Promise<void> {
    await this.execute(session, coreId, { operation: "connect" });
  }

  async disconnect(session: AdapterSession, coreId: CoreId): Promise<void> {
    await this.execute(session, coreId, { operation: "disconnect" });
  }

  async run(session: AdapterSession, coreId: CoreId): Promise<void> {
    await this.execute(session, coreId, { operation: "run" });
  }

  async halt(session: AdapterSession, coreId: CoreId): Promise<void> {
    await this.execute(session, coreId, { operation: "halt" });
  }

  async reset(session: AdapterSession, coreId: CoreId, resetType: ResetType): Promise<void> {
    await this.execute(session, coreId, { operation: "reset", resetType });
  }

  async loadProgram(session: AdapterSession, coreId: CoreId, programUri: string): Promise<void> {
    await this.execute(session, coreId, { operation: "loadProgram", programUri });
  }

  async writeMemory(session: AdapterSession, coreId: CoreId, page: string, address: number, value: number, typeSize: number): Promise<void> {
    await this.execute(session, coreId, { operation: "writeMemory", page, address, value, typeSize });
  }

  async readMemory(session: AdapterSession, coreId: CoreId, page: string, address: number, typeSize: number): Promise<number> {
    const result = await this.execute(session, coreId, { operation: "readMemory", page, address, typeSize });
    if (typeof result.value === "number" && Number.isFinite(result.value)) {
      return result.value;
    }
    if (typeof result.value === "string" && result.value.length > 0) {
      const parsed = Number(result.value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
    throw new DebugMcpError("MemoryReadFailed", "CCS bridge readMemory did not return a numeric value", {
      coreId,
      page,
      address,
      typeSize,
      result
    });
  }

  async getState(session: AdapterSession, coreId: CoreId): Promise<TargetState> {
    const result = await this.execute(session, coreId, { operation: "getState" });
    const core = this.requireCore(session, coreId);
    return {
      coreId,
      coreName: core.coreName,
      connected: Boolean(result.connected),
      state: typeof result.state === "string" ? result.state as TargetState["state"] : "Unknown",
      pc: typeof result.pc === "string" ? result.pc : undefined
    };
  }

  async readPc(session: AdapterSession, coreId: CoreId): Promise<string> {
    const result = await this.execute(session, coreId, { operation: "readPc" });
    return typeof result.pc === "string" ? result.pc : typeof result.value === "string" ? result.value : "0x0";
  }

  async evaluateExpression(session: AdapterSession, coreId: CoreId, expression: string): Promise<EvaluateResult> {
    const result = await this.execute(session, coreId, { operation: "evaluateExpression", expression });
    return {
      expression,
      success: result.success !== false,
      value: typeof result.value === "string" ? result.value : undefined,
      type: typeof result.type === "string" ? result.type : undefined,
      address: typeof result.address === "string" ? result.address : undefined
    };
  }

  async assignExpression(session: AdapterSession, coreId: CoreId, expression: string, value: ExpressionAssignmentValue): Promise<{ success: boolean; value?: string }> {
    const result = await this.execute(session, coreId, {
      operation: "assignExpression",
      expression,
      valueExpression: formatExpressionAssignmentValue(value)
    });
    return {
      success: result.success !== false,
      value: typeof result.value === "string" ? result.value : typeof result.assignedValue === "string" ? result.assignedValue : undefined
    };
  }

  async resolveAddress(session: AdapterSession, coreId: CoreId, address: string): Promise<ResolveResult> {
    const result = await this.execute(session, coreId, { operation: "resolveAddress", address });
    const hasSymbolMapping = typeof result.function === "string"
      || typeof result.sourceFile === "string"
      || typeof result.line === "number";
    const explicitSuccess = result.success === true && hasSymbolMapping;
    return {
      success: explicitSuccess,
      address,
      pc: typeof result.pc === "string" ? result.pc : address,
      function: typeof result.function === "string" ? result.function : undefined,
      sourceFile: typeof result.sourceFile === "string" ? result.sourceFile : undefined,
      line: typeof result.line === "number" ? result.line : undefined,
      offset: typeof result.offset === "string" ? result.offset : undefined,
      partial: typeof result.partial === "boolean" ? result.partial : !explicitSuccess,
      ...(explicitSuccess
        ? {}
        : {
          error: {
            code: "AddressResolveFailed",
            message: typeof result.error === "string"
              ? result.error
              : "Address-to-source mapping is not implemented by the CCS scripting adapter"
          }
        })
    };
  }

  private async execute(
    session: AdapterSession,
    coreId: CoreId,
    command: Pick<CcsScriptingCommand, "operation" | "resetType" | "programUri" | "expression" | "valueExpression" | "page" | "address" | "value" | "typeSize">
  ): Promise<Record<string, unknown>> {
    const core = this.requireCore(session, coreId);
    const result = await this.bridge.execute({
      ...command,
      adapterSessionId: session.adapterSessionId,
      ccxmlPath: session.ccxmlPath,
      coreId,
      coreName: core.coreName,
      corePattern: core.corePattern ?? core.coreName
    });
    this.assertResponseCoreIdentity(result, coreId, core.coreName);
    return result;
  }

  private requireCore(session: AdapterSession, coreId: CoreId) {
    const core = session.coreMap.find(item => item.coreId === coreId);
    if (!core) {
      throw new DebugMcpError("CoreNotFound", `Core ${coreId} was not found in CCS adapter session`, { coreId });
    }
    return core;
  }

  private assertResponseCoreIdentity(response: Record<string, unknown>, requestedCoreId: CoreId, requestedCoreName: string) {
    if (!("coreId" in response) || !("coreName" in response)) {
      throw new DebugMcpError("CoreIdentityMissing", "CCS bridge response did not include requested core identity", {
        requestedCoreId,
        requestedCoreName,
        responseCoreId: response.coreId,
        responseCoreName: response.coreName
      });
    }
    if (typeof response.coreId !== "number" || response.coreId !== requestedCoreId) {
      throw new DebugMcpError("CoreIdentityMismatch", "CCS bridge response coreId did not match requested coreId", {
        requestedCoreId,
        requestedCoreName,
        responseCoreId: response.coreId,
        responseCoreName: response.coreName
      });
    }
    if (response.coreName !== requestedCoreName) {
      throw new DebugMcpError("CoreIdentityMismatch", "CCS bridge response coreName did not match requested coreName", {
        requestedCoreId,
        requestedCoreName,
        responseCoreId: response.coreId,
        responseCoreName: response.coreName
      });
    }
  }
}
