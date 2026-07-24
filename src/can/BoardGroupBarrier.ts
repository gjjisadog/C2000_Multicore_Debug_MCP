import { DebugMcpError } from "../utils/errors.js";

/** A one-shot, timeout-bounded barrier. A failed launch cannot leave a peer waiting forever. */
export class BoardGroupBarrier {
  private readonly arrived = new Set<string>();
  private readonly release: Promise<void>;
  private resolveRelease!: () => void;
  private rejectRelease!: (error: Error) => void;
  private readonly timeout: NodeJS.Timeout;

  constructor(private readonly participants: readonly string[], timeoutMs: number) {
    this.release = new Promise<void>((resolve, reject) => { this.resolveRelease = resolve; this.rejectRelease = reject; });
    this.timeout = setTimeout(() => this.reject(new DebugMcpError("CanBarrierTimeout", "CAN board-group barrier timed out", { participants, arrived: [...this.arrived] })), timeoutMs);
    this.timeout.unref();
  }

  async arrive(boardId: string): Promise<void> {
    if (!this.participants.includes(boardId)) throw new DebugMcpError("CanProfileInvalid", "Board is not a member of the CAN group", { boardId, participants: this.participants });
    this.arrived.add(boardId);
    if (this.arrived.size === this.participants.length) {
      clearTimeout(this.timeout);
      this.resolveRelease();
    }
    return this.release;
  }

  reject(error: Error): void {
    clearTimeout(this.timeout);
    this.rejectRelease(error);
  }
}
