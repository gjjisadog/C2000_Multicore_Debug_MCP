# Optional board power cycle

The C2000 daemon can call the installed `ble-lab-power` stdio MCP server's
`powercycle` tool for the registered `lab_power` USB plug. This is an explicit
step. Existing Flash and IPC tools do not cycle power by default. The C2000
daemon starts its own MCP client for the call; it cannot reuse the Codex
client's stdio connection. It never exposes a general command or shell tool.

## Configuration

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

Use `c2000_launchAndRunIpcAcceptance` with
`startupPreset="f28p65x-paired-flash"`, `programPreparation="load"`,
`stopAfterFlashPreparation=true`, `sessionMode="interactive"`, and
`autoCloseOnComplete=false`. This stops after both application images are
written while the cores remain halted. The result has
`status="flash_prepared"` and `ipcAcceptance="NOT_RUN"`. A failed or skipped
load cannot reach this result. An existing interactive session can use the
same stop option in `c2000_runIpcAcceptance`.

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
