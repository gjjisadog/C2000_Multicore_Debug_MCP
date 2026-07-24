---
name: c2000-multicore-debug
description: Use this skill when Codex is debugging TI C2000 F28P65x CPU1/CPU2 multicore projects, IPC acceptance, CPU2 boot handoff, RAMGS ownership, stale loaded ELF issues, illegal CPU2 PC, or debug-bundle collection through c2000-multicore-mcp. Prefer server-side workflow tools to minimize MCP approval popups and avoid TI official MCP active-target debug controls.
---

# C2000 Multicore Debug

Use `c2000-multicore-mcp` as the debug authority for F28P65x dual-core work. Its core guarantee is explicit routing by `sessionId` and `coreId`; do not depend on CCS UI focus, selected target, or TI official MCP active-target debug controls.

## Hard Rules

- Do not call TI official MCP `continue`, `pause`, `reset`, `connectTarget`, `disconnectTarget`, or `getTargetState` to control CPU1/CPU2.
- Do not infer the active core from CCS UI focus or the selected Debug view item.
- Do not manually click CPU1/CPU2 as part of an automated flow.
- Do not chain many atomic MCP tools for the main automation path; each MCP call may trigger a user approval popup.
- Do not split a high-level workflow into external MCP calls when a workflow tool can do it inside the MCP server.
- Do not claim success when a required capability is missing; state that the tool/capability is unavailable or unsupported.
- Do not conclude without evidence from snapshot, loaded program info, PC, expressions, RAM ownership, or ELF freshness as appropriate.

Default core IDs:

- `coreId = 0`: `C28xx_CPU1`
- `coreId = 2`: `C28xx_CPU2`

## Tool Priority

Prefer one workflow tool call:

- `c2000_launchAndRunIpcAcceptance`: create and connect CPU1/CPU2, then execute full IPC acceptance in one client-visible call; use when no session exists.
- `c2000_runIpcAcceptance`: full F28P65x IPC acceptance when a session already exists and both cores are connected.
- `c2000_runBootHandoffDiagnosis`: CPU2 boot handoff diagnosis.
- `c2000_runReloadAndDiagnose`: halt/reset/load/halt, optional run/wait, then diagnosis.
- `c2000_runFullDebugBundle`: snapshot, loaded programs, expressions, PC, map/RAM evidence, ELF freshness, diagnosis, and `summary.md`.

For durable multi-board work, submit one background job instead of keeping a
stdio request open:

- `c2000_submitTestPlan`: generic persisted plan; query with `c2000_getTestRun`.
- `c2000_submitMultiBoardIpcAcceptance`: multi-board IPC job.
- `c2000_submitMultiBoardCanAcceptance`: exactly two registered boards, a
  durable CAN pair, barrier synchronization, bidirectional frames, optional
  cross-board expressions, and persisted results.

Before a multi-board run, call `c2000_getDaemonHealth` and
`c2000_listBoards`; require distinct `boardId` and `probeSerial` values and do
not select a board that is leased or quarantined. A returned `jobId` is the
durable handle; reconnecting the MCP client must not change it.

If a board worker is unhealthy, call `c2000_recoverBoard` with its default
`dryRun: true` first. A non-dry run can restart only the daemon-owned worker;
never use it as authority to kill an external CCS or DebugServer process.

For CAN, `profile.adapter: "mock"` is simulation only. It may prove the job
engine, pairing, barriers, matching, fault injection, and evidence persistence,
but never physical wiring or firmware CAN operation. Hardware mode fails closed
with `CanAdapterUnavailable` until a real `CanBusAdapter` is installed. State
that limitation plainly; do not call a Mock pass a bench acceptance pass.

When atomics are required, prefer **primary** names over aliases: `c2000_runCore` (not `c2000_continue`), `c2000_haltCore` (not `c2000_pause`). Call `c2000_getToolContracts` for `toolSurface` guidance.

Use these only if `c2000_getToolContracts` shows they exist:

- `c2000_collectDebugBundle`
- `c2000_generateBringupReport`
- `c2000_checkLoadedElfFreshness`
- `c2000_diagnoseCpu2IllegalPc`
- `c2000_verifyRamOwnershipRuntime`

Atomic tools are for manual/debug evidence only:

- `c2000_createDebugSession`
- `c2000_connectTarget`, `c2000_connectCores`
- `c2000_loadProgram`, `c2000_loadPrograms`
- `c2000_runCore`, `c2000_runCores`
- `c2000_haltCore`, `c2000_haltCores`
- `c2000_reset`, `c2000_resetCores`
- `c2000_getTargetState`, `c2000_getMulticoreSnapshot`
- `c2000_evaluateMany`
- `c2000_resolvePc`, `c2000_resolveAddress`
- `c2000_analyzeRamOwnership`
- `c2000_diagnoseBootHandoff`
- `c2000_waitForIpcReady`

Use atomic tools only when the user explicitly asks for a single step, a workflow failed and missing evidence is needed, only one small read is needed, the user accepts multiple approval popups, or per-core isolation must be verified.

## Intent Mapping

- "跑一下 IPC", "检查双核 IPC", "做 acceptance", "检查 MSGRAM", "检查参数同步" -> no session: `c2000_launchAndRunIpcAcceptance`; existing connected session: `c2000_runIpcAcceptance`.
- "CPU2 没起来", "CPU2 卡住", "CPU2 一跑就飞", "CPU1 放核了吗" -> `c2000_runBootHandoffDiagnosis`.
- "重新加载两个 out 再看", "reload/reset/run 后诊断" -> `c2000_runReloadAndDiagnose`.
- "打包现场", "生成报告", "保存失败信息" -> `c2000_runFullDebugBundle`.
- "RAMGS4", "GS RAM", "MEMCFG_GSXMSEL", "0x0005F444", "ownership" -> workflow diagnosis first; use `c2000_analyzeRamOwnership` for focused static map evidence. Multi-GS maps are OR-merged into one `MEMCFG_GSXMSEL` write before CPU2 load.
- "watch 变量读不到", "旧变量名", "明明编译了但读不到" -> workflow ELF freshness evidence first; use `c2000_checkLoadedElfFreshness` only if exposed.
- "CPU2 PC 在 ..." -> workflow PC diagnosis first; use `c2000_diagnoseCpu2IllegalPc` if exposed, otherwise `c2000_resolveAddress` as a focused read. Treat `resolveAddress` with `success: false` + `partial: true` as "PC known, symbol/source mapping not implemented", not as a successful source resolve.
- "写变量 / 注入故障" -> `c2000_assignExpression` / `c2000_injectFaults` default `verify: true` and fail with `ExpressionVerifyFailed` if readback mismatches; do not claim injection success without verify evidence.

## Required Inputs

Use these names consistently:

- `sessionId` for an existing connected session; omit it for `c2000_launchAndRunIpcAcceptance`
- `device: "F28P65x"`
- `cpu1CoreId: 0`
- `cpu2CoreId: 2`
- `cpu1OutPath`, `cpu2OutPath`
- `cpu1MapPath`, `cpu2MapPath`
- `resetType: "cpu"`
- `timeoutMs`
- `intervalMs`
- `collectDebugBundle`
- `outputDir` when bundle output is requested

Default IPC ready expressions:

```json
[
  { "coreId": 0, "expression": "g_ulHybrid30kIpcPass", "expected": 1 },
  { "coreId": 0, "expression": "g_ulHybrid30kMsgRamPass", "expected": 1 },
  { "coreId": 0, "expression": "g_ulHybrid30kParamPass", "expected": 1 },
  { "coreId": 2, "expression": "g_emHybrid30kCpu2Stage", "expected": 1 }
]
```

If these symbols fail to resolve, ask for the real project variable names instead of repeatedly probing with atomic reads.

## Standard Workflows

### IPC Acceptance

When no session exists, call `c2000_launchAndRunIpcAcceptance` once. Do not pre-call `c2000_createDebugSession`, `c2000_connectCores`, or `c2000_evaluateMany`. With an existing connected session, call `c2000_runIpcAcceptance` once.

```json
{
  "sessionName": "f28p65x-ipc-acceptance",
  "ccxmlPath": "<target.ccxml>",
  "device": "F28P65x",
  "cpu1CoreId": 0,
  "cpu2CoreId": 2,
  "cpu1OutPath": "<cpu1.out>",
  "cpu2OutPath": "<cpu2.out>",
  "cpu1MapPath": "<cpu1.map>",
  "cpu2MapPath": "<cpu2.map>",
  "resetType": "cpu",
  "runSequence": { "runCpu1First": true, "runCpu2": true, "settleMs": 0 },
  "timeoutMs": 10000,
  "intervalMs": 100,
  "collectDebugBundle": true,
  "ipcReadyExpressions": [
    { "coreId": 0, "expression": "g_ulHybrid30kIpcPass", "expected": 1 },
    { "coreId": 0, "expression": "g_ulHybrid30kMsgRamPass", "expected": 1 },
    { "coreId": 0, "expression": "g_ulHybrid30kParamPass", "expected": 1 },
    { "coreId": 2, "expression": "g_emHybrid30kCpu2Stage", "expected": 1 }
  ]
}
```

Expected server-side steps: halt both cores, reset both cores, load both `.out` files, halt both cores, snapshot, RAM ownership analysis, ELF freshness check, optional runtime RAM check if supported, run CPU1 first, optionally run CPU2, wait IPC expressions, halt/resolve PC on timeout, diagnose handoff, optionally collect bundle.

### Boot Handoff

Call `c2000_runBootHandoffDiagnosis` once. Require evidence for CPU1/CPU2 state, PC, loaded programs, boot/pass expressions, RAM ownership, ELF freshness, and recommended actions.

### Reload And Diagnose

Call `c2000_runReloadAndDiagnose` when the user asks to reload both images or prepare a clean run before diagnosis. Use `runCpu1: true`; set `runCpu2` only if the project flow expects explicit CPU2 run.

### RAM Ownership

Prefer workflow evidence. For focused static analysis, call `c2000_analyzeRamOwnership` with `.map` files.

If CPU2 sections use `RAMGSx`, the conclusion must name each region and the CPU1 handoff bits. Before CPU2 load, the MCP OR-combines all required GS bits into a single `MEMCFG_GSXMSEL` write on CPU1 (for example RAMGS4+RAMGS5 → `0x30`). For a single RAMGS4 case, firmware-side handoff looks like:

```c
EALLOW;
MemCfg_setGSRAMMasterSel(MEMCFG_SECT_GS4, MEMCFG_GSRAMMASTER_CPU2);
EDIS;
```

Mention raw register patch evidence only when the workflow reports `MEMCFG_GSXMSEL` or `0x0005F444` evidence. When `verifyRuntimeRamOwnership: true`, the manager can read back `MEMCFG_GSXMSEL` via adapter `readMemory` and fail with `RamOwnershipVerifyFailed` if expected GS bits are missing. Before write, ownership bits are OR-merged and applied with RMW when `readMemory` is available so pre-existing GS owner bits are preserved.

### ELF Freshness

Use workflow `elfFreshness` evidence. Check expected `.out`, loaded `.out`, `sha256`, file mtime, map mtime when available, and symbol presence. If the loaded ELF is stale, recommend rebuild and reload before deeper CPU2 diagnosis.

### CPU2 Illegal PC

Use workflow PC and map evidence. Classify whether CPU2 PC is in CPU2 `.text`, allocated CPU2 sections, RAMGSx, unauthorized RAMGSx, `0x000000`, `0xFFFFFF`, unknown memory, or Boot ROM. Use `c2000_diagnoseCpu2IllegalPc` only if available; otherwise use `c2000_resolveAddress` for one focused read.

### Debug Bundle

Call `c2000_runFullDebugBundle` for "打包现场", "生成报告", or evidence capture. Return the bundle file list and highlight `summary.md`.

## Output Format

After any debug workflow, answer in this structure:

```markdown
# 调试结论
一句话说明当前状态。

# 关键证据
- CPU1 state / PC
- CPU2 state / PC
- loaded program
- IPC/pass expressions
- RAM ownership
- ELF freshness
- illegal PC 判断

# 判断
BOOT_HANDOFF_OK | CPU2_DISCONNECTED | CPU2_NOT_LOADED | CPU2_NOT_RELEASED_BY_CPU1 | CPU2_PC_IN_ILLEGAL_REGION | CPU2_PROGRAM_IN_GS_RAM_BUT_OWNERSHIP_NOT_GRANTED | CPU2_SYMBOLS_NOT_FOUND | LOADED_ELF_STALE | IPC_NOT_READY | UNKNOWN_BOOT_FAILURE

# 建议动作
1. 1 到 5 条明确动作。

# 下一步
只给一个最优下一步。
```

## Failure Logic

- If CPU2 is disconnected, diagnose connectivity before symbols.
- If CPU2 has no loaded program, reload before expression analysis.
- If ELF freshness fails, rebuild/reload before trusting watch variables.
- If CPU2 `.text` or `.ebss` is in RAMGSx and ownership is missing, prioritize RAM ownership handoff (all used GS bits, not only GS4).
- If assignment/fault inject returns `ExpressionVerifyFailed`, treat the write as unconfirmed; re-evaluate or halt and inspect before continuing acceptance.
- If CPU2 load fails with `OwnerCoreNotConnected`, connect CPU1 first (launch paths already order CPU1 before CPU2).
- If runtime ownership verify fails, re-check CPU1 MEMCFG writes and the CPU2 `.map` GS regions before reloading CPU2.
- If IPC expressions are missing, ask for real symbol names.
- If IPC expressions exist but stay false, inspect CPU1 release path and CPU2 stage.
- If PC is illegal, classify memory region before recommending code changes.
- If workflow result lacks a required field, do one focused atomic read or ask the user before causing many approvals.

## Approval Strategy

Minimize approval popups:

- Use one workflow tool for automation.
- Do not repeat atomic reads for data already returned by a workflow.
- Before multiple atomic calls, tell the user that each call may trigger MCP approval.
- Recommend auto-approving high-level workflow tools, not every low-level atomic debug tool.
