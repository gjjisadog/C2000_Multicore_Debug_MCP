# Bounded CPU2 loader failure evidence

## Scope and identity

User-authorized MCP diagnostic correction. Baseline:
`7cd31f0ae7843fdc22b04d483a580b3d36921cab`; candidate branch:
`codex/loader-failure-evidence-20260910`, isolated worktree
`C:/c2000-loader-evidence-20260910`.

Motivation: real DK9 job `run-2cef48dc-b1e3-481e-9f54-e755405a6d4e`
failed on CPU2 program load after CPU1 succeeded. The public failure retained
only DSS `Load failed`; historical collection was INCOMPLETE after cleanup.
The earlier same-image job `run-e596f160-1fa3-43ac-ab9a-808b14e96286` loaded
successfully but had an initial boot failure and non-progressing Comm/Fault/EMS
counters. Neither observation establishes a Flash or RTOS root cause.

Historical commit `76dcf60` contains an earlier version of the diagnostic fix,
but is **not an ancestor** of the installed/current baseline `7cd31f0`.
This change reuses that bounded collection design, adds truncation indicators
and socket diagnostic-callback isolation, and broadens regression coverage.
It preserves the current baseline's reset/startup and identity-fencing changes.

## Changes

- `src/adapters/PersistentDssBridge.ts`: on a received DSS FAIL, snapshot only
  stdout/stderr tails before process disposal; retain at most 12000 characters
  per tail, with a `*Truncated=true` marker when the snapshot is trimmed.
  Include requested core ID/name and adapter session ID. Redact the session
  authentication token from the response strings and captured output. Do not
  export the handle, arbitrary diagnostic fields or environment.
- Generated DSS catch: include up to four Java causes, 2048 message characters
  per cause, eight stack frames per cause and 256 characters per frame. Plain
  exceptions, unavailable stack/cause accessors and cycles are handled without
  target commands. The top-level FAIL message is also limited to 2048 characters.
- A throwing diagnostics callback is recorded as `captureFailed=true` and
  cannot replace the command failure or throw from socket close/error handling.
- `src/debug/DebugSessionManager.ts`: log the structured load error, including
  nested cause/details, instead of Logger's generic Error summary.

The normal error object is JSON-serializable and self-contained before cleanup.
Existing batch/workflow/durable error propagation carries it; the existing
historical failure collector exports it to `failure-bundle/failure.json` even
when no live session remains. No new collector, job engine or target access
path was added. Missing target evidence still yields INCOMPLETE.

For a nested `ProgramLoadFailed`, inspect
`details.cause.details.diagnostics` (tails), and
`details.cause.details.response.details.causes` (Java cause/stack records).
Batch/workflow wrappers contain that error deeper under their failed item.
The daemon's `program load failed` log now retains the same structured payload.

## Verification (Node 22.23.2, Windows)

| Gate | Result |
|---|---|
| Baseline affected suite (five files) | 126 PASS |
| New regressions before production edit | Four failures reproduced missing cause/tail evidence and missing diagnostics handling; throwing callback also exposed an uncaught close-path error. |
| Candidate affected suite | 133 PASS, seven added tests |
| Full Host, final test revision | 763 PASS, zero failed/pending |
| `npm run typecheck` (runtime sources) | PASS |
| `npm run build` | PASS |
| `npm run verify:debug-boundary` | PASS, no offenders |
| Expanded `tsc -p tsconfig.json --noEmit` | FAIL: baseline and candidate both have the same 63 existing errors, compared ignoring shifted line numbers; no new errors. |
| `git diff --check` | PASS |
| Installed-runtime / real Flash verification of this candidate | NOT RUN |

Affected command:

```powershell
npm test -- --reporter=dot tests/PersistentDssBridge.test.ts tests/dssScriptSource.test.ts tests/dssResetBehavior.test.ts tests/DebugSessionManager.test.ts tests/traceFailureBundle.test.ts
```

Final full Host artifact (local ignored):
`artifacts/loader-failure-evidence-20260910/full-host-final.json`.
Extended typecheck baseline/candidate and normalized comparison are saved under
the same local artifact directory as `typecheck-comparison.json`.

Regressions cover actual generated exception-helper behavior; tail limits and
truncation marker; authentication-token redaction in both tails and nested
causes; evidence surviving disposal; one load call without retry; missing and
throwing diagnostic callbacks; unchanged successful-command collection behavior;
structured load log persistence after closure; and historical JSON export
without live-target access or a false COMPLETE classification.

## Safety review and remaining limits

No edits to firmware, Scope ABI, protocol, reset/load/run ordering, memory
ownership writes, reload/retry policies, leases/fencing, tool schemas or public
startup contract version (still 5). No firmware reflash, daemon restart,
installation, remote push or master merge was performed for this correction.

Evidence is a bounded snapshot, not an unlimited log or a new target capture.
The launcher buffer may already have discarded older output, and asynchronous
output arriving after the FAIL snapshot is not guaranteed to be present. Java
causes may be absent if CCS does not provide them. Do not infer a specific
Flash fault from a generic error if the new fields still lack its details.

Host evidence shows improved diagnostic retention with unchanged target
actions. Physical loader stability, C0, RTOS liveness and integrated Scope
acceptance remain OPEN/NOT VERIFIED; this patch is not a firmware/Flash fix.
After the owner installs this exact candidate, first confirm matching frontend
and daemon source identity, then use a fresh exclusive lease and the declared
image pair for a bounded startup attempt. Inspect persisted failure data before
any further programming; do not resume stale symbols or blindly reload.
