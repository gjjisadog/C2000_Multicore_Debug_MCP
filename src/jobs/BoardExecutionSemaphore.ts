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
  queue: Array<{ boardIds: string[]; jobId: string; queuedAt: string; waitDurationMs: number; priority: BoardExecutionPriority; bypassCount: number; starving: boolean }>;
}

export type BoardExecutionPriority = "SAFETY_RECOVERY" | "INTERACTIVE_DEBUG" | "ACCEPTANCE" | "REGRESSION" | "SOAK";

interface Waiter {
  boardIds: string[];
  jobId: string;
  resolve: (permits: BoardExecutionPermit[]) => void;
  reject: (error: Error) => void;
  queuedAt: number;
  priority: BoardExecutionPriority;
  bypassCount: number;
  starvationReported: boolean;
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

  constructor(readonly limit: number, private readonly options: {
    agingThresholdMs?: number;
    starvationTimeoutMs?: number;
    onStarvation?: (waiter: { boardIds: string[]; jobId: string; queuedAt: string; waitDurationMs: number; priority: BoardExecutionPriority; bypassCount: number }) => void;
  } = {}) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError("Board concurrency limit must be a positive integer");
    }
  }

  async acquire(boardId: string, jobId: string, priority: BoardExecutionPriority = "REGRESSION"): Promise<BoardExecutionPermit> {
    return (await this.acquireGroup([boardId], jobId, priority))[0]!;
  }

  acquireGroup(boardIds: string[], jobId: string, priority: BoardExecutionPriority = "ACCEPTANCE"): Promise<BoardExecutionPermit[]> {
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
      this.waiters.push({ boardIds: normalized, jobId, resolve, reject, queuedAt: Date.now(), priority, bypassCount: 0, starvationReported: false });
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
        .sort((left, right) => left.boardId.localeCompare(right.boardId)),
      queue: this.waiters.map(waiter => ({
        boardIds: [...waiter.boardIds],
        jobId: waiter.jobId,
        queuedAt: new Date(waiter.queuedAt).toISOString(),
        waitDurationMs: Date.now() - waiter.queuedAt,
        priority: waiter.priority,
        bypassCount: waiter.bypassCount,
        starving: Date.now() - waiter.queuedAt >= (this.options.starvationTimeoutMs ?? 300000)
      }))
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
    const now = Date.now();
    for (const waiter of this.waiters) {
      const waitDurationMs = now - waiter.queuedAt;
      if (!waiter.starvationReported && waitDurationMs >= (this.options.starvationTimeoutMs ?? 300000)) {
        waiter.starvationReported = true;
        this.options.onStarvation?.({ boardIds: [...waiter.boardIds], jobId: waiter.jobId, queuedAt: new Date(waiter.queuedAt).toISOString(), waitDurationMs, priority: waiter.priority, bypassCount: waiter.bypassCount });
      }
    }
    while (this.waiters.length) {
      const aged = this.waiters
        .map((waiter, index) => ({ waiter, index }))
        .filter(item => now - item.waiter.queuedAt >= (this.options.agingThresholdMs ?? 30000))
        .sort((left, right) => left.waiter.queuedAt - right.waiter.queuedAt);
      const candidates = aged.length ? aged : this.waiters
        .map((waiter, index) => ({ waiter, index }))
        .sort((left, right) => priorityRank(left.waiter.priority) - priorityRank(right.waiter.priority) || left.waiter.queuedAt - right.waiter.queuedAt);
      let selected: { waiter: Waiter; index: number } | undefined;
      for (const candidate of candidates) {
        const waiter = candidate.waiter;
        const enoughCapacity = this.holders.size + waiter.boardIds.length <= this.limit;
        const boardsFree = waiter.boardIds.every(boardId => !this.holders.has(boardId));
        if (enoughCapacity && boardsFree) {
          selected = candidate;
          break;
        }
        // Once an aged request reaches the head, reserve future capacity for it.
        if (aged.length) return;
      }
      if (!selected) return;
      for (let index = 0; index < selected.index; index += 1) this.waiters[index]!.bypassCount += 1;
      const waiter = selected.waiter;
      this.waiters.splice(selected.index, 1);
      waiter.resolve(waiter.boardIds.map(boardId => this.createPermit(boardId, waiter.jobId)));
      if (this.holders.size >= this.limit) return;
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

function priorityRank(priority: BoardExecutionPriority): number {
  return ["SAFETY_RECOVERY", "INTERACTIVE_DEBUG", "ACCEPTANCE", "REGRESSION", "SOAK"].indexOf(priority);
}
