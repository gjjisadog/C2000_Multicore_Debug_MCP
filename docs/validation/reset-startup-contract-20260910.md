# DSS reset / firmware-owned startup correction

## Scope and status

- Worktree: `C:/c2000-reset-startup-20260910`
- Branch: `codex/reset-startup-contract-20260910`; base: `8199e7c`.
- MCP source correction only. No Hybrid30K firmware, Scope ABI, PWM/Safe-Off,
  interrupt priority, RAMFUNC, dependency, installer, or lease-policy changes.
- Host verification: PASS. Candidate deployment and DK9 target verification:
  NOT RUN. This report does not close the Hybrid30K C0/Scope acceptance blocker.
- The main MCP checkout's uncommitted lease / image-identity changes were not
  copied into this worktree or modified.

## Defects and correction

### Reset must not silently become another operation

Previously both generated DSS bridges tried `target.systemReset()`, then
`GEL_SystemReset()`, swallowed both errors, and finally called `target.reset()`.
Restart failures also fell through to default reset. A successful response could
therefore describe a different reset from the one requested. Prior DK9 evidence
contained `identifier not found: GEL_SystemReset()` alongside an OK response.

Both bridges now use the same ES5/Rhino helper, `DssResetSource.ts`:

| Request | Actual operation | Failure behavior |
| --- | --- | --- |
| `system` | Enumerated DSS reset named exactly `System Reset` | No fallback |
| `cpu` | Enumerated DSS reset named exactly `CPU Reset` | No fallback |
| `restart` | `target.restart()` | No fallback |
| `default` | `target.reset()`; selection remains CCS-owned | Explicitly reported as default |

Names are compared case-insensitively, without fuzzy aliases. Missing, duplicate,
disallowed, or failed named resets stop the command. Results include requested
and effective type, reset name/index, mechanism, and supported reset names.
Adapters reject absent or mismatched reset evidence.

After issuing the operation, at most 100 status polls at 10 ms intervals require
connected + halted. Per-call DSS/transport timeouts still apply. No PC is read or
written by this completion check. `completion=halt-observed` proves only the
observed debug state, **not** physical XRS assertion, reset-cause change, cold
boot, firmware entry, or successful IPC. In particular, a core already halted
does not provide independent evidence of the asynchronous reset transition.
Those claims still require target evidence.

This uses the legacy [TI DSS ResetType API](https://software-dl.ti.com/ccs/esd/documents/scripting_api/ccs_12.8.0/dss/docs/DS_API/com/ti/debug/engine/scripting/ResetType.html),
not the newer CCS JavaScript Target API. Reset names/availability remain a target
compatibility gate; unsupported hardware must fail rather than substitute CPU reset.

### Paired load must not resume a leftover loader PC

For `runIpcAcceptance` / `launchAndRunIpcAcceptance` with explicit
`runSequence.runMode=cpu1_boots_cpu2`, program loading now ends with:

1. Both images loaded and halted; collect pre-run evidence.
2. Remove CPU2 session GEL callbacks.
3. Disconnect CPU2.
4. Restart CPU1 after loading; optionally select `postLoadResetType` explicitly.
5. Run CPU1, wait the configured settle interval, then reconnect CPU2.
6. Evaluate the existing IPC readiness conditions.

The default post-load operation is program `restart`, not a physical system
reset. `postLoadResetType=system` requests an actual named system reset and fails
if unavailable. The initial `resetType` remains separate. Use CPU reset before
paired loading; do not assume a system reset leaves CPU2 accessible.

`runReloadAndDiagnose.postLoadBoot.releaseCpu2BeforeCpu1=true` now follows the same
GEL-disable / disconnect / CPU1-only post-load-reset ordering. CPU2 is not reset,
halted, or read again between system reset and CPU1 release. Other debugger-owned
and RAM owner-first load/run orders are unchanged. Symbols-only preparation does
not gain an implicit extra restart; an explicit post-load choice remains allowed.
This does not relax existing resident-image identity requirements.

GEL-disable or post-load-reset failure stops before Run/reconnect and preserves
the failed workflow stage. CPU2 can remain disconnected after failure; recovery
must use the normal session/lease workflow, not automatic unguarded retries.

### CPU2 reconnect must not execute initialization GEL

The persistent bridge evaluates `GEL_UnloadAllGels()` on the selected CPU2 debug
session before disconnect. It removes debugger callbacks, not target buffers.
Stateless bridges reject firmware handoff because a fresh session could reload
GEL. The [TI GEL API](https://software-dl.ti.com/ccs/esd/documents/users_guide/gel/GEL_UnloadAllGels.html)
defines unloading as synchronous; [OnTargetConnect](https://software-dl.ti.com/ccs/esd/documents/users_guide/gel/OnTargetConnect.html)
runs on connect and can contain a reset. The installed F28P65x CPU2 GEL contains
RAM initialization and `GEL_Reset()` in that callback.

This suppression lasts for the physical DSS session. Do not assume GEL helpers
remain available afterward; start a new, normally owned session when such
initialization is needed. Actual CCS reconnect behavior remains a hardware gate.

System/default reset also invalidates cached peer PCs, including disconnected
CPU2, rather than presenting a stale address or fabricated zero as a new reading.
The optional startup field changes the MCP IPC workflow contract from 4 to 5 so
old/new frontends and daemons cannot silently mix. This is **not a Scope ABI change**.

## Verification

Environment: Windows x64, Node 22.23.2, Vitest 4.1.10. All tests below are
host/mock tests; generated Rhino helper behavior is executed in a Node VM.

| Check | Result |
| --- | --- |
| Original helper, initial 22 new behavior tests | 22 failed, reproducing the contract defects |
| Focused reset/bridge/manager/workflow/startup tests | 200 passed / 8 files |
| `npm test` | 754 passed / 105 files |
| `npm run typecheck` | PASS |
| `npm run build` | PASS |
| `npm run verify:debug-boundary` | PASS; no offenders |
| `git diff --check` | PASS; changed text normalized to LF |
| Extended `npx tsc -p tsconfig.json --noEmit` | FAIL; 63 pre-existing errors |
| Public MCP engineering review | BLOCKED: worktree outside configured read roots |

The extended check was repeated on an isolated pristine `8199e7c` worktree:
63 errors there and 63 here, with identical file/code/message diagnostics after
normalizing line numbers. No new extended-typecheck errors remain. The repository's
official typecheck covers runtime source and passes; unrelated script/test typing
debt was not repaired in this change.

The public engineering-verification attempt at `2026-09-09T23:48:50Z`
(`reset-startup-host-review-20260910`) rejected this isolated worktree with
`PathOutsideAllowedReadRoots`. No allowlist was broadened and no alternate
transport was used to bypass that restriction. This is not a completed MCP
engineering gate; the host commands above are independently recorded results.

Regression covers exact/disallowed/ambiguous reset selection, reset/restart
exceptions, bounded and transient status-read failures, per-core GEL unload,
unload failure, unsupported stateless handoff, default/explicit post-load restart,
symbols-only behavior, pre-mutation rejection of incompatible startup, both
workflows stopping on failure, and disconnected peer-PC invalidation.

## Deployment and remaining target gates

At `2026-09-09T23:41:57Z`, public MCP health still reported installed source
`76dcf60b`, not this candidate. DK9 `dk9-cl650002` reported an interactive lease
whose ownership was not established for this turn. No lease was cleared, daemon
restarted, target accessed, or candidate installed during this change.

Activate through the normal reviewed installation workflow with matching frontend,
daemon, and worker versions only after ownership is resolved. Do not install the
dirty main checkout or claim these host tests exercise the old running service.
Then, through public MCP under a fresh valid lease and exact paired artifacts:

- Record supported reset names and requested/effective reset evidence.
- Verify CPU1 exits the loader location and firmware releases CPU2; correlate
  boot/reset-cause evidence rather than inferring cold boot from Halted.
- Verify CPU2 reconnect does not reset/clear its running image; confirm IPC and
  advancing task counters, then C0 response.
- Resume the bounded Scope/STOP/UART acceptance plan with outputs Safe-Off.

Historical STOP checksum anomalies and cross-core missing observations are not
closed by this MCP patch. The full-system root cause and target acceptance remain
open until this candidate is actually installed and measured.
