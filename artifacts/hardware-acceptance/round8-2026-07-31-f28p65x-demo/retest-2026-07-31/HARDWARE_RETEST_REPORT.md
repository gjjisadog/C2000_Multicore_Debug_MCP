# F28P65x hardware retest report

Date: 2026-07-31

Board: `f28p65x-demo-cl650002`

Probe: XDS110 `CL650002`

Device: F28P65x

Firmware: TI `ipc_ex1_basic`

## Safety and routing

The operator confirmed that the rig was isolated, had no high-voltage supply, had its power stage disabled, and had PWM physically inhibited. Every target operation was routed through the daemon and board worker with an explicit board lease, worker generation, adapter session, logical session, and CPU identity. CPU1 was `coreId=0 / C28xx_CPU1`; CPU2 was `coreId=2 / C28xx_CPU2`. No CCS UI focus or active target was used.

## Result

- IPC acceptance loop: **20/20 passed**. Every durable job loaded both programs using the verified CPU1-first sequence, assigned CPU2's GS4 ownership through CPU1, ran both cores explicitly, and matched `CPU1 pass == 1`.
- 30-minute endurance: **passed**. Three bounded 10-minute streams produced 1800/1800 samples with zero missed polls, overruns, read errors, or dropped samples.
- 2-hour endurance: **passed**. Twelve bounded 10-minute streams produced 7200/7200 samples with zero missed polls, overruns, read errors, or dropped samples. The target ran continuously under one session, one adapter session, and worker generation 5. The polling streams have short export/start transitions, so this is not claimed to be gap-free MCU-side sampling.
- 100 ms short variable stream: **passed** for 100 samples with no missed polls, overruns, read errors, or drops.
- 20 ms short variable stream: **bounded but not declared reliable**. It produced 500/500 samples and no drops, but recorded 14 strict overruns.
- 10 ms short variable stream: **not reliable**. It produced 879 samples with 121 missed/dropped polls and 35 overruns. This remains host-polled observability, not a high-rate waveform acquisition mechanism.

## DLOG and ERAD

- DLOG export was not run. The authorized TI demo has no `g_stDlog` symbol or equivalent firmware buffer contract, and the read-only descriptor correctly returned a symbol-read failure. This is classified as `SKIPPED_UNSUPPORTED_FIRMWARE`, not a board failure and not a hardware verification.
- ERAD profiling was not run. Read-only F28P65x capability inspection is available, but configure/start/stop profiling tools are absent from the active safe MCP profile. Bypassing that profile with raw register writes would violate the repository boundary, so the result is `BLOCKED_BY_TOOL_PROFILE`.

## Fail-closed evidence

Two diagnostic attempts are intentionally excluded from passing statistics:

1. `cpu1_boots_cpu2` timed out because this demo requires the debugger to run CPU2. Timeout recovery halted both cores; re-running with the already validated `debugger_runs_both` contract passed.
2. An earlier endurance continuation crossed the fencing lease lifetime. The daemon rejected the next stream with `BoardLeaseRequired`. That 10-minute artifact is retained under `endurance/interrupted` but was not joined to the continuous two-hour result.

## Evidence layout

- `loops/`: 20 standardized durable job snapshots.
- `variable-stream/short/`: 10 ms, 20 ms, and 100 ms short-run evidence.
- `endurance/30min/`: three completed variable-stream snapshots.
- `endurance/120min/`: twelve completed variable-stream snapshots.
- `endurance/interrupted/`: the valid but non-composable 10-minute pre-expiry snapshot.
- `hardware-retest-result.json`: structured aggregate result; individual artifacts remain the source evidence.

Archive validation parsed 78 JSON documents and 11,157 JSONL records with zero parse errors. All 7200 two-hour samples had monotonically increasing per-stream sequence numbers and host monotonic timestamps. A targeted secret/token/license scan returned zero matches.
