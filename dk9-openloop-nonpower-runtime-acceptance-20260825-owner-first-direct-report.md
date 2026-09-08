# DK9 OpenLoop Non-Power Runtime Acceptance

日期：2026-08-25（Asia/Shanghai）  
结论：**INCONCLUSIVE / corrected RAM execution, IPC, runtime safety and formal-command diagnostic passed; final 3P3W OpenLoop A/B/C acceptance was not executed**

## Scope and identity

- Hybrid_Platform HEAD: `cac656b560240168856a4eccdc5177387d233caf`
- CPU1/CPU2 fresh RAM artifacts were built successfully; host/static checks: 48 passed.
- CPU1 OUT SHA-256: `79C227906F3F888C500F5E1A9673B175A10E00002D35215B0CAAFC55BF93C8C7`
- CPU2 OUT SHA-256: `D1DFA98BF19D6D1E11650D5F020E3510D0EF29C8A5ABA3B2CDD7211AB5781D6E`
- Board: `dk9-cl650002` / probe `CL650002` / `F28P65x`
- Direct debug session: `dbg-e0ebb645-2a30-44e7-913d-eb1a3046e976`
- Targeted CPU1 identity diagnosis session: `dbg-5634f332-73ac-45cf-a164-da99a74d5eb1`

## 最新受控诊断（runtime Guard 时机修正）

- Job: `run-bb0b18f7-1538-4c32-8049-65d9ddd09ec3`
- Session: `dbg-59832eeb-2d6b-4e66-a9e8-8fd0b22deeca`
- Plan: `dk9-openloop-nonpower-runtime-acceptance-20260825-runtime-guard-corrected-retry4-cac656`
- Board: `dk9-cl650002` / `CL650002`; final board state `READY`。
- Launch 第一次遇到一次性 CPU2 `ProgramLoadFailed`，仅对可重入的 launch 做了 reconcile/retry；第二次 load PASS。表达式写入、run、halt 均未配置自动重试。
- Launch 阶段全局 Guard 只使用启动前有效的权威 `g_stBoardSafetyWatch.uiTripLatched==1`；Runtime Trip/Relay/Sampling 在 `runIpcAcceptance` 完成后、正式命令前及全过程等待条件中检查。
- 前一份 Guard 复现任务 `run-67e099cf-c26f-48ab-a7ec-e4fc8b1ce707` 已证明时机问题：launch PASS 后、任何 Grant 和 `runIpcAcceptance` 前，旧全局 Guard 读到 Runtime Watch `uiTripLatched=120`、`uiRelayDomainAvailable=19`、`uiSamplingArmed=0`，随即 fenced halt；该任务没有执行任何表达式写入。

### 任务闭环状态

| 阶段 | Status | 结果 |
|---|---|---|
| Preflight | PASS | 板卡、worker、artifact 路径与 SHA 校验通过 |
| Owner-first launch | PASS | CPU1/CPU2 RAM ELF 均加载、符号有效；CPU1/CPU2 均 Halted；CPU1 PC=`547565`，CPU2 PC=`100128` |
| Reset/load/run + IPC | PASS | 显式 halt/reset、CPU1 先运行再加载 CPU2、两核运行与 IPC ready 完成；RAM ownership mask=`24` |
| Runtime baseline | PASS | CPU1 Magic/Version=`1380011569/3`；CPU2=`1447119922/3`；Trip=`1`、RelayDomain=`0`、SamplingArmed=`1` |
| CPU1 Runtime grant / CPU2 validation mailbox | PASS | CPU1 nonce=`1001`；CPU2 nonce=`2001`；Logic state=`1`、channel=`1`、run mode=`2` |
| Debug gate diagnostic | PASS | `iCtrlRunCmdReq: 0→1`；CPU1 CoreComm fault `2048→0`；正式命令链可观察 |
| Stop | PASS | CPU1 nonce=`1004`、run=`0`；CPU2 nonce=`2002`、state=`0`、run=`0` |
| Halt / cleanup | PASS | 两核 Halted，session closed，board `READY` |

### 诊断快照与最终判定边界

原子 expression snapshot 显示：

| 阶段 | CPU1 Runtime Watch | CPU2 formal command / gate | 安全状态 |
|---|---|---|---|
| Grant 后、debug gate 前 | `uiRunGranted=1`、`ulLastNonce=1001`、`uiFormalOpenLoop=1`、`uiFormalWireMode=1`、`iRunCmd=0`、`uiRuntimeValid=1` | `ulLastNonce=2001`、Logic state/channel/run mode=`1/1/2`；`iCtrlRunCmdReq=0`、command `iRunCmd=0`、`uiCtrlMode=3`、`uiWireMode=1` | Trip=`1`、RelayDomain=`0`、SamplingArmed=`1` |
| Debug gate 置 1 后（12 samples） | `iRunCmd=1`、`uiCtrlMode=3`、`uiFormalOpenLoop=1`、`uiFormalWireMode=1`、`uiRuntimeValid=1`；`uiInvPwmCalcEnable=0`、`uiInvPwmRan=0`、Current Loop=`0` | `iCtrlRunCmdReq=1`、`iRunCmd=1`、`uiCtrlMode=3`、`uiWireMode=1`、fault=`0` | 12 samples 全部保持 Trip=`1`、RelayDomain=`0`、SamplingArmed=`1` |
| Stop 后 | `uiRunGranted=0`、`ulLastNonce=1004`、`iRunCmd=0`、`uiCtrlMode=0`、`uiRuntimeValid=0` | `iCtrlRunCmdReq=0`、`ulLastNonce=2002`、state=`0`、`iRunCmd=0`、`uiCtrlMode=0` | Trip=`1`、RelayDomain=`0`、SamplingArmed=`1` |

这次诊断确认了两件事：

1. `iCtrlRunCmdReq=0` 是 CPU2 预加载调试门控的输入；将其置为 `1` 后，CPU1 的 `ulCtrlCmdFaultFlags` 从 `2048 (CORE_COMM_FAULT_CTRL_NOT_ARMED)` 变为 `0`，CoreComm `iRunCmd=1` 正常传播。它不是 IPC 固件故障。
2. 当前生成参数 `uiWiringType=1`，所以 CPU2 和 CPU1 formal Watch 的 `uiWireMode=1`，即 3P4W；原始验收要求 3P3W=`0`。因此本次只完成了 3P4W 的非功率命令链诊断，`uiInvPwmCalcEnable=0` / `uiInvPwmRan=0` 是该配置下的前置不满足结果，不是 OpenLoop 算法失败。该参数来自当前 CPU2 生成配置；要进入最终验收必须先生成 `uiWiringType=2` 的 3P3W CPU2 artifact，不能通过调试器直接改写运行态输出字段冒充验收配置。

### 当前构建兼容性阻塞（非板卡运行故障）

验收固件与当前 CPU2 参数模型不兼容，现有构建不具备通过 3P3W + SVPWM A/B/C 验收的条件：

- CPU1 的验收硬门槛要求 `3P3W + SVPWM`，见 [cpu1_ctrl.c](C:/Users/11981/Documents/Hybrid_Platform/project/hybrid30k/dsp/cpu1/src/cpu1_ctrl.c:1310)。
- 当前 `0x5307` 参数的 `uiWiringType=1`，见 [0x5307 model](C:/Users/11981/Documents/Hybrid_Platform/project/hybrid30k/rtm/csv/models/0x5307_INVERTER_30kW_H_LV_US_MODEL.csv:6)；`0x5309` 也为 `1`，见 [0x5309 model](C:/Users/11981/Documents/Hybrid_Platform/project/hybrid30k/rtm/csv/models/0x5309_INVERTER_50kW_H_US_MODEL.csv:6)。按 [cpu2_param.c](C:/Users/11981/Documents/Hybrid_Platform/project/hybrid30k/dsp/cpu2/src/cpu2_param.c:697) 的契约，`1→3P4W`、`2→3P3W`。
- CPU2 在初始化时将该 wiring type 锁存进 Logic 上下文，见 [cpu2_logic.c](C:/Users/11981/Documents/Hybrid_Platform/project/hybrid30k/dsp/cpu2/src/cpu2_logic.c:27)；Runtime Grant 不会把 3P4W 运行态改成 3P3W。
- 提交 `4dc0897d` 增加了 CPU1 3P3W Runtime Acceptance 代码、文档和静态测试，但没有补充匹配的 CPU2 `uiWiringType=2` 参数模型；当前仓库、Git 历史及现有 worktree 中未找到该模型。
- 现有 [test_open_loop_runtime_acceptance.py](C:/Users/11981/Documents/Hybrid_Platform/tests/test_open_loop_runtime_acceptance.py:57) 的 6/6 通过只证明 CPU1 源码含有 3P3W 条件，不能证明所选 CPU2 模型能够生成 3P3W；这是本轮已确认的测试覆盖缺口。

因此 `uiFormalWireMode=1`、`uiInvPwmCalcEnable=0` 和 `uiInvPwmRan=0` 与当前模型及代码路径一致，不构成 OpenLoop 算法失败证据。下一步应先由产品定义确认一个独立的验收用 `uiWiringType=2` 模型身份，再让 CPU1/CPU2 基于同一模型身份和 CRC 重新构建并做静态一致性检查；不得直接把正式 `0x5307` 或 `0x5309` 改写为 3P3W。

故本次最终结论仍为 **INCONCLUSIVE / NOT EXECUTED（最终验收）**：CPU1/CPU2 已运行并完成安全的 formal-command 诊断，但 3P3W/SVPWM 要求不满足，A/B/C 算法验收未执行；不存在基于本次结果判定 OpenLoop 算法失败的依据。

证据：

- [manifest.json](C:/Users/11981/.c2000-multicore-mcp/runtime/artifacts/run-bb0b18f7-1538-4c32-8049-65d9ddd09ec3/manifest.json)
- [result.json](C:/Users/11981/.c2000-multicore-mcp/runtime/artifacts/run-bb0b18f7-1538-4c32-8049-65d9ddd09ec3/result.json)
- [expression-snapshots.json](C:/Users/11981/.c2000-multicore-mcp/runtime/artifacts/run-bb0b18f7-1538-4c32-8049-65d9ddd09ec3/expression-snapshots.json)

## 早期受控复测（corrected reset/load rerun；历史记录）

- Session: `dbg-cfdd82dd-2233-49d4-afd4-6d0d8301a309`
- Sequence: `connect -> halt -> CPU reset -> load CPU1/CPU2 RAM ELF -> halt -> PC/ELF check -> runCores([0,2]) -> guarded startup poll -> halt -> diagnosis -> close`。
- CPU1 load 后立即 PC=`0x1F66A`，解析为 RAMD4 `main`；CPU2 load 后立即 PC=`0x18720`，解析为 RAMGS4 `main`。两者均为目标 RAM ELF，未落入 Flash。
- Loaded artifact identity was fresh and symbolized: CPU1 SHA-256 `79C227906F3F888C500F5E1A9673B175A10E00002D35215B0CAAFC55BF93C8C7`; CPU2 SHA-256 `D1DFA98BF19D6D1E11650D5F020E3510D0EF29C8A5ABA3B2CDD7211AB5781D6E`。
- Runtime polling ran from 60 ms through 8 s (81 samples). CPU1/CPU2 Magic, Version, IPC stage and CPU2-ready all matched immediately and remained stable:
  - CPU1 `ulMagic=1380011569 (0x52414E31)`, `uiVersion=3`, `emStage=5`, `uiCpu2Ready=1`。
  - CPU2 `ulMagic=1447119922 (0x56414C32)`, `uiVersion=3`, `emStage=5`。
- The corrected runtime safety state passed for the Watches that are present in the loaded ELF: board and CPU1 Runtime Watch reported `uiSamplingArmed=1`, which is the expected ePWM1/ADC sampling-chain state after the control timebase starts; board `uiTripLatched=1`, CPU1 Runtime `uiTripLatched=1`, and `uiRelayDomainAvailable=0` remained valid. The Runtime ELF does not contain `g_stCpu1ValidationWatch`, so `uiPwmArmGranted` and `uiSafeOffAsserted` were not target-measured in this run; they must not be reported as Runtime Watch observations. Static source/configuration review remains the applicable safety-boundary evidence. The prior `SamplingArmed==0` check was an acceptance-condition error, not a firmware safety fault. Grant/A/B/C/Stop were still not executed in that run。
- At the safety halt, Watch addresses and values were captured: board Watch `141222` (Trip=`1`, SamplingArmed=`1`, WDG reset=`0`); CPU1 Runtime Watch `141128` (Magic/Version=`1380011569/3`, Trip=`1`, RelayDomain=`0`, SamplingArmed=`1`); CPU2 Validation Watch `48040` (Magic/Version=`1447119922/3`, LastNonce=`0`, Hold=`0`)；CPU1 CoreComm Watch `140928`（stage=`5`, CPU2-ready=`1`），CPU2 CoreComm Watch `47360`（stage=`5`, init=`1`, ctrl-blocked=`0`, fault=`0`）。
- Halt snapshot: CPU1 PC=`0x1F26F` (`CPU1_Ctrl8k_Isr`, RAMD4); CPU2 PC=`0x1644F` (`CPU2_Product_Run1ms`, RAMGS3)。两核均 Halted，session closed，board returned `READY`。
- Runtime ownership verification remained `expected mask=24`, `actual=24`, `matched=true`; the read-only boot-handoff diagnosis completed successfully and its raw evidence is recorded above。

### 该次复测验收状态（历史）

| Item | Status | Note |
|---|---|---|
| Reset/load ordering | PASS | CPU reset before load; both cores halted after load |
| RAM ELF execution identity | PASS | CPU1/CPU2 PC resolved inside target RAM maps |
| Artifact freshness / symbols | PASS | Fresh SHA and symbols loaded for both ELF files |
| CPU2 RAM ownership | PASS | GS3/GS4; mask `24` matched |
| Runtime Magic/Version/IPC | PASS | CPU1/CPU2 values and IPC stage matched |
| Authoritative Trip guard | PASS | Trip remained `1` |
| SamplingArmed runtime state | PASS | `1` is expected after ePWM1/ADC sampling-chain startup; it is not PWM Arm |
| PWM Arm / SafeOff | STATIC BOUNDARY / NOT TARGET-MEASURED | Runtime ELF excludes `g_stCpu1ValidationWatch`; no direct `uiPwmArmGranted` / `uiSafeOffAsserted` observation is valid in this report |
| Grant / case A / case B / case C | NOT EXECUTED | Safety gate failed before any command assignment |
| Stop / final acceptance | NOT EXECUTED | No acceptance case was entered |
| OpenLoop algorithm verdict | INCONCLUSIVE | No A/B/C evidence was collected |
| Cleanup | PASS | Both cores halted, session closed, board `READY` |

### SamplingArmed 判定修正

`board_safety.h` defines `uiSamplingArmed` as “ePWM1/ADC hardware sampling chain started”. `BOARD_CtrlTimebase_Start()` starts the control timebase, asserts the Safety Trip, then sets `uiSamplingArmed=1`; `BOARD_AdcFastSample_Get()` rejects samples while it is `0`. Therefore the runtime acceptance condition is `SamplingArmed=1` together with Trip=`1`, Relay Domain=`0`, AC SPS disabled and no physical PWM output; PWM Arm/SafeOff remains a required static safety boundary for this Runtime ELF, not a directly measured `g_stCpu1ValidationWatch` field in this report. The original pasted acceptance requirement did not require `SamplingArmed=0`。

## Previous launch-based run (historical evidence)

1. Loaded CPU1 then CPU2 with the owner-first sequence; CPU1 settle was 500 ms, CPU2 used `ramOwnershipPolicy=require-map`.
2. Launch snapshot: both cores connected, symbols loaded, both halted. Board authoritative Trip was `1`; board SamplingArmed was `0`.
3. Ran explicit core IDs `[0, 2]`. Ten 100-ms monitor samples were collected; board Trip stayed `1/1` and no safety halt was required.
4. Waited 8 s for runtime Watch Magic/Version and IPC readiness while continuing to check board Trip. Trip stayed `1`; readiness did not arrive.
5. Collected boot-handoff diagnosis, PC/core state, loaded-program freshness, RAM ownership and raw Watch addresses/values; halted both cores and closed the session.
6. Performed one isolated CPU1 diagnosis: `halt -> CPU reset -> load RAM ELF -> immediate PC capture -> 50 ms run -> halt`.

## 历史证据（previous launch-based run）

### Startup and runtime guards

- Board `g_stBoardSafetyWatch.uiTripLatched`: `1` before run and in all runtime guard samples.
- Board `g_stBoardSafetyWatch.uiSamplingArmed`: `0`.
- CPU1 runtime Watch address: `141128`; final values: `ulMagic=8061161`, `uiVersion=119`, `uiTripLatched=120`, `uiRelayDomainAvailable=19`, `uiSamplingArmed=16134`.
- CPU2 validation Watch address: `48040`; final values: `ulMagic=0`, `uiVersion=0`, `ulLastNonce=0`, `uiHoldActive=0`.
- Expected valid values were CPU1 `0x52414E31` / version `3`, CPU2 `0x56414C32` / version `3`. The observed values were not treated as firmware results.

### IPC and target state

- CPU1 CoreComm Watch address: `140928`; final `emStage=0`, `uiCpu2Ready=0`, `ulCpu2BootLastError=0`.
- CPU2 CoreComm Watch address: `47360`; final `emStage=3`, `uiInitParamApplied=0`, `uiCtrlEnableBlocked=0`, `ulCtrlFaultFlags=0`.
- During the wait both cores were observed `Running` (CPU1 PC around `549042`, CPU2 PC around `102431`).
- After safety halt: CPU1 `Halted`, PC `543659`; CPU2 `Halted`, PC `102896`.

### RAM ownership and artifact freshness

- CPU2 map uses `RAMGS3` and `RAMGS4`.
- Runtime ownership verification: expected mask `24`, actual MEMCFG value `24`; `matched=true`.
- Both loaded programs were fresh and had symbols loaded.
- Diagnosis verdict: `BOOT_HANDOFF_NOT_READY`; `ramOwnershipReady=true`, `runtimeRamOwnershipReady=true`, `cpu1Ready=false`, `cpu2Ready=false`.

### Targeted CPU1 execution-identity diagnosis

- After `CPU reset -> RAM ELF load -> halt`, PC was `128618 = 0x1F66A`, resolved by the RAM map to `main` in `RAMD4`.
- After a controlled 50 ms CPU1-only run, PC was `135057 = 0x20F91`, resolved by the RAM map to `IPC_Port_Timeout_IsExpired` in `RAMD5`.
- During all five 10 ms samples: board Trip=`1`, SamplingArmed=`0`, watchdog-reset flag=`0`, CPU1 Magic=`1380011569` (`0x52414E31`), Version=`3`, and Relay Domain=`0`.
- This proves the fresh RAM ELF and its Watch symbols execute correctly when reset/load ordering is controlled.

## 历史验收状态（previous launch-based run）

| Item | Status | Note |
|---|---|---|
| Fresh build / artifact identity | PASS | Current Hybrid_Platform HEAD and matching CPU1/CPU2 RAM artifacts |
| Owner-first launch / CPU2 RAM ownership | PASS | GS3/GS4 ownership verified on target |
| Launch safety Guard | PASS | Only authoritative board Trip used; Trip=`1` |
| `runCores` | PASS | Explicit core IDs `[0,2]` executed |
| Runtime Trip guard | PASS | Trip remained asserted throughout the run monitor and startup wait |
| Runtime Watch Magic/Version | FAIL / TIMEOUT | CPU1 `8061161/119`, CPU2 `0/0`, not valid initialization |
| CPU1/CPU2 IPC handoff | FAIL / TIMEOUT | CPU1 stage `0`, CPU2 stage `3`; readiness not reached |
| Grant / case A / case B / case C | NOT EXECUTED | Startup handoff gate failed; no command grant was sent |
| Stop / final acceptance | NOT EXECUTED | No acceptance case was entered |
| Relay Domain acceptance | INCONCLUSIVE | `19` was observed in an invalid/uninitialized Watch and is not evidence of relay availability |
| Cleanup | PASS | Both cores halted, session closed, board returned `READY` |

## Root-cause boundary

The primary failure category of the original launch-based run was **CPU1 startup/image execution identity**. That prior `launchMulticore` flow performed connect/load/run/halt without a CPU reset or a post-load PC-versus-ELF-range check. Its pre-`runCores` CPU1 PC `552493 = 0x86E2D` maps to the resident Flash image (`prvSCHED_Cpu1_EnterCritical`), while the RAM acceptance map has zero Flash usage and places `g_stCpu1RuntimeAcceptWatch` at `0x22748`. The resident Flash image uses that address range for `cpu1_core_comm.obj` `.bss`, explaining the invalid `120/19` interpretation. The latest owner-first retry with explicit reset/load and runtime-phase Guards confirms this original identity problem is fixed for the current diagnostic run.

The controlled reset/load diagnosis proves the RAM acceptance ELF can execute and produce valid Magic/Version/Trip/Relay values. Therefore `BOOT_HANDOFF_NOT_READY` was a downstream symptom of the original run, not the primary cause; RAM ownership mask `24` is not the cause; and no final OpenLoop algorithm verdict is valid because the required 3P3W/SVPWM A/B/C cases were not executed. The latest diagnostic did execute the formal grant/command chain and Stop safely. The CPU2 wait constant must be `0x56414C32 = 1447119922`, not `1447121970`.

For the latest controlled diagnostic, the remaining blocker is **CPU1 acceptance logic versus CPU2 parameter-model incompatibility**: the loaded model is 3P4W (`uiWiringType=1`), while the acceptance gate requires 3P3W + SVPWM. Consequently `uiInvPwmCalcEnable=0` and `uiInvPwmRan=0` are expected configuration-gate results, not an OpenLoop failure. The final A/B/C verdict remains not executable until an independently identified `uiWiringType=2` acceptance model is defined and both CPU1/CPU2 artifacts are rebuilt from the same model identity and CRC.

The current controlled path now performs reset-before-load through `runIpcAcceptance`, captures post-load PC/ELF identity, uses the launch-stage authoritative Trip Guard, and moves Runtime Watch checks to the runtime phase. No power, PWM enable, relay enable, or Trip clear was performed.
