import type { DebugAdapter, AdapterCreateSessionOptions, AdapterSession } from "./types.js";
import type { CoreId, CoreInfo, EvaluateResult, ExpressionAssignmentValue, ResolveResult, ResetEvidence, ResetType, TargetRunState } from "../debug/types.js";
import type { CcsScriptingBridge, CcsScriptingCommand } from "./CcsScriptingBridge.js";
import { formatExpressionAssignmentValue } from "./CcsScriptingBridge.js";
import { PersistentDssBridge } from "./PersistentDssBridge.js";
import { DebugMcpError, toStructuredError } from "../utils/errors.js";
import { normalizeProgramUri } from "../utils/pathUtils.js";

export interface CcsScriptingAdapterOptions {
  ccsInstallPath?: string;
  workspacePath?: string;
  dssTimeoutMs?: number;
  timeouts?: Partial<DssTimeouts>;
  ownership?: { boardId?: string; probeSerial?: string; workerInstanceId?: string; daemonInstanceId?: string };
}

/**
 * Per-operation DSS budgets. `flashPrepareMs` is deliberately separate from
 * `stateReadMs`: `prepareFlashLoad` runs the Flash Plugin's ConfigureClock and
 * ConfigureBanks on the owner core, which is a Flash operation rather than a
 * fast state read. Sharing one budget with state polling is what made the
 * F28P65x CPU2 preparation time out at the state-read deadline.
 */
export interface DssTimeouts {
  startupMs: number; connectMs: number; stateReadMs: number; expressionReadMs: number;
  addressResolveMs: number; resetMs: number; flashPrepareMs: number; programLoadMs: number;
  memoryWriteMs: number; shutdownRequestMs: number; processExitMs: number;
}

const DEFAULT_TIMEOUTS: DssTimeouts = { startupMs: 60000, connectMs: 30000, stateReadMs: 5000, expressionReadMs: 5000, addressResolveMs: 5000, resetMs: 30000, flashPrepareMs: 120000, programLoadMs: 300000, memoryWriteMs: 10000, shutdownRequestMs: 3000, processExitMs: 5000 };

export class CcsScriptingAdapter implements DebugAdapter {
  readonly name = "ccs-scripting";
  readonly supportsSimultaneousOperations = false;

  constructor(
    private readonly options: CcsScriptingAdapterOptions = {},
    private readonly bridge: CcsScriptingBridge = new PersistentDssBridge({
      ccsInstallPath: options.ccsInstallPath,
      workspacePath: options.workspacePath,
      // Persistent DSS has its own Java-side script deadline.  When no
      // explicit global deadline is configured, start it with the program-load
      // budget; individual commands still carry their operation-specific
      // timeout below.
      timeoutMs: options.dssTimeoutMs
        ?? options.timeouts?.programLoadMs
        ?? DEFAULT_TIMEOUTS.programLoadMs,
      startupMs: options.timeouts?.startupMs,
      shutdownRequestMs: options.timeouts?.shutdownRequestMs,
      processExitMs: options.timeouts?.processExitMs
      , ownership: options.ownership
    })
  ) {}

  /** CCS workspace used for relative program/map resolution and DSS process cwd/env. */
  get workspacePath(): string | undefined {
    return this.options.workspacePath;
  }

  ownedProcesses(): Record<string, unknown>[] {
    return this.bridge.ownedProcesses?.() ?? [];
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
      // DSS runs with the configured CCS workspace as its cwd, which can differ
      // from the MCP process cwd. Resolve before launching DSS so a caller's
      // relative target configuration is never reinterpreted by CCS.
      ccxmlPath: normalizeProgramUri(options.ccxmlPath),
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

  async refreshSessionForProgramLoad(session: AdapterSession, coreId: CoreId): Promise<AdapterSession> {
    if (coreId !== 0) {
      return session;
    }
    await this.disposeSession(session);
    return this.createSession({
      sessionName: session.sessionName,
      ccxmlPath: session.ccxmlPath,
      coreMap: session.coreMap
    });
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

  async loadSymbols(session: AdapterSession, coreId: CoreId, programUri: string): Promise<void> {
    await this.execute(session, coreId, { operation: "loadSymbols", programUri });
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

  async reset(session: AdapterSession, coreId: CoreId, resetType: ResetType): Promise<ResetEvidence> {
    const result = await this.execute(session, coreId, { operation: "reset", resetType });
    if (result.requestedResetType !== resetType || result.effectiveResetType !== resetType ||
        result.completion !== "halt-observed" || typeof result.resetName !== "string" ||
        typeof result.mechanism !== "string") {
      throw new DebugMcpError("DssCommandFailed", "CCS reset lacks matching completion evidence", {
        coreId, resetType, result
      });
    }
    return result as unknown as ResetEvidence;
  }

  async prepareFirmwareHandoff(session: AdapterSession, coreId: CoreId): Promise<void> {
    if (!this.bridge.supportsFirmwareHandoff) {
      throw new DebugMcpError("AdapterNotAvailable", "Firmware handoff requires persistent DSS", { coreId });
    }
    const result = await this.execute(session, coreId, { operation: "prepareFirmwareHandoff" });
    if (result.gelInitializationDisabled !== true) {
      throw new DebugMcpError("DssCommandFailed", "Firmware handoff lacks GEL suppression evidence", { coreId, result });
    }
  }

  async loadProgram(session: AdapterSession, coreId: CoreId, programUri: string): Promise<{
    flashLoadEvidence?: Record<string, unknown>;
  } | void> {
    const result = await this.execute(session, coreId, { operation: "loadProgram", programUri });
    if (typeof result.flashLoadEvidence === "object" && result.flashLoadEvidence !== null &&
        !Array.isArray(result.flashLoadEvidence)) {
      return { flashLoadEvidence: result.flashLoadEvidence as Record<string, unknown> };
    }
  }

  /**
   * F28P65x paired Flash preparation.
   *
   * The command is routed through the *owner* core because the on-chip Flash
   * Plugin (ConfigureClock / ConfigureBanks) must execute in the DSS context
   * that owns the shared clock and bank mapping. `targetCoreId` stays in the
   * command so the prepared mapping is unambiguous: the owner configures, the
   * target is the core that will be programmed.
   */
  async prepareFlashLoad(
    session: AdapterSession,
    ownerCoreId: CoreId,
    targetCoreId: CoreId,
    flashBanks: number[]
  ): Promise<{ flashLoadEvidence?: Record<string, unknown> } | void> {
    if (ownerCoreId === targetCoreId) {
      throw new DebugMcpError(
        "FlashLoadPreparationUnsupported",
        "prepareFlashLoad requires an owner core distinct from the target core",
        { ownerCoreId, targetCoreId, flashBanks }
      );
    }
    const timeouts = { ...DEFAULT_TIMEOUTS, ...this.options.timeouts };
    const timeoutMs = timeoutForOperation("prepareFlashLoad", timeouts, this.options.dssTimeoutMs);
    let result: Record<string, unknown>;
    try {
      result = await this.execute(session, ownerCoreId, {
        operation: "prepareFlashLoad",
        targetCoreId,
        flashBanks
      });
    } catch (error) {
      throw describeFlashPreparationFailure(error, { ownerCoreId, targetCoreId, flashBanks, timeoutMs });
    }
    if (result.targetCoreId !== targetCoreId) {
      throw new DebugMcpError(
        "CoreIdentityMismatch",
        "Flash preparation did not confirm the requested target core",
        {
          ownerCoreId,
          targetCoreId,
          responseTargetCoreId: result.targetCoreId,
          flashBanks
        }
      );
    }
    if (typeof result.flashLoadEvidence === "object" && result.flashLoadEvidence !== null &&
        !Array.isArray(result.flashLoadEvidence)) {
      return { flashLoadEvidence: result.flashLoadEvidence as Record<string, unknown> };
    }
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

  async getState(session: AdapterSession, coreId: CoreId): Promise<TargetRunState> {
    const result = await this.execute(session, coreId, { operation: "getState" });
    const core = this.requireCore(session, coreId);
    return {
      coreId,
      coreName: core.coreName,
      connected: Boolean(result.connected),
      state: typeof result.state === "string" ? result.state as TargetRunState["state"] : "Unknown"
    };
  }

  async readPc(session: AdapterSession, coreId: CoreId): Promise<string> {
    const result = await this.execute(session, coreId, { operation: "readPc" });
    const raw = result.pc ?? result.value;
    const text = typeof raw === "string" ? raw.trim() : undefined;
    // DSS String(expression.evaluate("PC")) is decimal, unlike bare linker-map
    // addresses. Tag it at the adapter boundary so downstream parsers never
    // infer hexadecimal from digit count. Preserve already explicit hex PCs.
    const explicitHex = text !== undefined && /^0x[0-9a-f]+$/i.test(text);
    const value = typeof raw === "number" ? raw
      : text !== undefined && (explicitHex || /^\d+$/.test(text)) ? Number(text) : NaN;
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new DebugMcpError("AddressResolveFailed", "DSS returned an invalid PC value", {
        coreId, operation: "readPc", rawPc: raw
      });
    }
    return explicitHex ? text! : `0x${value.toString(16).padStart(8, "0")}`;
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

  async evaluateExpressions(
    session: AdapterSession,
    coreId: CoreId,
    expressions: string[],
    timeoutMs?: number,
    options?: { diagnostics?: "full" | "errors-only" }
  ): Promise<EvaluateResult[]> {
    const result = await this.execute(session, coreId, {
      operation: "evaluateExpressions",
      expressions,
      diagnostics: options?.diagnostics
    }, timeoutMs);
    return Array.isArray(result.results) ? result.results as EvaluateResult[] : [];
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
    command: Pick<CcsScriptingCommand, "operation" | "targetCoreId" | "resetType" | "programUri" | "expression" | "expressions" | "diagnostics" | "valueExpression" | "page" | "address" | "value" | "typeSize" | "flashBanks">,
    timeoutOverrideMs?: number
  ): Promise<Record<string, unknown>> {
    const core = this.requireCore(session, coreId);
    const timeouts = { ...DEFAULT_TIMEOUTS, ...this.options.timeouts };
    const timeoutMs = timeoutOverrideMs ?? timeoutForOperation(command.operation, timeouts, this.options.dssTimeoutMs);
    const result = await this.bridge.execute({
      ...command,
      adapterSessionId: session.adapterSessionId,
      ccxmlPath: session.ccxmlPath,
      coreId,
      coreName: core.coreName,
      corePattern: core.corePattern ?? core.coreName,
      timeoutMs
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

/**
 * A DSS deadline failure reaches the adapter as either the channel timeout
 * itself or the channel's reconnect wrapper, which carries the timeout only as
 * text. Recognising both keeps the Flash stage diagnosable instead of
 * collapsing into a generic transport error.
 */
export function isDssTimeoutFailure(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current !== null && current !== undefined && depth < 6; depth++) {
    const record = current as { code?: unknown; message?: unknown; details?: Record<string, unknown> };
    if (record.code === "DssCommandTimeout" || record.code === "DssTimeout") {
      return true;
    }
    if (typeof record.message === "string" && /Timed out waiting for DSS response|DssCommandTimeout/.test(record.message)) {
      return true;
    }
    const details = record.details;
    if (!details || typeof details !== "object") {
      return false;
    }
    const nested = [details.firstError, details.secondError, details.cause].find(
      candidate => candidate !== undefined
    );
    if (nested === undefined) {
      return false;
    }
    current = typeof nested === "string" ? { message: nested } : nested;
  }
  return false;
}

export interface FlashPreparationFailureContext {
  ownerCoreId: CoreId;
  targetCoreId: CoreId;
  flashBanks: number[];
  timeoutMs: number;
}

/**
 * Preserve the operation's own error (it carries the DSS flash evidence), and
 * only replace the transport deadline that lost the stage context.
 */
function describeFlashPreparationFailure(error: unknown, context: FlashPreparationFailureContext): unknown {
  if (!isDssTimeoutFailure(error)) {
    return error;
  }
  return new DebugMcpError(
    "FlashPreparationTimeout",
    `F28P65x Flash preparation timed out after ${context.timeoutMs} ms; the owner core did not finish ConfigureClock/ConfigureBanks`,
    {
      stage: "prepare-flash",
      ownerCoreId: context.ownerCoreId,
      targetCoreId: context.targetCoreId,
      flashBanks: context.flashBanks,
      timeoutMs: context.timeoutMs,
      targetMemoryWritten: false,
      cause: toStructuredError(error)
    }
  );
}

function timeoutForOperation(operation: CcsScriptingCommand["operation"], timeouts: DssTimeouts, fallback?: number): number {
  switch (operation) {
    case "connect": case "disconnect": return timeouts.connectMs;
    case "getState": case "readPc": case "run": case "halt": return timeouts.stateReadMs;
    case "evaluateExpression": case "evaluateExpressions": case "assignExpression": return timeouts.expressionReadMs;
    case "resolveAddress": return timeouts.addressResolveMs;
    case "reset": return timeouts.resetMs;
    case "prepareFlashLoad": return timeouts.flashPrepareMs;
    case "loadProgram": case "loadSymbols": return timeouts.programLoadMs;
    case "writeMemory": return timeouts.memoryWriteMs;
    default: return fallback ?? timeouts.stateReadMs;
  }
}
