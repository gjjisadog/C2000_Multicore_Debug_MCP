import type { Cpu2BootContract } from "../jobs/TestPlanSchema.js";
import type { CoreId, EvaluateResult } from "./types.js";
import { DebugMcpError, type DebugErrorCode } from "../utils/errors.js";
import { sleep } from "../utils/async.js";

type Condition = { coreId: number; expression: string; expected: unknown };
type Read = (coreId: CoreId, expressions: string[]) => Promise<EvaluateResult[]>;
type Sample = Record<string, unknown>;

/** Never reinterpret an in-band number as a boolean. Preserve raw transport evidence. */
export function unsignedSample(result: EvaluateResult | undefined, maximum = 0xffffffff) {
  if (!result?.success) return { status: "TARGET_UNAVAILABLE" as const, raw: result };
  const text = String(result.value ?? "").trim();
  const value = /^(?:0[xX][\da-fA-F]+|\d+)$/.test(text) ? Number(text) : NaN;
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum
    ? { status: "OK" as const, value, raw: result }
    : { status: "INVALID_VALUE" as const, raw: result };
}

// Ownership failures are never converted into retryable target-read samples.
export function assertReadOwnership(results: EvaluateResult[]) {
  const failed = results.find(result => result.error
    && /lease|fenc|worker|session|cancel|abort|permission|policy/i.test(result.error.code));
  if (failed?.error) throw new DebugMcpError(failed.error.code as DebugErrorCode, failed.error.message, failed.error.details);
}

/** Per-workflow observation gate, not a second job engine or a target boot protocol. */
export class Cpu2BootGate {
  readonly evidence: {
    guardState: "DISARMED" | "ARMED";
    baseline?: unknown;
    bootEpoch?: number;
    pollCount: number;
    firstNotReady?: Sample;
    lastSample?: Sample;
    transitions: Sample[];
  } = { guardState: "DISARMED", pollCount: 0, transitions: [] };
  private baselineEpoch?: number;
  private observedEpoch?: number;
  private firstLogic?: number;
  private committed = false;
  private phase = "WAIT_CPU2_PRESENT";
  private readonly mirrorExpressions: string[];

  constructor(private readonly contract: Cpu2BootContract, private readonly read: Read,
    private readonly mirrors: Condition[]) {
    this.mirrorExpressions = [...new Set([...mirrors.map(condition => condition.expression),
      ...contract.mirrorBooleanExpressions])];
  }

  async captureBaseline(): Promise<void> {
    const results = await this.read(0, [this.contract.epochExpression]);
    assertReadOwnership(results);
    const baseline = unsignedSample(results.find(result => result.expression === this.contract.epochExpression));
    this.evidence.baseline = baseline;
    if (baseline.status !== "OK") {
      throw new DebugMcpError("Cpu2ReadUnavailable", "Cannot prove a new CPU2 boot epoch without a pre-reset baseline", {
        cpu2BootGate: this.evidence, targetResetAttempted: false, ipcReadySkipped: true
      });
    }
    this.baselineEpoch = baseline.value;
  }

  private record(reason: string, sample: Sample): void {
    const item = { phase: this.phase, reason, at: new Date().toISOString(), ...sample };
    this.evidence.lastSample = item;
    this.evidence.firstNotReady ??= item;
    if (this.evidence.transitions.at(-1)?.reason !== reason && this.evidence.transitions.length < 32) {
      this.evidence.transitions.push(item);
    }
  }

  private async coreState() {
    const c = this.contract;
    const expressions = [c.abiExpression, c.roleExpression, c.epochExpression,
      c.statusExpression, c.logicAliveExpression];
    const results = await this.read(0, expressions);
    assertReadOwnership(results);
    const closing = await this.read(0, [c.abiExpression, c.epochExpression]);
    assertReadOwnership(closing);
    const values = expressions.map(expression => unsignedSample(results.find(r => r.expression === expression)));
    const endAbi = unsignedSample(closing.find(r => r.expression === c.abiExpression));
    const endEpoch = unsignedSample(closing.find(r => r.expression === c.epochExpression));
    const [abi, role, epoch, status, logic] = values;
    const sample = { results, closing };
    if (values.some(value => value.status !== "OK") || endAbi.status !== "OK" || endEpoch.status !== "OK") {
      return { reason: "Cpu2ReadUnavailable", sample };
    }
    if (abi!.value !== c.abiVersion || role!.value !== c.roleValue || endAbi.value !== abi!.value
      || endEpoch.value !== epoch!.value) return { reason: "Cpu2NotReady", sample };
    if (!epoch!.value || epoch!.value === this.baselineEpoch) return { reason: "Cpu2BootEpochStale", sample };
    if (((status!.value! & c.appInitMask) >>> 0) !== c.appInitMask) {
      return { reason: "Cpu2AppNotReady", sample };
    }
    return { epoch: epoch!.value!, logic: logic!.value!, sample };
  }

  async waitAndArm(checkCpu1: () => Promise<unknown>, connectCpu2: () => Promise<unknown>): Promise<void> {
    if (this.baselineEpoch === undefined) throw new DebugMcpError("StartupContractInvalid", "Missing pre-reset epoch baseline");
    const deadline = performance.now() + this.contract.timeoutMs;
    let connected = false;
    do {
      this.evidence.pollCount++;
      await checkCpu1(); // CPU1 power invariants are never disarmed.
      const state = await this.coreState();
      let reason = state.reason;
      let sample: Sample = state.sample;
      if (!reason) {
        this.phase = "WAIT_LOGIC_ALIVE";
        if (state.epoch !== this.observedEpoch) {
          this.observedEpoch = state.epoch;
          this.firstLogic = state.logic;
          this.committed = false;
        }
        const delta = (state.logic! - this.firstLogic!) >>> 0;
        this.committed ||= delta > 0 && delta < 0x80000000;
        if (!this.committed) reason = "Cpu2LogicNotAlive";
        else {
          this.phase = "WAIT_SAFETY_MIRROR";
          // Do not disturb CPU2 while CPU1's MsgRAM view still reports boot/reset.
          if (!connected) { await connectCpu2(); connected = true; }
          const results = await this.read(2, this.mirrorExpressions);
          assertReadOwnership(results);
          const values = this.mirrorExpressions.map(expression => unsignedSample(results.find(r => r.expression === expression), 1));
          const closing = await this.coreState();
          sample = { ...sample, mirrors: values, closing: closing.sample };
          if (closing.reason || closing.epoch !== state.epoch) {
            reason = closing.reason ?? "Cpu2BootEpochStale";
            this.committed = false;
            this.firstLogic = undefined;
            this.observedEpoch = undefined;
          } else if (values.some(value => value.status === "TARGET_UNAVAILABLE")) reason = "Cpu2ReadUnavailable";
          else if (values.some(value => value.status !== "OK")) reason = "SafetyMirrorNotReady";
          else {
            this.evidence.guardState = "ARMED";
            this.evidence.bootEpoch = state.epoch;
            this.phase = "SAFETY_GUARD_ARMED";
            this.record("SafetyMirrorValid", sample);
            this.assertMirrorPredicates(values);
            return;
          }
        }
      } else {
        this.phase = reason === "Cpu2AppNotReady" ? "WAIT_APP_INIT_OK"
          : reason === "Cpu2BootEpochStale" ? "WAIT_NEW_BOOT_EPOCH" : "WAIT_CPU2_PRESENT";
        this.observedEpoch = undefined;
        this.firstLogic = undefined;
        this.committed = false;
      }
      this.record(reason!, sample);
      const remaining = deadline - performance.now();
      if (remaining <= 0) break;
      await sleep(Math.min(this.contract.intervalMs, remaining));
    } while (performance.now() < deadline);
    throw new DebugMcpError("Cpu2BootContractTimeout", "CPU2 application/safety publication did not become valid before the bounded startup deadline", {
      cpu2BootGate: this.evidence, classification: this.evidence.lastSample?.reason, ipcReadySkipped: true
    });
  }

  private assertMirrorPredicates(values: ReturnType<typeof unsignedSample>[]) {
    if (this.mirrors.some(condition => {
      const value = values[this.mirrorExpressions.indexOf(condition.expression)]!;
      return value.status !== "OK" || value.value !== condition.expected;
    })) {
      throw new DebugMcpError("SafetyGuardViolation", "A valid CPU2 safety mirror violates its declared predicate", {
        cpu2BootGate: this.evidence, mirrors: values
      });
    }
  }

  async verifyRuntime(): Promise<void> {
    const state = await this.coreState();
    if (this.evidence.guardState !== "ARMED" || state.reason || state.epoch !== this.evidence.bootEpoch) {
      throw new DebugMcpError("SafetyGuardViolation", "Armed CPU2 CoreState lost read/boot integrity", {
        classification: "RuntimeSafetyIntegrityFailure", cpu2BootGate: this.evidence, state
      });
    }
    const results = await this.read(2, this.mirrorExpressions);
    assertReadOwnership(results);
    const values = this.mirrorExpressions.map(expression => unsignedSample(results.find(r => r.expression === expression), 1));
    const closing = await this.coreState();
    if (closing.reason || closing.epoch !== state.epoch
      || values.some(value => value.status !== "OK")) {
      throw new DebugMcpError("SafetyGuardViolation", "Armed CPU2 guard lost read/boot integrity; re-arming is forbidden in this workflow", {
        classification: "RuntimeSafetyIntegrityFailure", cpu2BootGate: this.evidence,
        state, closing, mirrors: values
      });
    }
    this.assertMirrorPredicates(values);
  }
}
