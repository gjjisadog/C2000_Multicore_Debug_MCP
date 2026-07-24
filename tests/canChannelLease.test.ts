import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { CanChannelLeaseManager } from "../src/can/CanChannelLeaseManager.js";
import { SqliteStore } from "../src/storage/SqliteStore.js";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))));

describe("cross-process CAN channel fencing", () => {
  test("allows only one live owner and permanently rejects an old worker generation", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "c2000-can-lease-"));
    directories.push(directory);
    const store = await SqliteStore.open(path.join(directory, "test.sqlite"));
    const leases = new CanChannelLeaseManager(store);
    const first = leases.acquire({
      adapterId: "pcan-1", channel: "PCAN_USBBUS1", ownerJobId: "job-a",
      daemonInstanceId: "daemon-a", canWorkerInstanceId: "worker-a", pid: 100,
      processStartTime: "2026-01-01T00:00:00.000Z", ttlMs: 1000
    });
    expect(() => leases.acquire({
      adapterId: "pcan-1", channel: "PCAN_USBBUS1", ownerJobId: "job-b",
      daemonInstanceId: "daemon-b", canWorkerInstanceId: "worker-b", pid: 101,
      processStartTime: "2026-01-01T00:00:01.000Z", ttlMs: 1000
    })).toThrowError(expect.objectContaining({ code: "PcanChannelInUse" }));
    leases.release(first);
    const second = leases.acquire({
      adapterId: "pcan-1", channel: "PCAN_USBBUS1", ownerJobId: "job-b",
      daemonInstanceId: "daemon-b", canWorkerInstanceId: "worker-b", pid: 101,
      processStartTime: "2026-01-01T00:00:01.000Z", ttlMs: 1000
    });
    expect(second.fencingToken).toBe(first.fencingToken + 1);
    expect(() => leases.validate(first)).toThrowError(expect.objectContaining({ code: "LeaseFencingRejected" }));
    expect(() => leases.validate({ ...second, canWorkerInstanceId: "stale-worker" })).toThrowError(expect.objectContaining({ code: "LeaseWorkerMismatch" }));
    store.close();
  });
});
