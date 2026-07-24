import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { ProbeRecoveryManager, type ObservedProcess, type OwnedProcessIdentity } from "../src/boards/ProbeRecoveryManager.js";
import { BoardRegistry } from "../src/boards/BoardRegistry.js";
import { BoardRepository } from "../src/storage/repositories/BoardRepository.js";
import { EventRepository } from "../src/storage/repositories/EventRepository.js";
import { LeaseRepository } from "../src/storage/repositories/LeaseRepository.js";
import { SqliteStore } from "../src/storage/SqliteStore.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

describe("probe recovery safety", () => {
  test("only terminates a fully matched owned process and quarantines external/PID-reused identities", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "c2000-probe-recovery-"));
    directories.push(directory);
    const store = await SqliteStore.open(path.join(directory, "state.sqlite"));
    const events = new EventRepository(store);
    const registry = new BoardRegistry(new BoardRepository(store), events, store, new LeaseRepository(store));
    registry.register({ boardId: "board-a", probeSerial: "CL650001", device: "F28P65x", ccxmlPath: "a.ccxml", tags: [] });
    const owned: OwnedProcessIdentity = { pid: 42, ppid: 10, processStartTime: "2026-01-01T00:00:00.000Z", commandLine: "node dss --serial CL650001 --c2000-owner=hash", daemonInstanceId: "daemon", workerInstanceId: "worker", boardId: "board-a", probeSerial: "CL650001", identityHash: "hash", kind: "dss" };
    const observed: ObservedProcess = { pid: 42, ppid: 10, processStartTime: owned.processStartTime, commandLine: owned.commandLine, kind: "c2000-dss" };
    const terminated: number[] = [];
    const manager = new ProbeRecoveryManager({ registry, events, owned: async () => [owned], inspect: async () => [observed], terminate: async process => { terminated.push(process.pid); } });
    await expect(manager.recoverOwnedProbeProcesses("CL650001", false)).resolves.toEqual(expect.objectContaining({ recoveredPids: [42] }));
    expect(terminated).toEqual([42]);

    const reused = new ProbeRecoveryManager({ registry, events, owned: async () => [owned], inspect: async () => [{ ...observed, processStartTime: "2026-01-01T01:00:00.000Z" }], terminate: async process => { terminated.push(process.pid); } });
    await reused.recoverOwnedProbeProcesses("CL650001", false);
    expect(terminated).toEqual([42]);
    expect(registry.get("board-a").status).toBe("QUARANTINED");
    store.close();
  });
});
