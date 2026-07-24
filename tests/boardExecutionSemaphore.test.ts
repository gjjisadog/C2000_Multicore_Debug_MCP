import { describe, expect, test, vi } from "vitest";
import { BoardExecutionSemaphore } from "../src/jobs/BoardExecutionSemaphore.js";

describe("BoardExecutionSemaphore", () => {
  test("limits physical boards globally across jobs", async () => {
    const semaphore = new BoardExecutionSemaphore(2);
    const first = await semaphore.acquire("board-a", "job-a");
    const second = await semaphore.acquire("board-b", "job-b");
    let thirdAcquired = false;
    const thirdPromise = semaphore.acquire("board-c", "job-c").then(permit => {
      thirdAcquired = true;
      return permit;
    });

    await Promise.resolve();
    expect(semaphore.snapshot()).toMatchObject({ limit: 2, active: 2, waiting: 1 });
    expect(thirdAcquired).toBe(false);

    first.release();
    const third = await thirdPromise;
    expect(semaphore.snapshot().holders.map(holder => holder.boardId).sort()).toEqual(["board-b", "board-c"]);
    second.release();
    third.release();
  });

  test("acquires a CAN pair atomically without partial reservation", async () => {
    const semaphore = new BoardExecutionSemaphore(2);
    const blocker = await semaphore.acquire("board-b", "blocker");
    const pairPromise = semaphore.acquireGroup(["board-b", "board-a"], "can-job");
    await Promise.resolve();

    expect(semaphore.snapshot().holders).toEqual([
      expect.objectContaining({ boardId: "board-b", jobId: "blocker" })
    ]);
    expect(semaphore.snapshot()).toMatchObject({ active: 1, waiting: 1 });

    blocker.release();
    const pair = await pairPromise;
    expect(pair.map(permit => permit.boardId)).toEqual(["board-a", "board-b"]);
    pair.forEach(permit => permit.release());
  });

  test("fails immediately when a CAN pair cannot fit the configured limit", async () => {
    const semaphore = new BoardExecutionSemaphore(1);
    await expect(semaphore.acquireGroup(["board-b", "board-a"], "can-job")).rejects.toMatchObject({
      code: "InsufficientBoardConcurrency",
      details: {
        requiredBoards: 2,
        configuredMaxParallelBoards: 1,
        boardIds: ["board-a", "board-b"]
      }
    });
  });

  test("does not grant duplicate permits and release is idempotent", async () => {
    const semaphore = new BoardExecutionSemaphore(2);
    const first = await semaphore.acquire("board-a", "job-a");
    const releaseSpy = vi.fn();
    const waiting = semaphore.acquire("board-a", "job-b").then(permit => {
      releaseSpy();
      return permit;
    });
    await Promise.resolve();
    expect(semaphore.snapshot()).toMatchObject({ active: 1, waiting: 1 });
    first.release();
    first.release();
    const second = await waiting;
    expect(releaseSpy).toHaveBeenCalledOnce();
    second.release();
  });

  test("stop rejects waiters and waits for active permits to release", async () => {
    const semaphore = new BoardExecutionSemaphore(1);
    const active = await semaphore.acquire("board-a", "job-a");
    const waiting = semaphore.acquire("board-b", "job-b");
    const stopped = semaphore.stop();
    await expect(waiting).rejects.toThrow("stopped");
    let finished = false;
    void stopped.then(() => { finished = true; });
    await Promise.resolve();
    expect(finished).toBe(false);
    active.release();
    await stopped;
    expect(finished).toBe(true);
  });
});
