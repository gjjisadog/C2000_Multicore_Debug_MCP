import type { C2000McpConfig } from "../config/config.schema.js";
import { createC2000McpRuntime, type C2000McpRuntime } from "../server.js";
import type { WorkerHeartbeat } from "./WorkerHeartbeat.js";

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
    this.status = "RUNNING";
    this.currentCommandId = commandId;
    try {
      const result = await this.runtime.toolInvoker.invokeTool(toolName, input);
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
