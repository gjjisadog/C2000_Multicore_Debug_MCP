import type { C2000McpConfig } from "../config/config.schema.js";
import { createC2000McpRuntime, type C2000McpRuntime } from "../server.js";
import type { WorkerHeartbeat } from "./WorkerHeartbeat.js";
import type { BoardLeaseContext } from "../boards/types.js";
import { DebugMcpError } from "../utils/errors.js";
import { internalVariableBatchSchema, VARIABLE_STREAM_INTERNAL_TOOL } from "../observability/VariableStreamSchemas.js";
import { DLOG_EXPRESSION_BATCH_TOOL, internalDlogExpressionBatchSchema } from "../observability/DlogSchemas.js";
import { ERAD_INTERNAL_TOOL, internalEradCommandSchema } from "../observability/EradSchemas.js";
import {
  F28p65xEradRegisterBackend,
  MockEradBackend,
  type EradBackend
} from "../observability/EradBackend.js";
import { INTERNAL_CLOSE_STALE_RESIDENT_SESSION } from "./internalTools.js";

export interface BoardWorkerLaunchOptions {
  boardId: string;
  probeSerial: string;
  ccxmlPath: string;
  workerInstanceId: string;
  daemonInstanceId: string;
  authToken: string;
}

/** Worker-local owner of one board's DebugSessionManager and persistent DSS children. */
export class BoardWorkerRuntime {
  private runtime?: C2000McpRuntime;
  private status: WorkerHeartbeat["status"] = "STARTING";
  private currentCommandId?: string;
  private lastSuccessfulCommandAt?: string;
  private acceptedFencingToken = 0;
  private acceptedLeaseId?: string;
  private eradBackend?: EradBackend;

  constructor(
    readonly options: BoardWorkerLaunchOptions,
    private readonly config: C2000McpConfig
  ) {}

  get effectiveAdapterType(): "ccs" | "mock" {
    return this.runtime?.adapterResolution.mode ?? (this.config.adapter === "mock" || this.config.ccs.scriptingMode === "mock" ? "mock" : "ccs");
  }

  async start(): Promise<void> {
    const workerConfig: C2000McpConfig = {
      ...this.config,
      ccs: { ...this.config.ccs, ccxmlPath: this.options.ccxmlPath }
    };
    this.runtime = await createC2000McpRuntime(workerConfig, {}, {
      boardId: this.options.boardId,
      probeSerial: this.options.probeSerial,
      workerInstanceId: this.options.workerInstanceId,
      daemonInstanceId: this.options.daemonInstanceId
    });
    this.eradBackend = workerConfig.adapter === "mock" || workerConfig.ccs.scriptingMode === "mock"
      ? new MockEradBackend()
      : new F28p65xEradRegisterBackend();
    this.status = "READY";
  }

  async invoke(commandId: string, toolName: string, input: unknown): Promise<Record<string, unknown>> {
    if (!this.runtime) throw new Error("Board worker is not ready");
    const { leaseContext, toolInput } = splitLeaseContext(input);
    if (toolName !== INTERNAL_CLOSE_STALE_RESIDENT_SESSION) {
      this.validateLeaseContext(leaseContext, toolName);
    }
    this.status = "RUNNING";
    this.currentCommandId = commandId;
    try {
      const result = toolName === INTERNAL_CLOSE_STALE_RESIDENT_SESSION
        ? await this.closeStaleResidentSession(toolInput)
        : toolName === VARIABLE_STREAM_INTERNAL_TOOL
        ? await this.readVariableBatch(toolInput)
        : toolName === DLOG_EXPRESSION_BATCH_TOOL
          ? await this.readDlogExpressionBatch(toolInput)
          : toolName === ERAD_INTERNAL_TOOL
            ? await this.invokeErad(toolInput)
          : await this.runtime.toolInvoker.invokeTool(toolName, toolInput);
      this.lastSuccessfulCommandAt = new Date().toISOString();
      return {
        ...result,
        boardId: this.options.boardId,
        probeSerial: this.options.probeSerial,
        workerInstanceId: this.options.workerInstanceId,
        configuredAdapterMode: this.config.adapter,
        configuredScriptingMode: this.config.ccs.scriptingMode,
        effectiveAdapterType: this.runtime.adapterResolution.mode,
        adapterName: typeof result.sessionId === "string"
          ? await this.adapterNameForSession(result.sessionId)
          : undefined,
        commandId
      };
    } finally {
      this.currentCommandId = undefined;
      this.status = "READY";
    }
  }

  /**
   * Release only a daemon-owned logical session and its probe lease after the
   * board lease has expired. This path is reachable only over the worker's
   * authenticated IPC channel and is intentionally limited to session close;
   * it cannot reset, run, halt, program, or write target memory.
   */
  private async closeStaleResidentSession(input: unknown): Promise<Record<string, unknown>> {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new DebugMcpError("DaemonProtocolError", "Stale resident cleanup requires an object input");
    }
    const values = input as Record<string, unknown>;
    if (values.boardId !== this.options.boardId || values.workerInstanceId !== this.options.workerInstanceId) {
      throw new DebugMcpError("WorkerIdentityMismatch", "Stale resident cleanup identity does not match this worker", {
        boardId: this.options.boardId,
        workerInstanceId: this.options.workerInstanceId,
        receivedBoardId: values.boardId,
        receivedWorkerInstanceId: values.workerInstanceId,
        targetAccessAttempted: false
      });
    }
    if (typeof values.sessionId !== "string" || values.sessionId.length === 0) {
      throw new DebugMcpError("SessionNotFound", "Stale resident cleanup requires a sessionId", { targetAccessAttempted: false });
    }
    const result = await this.runtime!.manager.closeDebugSession(values.sessionId);
    return {
      success: true,
      ...result,
      recovery: {
        mode: "expired-board-lease-resident-close",
        targetAccessAttempted: false,
        targetMemoryWritten: false,
        executionControlIssued: false
      }
    };
  }

  private async adapterNameForSession(sessionId: string): Promise<string | undefined> {
    try {
      return (await this.runtime?.manager.getSessionTopology(sessionId))?.adapterName;
    } catch {
      return undefined;
    }
  }

  private async readVariableBatch(input: unknown): Promise<Record<string, unknown>> {
    if (!this.runtime) throw new Error("Board worker is not ready");
    const parsed = internalVariableBatchSchema.parse(input);
    const topology = await this.runtime.manager.getSessionTopology(parsed.sessionId);
    const core = topology.cores.find(candidate => candidate.coreId === parsed.coreId);
    if (!core) {
      throw new DebugMcpError("CoreNotFound", "Variable batch core was not found in the explicit adapter session", {
        sessionId: parsed.sessionId,
        coreId: parsed.coreId
      });
    }
    const results = await this.runtime.manager.evaluateManyWithTimeout(
      parsed.sessionId,
      parsed.coreId,
      parsed.expressions,
      parsed.timeoutMs,
      { diagnostics: "errors-only" }
    );
    return {
      success: true,
      sessionId: parsed.sessionId,
      adapterSessionId: topology.adapterSessionId,
      coreId: core.coreId,
      coreName: core.coreName,
      results
    };
  }

  private async readDlogExpressionBatch(input: unknown): Promise<Record<string, unknown>> {
    if (!this.runtime) throw new Error("Board worker is not ready");
    const parsed = internalDlogExpressionBatchSchema.parse(input);
    const topology = await this.runtime.manager.getSessionTopology(parsed.sessionId);
    const core = topology.cores.find(candidate => candidate.coreId === parsed.coreId);
    if (!core) {
      throw new DebugMcpError("CoreNotFound", "DLOG buffer core was not found in the explicit adapter session", {
        sessionId: parsed.sessionId,
        coreId: parsed.coreId
      });
    }
    const results = await this.runtime.manager.evaluateManyWithTimeout(
      parsed.sessionId,
      parsed.coreId,
      parsed.expressions,
      parsed.timeoutMs
    );
    return {
      success: true,
      sessionId: parsed.sessionId,
      adapterSessionId: topology.adapterSessionId,
      coreId: core.coreId,
      coreName: core.coreName,
      results
    };
  }

  private async invokeErad(input: unknown): Promise<Record<string, unknown>> {
    if (!this.runtime || !this.eradBackend) throw new Error("Board worker ERAD backend is not ready");
    const parsed = internalEradCommandSchema.parse(input);
    const topology = await this.runtime.manager.getSessionTopology(parsed.sessionId);
    const core = topology.cores.find(candidate => candidate.coreId === parsed.coreId);
    if (!core) {
      throw new DebugMcpError("CoreNotFound", "ERAD core was not found in the explicit adapter session", {
        sessionId: parsed.sessionId,
        coreId: parsed.coreId
      });
    }
    const context = {
      manager: this.runtime.manager,
      sessionId: parsed.sessionId,
      coreId: parsed.coreId,
      device: parsed.device
    };
    const identity = {
      sessionId: parsed.sessionId,
      adapterSessionId: topology.adapterSessionId,
      coreId: core.coreId,
      coreName: core.coreName
    };
    if (parsed.operation === "capabilities") {
      return { success: true, ...identity, capabilities: await this.eradBackend.capabilities(context) };
    }
    if (parsed.operation === "resolve") {
      if (!parsed.startSymbol || !parsed.endSymbol) {
        throw new DebugMcpError("EradSymbolsRequired", "ERAD symbol resolution requires startSymbol and endSymbol");
      }
      const expressions = [`&(${parsed.startSymbol})`, `&(${parsed.endSymbol})`];
      const results = await this.runtime.manager.evaluateManyWithTimeout(
        parsed.sessionId,
        parsed.coreId,
        expressions,
        5000
      );
      const addresses = results.map((result, index) => {
        if (result.success !== true || result.value === undefined) {
          throw new DebugMcpError("EradSymbolNotFound", "ERAD PC symbol could not be resolved", {
            symbol: index === 0 ? parsed.startSymbol : parsed.endSymbol,
            result
          });
        }
        return parseEradAddress(result.value);
      });
      return {
        success: true,
        ...identity,
        startAddress: addresses[0],
        endAddress: addresses[1],
        startAddressHex: toHex(addresses[0]!),
        endAddressHex: toHex(addresses[1]!)
      };
    }
    if (parsed.operation === "cla-timing-read") {
      if (!parsed.recordSymbol || parsed.taskNumber === undefined || parsed.snapshotAttempts === undefined) {
        throw new DebugMcpError("ClaTimingRequestInvalid", "CLA timing reads require recordSymbol, taskNumber, and snapshotAttempts");
      }
      if (this.effectiveAdapterType === "mock") {
        return {
          success: true,
          ...identity,
          snapshot: {
            sequence: 2,
            taskNumber: parsed.taskNumber,
            count: 100,
            lastCycles: 420,
            totalCyclesLow: 42_000,
            totalCyclesHigh: 0,
            minCycles: 398,
            maxCycles: 451,
            overflowCount: 0
          },
          snapshotAttemptsUsed: 1
        };
      }
      if (!/F28P65/i.test(parsed.device)) {
        throw new DebugMcpError("ClaTimingDeviceUnsupported", "Firmware-instrumented CLA timing currently supports F28P65x only", {
          device: parsed.device,
          supportedDevices: ["F28P65x"]
        });
      }

      const fields = [
        "sequence",
        "taskNumber",
        "count",
        "lastCycles",
        "totalCyclesLow",
        "totalCyclesHigh",
        "minCycles",
        "maxCycles",
        "overflowCount"
      ] as const;
      const addressResults = await this.runtime.manager.evaluateManyWithTimeout(
        parsed.sessionId,
        parsed.coreId,
        fields.map(field => `&(${parsed.recordSymbol}.${field})`),
        5000
      );
      const addresses = new Map<string, number>();
      for (const [index, field] of fields.entries()) {
        const result = addressResults[index];
        if (!result || result.success !== true || result.value === undefined) {
          throw new DebugMcpError("ClaTimingRecordSymbolNotFound", "CLA timing record field could not be resolved", {
            recordSymbol: parsed.recordSymbol,
            field,
            result
          });
        }
        addresses.set(field, parseEradAddress(result.value));
      }
      const readField = async (field: typeof fields[number]): Promise<number> => {
        const address = addresses.get(field);
        if (address === undefined) throw new DebugMcpError("ClaTimingRecordSymbolNotFound", "CLA timing field address is unavailable", { field });
        const value = await this.runtime!.manager.readMemory(parsed.sessionId, parsed.coreId, "DATA", address, 32);
        if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
          throw new DebugMcpError("ClaTimingRecordInvalid", "CLA timing record contains a non-uint32 field", { field, value });
        }
        return value;
      };

      for (let attempt = 1; attempt <= parsed.snapshotAttempts; attempt += 1) {
        const sequenceBefore = await readField("sequence");
        if ((sequenceBefore & 1) !== 0) continue;
        const snapshot = {
          sequence: sequenceBefore,
          taskNumber: await readField("taskNumber"),
          count: await readField("count"),
          lastCycles: await readField("lastCycles"),
          totalCyclesLow: await readField("totalCyclesLow"),
          totalCyclesHigh: await readField("totalCyclesHigh"),
          minCycles: await readField("minCycles"),
          maxCycles: await readField("maxCycles"),
          overflowCount: await readField("overflowCount")
        };
        const sequenceAfter = await readField("sequence");
        if (sequenceBefore === sequenceAfter && (sequenceAfter & 1) === 0) {
          return { success: true, ...identity, snapshot, snapshotAttemptsUsed: attempt };
        }
      }
      throw new DebugMcpError("ClaTimingSnapshotUnstable", "CLA timing record changed during every bounded snapshot attempt", {
        recordSymbol: parsed.recordSymbol,
        snapshotAttempts: parsed.snapshotAttempts
      });
    }
    if (!parsed.resources && parsed.operation !== "configure") {
      throw new DebugMcpError("EradResourcesRequired", `ERAD ${parsed.operation} requires frozen resources`);
    }
    if (parsed.operation === "configure") {
      if (parsed.startAddress === undefined || parsed.endAddress === undefined) {
        throw new DebugMcpError("EradAddressesRequired", "ERAD configuration requires resolved start/end addresses");
      }
      const configured = await this.eradBackend.configure(context, {
        startAddress: parsed.startAddress,
        endAddress: parsed.endAddress,
        ...(parsed.resources ? { resources: parsed.resources } : {}),
        allowOverwrite: parsed.allowOverwrite ?? false
      });
      return { success: true, ...identity, ...configured };
    }
    if (parsed.operation === "start") {
      await this.eradBackend.start(context, parsed.resources!);
      return { success: true, ...identity, started: true };
    }
    if (parsed.operation === "stop-read-restore") {
      let raw;
      let restoreStatus: "RESTORED" | "NOT_REQUIRED" = "NOT_REQUIRED";
      try {
        raw = await this.eradBackend.stopAndRead(context, parsed.resources!);
      } finally {
        restoreStatus = await this.eradBackend.restore(
          context,
          parsed.resources!,
          parsed.savedConfiguration ?? { required: false }
        );
      }
      return { success: true, ...identity, raw, restoreStatus };
    }
    const restoreStatus = await this.eradBackend.restore(
      context,
      parsed.resources!,
      parsed.savedConfiguration ?? { required: false }
    );
    return { success: true, ...identity, restoreStatus };
  }

  private validateLeaseContext(context: BoardLeaseContext | undefined, toolName: string): void {
    if (!context) throw new DebugMcpError("BoardLeaseRequired", "Worker rejected an unfenced board command", { toolName, boardId: this.options.boardId });
    if (context.boardId !== this.options.boardId || context.probeSerial !== this.options.probeSerial) {
      throw new DebugMcpError("LeaseBoardMismatch", "Worker rejected a lease for another board", { toolName, boardId: this.options.boardId });
    }
    if (context.workerInstanceId !== this.options.workerInstanceId) {
      throw new DebugMcpError("LeaseWorkerMismatch", "Worker rejected a lease for another worker generation", { toolName, workerInstanceId: this.options.workerInstanceId });
    }
    if (context.fencingToken < this.acceptedFencingToken ||
        (context.fencingToken === this.acceptedFencingToken && this.acceptedLeaseId !== undefined && context.leaseId !== this.acceptedLeaseId)) {
      throw new DebugMcpError("LeaseFencingRejected", "Worker rejected a stale fencing token", {
        toolName,
        acceptedFencingToken: this.acceptedFencingToken,
        receivedFencingToken: context.fencingToken
      });
    }
    this.acceptedFencingToken = context.fencingToken;
    this.acceptedLeaseId = context.leaseId;
  }

  heartbeat(): WorkerHeartbeat {
    return {
      workerInstanceId: this.options.workerInstanceId,
      boardId: this.options.boardId,
      probeSerial: this.options.probeSerial,
      timestamp: new Date().toISOString(),
      status: this.status,
      ...(this.currentCommandId ? { currentCommandId: this.currentCommandId } : {}),
      dssProcesses: this.runtime?.ownedProcesses() ?? [],
      ...(this.lastSuccessfulCommandAt ? { lastSuccessfulCommandAt: this.lastSuccessfulCommandAt } : {})
    };
  }

  async stop(): Promise<void> {
    this.status = "STOPPING";
    await this.runtime?.dispose();
    this.runtime = undefined;
    this.eradBackend = undefined;
  }
}

function parseEradAddress(value: unknown): number {
  const raw = String(value).trim();
  if (!/^(?:0x[0-9a-f]+|\d+)$/i.test(raw)) {
    throw new DebugMcpError("EradAddressInvalid", "ERAD symbol resolved to an invalid address", { value });
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 0xffff_ffff) {
    throw new DebugMcpError("EradAddressInvalid", "ERAD symbol address is outside the supported C28x range", { value });
  }
  return parsed;
}

function toHex(value: number): string {
  return `0x${value.toString(16)}`;
}

function splitLeaseContext(input: unknown): { leaseContext?: BoardLeaseContext; toolInput: unknown } {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { toolInput: input };
  const { __leaseContext, ...toolInput } = input as Record<string, unknown>;
  return {
    ...(__leaseContext && typeof __leaseContext === "object" && !Array.isArray(__leaseContext)
      ? { leaseContext: __leaseContext as BoardLeaseContext }
      : {}),
    toolInput
  };
}
