import { mergeOwnershipActions, ownershipActionsForMap, parseLinkerMap } from "../dist/src/hardware/mapOwnership.js";
import { resolveAdapterMode } from "../dist/src/adapters/adapterResolution.js";
import { DebugSessionManager } from "../dist/src/debug/DebugSessionManager.js";
import { MockDebugAdapter } from "../dist/src/adapters/MockDebugAdapter.js";
import { LoadedProgramRegistry } from "../dist/src/debug/LoadedProgramRegistry.js";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

function assert(cond, label, detail) {
  if (!cond) {
    console.error("FAIL", label, detail ?? "");
    process.exitCode = 1;
    return;
  }
  console.log("ok", label);
}

const parsed = parseLinkerMap(`
MEMORY CONFIGURATION
         name            origin    length      used     unused   attr    fill
  RAMGS4                00018000   00002000  00000800  00001800  RWIX
  RAMGS5                0001a000   00002000  00000400  00001c00  RWIX
`, { coreId: 2, coreName: "C28xx_CPU2", mapPath: "/tmp/cpu2.map" });
const merged = mergeOwnershipActions(ownershipActionsForMap(parsed));
assert(merged.length === 1 && merged[0].value === 0x30, "merge multi-GS ownership");

const noDss = await resolveAdapterMode({
  adapter: "auto",
  ccs: { scriptingMode: "auto", installPath: "/tmp/no-ccs-install" },
  target: { name: "F28P65x", coreMap: [{ coreId: 0, coreName: "C28xx_CPU1" }] },
  logging: { level: "info" }
});
assert(noDss.mode === "mock" && noDss.reason.includes("not found"), "auto falls back without DSS");

const tempCcs = await mkdtemp(path.join(tmpdir(), "c2000-dss-"));
const dssDir = path.join(tempCcs, "ccs_base", "scripting", "bin");
await mkdir(dssDir, { recursive: true });
await writeFile(path.join(dssDir, process.platform === "win32" ? "dss.bat" : "dss.sh"), "#!/bin/sh\n");
const withDss = await resolveAdapterMode({
  adapter: "auto",
  ccs: { scriptingMode: "auto", installPath: tempCcs },
  target: { name: "F28P65x", coreMap: [{ coreId: 0, coreName: "C28xx_CPU1" }] },
  logging: { level: "info" }
});
assert(withDss.mode === "ccs" && withDss.reason.includes("found"), "auto selects ccs with DSS");

class Lying extends MockDebugAdapter {
  async assignExpression() {
    return { success: true, value: "0" };
  }
}
const mgr = new DebugSessionManager(new Lying({
  expressionValues: { x: { value: "1" } }
}), new LoadedProgramRegistry());
const s = await mgr.createDebugSession({
  sessionName: "t",
  coreMap: [
    { coreId: 0, coreName: "C28xx_CPU1" },
    { coreId: 2, coreName: "C28xx_CPU2" }
  ]
});
await mgr.connectTarget(s.sessionId, 0);
let verifyFailed = false;
try {
  await mgr.assignExpression(s.sessionId, 0, "x", 0);
} catch (error) {
  verifyFailed = error.code === "ExpressionVerifyFailed";
}
assert(verifyFailed, "assignExpression verify mismatch fails");

const resolved = await mgr.resolveAddress(s.sessionId, 0, "0x1");
assert(resolved.success === false && resolved.partial === true, "resolveAddress partial failure");

const pc = await mgr.resolvePc(s.sessionId, 0);
assert(pc.success === true && pc.partial === true, "resolvePc keeps success for PC read");

const tempDir = await mkdtemp(path.join(tmpdir(), "c2000-gs-"));
const out = path.join(tempDir, "cpu2.out");
const map = path.join(tempDir, "cpu2.map");
await writeFile(out, "img");
await writeFile(map, `
MEMORY CONFIGURATION
         name            origin    length      used     unused   attr    fill
  RAMGS4                00018000   00002000  00000800  00001800  RWIX
  RAMGS5                0001a000   00002000  00000400  00001c00  RWIX
`);
const events = [];
class Rec extends MockDebugAdapter {
  async writeMemory(session, coreId, page, address, value, typeSize) {
    events.push({ coreId, page, address, value, typeSize });
    return super.writeMemory(session, coreId, page, address, value, typeSize);
  }
}
const m2 = new DebugSessionManager(new Rec(), new LoadedProgramRegistry());
const s2 = await m2.createDebugSession({
  sessionName: "gs",
  coreMap: [
    { coreId: 0, coreName: "C28xx_CPU1" },
    { coreId: 2, coreName: "C28xx_CPU2" }
  ]
});
await m2.connectCores(s2.sessionId, [0, 2]);
await m2.loadProgramWithMap(s2.sessionId, 2, out, map);
assert(events.length === 1 && events[0].value === 0x30, "single OR-combined MEMCFG write", events);

console.log(process.exitCode ? "P0 smoke FAILED" : "P0 smoke PASSED");
