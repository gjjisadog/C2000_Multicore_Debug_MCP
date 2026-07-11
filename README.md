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

For F28P65x CPU2 RAM builds that place sections in `RAMGSx`, `c2000_loadProgram` and `c2000_loadPrograms` prepare GS RAM ownership before loading CPU2. When a `.map` file is supplied through `mapUri`, or can be derived next to the `.out`, the manager parses the map and writes the required GS owner bits through CPU1. If no usable map is available, it keeps the previous RAMGS4 fallback for compatibility. The write uses an explicit CPU1 DebugSession memory write to `MEMCFG_GSXMSEL` at `0x0005F444` on the DATA page through `DebugAdapter.writeMemory`. This mirrors TI's dual-core RAM ownership requirement and still uses the self-managed `sessionId -> coreId -> DebugSession` path; it does not call TI official MCP debug controls and does not depend on CCS UI focus.

## Install

```bash
npm install
npm run build
```

## Start

Mock mode:

```bash
C2000_MCP_CONFIG=./examples/f28p65x.config.json npm run dev
```

Built server:

```bash
C2000_MCP_CONFIG=./examples/f28p65x.config.json npm start
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

Environment overrides:

- `C2000_MCP_CONFIG`
- `C2000_MCP_ADAPTER=mock|ccs|auto`
- `C2000_MCP_CCS_INSTALL_PATH`
- `C2000_MCP_C2000WARE_PATH`
- `C2000_MCP_WORKSPACE_PATH`
- `C2000_MCP_CCXML_PATH`
- `C2000_MCP_DSS_TIMEOUT_MS` (default hardware acceptance value: `300000`)
- `C2000_MCP_REQUEST_TIMEOUT_MS` (MCP hardware acceptance client request timeout; default: `600000`)
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
- `c2000_resolvePc`
- `c2000_resolveAddress`
- `c2000_waitUntilExpression`
- `c2000_waitForExpressionSet`
- `c2000_diagnoseCpu2Boot`
- `c2000_verifyRunPauseIsolation`
- `c2000_assignExpression`
- `c2000_assignExpressions`
- `c2000_injectFaults`
- `c2000_compareExpressions`
- `c2000_analyzeRamOwnership`
- `c2000_diagnoseBootHandoff`
- `c2000_waitForIpcReady`
- `c2000_reloadResetRunToMain`

Phase 3:

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
9. If stuck, `c2000_haltCores`, then `c2000_resolvePc` or `c2000_resolveAddress`.
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
    "runCpu1First": true,
    "runCpu2": true,
    "settleMs": 0
  },
  "timeoutMs": 5000,
  "intervalMs": 100,
  "collectDebugBundle": true,
  "outputDir": "/tmp/c2000-ipc-acceptance"
}
```

The result includes the created `sessionId`, `launch` connection evidence, `workflow`, `orchestration: "server-internal"`, `mcpToolCalls: []`, explicit CPU IDs, snapshot evidence, RAM ownership analysis, ELF freshness, IPC-ready conditions, boot handoff diagnosis, and optional bundle files. On launch failure the server closes the newly created logical session before returning a structured error.

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

For CPU2 sections in `RAMGS4`, the result includes an ownership action with `ownerCoreId: 0`, `targetCoreId: 2`, `address: 0x0005F444`, `value: 0x10`, and `page: "DATA"`. `c2000_loadProgram` and `c2000_loadPrograms` use the same parser when `mapUri` is supplied, or when a sibling `.map` can be derived from the `.out`.

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

`c2000_assignExpression` assigns one expression on one explicit core. It requires `sessionId`, `coreId`, `expression`, and `value`, and by default reads the expression back on the same core after assignment.

Example:

```json
{
  "sessionId": "dbg-...",
  "coreId": 0,
  "expression": "g_ulHybrid30kIpcPass",
  "value": 0
}
```

String values are treated as CCS/C expression fragments, so values such as `"0x1"` or `"MY_ENUM_VALUE"` can be used for target-side assignments. Use `c2000_evaluateMany` on the peer core to confirm the injection did not change unrelated CPU1/CPU2 state.

`c2000_assignExpressions` applies multiple explicit per-core assignments in one request. Every item carries its own `coreId`, `expression`, `value`, and optional `verify` flag; the response returns independent per-item results and a top-level failure if any item fails.

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

`c2000_injectFaults` is a semantic wrapper for fault campaigns. It uses the same per-core assignment path as `c2000_assignExpression`, but each item is named as a fault with an optional `label`. The response includes `summary.total`, `summary.succeeded`, `summary.failed`, and independent per-fault results. This is useful when an acceptance log needs to say which fault case was injected, while still proving every write used an explicit `coreId`.

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

If `c2000_launchMulticoreDebug` fails after creating a logical session, it calls `c2000_closeDebugSession` internally and returns the failed `sessionId` with `cleanedUp: true` when cleanup succeeds. This avoids leaving persistent DSS sessions alive after a partial connect/load/check failure.

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

Preflight keeps the legacy `debugProcesses` string array and also returns `debugProcessDetails`, with `pid`, optional `ppid`, optional `elapsed`, `kind`, `command`, and `rawLine` for each possible probe owner. Readiness and hardware acceptance use this structured detail to report blockers such as `93717 DSLite: ./DSLite` without terminating anything automatically.

For one-shot host-side acceptance gating, call `c2000_getAcceptanceReadiness`. It combines `.ccxml` checks, CPU1/CPU2 `.out` discovery, XDS110 preflight, debug-process ownership, the debug boundary contract, UI-independence proof, and the acceptance evidence plan in one read-only report. The tool returns `readyForHardwareAcceptance`, `blockers`, `warnings`, `checks`, `programDiscovery`, `preflight`, `debugBoundary`, `uiIndependenceEvidence`, `acceptanceEvidence`, and `nextCommand`; it does not create a debug session or call any target-control method.

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

Set:

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

Current limitation: `CcsScriptingAdapter` uses an experimental persistent DSS bridge by default. It launches `dss.sh`, opens the configured `.ccxml`, resolves CPU1/CPU2 by `corePattern`, and keeps one socket endpoint per core DebugSession. Commands are routed by `adapterSessionId + coreId`, not by CCS UI focus. Each socket endpoint is also bound to its expected `coreId`; if an internal bridge bug sends a command whose `coreId` does not match that endpoint, the DSS server rejects it before resolving a DebugSession. Persistent DSS responses include the requested `coreId` and `coreName`, and the Node bridge rejects a successful DSS response if that identity does not match the requested core. The stateless compatibility bridge emits the same `coreId` and `coreName` response fields, but it is not the F28P65x automation path because it does not preserve per-core DebugSession objects across commands. Hardware acceptance logs can tie each `run`, `halt`, `reset`, `load`, GS4 ownership `writeData`, state, expression, and address response back to the logical core that handled it. This is the correct architectural direction because it does not call TI official MCP debug controls. Physical-board acceptance has passed with `C2000_RUN_LAUNCH=1` and `C2000_RUN_ISOLATION=1` on the attached F28P65x/XDS110 setup.

The adapter currently implements the integration boundary in:

- `src/adapters/CcsScriptingAdapter.ts`
- `src/adapters/CcsScriptingBridge.ts`
- `src/adapters/PersistentDssBridge.ts`

The DSS script uses the CCS Scripting APIs shown in TI's installed examples:

- `ScriptingEnvironment.instance()`
- `script.getServer("DebugServer.1")`
- `debugServer.setConfig(ccxmlPath)`
- `debugServer.openSession("*", corePattern)`
- `debugSession.target.connect()`
- `debugSession.target.disconnect()`
- `debugSession.target.runAsynch()`
- `debugSession.target.halt()`
- `debugSession.target.reset()`
- `debugSession.memory.loadProgram(programUri)`
- `debugSession.memory.writeData(Memory.Page.DATA, address, value, typeSize)`
- `debugSession.expression.evaluate(expression)`

The older `DssCliBridge` remains in `CcsScriptingBridge.ts` as a stateless diagnostic fallback. It must still return explicit `coreId` and `coreName` in successful responses so the adapter can fail closed on identity mismatches, but it is not the preferred path for F28P65x dual-core automation because it does not preserve `coreId -> DebugSession` across commands.

The next adapter hardening work is:

- Confirm target state semantics on a physical F28P65x board after XDS110 ownership is clear.
- Complete physical-board acceptance for `c2000_continue` and `c2000_pause` on CPU1/CPU2 with a free XDS110 debug probe.
- Add reset-type mapping for C2000-specific CPU/system/restart behavior after verifying CCS Debug Server support.

The real adapter must not call TI official MCP `continue`, `pause`, `reset`, `connectTarget`, `disconnectTarget`, or `getTargetState`. Doing so would reintroduce active-target behavior and fail the purpose of this project.

Unsupported reset modes must throw `UnsupportedResetType`; unavailable symbols must throw `SymbolNotFound`; adapter wiring failures must throw `AdapterNotAvailable`.

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
    adapters/
    config/
    debug/
    mcp/
    utils/
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

`C2000_MCP_ALLOWED_READ_ROOTS` and `C2000_MCP_ALLOWED_WRITE_ROOTS` use the platform path delimiter. Paths are resolved through real filesystem parents before containment checks, including missing write targets, so traversal and symlink escapes fail closed. Default read access is the configured repository/workspace and default writes are limited to `runtime`; an empty write-root list rejects bundle output.

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
