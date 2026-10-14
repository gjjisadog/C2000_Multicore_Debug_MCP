import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { MockDebugAdapter } from "../src/adapters/MockDebugAdapter.js";
import { c2000McpConfigSchema } from "../src/config/config.schema.js";
import { DebugSessionManager } from "../src/debug/DebugSessionManager.js";
import { LoadedProgramRegistry } from "../src/debug/LoadedProgramRegistry.js";
import { createToolHandlers } from "../src/mcp/toolHandlers.js";
import { assertCcxmlProbeBinding, readCcxmlProbeSerialFromText, readCcxmlProbeTypeFromText } from "../src/hardware/ccxmlBinding.js";
import { getConnectedProbeSerials, parseXds100Devices, resolveXds100SerialPath, runHardwarePreflight } from "../src/hardware/preflight.js";
import { discoverAcceptancePrograms, validateProgramPair } from "../src/hardware/programDiscovery.js";
import { buildAdapterEvidence } from "../src/artifacts/JobArtifactSnapshotService.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function tempRoot() {
  const root = await mkdtemp(path.join(tmpdir(), "c2000-compat-"));
  roots.push(root);
  return root;
}
const table = `Scanning for XDS100 emulators...
VID/PID    Type            Serial #    Description
0403/a6d0  XDS100v1/v2     TI100001    Texas Instruments XDS100v2
0403/a6d1  XDS100v3        TI100003    Texas Instruments XDS100v3
0403/6010  generic FT2232  FT12345     USB serial converter
0403/a6d0  XDS100v1/v2     unknownA    no description available A
`;

describe("F28374S / XDS100 compatibility", () => {
  test("parses only identified XDS100 devices, not generic FTDI or empty enumeration", () => {
    expect(parseXds100Devices(table).map(device => device.serialNumber)).toEqual(["TI100001", "TI100003"]);
    expect(parseXds100Devices("No XDS100 emulators were found on the system.")).toEqual([]);
    expect(resolveXds100SerialPath("D:/ti/ccs", "win32")).toBe("D:\\ti\\ccs\\ccs_base\\common\\uscif\\xds100serial.exe");
    expect(resolveXds100SerialPath("/ti/ccs", "linux")).toBe("/ti/ccs/ccs_base/common/uscif/xds100serial");
  });

  test.each(["darwin", "linux", "win32"] as const)("enumerates XDS100 alongside XDS110 on %s", async platform => {
    const result = await runHardwarePreflight({ ccsInstallPath: "/ti/ccs", platform,
      execFile: async (command, args) => {
        if (/xds100serial(?:\.exe)?$/.test(command)) {
          expect(args).toEqual([]);
          return { stdout: table, stderr: "" };
        }
        if (/xdsdfu(?:\.exe)?$/.test(command)) return { stdout: "<<<< Device 0 >>>>\nSerial Num: TI110001\n", stderr: "" };
        return { stdout: "", stderr: "" };
      }
    });
    expect(result.xds100).toMatchObject({ ok: true, probeReady: true });
    expect(getConnectedProbeSerials(result)).toEqual(["TI110001", "TI100001", "TI100003"]);
  });

  test("enumerates XDS100 when the XDS110 utility fails and reports missing XDS100 utility", async () => {
    const preflight = (available: boolean) => runHardwarePreflight({ platform: "linux", execFile: async command => {
      if (command.endsWith("xds100serial") && available) return { stdout: table, stderr: "" };
      if (command === "ps") return { stdout: "", stderr: "" };
      throw new Error("utility unavailable");
    } });
    expect(getConnectedProbeSerials(await preflight(true))).toEqual(["TI100001", "TI100003"]);
    const absent = await preflight(false);
    expect(absent.xds100).toMatchObject({ ok: false, probeReady: false, error: "utility unavailable" });
    expect(getConnectedProbeSerials(absent)).toEqual([]);
  });

  test("accepts CCS's XDS100 serial property and rejects placeholders and mismatched bindings", async () => {
    expect(readCcxmlProbeSerialFromText('<property ID="SEPK.POD_SERIAL" Value="TI100001"/>')).toBe("TI100001");
    expect(readCcxmlProbeSerialFromText('<property ID="SEPK.POD_SERIAL" Value="Run xds100serial to get serial number"/>')).toBeUndefined();
    const template = await readFile(new URL("../examples/targetConfigs/F28374S_XDS100v2.ccxml", import.meta.url), "utf8");
    expect(readCcxmlProbeTypeFromText(template)).toBe("XDS100");
    expect(readCcxmlProbeSerialFromText(template)).toBeUndefined();
    const file = path.join(await tempRoot(), "board.ccxml");
    await writeFile(file, template.replace("REPLACE_WITH_XDS100_SERIAL", "TI100001"));
    await expect(assertCcxmlProbeBinding(file, "TI100001")).resolves.toBeUndefined();
    await expect(assertCcxmlProbeBinding(file, "TI100002")).rejects.toMatchObject({ code: "ProbeBindingInvalid" });
  });

  test("discovers ordinary single-CPU artifacts and still rejects wrong device/core images", async () => {
    const root = await tempRoot();
    const program = path.join(root, "blink.out");
    await writeFile(program, "mock image");
    await writeFile(path.join(root, "cpu2.out"), "wrong core");
    await writeFile(path.join(root, "f28p65x_cpu1.out"), "wrong device");
    const result = await discoverAcceptancePrograms({ searchRoots: [root], expectedDevice: "F28374S", singleCore: true });
    expect(result.cpu1.selected).toBe(program);
    expect(result.cpu2.candidates).toEqual([]);
    expect(result.pairing).toMatchObject({ complete: true, compatible: true });
    expect(validateProgramPair("f28374s_cpu2.out", undefined, "F28374S", true).compatible).toBe(false);
    expect(validateProgramPair("f28p65x_cpu1.out", undefined, "F28374S", true).compatible).toBe(false);
    expect(validateProgramPair("f28379s_cpu1.out", undefined, "F28374S", true).compatible).toBe(false);
    expect(validateProgramPair("f2837xs/blink.out", undefined, "TMS320F28374S", true).compatible).toBe(true);
    expect(validateProgramPair("cpu1.out", undefined, "F28P65x").complete).toBe(false);
    await rm(program);
    const family = path.join(root, "f2837xs_blink.out");
    await writeFile(family, "TI family example");
    const familyDiscovery = await discoverAcceptancePrograms({ searchRoots: [root], expectedDevice: "F28374S", singleCore: true });
    expect(familyDiscovery.cpu1.selected).toBe(family);
    expect(familyDiscovery.pairing?.compatible).toBe(true);
  });

  test("single-CPU readiness and load/run/halt stay on core 0", async () => {
    const config = c2000McpConfigSchema.parse(JSON.parse(await readFile(new URL("../examples/f28374s-xds100v2.config.json", import.meta.url), "utf8")));
    const root = await tempRoot();
    const program = path.join(root, "blink.out");
    const ccxmlPath = path.join(root, "board.ccxml");
    await writeFile(program, "mock image");
    await writeFile(ccxmlPath, "<configurations/>");
    const manager = new DebugSessionManager(new MockDebugAdapter(), new LoadedProgramRegistry(), undefined, { defaultCoreMap: config.target.coreMap });
    const handlers = createToolHandlers(manager, { target: config.target, tiEnvironment: { ccxmlPath },
      runHardwarePreflight: async () => ({ xdsdfuPath: "unused", xdsdfu: { ok: false },
        xds100: { ok: true, commandOk: true, probeReady: true, devices: parseXds100Devices(table) },
        debugProcesses: [], debugProcessDetails: [] }) });
    const readiness = await handlers.getAcceptanceReadiness({ cpu1Program: program, searchRoots: [root] });
    expect(readiness).toMatchObject({ success: true, readyForHardwareAcceptance: true, blockers: [],
      checks: { cpu2Program: { applicable: false }, probe: { ok: true } }, acceptanceEvidence: { applicable: false } });
    expect(readiness.nextCommand).toBeUndefined();
    const session = await manager.createDebugSession({ sessionName: "single-CPU", coreMap: config.target.coreMap });
    try {
      expect((await manager.getSessionTopology(session.sessionId)).cores.map(core => core.coreId)).toEqual([0]);
      await manager.connectCores(session.sessionId, [0]);
      await manager.loadProgram(session.sessionId, 0, program);
      expect(await manager.runCore(session.sessionId, 0)).toMatchObject({ coreId: 0, state: "Running" });
      expect(await manager.haltCore(session.sessionId, 0)).toMatchObject({ coreId: 0, state: "Halted" });
      await expect(manager.connectTarget(session.sessionId, 2)).rejects.toMatchObject({ code: "CoreNotFound" });
    } finally { await manager.closeDebugSession(session.sessionId); }
  });

  test.each(["xds100", "xds2xx"])("requires actual matching %s preflight evidence for hardware classification", source => {
    const config = { adapter: "ccs", ccs: { scriptingMode: "ccs" } } as Parameters<typeof buildAdapterEvidence>[0];
    const evidence = (ready: boolean, serial: string) => buildAdapterEvidence(config, "board", "TI100001",
      { sessionId: "session", adapterSessionId: "adapter" }, [
        { stepType: "launchMulticore", output: { effectiveAdapterType: "ccs", sessionId: "session", adapterSessionId: "adapter" } },
        { stepType: "preflight", output: { [source]: { probeReady: ready, devices: [{ serialNumber: serial }] } } }
      ]);
    expect(evidence(true, "TI100001").classification).toBe("HARDWARE_TARGET");
    expect(evidence(false, "TI100001").classification).toBe("UNKNOWN");
    expect(evidence(true, "OTHER").classification).toBe("UNKNOWN");
  });
});
