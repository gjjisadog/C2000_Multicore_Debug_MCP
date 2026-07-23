import { DebugSessionManager } from "../dist/src/debug/DebugSessionManager.js";
import { MockDebugAdapter } from "../dist/src/adapters/MockDebugAdapter.js";
import { LoadedProgramRegistry } from "../dist/src/debug/LoadedProgramRegistry.js";
import { assertCoreIsolation } from "../dist/src/debug/isolationAssertions.js";
import { buildBootHandoffVerdict } from "../dist/src/debug/bootHandoffVerdict.js";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

function ok(label, cond, detail) {
  if (!cond) {
    console.error("FAIL", label, detail ?? "");
    process.exitCode = 1;
    return;
  }
  console.log("ok", label);
}

const coreMap = [
  { coreId: 0, coreName: "C28xx_CPU1" },
  { coreId: 2, coreName: "C28xx_CPU2" }
];

// Running peer PC drift ignored
const halted = { coreId: 0, coreName: "C28xx_CPU1", name: "C28xx_CPU1", connected: true, state: "Halted", pc: "0x1" };
const runningPeer = { coreId: 2, coreName: "C28xx_CPU2", name: "C28xx_CPU2", connected: true, state: "Running", pc: "0x2" };
const isolation = assertCoreIsolation({
  label: "t",
  before: { sessionId: "s", cores: [halted, runningPeer] },
  after: { sessionId: "s", cores: [{ ...halted, state: "Running" }, { ...runningPeer, pc: "0x999" }] },
  targetCoreId: 0,
  expectedTargetState: "Running"
});
ok("running peer pc ignored", isolation.success && !isolation.checkedPeerFields.includes("pc"));

// Owner core required
const manager = new DebugSessionManager(new MockDebugAdapter(), new LoadedProgramRegistry());
const session = await manager.createDebugSession({
  sessionName: "owner",
  coreMap,
  ccxmlPath: undefined
});
await manager.connectTarget(session.sessionId, 2);
const tempDir = await mkdtemp(path.join(tmpdir(), "p1p2-"));
const cpu2Out = path.join(tempDir, "cpu2.out");
await writeFile(cpu2Out, "img");
let ownerFailed = false;
try {
  await manager.loadProgram(session.sessionId, 2, cpu2Out);
} catch (error) {
  ownerFailed = error.code === "OwnerCoreNotConnected";
}
ok("owner core required", ownerFailed);

// runtime ownership verify after load
const manager2 = new DebugSessionManager(new MockDebugAdapter(), new LoadedProgramRegistry(), undefined, {
  defaultCcxmlPath: "/tmp/default.ccxml"
});
const s2 = await manager2.createDebugSession({ sessionName: "rt", coreMap });
ok("default ccxml injected", (await manager2.getSessionTopology(s2.sessionId)).ccxmlPath === "/tmp/default.ccxml");
await manager2.connectCores(s2.sessionId, [0, 2]);
const map = path.join(tempDir, "cpu2.map");
await writeFile(map, `
MEMORY CONFIGURATION
         name            origin    length      used     unused   attr    fill
  RAMGS4                00018000   00002000  00000800  00001800  RWIX
  RAMGS5                0001a000   00002000  00000400  00001c00  RWIX
`);
await manager2.loadProgramWithMap(s2.sessionId, 2, cpu2Out, map);
const verify = await manager2.verifyRuntimeRamOwnership(s2.sessionId, [
  { ownerCoreId: 0, targetCoreId: 2, memoryRegion: "RAMGS4", gsIndex: 4, page: "DATA", address: 0x0005F444, value: 0x10, typeSize: 32, reason: "t" },
  { ownerCoreId: 0, targetCoreId: 2, memoryRegion: "RAMGS5", gsIndex: 5, page: "DATA", address: 0x0005F444, value: 0x20, typeSize: 32, reason: "t" }
]);
ok("runtime ownership verify", verify.matched === true && verify.actualValue === 0x30, verify);

// tighter verdict
const verdict = buildBootHandoffVerdict({
  cpu1: { expressions: [{ success: true, value: "0" }] },
  cpu2: { expressions: [{ success: true, value: "1" }] }
}, {
  success: true,
  target: "F28P65x",
  memcfgGsxmSelAddress: 0x5F444,
  maps: [{ coreId: 2, usedGsRam: [{ name: "RAMGS4", gsIndex: 4 }], memoryRegions: [], sections: [], mapPath: "x" }],
  ownershipActions: []
});
ok("verdict not ready for zero/empty ownership", verdict.ready === false && verdict.cpu1Ready === false && verdict.ramOwnershipReady === false, verdict);

// isolation baseline halt
const manager3 = new DebugSessionManager(new MockDebugAdapter(), new LoadedProgramRegistry());
const s3 = await manager3.createDebugSession({ sessionName: "iso", coreMap });
await manager3.connectCores(s3.sessionId, [0, 2]);
await manager3.runCore(s3.sessionId, 0);
await manager3.runCore(s3.sessionId, 2);
const iso = await manager3.verifyRunPauseIsolation({ sessionId: s3.sessionId, settleMs: 0 });
ok("isolation from running baseline", iso.acceptanceSummary.success === true, iso.acceptanceSummary);

console.log(process.exitCode ? "P1/P2 smoke FAILED" : "P1/P2 smoke PASSED");
