import { runInNewContext } from "node:vm";
import { describe, expect, test } from "vitest";
import { persistentServerScriptSource } from "../src/adapters/PersistentDssBridge.js";

// Execute the actual generated command handlers, not a reimplementation of them.
function harness() {
  const source = persistentServerScriptSource("C:/ti/json2.js");
  const calls: unknown[][] = [];
  const state = { bank: 0, lock: 0, clock: 0, connected: [true, true], halted: [true, true],
    failReads: false, failStates: false, failLoad: false, failPrepare: false, failBanks: false,
    configuredBank: 0x3c0, configuredLock: 0,
    loadError: "original Bank 3 erase failed",
    registerValues: {} as Record<string, number>,
    coreSelections: { 0: "CPU1", 2: "CPU2" } as Record<number, string>,
    selectionFault: "" as "" | "read" | "write" | "readback" };
  const sessions = Object.fromEntries([0, 2].map((id, index) => [id, {
    target: {
      isConnected() {
        calls.push(["connected", id]);
        if (state.failStates) throw Error("state unavailable");
        return state.connected[index];
      },
      isHalted() { calls.push(["halted", id]); return state.halted[index]; }
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
        getString(name: string) {
          calls.push(["get-option", id, name]);
          if (state.selectionFault === "read") throw Error("selection read unavailable");
          return state.coreSelections[id];
        },
        setString(name: string, value: string) {
          calls.push(["option", id, name, value]);
          if (name === "FlashCoreSelection") {
            if (state.selectionFault === "write") throw Error("selection write unavailable");
            if (state.selectionFault !== "readback") state.coreSelections[id] = value;
          }
        },
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
  const rawHandle = runInNewContext(source.slice(source.indexOf("function getSessionForCommand("),
    source.indexOf("function startCoreThread(")) + "\nhandleCommand;", context);
  // Mirror the socket loop: a handler exception becomes a bounded FAIL response
  // instead of escaping as a raw script error.
  const handle = (command: Record<string, unknown>) => {
    try {
      return rawHandle(command);
    } catch (ex) {
      return { status: "FAIL", message: String(ex).slice(0, 2048) };
    }
  };
  const command = (name: string, coreId = 2, flashBanks = [3, 4], extra: Record<string, unknown> = {}) =>
    handle({ name, coreId, coreName: coreId === 2 ? "C28xx_CPU2" : "C28xx_CPU1",
      program: "cpu2.out", flashBanks, ...extra });
  // The owner core executes the preparation; the target core receives the
  // prepared bank mapping. The command is delivered over the owner's socket.
  const prepare = (flashBanks = [3, 4], extra: Record<string, unknown> = {}) =>
    command("prepareFlashLoad", 0, flashBanks, { targetCoreId: 2, ...extra });
  return { command, prepare, calls, state, context, source };
}

describe("F28P65x Flash load state evidence", () => {
  test("binds the Flash plugin core independently of the DebugSession", () => {
    const h = harness();
    h.state.coreSelections = { 0: "CPU2", 2: "CPU1" };
    const result = h.prepare();
    expect(result.status).toBe("OK");
    expect(result.value.flashLoadEvidence.loaderCoreSelection).toEqual([
      { coreId: 0, coreName: "C28xx_CPU1", option: "FlashCoreSelection",
        before: "CPU2", expected: "CPU1", after: "CPU1", changed: true, verified: true },
      { coreId: 2, coreName: "C28xx_CPU2", option: "FlashCoreSelection",
        before: "CPU1", expected: "CPU2", after: "CPU2", changed: true, verified: true }
    ]);
    expect(h.calls.filter(c => c[0] === "option" && c[2] === "FlashCoreSelection")).toEqual([
      ["option", 0, "FlashCoreSelection", "CPU1"], ["option", 2, "FlashCoreSelection", "CPU2"]
    ]);
    expect(h.calls.findIndex(c => c[0] === "perform")).toBeGreaterThan(
      h.calls.findLastIndex(c => c[0] === "get-option"));
  });

  test("records already-correct plugin core selections without rewriting them", () => {
    const h = harness();
    const result = h.prepare();
    expect(result.value.flashLoadEvidence.loaderCoreSelection).toEqual([
      expect.objectContaining({ coreId: 0, before: "CPU1", after: "CPU1", changed: false, verified: true }),
      expect.objectContaining({ coreId: 2, before: "CPU2", after: "CPU2", changed: false, verified: true })
    ]);
    expect(h.calls.filter(c => c[0] === "option" && c[2] === "FlashCoreSelection")).toEqual([]);
  });

  test.each(["read", "write", "readback"] as const)("plugin selection %s failure stops preparation", fault => {
    const h = harness();
    h.state.coreSelections[0] = "CPU2";
    h.state.selectionFault = fault;
    const result = h.prepare();
    expect(result.status).toBe("FAIL");
    expect(result.flashLoadEvidence.loaderCoreSelection[0]).toMatchObject({ coreId: 0, verified: false });
    expect(result.flashLoadEvidence.loaderCoreSelection[0].error).toBeTruthy();
    expect(h.context.pendingFlashLoadEvidence).toEqual({});
    expect(h.calls.filter(c => c[0] === "perform" || c[0] === "load")).toEqual([]);
  });

  test("records both cores and actual mapping before/after preparation and load", () => {
    const h = harness();
    expect(h.prepare().status).toBe("OK");
    const result = h.command("load");
    expect(result).toMatchObject({ status: "OK", value: { coreId: 2, coreName: "C28xx_CPU2",
      flashLoadEvidence: { readOnly: true, atomic: false, requestedFlashBanks: [3, 4],
        ownerCoreId: 0, targetCoreId: 2 } } });
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
        { coreId: 0, coreName: "C28xx_CPU1", success: true, connected: true, state: "Halted" },
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

  test("executes the Flash Plugin on the owner core and keeps the mapping on the target", () => {
    const h = harness();
    h.state.configuredBank = 0xC0;
    expect(h.prepare([3]).status).toBe("OK");

    const performCores = h.calls.filter(c => c[0] === "perform").map(c => c[1]);
    const mapOptionCores = h.calls.filter(c => c[0] === "option" && String(c[2]).startsWith("FlashMapC28Bank")).map(c => c[1]);
    const targetOptionCores = h.calls.filter(c => c[0] === "option" &&
      (String(c[2]).startsWith("FlashC28Bank") || c[2] === "FlashEraseSelection")).map(c => c[1]);
    expect(new Set(performCores)).toEqual(new Set([0]));
    expect(new Set(mapOptionCores)).toEqual(new Set([0]));
    expect(new Set(targetOptionCores)).toEqual(new Set([2]));
  });

  test("rejects a preparation whose owner core is running instead of halting it implicitly", () => {
    const h = harness();
    h.state.halted = [false, true];

    const result = h.prepare();
    expect(result.status).toBe("FAIL");
    expect(result.message).toContain("requires owner core 0 to be connected and halted");
    expect(result.message).toContain("\"state\":\"Running\"");
    expect(h.calls.filter(c => c[0] === "perform")).toHaveLength(0);
    expect(h.calls.filter(c => c[0] === "option")).toHaveLength(0);
    expect(h.context.pendingFlashLoadEvidence).toEqual({});
  });

  test("rejects a preparation whose owner state cannot be read", () => {
    const h = harness();
    h.state.failStates = true;

    const result = h.prepare();
    expect(result.status).toBe("FAIL");
    expect(result.message).toContain("requires owner core 0 to be connected and halted");
    expect(h.calls.filter(c => c[0] === "perform")).toHaveLength(0);
  });

  test("rejects a preparation without an explicit distinct target core", () => {
    const h = harness();
    const sameCore = h.command("prepareFlashLoad", 2, [3]);
    expect(sameCore.status).toBe("FAIL");
    expect(sameCore.message).toContain("requires an explicit targetCoreId");
    const missingTarget = h.command("prepareFlashLoad", 0, [3]);
    expect(missingTarget.status).toBe("FAIL");
    expect(missingTarget.message).toContain("requires an explicit targetCoreId");
    expect(h.calls.filter(c => c[0] === "perform")).toHaveLength(0);
  });

  test("arms the target core's next load, not the owner's", () => {
    const h = harness();
    expect(h.prepare().status).toBe("OK");

    // The owner core's own load must not consume the CPU2 preparation.
    const ownerLoad = h.command("load", 0);
    expect(ownerLoad.value).not.toHaveProperty("flashLoadEvidence");
    const targetLoad = h.command("load", 2);
    expect(targetLoad.value.flashLoadEvidence).toMatchObject({ requestedFlashBanks: [3, 4] });
    expect(h.context.pendingFlashLoadEvidence).toEqual({});
  });

  test("retains original load failure and its snapshots without a load retry", () => {
    const h = harness();
    h.prepare();
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
    const result = h.prepare([3]);
    expect(result).toMatchObject({ status: "OK", value: { targetCoreId: 2, flashLoadEvidence: {
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
    h.prepare();
    h.state.failLoad = true;
    h.state.loadError = "Flash Programmer: Error erasing Bank 3 Flash registers are locked and hence are not configurable to issue the erase command. Operation Cancelled (3).";
    const result = h.command("load");
    expect(result).toMatchObject({ status: "FAIL", flashLoadEvidence: { failureClass: "flash_programmer_state" } });
  });

  test("labels a DSS deadline as a Flash operation timeout, not a bank failure", () => {
    const h = harness();
    h.prepare();
    h.state.failLoad = true;
    h.state.loadError = "Script timeout exceeded while programming Bank 3";
    const result = h.command("load");
    expect(result).toMatchObject({ status: "FAIL", flashLoadEvidence: { failureClass: "flash_operation_timeout" } });
  });

  test.each([
    ["bank mapping", 0, 0],
    ["BANKMUXSEL lock", 0x3c0, 4]
  ])("blocks a readable unsafe %s boundary before arming CPU2 load", (_label, configuredBank, configuredLock) => {
    const h = harness();
    h.state.configuredBank = configuredBank;
    h.state.configuredLock = configuredLock;
    const result = h.prepare();
    expect(result).toMatchObject({ status: "FAIL", flashLoadEvidence: { boundaryValidation: { status: "mismatch" } } });
    expect(h.context.pendingFlashLoadEvidence).toEqual({});
    expect(h.calls.filter(c => c[0] === "load")).toHaveLength(0);
  });

  test("records a preparation failure but does not arm stale evidence for another load", () => {
    const h = harness();
    h.state.failPrepare = true;
    const result = h.prepare();
    expect(result.status).toBe("FAIL");
    expect(result.message).toContain("original preparation failed");
    expect(result.flashLoadEvidence.snapshots.map((s: any) => s.phase)).toEqual([
      "prepare:before", "prepare:failure"]);
    expect(h.context.pendingFlashLoadEvidence).toEqual({});
    expect(h.calls.filter(c => c[0] === "load")).toHaveLength(0);
  });

  test("register read failures cannot turn a successful load into failure", () => {
    const h = harness();
    h.state.failReads = true;
    expect(h.prepare().status).toBe("OK");
    const result = h.command("load");
    expect(result.status).toBe("OK");
    expect(result.value.flashLoadEvidence.snapshots.every((s: any) =>
      s.registers.every((r: any) => r.success === false))).toBe(true);
  });

  test("never queries halted state or memory through a disconnected target core", () => {
    const h = harness();
    h.state.connected = [true, false];
    expect(h.prepare().status).toBe("OK");
    const snapshots = h.command("load").value.flashLoadEvidence.snapshots;
    expect(snapshots[0].cores.map((c: any) => c.state)).toEqual(["Halted", "Disconnected"]);
    expect(h.calls.filter(c => (c[0] === "halted" || c[0] === "read") && c[1] === 2)).toHaveLength(0);
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
    for (let i = 0; i < 10; i++) h.prepare();
    expect(h.command("load").value.flashLoadEvidence.snapshots).toHaveLength(5);
    h.calls.length = 0;
    expect(h.command("load").value).not.toHaveProperty("flashLoadEvidence");
    expect(h.calls).toEqual([["load", 2, "cpu2.out"]]);
  });

  test("a second CPU2 load requires a fresh preparation", () => {
    const h = harness();
    expect(h.prepare().status).toBe("OK");
    expect(h.command("load").value).toHaveProperty("flashLoadEvidence");
    h.calls.length = 0;
    expect(h.command("load").value).not.toHaveProperty("flashLoadEvidence");
    expect(h.calls).toEqual([["load", 2, "cpu2.out"]]);

    expect(h.prepare().status).toBe("OK");
    expect(h.command("load").value).toHaveProperty("flashLoadEvidence");
  });

  test("invalid register values are missing evidence, never a plausible zero", () => {
    const h = harness();
    h.state.bank = NaN;
    const snapshot = h.prepare().value.flashLoadEvidence.snapshots[0];
    expect(snapshot.registers[0]).toMatchObject({ success: false });
    expect(snapshot.registers[0]).not.toHaveProperty("value");
  });

  test.each([0x0bad, 0x0bad0bad])("rejects suspect DSS placeholder %i only in its core view", value => {
    const h = harness();
    h.state.registerValues["2:" + 0x5f804] = value;
    const snapshot = h.prepare().value.flashLoadEvidence.snapshots[0];
    expect(snapshot.registers.find((r: any) => r.name === "FLPROT" && r.coreId === 2))
      .toMatchObject({ success: false, rawValue: value,
        error: "Suspect DSS bad-access sentinel; not usable as register evidence" });
    expect(snapshot.registers.filter((r: any) => r.success)).toHaveLength(22);
    expect(h.command("load").status).toBe("OK");
  });

  test("never reads through a disconnected target core view, preserves the owner view", () => {
    const h = harness();
    h.state.connected[1] = false;
    const snapshot = h.prepare().value.flashLoadEvidence.snapshots[0];
    expect(h.calls.filter(c => c[0] === "read" && c[1] === 2)).toHaveLength(0);
    expect(snapshot.registers.filter((r: any) => r.coreId === 2)
      .every((r: any) => !r.success && r.error)).toBe(true);
    expect(snapshot.registers.filter((r: any) => r.coreId !== 2)
      .every((r: any) => r.success)).toBe(true);
  });

  test("a bank configuration failure retains the completed clock boundary", () => {
    const h = harness();
    h.state.failBanks = true;
    const result = h.prepare();
    expect(result.status).toBe("FAIL");
    expect(result.message).toContain("original bank preparation failed");
    expect(result.flashLoadEvidence.snapshots.map((s: any) => s.phase)).toEqual([
      "prepare:before", "prepare:clock-ready", "prepare:failure"]);
    expect(h.context.pendingFlashLoadEvidence).toEqual({});
  });

  test("mid-preparation diagnostic exceptions cannot skip bank configuration or load", () => {
    const h = harness();
    h.context.logDiagnostic = () => { throw Error("diagnostic output failed"); };
    expect(h.prepare().status).toBe("OK");
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

  test("the owner precondition helper never starts, halts or writes to the target", () => {
    const h = harness();
    const helper = h.source.slice(h.source.indexOf("function readCoreRunState("),
      h.source.indexOf("function handleCommand("));
    expect(helper).not.toMatch(/\.halt\(|\.run|assig|writeData|loadProgram|performOperation/);
  });
});
