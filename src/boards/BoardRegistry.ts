import type { BoardRecord, BoardRegistration, BoardStatus } from "./types.js";
import { BoardRepository } from "../storage/repositories/BoardRepository.js";
import { EventRepository } from "../storage/repositories/EventRepository.js";
import { LeaseRepository } from "../storage/repositories/LeaseRepository.js";
import { SqliteStore } from "../storage/SqliteStore.js";
import { BoardLeaseManager } from "./BoardLeaseManager.js";

export class BoardRegistry {
  readonly leases: BoardLeaseManager;

  constructor(
    private readonly boards: BoardRepository,
    private readonly events: EventRepository,
    store: SqliteStore,
    leaseRepository: LeaseRepository
  ) {
    this.leases = new BoardLeaseManager(store, boards, leaseRepository);
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
}
