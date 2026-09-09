import type { BoardRecord, BoardRegistration, BoardStatus, TargetProgramMutation } from "./types.js";
import { BoardRepository } from "../storage/repositories/BoardRepository.js";
import { EventRepository } from "../storage/repositories/EventRepository.js";
import { LeaseRepository } from "../storage/repositories/LeaseRepository.js";
import { SqliteStore } from "../storage/SqliteStore.js";
import { BoardLeaseManager } from "./BoardLeaseManager.js";
import { DebugMcpError } from "../utils/errors.js";

export class BoardRegistry {
  readonly leases: BoardLeaseManager;

  constructor(
    private readonly boards: BoardRepository,
    private readonly events: EventRepository,
    store: SqliteStore,
    leaseRepository: LeaseRepository
  ) {
    this.leases = new BoardLeaseManager(
      store,
      boards,
      leaseRepository,
      (boardId, reason) => this.markTargetIdentityUnknown(boardId, reason)
    );
  }

  register(registration: BoardRegistration): BoardRecord {
    const board = this.boards.upsert(registration);
    this.events.append({ level: "info", sourceType: "board", sourceId: board.boardId, boardId: board.boardId, eventType: "BOARD_REGISTERED", payload: { probeSerial: board.probeSerial, device: board.device } });
    return board;
  }

  registerAll(registrations: BoardRegistration[]): BoardRecord[] {
    return registrations.map(registration => this.register(registration));
  }

  get(boardId: string): BoardRecord {
    return this.boards.require(boardId);
  }

  setWorker(boardId: string, workerInstanceId: string | undefined): void {
    this.boards.setWorker(boardId, workerInstanceId);
  }

  heartbeat(boardId: string, timestamp?: string): void {
    this.boards.heartbeat(boardId, timestamp);
  }

  list(filters: { status?: BoardStatus[]; tags?: string[] } = {}): Array<BoardRecord & { leaseOwner?: string }> {
    return this.boards.list(filters).map(board => {
      const lease = this.leases.active(board.boardId);
      return { ...board, ...(lease?.ownerJobId ? { leaseOwner: lease.ownerJobId } : {}) };
    });
  }

  transition(boardId: string, status: BoardStatus, error?: Record<string, unknown>): BoardRecord {
    const before = this.boards.require(boardId);
    const after = this.boards.setStatus(boardId, status, error);
    this.events.append({ level: error ? "warn" : "info", sourceType: "board", sourceId: boardId, boardId, eventType: "BOARD_STATUS_CHANGED", payload: { previous: before.status, current: status, ...(error ? { error } : {}) } });
    return after;
  }

  targetIdentity(boardId: string): BoardRecord["targetIdentity"] {
    return this.boards.require(boardId).targetIdentity;
  }

  requireKnownTargetIdentity(boardId: string, coreIds: number[]): BoardRecord["targetIdentity"] {
    const identity = this.targetIdentity(boardId);
    const missingCoreIds = coreIds.filter(coreId => !identity.programs[String(coreId)]);
    if (identity.status !== "KNOWN" || missingCoreIds.length > 0) {
      throw new DebugMcpError(
        "TargetImageIdentityUnknown",
        "The resident target image identity is not known for the requested core(s)",
        {
          boardId,
          status: identity.status,
          generation: identity.generation,
          reason: identity.reason,
          requestedCoreIds: coreIds,
          missingCoreIds,
          nextAction: "Load the exact image through MCP under the current board lease before loading symbols or starting observation."
        }
      );
    }
    return identity;
  }

  markTargetIdentityUnknown(boardId: string, reason: string): BoardRecord {
    const board = this.boards.markTargetUnknown(boardId, reason);
    this.events.append({
      level: "warn",
      sourceType: "board",
      sourceId: boardId,
      boardId,
      eventType: "TARGET_IDENTITY_INVALIDATED",
      payload: { generation: board.targetIdentity.generation, reason }
    });
    return board;
  }

  recordTargetPrograms(boardId: string, programs: TargetProgramMutation[], reason = "mcp-program-load"): BoardRecord {
    const board = this.boards.recordTargetPrograms(boardId, programs, reason);
    this.events.append({
      level: "info",
      sourceType: "board",
      sourceId: boardId,
      boardId,
      eventType: "TARGET_PROGRAMS_RECORDED",
      payload: {
        generation: board.targetIdentity.generation,
        programs: programs.map(program => ({ coreId: program.coreId, programUri: program.programUri, sha256: program.sha256 }))
      }
    });
    return board;
  }
}
