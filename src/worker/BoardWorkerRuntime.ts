import type { C2000McpConfig } from "../config/config.schema.js";
import { createC2000McpRuntime, type C2000McpRuntime } from "../server.js";
import type { WorkerHeartbeat } from "./WorkerHeartbeat.js";
import type { BoardLeaseContext } from "../boards/types.js";
import { DebugMcpError } from "../utils/errors.js";

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

  constructor(
    readonly options: BoardWorkerLaunchOptions,
    private readonly config: C2000McpConfig
  ) {}

  async start(): Promise<void> {
    const workerConfig: C2000McpConfig = {
      ...this.config,
      ccs: { ...this.config.ccs, ccxmlPath: this.options.ccxmlPath }
    };
    this.runtime = await createC2000McpRuntime(workerConfig);
    this.status = "READY";
  }

  async invoke(commandId: string, toolName: string, input: unknown): Promise<Record<string, unknown>> {
    if (!this.runtime) throw new Error("Board worker is not ready");
    const { leaseContext, toolInput } = splitLeaseContext(input);
    this.validateLeaseContext(leaseContext, toolName);
    this.status = "RUNNING";
    this.currentCommandId = commandId;
    try {
      const result = await this.runtime.toolInvoker.invokeTool(toolName, toolInput);
      this.lastSuccessfulCommandAt = new Date().toISOString();
      return {
        ...result,
        boardId: this.options.boardId,
        probeSerial: this.options.probeSerial,
        workerInstanceId: this.options.workerInstanceId,
        commandId
      };
    } finally {
      this.currentCommandId = undefined;
      this.status = "READY";
    }
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
      dssProcesses: [],
      ...(this.lastSuccessfulCommandAt ? { lastSuccessfulCommandAt: this.lastSuccessfulCommandAt } : {})
    };
  }

  async stop(): Promise<void> {
    this.status = "STOPPING";
    await this.runtime?.dispose();
    this.runtime = undefined;
  }
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
