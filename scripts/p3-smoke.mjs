import { normalizeProgramUri } from "../dist/src/utils/pathUtils.js";
import { parseLinkerMap } from "../dist/src/hardware/mapOwnership.js";
import { DebugSessionManager } from "../dist/src/debug/DebugSessionManager.js";
import { MockDebugAdapter } from "../dist/src/adapters/MockDebugAdapter.js";
import { LoadedProgramRegistry } from "../dist/src/debug/LoadedProgramRegistry.js";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

function ok(label, cond, detail) {
  if (!cond) {
    console.error("FAIL", label, detail ?? "");
    process.exitCode = 1;
    return;
  }
  console.log("ok", label);
}

const abs = path.resolve("/tmp/cpu1.out");
ok("file url normalize", normalizeProgramUri(pathToFileURL(abs).href) === abs);
ok("quoted path normalize", normalizeProgramUri(`"${abs}"`) === abs);

const parsed = parseLinkerMap(`
GLOBAL SYMBOLS
  RAMGS9                00020000   00002000  00000100  00001f00  RWIX
MEMORY CONFIGURATION
  RAMGS4                00018000   00002000  00000800  00001800  RWIX
SECTION ALLOCATION MAP
  RAMGS8                0001c000   00002000  00000200  00001e00  RWIX
`, { coreId: 2, mapPath: "/tmp/cpu2.map" });
ok("map scoped to MEMORY CONFIGURATION", parsed.memoryRegions.length === 1 && parsed.memoryRegions[0].name === "RAMGS4", parsed.memoryRegions);

const coreMap = [
  { coreId: 0, coreName: "C28xx_CPU1" },
  { coreId: 2, coreName: "C28xx_CPU2" }
];
const events = [];
class Rec extends MockDebugAdapter {
  async writeMemory(session, coreId, page, address, value, typeSize) {
    events.push({ coreId, page, address, value, typeSize });
    return super.writeMemory(session, coreId, page, address, value, typeSize);
  }
}
const adapter = new Rec();
const manager = new DebugSessionManager(adapter, new LoadedProgramRegistry());
const session = await manager.createDebugSession({ sessionName: "p3", coreMap });
await manager.connectCores(session.sessionId, [0, 2]);
const topology = await manager.getSessionTopology(session.sessionId);
await adapter.writeMemory(
  {
    adapterSessionId: topology.adapterSessionId,
    sessionName: topology.sessionName,
    ccxmlPath: topology.ccxmlPath,
    coreMap
  },
  0,
  "DATA",
  0x0005F444,
  0x08,
  32
);
events.length = 0;
const tempDir = await mkdtemp(path.join(tmpdir(), "p3-smoke-"));
const cpu2Out = path.join(tempDir, "cpu2.out");
await writeFile(cpu2Out, "img");
const loaded = await manager.loadProgram(session.sessionId, 2, cpu2Out);
ok("rmw preserves existing bits", events.length === 1 && events[0].value === (0x08 | 0x10), events);
ok("fallback warning on load info", String(loaded.warning).includes("RAMGS4-only handoff default"), loaded.warning);

console.log(process.exitCode ? "P3 smoke FAILED" : "P3 smoke PASSED");
