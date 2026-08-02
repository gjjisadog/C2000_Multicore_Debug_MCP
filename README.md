# C2000 Multicore MCP

Independent MCP server for explicit TI C2000 multicore debug control. The first implementation targets F28P65x CPU1/CPU2 workflows and keeps all debug APIs scoped by `sessionId` and `coreId`.

## Capability status

| Capability | Status | Evidence |
|---|---|---|
| Daemon/job/lease/worker persistence | Mock verified; selected hardware manually verified | Automated SQLite/Mock tests plus prior explicit F28P65x acceptance |
| Variable stream | Implemented but not hardware verified | Deterministic Mock only; host polling, minimum configured period 10 ms |
| Read-only DLOG export (SoA) | Implemented but not hardware verified | Deterministic Mock only |
| F28P65x ERAD profiling | Implemented but not hardware verified | Structured Mock ERAD backend only |
| Perfetto trace/failure bundle | Mock verified | Offline SQLite/artifact regeneration tests |
| Python pytest HIL SDK | Mock verified | Fake daemon contract tests; hardware is explicit opt-in |
| Deterministic metrics/baselines | Mock verified | Raw-linked metric and compatibility/threshold tests |
| DLOG arm/trigger writes | Unsupported | No write capability is exposed |
| CLA timing, cross-core ERAD synchronization | Planned | No completion claim |

Automated Mock results are never classified as real XDS110, PCAN, DLOG, ERAD,
or target-timing evidence.

## pytest HIL SDK

The package contains a pure-Python SDK under `python/`. Install it from a
release/offline bundle without resolving network dependencies:

```text
python -m pip install --no-deps ./python
```

The SDK reads daemon discovery metadata and calls authenticated public RPC. It
does not import CCS libraries, access XDS110/PCAN, or read SQLite tables.
Creating `c2000_board` calls `c2000_createDebugSession` with an explicit
`boardId` and CPU1/CPU2 core map; the daemon owns and fences the lease.
Fixture teardown closes the session and releases that lease.

```python
def test_cpu2_boots(c2000_board):
    c2000_board.load_programs(cpu1="cpu1.out", cpu2="cpu2.out")
    c2000_board.run(core_id=0)
    result = c2000_board.wait_for_variable(
        core_id=2,
        symbol="g_stBoot.uiIpcReady",
        equals=1,
        timeout=5.0,
    )
    assert result.matched
```

Normal `pytest` does not contact a daemon or target. Use
`C2000_HIL_MODE=mock` for a registered Mock daemon. Real hardware additionally
requires `C2000_HARDWARE_TEST=1`; the fixture skips when CCS/XDS110, a matching
board, requested PCAN capability, or two-board capacity is unavailable.

## Deterministic metrics and baselines

`c2000_createRunBaseline` regenerates `metrics.json` from durable job events and
available variable, DLOG, ERAD, and CAN evidence, then creates an atomic
baseline under `artifacts/baselines/`. Metrics retain raw numeric samples and
source selectors; statistics use linear-R7 percentiles and population standard
deviation. A baseline stores statistics plus a SHA-256 link to the source
`metrics.json`, so it does not replace measurement evidence.

`c2000_compareRunWithBaseline` rejects firmware, CPU image, test plan/version,
device, board-profile, or metric-schema mismatches by default. An explicit
`allowCompatibleComparison` records an `OVERRIDDEN` compatibility status.
Supported first-version rules are upper/lower bound, absolute difference,
relative increase, and p95/p99 upper bounds. Comparisons are artifacts and
never modify the original job verdict.

## 0.5 CAN evidence and job semantics

Physical two-board acceptance defaults to `trafficMode: "firmware-driven"`.
The board firmware transmits, PCAN passively observes the physical bus with
hardware and host timestamps, and the peer firmware counters/last-frame
variables plus optional application assertions close the evidence chain.
`FULL_HARDWARE_EVIDENCE` requires matching firmware TX, bus, and firmware RX
evidence; Mock always reports `SIMULATION_EVIDENCE`. A successful PCAN write is
only `QUEUED_TO_ADAPTER`, not delivered.

PCAN native access now runs in `c2000-can-worker`; daemon and board-worker
processes do not load Koffi or `PCANBasic.dll`. SQLite channel leases fence old
worker generations. Two-board permits and leases are acquired atomically.
Scheduler job capacity (`maxActiveJobs`) is independent of physical-board
capacity (`maxParallelBoards`) and includes priority, aging, and starvation
evidence. Retry policies, `step.on`, attempt persistence, and abort-aware
cancellation are enforced by the job engine.

Required branch protection checks are `Fast CI`, `Deep CI`, and `Packaging CI`.
Release artifacts contain a runtime manifest, SHA-256 metadata, and CycloneDX
SBOM. Automated CI does not claim real XDS110/PCAN/two-board hardware success;
that remains an explicit manual hardware workflow.

## Round 4 execution safety

`scheduler.maxParallelBoards` is now a daemon-wide physical-board limit.
Every board flow obtains a `BoardExecutionPermit`; two-board CAN flows obtain
both permits atomically and fail immediately with
`InsufficientBoardConcurrency` when the limit is below two. Daemon health
reports the limit, active holders, and waiting requests.

Board leases are fencing contracts. Every lease has a monotonically increasing
token/generation, and every board-bound command carries its complete lease
context through the Daemon to the Board Worker. Both layers reject expired,
invalidated, identity-mismatched, or stale-generation commands. Repeated
renewal failure records events, invalidates the lease, and stops further target
commands.

PCAN-Basic support is Windows x64 only and dynamically uses the official
`PCANBasic.dll` through the optional Koffi binding. PEAK binaries are not
redistributed, and hardware mode never falls back to Mock CAN. Install the
official PEAK package; set `C2000_PCAN_BASIC_LIBRARY` only if discovery fails.
The first backend supports Classical CAN with 11/29-bit IDs, DLC 0–8, and
125/250/500 kbit/s or 1 Mbit/s. Hardware preflight is explicitly opt-in:

```powershell
$env:C2000_PCAN_HARDWARE_TEST = "1"
npm run verify:pcan:hardware
```

Without opt-in this prints `SKIPPED` and touches no hardware. Passing preflight
does not mean two-board CAN acceptance passed.

Detached daemon management:

```powershell
npm run build
npm run daemon:detached
npm run daemon:status
npm run daemon:stop
```

The launcher returns after health is ready, avoids duplicate daemons, and stop
uses authenticated local RPC rather than unconditional `taskkill`. For
production Windows deployment use a service manager such as NSSM; these npm
scripts are not a complete Windows Service manager.

Runtime bundles are platform-, architecture-, Node ABI-, and native-binding
specific. Each build clears `dist/src`, overwrites `better_sqlite3.node`, and
writes `runtime-manifest.json`. Doctor verifies platform, architecture, ABI,
and binding SHA-256. Do not copy bundles across platforms or Node ABIs.

## What It Solves

This server avoids controlling "whatever target CCS UI has focused". Every tool call takes a logical `sessionId`; every core operation takes an explicit `coreId`.

- `coreId = 0`: `C28xx_CPU1`
- `coreId = 2`: `C28xx_CPU2`
- Mock adapter is complete enough for development and smoke tests.
- CCS adapter has an experimental persistent DSS bridge that calls CCS Scripting / Debug Server APIs directly. Physical-board acceptance has passed for connect/load/snapshot, launch, and CPU1/CPU2 run-pause isolation.
- Debug control tools are all registered with a `c2000_` prefix to avoid collisions with TI official MCP tools.

## Boundary With TI Official MCP

TI official MCP debug control tools such as `continue`, `pause`, `reset`, `connectTarget`, `disconnectTarget`, and `getTargetState` are not used as the F28P65x dual-core automation path. Those tools may depend on the active target selected inside CCS or CCS Theia.

This MCP must not wrap those TI official debug control tools for dual-core control. F28P65x debug automation uses this server's own tools, backed by `DebugAdapter` implementations:

- `c2000_continue`
- `c2000_pause`
- `c2000_reset`
- `c2000_connectTarget`
- `c2000_disconnectTarget`
- `c2000_getTargetState`
- `c2000_loadProgram`
- `c2000_loadPrograms`
- `c2000_getMulticoreSnapshot`
- `c2000_analyzeRamOwnership`
- `c2000_diagnoseBootHandoff`
- `c2000_waitForIpcReady`
- `c2000_reloadResetRunToMain`
- `c2000_launchAndRunIpcAcceptance`
- `c2000_runIpcAcceptance`
- `c2000_runBootHandoffDiagnosis`
- `c2000_runReloadAndDiagnose`
- `c2000_runFullDebugBundle`

Build, project, or SysConfig discovery may still be handled outside this server, but per-core debug control must go through `c2000-multicore-mcp` and its adapter layer. The real CCS path must call the specific core's CCS Scripting / Debug Server `DebugSession`, for example `session.target.run()` or `session.memory.loadProgram()`, after resolving that session by `corePattern`.

MCP clients can call `c2000_getDebugBoundary` before touching the target. It returns machine-readable guarantees including `officialTiMcpDebugControlsUsed: false`, `activeTargetAllowed: false`, `uiFocusRequired: false`, `requiredPerCoreInputs: ["sessionId", "coreId"]`, the CPU1/CPU2 `coreId` convention, the forbidden TI official debug tool names, the `c2000_` debug tools that must be used instead, and the CCS DebugSession methods used by the real adapter. `c2000_continue` is intentionally reported as non-blocking and maps to `session.target.runAsynch()` so the MCP call can return after issuing the per-core continue command.

The same boundary report also states that the real adapter is `CcsScriptingAdapter` with `PersistentDssBridge` as its default bridge, and that `DssCliBridge` is not used for F28P65x debug automation. This matters because the persistent bridge keeps per-core DebugSession objects alive and addressable by `adapterSessionId + coreId`.

`CcsScriptingAdapter` and `PersistentDssBridge` both fail closed when a successful CCS response omits or mismatches the requested `coreId` and `coreName`. The returned `coreId` must be a number equal to the requested core ID, and the returned `coreName` must be a string equal to the requested core name; malformed identity values are rejected rather than treated as active-target evidence. A response without explicit core identity is treated as `CoreIdentityMissing`, not as an acceptable active-target result.

For F28P65x CPU2 RAM builds that place sections in `RAMGSx`, `c2000_loadProgram` and `c2000_loadPrograms` prepare GS RAM ownership before loading CPU2. When a `.map` file is supplied through `mapUri`, or can be derived next to the `.out`, the manager parses the map (only the `MEMORY CONFIGURATION` section) and computes the required GS owner bits for CPU1. **Multiple used `RAMGSx` regions are OR-combined into a single `MEMCFG_GSXMSEL` write** so later bits do not overwrite earlier ones (for example RAMGS4+RAMGS5 → value `0x30`). When `readMemory` is available, that write is applied as **RMW** (`current | requiredMask`) so unrelated GS owner bits already set on CPU1 are preserved. If no usable map is available, it keeps the previous RAMGS4-only fallback (`value: 0x10`) for compatibility, logs a warning, and appends the fallback reason to `LoadedProgramInfo.warning`. Program/map paths accept `file://` URLs, surrounding quotes, `~`, and relative paths via `normalizeProgramUri`. The write uses an explicit CPU1 DebugSession memory write to `MEMCFG_GSXMSEL` at `0x0005F444` on the DATA page through `DebugAdapter.writeMemory`. This mirrors TI's dual-core RAM ownership requirement and still uses the self-managed `sessionId -> coreId -> DebugSession` path; it does not call TI official MCP debug controls and does not depend on CCS UI focus.

## Install

### One-command install (Windows and macOS)

Prerequisites: Node.js 22.12+ LTS (recommended) or Node.js 20.19+ LTS; an
authenticated GitHub CLI (`gh auth status --hostname github.com`); and Codex.
Node.js 24 is not currently supported by the published native dependency bundle.
This repository is private, so anonymous release URLs do not work. The
bootstrap fails before downloading when the Node version or GitHub
authentication is invalid, selects the runtime for the active Node ABI, verifies
the release archive against the published SHA-256 metadata, and removes its
temporary download directory. No npm command or dependency download is used.
The installer copies the
platform-specific bundled runtime to `~/.c2000-multicore-mcp`, installs the
bundled Codex skill, registers the `c2000-multicore` MCP server, and runs a
runtime handshake check. Restart Codex after it succeeds.

Windows x64 (PowerShell):

```powershell
gh release download v0.7.0 -R gjjisadog/C2000_Multicore_Debug_MCP -p install-release.ps1 -O - | powershell -NoProfile -ExecutionPolicy Bypass -Command -
```

macOS (Apple Silicon and Intel):

```bash
gh release download v0.7.0 -R gjjisadog/C2000_Multicore_Debug_MCP -p install-release.sh -O - | bash
```

The release tag and assets must exist before these download commands can be
used.

### One-command offline install (Windows x64)

On a connected machine, download `offline-bundle-win32-x64.zip` from the
release and transfer it to the offline machine. The bundle contains the native
runtimes for Node 20 ABI 115 and Node 22 ABI 127, their SHA-256 metadata, and
the installer. Extract it and run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-offline.ps1
```

The script detects the active ABI, selects the matching local `.tgz`, verifies
the archive SHA-256 and size, rejects unsafe archive paths, verifies the
platform, ABI, and bundled native binding, directly runs
`dist/src/installer/index.js`, and finishes with the installer's doctor check.
It never invokes npm or accesses the network.

For an unpublished or separately transferred package, pass both files
explicitly:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-offline.ps1 `
  -PackagePath .\c2000-multicore-mcp-0.7.0-win32-x64-abi127.tgz `
  -ChecksumPath .\SHA256SUMS-win32-x64-abi127.json
```

Useful options:

- `--config /absolute/path/config.json` preserves an existing hardware config.
- `--workspace /absolute/path` sets the default allowed program/read root.
- `--scope project` writes project-scoped Codex MCP configuration.
- `--no-register`, `--no-skill`, and `--no-doctor` opt out of individual steps.
- `--json` emits a machine-readable installation result.

The installer prefers the official `codex mcp add` command. If the Codex CLI
cannot be launched, it writes a clearly marked, replaceable block to
`~/.codex/config.toml` (or `.codex/config.toml` with `--scope project`) without
rewriting unrelated configuration.

### Install from source

Windows x64 should use the isolated source installer:

```powershell
npm run install:source:windows
```

Pass installer options after `--`, for example:

```powershell
npm run install:source:windows -- --config C:\absolute\c2000.json --force
```

This path validates the complete Node version before changing dependencies,
skips `npm ci` when the lockfile dependencies and native SQLite binding are
already usable, and builds under a unique temporary directory. It never
overwrites the repository `dist` directory, so running Codex MCP
proxy/supervisor/daemon processes cannot lock the upgrade build. The temporary
staging directory is removed on success or failure.

The lower-level cross-platform development sequence remains:

```bash
npm ci
npm run build
npm run doctor
```

`npm run build` first type-checks production sources with the pinned TypeScript CLI (`lib/_tsc.js`), then invokes esbuild for the proxy, daemon, board-worker, CAN-worker, and installer entrypoints. It emits CommonJS self-contained bundles under `dist/src/` plus the required `better_sqlite3.node` binding, so a later partial or missing `node_modules` directory does not take the configured C2000 MCP service offline. `npm run typecheck` is also available as a standalone quality gate. If build fails after a partial `node_modules`, reinstall with `npm ci`.

## Start

Mock mode:

```bash
C2000_MCP_CONFIG=./examples/f28p65x.config.json npm run dev
```

Built server:

```bash
C2000_MCP_CONFIG=./examples/f28p65x.config.json npm start
```

## Persistent daemon, jobs, and board ownership

The stdio executable is a short-lived MCP proxy. It discovers or starts a
loopback-only `c2000-debugd`, then forwards calls with a per-daemon local token.
Closing a stdio client therefore does **not** dispose board workers, debug
sessions, DSS children, leases, or queued jobs. The daemon keeps SQLite state
in `storage.sqlitePath` (WAL enabled by default) and starts one worker per
registered `boards[]` entry. A non-mock worker checks that its `.ccxml` binds
the expected XDS110 serial before it starts. An atomic runtime lock prevents
concurrent proxies from starting two daemons against the same database. If a
daemon is restarted, the MCP proxy safely rediscovers its endpoint and token
once after a connection or authentication failure; it never retries a request
that merely timed out after dispatch.

Use the daemon/job surface for multi-board work:

- `c2000_getDaemonHealth` reports daemon, worker, job, and read-only database-consistency state.
- `c2000_listBoards` reports persisted registrations, leases, workers, and quarantine state.
- `c2000_registerBoard` validates a serial-bound `.ccxml`, persists the board,
  and starts its isolated worker. Use it when health reports
  `boards.registrationRequired: true`; no daemon restart is required.
- `c2000_recoverBoard` defaults to a dry run and can restart only the daemon-owned
  worker for one board. It deliberately never terminates an external CCS/DSS owner.
- `c2000_submitTestPlan` returns a stable `jobId` immediately; use
  `c2000_getTestRun`, `c2000_listTestRuns`, `c2000_cancelTestRun`, and
  `c2000_getTestArtifacts` afterwards.
- A daemon stop marks in-flight runs `RECOVERING`. Startup makes a
  **persisted-metadata-only** decision: it creates fresh worker/session state
  and may restart an authorized RAM plan from its declared whole-board safe
  boundary. It does not restore a former DSS `DebugSession`, nor read/reconcile
  XDS110 ownership, CPU state/PC, loaded ELF hashes, fault-hook readback, or a
  CAN adapter session. Non-idempotent interruptions become
  `NEEDS_MANUAL_INTERVENTION` instead of being replayed. Reconcile events carry
  these explicit capability flags as evidence.

Durable safety regression plans use a strict discriminated step schema. An
unknown field, a missing `coreId`, or a core other than F28P65x CPU1 `0` and
CPU2 `2` is rejected before the job is persisted. Session-scoped steps must
follow `launchMulticore` in the same board flow; they never attach to a session
left by an earlier daemon generation.

Recovery has a separate compatibility parser for plans already persisted by
the former permissive v1 schema. It accepts only the nine original step types,
normalizes a missing legacy `delayMs` to zero, and discards old passthrough
noise before strict validation. New target-control steps and plans containing
`safetyGuards` never use that compatibility path, so migration cannot silently
remove a guard or make a non-replayable step replayable.

Supported target-oriented durable steps are:

- `launchMulticore`: `loadPrograms` is explicit and defaults to `true`.
  `false` creates a connect-only session and never supplies a program path or
  sets a core's `load` flag. `loadSequence` accepts `cpu1-then-cpu2` or the
  explicit `cpu1-run-before-cpu2` RAM-ownership sequence.
- `assignExpressions`: `{ assignments: [{ coreId, expression, value, verify }] }`.
- `injectFaults`: `{ faults: [{ label?, coreId, expression, value, verify }] }`.
- `captureExpressions`: `{ label?, reads: [{ label?, coreId, expressions }],
  sampleCount, intervalMs }` for a bounded evaluation window.
- `waitForExpressions`: `{ conditions: [{ label?, coreId, expression,
  expected }], timeoutMs, intervalMs }`.
- `runCores`: `{ coreIds, monitorMs, intervalMs }`. It is non-idempotent:
  interruption is never retried or replayed. `monitorMs` provides a bounded
  window for plan safety guards while the selected cores run, and must be
  positive whenever the plan declares guards.
- `haltCores`: `{ coreIds }`. Repeating a halt is safe, so this step is the
  only new execution-control step classified `SAFE_RETRY`.
- `reconnectAfterTargetReset`: records a connected baseline, then waits for an
  adapter-observed `Disconnected` requested core, an explicit target-read
  inaccessibility transition, or fresh firmware `resetEvidence`. Evidence must
  declare `freshness` as `transition-to-expected`, `monotonic-increase`, or
  `value-change`; an already-set latch is not accepted. Safety guards continue
  at their configured cadence while the target remains readable, pause only
  across the observed disconnect, and resume immediately after reconnect. The
  step can load symbols only, requires every `resetCauseReads` result to be
  readable, and optionally runs CPU1 before CPU2. It never calls reset, program
  load, or a PC write. Timeout fails closed as `TargetResetNotObserved`.
- `restorePrograms`: an `on: always` isolation step with explicit CPU1/CPU2
  `{ coreId, outPath, mapPath, outSha256, mapSha256 }`. Before target access it
  validates every path against `allowedReadRoots` and every SHA-256. It then
  performs halt → `loadPrograms` with map-required GS ownership → halt, and
  never runs a core or writes PC. Any failure, including path/hash preflight,
  triggers a fenced halt attempt; an unconfirmed halt quarantines the board.
- `resetReconnectCapture`: `{ coreIds, resetType, settleMs, reload,
  loadPolicy, reads }`, where `reload` is `none`, `symbols`, or `programs`.
  It performs one explicit reset → reconnect → optional reload → capture
  sequence; symbol reload uses `c2000_loadSymbols` and never programs Flash.

Expression assignment, fault injection, run, externally observed reset
reconnect, program restore, and reset/reconnect are non-idempotent checkpoints.
An interruption is routed to manual intervention, not retried or restarted
from the beginning. Every sub-operation carries the
job's current lease secret, fencing token/generation, worker identity,
`sessionId`, and explicit `coreId`. Job finalization closes the current session
before releasing the lease even when a plan omits `cleanup` or fails midway.

Passed capture outputs are persisted in SQLite step results. Terminal export
atomically publishes `expression-snapshots.json`; its SHA-256 and size are
committed in `manifest.json` as `evidence:expression-snapshots`, with the
manifest written last as the artifact commit marker. Assignment, injection,
wait, capture-summary, and reset/reconnect results are embedded in the same
manifest under `durableStepResults` (capture arrays remain only in the hashed
snapshot file to avoid duplicating large windows). The shared portable-evidence
sanitizer recursively removes sensitive keys from objects and arbitrarily
nested arrays, including evaluator error details, without changing the SQLite
run record.

Optional plan-level `safetyGuards` declare bounded `eq` conditions with an
explicit `coreId`, expression, and expected value, plus the cores to halt.
Guards start only after `launchMulticore` establishes the current session. The
engine checks them before and after target steps; guarded wait, delay, and run
monitor windows poll them serially through the board worker. No guard read runs
concurrently with another target command. The first mismatch issues a fenced
`haltCores` using the job's current lease, records the evaluation and halt
evidence, and fails the job without retry; an unreadable guard is treated the
same way. If the halt cannot be confirmed, the board is quarantined before its
lease is released. `restorePrograms` and `cleanup` remain executable as
`always` isolation paths after that failure. Guard evaluation is deliberately
skipped before `reconnectAfterTargetReset`, when disconnection is expected,
and resumes immediately after reconnect/capture completes.

Resource limits are fail-closed: at most 128 steps, 256 assignments or faults,
64 read groups, 128 expressions per read, 256 wait or IPC-ready conditions,
1,000 samples,
10,000 expanded evidence values per step, and 20,000 per plan. Labels are at
most 128 characters and expressions/string values at most 512. Durable
timeouts and delays are capped at 24 hours; polling intervals and load/reset
settles are capped at 60 seconds. Runtime output is capped at 2 MiB per step
and 8 MiB across all boards in one job. Terminal export applies the same
8 MiB portable-evidence ceiling, so a multi-board run cannot obtain a separate
budget for each board and then exceed the artifact budget.

Retry policies accept only declared durable step-type keys, with at most one
entry per step type (18 entries total). `maxAttempts` is the total attempt
count, including the first execution, and is capped at 10 in both numeric and
structured forms. Structured `maxAttempts: 1` means no retry. For compatibility,
the legacy numeric shorthand `0` also means one total attempt; it never creates
an unbounded or zero-execution loop. NON_IDEMPOTENT steps still never retry,
regardless of their configured policy, while RECONCILABLE steps must reconcile
before each retry and cannot exceed the same attempt cap.

For the A sequence that needs CPU1 initialized before a CPU2 RAM image is
loaded, `launchMulticore.loadSequence.mode: cpu1-run-before-cpu2` already has
the precise server-side ordering CPU1 load/halt → CPU1 run/settle → CPU2
load/halt → CPU1 halt. It leaves both cores halted and does not rely on CCS UI
focus or an active-target selection.

The manifest is the publication transaction boundary. Failures before it is
written restore the previous manifest/snapshot pair. Artifact indexing or
hash/stat registration failures after publication retain the committed files
and their valid references while marking the export index `FAILED` for later
recovery. If explicit cleanup and the engine's fenced final cleanup both fail,
the job fails and the board is quarantined before its lease is released.

To use real multiple boards, add unique `boardId`, `probeSerial`, `ccxmlPath`,
and tags in `boards[]`, or register them through `c2000_registerBoard`; do not
leave probe allocation to CCS UI focus. Board-bound launch tools fail fast with
`ProbeBindingMissing`, `nextTool: "c2000_registerBoard"`, registered board IDs,
and the standard `{ cpu1: 0, cpu2: 2 }` core convention instead of falling
through to an unfenced local launch.

Example runtime registration:

```json
{
  "boardId": "dk9-cl650001",
  "probeSerial": "CL650001",
  "device": "F28P65x",
  "ccxmlPath": "/allowed/path/TMS320F28P650DK9-CL650001.ccxml",
  "tags": ["dk9"]
}
```

## Two-board CAN acceptance

`c2000_submitMultiBoardCanAcceptance` creates a durable `CAN_PAIR` group,
allocates both board leases, launches isolated sessions, synchronizes the pair
at a timeout-bounded barrier, starts the chosen cores, and records each
direction, frame capture, optional expression observation, and failure in
SQLite. It returns a `jobId` immediately. Querying the job exposes `can.group`
and `can.results` in addition to ordinary step history.

Start with
[`examples/two-board-can.mock.config.json`](examples/two-board-can.mock.config.json)
and
[`examples/two-board-can.mock.request.json`](examples/two-board-can.mock.request.json).
The profile must contain both `board-a → board-b` and `board-b → board-a`
directions. It can declare `drop`, `delay`, or `bus_off` fault scenarios and
cross-board `c2000_evaluateMany` observations.

`profile.adapter: "mock"` is a deterministic simulation only. It validates
pair lifecycle, barriers, matching, injected faults, proxy independence, and
persisted evidence; it does **not** prove real wiring, bit timing, transceiver
state, firmware ISR behavior, or physical frame delivery. The safe default is
`"hardware"`, which fails with `CanAdapterUnavailable` until an application
supplies a real `CanBusAdapter` (USB/CAN, PCAN, Vector, or firmware-backed).
Never report a Mock result as hardware CAN acceptance.

The repository includes no operational SocketCAN, PCAN, Kvaser, or Vector
backend, and the default hardware adapter intentionally fails closed. Firmware
expression observations are debug-side evidence, not independent bus-frame
capture. `acceptance:can:hardware` is configuration preflight only; it sends no
CAN traffic and controls no target.

### Persistent P1 CAN orchestration

Board groups now persist member lease/worker/session evidence, named barriers,
profile hash/version, and conservative reconciliation decisions. Use
`c2000_getBoardGroupSnapshot` for this durable evidence and
`c2000_listCanProfiles` for registered profiles. Profile version 2+ declares
role mappings, read-only safety expressions, and cross-board comparisons; the
daemon evaluates those internally as `group → board → worker/session → core`
and exposes no atomic cross-board CAN I/O MCP tools.

`c2000_submitCanFaultCampaign` and `c2000_submitCanSoakTest` submit finite,
checkpointed jobs. A generic test plan can declare a bounded deterministic
matrix. Interrupted fault/reset/rejoin work is never blindly replayed. Each
successful job registers JSON, Markdown, and JUnit report artifacts. When the
adapter lacks independent bus verification, reports omit a fake CAN trace and
say so explicitly.

Campaign health limits are opt-in. With `failFast: false` and no `health`
limits, every finite case executes and failures are recorded as a `PARTIAL`
campaign. An explicit `maxConsecutiveFailures: 0` or `maxFailureRate: 0`
means the first failure stops the campaign; a successful case is the only event
that resets the consecutive-failure counter.

CAN jobs can use a shared `artifacts` object for compatibility, or choose
distinct firmware with `artifactsByBoard` and/or `artifactsByRole`. Resolution
is `artifactsByBoard[boardId]` → `artifactsByRole[role]` → shared `artifacts`.
The scheduler materializes role assignments to board IDs before persistence, so
restart behavior remains deterministic.

Useful local verification commands:

```bash
npm run verify:daemon-proxy
npm run verify:can:mock
npm run acceptance:can:hardware
```

`acceptance:can:hardware` is a configuration-only preflight: it checks two
distinct F28P65x board/probe bindings and performs no target control, CAN
traffic, power enable, PWM-trip modification, or contactor action.
Read-only startup diagnosis:

```bash
npm run doctor
```

The doctor uses only Node built-ins. It starts the built MCP without touching the target, completes the MCP initialize handshake, lists tools, and calls `c2000_getServerHealth`. On failure it prints structured JSON with a failure code, remediation, and captured server stderr.

Use `npm run doctor:isolated` to copy the full proxy/daemon/worker runtime into a temporary directory with no adjacent `node_modules` and perform the same handshake. `npm run verify:runtime-cwd` goes further: it starts the stdio proxy from an unrelated temporary working directory, auto-starts a detached daemon, and verifies a Mock worker reaches `READY`. These are the release checks that the configured artifact is genuinely self-contained and independent of the MCP host's cwd.

## Startup Resilience

The configured entrypoint remains `dist/src/index.js`, but it is now a self-contained bundle rather than a thin file that imports runtime packages from `node_modules`. This prevents a damaged transitive package from silently removing every `c2000_*` tool on the next Codex session startup.

Startup events are written as one-line JSON to stderr, never stdout. A successful process emits `c2000_mcp_ready`; failures identify `load-config`, `create-server`, or `connect-transport` and include a repair action. Set `C2000_MCP_STARTUP_DIAGNOSTICS=quiet` to suppress only the ready event; errors remain visible.

If a client reports an empty tool list:

1. Run `npm run doctor`.
2. If the runtime artifact is missing, run `npm ci && npm run build`.
3. Re-run `npm run doctor` and confirm `runtime.bundled === true`.
4. Restart or reload the MCP client so it performs a fresh `initialize` and `tools/list` handshake.

These checks do not connect XDS110, create a debug session, load programs, reset cores, or run the target.

## Debug Workflow Performance

High-level one-shot workflows use `sessionMode: "ephemeral"` by default and close the logical DebugSession, Persistent DSS process, and probe lease in a unified `finally` cleanup. Use `interactive` only for consecutive read/run/halt operations, then explicitly close the session.

The CCS adapter uses operation-specific timeouts under `ccs.timeouts`: short state/expression/address/shutdown deadlines remain independent from the long program-load deadline. `C2000_MCP_DSS_TIMEOUT_MS` remains a compatibility fallback. The board worker command floor is 60 seconds, and load/launch workflows automatically receive an outer timeout envelope large enough for their nested CCS startup, connect, reset, and per-program load budgets.

Persistent DSS now keeps one request-correlated TCP channel per explicit core. Commands on one core are serialized, responses are matched by `requestId`, and one reconnect is attempted without changing the bound `coreId`/`coreName`. Expression reads use one `evaluateMany` DSS command per core. Adaptive IPC polling groups and deduplicates conditions, using 50 ms through 500 ms, 100 ms through 2 seconds, then 250 ms unless a schedule is supplied.

`c2000_waitForExpressionSet` also groups all conditions by core for each poll
and returns `pollIterations`, `expressionBatchCalls`, `expressionCount`,
`pollDurationMs`, and `matchedAtMs` when matched. Use these fields for bounded
latency/WCET evidence before increasing the timeout.

Program loading supports `always`, `if-changed`, and
`verify-mcp-registry`. The last policy only compares canonical path, size,
mtime, SHA-256, and the loaded-program registry for the same MCP session; it
returns `targetFlashVerified: false` and must not be presented as target Flash
verification. `verify-only` remains a deprecated alias. A bounded host cache
shares hashes between loading and ELF freshness checks.

For firmware that is already resident in Flash, use `c2000_loadSymbols` with
the matching `.out` file. It calls the DSS symbol loader only and returns
`targetMemoryWritten: false`; it does not erase or program Flash and does not
insert a false entry into the MCP loaded-program registry.

Full Debug Bundle captures a `DebugEvidence` object once; diagnosis and bundle writing consume that evidence rather than reading snapshot, PC, and expressions again. Workflow results expose polling and total-duration metrics. Inspect `performance` before increasing timeouts.

Run the deterministic mock comparison with `npm run benchmark:debug`. `npm run benchmark:hardware` is explicitly opt-in and reports a skip unless the CCS/XDS110 environment is supplied; it never fabricates board timings.

## Client Config

Codex, Claude Desktop, ChatGPT MCP clients, or other stdio MCP hosts can spawn the built server:

```json
{
  "mcpServers": {
    "c2000-multicore": {
      "command": "node",
      "args": [
        "/absolute/path/to/c2000-multicore-mcp/dist/src/index.js"
      ],
      "env": {
        "C2000_MCP_CONFIG": "/absolute/path/to/c2000-multicore-mcp/examples/f28p65x.config.json"
      }
    }
  }
}
```

For local development:

```json
{
  "mcpServers": {
    "c2000-multicore-dev": {
      "command": "npx",
      "args": [
        "tsx",
        "/absolute/path/to/c2000-multicore-mcp/src/index.ts"
      ],
      "env": {
        "C2000_MCP_CONFIG": "/absolute/path/to/c2000-multicore-mcp/examples/f28p65x.config.json"
      }
    }
  }
}
```

### Automatic recovery for Codex

For an installed build, point Codex at `scripts/mcp-supervisor.mjs` instead of
starting `dist/src/index.js` directly. The supervisor is an MCP-aware stdio
proxy: after an unexpected server exit it starts a fresh server, replays the
MCP initialization handshake, then resumes forwarding new requests. Its own
diagnostics go to stderr, so stdout remains a JSON-RPC-only MCP channel.

Add the following to the Codex `config.toml`, replacing both absolute paths:

```toml
[mcp_servers.c2000-multicore]
command = "node"
args = [
  "C:/absolute/path/to/c2000-multicore-mcp/scripts/mcp-supervisor.mjs",
  "--initial-delay-ms", "1000",
  "--max-delay-ms", "10000",
  "--max-restarts", "5",
  "--",
  "node",
  "C:/absolute/path/to/c2000-multicore-mcp/dist/src/index.js"
]

[mcp_servers.c2000-multicore.env]
C2000_MCP_CONFIG = "C:/absolute/path/to/c2000-multicore-mcp/examples/f28p65x.config.json"
```

The restart limit applies within a 60-second window. Options `--restart-window-ms`,
`--initial-delay-ms`, `--max-delay-ms`, and `--max-restarts` tune that policy.
`npm run start:supervised` offers the same wrapper for a manually launched
server when `C2000_MCP_CONFIG` is already set.

An interrupted MCP call is intentionally **not replayed** after a restart:
repeating a load, reset, run, or memory-write command could alter the board a
second time. Once the channel has recovered, inspect the target and explicitly
retry only the operation that is still appropriate. If recovery reaches its
restart limit, the supervisor exits so Codex can surface the failure instead
of hiding a crash loop.

## Codex Skill

This repository includes a lightweight Codex Skill at:

```text
.skills/c2000-multicore-debug/SKILL.md
```

The skill teaches Codex to prefer high-level `c2000-multicore-mcp` workflow tools for F28P65x CPU1/CPU2 debugging, especially `c2000_launchAndRunIpcAcceptance` when no session exists and `c2000_runIpcAcceptance` for an existing connected session, instead of chaining many atomic MCP calls that may each trigger an approval dialog.

To make the skill discoverable by Codex, copy or symlink the folder into your Codex skills directory:

```bash
mkdir -p ~/.codex/skills
ln -s "$(pwd)/.skills/c2000-multicore-debug" ~/.codex/skills/c2000-multicore-debug
```

Then invoke it explicitly when needed:

```text
Use $c2000-multicore-debug to run IPC acceptance on this F28P65x dual-core session.
```

The skill is only guidance for Codex. The actual target control still comes from the MCP tools exposed by this server.

## Configuration

Example:

```json
{
  "adapter": "mock",
  "ccs": {
    "installPath": "C:/ti/ccs",
    "workspacePath": "D:/workspace",
    "ccxmlPath": "D:/workspace/targetConfigs/TMS320F28P650DK9.ccxml",
    "scriptingMode": "mock"
  },
  "target": {
    "name": "F28P65x",
    "coreMap": [
      { "coreId": 0, "coreName": "C28xx_CPU1", "corePattern": "C28xx_CPU1" },
      { "coreId": 2, "coreName": "C28xx_CPU2", "corePattern": "C28xx_CPU2" }
    ]
  },
  "logging": {
    "level": "info",
    "logFile": "./logs/c2000-multicore-mcp.log"
  }
}
```

`target.coreMap` must use unique `coreId` values and unique target selectors. The target selector is `corePattern` when present, otherwise `coreName`. Use the exact CCS selectors `C28xx_CPU1` and `C28xx_CPU2`; do not wrap them in regular expressions such as `.*C28xx_CPU1.*`. Duplicate IDs are rejected with `DuplicateCoreId`; duplicate target selectors are rejected with `DuplicateCoreTarget`. Both checks protect the internal `sessionId -> coreId -> DebugSession` mapping from becoming ambiguous.

### Adapter selection (`adapter` / `ccs.scriptingMode`)

| Value | Behavior |
| --- | --- |
| `mock` | Always use `MockDebugAdapter` (no CCS/DSS). |
| `ccs` | Always use `CcsScriptingAdapter` + persistent DSS bridge. |
| `auto` | Prefer `ccs.scriptingMode` when `adapter` is `auto`. If that is also `auto`, **probe** for `ccs_base/scripting/bin/dss.sh` (or `dss.bat` on Windows). Search order: explicit `ccs.installPath` → `C2000_MCP_CCS_INSTALL_PATH` → multi-version discovery under `/Applications/ti`, `~/ti` (and Windows `C:\\ti` / `D:\\ti`), preferring the highest `ccsNNNN` product tree → last-resort default `/Applications/ti/ccs2100/ccs`. DSS found → `ccs`; otherwise → `mock`. |

On startup the server logs `debug adapter selected` with `mode`, `requested`, `reason`, and when available `ccsInstallPath` / `ccsInstallSource`. Prefer explicit `mock` or `ccs` in committed configs so environments do not silently change when CCS is installed or removed.

Notes:

- `ccs.installPath` pins DSS discovery and launch when set; otherwise multi-version CCS discovery runs.
- `ccs.workspacePath` / `C2000_MCP_WORKSPACE_PATH` is used as: (1) base directory for relative `programUri` / `mapUri` resolution, (2) DSS process `cwd`, (3) env hints `C2000_MCP_WORKSPACE_PATH`, `WORKSPACE`, `CCS_WORKSPACE`. Exposed on `c2000_getSessionTopology.workspacePath`.
- `ccs.ccxmlPath` / `C2000_MCP_CCXML_PATH` are auto-injected when a tool omits `ccxmlPath` on `c2000_createDebugSession` / launch workflows (explicit tool args still win).
- `target.coreMap` from config is used as the default core map when create/launch omit `coreMap`.
- Optional `diagnostics.cpu1BootExpressions` / `diagnostics.cpu2BootExpressions` override the default Hybrid30k boot symbol lists used by diagnosis tools.
- Per-session operations are serialized with an internal queue so concurrent MCP tool calls on the same `sessionId` do not interleave connect/load/run sequences.
- Persistent DSS sessions are disposed on `SIGINT` / `SIGTERM` / `beforeExit`, and base ports are probed before bind with retry on conflict.

### Tool surface (prefer workflows / primary atomics)

There are many tools by design (host gates, atomics, batches, workflows). Semantic overlap is intentional for TI MCP naming; **aliases are marked, not duplicated logic**:

| Prefer | Avoid (alias) |
| --- | --- |
| `c2000_runCore` | `c2000_continue` |
| `c2000_haltCore` | `c2000_pause` |

Prefer one workflow (`c2000_launchAndRunIpcAcceptance`, `c2000_runIpcAcceptance`, `c2000_runBootHandoffDiagnosis`, `c2000_runReloadAndDiagnose`, `c2000_runFullDebugBundle`) over long atomic chains. Call `c2000_getToolContracts` for `tools[]` plus `toolSurface` (`families`, `preferredWorkflows`, `preferredAtomics`, `aliases`, `guidance`).

Environment overrides:

- `C2000_MCP_CONFIG`
- `C2000_MCP_ADAPTER=mock|ccs|auto`
- `C2000_MCP_CCS_INSTALL_PATH`
- `C2000_MCP_C2000WARE_PATH`
- `C2000_MCP_WORKSPACE_PATH`
- `C2000_MCP_CCXML_PATH`
- `C2000_MCP_DSS_TIMEOUT_MS` (default hardware acceptance value: `300000`)
- `C2000_MCP_REQUEST_TIMEOUT_MS` (end-to-end MCP/daemon long-operation response timeout; default: `600000`)
- `C2000_MCP_PROBE_QUEUE_DIR` (shared FIFO lease directory; every MCP instance must use the same absolute path)
- `C2000_MCP_PROBE_QUEUE_TIMEOUT_MS` (default: `600000`)
- `C2000_MCP_PROBE_RECOVERY_POLICY=block|owned-and-stale|terminate-external` (default: `owned-and-stale`)
- `C2000_MCP_PROBES_JSON` (optional JSON array defining the multi-board pool)
- `C2000_MCP_MULTI_BOARD_ENABLED=true` (explicit multi-board opt-in; default is false)
- `C2000_PROGRAM_SEARCH_ROOTS`
- `C2000_MCP_LOG_LEVEL=debug|info|warn|error`
- `C2000_MCP_LOG_FILE`

Windows paths are plain JSON strings. Escape backslashes or use forward slashes.

TI paths use this priority: environment/config values, validated automatic discovery, then an unresolved result with all attempted paths. On macOS the resolver checks `$HOME/ti/ccs*/ccs`, `$HOME/ti/c2000/C2000Ware_*`, and `/Applications/ti`; it validates CCS with the `DSLite` executable and C2000Ware with `.metadata/sdk.json`. The F28P65x `.ccxml` path is derived only from a validated C2000Ware installation. Call `c2000_getEnvironment` to see the selected canonical paths, versions, sources, and rejected candidates. Do not copy an example installation path without validating it first.

## Tools

Phase 0 read-only host checks:

- `c2000_getServerHealth`
- `c2000_getEnvironment`
- `c2000_getToolContracts`
- `c2000_getDebugBoundary`
- `c2000_getAcceptanceEvidence`
- `c2000_getHardwarePreflight`
- `c2000_discoverAcceptancePrograms`
- `c2000_getAcceptanceReadiness`

Phase 1:

- `c2000_createDebugSession`
- `c2000_closeDebugSession`
- `c2000_listCores`
- `c2000_getSessionTopology`
- `c2000_connectTarget`
- `c2000_disconnectTarget`
- `c2000_runCore`, `c2000_continue`
- `c2000_haltCore`, `c2000_pause`
- `c2000_reset`
- `c2000_getTargetState`
- `c2000_loadProgram`
- `c2000_loadPrograms`
- `c2000_connectCores`
- `c2000_haltCores`
- `c2000_resetCores`
- `c2000_runCores`
- `c2000_getMulticoreSnapshot`

Phase 2:

- `c2000_evaluateMany`
- `c2000_getLoadedProgramInfo`
- `c2000_resolvePc` (PC read succeeds even when symbol mapping is partial)
- `c2000_resolveAddress` (honest: no fake symbol/source map; often `success: false`, `partial: true`)
- `c2000_waitUntilExpression`
- `c2000_waitForExpressionSet`
- `c2000_diagnoseCpu2Boot`
- `c2000_verifyRunPauseIsolation`
- `c2000_assignExpression` (default `verify: true`; fails on readback mismatch)
- `c2000_assignExpressions`
- `c2000_injectFaults`
- `c2000_compareExpressions`
- `c2000_analyzeRamOwnership`
- `c2000_diagnoseBootHandoff`
- `c2000_waitForIpcReady`
- `c2000_reloadResetRunToMain`

Phase 3:

- `c2000_launchMultiBoardDebug`
- `c2000_launchMulticoreDebug`
- `c2000_launchAndRunIpcAcceptance`
- `c2000_runIpcAcceptance`
- `c2000_runBootHandoffDiagnosis`
- `c2000_runReloadAndDiagnose`
- `c2000_runFullDebugBundle`

All tool responses include `success`, `timestamp`, and scoped fields such as `sessionId`, `coreId`, `coreName`.

`c2000_getServerHealth` is available in `readonly`, `safe`, and `full` profiles. It reports server/runtime version, whether the active artifact is bundled, process uptime, selected adapter and tool profile, configured TI path presence, and the exact registered tool names. It is host-read only and never enumerates or controls the target.

Each registered tool definition also declares `inputScope` and `targetEffect` contracts. Core-scoped debug tools use `inputScope: "core"` and must expose both `sessionId` and `coreId`; host-only tools such as `c2000_getDebugBoundary`, `c2000_getHardwarePreflight`, `c2000_discoverAcceptancePrograms`, `c2000_getAcceptanceReadiness`, and `c2000_analyzeRamOwnership` use `inputScope: "host"` and do not connect to the target. MCP clients can call `c2000_getToolContracts` to inspect each tool's `inputScope`, `targetEffect`, `inputFields`, `requiredInputFields`, `coreIdentityFields`, and `responseCoreIdentityFields`. Single-core debug controls declare response identity fields `["coreId", "coreName"]`; batch tools declare per-result identity fields; multicore snapshots declare `["cores[].coreId", "cores[].coreName"]`; and `c2000_verifyRunPauseIsolation` declares `["acceptanceSummary.steps[].commandCoreId", "acceptanceSummary.steps[].commandCoreName"]`. Advanced IPC, MSGRAM, parameter-sync, CPU2 bring-up, and fault-injection tools also declare response identity paths, for example `c2000_assignExpressions` and `c2000_injectFaults` use `["results[].coreId", "results[].coreName"]`, `c2000_compareExpressions` uses `["comparisons[].left.coreId", "comparisons[].right.coreId"]`, `c2000_waitForExpressionSet` and `c2000_waitForIpcReady` use `["conditions[].coreId"]`, `c2000_analyzeRamOwnership` uses `["maps[].coreId", "ownershipActions[].targetCoreId"]`, `c2000_diagnoseCpu2Boot` uses `["cpu1.coreId", "cpu2.coreId", "snapshot.cores[].coreId"]`, and `c2000_diagnoseBootHandoff` also includes `["ramOwnership.maps[].coreId"]` when map evidence is supplied. `c2000_reloadResetRunToMain` declares `["coreId", "coreName"]` and reports the current adapter limitation for true breakpoint/run-to-symbol behavior. Workflow tools such as `c2000_runIpcAcceptance`, `c2000_runBootHandoffDiagnosis`, `c2000_runReloadAndDiagnose`, and `c2000_runFullDebugBundle` declare `targetEffect: "launch-workflow"` because they perform multi-step orchestration inside the MCP server. `c2000_launchMulticoreDebug` declares response identity paths for its snapshot, post-launch actions, post-launch checks, and nested run/pause isolation summary. The readiness and hardware acceptance scripts assert these response identity contracts before any target connection or launch step, so weak contracts fail fast before touching the board.

For automated boundary checks, call `c2000_getDebugBoundary` and assert:

- `officialTiMcpDebugControlsUsed === false`
- `activeTargetAllowed === false`
- `uiFocusRequired === false`
- `requiredPerCoreInputs` contains only `sessionId` and `coreId`
- `coreIdConvention["0"] === "C28xx_CPU1"` and `coreIdConvention["2"] === "C28xx_CPU2"`
- `forbiddenOfficialDebugTools` includes `continue`, `pause`, `reset`, `connectTarget`, `disconnectTarget`, and `getTargetState`
- `c2000DebugTools` includes the `c2000_` tools used for per-core target control
- `perCoreDebugSessionMethods.c2000_runCore === "session.target.runAsynch()"`
- `perCoreDebugSessionMethods.c2000_continue === "session.target.runAsynch()"`
- `perCoreDebugSessionMethods.c2000_haltCore === "session.target.halt()"`
- `perCoreDebugSessionMethods.c2000_pause === "session.target.halt()"`
- `perCoreDebugSessionMethods.c2000_loadProgram === "session.memory.loadProgram(programUri)"`
- `realAdapter.defaultBridge === "PersistentDssBridge"`
- `realAdapter.statelessDssCliBridgeUsedForDebugAutomation === false`

Call `c2000_getAcceptanceEvidence` when a client needs a machine-readable map from final acceptance requirements to proof sources before running target-touching acceptance. It returns `evidence: "c2000_multicore_acceptance_evidence_plan"`, `hostReadinessTool: "c2000_getAcceptanceReadiness"`, `hardwareAcceptanceTool: "c2000_verifyRunPauseIsolation"`, and a `requirements` array covering the four CPU1/CPU2 run/pause isolation criteria, `c2000_getMulticoreSnapshot` fields, explicit `debug_tool_contracts`, explicit `multicore_tool_contracts`, explicit `core_read_tool_contracts`, explicit `advanced_automation_contracts`, and the UI-independence evidence. Each run/pause requirement also records `checkedCommandFields: ["coreId", "coreName"]` and `checkedPeerFields: ["connected", "state", "pc", "loadedProgram", "loadedProgramInfo"]`, matching the fields enforced by `acceptanceSummary`. The `debug_tool_contracts` requirement points at `c2000_getToolContracts` and records the core debug tools, including `c2000_runCore`/`c2000_haltCore` aliases and `c2000_continue`/`c2000_pause`, that must require `sessionId` plus `coreId` and return `["coreId", "coreName"]`. The `multicore_tool_contracts` requirement records `c2000_loadPrograms`, batch core controls, and `c2000_getMulticoreSnapshot` with their explicit core identity input paths and response identity fields. The `core_read_tool_contracts` requirement records `c2000_evaluateMany`, `c2000_getLoadedProgramInfo`, `c2000_resolvePc`, `c2000_resolveAddress`, and `c2000_waitUntilExpression`; each must require explicit `sessionId` plus `coreId`, expose `coreIdentityFields: ["coreId"]`, and return `["coreId", "coreName"]`. The `advanced_automation_contracts` requirement records RAM ownership analysis, IPC/MSGRAM, parameter synchronization, fault injection, CPU2 bring-up, reload/reset/run, and launch workflow tools with their explicit per-core identity input and response paths. This tool is host-read only; it does not create a session, connect, load, run, pause, or reset the target.

`c2000_getSessionTopology` is a read-only session tool for auditing the logical mapping before target control. It returns `adapterName`, `adapterSessionId`, `debugSessionRoute: "sessionId -> adapterSessionId -> coreId -> DebugSession"`, and each core's `coreId`, `coreName`, optional `corePattern`, resolved `targetSelector`, and `debugSessionKey`. It does this without connecting, halting, running, loading, or reading target state.

`targetEffect` is machine-readable side-effect metadata for clients that need to avoid changing a connected board accidentally:

- `host-read`: read-only host checks, no target connection.
- `session-read`: read-only logical session metadata.
- `session-lifecycle`: create or dispose the logical debug session.
- `target-read`: read target state, symbols, PC, loaded-program registry, or poll expressions.
- `connectivity-control`: connect or disconnect explicit cores.
- `execution-control`: run, halt, pause, or perform run/pause isolation checks.
- `reset-control`: reset explicit cores.
- `program-load`: load `.out` images to explicit cores.
- `memory-write`: write target expressions for fault injection or synchronization tests.
- `launch-workflow`: perform a composed launch flow that may connect, load, halt, poll, diagnose, or run/pause depending on request options.

Failures return:

```json
{
  "success": false,
  "error": {
    "code": "CoreNotFound",
    "message": "Core 9 was not found",
    "details": {}
  }
}
```

Batch tools such as `c2000_connectCores`, `c2000_loadPrograms`, `c2000_haltCores`, `c2000_resetCores`, and `c2000_runCores` return `success: false` with `error.code: "BatchOperationFailed"` if any per-core item in `results` fails. Clients should still inspect `results` for per-core diagnostics.

## Typical RAM Debug Flow

1. `c2000_createDebugSession`
2. `c2000_connectCores({ "sessionId": "dbg-...", "coreIds": [0, 2] })`
3. `c2000_resetCores({ "sessionId": "dbg-...", "coreIds": [0, 2], "resetType": "cpu" })`
4. `c2000_loadPrograms({ "sessionId": "dbg-...", "programs": [{ "coreId": 0, "programUri": "cpu1.out" }, { "coreId": 2, "programUri": "cpu2.out" }] })`
5. `c2000_getMulticoreSnapshot({ "sessionId": "dbg-..." })`
6. `c2000_continue({ "sessionId": "dbg-...", "coreId": 0 })`
7. Run CPU2 only when CPU1 boot/release and IPC/MSGRAM initialization make that valid.
8. `c2000_evaluateMany` for IPC variables:
   - `g_stCoreCommCpu1Watch.emStage`
   - `g_stCoreCommCpu1Watch.uiCpu2Ready`
   - `g_stCoreCommCpu1Watch.ulCpu2BootLastError`
   - `g_stCoreCommCpu2Watch.emStage`
   - `g_stCoreCommCpu2Watch.ulInitParamSnapSeq`
   - `g_stCoreCommCpu2Watch.uiInitParamApplied`
9. If stuck, `c2000_haltCores`, then `c2000_resolvePc` (for PC) or `c2000_resolveAddress` (address only; symbol mapping may be `partial` / not implemented).
10. `c2000_diagnoseCpu2Boot` to collect CPU1/CPU2 PC, snapshot, CPU1 IPC stage/ready/error fields, and CPU2 stage.
11. `c2000_analyzeRamOwnership` for host-side `.map` RAMGS ownership evidence.
12. `c2000_diagnoseBootHandoff` to combine CPU2 boot diagnosis with RAM ownership evidence.
13. `c2000_waitForIpcReady` to wait for the default CPU1/CPU2 IPC-ready symbols or supplied explicit conditions.
14. `c2000_assignExpression`, `c2000_assignExpressions`, or `c2000_injectFaults` for explicit-core fault injection.
15. `c2000_compareExpressions` for IPC, MSGRAM, and parameter synchronization checks.
16. `c2000_waitForExpressionSet` to wait for CPU1/CPU2 bring-up conditions.
17. `c2000_reloadResetRunToMain` for a single explicit core reload + reset + run sequence.
18. `c2000_getMulticoreSnapshot` for issue capture.

## Workflow Tools And MCP Approvals

Many MCP clients show a user approval dialog for every tool call. If an AI agent chains atomic tools externally, for example `c2000_getMulticoreSnapshot`, `c2000_evaluateMany`, `c2000_analyzeRamOwnership`, and `c2000_waitForIpcReady`, the user may see one approval popup per step. That is useful for manual debugging, but it is not a real hierarchical automation path.

The automation main path should use workflow tools. A workflow tool is still one MCP tool call from the client's point of view, so the client only needs one approval. The workflow then performs halt/reset/load/snapshot/map analysis/expression polling/diagnosis/bundle collection inside the MCP server process by directly reusing `DebugSessionManager`, expression evaluation, RAM ownership analyzer, loaded-program registry, and adapter functions. Workflow tools do not call other MCP tools through the MCP client.

`c2000_launchAndRunIpcAcceptance` additionally creates the logical session and connects CPU1/CPU2 before running acceptance, so an unconnected target still requires only one client-visible MCP call.

RAM builds that initialize GS ownership or CPU2 release from CPU1 can set
`"loadSequence": {"mode": "cpu1-run-before-cpu2", "cpu1SettleMs": 250}`.
This explicitly loads and runs CPU1 before the CPU2 image is loaded. The
default remains `"cpu1-then-cpu2"` and introduces no extra pre-load run.

Use atomic tools for manual inspection and bottom-layer validation:

- `c2000_getMulticoreSnapshot`
- `c2000_evaluateMany`
- `c2000_analyzeRamOwnership`
- `c2000_diagnoseBootHandoff`
- `c2000_waitForIpcReady`
- `c2000_reloadResetRunToMain`

Use workflow tools for AI-driven automation:

- `c2000_launchAndRunIpcAcceptance`: preferred default when no debug session exists; it creates the logical session, connects CPU1/CPU2, then runs IPC acceptance in one client-visible call.
- `c2000_runIpcAcceptance`: use when a session already exists and both cores are connected.
- `c2000_runBootHandoffDiagnosis`: one-shot CPU2 boot handoff diagnosis.
- `c2000_runReloadAndDiagnose`: reload/reset/prepare, optionally perform a
  controlled post-load reset and CPU1-first boot, then wait/diagnose. Set
  `postLoadBoot` for freshly programmed Flash; it does not write PC or verify
  resident Flash contents.
- `c2000_runFullDebugBundle`: collect snapshot, loaded-program info, expressions, PC, `.map` evidence, ELF freshness, boot diagnosis, and `summary.md`.

Recommended one-approval call from an unconnected target through `c2000_launchAndRunIpcAcceptance`:

```json
{
  "sessionName": "f28p65x-ipc-acceptance",
  "ccxmlPath": "/path/to/target.ccxml",
  "device": "F28P65x",
  "cpu1CoreId": 0,
  "cpu2CoreId": 2,
  "cpu1OutPath": "/path/to/cpu1.out",
  "cpu2OutPath": "/path/to/cpu2.out",
  "cpu1MapPath": "/path/to/cpu1.map",
  "cpu2MapPath": "/path/to/cpu2.map",
  "resetType": "cpu",
  "runSequence": {
    "runMode": "debugger_runs_both",
    "runCpu1First": true,
    "runCpu2": true,
    "settleMs": 0
  },
  "timeoutMs": 5000,
  "intervalMs": 100,
  "autoCloseOnComplete": true,
  "autoCloseIdleTimeoutMs": 60000,
  "collectDebugBundle": true,
  "outputDir": "/tmp/c2000-ipc-acceptance"
}
```

`runMode` makes the startup contract explicit: `cpu1_boots_cpu2` runs only CPU1 and expects firmware boot handoff, `debugger_runs_both` runs CPU1 then CPU2, and `cpu2_pre_running` starts CPU2 before CPU1. The legacy `runCpu1First`/`runCpu2` fields remain supported when `runMode` is omitted. The result includes the resolved `runPlan`, created `sessionId`, launch connection evidence, `workflow`, `orchestration: "server-internal"`, `mcpToolCalls: []`, explicit CPU IDs, snapshot evidence, RAM ownership analysis, ELF freshness, IPC-ready conditions, boot handoff diagnosis, and optional bundle files. Bundles include both the detailed JSON files and a compact `evidence.json`. On launch failure the server closes the newly created logical session before returning a structured error.

## RAM Ownership Analysis

`c2000_analyzeRamOwnership` is a host-read helper. It parses TI linker `.map` files, reports used `RAMGSx` regions, associates allocated sections with those regions when section addresses are present, and emits CPU1 `MEMCFG_GSXMSEL` write actions needed before loading CPU2 RAM builds. It does not create a debug session, connect, load, run, pause, reset, or read target state.

Example:

```json
{
  "maps": [
    { "coreId": 2, "coreName": "C28xx_CPU2", "mapPath": "/path/to/cpu2.map" }
  ]
}
```

For CPU2 sections in `RAMGS4`, the analysis emits an ownership action with `ownerCoreId: 0`, `targetCoreId: 2`, `address: 0x0005F444`, `value: 0x10`, and `page: "DATA"`. If the map shows multiple used GS blocks (for example RAMGS4 and RAMGS5), analysis still lists per-region actions; **before load**, `DebugSessionManager` merges same-register actions with bitwise OR into **one** write (for example `0x10 | 0x20 = 0x30`). `c2000_loadProgram` and `c2000_loadPrograms` use the same parser when `mapUri` is supplied, or when a sibling `.map` can be derived from the `.out`.

## CPU2 Boot Diagnosis

`c2000_diagnoseCpu2Boot` is a read-only bring-up helper. It does not run, halt, reset, connect, or disconnect targets. It collects:

- `c2000_getMulticoreSnapshot`
- CPU1 PC via `c2000_resolvePc`
- CPU2 PC via `c2000_resolvePc`
- CPU1 expressions:
  - `g_stCoreCommCpu1Watch.emStage`
  - `g_stCoreCommCpu1Watch.uiCpu2Ready`
  - `g_stCoreCommCpu1Watch.ulCpu2BootLastError`
- CPU2 expressions:
  - `g_stCoreCommCpu2Watch.emStage`
  - `g_stCoreCommCpu2Watch.ulInitParamSnapSeq`
  - `g_stCoreCommCpu2Watch.uiInitParamApplied`

Example:

```json
{
  "sessionId": "dbg-...",
  "cpu1CoreId": 0,
  "cpu2CoreId": 2
}
```

This is intended for cases where CPU1 reaches a CPU2 boot/release wait path and CPU2 does not enter its application.

`c2000_diagnoseBootHandoff` wraps the same read-only CPU1/CPU2 boot diagnosis and can add RAM ownership evidence from `.map` files. It returns a compact `verdict` showing whether CPU1 IPC stage/ready/error fields, CPU2 stage evidence, and RAM ownership evidence look ready.

Example:

```json
{
  "sessionId": "dbg-...",
  "cpu1CoreId": 0,
  "cpu2CoreId": 2,
  "maps": [
    { "coreId": 2, "coreName": "C28xx_CPU2", "mapPath": "/path/to/cpu2.map" }
  ]
}
```

`c2000_waitForIpcReady` waits for CPU1/CPU2 IPC-ready conditions. If no custom
`conditions` array is supplied, it polls the current five-condition Hybrid30K
product gate: both stages are running, CPU1 reports CPU2 ready, CPU1 boot error
is clear, and CPU2 has applied the initial parameter snapshot. The monotonically
increasing snapshot sequence is diagnostic evidence rather than an exact-value
gate. Historical `ulMsgRamPass` and `ulParamPass` self-test flags
are intentionally excluded from the default gate. Every condition is evaluated
through the requested `sessionId` and explicit `coreId`.

Example:

```json
{
  "sessionId": "dbg-...",
  "cpu1CoreId": 0,
  "cpu2CoreId": 2,
  "timeoutMs": 5000,
  "intervalMs": 100
}
```

`c2000_reloadResetRunToMain` reloads one explicit core, resets it, runs it, and returns the final explicit-core target state. The current adapter layer has no stable breakpoint or run-to-symbol primitive, so the tool reports `runToMainSupported: false` and `runToMainAchieved: false`; it does not claim that execution stopped at `main`.

Example:

```json
{
  "sessionId": "dbg-...",
  "coreId": 0,
  "programUri": "/path/to/cpu1.out",
  "mapUri": "/path/to/cpu1.map",
  "resetType": "cpu",
  "settleMs": 250
}
```

## Fault Injection

`c2000_assignExpression` assigns one expression on one explicit core. It requires `sessionId`, `coreId`, `expression`, and `value`. By default `verify` is `true`: after the write, the same core re-reads the expression and **fails the tool** if the write reported failure or the readback does not match the assigned value (numeric strings such as `"0"` and `0` compare equal).

| Outcome | Error code |
| --- | --- |
| Adapter write returned `success: false` | `ExpressionAssignFailed` |
| Readback missing, failed, or mismatched (when `verify: true`) | `ExpressionVerifyFailed` |
| Write + matching readback | success with `write` and `readback` fields |

Set `"verify": false` only when you intentionally skip readback (for example a write-only register or a follow-up poll with `c2000_waitUntilExpression`).

Example:

```json
{
  "sessionId": "dbg-...",
  "coreId": 0,
  "expression": "g_stCoreCommCpu1Watch.uiCpu2Ready",
  "value": 0,
  "verify": true
}
```

String values are treated as CCS/C expression fragments, so values such as `"0x1"` or `"MY_ENUM_VALUE"` can be used for target-side assignments. Use `c2000_evaluateMany` on the peer core to confirm the injection did not change unrelated CPU1/CPU2 state.

`c2000_assignExpressions` applies multiple explicit per-core assignments in one request. Every item carries its own `coreId`, `expression`, `value`, and optional `verify` flag (default `true`); the response returns independent per-item results and a top-level failure if any item fails.

Example:

```json
{
  "sessionId": "dbg-...",
  "assignments": [
    { "coreId": 0, "expression": "g_ulHybrid30kBatchFault", "value": 1 },
    { "coreId": 2, "expression": "g_ulHybrid30kBatchFault", "value": 2 }
  ]
}
```

`c2000_injectFaults` is a semantic wrapper for fault campaigns. It uses the same per-core assignment path as `c2000_assignExpression` (including default verify/readback), but each item is named as a fault with an optional `label`. The response includes `summary.total`, `summary.succeeded`, `summary.failed`, and independent per-fault results. This is useful when an acceptance log needs to say which fault case was injected, while still proving every write used an explicit `coreId`.

Example:

```json
{
  "sessionId": "dbg-...",
  "faults": [
    { "label": "cpu1-ipc-drop", "coreId": 0, "expression": "g_ulHybrid30kInjectedFault", "value": 11 },
    { "label": "cpu2-msgram-drop", "coreId": 2, "expression": "g_ulHybrid30kInjectedFault", "value": 22 }
  ]
}
```

## Parameter Synchronization

`c2000_compareExpressions` compares explicit per-core expression pairs. Each side of a comparison must include its own `coreId` and `expression`, so CPU1/CPU2 checks do not depend on CCS UI focus.

Example:

```json
{
  "sessionId": "dbg-...",
  "comparisons": [
    {
      "label": "param-crc",
      "left": { "coreId": 0, "expression": "g_ulHybrid30kCpu1ParamCrc" },
      "right": { "coreId": 2, "expression": "g_ulHybrid30kCpu2ParamCrc" }
    }
  ]
}
```

The result includes a top-level `matched` flag and a per-comparison `matched` flag with both evaluated endpoint values.

## Multicore Wait Conditions

`c2000_waitForExpressionSet` polls explicit per-core conditions until every condition matches or the timeout expires. It is intended for boot, IPC, MSGRAM, and parameter synchronization gates that span CPU1 and CPU2.

Example:

```json
{
  "sessionId": "dbg-...",
  "conditions": [
    { "label": "cpu1-cpu2-ready", "coreId": 0, "expression": "g_stCoreCommCpu1Watch.uiCpu2Ready", "expected": 1 },
    { "label": "cpu2-stage", "coreId": 2, "expression": "g_stCoreCommCpu2Watch.emStage", "expected": 5 }
  ],
  "timeoutMs": 5000,
  "intervalMs": 100
}
```

The result includes `matched`, `timedOut`, and the latest per-condition evaluation result.

## Advanced Launch Flow

### Multi-board allocation

`c2000_launchMultiBoardDebug` dispatches one MCP request across multiple physically connected boards. Each entry must provide a unique XDS110 `probeSerial` and a `.ccxml` that contains that serial-number binding. The tool performs one host preflight, rejects missing or duplicate probes, creates isolated sessions in sequence, and rolls back already-created sessions if a later board fails. Sessions remain simultaneously usable after allocation; sequential setup avoids overlapping operations in the current CCS adapter.

```json
{
  "ccsInstallPath": "D:/ccs21.0/ccs",
  "boards": [
    {
      "boardId": "board-a",
      "probeSerial": "CL650001",
      "ccxmlPath": "D:/workspace/targetConfigs/F28P650DK9_XDS110_CL650001.ccxml",
      "cores": [
        { "coreId": 0, "coreName": "C28xx_CPU1", "connect": true, "load": false, "haltAtEntry": false },
        { "coreId": 2, "coreName": "C28xx_CPU2", "connect": true, "load": false, "haltAtEntry": false }
      ]
    },
    {
      "boardId": "board-b",
      "probeSerial": "CL650002",
      "ccxmlPath": "D:/workspace/targetConfigs/F28P650DK9_XDS110_CL650002.ccxml",
      "cores": [
        { "coreId": 0, "coreName": "C28xx_CPU1", "connect": true, "load": false, "haltAtEntry": false },
        { "coreId": 2, "coreName": "C28xx_CPU2", "connect": true, "load": false, "haltAtEntry": false }
      ]
    }
  ]
}
```

The response returns `results[]` with `boardId`, `probeSerial`, `sessionId`, and the per-board multicore snapshot. Use the returned `sessionId` with the existing explicit `coreId` tools for subsequent per-board work.

`c2000_launchMulticoreDebug` creates the logical session, connects/loads/halts the requested cores, captures an initial snapshot, and can optionally run post-launch checks.

Example:

```json
{
  "sessionName": "f28p65x-ram-debug",
  "programDiscovery": {
    "enabled": true,
    "searchRoots": ["/Users/wangxuwen/workspace_ccstheia"]
  },
  "cores": [
    { "coreId": 0, "coreName": "C28xx_CPU1" },
    { "coreId": 2, "coreName": "C28xx_CPU2" }
  ],
  "postLaunchActions": {
    "assignExpressions": [
      { "coreId": 0, "expression": "g_ulHybrid30kLaunchBatchFault", "value": 7 },
      { "coreId": 2, "expression": "g_ulHybrid30kLaunchBatchFault", "value": 7 }
    ],
    "injectFaults": [
      { "label": "launch-cpu1-fault", "coreId": 0, "expression": "g_ulHybrid30kLaunchInjectedFault", "value": 9 },
      { "label": "launch-cpu2-fault", "coreId": 2, "expression": "g_ulHybrid30kLaunchInjectedFault", "value": 9 }
    ]
  },
  "postLaunchChecks": {
    "waitForExpressionSet": {
      "conditions": [
        { "label": "cpu1-cpu2-ready", "coreId": 0, "expression": "g_stCoreCommCpu1Watch.uiCpu2Ready", "expected": 1 },
        { "label": "cpu2-stage", "coreId": 2, "expression": "g_stCoreCommCpu2Watch.emStage", "expected": 5 }
      ],
      "timeoutMs": 5000,
      "intervalMs": 100
    },
    "compareExpressions": [
      {
        "label": "launch-batch-fault-sync",
        "left": { "coreId": 0, "expression": "g_ulHybrid30kLaunchBatchFault" },
        "right": { "coreId": 2, "expression": "g_ulHybrid30kLaunchBatchFault" }
      },
      {
        "label": "launch-injected-fault-sync",
        "left": { "coreId": 0, "expression": "g_ulHybrid30kLaunchInjectedFault" },
        "right": { "coreId": 2, "expression": "g_ulHybrid30kLaunchInjectedFault" }
      }
    ],
    "diagnoseCpu2Boot": { "cpu1CoreId": 0, "cpu2CoreId": 2 },
    "verifyRunPauseIsolation": { "cpu1CoreId": 0, "cpu2CoreId": 2, "settleMs": 250 }
  }
}
```

When `programDiscovery.enabled` is true, `c2000_launchMulticoreDebug` runs the same CPU1/CPU2 `.out` discovery used by `c2000_discoverAcceptancePrograms` before creating the debug session. Explicit per-core `programUri` values still win; missing `programUri` values for `coreId: 0` and `coreId: 2` are filled from the discovered CPU1/CPU2 programs. The launch response includes `programDiscovery` so the acceptance log records exactly which `.out` files were loaded. If a core has `load: true` and no explicit or discovered `programUri`, launch fails with `error.code: "LaunchProgramMissing"` and cleans up any created session.

`postLaunchActions.assignExpressions` and `postLaunchActions.injectFaults` run after connect/load/halt and the initial snapshot, and before post-launch checks. They use the same explicit per-item `coreId` contract as `c2000_assignExpressions` and `c2000_injectFaults`; any failed item makes the launch fail and triggers cleanup. `postLaunchChecks.compareExpressions` requires all comparisons to match, otherwise the launch fails and is cleaned up.

`verifyRunPauseIsolation` is opt-in because it runs and pauses targets. It is intended for explicit acceptance, not routine non-invasive snapshots. The tool response includes `acceptanceSummary`, a compact machine-readable verdict for `c2000_continue(cpu1)`, `c2000_pause(cpu1)`, `c2000_continue(cpu2)`, and `c2000_pause(cpu2)`.

When post-launch actions or checks are requested, they are part of the launch verdict. `assignExpressions` and `injectFaults` must return successful per-item results, `waitForExpressionSet` must return `matched: true`, `compareExpressions` must return `matched: true`, and `verifyRunPauseIsolation` must return `acceptanceSummary.success: true`. A failed action returns `success: false` with `error.code: "PostLaunchActionFailed"`. A timeout, failed comparison, failed isolation step, or malformed isolation summary returns `success: false` with `error.code: "PostLaunchCheckFailed"` plus the captured `snapshot`, `postLaunchActions`, and/or `postLaunchChecks` evidence.

If `c2000_launchMulticoreDebug` fails after creating a logical session, it calls `c2000_closeDebugSession` internally and returns the failed `sessionId` with `cleanedUp: true` when cleanup succeeds. This avoids leaving persistent DSS sessions alive after a partial connect/load/check failure. Successful launches preserve the session by default. With `autoCloseOnComplete: true`, the session remains usable and is closed only after `autoCloseIdleTimeoutMs` passes with no in-flight or recent session-scoped MCP call. This prevents a long-running load, expression wait, snapshot, or diagnosis from being terminated by automatic cleanup.

## Mock Verification

```bash
npm test
npm run build
npm run verify:debug-boundary
npm run verify:host
npm run smoke
npm run smoke:mcp
```

The smoke test creates a mock F28P65x session, connects CPU1/CPU2, resets, loads two temporary `.out` files, runs CPU1, evaluates IPC symbols, and prints a final snapshot.

`npm run verify:debug-boundary` is a host-only source guard. It scans `src` and `scripts` for forbidden active-target/current-target, CCS UI focus/selected CPU, and TI official MCP debug fallback patterns. It exits with code `1` and prints `debugBoundarySourceScan.offenders` if a forbidden pattern is introduced.

The MCP stdio smoke test starts the built server through `StdioClientTransport`, lists registered tools, calls `c2000_getDebugBoundary`, `c2000_getAcceptanceEvidence`, `c2000_getHardwarePreflight`, `c2000_discoverAcceptancePrograms`, and `c2000_getAcceptanceReadiness`, creates a mock debug session, connects/loads CPU1 and CPU2, reloads CPU1 through single-core `c2000_loadProgram`, runs/pauses CPU1 and CPU2 by explicit `coreId`, reads `c2000_getTargetState`, exercises `c2000_reset` and `c2000_disconnectTarget`, verifies `c2000_assignExpressions` and `c2000_injectFaults` write distinct values per core, verifies the four-step `c2000_verifyRunPauseIsolation` `acceptanceSummary`, reads `c2000_getMulticoreSnapshot`, verifies each loaded core reports both `loadedProgram` and trusted `loadedProgramInfo` metadata, and closes the session through MCP `tools/call`.

`npm run verify:host` is the single host-side gate to run before target-touching hardware acceptance. It runs `verify:debug-boundary`, TypeScript build, unit/contract tests, MCP stdio smoke, and the read-only `acceptance:ready` check, then prints one JSON report with `hostChecksPassed`, `readyForHardwareAcceptance`, `readinessBlocked`, per-step exit codes, `debugProcessDetails`, `uiIndependenceEvidence`, `acceptanceEvidence`, and `nextCommand`. It never runs `acceptance:ccs`, `acceptance:ccs:mcp`, `C2000_RUN_LAUNCH`, or `C2000_RUN_ISOLATION`. Exit code `0` means host checks passed and hardware acceptance is ready; exit code `2` means host checks passed but readiness blockers remain, such as an existing `DSLite` owner; exit code `1` means a host-side code, boundary, build, test, smoke, or readiness execution failed.

## Hardware Acceptance

The hardware acceptance scripts use `CcsScriptingAdapter` and the persistent DSS bridge. They do not call TI official MCP debug control tools. Both the direct handler path and the MCP stdio path validate `c2000_getDebugBoundary` before target control, including `officialTiMcpDebugControlsUsed: false`, `activeTargetAllowed: false`, and the per-core DebugSession method mapping.

On physical F28P65x boards, CPU2 program loading can take several minutes depending on the current target state. The target-touching acceptance scripts default `C2000_MCP_DSS_TIMEOUT_MS` to `300000` ms and pass it into the MCP server / `CcsScriptingAdapter`; the MCP stdio hardware acceptance client defaults `C2000_MCP_REQUEST_TIMEOUT_MS` to `600000` ms so long CCS/DSS operations do not lose their tool response at the SDK layer. Set both explicitly when diagnosing slower CCS/DSS sessions. Timeout errors include the requested `adapterSessionId`, `operation`, `dssCommandName`, `coreId`, `coreName`, DSS process `pid`, exit state, and stdout/stderr tails, including `C2000_DSS_SERVER_EVENT` command lifecycle records.

Read-only preflight checks XDS110 enumeration and possible debug-process owners. It does not connect to the target, load programs, or run CPU1/CPU2. MCP clients can call `c2000_getHardwarePreflight` before creating a debug session:

```json
{
  "ccsInstallPath": "/Applications/ti/ccs2100/ccs"
}
```

`ccsInstallPath` and `C2000_MCP_CCS_INSTALL_PATH` take precedence on every platform. Without either, macOS uses `/Applications/ti/ccs2100/ccs`; Windows searches mounted drives for common CCS layouts such as `D:\\ccs21.0\\ccs` and falls back to `C:\\ti\\ccs2100\\ccs`. It resolves `xdsdfu` on macOS and `xdsdfu.exe` on Windows. Windows acceptance scripts similarly discover the F28P650DK9 `.ccxml` under common C2000Ware layouts; set `C2000_MCP_CCXML_PATH` to override it.

Preflight keeps the legacy `debugProcesses` string array and also returns `debugProcessDetails`, with `pid`, optional `ppid`, optional `elapsed`, `kind`, `command`, and `rawLine` for each possible probe owner. Readiness and hardware acceptance use this structured detail to report blockers such as `93717 DSLite: ./DSLite` without terminating anything automatically.

For one-shot host-side acceptance gating, call
`c2000_getAcceptanceReadiness`. It combines `.ccxml` checks, CPU1/CPU2 `.out`
discovery, XDS110 preflight, debug-process ownership, the debug boundary
contract, UI-independence proof, and the acceptance evidence plan in one
read-only report. In daemon mode it additionally requires a registered board
whose `probeSerial` is currently enumerated, whose route is READY and
unleased, a healthy worker, and available `boardConcurrency`; otherwise
`checks.daemonRoute` names the blocker and directs an empty registry to
`c2000_registerBoard`. Set `waitForProbeMs` plus `probePollIntervalMs` to wait
for an existing debug process to release the probe without killing it; the
response reports `probeWait.requestedMs`, `elapsedMs`, `attempts`, and
`released`. The tool returns `readyForHardwareAcceptance`, `blockers`,
`warnings`, `checks`, `programDiscovery`, `preflight`, `probeWait`,
`debugBoundary`, `uiIndependenceEvidence`, `acceptanceEvidence`, and
`nextCommand`; it does not create a debug session or call any target-control
method. Transient XDS110 launch failures such as Error -260 are retried with
capped exponential backoff.

The same check is also available from the CLI:

```bash
C2000_MCP_CCS_INSTALL_PATH=/Applications/ti/ccs2100/ccs \
npm run acceptance:preflight
```

Before running target-touching acceptance, use the MCP stdio readiness check. It is read-only: it starts the built MCP server, checks `c2000_getToolContracts`, calls `c2000_getAcceptanceReadiness`, and prints `readyForHardwareAcceptance`, `blockers`, and the exact next command. The script also asserts that `nextCommand` enables both `C2000_RUN_LAUNCH=1` and `C2000_RUN_ISOLATION=1` and runs `npm run acceptance:ccs:mcp`, so a malformed handoff to hardware acceptance fails before the target is touched. It does not create a debug session, connect cores, load programs, run, pause, or reset:

```bash
C2000_MCP_CCS_INSTALL_PATH=/Applications/ti/ccs2100/ccs \
C2000_MCP_CCXML_PATH=/Applications/ti/C2000Ware_26_01_00_00_STS/device_support/f28p65x/common/targetConfigs/TMS320F28P650DK9.ccxml \
C2000_CPU1_OUT=/Users/wangxuwen/workspace_ccstheia/hybrid30k_f28p65x_ipc_cpu1/CPU1_RAM/hybrid30k_f28p65x_ipc_cpu1.out \
C2000_CPU2_OUT=/Users/wangxuwen/workspace_ccstheia/hybrid30k_f28p65x_ipc_cpu2/CPU2_RAM/hybrid30k_f28p65x_ipc_cpu2.out \
npm run acceptance:ready
```

`acceptance:ready` exits with code `0` only when the host-side checks pass and no existing debug-related process appears to own the XDS probe. It exits with code `2` when the report was produced but blockers remain, such as an existing `DSLite` process. To intentionally accept that risk, set `C2000_ALLOW_EXISTING_DEBUG_PROCESSES=1`; readiness then records the existing owner under `warnings`, marks `debugProcessOwnership.overrideAccepted: true`, and includes the same override in `nextCommand`.

If `C2000_CPU1_OUT` or `C2000_CPU2_OUT` is not set, `acceptance:ready`, `acceptance:ccs`, and `acceptance:ccs:mcp` perform a read-only `.out` discovery pass before reporting blockers or touching the target. By default they search `~/workspace_ccstheia`; set `C2000_PROGRAM_SEARCH_ROOTS` to one or more roots separated by the platform path delimiter (`:` on macOS/Linux, `;` on Windows) to search another workspace. Explicit `C2000_CPU1_OUT` and `C2000_CPU2_OUT` values still win over discovery. The JSON report includes `programDiscovery` with the selected CPU1/CPU2 `.out` paths, candidate lists, and whether each path came from env or discovery. The printed readiness `nextCommand` uses discovered paths when available.

Safe default mode connects both cores, loads CPU1/CPU2 programs, and reads a multicore snapshot. If the CPU program paths can be discovered from `~/workspace_ccstheia`, the `C2000_CPU1_OUT` and `C2000_CPU2_OUT` lines below are optional:

```bash
C2000_MCP_CCS_INSTALL_PATH=/Applications/ti/ccs2100/ccs \
C2000_MCP_CCXML_PATH=/Applications/ti/C2000Ware_26_01_00_00_STS/device_support/f28p65x/common/targetConfigs/TMS320F28P650DK9.ccxml \
C2000_CPU1_OUT=/Users/wangxuwen/workspace_ccstheia/hybrid30k_f28p65x_ipc_cpu1/CPU1_RAM/hybrid30k_f28p65x_ipc_cpu1.out \
C2000_CPU2_OUT=/Users/wangxuwen/workspace_ccstheia/hybrid30k_f28p65x_ipc_cpu2/CPU2_RAM/hybrid30k_f28p65x_ipc_cpu2.out \
npm run acceptance:ccs
```

The equivalent end-to-end MCP stdio path starts the built MCP server, checks `c2000_getToolContracts`, calls `c2000_getDebugBoundary` and `c2000_getHardwarePreflight`, then performs the same connect/load/snapshot flow through MCP `tools/call`:

```bash
C2000_MCP_CCS_INSTALL_PATH=/Applications/ti/ccs2100/ccs \
C2000_MCP_CCXML_PATH=/Applications/ti/C2000Ware_26_01_00_00_STS/device_support/f28p65x/common/targetConfigs/TMS320F28P650DK9.ccxml \
C2000_CPU1_OUT=/Users/wangxuwen/workspace_ccstheia/hybrid30k_f28p65x_ipc_cpu1/CPU1_RAM/hybrid30k_f28p65x_ipc_cpu1.out \
C2000_CPU2_OUT=/Users/wangxuwen/workspace_ccstheia/hybrid30k_f28p65x_ipc_cpu2/CPU2_RAM/hybrid30k_f28p65x_ipc_cpu2.out \
npm run acceptance:ccs:mcp
```

Run/pause isolation mode is opt-in because it changes target execution state:

```bash
C2000_RUN_ISOLATION=1 \
C2000_MCP_CCS_INSTALL_PATH=/Applications/ti/ccs2100/ccs \
C2000_MCP_CCXML_PATH=/Applications/ti/C2000Ware_26_01_00_00_STS/device_support/f28p65x/common/targetConfigs/TMS320F28P650DK9.ccxml \
C2000_CPU1_OUT=/Users/wangxuwen/workspace_ccstheia/hybrid30k_f28p65x_ipc_cpu1/CPU1_RAM/hybrid30k_f28p65x_ipc_cpu1.out \
C2000_CPU2_OUT=/Users/wangxuwen/workspace_ccstheia/hybrid30k_f28p65x_ipc_cpu2/CPU2_RAM/hybrid30k_f28p65x_ipc_cpu2.out \
npm run acceptance:ccs
```

For the MCP stdio acceptance path, use the same environment and replace the final command with `npm run acceptance:ccs:mcp`.

The direct and MCP stdio acceptance scripts can also exercise the high-level launch workflow after the basic connect/load/snapshot pass. Set `C2000_RUN_LAUNCH=1` to close the basic acceptance session, call `c2000_launchMulticoreDebug` with `programDiscovery.enabled: true`, and verify the launch response records the discovered CPU1/CPU2 `.out` paths and the launch snapshot has both cores connected, halted, and loaded with those expected programs:

```bash
C2000_RUN_LAUNCH=1 \
C2000_MCP_CCS_INSTALL_PATH=/Applications/ti/ccs2100/ccs \
C2000_MCP_CCXML_PATH=/Applications/ti/C2000Ware_26_01_00_00_STS/device_support/f28p65x/common/targetConfigs/TMS320F28P650DK9.ccxml \
C2000_CPU1_OUT=/Users/wangxuwen/workspace_ccstheia/hybrid30k_f28p65x_ipc_cpu1/CPU1_RAM/hybrid30k_f28p65x_ipc_cpu1.out \
C2000_CPU2_OUT=/Users/wangxuwen/workspace_ccstheia/hybrid30k_f28p65x_ipc_cpu2/CPU2_RAM/hybrid30k_f28p65x_ipc_cpu2.out \
npm run acceptance:ccs:mcp
```

Use `npm run acceptance:ccs` instead of `npm run acceptance:ccs:mcp` for the direct adapter path with the same environment.

Combine `C2000_RUN_LAUNCH=1` with `C2000_RUN_ISOLATION=1` to require `c2000_launchMulticoreDebug` to run its own post-launch `c2000_verifyRunPauseIsolation` check and emit a launch `acceptanceSummary`.

In isolation mode the script calls `c2000_verifyRunPauseIsolation`, which runs CPU1/CPU2 one at a time, captures a multicore snapshot after each single-core command, and fails if:

- the requested core does not reach the expected state (`Running` after `c2000_continue`, `Halted` after `c2000_pause`);
- any peer core changes connection state, run state, PC, or loaded program metadata during that single-core command.

Before isolation mode starts, the MCP stdio hardware acceptance script also checks the initial `c2000_getMulticoreSnapshot` result after `c2000_loadPrograms`. Core `0` and core `2` must both report `connected: true`, a non-empty `state`, a non-empty `pc`, and the expected `.out` path in `loadedProgram`. The snapshot also includes `loadedProgramInfo` when the program was loaded through this MCP, including file size, modification time, SHA-256, and symbol-load metadata from the internal registry.

The `c2000_verifyRunPauseIsolation` result must include `acceptanceSummary` in isolation mode. It lists the required labels `c2000_continue(cpu1)`, `c2000_pause(cpu1)`, `c2000_continue(cpu2)`, and `c2000_pause(cpu2)` with per-step `success`, command-returned `commandCoreId` and `commandCoreName`, `targetCoreId`, `expectedTargetState`, peer core IDs, `checkedPeerFields`, and failures. The tool contract exposes those command-returned identity fields as `responseCoreIdentityFields: ["acceptanceSummary.steps[].commandCoreId", "acceptanceSummary.steps[].commandCoreName"]`, and readiness/hardware acceptance scripts assert that contract before touching the target. `acceptanceSummary.success` requires every step to include a command result with explicit core identity, a numeric `commandCoreId` equal to the target core, and a `commandCoreName` equal to the target core name from the logical session core map; missing, malformed, or mismatched command identity makes the summary fail. `checkedPeerFields` must be `["connected", "state", "pc", "loadedProgram", "loadedProgramInfo"]`, making the peer-core invariants audited by the hardware log explicit. If a per-core command or isolation assertion fails, the failed step is still returned with its `beforeSnapshot`, `afterSnapshot`, checked peer fields, structured command error when available, and failure message, and `acceptanceSummary.success` is `false`; the compact `acceptanceSummary.steps[]` entry also exposes the structured command error as `commandError`. It also includes `acceptanceCriteria`, which maps the four user-facing acceptance requirements directly to the tool labels: `c2000_continue({ sessionId, coreId: 0 }) only runs CPU1`, `c2000_continue({ sessionId, coreId: 2 }) only runs CPU2`, `c2000_pause({ sessionId, coreId: 0 }) only pauses CPU1`, and `c2000_pause({ sessionId, coreId: 2 }) only pauses CPU2`. The direct, MCP stdio hardware acceptance, and MCP stdio smoke scripts require the explicit tool-provided `acceptanceSummary.success === true`, `evidence === "c2000_verifyRunPauseIsolation"`, exact `requiredLabels`, exact `acceptanceCriteria`, each step's `commandCoreId` matching the expected target core, and each step's `commandCoreName` matching the expected target core name; they fail if the summary is missing, any required step is missing, unsuccessful, mapped to the wrong `targetCoreId`, mapped to the wrong command core ID, mapped to the wrong command core name, or mapped to the wrong `expectedTargetState`. When direct or MCP stdio hardware acceptance fails either the isolation or launch tool success check, or fails the summary assertion, the script first writes a JSON object to stdout containing `success: false`, the error, the full captured evidence object, and `failedToolResult` when the tool returned `success: false`.

The direct and MCP stdio hardware acceptance reports also include `uiIndependenceEvidence` and `acceptanceEvidence`. `uiIndependenceEvidence` is derived from `c2000_getDebugBoundary` and is asserted before target control starts. It records `debugControlPath: "c2000-multicore-mcp -> CCS Scripting DebugServer -> DebugSession(coreId)"`, `officialTiMcpDebugControlsUsed: false`, `activeTargetAllowed: false`, `uiFocusRequired: false`, `selectedCpuRequired: false`, `requiredPerCoreInputs: ["sessionId", "coreId"]`, and the `{ "0": "C28xx_CPU1", "2": "C28xx_CPU2" }` core convention. `acceptanceEvidence` comes from `c2000_getAcceptanceEvidence` and is asserted before target control starts; it records the proof tools for `continue_cpu1_only`, `continue_cpu2_only`, `pause_cpu1_only`, `pause_cpu2_only`, `multicore_snapshot`, `debug_tool_contracts`, `multicore_tool_contracts`, `core_read_tool_contracts`, `advanced_automation_contracts`, and UI-independence requirements. The run/pause requirements include the same `checkedCommandFields` and `checkedPeerFields` enforced by `c2000_verifyRunPauseIsolation`, `multicore_snapshot.expectedCoreFields` includes `coreName`, `connected`, `state`, `pc`, `loadedProgram`, and `loadedProgramInfo`, `debug_tool_contracts` records the core debug tools, including `c2000_runCore`/`c2000_haltCore` aliases, that must require `sessionId` plus `coreId` and return `coreId` plus `coreName`, and `multicore_tool_contracts` records `programs[].coreId`, `coreIds[]`, and `cores[].coreId`/`cores[].coreName` identity paths for batch and snapshot tools. `core_read_tool_contracts` records the target-read tools `c2000_evaluateMany`, `c2000_getLoadedProgramInfo`, `c2000_resolvePc`, `c2000_resolveAddress`, and `c2000_waitUntilExpression`, including their `coreIdentityFields: ["coreId"]` and `responseCoreIdentityFields: ["coreId", "coreName"]`. `advanced_automation_contracts` records `assignments[].coreId`, `faults[].coreId`, `comparisons[].left.coreId`, `comparisons[].right.coreId`, `conditions[].coreId`, `cpu1CoreId`, `cpu2CoreId`, `cores[].coreId`, and post-launch identity paths for IPC/MSGRAM checks, parameter synchronization, fault injection, CPU2 bring-up diagnosis, and launch automation. `c2000_getDebugBoundary.realAdapter.requiresResponseCoreIdentity: true` records that the persistent DSS bridge rejects successful per-core responses unless they include the requested `coreId` and `coreName`. These fields are the machine-readable proof that acceptance does not require clicking CPU1/CPU2 in the CCS Debug window and does not depend on CCS UI focus.

Before hardware acceptance, close or terminate any existing CCS debug session that already owns the XDS110 probe. Do not use TI official MCP `continue`, `pause`, or `reset` as part of this acceptance.

The script calls `c2000_closeDebugSession` in a `finally` block when a session was created, so the persistent DSS server is disposed even when a later connect/load/snapshot step fails. If cleanup fails after an earlier hardware acceptance failure, the original failure is preserved and the cleanup failure is written to stderr; if cleanup is the only failure, the script fails on that cleanup error.

The script first checks MCP tool contracts for the critical debug path:

- Core debug controls such as `c2000_connectTarget`, `c2000_disconnectTarget`, `c2000_continue`, `c2000_pause`, `c2000_reset`, `c2000_getTargetState`, and `c2000_loadProgram` must be `inputScope: "core"` and require `sessionId` plus `coreId`.
- Batch controls such as `c2000_connectCores`, `c2000_haltCores`, `c2000_resetCores`, `c2000_runCores`, and `c2000_loadPrograms` must declare batch/session inputs explicitly and the expected target side effect.
- `c2000_getMulticoreSnapshot`, `c2000_verifyRunPauseIsolation`, and `c2000_closeDebugSession` must declare session-scoped contracts before the script touches the target.
- `c2000_launchMulticoreDebug` must declare `inputScope: "launch"` and `targetEffect: "launch-workflow"` before optional launch acceptance starts.

For batch operations, the script checks every expected per-core result. `c2000_connectCores` and `c2000_loadPrograms` must both report successful results for core `0` and core `2`; a top-level `success: true` response is not enough for hardware acceptance.

The script then runs a preflight check:

- `xdsdfu -e` must enumerate the XDS110.
- Existing `DSLite`, `ccstudio`, `DebugServer`, or `dss.sh` processes are treated as possible XDS owners.

If an existing debug process is expected and you still want to try the acceptance script, set:

```bash
C2000_ALLOW_EXISTING_DEBUG_PROCESSES=1
```

## Switching To Real CCS

Explicit CCS mode (recommended for hardware):

```json
{
  "adapter": "ccs",
  "ccs": {
    "installPath": "C:/ti/ccs",
    "workspacePath": "D:/workspace",
    "ccxmlPath": "D:/workspace/targetConfigs/TMS320F28P650DK9.ccxml",
    "scriptingMode": "ccs"
  }
}
```

Or use `"adapter": "auto"` / `"scriptingMode": "auto"` so the server selects `ccs` only when the DSS launcher exists under `installPath` (see [Adapter selection](#adapter-selection-adapter--ccsscriptingmode)). Check the startup log line `debug adapter selected` before assuming you are on hardware.

Current limitation: `CcsScriptingAdapter` uses an experimental persistent DSS bridge by default. It launches `dss.sh`, opens the configured `.ccxml`, resolves CPU1/CPU2 by `corePattern`, and keeps one socket endpoint per core DebugSession. Commands are routed by `adapterSessionId + coreId`, not by CCS UI focus. Each socket endpoint is also bound to its expected `coreId`; if an internal bridge bug sends a command whose `coreId` does not match that endpoint, the DSS server rejects it before resolving a DebugSession. Persistent DSS responses include the requested `coreId` and `coreName`, and the Node bridge rejects a successful DSS response if that identity does not match the requested core. The stateless compatibility bridge emits the same `coreId` and `coreName` response fields, but it is not the F28P65x automation path because it does not preserve per-core DebugSession objects across commands. Hardware acceptance logs can tie each `run`, `halt`, `reset`, `load`, GS ownership `writeData`, state, expression, and address response back to the logical core that handled it. This is the correct architectural direction because it does not call TI official MCP debug controls. Physical-board acceptance has passed with `C2000_RUN_LAUNCH=1` and `C2000_RUN_ISOLATION=1` on the attached F28P65x/XDS110 setup.

The adapter currently implements the integration boundary in:

- `src/adapters/CcsScriptingAdapter.ts`
- `src/adapters/CcsScriptingBridge.ts`
- `src/adapters/PersistentDssBridge.ts`
- `src/adapters/adapterResolution.ts` (`auto` / `mock` / `ccs` selection)

The DSS script uses the CCS Scripting APIs shown in TI's installed examples:

- `ScriptingEnvironment.instance()`
- `script.getServer("DebugServer.1")`
- `debugServer.setConfig(ccxmlPath)`
- `debugServer.openSession("*", corePattern)`
- `debugSession.target.connect()`
- `debugSession.target.disconnect()`
- `debugSession.target.runAsynch()`
- `debugSession.target.halt()`
- `debugSession.target.reset()` (default / `cpu`)
- `debugSession.target.systemReset()` or `GEL_SystemReset()` when `resetType` is `system` (falls back to `reset()` if unsupported)
- `debugSession.target.restart()` when `resetType` is `restart` (falls back to `reset()` if unsupported)
- `debugSession.memory.loadProgram(programUri)`
- `debugSession.memory.writeData(Memory.Page.DATA, address, value, typeSize)`
- `debugSession.expression.evaluate(expression)`

### Address resolution honesty

`c2000_resolveAddress` does **not** invent symbol or source mapping. When the adapter has no function/source/line data, the result is `success: false`, `partial: true`, and an `AddressResolveFailed` (or equivalent) error payload. `c2000_resolvePc` still returns `success: true` when the PC value itself was read successfully; partial address-to-source mapping is reported with `partial: true` (and optional error details) without claiming a full symbol resolve.

### Reset types

Tool APIs accept `resetType`: `cpu` | `system` | `restart` | `default`. The DSS scripts map these as above. On the mock adapter, all four types are accepted; unsupported values throw `UnsupportedResetType`.

The older `DssCliBridge` remains in `CcsScriptingBridge.ts` as a stateless diagnostic fallback. It must still return explicit `coreId` and `coreName` in successful responses so the adapter can fail closed on identity mismatches, but it is not the preferred path for F28P65x dual-core automation because it does not preserve `coreId -> DebugSession` across commands.

Implemented robustness notes:

- CPU2 GS ownership writes require CPU1 to already be connected (`OwnerCoreNotConnected` otherwise).
- GS ownership multi-bit OR merge plus RMW when `readMemory` is available; missing-map fallback is logged and surfaced on `LoadedProgramInfo.warning`.
- `c2000_launchMulticoreDebug` always processes CPU1 before other cores and accepts per-core `mapUri`.
- `c2000_verifyRunPauseIsolation` halts both cores first; peer cores that are `Running` are not compared on `pc` (only `connected` / `state` / loaded program fields).
- `listCores` refreshes each core through adapter `getState` instead of returning static disconnected flags.
- `readMemory` is available on mock and CCS adapters; workflow `verifyRuntimeRamOwnership: true` reads `MEMCFG_GSXMSEL` and checks the expected GS bit mask.
- Boot handoff verdict treats zero/false expression values as not ready, and requires non-empty ownership actions when CPU2 maps use GS RAM.
- Program/map URIs normalize `file://`, quotes, `~`, and relative paths.
- DSS failures use specific codes: `DssNotFound`, `DssLaunchFailed`, `DssCommandFailed`, `DssTimeout`, `DssTransportFailed` (adapter wiring still uses `AdapterNotAvailable`).
- CCS install multi-version discovery under common TI roots; `ccs.workspacePath` drives relative loads and DSS cwd/env.
- Tool contracts expose `role` / `family` / `aliasOf` and a `toolSurface` guide so clients prefer workflows and primary atomics.

The real adapter must not call TI official MCP `continue`, `pause`, `reset`, `connectTarget`, `disconnectTarget`, or `getTargetState`. Doing so would reintroduce active-target behavior and fail the purpose of this project.

Unsupported reset modes must throw `UnsupportedResetType`; unavailable symbols must throw `SymbolNotFound`; failed assignment or verify readback must throw `ExpressionAssignFailed` / `ExpressionVerifyFailed`; missing owner core before GS handoff must throw `OwnerCoreNotConnected`; runtime GS verify failures throw `RamOwnershipVerifyFailed`; DSS transport/launch/command failures throw the `Dss*` codes above; remaining adapter wiring failures throw `AdapterNotAvailable`.

## Acceptance Checks

The real CCS adapter is accepted only when these checks pass without clicking the CCS Debug window:

- `c2000_continue({ "sessionId": "...", "coreId": 0 })` only runs CPU1.
- `c2000_continue({ "sessionId": "...", "coreId": 2 })` only runs CPU2.
- `c2000_pause({ "sessionId": "...", "coreId": 0 })` only pauses CPU1.
- `c2000_pause({ "sessionId": "...", "coreId": 2 })` only pauses CPU2.
- `c2000_reset({ "sessionId": "...", "coreId": 0 })` and `c2000_reset({ "sessionId": "...", "coreId": 2 })` address separate core DebugSessions.
- No test step depends on CCS UI focus or manual CPU selection.

## File Layout

```text
c2000-multicore-mcp/
  src/
    adapters/          # Mock, CcsScripting, PersistentDss, adapterResolution
    config/
    debug/             # DebugSessionManager, isolation, program registry
    hardware/          # map ownership, preflight, program discovery
    mcp/
    utils/
    workflows/
  scripts/             # smoke, acceptance, optional p0-smoke.mjs
  examples/
  scripts/
  tests/
```

## Security Model

Every registered tool publishes standard MCP annotations plus precise `effects`. Read-only annotations are derived from effects and never hide connect, run, halt, reset, load, memory-write, RAM-ownership, fault-injection, or host-write behavior. The explicit route remains `sessionId -> adapterSessionId -> coreId -> DebugSession`.

The MCP Server can reduce approval frequency by using accurate annotations and server-internal workflows, but the MCP client remains the final approval authority.

Recommended approval policy:

- read-only tools: auto approve
- safe high-level workflow: approve once
- target mutation tools: always prompt

## Tool Profiles

Set `C2000_MCP_TOOL_PROFILE=readonly|safe|full` (default `safe`). `readonly` exposes only tools whose annotations are read-only. `safe` adds session lifecycle, target control, loading, and safe workflows but hides arbitrary expression writes and fault injection. `full` exposes every tool. `c2000_getToolContracts` reports only the active set together with `activeToolProfile`, `hiddenTools`, and `profileReason`.

## Filesystem Policy

`C2000_MCP_ALLOWED_READ_ROOTS` and `C2000_MCP_ALLOWED_WRITE_ROOTS` use the platform path delimiter. Paths are resolved through real filesystem parents before containment checks, including missing write targets, so traversal and symlink escapes fail closed. Default read access is the configured repository/workspace and default writes are limited to `runtime`; an empty write-root list rejects bundle output. Tool errors return the canonical rejected path and configured roots. Keep `.ccxml`, `.out`, and `.map` inputs under a read root, and `outputDir` under a write root.

## RAM Ownership Policy

CPU2 loads no longer assume RAMGS4. Use `ramOwnershipPolicy: "require-map"` (default) with a readable linker map, `"explicit-fallback"` with explicit `fallbackGsRegions`, or `"skip"`. CPU1 loading is unchanged. Results record policy, fallback use, ownership writes, and whether ownership was prepared or skipped.

Migration: callers that previously omitted a CPU2 map must now provide map evidence, explicitly authorize fallback regions, or explicitly skip ownership changes.

## Safe Workflow vs Mutation Workflow

`c2000_launchMulticoreDebugSafe` permits session creation, connect/load/halt, snapshot, polling, comparisons, and diagnosis. It excludes assignments, fault injection, reset, automatic run, and run/pause isolation. `c2000_launchMulticoreDebugWithActions` is the explicit destructive alternative. The old `c2000_launchMulticoreDebug` remains a deprecated compatibility alias and identifies its replacement in the response.

High-level workflows execute their steps inside the server; they do not recursively issue MCP tool calls. This keeps one client-visible `tools/call` while preserving truthful annotations and evidence.

CCS project cleanup is workflow-scoped. Projects needed by build/debug remain available for the full workflow and are cleaned together only after success or failure. Because CCS 21 has no `Close Project` command, automation should use a dedicated temporary CCS workspace for each workflow instead of importing workflow-only projects into the user's main workspace. Final cleanup closes the logical DebugSession and the temporary workflow workspace together while preserving source projects, generated `.out`/`.map` evidence, and every project that existed in the main workspace before the workflow.

Persistent DSS children also register a parent-process exit fallback. Normal cleanup still uses the structured shutdown command and `c2000_closeDebugSession`; if the MCP process is terminated unexpectedly, its own DSS child is killed to avoid an orphan process.

All CCS-backed MCP instances coordinate through a filesystem FIFO lease. The lease is acquired before probe recovery/session creation and held until the logical debug session closes, so multiple Agents or conversations cannot interleave operations on one XDS110. Dead active owners and dead waiting tickets are reclaimed automatically. Configure every instance with the same absolute `C2000_MCP_PROBE_QUEUE_DIR`.

For multiple boards, configure `debugProbe.probes` in the config file (or `C2000_MCP_PROBES_JSON`). Every entry must use a unique `probeId`, unique XDS110 `serialNumber`, and a separate `.ccxml` already bound to that serial number:

```json
{
  "debugProbe": {
    "multiBoardEnabled": true,
    "queueDir": "/shared/c2000-probe-queue",
    "queueTimeoutMs": 600000,
    "recoveryPolicy": "terminate-external",
    "probes": [
      { "probeId": "board-01", "serialNumber": "XDS110-A", "ccxmlPath": "/targets/board-01.ccxml", "enabled": true },
      { "probeId": "board-02", "serialNumber": "XDS110-B", "ccxmlPath": "/targets/board-02.ccxml", "enabled": true }
    ]
  }
}
```

Multi-board mode is fail-closed. It activates only when `multiBoardEnabled: true` and at least two enabled, uniquely identified probes are configured. At Session creation the MCP verifies that the selected XDS110 serial is currently enumerated and that its dedicated `.ccxml` contains that serial binding. A mismatch aborts before DSS creation or target access.

Launch tools accept optional `probeId`, `preferredProbeIds`, and `allowAutoProbeAllocation`. The default requires an explicit `probeId`. Automatic least-loaded selection occurs only when `allowAutoProbeAllocation: true`; preferences do not implicitly enable it. Sessions on different boards use separate DSS processes and can execute concurrently. Calls targeting the same board remain FIFO-serialized. The creation response records `probeId`, `serialNumber`, selected `ccxmlPath`, queue position, and wait time. If explicit multi-board activation is absent, the original single-board queue remains active even if probe entries exist.

The default `owned-and-stale` recovery policy blocks on a live external DSLite owner. For a dedicated unattended test machine, set `C2000_MCP_PROBE_RECOVERY_POLICY=terminate-external`; only the FIFO lease holder may then send TERM/KILL to detected DSLite, DebugServer, or dss.sh processes before starting the test. The CCS application itself is not terminated. `c2000_createDebugSession` returns `probeQueue` and `probeRecovery` evidence so callers can see queue position, wait time, and recovered PIDs.

## F28P65x hardware acceptance

Hardware acceptance is fail-closed. Without `C2000_HARDWARE_TEST=1`, every
hardware entry prints `SKIPPED_NO_HARDWARE` and exits before CCS discovery,
DSS startup, XDS110 access, program load, reset, or PCAN initialization.
PCAN additionally requires `C2000_PCAN_HARDWARE_TEST=1`; two-board tests also
require `C2000_TWO_BOARD_TEST=1`.

The standardized source-checkout entry points are:

```text
npm run acceptance:hardware:single-board
npm run acceptance:hardware:multicore
npm run acceptance:hardware:variables
npm run acceptance:hardware:dlog
npm run acceptance:hardware:erad
npm run acceptance:hardware:trace
npm run acceptance:hardware:can
npm run acceptance:hardware:two-board
npm run acceptance:hardware:soak
npm run acceptance:hardware:all
```

Each entry writes `HARDWARE_ACCEPTANCE_REPORT.md`,
`hardware-acceptance-result.json`, `hardware-acceptance-events.jsonl`, and
`hardware-acceptance-manifest.json`. Results use only
`PASS_HARDWARE`, `FAIL_HARDWARE`, `SKIPPED_NO_HARDWARE`,
`SKIPPED_UNSUPPORTED`, `INCONCLUSIVE`, or `PASS_MOCK`.

The report orchestrator currently provides complete opt-in gating and
machine-readable evidence aggregation. It deliberately reports
`SKIPPED_UNSUPPORTED` after opt-in for scopes that do not yet have a dedicated
automated target-side executor; it never turns an existing CCS/PCAN preflight
or Mock result into `PASS_HARDWARE`.
