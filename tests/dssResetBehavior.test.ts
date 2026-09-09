import vm from "node:vm";
import { describe, expect, test, vi } from "vitest";
import { dssCommandScriptSource } from "../src/adapters/CcsScriptingBridge.js";
import { persistentServerScriptSource } from "../src/adapters/PersistentDssBridge.js";

// Execute the actual generated Rhino-compatible helper, not a second TS model.
function functionSource(source: string, name: string) {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf("\n}", start) + 2;
  if (start < 0 || end < start) throw Error(`Generated function missing: ${name}`);
  return source.slice(start, end);
}

function helper(source: string) {
  return vm.runInNewContext(`(${functionSource(source, "applyTargetReset")})`, {
    java: { lang: { Thread: { sleep: vi.fn() } } }
  });
}

function session(names = ["CPU Reset", "System Reset"], allowed = true) {
  const resets = names.map(name => ({
    getName: () => name, isAllowed: () => allowed, issueReset: vi.fn()
  }));
  return {
    resets,
    target: {
      getNumResetTypes: () => resets.length,
      getResetType: (index: number) => resets[index],
      reset: vi.fn(), restart: vi.fn(),
      isConnected: () => true, isHalted: vi.fn(() => true)
    },
    expression: { evaluate: vi.fn(() => { throw Error("GEL function absent"); }) }
  };
}

describe.each([
  ["persistent", persistentServerScriptSource], ["stateless", dssCommandScriptSource]
] as const)("%s DSS reset behavior", (_name, generate) => {
  const reset = () => helper(generate("json2.js"));

  test("system selects the named DSS reset, returns its identity, never uses GEL/default", () => {
    const s = session();
    expect(reset()(s, "system")).toMatchObject({
      requestedResetType: "system", effectiveResetType: "system",
      resetName: "System Reset", resetIndex: 1, completion: "halt-observed"
    });
    expect(s.resets[1].issueReset).toHaveBeenCalledOnce();
    expect(s.target.reset).not.toHaveBeenCalled();
    expect(s.expression.evaluate).not.toHaveBeenCalled();
  });

  test("explicit CPU reset does not silently use another default reset", () => {
    const s = session(["System Reset", "CPU Reset"]);
    expect(reset()(s, "cpu")).toMatchObject({ resetName: "CPU Reset", resetIndex: 1 });
    expect(s.resets[1].issueReset).toHaveBeenCalledOnce();
    expect(s.target.reset).not.toHaveBeenCalled();
  });

  test.each([["CPU Reset"], ["System Reset (assert only)"], ["Emulation Reset"]])(
    "missing exact system reset fails closed (%s)", name => {
      const s = session([name]);
      expect(() => reset()(s, "system")).toThrow(/unavailable/i);
      expect(s.target.reset).not.toHaveBeenCalled();
      expect(s.resets[0].issueReset).not.toHaveBeenCalled();
      expect(s.expression.evaluate).not.toHaveBeenCalled();
    });

  test("unsupported, ambiguous or currently disallowed named resets never mutate target", () => {
    for (const s of [session([], true), session(["System Reset", "System Reset"]),
      session(["System Reset"], false)]) {
      expect(() => reset()(s, "system")).toThrow();
      expect(s.target.reset).not.toHaveBeenCalled();
      expect(s.resets.every(r => r.issueReset.mock.calls.length === 0)).toBe(true);
    }
  });

  test("reset issue error propagates without trying a different reset", () => {
    const s = session();
    s.resets[1].issueReset.mockImplementation(() => { throw Error("probe fault"); });
    expect(() => reset()(s, "system")).toThrow("probe fault");
    expect(s.target.reset).not.toHaveBeenCalled();
  });

  test("restart error propagates without CPU reset fallback", () => {
    const s = session();
    s.target.restart.mockImplementation(() => { throw Error("restart failed"); });
    expect(() => reset()(s, "restart")).toThrow("restart failed");
    expect(s.target.reset).not.toHaveBeenCalled();
  });

  test("successful restart reports program restart, not a physical reset", () => {
    const s = session();
    expect(reset()(s, "restart")).toMatchObject({
      effectiveResetType: "restart", mechanism: "target.restart", completion: "halt-observed"
    });
  });

  test("asynchronous reset waits for halt, fails boundedly if it never arrives", () => {
    const s = session();
    s.target.isHalted.mockReturnValueOnce(false).mockReturnValueOnce(false);
    expect(reset()(s, "system")).toMatchObject({ completion: "halt-observed" });
    expect(s.target.isHalted).toHaveBeenCalledTimes(3);
    s.target.isHalted.mockReset().mockReturnValue(false);
    expect(() => reset()(s, "system")).toThrow(/completion/i);
    expect(s.target.isHalted.mock.calls.length).toBeLessThanOrEqual(101);
  });

  test("transient state-read failure is retried, permanent failure is not success", () => {
    const s = session();
    s.target.isHalted.mockImplementationOnce(() => { throw Error("reset in progress"); });
    expect(reset()(s, "system")).toMatchObject({ completion: "halt-observed" });
    s.target.isHalted.mockImplementation(() => { throw Error("debug link lost"); });
    expect(() => reset()(s, "system")).toThrow(/debug link lost/);
    expect(s.target.reset).not.toHaveBeenCalled();
  });

  test("default is explicit about delegating selection to CCS; unknown input fails", () => {
    const s = session();
    expect(reset()(s, "default")).toMatchObject({
      effectiveResetType: "default", mechanism: "target.reset"
    });
    expect(s.target.reset).toHaveBeenCalledOnce();
    expect(() => reset()(s, "bogus")).toThrow();
    expect(s.target.reset).toHaveBeenCalledOnce();
  });
});

describe("persistent handoff command", () => {
  function handler(cpu1: ReturnType<typeof session>, cpu2: ReturnType<typeof session>) {
    const source = persistentServerScriptSource("json2.js");
    return vm.runInNewContext([
      functionSource(source, "withCoreIdentity"),
      functionSource(source, "handleCommand"), "handleCommand"
    ].join("\n"), {
      getSessionForCommand: (command: { coreId: number }) => {
        if (command.coreId === 0) return cpu1;
        if (command.coreId === 2) return cpu2;
        throw Error("unknown core");
      }
    });
  }

  test("unloads GEL only on the selected CPU2 session and reports completion", () => {
    const cpu1 = session();
    const cpu2 = session();
    cpu2.expression.evaluate.mockImplementation(() => undefined as never);
    expect(handler(cpu1, cpu2)({ name: "prepareFirmwareHandoff", coreId: 2, coreName: "CPU2" }))
      .toMatchObject({ status: "OK", value: { coreId: 2, coreName: "CPU2", gelInitializationDisabled: true } });
    expect(cpu2.expression.evaluate).toHaveBeenCalledExactlyOnceWith("GEL_UnloadAllGels()");
    expect(cpu1.expression.evaluate).not.toHaveBeenCalled();
    expect(cpu2.target.reset).not.toHaveBeenCalled();
  });

  test("failed GEL unload propagates to the command error handler", () => {
    const cpu1 = session();
    const cpu2 = session();
    expect(() => handler(cpu1, cpu2)({ name: "prepareFirmwareHandoff", coreId: 2 })).toThrow("GEL function absent");
    expect(cpu1.expression.evaluate).not.toHaveBeenCalled();
    expect(cpu2.target.reset).not.toHaveBeenCalled();
  });
});
