# CPU2 Flash-lock boundary diagnostics

Date: 2026-09-10. Baseline `68ff74ff06d69e3f05a56187bb4ec8d02103a03b`.
Local candidate extends the existing user-authorized MCP diagnostic branch
`codex/flash-load-state-evidence-20260910`. Verdict: **HOST PASS; TARGET NOT RUN**.
This is evidence collection, not a Flash unlock or a proven loader fix.

## Failure and missing evidence

DK9/CL650002 job `run-52ff5490-d175-497f-901d-1f0b3c2688d4` (09:33 UTC)
loaded CPU1, then TI's CPU2 loader reported Bank 3 erase registers locked.
The same runtime and matched firmware pair had loaded successfully three times.
Existing four-phase snapshots showed identical BANKMUXSEL/DEVCFGLOCK2 patterns
on success and failure; later protection/semaphore reads did not explain the
earlier erase failure. This motivates more boundary evidence, not automatic retry.

Read-only preflight at 10:46 UTC: MCP frontend/daemon both still baseline
68ff74ff, contracts 1/3/5, no active job, lease or external debugger. DK9 is
READY but generation 30 contains only a CPU1 program record. Top-level KNOWN
is insufficient to authorize paired-image symbols or application acceptance.
No target connect, reset, load, run, register write or UART command was executed
during this implementation. The explicit registered ccxml remains available;
global environment ccxml/C2000Ware autodiscovery is unresolved, not a new target fault.

## Bounded changes

Only `src/adapters/PersistentDssBridge.ts` and its generated-handler test change.
The existing F28P65x preparation arms one same-core CPU2 load. Snapshot phases:

1. `prepare:before`: before CPU2 preparation (after CPU1 load in the paired plan).
2. `prepare:clock-ready`: after the existing ConfigureClock call returns.
3. `prepare:after`: after the existing ConfigureBanks call returns.
4. `load:before`: immediately before the existing CPU2 loadProgram call.
5. `load:after` or `load:failure`: after it returns/throws.

The phase name clock-ready denotes the operation boundary, **not** an assertion
that PLL is locked or a derived frequency has passed. Actual values must agree.
A ConfigureClock failure yields before/failure only; ConfigureBanks failure
also preserves the completed clock boundary. No preparation failure arms a load.
No snapshot is taken inside the opaque TI erase/FSM operation.

Each phase reads this fixed allowlist, using 32-bit DATA access and C28x word
addresses. No target variable addresses, passwords, OTP, read-to-unlock or
undocumented Flash FSM registers are read.

| Register(s) | Word address(es) | Read view |
|---|---|---|
| BANKMUXSEL / DEVCFGLOCK2 | 0x5D060 / 0x5D002 | CPU1 |
| CLKSEM / CLKCFGLOCK1 | 0x5D200 / 0x5D202 | CPU1 |
| CLKSRCCTL1 / SYSPLLCTL1 | 0x5D208 / 0x5D20E | CPU1 |
| SYSPLLMULT / SYSPLLSTS | 0x5D214 / 0x5D216 | CPU1 |
| SYSCLKDIVSEL / MCDCR / SYNCBUSY | 0x5D222 / 0x5D22E / 0x5D242 | CPU1 |
| FLASHCTLSEM / FLSEM | 0x5CE24 / 0x5F0C0 | CPU1 and CPU2 separately |
| Z1_CR / Z2_CR | 0x5F018 / 0x5F098 | CPU1 and CPU2 separately |
| FRDCNTL / FLPROT | 0x5F800 / 0x5F804 | CPU1 and CPU2 separately |

Addresses, 32-bit widths and read access were checked against installed
C2000Ware 26.01 `hw_memmap.h`, `hw_sysctl.h`, `hw_ipc.h`, `hw_dcsm.h`,
`hw_flash.h` and CCS 21.0 targetdb F28P65x clock/Flash/IPC/DCSM register XMLs.
RW descriptors do not mean these probes write; status clearing would require
a write and is not performed. DCSM CSMKEY/CSMPSWD and OTP are excluded.

At most 23 memory reads plus two connected/two halted status queries per phase:
115 memory reads / 135 SDK queries per successfully prepared load, five phases.
Disconnected or state-unavailable cores are not read; their fields remain
missing while the other core's view is retained. No PC or expression evaluation.
The probes are sequential (`atomic=false`) and can change loader latency.
They retain original per-phase host timestamps and unchanged command timeouts.

The observed DSS bad-access patterns `0xBAD` and `0x0BAD0BAD` retain `rawValue`
but have `success=false` and no usable `value`. This is conservative evidence
validation, not proof that every occurrence of either bit pattern is an access
fault. It never cancels an otherwise successful load. Other numeric validation
and bounded error strings remain. Per-field failure does not erase other fields.

Existing options, selected banks, ConfigureClock/ConfigureBanks ordering,
CPU1/CPU2 run/reset/load sequence, RAM ownership, retry policy, leases, safety
profile and API/contract versions are unchanged. The diagnostic readOnly flag
describes probes, **not** the pre-existing erase/load operation. Original loader
exceptions remain primary; missing snapshots cannot be reported as PASS.

## Host verification

Windows, Node 22.23.2. Baseline affected suite: 112 PASS, before editing.
Candidate affected suite: 118 PASS (six added cases), 0.812 s.

```powershell
npx vitest run tests/flashLoadStateEvidence.test.ts tests/PersistentDssBridge.test.ts `
  tests/dssScriptSource.test.ts tests/CcsScriptingAdapter.test.ts tests/DebugSessionManager.test.ts
npm test
npm run typecheck
npm run build
npm run verify:debug-boundary
git diff --check
```

- Full Host: 106 files / 781 tests PASS, 16.81 s; no failed/skipped tests.
- Runtime typecheck, build and debug boundary scan PASS; no boundary offenders.
- Tests execute the actual generated DSS handlers, including fixed address/core
  tuples, exact old option/operation order, original loader failure retention,
  one load attempt, bounded snapshots, separate core accessibility, sentinel
  rejection, clock/bank failure distinction and diagnostic exception isolation.
- Not a firmware edit: product FLASH/RAM, Monitor/Scope ABI and builds unchanged.
- A pre-existing dirty `flash-load-state-evidence-20260910.md` is preserved and
  excluded from this candidate commit; it is not silently incorporated or reverted.

## Target gate and next declared attempt

The live MCP is still baseline 68ff74ff. Installing/reconnecting the candidate
is required before expecting the new phases/fields. Do not claim board evidence
from these Host tests or replay the old loader error as candidate evidence.

The next plan is loader-only: exact DK9 CPU1/CPU2 pair from Hybrid30K source
02c7934d; explicit cores 0 and 2; same preflight/system-reset/reconnect/paired-load
preparation as the failed job; at most one load attempt; always-cleanup; no
application handoff, Scope START, security unlock or automatic retry.
Before running, verify frontend, daemon and worker use the candidate runtime,
the registered CL650002 is exclusively available, and all four OUT/MAP hashes
match. Preserve either success or first failure with the expanded snapshots.

Compare: CPU1 post-load/preparation entry -> clock-ready -> bank-ready ->
CPU2 load entry -> first failure. Check actual mapping, PLL/divider/status,
both Flash controller/semaphore views and protection before inferring a cause.
If the same error remains with valid consistent boundaries, the unresolved
interval is inside TI's load/erase operation, not proven by post-return values.
Keep that distinction explicit and do not clear protection based on inference.
