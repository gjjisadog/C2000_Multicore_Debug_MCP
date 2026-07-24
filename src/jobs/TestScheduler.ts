/** Small bounded scheduler. Work is persistent; this class intentionally stores no job authority. */
export class TestScheduler {
  private readonly pending: Array<{ work: () => Promise<void>; resolve: () => void; reject: (error: Error) => void }> = [];
  private running = 0;
  private stopped = false;

  constructor(private readonly maxParallelBoards: number) {}

  schedule(work: () => Promise<void>): Promise<void> {
    if (this.stopped) return Promise.reject(new Error("Test scheduler is stopped"));
    return new Promise<void>((resolve, reject) => {
      this.pending.push({ work, resolve, reject });
      this.drain();
    });
  }

  stop(): void {
    this.stopped = true;
    const error = new Error("Test scheduler stopped before queued work ran");
    for (const pending of this.pending.splice(0)) pending.reject(error);
  }

  private drain(): void {
    while (this.running < this.maxParallelBoards && this.pending.length > 0) {
      const scheduled = this.pending.shift()!;
      this.running += 1;
      void scheduled.work().then(scheduled.resolve, scheduled.reject).finally(() => {
        this.running -= 1;
        this.drain();
      });
    }
  }
}
