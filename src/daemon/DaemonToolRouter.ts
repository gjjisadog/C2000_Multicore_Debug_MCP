import type { C2000ToolInvoker } from "../mcp/tools.js";
import { DebugMcpError } from "../utils/errors.js";
import { BoardRegistry } from "../boards/BoardRegistry.js";
import { BoardWorkerSupervisor } from "../boards/BoardWorkerSupervisor.js";
import { SessionRepository } from "../storage/repositories/SessionRepository.js";
import type { LeasedBoard } from "../boards/BoardLeaseManager.js";

/** Routes board-bound tools to a single worker without changing sessionId/coreId semantics. */
export class DaemonToolRouter implements C2000ToolInvoker {
  private readonly interactiveLeases = new Map<string, LeasedBoard>();
  constructor(
    private readonly local: C2000ToolInvoker,
    private readonly registry: BoardRegistry,
    private readonly workers: BoardWorkerSupervisor,
    private readonly sessions: SessionRepository
  ) {}

  async invokeTool(toolName: string, input: unknown): Promise<Record<string, unknown>> {
    if (toolName === "c2000_launchMultiBoardDebug") {
      return this.launchMultiBoard(input);
    }
    const sessionId = record(input).sessionId;
    if (typeof sessionId === "string") {
      const session = this.sessions.get(sessionId);
      if (session) {
        const interactive = this.interactiveLeases.get(sessionId);
        const timeoutMs = this.workers.commandTimeoutMs(toolName, input);
        if (interactive) this.registry.leases.renew(interactive.lease.leaseId, interactive.leaseToken, leaseTtlMs(timeoutMs));
        const invocation = this.withLeaseInput(input, interactive);
        const result = await this.workers.invokeBoard(session.boardId, toolName, invocation, timeoutMs);
        if (toolName === "c2000_closeDebugSession" && result.success === true) {
          this.sessions.close(sessionId);
          this.releaseInteractiveLease(sessionId);
        }
        return result;
      }
      // Compatibility for sessions that pre-date worker routing or no-board mock configurations.
      return this.local.invokeTool(toolName, input);
    }
    if ([
      "c2000_createDebugSession",
      "c2000_launchMulticoreDebug",
      "c2000_launchMulticoreDebugSafe",
      "c2000_launchMulticoreDebugWithActions",
      "c2000_launchAndRunIpcAcceptance"
    ].includes(toolName)) {
      const boardId = this.selectBoard(record(input).boardId);
      const supplied = readLease(input);
      const timeoutMs = this.workers.commandTimeoutMs(toolName, input);
      const interactive = supplied ? undefined : await this.acquireInteractiveLease(boardId, leaseTtlMs(timeoutMs));
      try {
        const result = await this.workers.invokeBoard(boardId, toolName, this.withLeaseInput(input, interactive), timeoutMs);
        const sessionPersisted = this.persistCreatedSession(boardId, input, result);
        if (interactive && sessionPersisted && typeof result.sessionId === "string") {
          this.interactiveLeases.set(result.sessionId, interactive);
        } else if (interactive) {
          this.releaseLease(interactive);
        }
        return result;
      } catch (error) {
        if (interactive) this.releaseLease(interactive);
        throw error;
      }
    }
    return this.local.invokeTool(toolName, input);
  }

  private async acquireInteractiveLease(boardId: string, ttlMs = 60000): Promise<LeasedBoard> {
    const worker = await this.workers.startBoard(boardId);
    return this.registry.leases.acquire({
      boardId,
      ownerJobId: `interactive-${randomId()}`,
      workerInstanceId: worker.workerInstanceId,
      ttlMs
    });
  }

  private withLeaseInput(input: unknown, interactive?: LeasedBoard): unknown {
    if (readLease(input) || !interactive) return input;
    return { ...record(input), __leaseContext: interactive.context };
  }

  private releaseInteractiveLease(sessionId: string): void {
    const lease = this.interactiveLeases.get(sessionId);
    if (!lease) return;
    this.interactiveLeases.delete(sessionId);
    this.releaseLease(lease);
  }

  private releaseLease(lease: LeasedBoard): void {
    try { this.registry.leases.release(lease.lease.leaseId, lease.leaseToken); } catch { /* already expired or invalidated */ }
  }

  private selectBoard(value: unknown): string {
    const boards = this.registry.list();
    if (typeof value === "string") {
      if (boards.some(board => board.boardId === value)) return value;
      throw boardRegistrationError({
        requestedBoardId: value,
        registeredBoardIds: boards.map(board => board.boardId)
      });
    }
    if (boards.length === 0) throw boardRegistrationError({ registeredBoardIds: [] });
    if (boards.length === 1) return boards[0]!.boardId;
    throw new DebugMcpError("ProbeBindingMissing", "Multiple registered boards require an explicit boardId", { boardIds: boards.map(board => board.boardId) });
  }

  private persistCreatedSession(
    boardId: string,
    input: unknown,
    result: Record<string, unknown>
  ): boolean {
    if (typeof result.sessionId !== "string") return false;
    const values = record(input);
    if (values.sessionMode === "ephemeral") return false;
    this.sessions.upsert({
      sessionId: result.sessionId,
      boardId,
      ...(typeof result.workerInstanceId === "string" ? { workerInstanceId: result.workerInstanceId } : {}),
      sessionName: typeof values.sessionName === "string" ? values.sessionName : "c2000-debug-session",
      ...(typeof values.ccxmlPath === "string" ? { ccxmlPath: values.ccxmlPath } : {}),
      coreMap: Array.isArray(values.coreMap) ? values.coreMap : Array.isArray(values.cores) ? values.cores : [],
      status: "OPEN",
      createdAt: new Date().toISOString()
    });
    return true;
  }

  private async launchMultiBoard(input: unknown): Promise<Record<string, unknown>> {
    const values = record(input);
    const boards = Array.isArray(values.boards) ? values.boards : [];
    if (boards.length === 0) return this.local.invokeTool("c2000_launchMultiBoardDebug", input);
    const results: Array<Record<string, unknown>> = await Promise.all(boards.map(async boardInput => {
      const boardValues = record(boardInput);
      const boardId = this.findBoardId(boardValues);
      const workerInput = {
        boardId,
        ccsInstallPath: values.ccsInstallPath,
        sessionName: boardValues.sessionName,
        cores: boardValues.cores
      };
      const timeoutMs = this.workers.commandTimeoutMs("c2000_launchMulticoreDebug", workerInput);
      const interactive = await this.acquireInteractiveLease(boardId, leaseTtlMs(timeoutMs));
      try {
        const result = await this.workers.invokeBoard(boardId, "c2000_launchMulticoreDebug", {
          ...workerInput,
          __leaseContext: interactive.context
        }, timeoutMs);
        const sessionPersisted = this.persistCreatedSession(boardId, boardInput, result);
        if (sessionPersisted && typeof result.sessionId === "string") {
          this.interactiveLeases.set(result.sessionId, interactive);
        } else {
          this.releaseLease(interactive);
        }
        return { boardId, probeSerial: this.registry.get(boardId).probeSerial, ...result };
      } catch (error) {
        this.releaseLease(interactive);
        throw error;
      }
    }));
    const failed = results.filter(result => result.success !== true);
    return {
      success: failed.length === 0,
      timestamp: new Date().toISOString(),
      workflow: "c2000_launchMultiBoardDebug",
      results,
      ...(failed.length ? { error: { code: "BatchOperationFailed", message: `${failed.length} board launch(es) failed`, details: { failed } } } : {})
    };
  }

  private findBoardId(input: Record<string, unknown>): string {
    if (typeof input.boardId === "string") return this.selectBoard(input.boardId)!;
    if (typeof input.probeSerial === "string") {
      const board = this.registry.list().find(candidate => candidate.probeSerial === input.probeSerial);
      if (board) return board.boardId;
    }
    throw new DebugMcpError("ProbeBindingMissing", "Multi-board launch entry does not map to a registered board", { boardId: input.boardId, probeSerial: input.probeSerial });
  }
}

function readLease(input: unknown): unknown {
  return record(input).__leaseContext;
}

function randomId(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function leaseTtlMs(commandTimeoutMs: number): number {
  return commandTimeoutMs + 30000;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function boardRegistrationError(details: Record<string, unknown>): DebugMcpError {
  return new DebugMcpError(
    "ProbeBindingMissing",
    "No matching board is registered with c2000-debugd",
    {
      ...details,
      nextTool: "c2000_registerBoard",
      remediation: "Register a board with its XDS110 serial-bound ccxml, then retry the original launch with that boardId.",
      standardCoreIds: { cpu1: 0, cpu2: 2 }
    }
  );
}
