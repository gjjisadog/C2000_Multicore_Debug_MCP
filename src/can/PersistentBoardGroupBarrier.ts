import { DebugMcpError } from "../utils/errors.js";
import {
  BoardGroupBarrierRepository,
  type BoardGroupBarrierName,
  type BoardGroupBarrierRecord
} from "../storage/repositories/BoardGroupBarrierRepository.js";

/** Timeout-bounded rendezvous backed by SQLite instead of process-local promises. */
export class PersistentBoardGroupBarrier {
  constructor(private readonly barriers: BoardGroupBarrierRepository) {}

  async arriveAndWait(input: {
    groupId: string;
    jobId: string;
    name: BoardGroupBarrierName;
    expectedMembers: readonly string[];
    boardId: string;
    timeoutMs: number;
    details?: Record<string, unknown>;
  }): Promise<BoardGroupBarrierRecord> {
    const barrier = this.barriers.begin(input);
    let current = this.barriers.arrive({ barrierId: barrier.barrierId, boardId: input.boardId, details: input.details });
    while (current.status === "PENDING" || current.status === "WAITING") {
      await sleep(Math.min(25, Math.max(1, input.timeoutMs)));
      current = this.barriers.timeoutIfExpired(current.barrierId);
    }
    if (current.status === "SATISFIED") return current;
    throw new DebugMcpError(
      current.status === "TIMED_OUT" ? "BoardGroupBarrierTimeout" : "BoardGroupBarrierFailed",
      `Board group ${input.groupId} did not satisfy ${input.name}: ${current.status}`,
      { barrier: current }
    );
  }

  /** Records a coordinator-observed all-member condition without fabricating target/CAN evidence. */
  satisfyObserved(input: {
    groupId: string;
    jobId: string;
    name: BoardGroupBarrierName;
    expectedMembers: readonly string[];
    timeoutMs: number;
    observations: Record<string, Record<string, unknown>>;
  }): BoardGroupBarrierRecord {
    const barrier = this.barriers.begin(input);
    let current = barrier;
    for (const boardId of input.expectedMembers) {
      current = this.barriers.arrive({ barrierId: current.barrierId, boardId, details: input.observations[boardId] ?? {} });
    }
    if (current.status !== "SATISFIED") {
      throw new DebugMcpError("BoardGroupBarrierFailed", `Coordinator could not satisfy ${input.name}`, { barrier: current });
    }
    return current;
  }
}

function sleep(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }
