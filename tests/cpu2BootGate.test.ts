import { afterEach, describe, expect, test, vi } from "vitest";
import { Cpu2BootGate, unsignedSample } from "../src/debug/Cpu2BootGate.js";
import { cpu2BootContractSchema } from "../src/jobs/TestPlanSchema.js";
import type { EvaluateResult } from "../src/debug/types.js";

const contract = cpu2BootContractSchema.parse({ abiExpression: "c2.abi", abiVersion: 48,
  roleExpression: "c2.role", roleValue: 2, epochExpression: "c2.epoch", statusExpression: "c2.status",
  appInitMask: 32, logicAliveExpression: "c2.logic", timeoutMs: 100, intervalMs: 20 });
const mirrors = ["blocked", "relay", "fan"].map(expression => ({ coreId: 2, expression, expected: 0 }));
afterEach(() => vi.useRealTimers());

async function fixture() {
  vi.useFakeTimers();
  const state: Record<string, string> = { "c2.abi": "48", "c2.role": "2", "c2.epoch": "7",
    "c2.status": "32", "c2.logic": "0", blocked: "0", relay: "0", fan: "0" };
  let advancing = true;
  const read = vi.fn(async (_core: number, expressions: string[]): Promise<EvaluateResult[]> =>
    expressions.map(expression => {
      if (expression === "c2.logic" && advancing) state[expression] = String((Number(state[expression]) + 1) >>> 0);
      return state[expression] === "unavailable"
        ? { expression, success: false, error: { code: "DssCommandFailed", message: "target unavailable" } }
        : { expression, success: true, value: state[expression] };
    }));
  const gate = new Cpu2BootGate(contract, read, mirrors);
  await gate.captureBaseline();
  state["c2.epoch"] = "8";
  const checkCpu1 = vi.fn(async () => undefined);
  const connect = vi.fn(async () => undefined);
  const wait = () => gate.waitAndArm(checkCpu1, connect);
  return { gate, read, state, checkCpu1, connect, wait, stopLogic: () => { advancing = false; } };
}

describe("CPU2 two-phase observation gate (host-only)", () => {
  test.each(["0x0BAD", "2989", "", "NaN", "true", "-1", "2"])("boolean sample %s is not valid state", value => {
    expect(unsignedSample({ expression: "bool", success: true, value }, 1).status).toBe("INVALID_VALUE");
  });
  test("0x0BAD is not globally blacklisted as a legitimate uint32 counter", () => {
    expect(unsignedSample({ expression: "epoch", success: true, value: "0x0BAD" })).toMatchObject({ status: "OK", value: 2989 });
  });
  test("fresh epoch + init + changing LogicAlive precede CPU2 reads and arm", async () => {
    const f = await fixture();
    const pending = f.wait();
    await vi.runAllTimersAsync();
    await pending;
    expect(f.gate.evidence).toMatchObject({ guardState: "ARMED", bootEpoch: 8, pollCount: 2 });
    expect(f.checkCpu1).toHaveBeenCalledTimes(2);
    expect(f.connect).toHaveBeenCalledTimes(1);
    expect(f.read.mock.calls.filter(call => call[0] === 2)).toHaveLength(1);
  });
  test.each([
    ["c2.abi", "unavailable", "Cpu2ReadUnavailable"],
    ["c2.abi", "0", "Cpu2NotReady"],
    ["c2.role", "1", "Cpu2NotReady"],
    ["c2.epoch", "7", "Cpu2BootEpochStale"],
    ["c2.status", "0", "Cpu2AppNotReady"],
    ["blocked", "0x0BAD", "SafetyMirrorNotReady"],
    ["relay", "unavailable", "Cpu2ReadUnavailable"]
  ])("%s=%s times out as %s, never a safety violation", async (expression, value, classification) => {
    const f = await fixture();
    f.state[expression] = value;
    const checked = expect(f.wait()).rejects.toMatchObject({ code: "Cpu2BootContractTimeout", details: {
      classification, ipcReadySkipped: true, cpu2BootGate: { guardState: "DISARMED" }
    } });
    await vi.runAllTimersAsync();
    await checked;
    if (expression.startsWith("c2.")) expect(f.connect).not.toHaveBeenCalled();
  });
  test("APP_INIT_OK alone does not prove an executed application cycle", async () => {
    const f = await fixture(); f.stopLogic();
    const checked = expect(f.wait()).rejects.toMatchObject({ code: "Cpu2BootContractTimeout",
      details: { classification: "Cpu2LogicNotAlive" } });
    await vi.runAllTimersAsync(); await checked;
    expect(f.connect).not.toHaveBeenCalled();
  });
  test("transient invalid mirror remains disarmed, then arms on a valid sample", async () => {
    const f = await fixture(); f.state.blocked = "0x0BAD";
    setTimeout(() => { f.state.blocked = "0"; }, 45);
    const pending = f.wait(); await vi.runAllTimersAsync(); await pending;
    expect(f.gate.evidence.transitions.some(sample => sample.reason === "SafetyMirrorNotReady")).toBe(true);
    expect(f.gate.evidence.guardState).toBe("ARMED");
  });
  test("valid unsafe mirror immediately violates predicates", async () => {
    const f = await fixture(); f.state.fan = "1";
    const checked = expect(f.wait()).rejects.toMatchObject({ code: "SafetyGuardViolation" });
    await vi.runAllTimersAsync(); await checked;
    expect(f.gate.evidence.guardState).toBe("ARMED");
  });
  test("a blocked indication may be a valid observation without being an unsafe-output predicate", async () => {
    const f = await fixture(); f.state.blocked = "1";
    f.state["c2.epoch"] = "7";
    const gate = new Cpu2BootGate({ ...contract, mirrorBooleanExpressions: ["blocked"] }, f.read,
      mirrors.filter(condition => condition.expression !== "blocked"));
    await gate.captureBaseline(); f.state["c2.epoch"] = "8";
    const pending = gate.waitAndArm(f.checkCpu1, f.connect); await vi.runAllTimersAsync(); await pending;
    await expect(gate.verifyRuntime()).resolves.toBeUndefined();
    f.state.blocked = "0x0BAD";
    await expect(gate.verifyRuntime()).rejects.toMatchObject({ code: "SafetyGuardViolation" });
  });
  test("epoch changes during mirror capture never arm a mixed-boot sample", async () => {
    const f = await fixture();
    f.read.mockImplementation(async (core, expressions) => {
      if (core === 2) f.state["c2.epoch"] = String(Number(f.state["c2.epoch"]) + 1);
      return expressions.map(expression => {
        if (expression === "c2.logic") f.state[expression] = String(Number(f.state[expression]) + 1);
        return { expression, success: true, value: f.state[expression] };
      });
    });
    const checked = expect(f.wait()).rejects.toMatchObject({ code: "Cpu2BootContractTimeout" });
    await vi.runAllTimersAsync(); await checked;
    expect(f.gate.evidence.guardState).toBe("DISARMED");
  });
  test.each([["fan", "0x0BAD"], ["relay", "unavailable"], ["c2.epoch", "9"], ["c2.status", "0"]])(
    "armed %s=%s is a runtime integrity failure, not another startup wait", async (key, value) => {
      const f = await fixture(); const pending = f.wait(); await vi.runAllTimersAsync(); await pending;
      f.state[key] = value;
      await expect(f.gate.verifyRuntime()).rejects.toMatchObject({ code: "SafetyGuardViolation",
        details: { classification: "RuntimeSafetyIntegrityFailure" } });
      expect(f.gate.evidence.guardState).toBe("ARMED");
    });
  test("missing baseline stops before startup, never substitutes a post-reset epoch", async () => {
    const gate = new Cpu2BootGate(contract, async () => [], mirrors);
    await expect(gate.captureBaseline()).rejects.toMatchObject({ code: "Cpu2ReadUnavailable",
      details: { targetResetAttempted: false } });
  });
  test("lease failure is terminal and is not classified as NOT_READY", async () => {
    const gate = new Cpu2BootGate(contract, async () => [{ expression: "c2.epoch", success: false,
      error: { code: "LeaseFencingRejected", message: "stale" } }], mirrors);
    await expect(gate.captureBaseline()).rejects.toMatchObject({ code: "LeaseFencingRejected" });
  });
  test("read-only syntax and finite polling are enforced", () => {
    for (const delta of [{ epochExpression: "reset()" }, { intervalMs: 0 }, { timeoutMs: 30001 },
      { roleValue: 1 }, { appInitMask: 0 }, { abiExpression: "c2.epoch" }]) {
      expect(cpu2BootContractSchema.safeParse({ ...contract, ...delta }).success).toBe(false);
    }
  });
});
