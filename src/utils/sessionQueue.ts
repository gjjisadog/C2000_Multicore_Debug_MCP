/**
 * Per-key serial queue so concurrent MCP tool calls on the same debug session
 * do not interleave connect/load/run sequences.
 */
export class SessionQueue {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(work);
    this.tails.set(
      key,
      run.then(
        () => undefined,
        () => undefined
      )
    );
    return run;
  }
}
