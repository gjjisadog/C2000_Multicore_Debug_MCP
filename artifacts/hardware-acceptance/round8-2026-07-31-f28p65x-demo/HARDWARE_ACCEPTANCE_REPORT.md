# F28P65x Round 8 hardware acceptance report

## Outcome

The isolated CL650002 F28P65x rig completed a real, explicit-core TI `ipc_ex1_basic` load/run/IPC acceptance through the MCP → daemon → fenced board worker → persistent CCS DebugSession path. The durable job passed all three steps and produced `HARDWARE_TARGET` evidence.

This is a **partial hardware acceptance**, not a blanket release claim. CPU1/CPU2 debug isolation, GS RAM ownership, IPC completion, slow-variable polling, read-only ERAD capability detection, artifact export, and offline Trace regeneration were exercised. DLOG, mutating ERAD profiling, CAN, 20 cold-start repetitions, and endurance testing were not executed.

## Safety boundary

The user explicitly confirmed that the CL650002 rig was isolated, had no high-voltage supply, had its power stage disabled, and had PWM physically inhibited. Only TI's IPC demo was downloaded and run. No PWM, Trip release, contactor, protection-threshold, or arbitrary target-memory operation was requested.

## Environment

| Item | Value |
|---|---|
| Board | `f28p65x-demo-cl650002` |
| Device | `TMS320F28P650DK9` |
| Probe | XDS110 `CL650002` |
| CCS/DSLite | CCS root `D:\ccs21.0\ccs`; DSLite product version `21.0`; CCS semantic version unavailable (`null`) |
| C2000Ware | `26.01.00.00` |
| Compiler | `25.11.1.LTS` |
| XDS110 package | `3.0.0.43` |
| MCP | `0.7.0` |
| Bundled runtime | Node `v22.17.1` |
| System default Node | `v20.10.0` (not used by the hardware runtime) |
| OS | Windows x64 `10.0.26200` |
| Source base commit | `3428109c2e7d498d9e566d0c6f527c7ff78ce907` plus the two fixes below |

The hardware entry point remains fail-closed on unsupported Node versions. The installed daemon used its bundled Node 22.17.1 runtime; the system Node 20.10.0 was not used to run the acceptance.

## Firmware identity

The firmware was C2000Ware's `driverlib/f28p65x/examples/c28x_dual/driver/ipc/ipc_ex1_basic`.

| Image | OUT SHA-256 | MAP SHA-256 |
|---|---|---|
| CPU1 | `f649cc246084fbcc1b453cc54d47f6adee7ab4a7a7b76de6595155dcc261a38d` | `35d4d60746d9363beee952b5907f80bf03bb16fd9799e23ba5ab1a3df192f5a0` |
| CPU2 | `3ea0ac74fb40d9172193bdcdf5a5a54cd9c99d3a4d4973c5278d41f92613c8a8` | `13f37ad2923fc2494936ec0b0b8815b21a7d5d66c19479a0c163e4e5e9ae30cf` |

The target configuration SHA-256 was `830ba8344129c36ebefc39e255d2284d3892f0680344cf17a80ea90f58bc63ba`.

## Completed hardware checks

- Durable job `run-4b1a7578-f21f-45cc-b748-9ee6cd8b22e9` passed launch, IPC acceptance, and cleanup.
- CPU1 was always addressed as `coreId: 0`, `C28xx_CPU1`; CPU2 as `coreId: 2`, `C28xx_CPU2`.
- Runtime GS RAM ownership matched the demo contract: expected `0x10`, actual `0x10`.
- CPU1 `pass == 1` matched on the first IPC poll after both images ran.
- Run/pause isolation passed in both directions; the peer core retained its expected halted state and PC.
- Disconnecting CPU2 left CPU1 connected; CPU2 then reconnected explicitly.
- Both cores reported F28P65x ERAD capability with `NO_OWNER`; no ERAD registers were configured.
- The final interactive session closed cleanly and disposed its adapter.

## Variable-stream characterization

The demo's CPU1 `pass` symbol was read as a static diagnostic variable, not as a control waveform. CCS returned the symbol address as decimal `43018`, normalized to C28x address `0xa80a`; the metadata froze it as `uint32`, two 16-bit address units.

| Requested period | Samples | Mean host interval | Missed | Overruns | Dropped | Read errors | Conclusion |
|---:|---:|---:|---:|---:|---:|---:|---|
| 10 ms | 123 | 16.3241 ms | 77 | 66 | 77 | 0 | Not reliable |
| 20 ms | 88 | 22.8382 ms | 12 | 25 | 12 | 0 | Not reliable |
| 100 ms | 20 | 100.7899 ms | 0 | 0 | 0 | 0 | Passed short run |

Therefore, the lowest demonstrated no-miss period is **100 ms in this short run**. It is an empirical result for this host/CCS/rig combination, not a guaranteed product limit. Host polling time is not MCU sample time; all samples correctly retain `targetSampleTime: null`. This mechanism remains unsuitable for 8 kHz or 32 kHz control waveforms.

## Trace and evidence

The standard job artifact snapshot is complete. The Perfetto export regenerated independently from SQLite (23 events) and from artifacts (17 events). Both Trace views are correctly marked incomplete because this TI demo did not provide linked CAN, DLOG, ERAD-profile, target-state, or variable-stream sources. Trace incompleteness did not alter the passed job verdict.

The first durable attempt, `run-39b35a72-f3f5-47ef-a145-8d50ed580288`, is retained as a configuration-mismatch evidence bundle. It loaded both images and verified GS RAM ownership, but the wrapper supplied project-specific `g_stCoreComm*` defaults that do not exist in TI's demo. It is not classified as a hardware failure.

## Blocking bugs found and fixed

1. The durable IPC acceptance schema did not expose `ipcReadyExpressions`, although the underlying workflow supported them. The daemon, job step registry, MCP contract, and tests now propagate explicit per-core expressions.
2. CCS returns some C28x symbol addresses as decimal strings. Variable-stream and DLOG address parsing previously accepted only hexadecimal. A shared strict normalizer now accepts decimal or hexadecimal and normalizes to hexadecimal without changing C28x 16-bit address-unit semantics.

Both fixes are foundational routing/data-interpretation corrections discovered by real hardware. No DLOG, ERAD profiling, or Trace control feature was added.

## Not executed

- DLOG: the TI IPC demo exposes no DLOG buffer contract.
- ERAD profiling: only read-only capability detection was authorized; no mutating profile was configured.
- CAN/two-board acceptance: no PCAN channel or second board was available.
- 20 cold-start repetitions: not run.
- 30-minute and 2-hour endurance: not run.
- High-voltage, PWM, Trip release, power-stage, and protection tests: explicitly out of scope.

## Regression results

All repository checks were run with Node `v22.17.1`:

| Check | Result |
|---|---|
| `npm run typecheck` | Passed |
| `npm test` | 73 files, 443 tests passed |
| `npm run build` | Passed |
| `npm run doctor` | Passed |
| `npm run smoke:mcp` | Passed |
| `npm run verify:debug-boundary` | Passed; no offenders |
| `npm run verify:daemon-proxy` | 2 files, 4 tests passed |
| `npm run verify:daemon-restart` | 1 test passed |
| `npm run verify:can:mock` | 6 files, 10 tests passed; mock only |
| `npm run verify:package` | Passed after producing its required local `npm pack` tarball |
| `npm run verify:python-package` | Passed |
| `python -m pytest python/tests` | 7 tests passed in an isolated environment |

The default system Python initially lacked pytest; the actual Python test result above came from the package-declared `python[pytest]` extra installed into a temporary virtual environment. No Python hardware test was enabled.

## Release assessment

The repository has demonstrated the core foundations needed for continued Observability Layer hardware work on this rig: explicit board/lease/worker/session/core routing, real CPU1/CPU2 load/run isolation, hardware evidence classification, atomic artifacts, offline Trace regeneration, and safe cleanup.

Release readiness remains **conditional** until the skipped DLOG/ERAD/CAN hardware cases and repetition/endurance matrix are executed on suitably instrumented, explicitly authorized rigs.
