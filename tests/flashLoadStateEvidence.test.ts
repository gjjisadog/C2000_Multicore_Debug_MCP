import { runInNewContext } from "node:vm";
import { describe, expect, test } from "vitest";
import { persistentServerScriptSource } from "../src/adapters/PersistentDssBridge.js";

// Execute the actual generated command handlers, not a reimplementation of them.
function harness() {
  const source = persistentServerScriptSource("C:/ti/json2.js");
  const calls: unknown[][] = [];
  const state = { bank: 0, lock: 0, connected: [true, true], failReads: false,
    failStates: false, failLoad: false, failPrepare: false };
  const sessions = Object.fromEntries([0, 2].map((id, index) => [id, {
    target: {
      isConnected() {
        calls.push(["connected", id]);
        if (state.failStates) throw Error("state unavailable");
        return state.connected[index];
      },
      isHalted() { calls.push(["halted", id]); return id === 2; }
    },
    memory: {
      readData(page: number, address: number, bits: number) {
        calls.push(["read", id, page, address, bits]);
        if (state.failReads) throw Error("r".repeat(500));
        return address === 0x5d060 ? state.bank : state.lock;
      },
      loadProgram(program: string) {
        calls.push(["load", id, program]);
        state.lock = 4;
        if (state.failLoad) throw Error("original Bank 3 erase failed");
      }
    },
    flash: {
      options: {
        setString(name: string, value: string) { calls.push(["option", id, name, value]); },
        setBoolean(name: string, value: boolean) { calls.push(["option", id, name, value]); }
      },
      performOperation(name: string) {
        calls.push(["perform", id, name]);
        if (state.failPrepare) throw Error("original preparation failed");
        if (name === "ConfigureBanks") state.bank = 0x3c0;
      }
    }
  }]));
  const context = { sessionsByCoreId: sessions, pendingFlashLoadEvidence: {},
    coreNamesByCoreId: { 0: "C28xx_CPU1", 2: "C28xx_CPU2" },
    Memory: { Page: { DATA: 1 } }, logDiagnostic() {} };
  const handle = runInNewContext(source.slice(source.indexOf("function getSessionForCommand("),
    source.indexOf("function startCoreThread(")) + "\nhandleCommand;", context);
  const command = (name: string, coreId = 2) => handle({ name, coreId,
    coreName: coreId === 2 ? "C28xx_CPU2" : "C28xx_CPU1", program: "cpu2.out", flashBanks: [3, 4] });
  return { command, calls, state, context, source };
}

describe("F28P65x Flash load state evidence", () => {
  test("records both cores and actual mapping before/after preparation and load", () => {
    const h = harness();
    expect(h.command("prepareFlashLoad").status).toBe("OK");
    const result = h.command("load");
    expect(result).toMatchObject({ status: "OK", value: { coreId: 2, coreName: "C28xx_CPU2",
      flashLoadEvidence: { readOnly: true, atomic: false, requestedFlashBanks: [3, 4] } } });
    const snapshots = result.value.flashLoadEvidence.snapshots;
    expect(snapshots.map((s: any) => s.phase)).toEqual([
      "prepare:before", "prepare:after", "load:before", "load:after"]);
    expect(snapshots.map((s: any) => s.registers[0].value)).toEqual([0, 0x3c0, 0x3c0, 0x3c0]);
    expect(snapshots.map((s: any) => s.registers[1].value)).toEqual([0, 0, 0, 4]);
    for (const snapshot of snapshots) {
      expect(snapshot.finishedAtMs).toBeGreaterThanOrEqual(snapshot.startedAtMs);
      expect(snapshot.cores).toEqual([
        { coreId: 0, coreName: "C28xx_CPU1", success: true, connected: true, state: "Running" },
        { coreId: 2, coreName: "C28xx_CPU2", success: true, connected: true, state: "Halted" }
      ]);
    }
    const reads = h.calls.filter(c => c[0] === "read");
    expect(reads).toHaveLength(8);
    expect(reads.every(c => c[1] === 0 && c[2] === 1 &&
      [0x5d060, 0x5d002].includes(c[3] as number) && c[4] === 32)).toBe(true);
    expect(h.calls.filter(c => c[0] === "perform")).toEqual([
      ["perform", 0, "ConfigureClock"], ["perform", 0, "ConfigureBanks"]]);
    const options = h.calls.filter(c => c[0] === "option");
    expect(options).toEqual([
      ...[0, 1, 2, 3, 4].flatMap(bank => [
        ["option", 0, "FlashMapC28Bank" + bank, bank >= 3 ? "1" : "0"],
        ["option", 2, "FlashC28Bank" + bank, bank >= 3]
      ]), ["option", 2, "FlashEraseSelection", "Selected Banks Only"]]);
    expect(h.context.pendingFlashLoadEvidence).toEqual({});
  });

  test("retains original load failure and its snapshots without a load retry", () => {
    const h = harness();
    h.command("prepareFlashLoad");
    h.state.failLoad = true;
    h.state.failReads = true;
    const result = h.command("load");
    expect(result.status).toBe("FAIL");
    expect(result.message).toContain("original Bank 3 erase failed");
    expect(result.details.causes[0].message).toContain("original Bank 3 erase failed");
    expect(result.flashLoadEvidence.snapshots.map((s: any) => s.phase)).toEqual([
      "prepare:before", "prepare:after", "load:before", "load:failure"]);
    expect(result.flashLoadEvidence.snapshots[3].registers[0]).toMatchObject({
      success: false, error: "Error: " + "r".repeat(249) });
    expect(h.calls.filter(c => c[0] === "load")).toHaveLength(1);
    expect(h.context.pendingFlashLoadEvidence).toEqual({});
  });

  test("records a preparation failure but does not arm stale evidence for another load", () => {
    const h = harness();
    h.state.failPrepare = true;
    const result = h.command("prepareFlashLoad");
    expect(result.status).toBe("FAIL");
    expect(result.message).toContain("original preparation failed");
    expect(result.flashLoadEvidence.snapshots.map((s: any) => s.phase)).toEqual([
      "prepare:before", "prepare:failure"]);
    expect(h.context.pendingFlashLoadEvidence).toEqual({});
    expect(h.calls.filter(c => c[0] === "load")).toHaveLength(0);
  });

  test.each(["failReads", "failStates"] as const)("%s cannot turn a successful load into failure", fault => {
    const h = harness();
    h.state[fault] = true;
    expect(h.command("prepareFlashLoad").status).toBe("OK");
    const result = h.command("load");
    expect(result.status).toBe("OK");
    expect(result.value.flashLoadEvidence.snapshots.every((s: any) =>
      s.registers.every((r: any) => r.success === false))).toBe(true);
    if (fault === "failStates") expect(h.calls.filter(c => c[0] === "read")).toHaveLength(0);
  });

  test("never queries halted state or memory through a disconnected core", () => {
    const h = harness();
    h.state.connected = [false, false];
    h.command("prepareFlashLoad");
    const snapshots = h.command("load").value.flashLoadEvidence.snapshots;
    expect(snapshots[0].cores.map((c: any) => c.state)).toEqual(["Disconnected", "Disconnected"]);
    expect(h.calls.filter(c => c[0] === "halted" || c[0] === "read")).toHaveLength(0);
  });

  test("unprepared loads and symbol-only loads do not add target probes", () => {
    const h = harness();
    h.command("load", 0);
    h.command("load", 2);
    expect(h.calls).toEqual([["load", 0, "cpu2.out"], ["load", 2, "cpu2.out"]]);
    const start = h.source.indexOf('command.name === "loadSymbols"');
    const end = h.source.indexOf('command.name === "prepareFirmwareHandoff"', start);
    expect(h.source.slice(start, end)).not.toContain("Evidence");
  });

  test("fresh preparations replace prior evidence and one load consumes at most four snapshots", () => {
    const h = harness();
    for (let i = 0; i < 10; i++) h.command("prepareFlashLoad");
    expect(h.command("load").value.flashLoadEvidence.snapshots).toHaveLength(4);
    h.calls.length = 0;
    expect(h.command("load").value).not.toHaveProperty("flashLoadEvidence");
    expect(h.calls).toEqual([["load", 2, "cpu2.out"]]);
  });

  test("invalid register values are missing evidence, never a plausible zero", () => {
    const h = harness();
    h.state.bank = NaN;
    const snapshot = h.command("prepareFlashLoad").value.flashLoadEvidence.snapshots[0];
    expect(snapshot.registers[0]).toMatchObject({ success: false });
    expect(snapshot.registers[0]).not.toHaveProperty("value");
  });

  test("the snapshot helper contains no reset, write, PC read, symbol evaluation or timeout change", () => {
    const h = harness();
    const helper = h.source.slice(h.source.indexOf("function captureFlashLoadState("),
      h.source.indexOf("function runFlashLoadWithEvidence("));
    expect(helper).not.toMatch(/writeData|\.reset\(|\.halt\(|\.run|evaluate\(|setScriptTimeout|connect\(/);
    expect(helper.match(/memory\.readData\(/g)).toHaveLength(1);
  });
});
