# C2000 Multicore MCP

Independent MCP server for explicit TI C2000 multicore debug control. The first implementation targets F28P65x CPU1/CPU2 workflows and keeps all debug APIs scoped by `sessionId` and `coreId`.

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

```bash
npm install
npm run build
```

`npm run build` runs `scripts/build.mjs`, which invokes the TypeScript package CLI (`lib/_tsc.js`) directly. This avoids broken `tsc` bin shims under some Node/package layouts. TypeScript is pinned to `5.5.4`. If build fails after a partial `node_modules`, reinstall with `npm ci` or `npm install typescript@5.5.4 --save-dev`.

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
the expected XDS110 serial before it starts.

Use the daemon/job surface for multi-board work:

- `c2000_getDaemonHealth` reports daemon, worker, job, and read-only database-consistency state.
- `c2000_listBoards` reports persisted registrations, leases, workers, and quarantine state.
- `c2000_recoverBoard` defaults to a dry run and can restart only the daemon-owned
  worker for one board. It deliberately never terminates an external CCS/DSS owner.
- `c2000_submitTestPlan` returns a stable `jobId` immediately; use
  `c2000_getTestRun`, `c2000_listTestRuns`, `c2000_cancelTestRun`, and
  `c2000_getTestArtifacts` afterwards.
- A daemon stop marks in-flight runs `RECOVERING`. Startup only restarts a plan
  from its declared whole-board safe boundary; a non-idempotent interruption
  becomes `NEEDS_MANUAL_INTERVENTION` instead of being replayed.

To use real multiple boards, add unique `boardId`, `probeSerial`, `ccxmlPath`,
and tags in `boards[]`; do not leave probe allocation to CCS UI focus.

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

Useful local verification commands:

```bash
npm run verify:daemon-proxy
npm run verify:can:mock
```

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

`target.coreMap` must use unique `coreId` values and unique target selectors. The target selector is `corePattern` when present, otherwise `coreName`. Duplicate IDs are rejected with `DuplicateCoreId`; duplicate target selectors are rejected with `DuplicateCoreTarget`. Both checks protect the internal `sessionId -> coreId -> DebugSession` mapping from becoming ambiguous.

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
- `C2000_MCP_WORKSPACE_PATH`
- `C2000_MCP_CCXML_PATH`
- `C2000_MCP_DSS_TIMEOUT_MS` (default hardware acceptance value: `300000`)
- `C2000_MCP_REQUEST_TIMEOUT_MS` (MCP hardware acceptance client request timeout; default: `600000`)
- `C2000_PROGRAM_SEARCH_ROOTS`
- `C2000_MCP_LOG_LEVEL=debug|info|warn|error`
- `C2000_MCP_LOG_FILE`

Windows paths are plain JSON strings. Escape backslashes or use forward slashes.

## Tools

Phase 0 read-only host checks:

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
   - `g_emHybrid30kCpu1Stage`
   - `g_ulHybrid30kIpcPass`
   - `g_ulHybrid30kMsgRamPass`
   - `g_ulHybrid30kParamPass`
9. If stuck, `c2000_haltCores`, then `c2000_resolvePc` (for PC) or `c2000_resolveAddress` (address only; symbol mapping may be `partial` / not implemented).
10. `c2000_diagnoseCpu2Boot` to collect CPU1/CPU2 PC, snapshot, CPU1 IPC stage/pass flags, and CPU2 stage.
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
- `c2000_runReloadAndDiagnose`: reload/reset/prepare, optionally run/wait, then diagnose.
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
  - `g_emHybrid30kCpu1Stage`
  - `g_ulHybrid30kIpcPass`
  - `g_ulHybrid30kMsgRamPass`
  - `g_ulHybrid30kParamPass`
- CPU2 expressions:
  - `g_emHybrid30kCpu2Stage`

Example:

```json
{
  "sessionId": "dbg-...",
  "cpu1CoreId": 0,
  "cpu2CoreId": 2
}
```

This is intended for cases where CPU1 reaches a CPU2 boot/release wait path and CPU2 does not enter its application.

`c2000_diagnoseBootHandoff` wraps the same read-only CPU1/CPU2 boot diagnosis and can add RAM ownership evidence from `.map` files. It returns a compact `verdict` showing whether CPU1 IPC/pass flags, CPU2 stage evidence, and RAM ownership evidence look ready.

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

`c2000_waitForIpcReady` waits for CPU1/CPU2 IPC-ready conditions. If no custom `conditions` array is supplied, it polls the default symbols `g_ulHybrid30kIpcPass`, `g_ulHybrid30kMsgRamPass`, `g_ulHybrid30kParamPass` on CPU1 and `g_emHybrid30kCpu2Stage` on CPU2. Every condition is still evaluated through the requested `sessionId` and explicit `coreId`.

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
  "expression": "g_ulHybrid30kIpcPass",
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
    { "label": "cpu1-ipc-pass", "coreId": 0, "expression": "g_ulHybrid30kIpcPass", "expected": 1 },
    { "label": "cpu2-stage", "coreId": 2, "expression": "g_emHybrid30kCpu2Stage", "expected": "3" }
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
        { "label": "cpu1-ipc-pass", "coreId": 0, "expression": "g_ulHybrid30kIpcPass", "expected": 1 },
        { "label": "cpu2-stage", "coreId": 2, "expression": "g_emHybrid30kCpu2Stage", "expected": "0" }
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

For one-shot host-side acceptance gating, call `c2000_getAcceptanceReadiness`. It combines `.ccxml` checks, CPU1/CPU2 `.out` discovery, XDS110 preflight, debug-process ownership, the debug boundary contract, UI-independence proof, and the acceptance evidence plan in one read-only report. Set `waitForProbeMs` plus `probePollIntervalMs` to wait for an existing debug process to release the probe without killing it; the response reports `probeWait.requestedMs`, `elapsedMs`, `attempts`, and `released`. The tool returns `readyForHardwareAcceptance`, `blockers`, `warnings`, `checks`, `programDiscovery`, `preflight`, `probeWait`, `debugBoundary`, `uiIndependenceEvidence`, `acceptanceEvidence`, and `nextCommand`; it does not create a debug session or call any target-control method. Transient XDS110 launch failures such as Error -260 are retried with capped exponential backoff.

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
