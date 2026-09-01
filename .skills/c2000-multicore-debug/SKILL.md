---
name: c2000-multicore-debug
description: Safely debug TI C2000 F28P65x CPU1/CPU2 and multi-board workflows through the daemon, with explicit core identity, durable jobs, lease fencing, hardware evidence, and deterministic engineering verification.
---

# C2000 Multicore Debug

Use this skill for F28P65x CPU1/CPU2 debug, IPC acceptance, CPU2 boot handoff,
RAMGS ownership, stale program/map diagnosis, CAN evidence, and engineering
verification through `c2000-multicore-mcp`.

## Core principles

- Use server-side workflow tools and preserve explicit `sessionId`, `boardId`,
  and `coreId`; never depend on CCS focus or TI active-target controls.
- F28P65x uses `coreId: 0` / `C28xx_CPU1` and `coreId: 2` / `C28xx_CPU2`.
  `corePattern` is an exact CCS selector, not a regular expression.
- Keep `.ccxml`, `.out`, and `.map` inputs inside `allowedReadRoots`; keep
  evidence and build output inside `allowedWriteRoots`.
- Mock is simulation evidence only. It never proves XDS110, PCAN, firmware,
  target timing, or physical wiring.
- Preserve daemon ownership, worker identity, board permits, lease/fencing
  context, safety guards, and durable `jobId` semantics. Never add a second
  target job engine or a general shell tool.

## Workflow priority

1. Inspect environment, server/daemon health, board registration, filesystem
   roots, and the applicable tool contract.
2. For target work, use one server-side workflow or one durable job. Register a
   serial-bound board and wait for its worker before touching a target.
3. Route normal tasks through the default `safe` + `agent` surface:
   - CPU1/CPU2 IPC startup and acceptance → `c2000_launchAndRunIpcAcceptance`.
   - IPC acceptance with an existing session → `c2000_runIpcAcceptance`.
   - CPU2 not starting or boot handoff diagnosis →
     `c2000_runBootHandoffDiagnosis`.
   - Reload firmware and diagnose → `c2000_runReloadAndDiagnose`.
   - Collect complete failure evidence → `c2000_runFullDebugBundle`.
   - Long-running HIL/test execution → `c2000_submitTestPlan`.
4. For engineering verification, explicitly select `advanced` and use
   `c2000_runEngineeringVerification`; read
   `c2000_getVerificationResult` or the job artifact manifest before
   concluding. A Build PASS is not task completion.

The default MCP connection uses `safe` + `agent`. It intentionally exposes a
small task-level API rather than every safe atomic. Raw `runCore`, `loadProgram`,
`loadSymbols`, generic waits, DLOG, ERAD, and Variable Stream lifecycle tools
are advanced-only; their backend capability remains available to workflows.
When a task genuinely needs one of these groups, call
`c2000_listCapabilities`, then open only the required short-lived capability
with a specific reason. Use `c2000_closeCapabilitySession` when finished; the
15-minute default TTL and 30-minute maximum also expire sessions automatically.
Use `advanced` when a complete canonical engineering toolbox is needed, and
`compatibility` only for legacy scripts, migration, or acceptance compatibility.
If a tool is not visible on the current surface, do not bypass MCP or call TI
active-target controls; choose the appropriate workflow or capability instead.

## Safety hard rules

- Do not use TI official `continue`, `pause`, `reset`, `connectTarget`,
  `disconnectTarget`, or active-target tools for dual-core automation.
- Do not retry an expired, invalidated, worker-mismatched, or fenced lease;
  stop and inspect durable evidence.
- Do not automatically kill external CCS/DebugServer processes. Recovery is
  limited to daemon-owned identities and remains dry-run by default.
- Do not repeat CPU2 Flash programming without explicit destructive reload
  authorization; use symbol loading for resident Flash.
- Do not assign PWM, contactor, power-stage, or HV control variables as part of
  generic verification. Target writes and fault injection remain in existing
  safe/full and durable-job boundaries.
- A parser failure, missing required evidence, stale `.out`/`.map`, unsupported
  required verifier, or incomplete artifact must not be reported as PASS.

## Intent routing

- IPC/acceptance: `c2000_launchAndRunIpcAcceptance` or
  `c2000_runIpcAcceptance` when a session already exists.
- CPU2 boot/illegal PC: `c2000_runBootHandoffDiagnosis`; its structured result
  includes the handoff and RAM ownership evidence.
- Reload/reset/run/diagnose: `c2000_runReloadAndDiagnose`.
- Evidence package: `c2000_runFullDebugBundle`.
- Resident Flash symbols: use the workflow's resident-image path by default;
  on `advanced`, use `c2000_loadSymbols`, never `c2000_loadProgram` as a
  symbol-only substitute.
- Multi-board CAN: use `c2000_submitMultiBoardCanAcceptance`; specialized
  fault/soak campaigns are advanced. `mock` remains simulation-only and
  hardware mode is explicit.

## On-demand capabilities

Route specialized work through a capability session instead of switching to
`full` compatibility:

- Manual per-core connect/run/halt/reset → `debug.manual`.
- Manual program or resident-image symbol loading → `debug.program`.
- Generic expression waits → `debug.wait`.
- Bounded variable monitoring → `observability.variables`.
- Existing target-side DLOG capture → `observability.dlog`.
- ERAD profiling → `observability.erad`.
- Baseline/closure/metrics evidence → `observability.metrics`.
- Specialized CAN profiles, fault campaigns, and soak jobs → `can.advanced`.

For example, ISR cycle analysis is:
`c2000_getServerHealth` → `c2000_listCapabilities` → open
`observability.erad` with a reason → inspect/configure/start/read/stop/export
the ERAD profile → close the capability session. The capability only changes
MCP tool visibility; the configured Safety Profile and every tool's effects,
approval class, lease fencing, and core identity checks remain in force.

Do not use shell, CCS GUI, TI active-target commands, or internal daemon RPCs
when an atomic is hidden. If the default workflow is insufficient, request the
smallest matching capability explicitly; never open a broad capability merely
because a workflow is available.

## Completion contract

For engineering changes, follow:

`Inspect → Modify → Build → Map → Regression → Review → runtime verification when required → Conclude`

Record the `jobId`/`verificationId`, status, evidence classification,
completeness, hard-gate failures, and paths to durable artifacts. Distinguish
real hardware, Mock, host-only, blocked, unsupported, and not-run results.

Do not declare completion solely because compilation succeeds. Respect the
configured map hard gates and review requirements; thresholds belong in
verification configuration, not in this Skill.

## References

- [Debugging workflows](references/debugging.md)
- [Durable jobs and leases](references/durable-jobs.md)
- [Hardware safety and evidence](references/hardware-safety.md)
- [Engineering verification](references/verification.md)
- [Artifacts and metrics](references/artifacts.md)
- [Skill evolution boundary](references/evolution.md)
