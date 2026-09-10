# CPU2 Flash preparation/load state evidence

## Scope and baseline

User-authorized, read-only diagnostic addition. Baseline:
`d0d4f1668c8558f81f326ce848c312c51417e227`; candidate branch:
`codex/flash-load-state-evidence-20260910`, worktree
`C:/c2000-flash-state-evidence-20260910`.

Motivation: DK9 job `run-e54528e6-1b73-405f-8063-5cd3a0584a73` loaded CPU1
but failed to erase CPU2 Bank 3. Its preserved loader message says Flash
registers were locked. Preparation had reported success without durable actual
mapping readback. This patch adds evidence, not a lock workaround or ISR fix.

## Added records

Only the existing F28P65x `prepareFlashLoad` path arms the next same-core
program load for collection. It retains four phase-tagged snapshots:

1. `prepare:before`
2. `prepare:after` (or `prepare:failure`, without arming a load)
3. `load:before`
4. `load:after` or `load:failure`

Each snapshot contains start/end host milliseconds, CPU1/core 0 and CPU2/core 2
connection/run states, and these fixed 32-bit DATA-page reads through CPU1:

| Register | C28x word address | Interpretation |
|---|---|---|
| BANKMUXSEL | 0x0005D060 | Actual Flash bank mapping, not the requested plugin option |
| DEVCFGLOCK2 | 0x0005D002 | Bit 2 locks BANKMUXSEL configuration |

Addresses/access were cross-checked against installed C2000Ware 26.01
`driverlib/f28p65x/driverlib/inc/hw_sysctl.h` and CCS 21.0
`ccs_base/common/targetdb/Modules/C2000/f28p65x_dev_cfg_regs.xml`.
DEVCFGLOCK2 is **not** a complete Flash FSM/DCSM security status. Its value alone
does not explain the loader's lock message or authorize any unlock.

The evidence includes requested banks and `readOnly: true`, `atomic: false`.
Read-only describes the diagnostic probes, not the pre-existing erase/load
operation. Up to six SDK queries per snapshot, four snapshots per prepared load;
there is no polling loop or retry. Core state is read without PC/expression
evaluation. Disconnected cores are not queried for halt state; if CPU1 state
is unavailable, its register reads are marked missing rather than attempted.
Each field has its own success/error status; invalid values are never converted
to plausible zero data. Error strings are limited to 256 characters.

Preparation evidence is replaced by a new preparation and consumed once by
the next same-core load. Session teardown discards pending in-memory state.
Unprepared CPU1/CPU2 loads and symbol-only loads add no probes. No new public
tool/input, generic memory access path, or test-plan version was introduced.

## Persistence and failure handling

- `PersistentDssBridge.ts`: generated DSS records snapshots around the unchanged
  preparation/load operations. A loader exception is serialized before
  post-failure reads, preserving its original bounded message/causes.
- Failures retain snapshots at
  `ProgramLoadFailed.details.cause.details.response.flashLoadEvidence` (batch/job
  wrappers nest this error further). Existing error persistence and historical
  failure collection carry the data through cleanup. Existing token redaction
  also covers the nested snapshots.
- Successful loads return optional `flashLoadEvidence` through
  `CcsScriptingAdapter` to `LoadedProgramInfo`, its registry and `program loaded`
  log. An older/Mock adapter may still return void.
- Each completed snapshot is also written to the existing DSS diagnostic output
  as `flash-load:snapshot`; this is useful if a later command fails. The existing
  bounded output tails can still truncate earlier messages.

Ordinary probe exceptions do not suppress the requested operation or replace
its result. Hung DSS calls remain subject to the unchanged command/worker
timeouts: this is not a new hard real-time deadline guarantee. Missing or
incomplete evidence must not be called PASS.

## Verification (Windows, Node 22.23.2)

| Check | Result |
|---|---|
| Baseline four affected files | 100 PASS |
| Candidate affected suite | 112 PASS, 12 added tests |
| Full Host | 106 files, 775 PASS, zero failed/skipped; 21.26 s |
| Runtime `npm run typecheck` | PASS |
| `npm run build` | PASS |
| `npm run verify:debug-boundary` | PASS, no offenders |
| Expanded `tsc -p tsconfig.json --noEmit` | Baseline/candidate both have the same 63 existing errors; normalized comparison has zero additions/removals |
| `git diff --check` | PASS |
| Installed candidate / real target test | NOT RUN |

Affected command:

```powershell
npx vitest run tests/flashLoadStateEvidence.test.ts tests/PersistentDssBridge.test.ts tests/dssScriptSource.test.ts tests/CcsScriptingAdapter.test.ts tests/DebugSessionManager.test.ts
```

The new harness executes the actual generated DSS handlers. Tests check exact
old option/ConfigureClock/ConfigureBanks/load call ordering, fixed read addresses,
one load attempt, success/failure snapshots, unavailable/disconnected cores,
bad register results, bounded pending evidence, no PC/memory-write/reset/timeout
changes, adapter pass-through, persisted success and failure records after
session closure, and nested token redaction. These are Host/Mock evidence only.

Local full output and baseline/candidate expanded typecheck logs are under
`artifacts/flash-state-validation/` (ignored).

## Safety review / remaining gate

No changes to bank selection, erase scope, ownership writes, reset/load/run
ordering, retry policy, security/password/OTP registers, leases/fencing, or
firmware. No master merge, installation, daemon restart, remote push or target
operation was performed during this implementation. Product FLASH/RAM is
unchanged: all additions are debugger-side TypeScript/generated DSS JavaScript.

Snapshots are sequential and can affect debugger/loader latency; they do not
prove instantaneous target state. Collection begins at CPU2 preparation, not
before the preceding CPU1 load or inside the opaque TI erase command. Runtime
benefit remains INCONCLUSIVE until the installed candidate records real data.

After installing this exact candidate, confirm matching frontend/daemon identity,
then use a fresh exclusive lease and the declared diagnostic CPU1/CPU2 pair.
Do not reuse the failed job's UNKNOWN firmware identity. Preserve the next
failure before changing any loading policy; no blind retry or security unlock.
ISR entry/exit diagnosis, C0 liveness and integrated Scope acceptance remain OPEN.
