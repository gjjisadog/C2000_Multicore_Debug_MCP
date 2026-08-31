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
3. For code/project changes, prefer `c2000_runEngineeringVerification` so the
   server evaluates Build → Map → Regression → Review and persists evidence.
   Atomic `c2000_verifyBuild`, `c2000_verifyMap`, `c2000_verifyRegression`,
   and `c2000_verifyReview` are for focused checks.
4. Read `c2000_getVerificationResult` or the job artifact manifest before
   concluding. A Build PASS is not task completion.

The default MCP connection uses `safe` + `agent`. Prefer the agent surface in
this order: Workflow → Diagnostic → read-only atomics. Switch explicitly to
the `advanced` surface only for manual core control, single-step reset/load,
DLOG lifecycle, ERAD profiling, Variable Stream lifecycle, or other low-level
debugging. Use `compatibility` only for legacy scripts, migration, or
acceptance compatibility. If an atomic tool is not visible on the current
surface, do not bypass MCP or call TI active-target controls; choose the
appropriate workflow or explicitly change the configured surface.

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
- CPU2 boot/illegal PC: `c2000_runBootHandoffDiagnosis`.
- Reload/reset/run/diagnose: `c2000_runReloadAndDiagnose`.
- Evidence package: `c2000_runFullDebugBundle`.
- RAMGS ownership: diagnose first, then `c2000_analyzeRamOwnership`.
- Resident Flash symbols: `c2000_loadSymbols`, not `c2000_loadProgram`.
- Multi-board CAN: use the durable two-board workflow; `mock` remains
  simulation-only and hardware mode is explicit.

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
