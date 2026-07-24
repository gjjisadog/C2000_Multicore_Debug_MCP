import { randomUUID } from "node:crypto";
import { DebugMcpError } from "../utils/errors.js";

export interface BoardExecutionPermit {
  permitId: string;
  boardId: string;
  jobId: string;
  acquiredAt: string;
  release(): void;
}

export interface BoardExecutionSnapshot {
  limit: number;
  active: number;
  waiting: number;
  holders: Array<{
    permitId: string;
    boardId: string;
    jobId: string;
    acquiredAt: string;
  }>;
}

interface Waiter {
  boardIds: string[];
  jobId: string;
  resolve: (permits: BoardExecutionPermit[]) => void;
  reject: (error: Error) => void;
}

/**
 * Daemon-wide physical-board concurrency authority.
 *
 * Group acquisition is committed atomically: a waiter never holds a subset of
 * its requested boards while waiting for the remainder.
 */
export class BoardExecutionSemaphore {
  private readonly holders = new Map<string, Omit<BoardExecutionPermit, "release">>();
  private readonly waiters: Waiter[] = [];
  private readonly idleWaiters: Array<() => void> = [];
  private stopped = false;

  constructor(readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError("Board concurrency limit must be a positive integer");
    }
  }

  async acquire(boardId: string, jobId: string): Promise<BoardExecutionPermit> {
    return (await this.acquireGroup([boardId], jobId))[0]!;
  }

  acquireGroup(boardIds: string[], jobId: string): Promise<BoardExecutionPermit[]> {
    const normalized = [...new Set(boardIds.map(value => value.trim()).filter(Boolean))].sort();
    if (normalized.length !== boardIds.length || normalized.length === 0) {
      return Promise.reject(new DebugMcpError("DuplicateBoardId", "Board permit request must contain distinct, non-empty board IDs", { boardIds }));
    }
    if (normalized.length > this.limit) {
      return Promise.reject(new DebugMcpError(
        "InsufficientBoardConcurrency",
        `The job requires ${normalized.length} boards but global concurrency is ${this.limit}`,
        { requiredBoards: normalized.length, configuredMaxParallelBoards: this.limit, boardIds: normalized }
      ));
    }
    if (this.stopped) return Promise.reject(new Error("Board execution semaphore is stopped"));
    return new Promise<BoardExecutionPermit[]>((resolve, reject) => {
      this.waiters.push({ boardIds: normalized, jobId, resolve, reject });
      this.drain();
    });
  }

  snapshot(): BoardExecutionSnapshot {
    return {
      limit: this.limit,
      active: this.holders.size,
      waiting: this.waiters.length,
      holders: [...this.holders.values()]
        .map(holder => ({ ...holder }))
        .sort((left, right) => left.boardId.localeCompare(right.boardId))
    };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const error = new Error("Board execution semaphore stopped before queued work acquired permits");
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
    if (this.holders.size === 0) return;
    await new Promise<void>(resolve => this.idleWaiters.push(resolve));
  }

  private drain(): void {
    if (this.stopped) return;
    for (let index = 0; index < this.waiters.length;) {
      const waiter = this.waiters[index]!;
      const enoughCapacity = this.holders.size + waiter.boardIds.length <= this.limit;
      const boardsFree = waiter.boardIds.every(boardId => !this.holders.has(boardId));
      if (!enoughCapacity || !boardsFree) {
        index += 1;
        continue;
      }
      this.waiters.splice(index, 1);
      waiter.resolve(waiter.boardIds.map(boardId => this.createPermit(boardId, waiter.jobId)));
    }
  }

  private createPermit(boardId: string, jobId: string): BoardExecutionPermit {
    const stored = {
      permitId: `board-permit-${randomUUID()}`,
      boardId,
      jobId,
      acquiredAt: new Date().toISOString()
    };
    this.holders.set(boardId, stored);
    let released = false;
    return {
      ...stored,
      release: () => {
        if (released) return;
        released = true;
        const current = this.holders.get(boardId);
        if (current?.permitId === stored.permitId) this.holders.delete(boardId);
        this.drain();
        if (this.holders.size === 0) {
          for (const resolve of this.idleWaiters.splice(0)) resolve();
        }
      }
    };
  }
}
