# CPU2 boot / safety observation contract

This opt-in contract addresses a startup observation race, not a proven CPU2
firmware boot fix. It does not repair a Flash loader failure. Hardware regression
remains required. Runtime contracts: RPC 1, durable plan 6, IPC workflow 10.

Use a single durable board flow: exact-pair `launchMulticore` immediately followed
by symbols-only `runIpcAcceptance`, `verify-mcp-registry`, all four artifact hashes,
explicit F28P65x cores 0/2 and `cpu1_boots_cpu2`. No second CPU2 run authority.
Existing callers without this opt-in keep their guard semantics unchanged.

Configure `systemResetBeforeHandoff.cpu2BootContract` from the exact firmware:

```json
{
  "abiExpression": "g_stCoreCommC2State.ulAbiVersion",
  "abiVersion": 48,
  "roleExpression": "g_stCoreCommC2State.uiCoreRole",
  "roleValue": 2,
  "epochExpression": "g_stCoreCommC2State.ulBootEpoch",
  "statusExpression": "g_stCoreCommC2State.ulStatus",
  "appInitMask": 32,
  "logicAliveExpression": "g_stCoreCommC2State.ulLogicAliveSeq",
  "mirrorBooleanExpressions": [
    "g_stCpu2Dk9MilWatch.uiHardSafetyBlocked",
    "g_stCpu2Dk9MilWatch.uiRelayPhysicalOutputAvailable",
    "g_stCpu2Dk9MilWatch.uiFanPhysicalOutputAvailable"
  ],
  "timeoutMs": 3000,
  "intervalMs": 100
}
```

CoreState reads use CPU1's view of CPU2-owned MsgRAM. Capture the epoch under the
same session before System Reset; a missing baseline is a stop, not permission to
adopt a later epoch. After CPU1 application entry, poll ABI/role, a nonzero epoch
different from baseline, APP_INIT_OK, and a forward LogicAlive change within that
epoch. Bracket the read with ABI/epoch checks. A new epoch or invalid AppInit resets
the LogicAlive baseline. Counter wrap is supported; backward deltas do not qualify.
Only then reconnect CPU2 once and read its boolean mirrors. Bracket the mirror read
with another CoreState check to reject samples spanning a reset.

CPU1 guard predicates stay active. CPU2 guard predicates alone are deferred after
pair loading and during this startup gate. Valid numeric booleans arm the guard,
then their declared predicates are evaluated; a valid predicate violation fails
immediately. `mirrorBooleanExpressions` adds value-domain checks, not equality
predicates. For example HardSafetyBlocked=1 may be an expected protective state,
whereas Relay/Fan physical output availability can still be required to equal 0.
SamplingArmed=1 means the sampling timebase started, not that PWM outputs were
unlocked. Do not use sampling activity as a universal no-power predicate.

| Evidence before arming | Classification |
| --- | --- |
| Failed target read | Cpu2ReadUnavailable |
| Missing/mismatched ABI or role | Cpu2NotReady |
| Zero/old epoch | Cpu2BootEpochStale |
| AppInit bit missing | Cpu2AppNotReady |
| No committed LogicAlive advance | Cpu2LogicNotAlive |
| Invalid boolean, including 0x0BAD | SafetyMirrorNotReady |

These states expire as Cpu2BootContractTimeout, not SafetyGuardViolation. Preserve
raw EvaluateResult status/error/value. 0x0BAD is NOT globally replaced or assumed
to be an MCP-generated sentinel; it could be a valid uint32 counter. The existing
transport already exposes a success/error result. Only successfully decoded
domain-valid values participate in predicates.

After arming, check CoreState/epoch and mirror integrity before and after IPC polls
and again after successful follow-up diagnosis. Later durable steps retain the
original CPU1/CPU2 predicates and the extra mirror boolean-domain checks. A loss
of readability never silently disarms or starts another wait. Lease/fencing,
worker/session and ownership errors are terminal, not startup samples.

On failure, preserve the first boundary and attempt a fenced halt. Capture the
requested read-only CPU1 boot observations after CPU1 halt is confirmed. CPU2 may
still be disconnected: retain unconfirmed CPU2 isolation and quarantine through
the durable engine; do not reconnect it just to claim a successful halt. Cleanup
must still run. No Trip/OST clear, PWM arm, relay enable or Flash unlock is added.

Polling has a <=30 s observation deadline and <=300 scheduled polls. Individual
CCS commands remain subject to existing adapter command timeout/queue behavior;
this is not a real-time host wall-clock guarantee. Evidence retains first/last and
at most 32 transitions. The gate does not provide an atomic multi-field safety
snapshot. Target mirror Valid/Seq/Epoch publication is a possible later extension,
not silently assumed for existing images.

Hybrid30K already publishes DK9 LogicShadow before LogicAlive. Preserve that order
and test it. The companion firmware edit initializes HardSafetyBlocked to 1 before
publishing watch magic, without changing shared ABI or adding a parallel boot
protocol. New source defaults do not apply to previously built images.

## Required regression evidence

Host tests cover stale epoch, ABI/role, AppInit without scheduler progress,
unavailable/invalid mirrors, mixed-epoch capture, predicate failure, post-arm read
loss, fencing, guard ordering, durable forwarding and unchanged legacy paths.
Host/Mock PASS is not target evidence. Require the new proxy and daemon contracts
to match before submitting a candidate plan; never send it through an old schema.

Hardware order: preflight / one lease -> pair load -> boot contract -> guard armed
-> explicit IPC readiness -> bounded validation fault/measurement campaign -> halt
and cleanup. FaultTask index 1, 1 ms period, stack HWM, deadline counters and physical
Safe-Off/OST/Trip waveform evidence are separate gates. Observed task-body maximum
is not a proof of whole-task WCET. A Flash load failure makes all later gates
NOT_RUN_HARDWARE, even if every Host test passes.

Hardware replay on 2026-09-16 (`run-1c4b7e49-7781-4580-897c-b326a97b6f98`)
reached CPU1 application code after successful pair loading, but CPU2 epoch stayed
1023 and LogicAlive stayed 2849. The gate timed out DISARMED with Cpu2BootEpochStale;
IPC was skipped. This establishes the stale-state boundary, not its firmware cause.

The replay exposed durable finalization defects: wrapping a failed IPC tool result
hid its twoPhaseIsolation marker; an always-halt guard read a disconnected CPU2;
and worker cleanup replaced QUARANTINED with READY. Preserve structured workflow
errors and the first failing boundary, never gate a halt on readable firmware
mirrors, require explicit per-core halt confirmation, and keep quarantine through
fenced cleanup. Boot-contract timeouts are not automatically retryable. Secondary
failures remain in their step/event records. These fixes require fresh runtime
activation and hardware verification; the original hardware evidence is immutable.
