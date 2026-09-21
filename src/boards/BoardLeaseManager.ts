import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type {
  BoardLease,
  BoardLeaseContext,
  BoardLeaseReconciliationBlockers,
  BoardLeaseReconciliationResult,
  BoardLeaseState
} from "./types.js";
import { BoardRepository } from "../storage/repositories/BoardRepository.js";
import { LeaseRepository } from "../storage/repositories/LeaseRepository.js";
import { SqliteStore } from "../storage/SqliteStore.js";
import { DebugMcpError } from "../utils/errors.js";

export interface LeasedBoard {
  lease: BoardLease;
  leaseToken: string;
  context: BoardLeaseContext;
}

/** One active lease per physical board; tokens are stored only as hashes. */
export class BoardLeaseManager {
  constructor(
    private readonly store: SqliteStore,
    private readonly boards: BoardRepository,
    private readonly leases: LeaseRepository
  ) {}

  acquire(options: { boardId: string; ownerJobId?: string; workerInstanceId: string; ttlMs: number }): LeasedBoard {
    return this.store.transaction(() => {
      const now = new Date();
      const prepared = this.prepare(options, now);
      return this.insertPrepared(prepared, options.ttlMs, now);
    });
  }

  /** Atomically validates and acquires every board or leaves the group completely untouched. */
  acquireGroup(options: {
    boardIds: string[];
    ownerJobId: string;
    workerInstanceIds: Record<string, string>;
    ttlMs: number;
  }): LeasedBoard[] {
    if (options.boardIds.length === 0 || new Set(options.boardIds).size !== options.boardIds.length) {
      throw new DebugMcpError("CanProfileInvalid", "A board lease group requires unique board IDs", { boardIds: options.boardIds });
    }
    return this.store.transaction(() => {
      const now = new Date();
      // Complete every read/check before releasing expired rows or inserting a single lease.
      const prepared = [...options.boardIds].sort().map(boardId => this.prepare({
        boardId,
        ownerJobId: options.ownerJobId,
        workerInstanceId: options.workerInstanceIds[boardId]!,
        ttlMs: options.ttlMs
      }, now, false));
      for (const item of prepared) {
        if (item.expiredLeaseId) this.leases.release(item.expiredLeaseId, now.toISOString());
      }
      return prepared.map(item => this.insertPrepared(item, options.ttlMs, now));
    });
  }

  renew(leaseId: string, leaseToken: string, ttlMs: number): BoardLease {
    return this.store.transaction(() => {
      const existing = this.find(leaseId);
      if (!tokensMatch(existing.leaseTokenHash, hashToken(leaseToken))) {
        throw new DebugMcpError("DaemonAuthenticationFailed", "Board lease token does not match", { leaseId });
      }
      const now = new Date();
      const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
      this.leases.renew(leaseId, expiresAt, now.toISOString());
      return { ...existing, expiresAt, renewedAt: now.toISOString() };
    });
  }

  release(leaseId: string, leaseToken: string): void {
    this.store.transaction(() => {
      const existing = this.find(leaseId);
      if (!tokensMatch(existing.leaseTokenHash, hashToken(leaseToken))) {
        throw new DebugMcpError("DaemonAuthenticationFailed", "Board lease token does not match", { leaseId });
      }
      this.leases.release(leaseId, new Date().toISOString());
      this.boards.setLease(existing.boardId, undefined);
    });
  }

  /**
   * A fresh daemon may release only a lease owned by the exact recovered job.
   * This does not inspect or terminate any external CCS/DSS owner, and never
   * steals a lease belonging to another job.
   */
  releaseForRecoveredJob(boardId: string, ownerJobId: string): boolean {
    return this.store.transaction(() => {
      const now = new Date().toISOString();
      const recovered = this.leases.unreleasedForBoard(boardId)
        .filter(lease => lease.ownerJobId === ownerJobId);
      if (recovered.length === 0) return false;
      for (const lease of recovered) this.leases.release(lease.leaseId, now);

      // Do not clear a newer lease belonging to another job. Re-point the
      // board row to the newest still-active generation, if one exists.
      this.boards.setLease(boardId, this.leases.activeForBoard(boardId)?.leaseId);
      return true;
    });
  }

  active(boardId: string): BoardLease | undefined {
    const lease = this.leases.activeForBoard(boardId);
    if (!lease || Date.parse(lease.expiresAt) <= Date.now()) return undefined;
    const { leaseTokenHash: _token, ...publicLease } = lease;
    return publicLease;
  }

  /**
   * Describe the durable lease route without treating an expired or terminal
   * row as an active owner. This is intentionally read-only so listBoards can
   * expose stale state without changing lease ownership as a side effect.
   */
  describe(boardId: string, currentWorkerInstanceId?: string): BoardLeaseState {
    const active = this.leases.activeForBoard(boardId);
    if (active) {
      const expired = Date.parse(active.expiresAt) <= Date.now();
      const stale = currentWorkerInstanceId !== undefined
        && active.workerInstanceId !== currentWorkerInstanceId;
      return {
        status: expired ? "EXPIRED" : stale ? "STALE" : "ACTIVE",
        leaseId: active.leaseId,
        ...(active.ownerJobId ? { ownerJobId: active.ownerJobId } : {}),
        ...(active.workerInstanceId ? { workerInstanceId: active.workerInstanceId } : {}),
        ...(currentWorkerInstanceId ? { currentWorkerInstanceId } : {}),
        expiresAt: active.expiresAt,
        ...(stale ? { reason: workerMismatchReason(active.workerInstanceId, currentWorkerInstanceId) } : {})
      };
    }

    const latest = this.leases.latestForBoard(boardId);
    if (latest?.invalidatedAt) {
      return {
        status: "INVALIDATED",
        leaseId: latest.leaseId,
        ...(latest.ownerJobId ? { ownerJobId: latest.ownerJobId } : {}),
        ...(latest.workerInstanceId ? { workerInstanceId: latest.workerInstanceId } : {}),
        ...(currentWorkerInstanceId ? { currentWorkerInstanceId } : {}),
        ...(latest.expiresAt ? { expiresAt: latest.expiresAt } : {}),
        invalidatedAt: latest.invalidatedAt,
        ...(latest.invalidationReason ? { reason: latest.invalidationReason } : {})
      };
    }
    if (latest && Date.parse(latest.expiresAt) <= Date.now()) {
      return {
        status: "EXPIRED",
        leaseId: latest.leaseId,
        ...(latest.ownerJobId ? { ownerJobId: latest.ownerJobId } : {}),
        ...(latest.workerInstanceId ? { workerInstanceId: latest.workerInstanceId } : {}),
        ...(currentWorkerInstanceId ? { currentWorkerInstanceId } : {}),
        expiresAt: latest.expiresAt,
        reason: "Lease expired and is no longer active."
      };
    }
    return {
      status: "NONE",
      ...(currentWorkerInstanceId ? { currentWorkerInstanceId } : {})
    };
  }

  /**
   * Reconcile a persisted lease when a new daemon-owned worker is published.
   * A worker mismatch is reclaimable only when no durable job or open debug
   * session can still own the target. Blocked cases remain fenced and are
   * surfaced as STALE; this method never force-closes a session or steals a
   * live owner.
   */
  reconcileWorkerChange(
    boardId: string,
    currentWorkerInstanceId: string,
    blockers: BoardLeaseReconciliationBlockers = {}
  ): BoardLeaseReconciliationResult {
    return this.store.transaction(() => {
      const board = this.boards.require(boardId);
      const active = this.leases.activeForBoard(boardId);
      if (!active) {
        const hadStaleReference = Boolean(board.currentLeaseId);
        if (hadStaleReference) this.boards.setLease(boardId, undefined);
        return {
          ...this.describe(boardId, currentWorkerInstanceId),
          action: hadStaleReference ? "CLEARED_STALE_REFERENCE" as const : "UNCHANGED" as const
        };
      }

      const expired = Date.parse(active.expiresAt) <= Date.now();
      const stale = active.workerInstanceId !== currentWorkerInstanceId;
      const normalizedBlockers = reconciliationBlockers(blockers);
      if ((stale || expired) && normalizedBlockers.length > 0) {
        const reason = stale
          ? `${workerMismatchReason(active.workerInstanceId, currentWorkerInstanceId)}; automatic reclaim blocked by active session/job ownership.`
          : "Lease is expired but an active session/job still requires daemon-managed closure.";
        return {
          ...this.describe(boardId, currentWorkerInstanceId),
          status: stale ? "STALE" : "EXPIRED",
          reason,
          blockers: normalizedBlockers,
          action: "BLOCKED" as const
        };
      }

      if (expired) {
        this.leases.release(active.leaseId, new Date().toISOString());
        this.boards.setLease(boardId, undefined);
        return {
          ...this.describe(boardId, currentWorkerInstanceId),
          status: "EXPIRED",
          reason: "Lease expired and was released before publishing the new worker route.",
          action: "RELEASED_EXPIRED" as const
        };
      }

      if (stale) {
        const reason = `worker-change:${active.workerInstanceId ?? "unknown"}->${currentWorkerInstanceId}`;
        this.leases.invalidate(active.leaseId, new Date().toISOString(), reason);
        this.boards.setLease(boardId, undefined);
        return {
          ...this.describe(boardId, currentWorkerInstanceId),
          status: "INVALIDATED",
          reason,
          action: "RECLAIMED_STALE" as const
        };
      }

      if (board.currentLeaseId !== active.leaseId) this.boards.setLease(boardId, active.leaseId);
      return {
        ...this.describe(boardId, currentWorkerInstanceId),
        action: "UNCHANGED" as const
      };
    });
  }

  invalidate(leaseId: string, leaseToken: string, reason: string): void {
    this.store.transaction(() => {
      const existing = this.find(leaseId);
      if (!tokensMatch(existing.leaseTokenHash, hashToken(leaseToken))) {
        throw new DebugMcpError("LeaseFencingRejected", "Board lease token does not match", { leaseId });
      }
      const now = new Date().toISOString();
      this.leases.invalidate(leaseId, now, reason);
      this.boards.setLease(existing.boardId, undefined);
    });
  }

  /**
   * Invalidates the lease fenced to a daemon-owned worker that is being
   * restarted. The exact board and worker identity must both match, so an
   * operator recovery cannot steal a lease owned by a different worker.
   */
  invalidateForWorkerRestart(
    boardId: string,
    workerInstanceId: string,
    reason: string
  ): boolean {
    return this.store.transaction(() => {
      const existing = this.leases.activeForBoard(boardId);
      if (!existing || existing.workerInstanceId !== workerInstanceId) {
        return false;
      }
      const now = new Date().toISOString();
      this.leases.invalidate(existing.leaseId, now, reason);
      this.boards.setLease(boardId, undefined);
      return true;
    });
  }

  validate(context: BoardLeaseContext): BoardLease {
    return this.store.transaction(() => {
      const existing = this.leases.activeForBoardByLeaseId(context.leaseId);
      if (!existing) throw new DebugMcpError("LeaseInvalidated", "Board lease is missing, released, or invalidated", { leaseId: context.leaseId });
      if (existing.invalidatedAt) throw new DebugMcpError("LeaseInvalidated", "Board lease has been invalidated", { leaseId: context.leaseId, reason: existing.invalidationReason });
      if (Date.parse(existing.expiresAt) <= Date.now()) throw new DebugMcpError("LeaseExpired", "Board lease has expired", { leaseId: context.leaseId, expiresAt: existing.expiresAt });
      if (!tokensMatch(existing.leaseTokenHash, hashToken(context.leaseToken))) throw new DebugMcpError("LeaseFencingRejected", "Board lease token does not match", { leaseId: context.leaseId });
      if (existing.fencingToken !== context.fencingToken || this.leases.latestFencingToken(existing.boardId) !== context.fencingToken) {
        throw new DebugMcpError("LeaseFencingRejected", "Board lease fencing token is stale", { leaseId: context.leaseId, expected: this.leases.latestFencingToken(existing.boardId), received: context.fencingToken });
      }
      if (existing.leaseGeneration !== context.leaseGeneration) throw new DebugMcpError("LeaseFencingRejected", "Board lease generation is stale", { leaseId: context.leaseId });
      if (existing.ownerJobId !== context.ownerJobId) throw new DebugMcpError("LeaseOwnerMismatch", "Board lease owner does not match", { leaseId: context.leaseId });
      if (existing.boardId !== context.boardId || existing.probeSerial !== context.probeSerial) throw new DebugMcpError("LeaseBoardMismatch", "Board lease identity does not match", { leaseId: context.leaseId });
      if (existing.workerInstanceId !== context.workerInstanceId) throw new DebugMcpError("LeaseWorkerMismatch", "Board lease worker does not match", {
        leaseId: context.leaseId,
        expectedWorkerInstanceId: existing.workerInstanceId,
        receivedWorkerInstanceId: context.workerInstanceId,
        stage: "lease-validate",
        targetAccessAttempted: false
      });
      this.leases.validate(existing.leaseId, new Date().toISOString());
      const { leaseTokenHash: _token, ...lease } = existing;
      return lease;
    });
  }

  private find(leaseId: string): BoardLease & { leaseTokenHash: string } {
    const candidate = this.leases.activeForBoardByLeaseId(leaseId);
    if (!candidate) {
      throw new DebugMcpError("BoardLeased", "Board lease is missing or released", { leaseId });
    }
    return candidate;
  }

  private prepare(
    options: { boardId: string; ownerJobId?: string; workerInstanceId: string; ttlMs: number },
    now: Date,
    releaseExpired = true
  ): { board: ReturnType<BoardRepository["require"]>; ownerJobId: string; workerInstanceId: string; expiredLeaseId?: string } {
    const board = this.boards.require(options.boardId);
    if (!["AVAILABLE", "READY"].includes(board.status)) {
      throw new DebugMcpError("ProbeNotConnected", `Board ${board.boardId} is not available for leasing`, { boardId: board.boardId, status: board.status });
    }
    const existing = this.leases.activeForBoard(board.boardId);
    if (existing && Date.parse(existing.expiresAt) > now.getTime()) {
      throw new DebugMcpError("BoardLeased", `Board ${board.boardId} already has an active lease`, {
        boardId: board.boardId, probeSerial: board.probeSerial, leaseId: existing.leaseId, ownerJobId: existing.ownerJobId
      });
    }
    if (!options.ownerJobId) throw new DebugMcpError("LeaseOwnerMismatch", "A board lease requires an explicit owner", { boardId: board.boardId });
    const workerInstanceId = options.workerInstanceId;
    if (!workerInstanceId) throw new DebugMcpError("LeaseWorkerMismatch", "A board lease requires the live supervisor worker identity", {
      boardId: board.boardId,
      stage: "lease-acquire",
      targetAccessAttempted: false,
      routeSource: "live-supervisor-required"
    });
    if (existing && releaseExpired) this.leases.release(existing.leaseId, now.toISOString());
    return { board, ownerJobId: options.ownerJobId, workerInstanceId, ...(existing ? { expiredLeaseId: existing.leaseId } : {}) };
  }

  private insertPrepared(
    prepared: { board: ReturnType<BoardRepository["require"]>; ownerJobId: string; workerInstanceId: string },
    ttlMs: number,
    now: Date
  ): LeasedBoard {
    const leaseToken = randomBytes(32).toString("base64url");
    const fencingToken = this.leases.latestFencingToken(prepared.board.boardId) + 1;
    const lease: BoardLease = {
      leaseId: `lease-${randomUUID()}`,
      boardId: prepared.board.boardId,
      probeSerial: prepared.board.probeSerial,
      ownerJobId: prepared.ownerJobId,
      workerInstanceId: prepared.workerInstanceId,
      acquiredAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
      renewedAt: now.toISOString(),
      fencingToken,
      leaseGeneration: fencingToken
    };
    this.leases.insert(lease, hashToken(leaseToken));
    this.boards.setLease(prepared.board.boardId, lease.leaseId);
    // A lease is control-plane fencing only. Acquiring a new MCP lease does
    // not read, reset, run, or program the target, so it must not invalidate
    // durable image evidence by itself.
    return { lease, leaseToken, context: toContext(lease, leaseToken) };
  }
}

function toContext(lease: BoardLease, leaseToken: string): BoardLeaseContext {
  return {
    leaseId: lease.leaseId,
    leaseToken,
    fencingToken: lease.fencingToken,
    leaseGeneration: lease.leaseGeneration,
    ownerJobId: lease.ownerJobId!,
    boardId: lease.boardId,
    probeSerial: lease.probeSerial,
    workerInstanceId: lease.workerInstanceId!
  };
}

function hashToken(token: string): string { return createHash("sha256").update(token).digest("hex"); }
function tokensMatch(left: string, right: string): boolean {
  const first = Buffer.from(left, "utf8");
  const second = Buffer.from(right, "utf8");
  return first.length === second.length && timingSafeEqual(first, second);
}

function workerMismatchReason(leaseWorkerInstanceId: string | undefined, currentWorkerInstanceId: string): string {
  return `Lease worker ${leaseWorkerInstanceId ?? "unknown"} does not match current worker ${currentWorkerInstanceId}.`;
}

function reconciliationBlockers(blockers: BoardLeaseReconciliationBlockers) {
  return [
    ...(blockers.activeJobs ?? []).map(job => ({ kind: "job" as const, id: job.jobId, status: job.status })),
    ...(blockers.openSessions ?? []).map(session => ({
      kind: "session" as const,
      id: session.sessionId,
      ...(session.workerInstanceId ? { workerInstanceId: session.workerInstanceId } : {})
    }))
  ];
}
