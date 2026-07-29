# F28P65x Hardware Acceptance Report

No Mock result is promoted to hardware evidence. A skipped preflight is not a hardware pass.

## 1. Actual hardware environment

- Run ID: `round8-2026-07-29-no-hardware`
- Host: `win32 10.0.26200 x64`
- Node.js: `v22.23.1`
- Package: `0.7.0`
- Hardware opt-in: `false`
- PCAN opt-in: `false`
- Two-board opt-in: `false`
- Overall status: `SKIPPED_NO_HARDWARE`

No XDS110, board, or PCAN identity was established in this run.

## 2. Repository commit

`19db3750b03f1fe83b7bc9fe26c73a0b8308f5c3`

## 3. Test firmware SHA

`not provided; no firmware was executed`

## 4. CCS, DSS, XDS110, and PCAN versions

- CCS: `not started / not measured`
- DSS: `not started / not measured`
- XDS110 serials: `not enumerated`
- PCAN model: `not opened`
- PCAN channel: `not opened`
- PCAN driver: `not loaded`

## 5. Acceptance result matrix

| Case | Acceptance | Status | Evidence | Reason |
|---|---|---|---|---|
| A1 | Board registration and identity fencing | SKIPPED_NO_HARDWARE | HOST_COMMAND_EVIDENCE | C2000_HARDWARE_TEST=1 is required; no target or probe was accessed |
| A2 | CPU1/CPU2 independent connect | SKIPPED_NO_HARDWARE | HOST_COMMAND_EVIDENCE | C2000_HARDWARE_TEST=1 is required; no target or probe was accessed |
| A3 | CPU1/CPU2 independent run and pause | SKIPPED_NO_HARDWARE | HOST_COMMAND_EVIDENCE | C2000_HARDWARE_TEST=1 is required; no target or probe was accessed |
| A4 | Reset scope and observer invalidation | SKIPPED_NO_HARDWARE | HOST_COMMAND_EVIDENCE | C2000_HARDWARE_TEST=1 is required; no target or probe was accessed |
| B1 | CPU1 program load | SKIPPED_NO_HARDWARE | HOST_COMMAND_EVIDENCE | C2000_HARDWARE_TEST=1 is required; no target or probe was accessed |
| B2 | CPU2 load and GS RAM ownership | SKIPPED_NO_HARDWARE | HOST_COMMAND_EVIDENCE | C2000_HARDWARE_TEST=1 is required; no target or probe was accessed |
| B3 | Dual-core boot and IPC ready repeatability | SKIPPED_NO_HARDWARE | HOST_COMMAND_EVIDENCE | C2000_HARDWARE_TEST=1 is required; no target or probe was accessed |
| C | Online slow variable stream | SKIPPED_NO_HARDWARE | HOST_COMMAND_EVIDENCE | C2000_HARDWARE_TEST=1 is required; no target or probe was accessed |
| D | Read-only target DLOG export | SKIPPED_NO_HARDWARE | HOST_COMMAND_EVIDENCE | C2000_HARDWARE_TEST=1 is required; no target or probe was accessed |
| E | F28P65x ERAD profiling | SKIPPED_NO_HARDWARE | HOST_COMMAND_EVIDENCE | C2000_HARDWARE_TEST=1 is required; no target or probe was accessed |
| F | Perfetto trace and failure bundle | SKIPPED_NO_HARDWARE | HOST_COMMAND_EVIDENCE | C2000_HARDWARE_TEST=1 is required; no target or probe was accessed |
| G | Two-board CAN three-segment physical evidence | SKIPPED_NO_HARDWARE | HOST_COMMAND_EVIDENCE | C2000_HARDWARE_TEST=1 is required; no target or probe was accessed |
| H | Multi-board concurrency and isolation | SKIPPED_NO_HARDWARE | HOST_COMMAND_EVIDENCE | C2000_HARDWARE_TEST=1 is required; no target or probe was accessed |
| I | Two-hour stability and recovery | SKIPPED_NO_HARDWARE | HOST_COMMAND_EVIDENCE | C2000_HARDWARE_TEST=1 is required; no target or probe was accessed |

## 6. Evidence levels

This run contains only `HOST_COMMAND_EVIDENCE` proving that hardware gates
stopped before target or bus access. It contains no
`TARGET_STATE_EVIDENCE`, `BUS_EVIDENCE`, or
`FULL_HARDWARE_EVIDENCE`.

## 7. CPU1/CPU2 independent control

`SKIPPED_NO_HARDWARE` / `SKIPPED_NO_HARDWARE`. No core was connected,
continued, halted, reset, or loaded.

## 8. GS RAM ownership

`SKIPPED_NO_HARDWARE`. No MEMCFG register was read or written and no real
linker map was accepted as hardware evidence.

## 9. IPC boot repeatability

`SKIPPED_NO_HARDWARE`. Zero cold/reload cycles were executed; no latency or
success-rate statistic exists.

## 10. Variable-stream measured performance

`SKIPPED_NO_HARDWARE`. No 10/20/100 ms hardware stream or 30-minute run was
executed, so no hardware polling latency, overrun, miss, or drop rate is
reported.

## 11. DLOG consistency

`SKIPPED_NO_HARDWARE`. No target buffer was read and no CSV/JSON hardware
alignment was measured.

## 12. ERAD repeatability

`SKIPPED_NO_HARDWARE`. No ERAD resource was configured or mutated and no
cycle distribution was measured.

## 13. Perfetto Trace time domains

`SKIPPED_NO_HARDWARE`. No hardware Trace was generated. The implementation
still treats host monotonic, wall clock, PCAN timestamps, MCU sample indices,
DLOG relative time, and ERAD cycles as distinct domains unless calibrated.

## 14. Two-board CAN three-segment statistics

`SKIPPED_NO_HARDWARE`. TX, PCAN bus, RX, match, loss, duplicate, ordering,
payload, period, and jitter counts are all unmeasured. No
`FULL_HARDWARE_EVIDENCE` is claimed.

## 15. Multi-board concurrency

`SKIPPED_NO_HARDWARE`. No pair permit, dual XDS110 route, or 50-round
concurrency test was executed.

## 16. Long-duration stability

`SKIPPED_NO_HARDWARE`. The two-hour stability/recovery test was not executed.

## 17. Fixes made in this round

- Added a P0 general hardware opt-in gate before CCS/DSS/XDS110 target access.
- Added independent PCAN and two-board opt-in gates.
- Moved the readiness/MCP hardware gate before their build step.
- Added a supported-Node fail-closed gate before hardware access.
- Added atomic result/event/manifest/report generation and no Mock promotion.

## 18. Unfinished or unexecuted hardware tests

All cases A1 through I are unexecuted because the required opt-in, board
configuration, ccxml, firmware, XDS110 identity, and PCAN/two-board
configuration were not available.

## 19. Remaining risks

- Real F28P65x behavior for variable stream, DLOG, ERAD, Trace, and failure
  collection remains unverified.
- Existing CCS and PCAN scripts prove only the evidence they actually capture;
  a PCAN preflight must never be reported as CAN acceptance.
- Dedicated automated target-side executors for every Round 8 scope remain to
  be implemented and reviewed on an isolated low-risk rig.
- The default host Node.js may differ from the supported acceptance runtime;
  hardware entry points now reject unsupported versions.

## 20. Artifact files

- `HARDWARE_ACCEPTANCE_REPORT.md`
- `hardware-acceptance-result.json`
- `hardware-acceptance-events.jsonl`
- `hardware-acceptance-manifest.json`

## Safety statement

This run did not authorize high-voltage bus connection, power-stage drive, automatic PWM enable,
Trip release, protection-threshold changes, or unknown firmware.
