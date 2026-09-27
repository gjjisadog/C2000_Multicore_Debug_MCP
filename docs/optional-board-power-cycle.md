# Optional board power cycle

The C2000 daemon can call the installed `ble-lab-power` stdio MCP server's
`powercycle` tool for the registered `lab_power` USB plug. This is an explicit
step. Paired Flash workflows stop after programming by default. Supplying
`afterFlashPowerCycle` to `c2000_launchAndRunIpcAcceptance` runs marker checks,
the power cycle, and a new read-only resident attach inside that one MCP call.
The C2000
daemon starts its own MCP client for the call; it cannot reuse the Codex
client's stdio connection. It never exposes a general command or shell tool.

## Configuration

At the first C2000 MCP use in each new Codex conversation, the C2000 Skill
calls `c2000_getServerHealth` and asks whether an automatic board power switch
is installed. The response includes `powerSwitchSetup` with the user-facing
question and `automaticControlConfigured`; this reports configuration only,
not physical installation. The answer applies to that conversation. Automatic
power control is selected only when the user confirms installation and the
MCP configuration is present. The health check does not operate the switch.
The stdio MCP connection may be reused across conversations, so the Skill
tracks the conversation boundary rather than the server process.

Add this optional section to the JSON file selected by `C2000_MCP_CONFIG`,
using the same executable, script, and working directory registered for
`ble-lab-power` in Codex. These paths are local installation settings; no BLE
credential is copied into the C2000 configuration.

```json
{
  "powerCycle": {
    "enabled": true,
    "bleLabPowerMcp": {
      "command": "E:\\Project\\ble-mesh-mcp\\ble_mesh_scan\\.venv\\Scripts\\python.exe",
      "args": ["E:\\Project\\ble-mesh-mcp\\ble_mesh_scan\\mcp_server.py"],
      "cwd": "E:\\Project\\ble-mesh-mcp\\ble_mesh_scan"
    }
  }
}
```

The daemon calls exactly `powercycle` with `device="lab_power"`, an off interval
of at least five seconds, and `reason="after_flash"` or
`"connection_recovery"`. The request chooses `mode="auto"`, `"manual"`, or
`"auto_or_manual"` (default). With no configured MCP, `auto_or_manual` and
`manual` return an operator step after safe C2000 cleanup; `auto` fails before
closing the debug session.

## After paired Flash programming

For one client-visible approval, call `c2000_launchAndRunIpcAcceptance` with
`startupPreset="f28p65x-paired-flash"`, `programPreparation="load"`, and
`afterFlashPowerCycle: { mode: "auto", offSeconds: 5, flashChecks: [...] }`.
Include exactly one manifest check for core 0 and one for core 2. Set
`allowDestructiveFlashReload=true` when the conversation's existing authorization covers
an intentional repeat of CPU2 Flash programming. The daemon finishes the
paired write, verifies both current-session writes and target markers, closes
the old session and lease, requests the five-second OFF/ON cycle, then opens a
fresh session with `mode="attach-only"` and re-verifies both resident images.
Omit `sessionMode`, `autoCloseOnComplete`, and `cleanupOnFailure` from this
one-call request. The daemon retains the preparation session through marker
verification, closes it before power control, and cleans up a failed
preparation. An explicit conflicting lifecycle setting is rejected before
target access with a field-specific error.
The resulting `flash`, `powerCycle`, and `resident` evidence remain separate.
The composite reports `ipcAcceptance="NOT_EVALUATED"` because a read-only
attach is an observation, not active startup acceptance. With caller-supplied
`ipcReadyExpressions`, `readOnlyIpc` reports a one-time `MATCHED` or
`NOT_MATCHED` snapshot; without them it reports `NOT_EVALUATED`. If Flash preparation or
marker verification fails, the daemon does not request power. If power returns
`manual_required`, it pauses before the fresh attach. `mode="auto"` fails before
programming when automatic power control is unavailable.

An explicit user authorization remains valid throughout the same conversation
for ongoing work on that board, including rebuilt CPU1/CPU2 images and
intentional reprogramming after a mismatch. The agent records fresh artifact
hashes but does not ask again for every load, session, or MCP call. The
`allowDestructiveFlashReload` flag records that choice for the target load;
it is not independent consent. Respect narrower user limits and request a new
decision only for an operation outside the authorization already given, such
as a different board or a new kind of target mutation. MCP clients retain
final control of their own approval dialogs.

The existing staged route remains available:

Use `c2000_launchAndRunIpcAcceptance` with
`startupPreset="f28p65x-paired-flash"` and `programPreparation="load"`.
The preset supplies `stopAfterFlashPreparation=true` and an interactive
session by default. This stops after both application images are
written while the cores remain halted. The result has
`status="flash_prepared"` and `ipcAcceptance="NOT_RUN"`. A failed or skipped
load cannot reach this result. An existing interactive session can use the
same preset in `c2000_runIpcAcceptance`. If CPU2 Flash is detected from the
linker map without a preset, specify `stopAfterFlashPreparation=true`.
`stopAfterFlashPreparation=false` is rejected before program loading.

If product power cycling is selected, call `c2000_cycleBoardPower` explicitly
with that `sessionId`, `boardId`, `reason="after_flash"`, and `flashChecks` for
core IDs 0 and 2. Each check supplies the exact `.out` path and a matching
resident-image manifest, plus a `.map` path when the manifest names its marker
by symbol. The daemon rehashes both `.out` files, checks that both were
actually written in the current session, and uses the existing read-only
`c2000_verifyResidentImage` path to compare both target markers. A successful
CCS load alone is insufficient. These markers establish image identity; they
are not a byte-for-byte Flash readback.

Only after those checks pass does the daemon quarantine the board, close the
old debug session through its fenced worker route, and confirm the old board
lease is released. It then invalidates target-image identity and calls the
BLE MCP. A Flash failure or unknown load result never triggers the plug.

## Connection recovery

Call `c2000_cycleBoardPower` with `reason="connection_recovery"` and
`firstFailure` containing `operation`, `code`, `message`, and ISO UTC
`observedAt`; `artifactPath` can point to an existing durable failure artifact.
The daemon saves this caller-reported first failure as a SQLite event before
cleanup. It refuses recovery if a durable board job or any target command is
active, another debug session is open, or the old session cannot be closed
through its current worker and lease. This prevents a power request while
Flash may still be executing. An unsafe close leaves the board quarantined
and returns `PowerCycleSessionCloseFailed`; inspect the old session and lease
before a supervised manual cycle.

## Results and resumption

| Result | Meaning | Next step |
| --- | --- | --- |
| `status="completed"`, `success=true` | BLE MCP returned `completed`, `protocol_verified=true`, the matching device/reason, and an OFF hold at least as long as requested | Create a **new** debug session, reconnect, and verify both resident images before Flash boot or IPC conclusions. |
| `status="manual_required"`, `success=false` | Manual mode, unavailable BLE MCP, or an automatic attempt that did not prove both protocol replies | Board stays `QUARANTINED`. Remove power for the requested interval, restore it, then call `c2000_confirmManualPowerCycle` with `requestId`, `powerRemovedAndRestored=true`, and `observedOffSeconds`. |
| `PowerCycleFlashIncomplete` / `PowerCycleFlashUnverified` | The current session did not prove both writes and marker checks | Keep the existing session; inspect Flash evidence. No plug action was requested. |
| `PowerCycleBusy` / `PowerCycleSessionUnsafe` | An active job/command, other session, or stale lease blocks safe cleanup | Resolve the owning C2000 work through normal daemon tools, then retry. |

The confirmation call records an **operator attestation** and clears only this
power-cycle quarantine after checking the request ID, minimum reported OFF
interval, and absence of open sessions, active jobs, and leases. An interrupted
daemon operation left as `PowerCycleInProgress` can use the same supervised
manual confirmation after its old session and lease are confirmed closed.

Every result reports `physicalState: null` and `coldStartVerified: false`.
`protocolVerified: true` proves matching MIoT replies for OFF and ON, not an
independent voltage measurement or successful Flash boot. The previous
`sessionId` is closed, and target-image identity remains `UNKNOWN`. A fresh
session must establish both core identities through manifest-backed resident
verification or a new controlled MCP program load. Resident IPC workflows
cannot use operator-only identity confirmation after a power cycle. Symbols-only
IPC acceptance is blocked until both identities are re-established.

## Resume after the five-second cycle

1. Use a **new** session with `c2000_launchResidentIpcDebug`,
   `mode="attach-only"`, `residentIdentityPolicy="require-known"`, and both
   image manifests. This verifies resident images and reads cold-start state
   without halting, resetting, or running either core.
2. If the firmware's debugger startup contract calls for CPU2 first, use
   `c2000_runResidentIpcDebug` on that session with
   `mode="restart-and-diagnose"` and `runMode="cpu2_pre_running"`.
   The workflow halts and resets both cores, runs CPU2, confirms CPU2 remains
   `Running`, and only then releases CPU1. If CPU2 stops, CPU1 stays halted
   and the failure reports `cpu1RunSkipped=true`.

The second step is controlled-debugger evidence. Keep it separate from the
attach-only cold-start observation. `loadSequence.mode` controls Flash
programming order; `runMode` controls debug startup order.
