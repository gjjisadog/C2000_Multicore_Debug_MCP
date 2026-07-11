import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { DebugProbePoolCoordinator, FileDebugProbeCoordinator } from "../src/hardware/debugProbeCoordinator.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "c2000-probe-"));
  roots.push(root);
  return root;
}

describe("FileDebugProbeCoordinator", () => {
  test("holds the shared lease until the debug workflow releases it", async () => {
    const root = await tempRoot();
    const coordinator = new FileDebugProbeCoordinator(root, 1000, 5);
    const lease = await coordinator.acquire("first");

    const owner = JSON.parse(await readFile(path.join(root, "active", "owner.json"), "utf8"));
    expect(owner).toMatchObject({ leaseId: lease.leaseId, label: "first", pid: process.pid });

    await lease.release();
    await expect(readFile(path.join(root, "active", "owner.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("queues concurrent agents in FIFO order", async () => {
    const root = await tempRoot();
    const first = await new FileDebugProbeCoordinator(root, 1000, 5).acquire("first");
    const secondPending = new FileDebugProbeCoordinator(root, 1000, 5).acquire("second");
    await new Promise(resolve => setTimeout(resolve, 20));

    let secondAcquired = false;
    void secondPending.then(() => { secondAcquired = true; });
    expect(secondAcquired).toBe(false);
    await first.release();

    const second = await secondPending;
    expect(second.queuePositionAtEntry).toBe(2);
    expect(second.waitedMs).toBeGreaterThan(0);
    await second.release();
  });

  test("removes dead waiting tickets instead of blocking the queue forever", async () => {
    const root = await tempRoot();
    const queueDir = path.join(root, "queue");
    await mkdir(queueDir, { recursive: true });
    await writeFile(path.join(queueDir, "0000000000000000-dead.json"), JSON.stringify({ pid: 99999999 }));

    const lease = await new FileDebugProbeCoordinator(root, 1000, 5).acquire("live");
    expect(lease.queuePositionAtEntry).toBe(1);
    await lease.release();
  });
});

describe("DebugProbePoolCoordinator", () => {
  const probes = [
    { probeId: "board-01", serialNumber: "XDS-A", ccxmlPath: "/targets/a.ccxml" },
    { probeId: "board-02", serialNumber: "XDS-B", ccxmlPath: "/targets/b.ccxml" }
  ];

  test("allocates different free boards so hardware workflows can run in parallel", async () => {
    const pool = new DebugProbePoolCoordinator(await tempRoot(), probes, 1000, 5);
    const first = await pool.acquire("agent-a", { allowAutoProbeAllocation: true });
    const second = await pool.acquire("agent-b", { allowAutoProbeAllocation: true });

    expect(first.probe?.probeId).toBe("board-01");
    expect(second.probe?.probeId).toBe("board-02");
    await Promise.all([first.release(), second.release()]);
  });

  test("serializes callers that request the same board", async () => {
    const pool = new DebugProbePoolCoordinator(await tempRoot(), probes, 1000, 5);
    const first = await pool.acquire("agent-a", { probeId: "board-02" });
    const waiting = pool.acquire("agent-b", { probeId: "board-02" });
    await new Promise(resolve => setTimeout(resolve, 20));
    await first.release();
    const second = await waiting;

    expect(second.probe).toEqual(probes[1]);
    expect(second.waitedMs).toBeGreaterThan(0);
    await second.release();
  });

  test("rejects an unknown board instead of routing to the wrong target", async () => {
    const pool = new DebugProbePoolCoordinator(await tempRoot(), probes, 1000, 5);
    await expect(pool.acquire("agent", { probeId: "missing" })).rejects.toMatchObject({ code: "ProbeNotFound" });
  });

  test("does not enter automatic multi-board allocation without explicit call opt-in", async () => {
    const pool = new DebugProbePoolCoordinator(await tempRoot(), probes, 1000, 5);
    await expect(pool.acquire("agent")).rejects.toMatchObject({ code: "ProbeSelectionRequired" });
  });
});
