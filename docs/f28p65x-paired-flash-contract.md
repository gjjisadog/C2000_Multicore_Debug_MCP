# F28P65x Dual-Core Flash Programming Contract

This document is the normative description of how this MCP programs both
F28P65x Flash images. It replaces the previous flow in which CPU1 was started
before the CPU2 image was loaded.

## Contract

> Flash programming decides what is written before application execution
> begins. Both Flash images are programmed while every application core stays
> halted; the CPU1 on-chip Flash Plugin prepares the shared Flash clock and bank
> mapping while CPU1 holds the target, and no application core is started until
> the last Flash image has been programmed.

The CPU1 Flash Plugin is allowed to own shared Flash clock/bank preparation. The
CPU1 **application** is not allowed to run for that purpose.

## Stages

```
MCP workflow
     |
     v
Connect CPU1 + CPU2
     |
     v
Halt both  (initial-halt)
     |
     v
Reset (cpu)                    <- reset contract: requestedResetType == effectiveResetType
     |
     v
Load CPU1 Flash
     |
CPU1 remains Halted  (paired-flash-owner-halt)
     |
     v
CPU1 Flash Plugin preparation
   ConfigureClock
   ConfigureBanks
   BANKMUXSEL / DEVCFGLOCK2 boundary validation
     |
     v
Load CPU2 Flash
     |
     v
Paired Flash complete
     |
===== Flash programming boundary (flashProgrammingWindow) =====
     |
     v
Boot / Run stage
     |
     v
IPC acceptance
```

The boundary between "Flash programming" and "application startup" is explicit:
`DebugSessionManager.beginPairedFlashProgramming()` opens it and
`endPairedFlashProgramming()` closes it.

Flash programming completion is not a cold-start validation. Before exercising
the Flash boot or IPC stage, perform and record one product-level startup
boundary after programming: (a) power off and power on the board, (b) use the
product-level restart path, or (c) trigger the board's hardware reset circuit
(for example XRSn). A debugger-only reconnect, reset, or run is
controlled-debugger evidence and does not substitute for this boundary. If the
boundary is not performed, classify the startup/IPC stage as `blocked/not-run`
rather than as a pass or a target-side failure.

## Invariants

| Point in time | CPU1 | CPU2 | Enforced by |
| --- | --- | --- | --- |
| Before CPU2 `prepareFlashLoad` | connected + `Halted` | connected + `Halted` | `FlashOwnerCoreNotHalted` (host) and the DSS owner-state precondition |
| Before CPU2 `loadProgram` | not `Running` | `Halted` | owner-halt confirmation plus the owner-state precondition |
| Between the two Flash loads | no `runCore` for any core | no `runCore` for any core | `FlashProgrammingWindowActive` on `runCoreUnlocked` |
| After both Flash loads | may run | may run | boundary closed by the workflow |

Invariants are enforced in two layers on purpose: the workflow chooses the
correct sequence, and the manager/DSS layers fail closed if they are asked to
violate it. Neither layer silently repairs a contract violation - in particular
neither layer halts CPU1 on the caller's behalf, because that would hide a
workflow that started an application core too early.

## Owner / target routing

`prepareFlashLoad` is a two-core operation:

- `ownerCoreId` (CPU1 / 0) executes the preparation. The command is delivered
  over the owner's persistent DSS channel and runs on the owner's thread, so
  `ConfigureClock` / `ConfigureBanks` execute inside the DSS context that owns
  the shared Flash clock and bank mapping.
- `targetCoreId` (CPU2 / 2) is carried explicitly. The bank mapping and erase
  selection belong to the target image; a command that omits the target, or that
  names the owner as its own target, is rejected.

The DSS server rejects any mismatch between the command's channel identity and
its `coreId`, so a preparation cannot be smuggled onto the target's channel.

`prepareFlashLoad` remains a one-shot: a successful preparation arms exactly the
next load of the named target core. The next CPU2 load consumes that
preparation; a further CPU2 load requires a fresh preparation.

## Timeout budgets

| Operation | Budget | Default |
| --- | --- | --- |
| `getState`, `readPc`, `run`, `halt` | `stateReadMs` | 5000 ms |
| `reset` | `resetMs` | 30000 ms |
| `prepareFlashLoad` | `flashPrepareMs` | 120000 ms |
| `loadProgram`, `loadSymbols` | `programLoadMs` | 300000 ms |

`prepareFlashLoad` is a Flash operation (options configuration, ConfigureClock,
Flash state snapshot, ConfigureBanks, boundary validation), not a fast state
read. It must never be budgeted by `stateReadMs`: that mapping previously
expired the host deadline after 5000 ms while the DSS server was still inside
`ConfigureClock`.

The DSS script deadline is process-wide because one `ScriptingEnvironment`
serves every core thread. The applied deadline is therefore the **longest**
budget currently in flight, and each command retires its budget when it
completes. A short state poll on one core can no longer shorten a long Flash
preparation running on another.

## Error catalog

| Code | Meaning | Details |
| --- | --- | --- |
| `FlashOwnerCoreNotHalted` | CPU1 is not connected and halted when CPU2 Flash preparation was requested; nothing was written | `sessionId`, `ownerCoreId`, `targetCoreId`, `ownerState`, `targetState`, `flashBanks`, `programUri`, `mapUri`, `targetMemoryWritten: false`, `nextAction` |
| `FlashPreparationTimeout` | The Flash preparation exceeded `flashPrepareMs` | `stage: "prepare-flash"`, `ownerCoreId`, `targetCoreId`, `flashBanks`, `timeoutMs`, `targetMemoryWritten: false`, `cause` |
| `FlashProgrammingWindowActive` | A core was started while the paired Flash boundary was open, or a boundary was opened twice | `stage: "paired-flash"`, `ownerCoreId`, `targetCoreId`, `flashBanks`, `openedAt`, `coreId` |
| `FlashLoadSessionQuarantined` | The session failed a CPU2 Flash load or preparation and may not be retried in place | `quarantine.failureClass` (`flash_programmer_state`, `bank_mapping_boundary_mismatch`, `flash_operation_timeout`, ...) |
| `FlashLoadPreparationUnsupported` | The adapter cannot prepare Flash banks, or owner == target | `ownerCoreId`, `targetCoreId`, `flashBanks` |
| `StartupContractInvalid` (`diagnosisCode: PAIRED_FLASH_REQUIRES_HALTED_OWNER`) | A CPU2 Flash image was combined with `cpu1-run-before-cpu2` | `loadMode`, `cpu2FlashBanks`, `requiredLoadMode: "cpu1-then-cpu2"`, `targetMemoryWritten: false`, `nextAction` |
| `DestructiveFlashReloadBlocked` | An unconfirmed repeat CPU2 Flash load would erase a resident image | `blocked.flashBanks`, `blocked.mapEvidence` |

Flash diagnostics (`BANKMUXSEL`, `DEVCFGLOCK2`, `CLKSEM`, `CLKCFGLOCK1`,
`CLKSRCCTL1`, `SYSPLLCTL1`, `SYSPLLMULT`, `SYSPLLSTS`, `SYSCLKDIVSEL`, `MCDCR`,
`SYNCBUSY`, `FLASHCTLSEM`, `FLSEM`, `Z1_CR`, `Z2_CR`, `FRDCNTL`, `FLPROT`, plus
`validateFlashBoundary()`) remain bounded, read-only and best-effort. They never
mask the primary Flash error, never change Flash state and never trigger a
retry. A DSS deadline is classified as `flash_operation_timeout` rather than as a
bank failure.

## Presets

| Preset | Programming contract | Post-program startup |
| --- | --- | --- |
| `f28p65x-paired-flash` | CPU reset + `cpu1-then-cpu2` | Select independently with `runSequence.runMode`; defaults to debugger-owned |
| `hybrid30k-dk9-owner-first` | `cpu1-run-before-cpu2` | Historical Hybrid30K DK9 RAM bring-up contract |

The paired Flash preset describes the programming phase only. After the Flash
boundary closes, `runSequence.runMode` may be `debugger_runs_both` or
`cpu1_boots_cpu2`, depending on who owns the product CPU2 handoff. An explicit
`resetType: "default"` is normalized to the paired contract's required CPU
reset. A contradictory reset or load mode is still rejected before target
access; repeated CPU2 Flash programming remains separately fail-closed.

## Resident-image debug shortcut

When both Flash images are already resident and the durable session is already
connected, use `c2000_runResidentIpcDebug`. It materializes the safe common
path in one call:

1. validate the CPU1/CPU2 artifacts and linker maps;
2. load both `.out` symbol tables only;
3. default to the CPU1-owned CPU2 handoff, with bounded entry/IPC evidence;
4. return boot diagnosis without opening the paired Flash programming boundary.

This shortcut never programs Flash, writes target memory, or assumes a Flash
image when the board identity is `UNKNOWN`. The daemon must still have a
verifiable resident identity; otherwise the result points to manifest
verification or an exact pair load as the next action. Evidence-bundle output
is disabled by default, and an omitted `outputDir` uses the configured write
root when a bundle is explicitly requested.

## Host verification

The contract is covered by host tests:

| Requirement | Test |
| --- | --- |
| `prepareFlashLoad` never uses `stateReadMs` | `tests/CcsScriptingAdapter.test.ts` ("budgets Flash preparation with the Flash-operation timeout") |
| Paired ordering, no early run | `tests/pairedFlashContract.test.ts` ("programs both images with every application core halted", "never starts an application core between the two Flash loads") |
| CPU1 `Running` fails closed without reaching the adapter | `tests/DebugSessionManager.test.ts` ("fails closed without touching the adapter when the Flash owner core is running"), `tests/flashLoadStateEvidence.test.ts` ("rejects a preparation whose owner core is running") |
| Owner halted allows preparation | `tests/DebugSessionManager.test.ts` ("prepares CPU2 Flash banks from its linker map before loading the image") |
| Owner/target routing | `tests/CcsScriptingAdapter.test.ts` ("sends per-core connect, run, halt, reset and load commands"), `tests/flashLoadStateEvidence.test.ts` ("executes the Flash Plugin on the owner core") |
| One-shot preparation | `tests/flashLoadStateEvidence.test.ts` ("a second CPU2 load requires a fresh preparation", "arms the target core's next load, not the owner's") |
| CPU2 Flash failure quarantine | `tests/DebugSessionManager.test.ts` ("quarantines a session after a CPU2 Flash programmer failure", "quarantines the session when CPU2 Flash preparation itself times out") |
| Reset contract regression | `tests/CcsScriptingAdapter.test.ts` ("returns matching reset evidence and rejects absent or mismatched evidence"), `tests/pairedFlashContract.test.ts` ("keeps the requested reset type for both cores and never substitutes a fallback") |
| Historical mode scope | `tests/pairedFlashContract.test.ts` ("rejects the historical CPU1-pre-run load sequence for a CPU2 Flash image", "keeps the historical CPU1-pre-run sequence available for a CPU2 RAM image") |

Run them with `npm test` (or `npm run verify:host` for the full host gate).

## DK9 hardware validation

The first hardware validation covers **Flash programming only**. Do not combine it
with IPC, UART, Scope, PWM or OpenLoop checks.

### Step 1 - program both Flash images

```json
{
  "startupPreset": "f28p65x-paired-flash",
  "cpu1CoreId": 0,
  "cpu2CoreId": 2,
  "cpu1OutPath": "<Hybrid30K_CPU1_DK9_LAUNCHXL.out>",
  "cpu2OutPath": "<Hybrid30K_CPU2_DK9_LAUNCHXL.out>",
  "cpu1MapPath": "<Hybrid30K_CPU1_DK9_LAUNCHXL.map>",
  "cpu2MapPath": "<Hybrid30K_CPU2_DK9_LAUNCHXL.map>",
  "ccxmlPath": "<TMS320F28P650DK9.ccxml>",
  "sessionMode": "interactive",
  "cleanupOnFailure": false,
  "autoCloseOnComplete": false,
  "ipcReadyExpressions": [{ "coreId": 0, "expression": "g_ulHybrid30kIpcPass", "expected": 1 }],
  "timeoutMs": 10000,
  "intervalMs": 100
}
```

Submit it through `c2000_launchAndRunIpcAcceptance` with
`sessionMode: "interactive"` and `cleanupOnFailure: false` so a failure keeps the
session, the probe lease and the first-failure evidence for inspection. If the
Flash boundary must be validated *without* any run stage, use
`c2000_loadPrograms` with the CPU1 image first and the CPU2 image second on a
session that has already been halted; the same contract applies.

### Step 2 - required log evidence

The log must show, in this order:

```
CPU1 connected / CPU2 connected
CPU1 halted / CPU2 halted
reset:0:cpu  reset:2:cpu
CPU1 load start -> CPU1 load success
CPU1 still halted            (paired-flash-owner-halt)
CPU2 prepareFlashLoad start  (owner 0 -> target 2, banks [...])
ConfigureClock PASS
ConfigureBanks PASS
boundary validation PASS
CPU2 load start -> CPU2 load success
no run before both image loads complete
paired Flash PASS
```

Record at minimum: `operation`, `coreId`, `ownerCoreId`, `targetCoreId`, core
state before/after, `flashBanks`, timeout budget, ConfigureClock duration,
ConfigureBanks duration, CPU1 load duration, CPU2 load duration, `BANKMUXSEL`,
`DEVCFGLOCK2`, and the final load result.

### Step 3 - only then test startup

Only after `flashProgramming.performed == true`,
`flashProgramming.applicationCoresStartedDuringFlash == false`, both load
results are successful, and the recorded product-level startup boundary has
completed may the boot/run/IPC stage be exercised (or the completed run stage
of `c2000_runIpcAcceptance` inspected).

### If preparation fails again

Do not retry immediately, and do not retry in the same session: the session is
quarantined. Preserve the first failure evidence - `workflowStage`,
`effectiveStartup`, `flashProgramming`, `load.results[].error.details.response`
(including `flashLoadEvidence.snapshots` and `boundaryValidation`), the
`FlashPreparationTimeout` budget, and the captured DSS stdout/stderr tails - and
report it before any intentional destructive re-program.
