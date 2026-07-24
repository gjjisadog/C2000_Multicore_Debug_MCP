import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { BoardLease } from "./types.js";
import { BoardRepository } from "../storage/repositories/BoardRepository.js";
import { LeaseRepository } from "../storage/repositories/LeaseRepository.js";
import { SqliteStore } from "../storage/SqliteStore.js";
import { DebugMcpError } from "../utils/errors.js";

export interface LeasedBoard {
  lease: BoardLease;
  leaseToken: string;
}

/** One active lease per physical board; tokens are stored only as hashes. */
export class BoardLeaseManager {
  constructor(
    private readonly store: SqliteStore,
    private readonly boards: BoardRepository,
    private readonly leases: LeaseRepository
  ) {}

  acquire(options: { boardId: string; ownerJobId?: string; workerInstanceId?: string; ttlMs: number }): LeasedBoard {
    return this.store.transaction(() => {
      const board = this.boards.require(options.boardId);
      const now = new Date();
      const existing = this.leases.activeForBoard(board.boardId);
      if (existing && Date.parse(existing.expiresAt) > now.getTime()) {
        throw new DebugMcpError("BoardLeased", `Board ${board.boardId} already has an active lease`, {
          boardId: board.boardId,
          probeSerial: board.probeSerial,
          leaseId: existing.leaseId,
          ownerJobId: existing.ownerJobId
        });
      }
      if (existing) this.leases.release(existing.leaseId, now.toISOString());
      const leaseToken = randomBytes(32).toString("base64url");
      const lease: BoardLease = {
        leaseId: `lease-${randomUUID()}`,
        boardId: board.boardId,
        probeSerial: board.probeSerial,
        ...(options.ownerJobId ? { ownerJobId: options.ownerJobId } : {}),
        ...(options.workerInstanceId ? { workerInstanceId: options.workerInstanceId } : {}),
        acquiredAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + options.ttlMs).toISOString(),
        renewedAt: now.toISOString()
      };
      this.leases.insert(lease, hashToken(leaseToken));
      this.boards.setLease(board.boardId, lease.leaseId);
      return { lease, leaseToken };
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
      const existing = this.leases.activeForBoard(boardId);
      if (!existing || existing.ownerJobId !== ownerJobId) return false;
      this.leases.release(existing.leaseId, new Date().toISOString());
      this.boards.setLease(boardId, undefined);
      return true;
    });
  }

  active(boardId: string): BoardLease | undefined {
    const lease = this.leases.activeForBoard(boardId);
    if (!lease || Date.parse(lease.expiresAt) <= Date.now()) return undefined;
    const { leaseTokenHash: _token, ...publicLease } = lease;
    return publicLease;
  }

  private find(leaseId: string): BoardLease & { leaseTokenHash: string } {
    const candidate = this.leases.activeForBoardByLeaseId(leaseId);
    if (!candidate) {
      throw new DebugMcpError("BoardLeased", "Board lease is missing or released", { leaseId });
    }
    return candidate;
  }
}

function hashToken(token: string): string { return createHash("sha256").update(token).digest("hex"); }
function tokensMatch(left: string, right: string): boolean {
  const first = Buffer.from(left, "utf8");
  const second = Buffer.from(right, "utf8");
  return first.length === second.length && timingSafeEqual(first, second);
}
