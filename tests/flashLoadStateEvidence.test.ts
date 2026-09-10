import { runInNewContext } from "node:vm";
import { describe, expect, test } from "vitest";
import { persistentServerScriptSource } from "../src/adapters/PersistentDssBridge.js";

// Execute the actual generated command handlers, not a reimplementation of them.
function harness() {
  const source = persistentServerScriptSource("C:/ti/json2.js");
  const calls: unknown[][] = [];
  const state = { bank: 0, lock: 0, clock: 0, connected: [true, true], failReads: false,
    failStates: false, failLoad: false, failPrepare: false, failBanks: false,
    configuredBank: 0x3c0, configuredLock: 0,
    loadError: "original Bank 3 erase failed",
    registerValues: {} as Record<string, number> };
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
        const override = state.registerValues[id + ":" + address];
        if (override !== undefined) return override;
        return address === 0x5d060 ? state.bank : address === 0x5d002 ? state.lock :
          address === 0x5d20e ? state.clock : 0;
      },
      loadProgram(program: string) {
        calls.push(["load", id, program]);
        state.lock = 4;
        if (state.failLoad) throw Error(state.loadError);
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
        if (name === "ConfigureClock") state.clock = 3;
        if (name === "ConfigureBanks") {
          if (state.failBanks) throw Error("original bank preparation failed");
          state.bank = state.configuredBank;
          state.lock = state.configuredLock;
        }
      }
    }
  }]));
  const context = { sessionsByCoreId: sessions, pendingFlashLoadEvidence: {},
    coreNamesByCoreId: { 0: "C28xx_CPU1", 2: "C28xx_CPU2" },
    Memory: { Page: { DATA: 1 } }, logDiagnostic() {} };
  const handle = runInNewContext(source.slice(source.indexOf("function getSessionForCommand("),
    source.indexOf("function startCoreThread(")) + "\nhandleCommand;", context);
  const command = (name: string, coreId = 2, flashBanks = [3, 4]) => handle({ name, coreId,
    coreName: coreId === 2 ? "C28xx_CPU2" : "C28xx_CPU1", program: "cpu2.out", flashBanks });
  return { command, calls, state, context, source };
}

describe("F28P65x Flash load state evidence", () => {
  test("records both cores and actual mapping before/after preparation and load", () => {
    const h = harness();
    expect(h.command("prepareFlashLoad").status).toBe("OK");
    const result = h.command("load");
    expect(result).toMatchObject({ status: "OK", value: { coreId: 2, coreName: "C28xx_CPU2",
      flashLoadEvidence: { readOnly: true, atomic: false, requestedFlashBanks: [3, 4] } } });
    expect(result.value.flashLoadEvidence.boundaryValidation).toMatchObject({
      status: "verified", expectedBankMuxSel: 0x3c0, actualBankMuxSel: 0x3c0, bankMuxLocked: false
    });
    const snapshots = result.value.flashLoadEvidence.snapshots;
    expect(snapshots.map((s: any) => s.phase)).toEqual([
      "prepare:before", "prepare:clock-ready", "prepare:after", "load:before", "load:after"]);
    expect(snapshots.map((s: any) => s.registers[0].value)).toEqual([0, 0, 0x3c0, 0x3c0, 0x3c0]);
    expect(snapshots.map((s: any) => s.registers[1].value)).toEqual([0, 0, 0, 0, 4]);
    expect(snapshots.map((s: any) => s.registers.find((r: any) =>
      r.name === "SYSPLLCTL1").value)).toEqual([0, 3, 3, 3, 3]);
    for (const snapshot of snapshots) {
      expect(snapshot.finishedAtMs).toBeGreaterThanOrEqual(snapshot.startedAtMs);
      expect(snapshot.cores).toEqual([
        { coreId: 0, coreName: "C28xx_CPU1", success: true, connected: true, state: "Running" },
        { coreId: 2, coreName: "C28xx_CPU2", success: true, connected: true, state: "Halted" }
      ]);
    }
    const reads = h.calls.filter(c => c[0] === "read");
    const cpu1Addresses = [0x5d060, 0x5d002, 0x5d200, 0x5d202, 0x5d208, 0x5d20e,
      0x5d214, 0x5d216, 0x5d222, 0x5d22e, 0x5d242];
    const flashAddresses = [0x5ce24, 0x5f0c0, 0x5f018, 0x5f098, 0x5f800, 0x5f804];
    const oneSnapshot = [...cpu1Addresses.map(address => ["read", 0, 1, address, 32]),
      ...[0, 2].flatMap(core => flashAddresses.map(address => ["read", core, 1, address, 32]))];
    expect(reads).toEqual(Array.from({ length: 5 }, () => oneSnapshot).flat());
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
      "prepare:before", "prepare:clock-ready", "prepare:after", "load:before", "load:failure"]);
    expect(result.flashLoadEvidence.snapshots[4].registers[0]).toMatchObject({
      success: false, error: "Error: " + "r".repeat(249) });
    expect(h.calls.filter(c => c[0] === "load")).toHaveLength(1);
    expect(h.context.pendingFlashLoadEvidence).toEqual({});
  });

  test("accepts the DK9 CPU2 Bank3-only mapping and keeps Bank4 on CPU1", () => {
    const h = harness();
    h.state.configuredBank = 0xC0;
    const result = h.command("prepareFlashLoad", 2, [3]);
    expect(result).toMatchObject({ status: "OK", value: { flashLoadEvidence: {
      expectedBankMuxSel: 0xC0,
      boundaryValidation: { status: "verified", actualBankMuxSel: 0xC0 }
    } } });
    expect(h.calls.filter(c => c[0] === "option")).toEqual([
      ["option", 0, "FlashMapC28Bank0", "0"],
      ["option", 2, "FlashC28Bank0", false],
      ["option", 0, "FlashMapC28Bank1", "0"],
      ["option", 2, "FlashC28Bank1", false],
      ["option", 0, "FlashMapC28Bank2", "0"],
      ["option", 2, "FlashC28Bank2", false],
      ["option", 0, "FlashMapC28Bank3", "1"],
      ["option", 2, "FlashC28Bank3", true],
      ["option", 0, "FlashMapC28Bank4", "0"],
      ["option", 2, "FlashC28Bank4", false],
      ["option", 2, "FlashEraseSelection", "Selected Banks Only"]
    ]);
  });

  test("classifies the TI locked-register erase message without calling it permanent protection", () => {
    const h = harness();
    h.command("prepareFlashLoad");
    h.state.failLoad = true;
    h.state.loadError = "Flash Programmer: Error erasing Bank 3 Flash registers are locked and hence are not configurable to issue the erase command. Operation Cancelled (3).";
    const result = h.command("load");
    expect(result).toMatchObject({ status: "FAIL", flashLoadEvidence: { failureClass: "flash_programmer_state" } });
  });

  test.each([
    ["bank mapping", 0, 0],
    ["BANKMUXSEL lock", 0x3c0, 4]
  ])("blocks a readable unsafe %s boundary before arming CPU2 load", (_label, configuredBank, configuredLock) => {
    const h = harness();
    h.state.configuredBank = configuredBank;
    h.state.configuredLock = configuredLock;
    const result = h.command("prepareFlashLoad");
    expect(result).toMatchObject({ status: "FAIL", flashLoadEvidence: { boundaryValidation: { status: "mismatch" } } });
    expect(h.context.pendingFlashLoadEvidence).toEqual({});
    expect(h.calls.filter(c => c[0] === "load")).toHaveLength(0);
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

  test("fresh preparations replace prior evidence and one load consumes at most five snapshots", () => {
    const h = harness();
    for (let i = 0; i < 10; i++) h.command("prepareFlashLoad");
    expect(h.command("load").value.flashLoadEvidence.snapshots).toHaveLength(5);
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

  test.each([0x0bad, 0x0bad0bad])("rejects suspect DSS placeholder %i only in its core view", value => {
    const h = harness();
    h.state.registerValues["2:" + 0x5f804] = value;
    const snapshot = h.command("prepareFlashLoad").value.flashLoadEvidence.snapshots[0];
    expect(snapshot.registers.find((r: any) => r.name === "FLPROT" && r.coreId === 2))
      .toMatchObject({ success: false, rawValue: value,
        error: "Suspect DSS bad-access sentinel; not usable as register evidence" });
    expect(snapshot.registers.filter((r: any) => r.success)).toHaveLength(22);
    expect(h.command("load").status).toBe("OK");
  });

  test.each([0, 2])("never reads through disconnected core %i, preserves other view", core => {
    const h = harness();
    h.state.connected[core === 0 ? 0 : 1] = false;
    const snapshot = h.command("prepareFlashLoad").value.flashLoadEvidence.snapshots[0];
    expect(h.calls.filter(c => c[0] === "read" && c[1] === core)).toHaveLength(0);
    expect(snapshot.registers.filter((r: any) => r.coreId === core)
      .every((r: any) => !r.success && r.error)).toBe(true);
    expect(snapshot.registers.filter((r: any) => r.coreId !== core)
      .every((r: any) => r.success)).toBe(true);
  });

  test("a bank configuration failure retains the completed clock boundary", () => {
    const h = harness();
    h.state.failBanks = true;
    const result = h.command("prepareFlashLoad");
    expect(result.status).toBe("FAIL");
    expect(result.message).toContain("original bank preparation failed");
    expect(result.flashLoadEvidence.snapshots.map((s: any) => s.phase)).toEqual([
      "prepare:before", "prepare:clock-ready", "prepare:failure"]);
    expect(h.context.pendingFlashLoadEvidence).toEqual({});
  });

  test("mid-preparation diagnostic exceptions cannot skip bank configuration or load", () => {
    const h = harness();
    h.context.logDiagnostic = () => { throw Error("diagnostic output failed"); };
    expect(h.command("prepareFlashLoad").status).toBe("OK");
    expect(h.command("load").status).toBe("OK");
    expect(h.calls.filter(c => c[0] === "perform")).toEqual([
      ["perform", 0, "ConfigureClock"], ["perform", 0, "ConfigureBanks"]]);
    expect(h.calls.filter(c => c[0] === "load")).toHaveLength(1);
  });

  test("the snapshot helper contains no reset, write, PC read, symbol evaluation or timeout change", () => {
    const h = harness();
    const helper = h.source.slice(h.source.indexOf("function captureFlashLoadState("),
      h.source.indexOf("function runFlashLoadWithEvidence("));
    expect(helper).not.toMatch(/writeData|\.reset\(|\.halt\(|\.run|evaluate\(|setScriptTimeout|connect\(/);
    expect(helper.match(/memory\.readData\(/g)).toHaveLength(1);
  });
});
