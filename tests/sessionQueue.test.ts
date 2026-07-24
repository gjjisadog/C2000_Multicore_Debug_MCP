import { describe, expect, test } from "vitest";
import { SessionQueue } from "../src/utils/sessionQueue.js";

describe("SessionQueue", () => {
  test("retains a key until all queued work settles, then removes the released tail", async () => {
    const queue = new SessionQueue();
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    let firstStarted!: () => void;
    let secondStarted!: () => void;
    const firstStartedPromise = new Promise<void>(resolve => { firstStarted = resolve; });
    const secondStartedPromise = new Promise<void>(resolve => { secondStarted = resolve; });
    const first = queue.run("closed-session", () => {
      firstStarted();
      return new Promise<void>(resolve => { releaseFirst = resolve; });
    });
    const second = queue.run("closed-session", () => {
      secondStarted();
      return new Promise<void>(resolve => { releaseSecond = resolve; });
    });

    await firstStartedPromise;

    queue.clearWhenIdle("closed-session");
    expect(queue.has("closed-session")).toBe(true);

    releaseFirst();
    await first;
    await secondStartedPromise;
    await new Promise(resolve => setImmediate(resolve));
    expect(queue.has("closed-session")).toBe(true);

    releaseSecond();
    await second;
    await new Promise(resolve => setImmediate(resolve));
    expect(queue.has("closed-session")).toBe(false);
  });
});
