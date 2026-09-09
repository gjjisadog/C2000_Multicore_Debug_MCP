---
name: c2000-ipc-debug
description: Diagnose TI C2000 F28P65x CPU1/CPU2 IPC-ready failures and acceptance-test false negatives, separating target boot faults from debugger, session, artifact, and test-method issues while keeping RAM and Flash startup semantics separate.
---

# C2000 IPC Debug

Use this focused skill for F28P65x CPU1/CPU2 IPC-ready failures, CPU2 boot
handoff, RAMGS ownership, parameter synchronization, and Flash cold-start
validation. It adds IPC-specific test-method discipline to the general
`c2000-multicore-debug` rules. Do not use it for unrelated single-core debug.

## The invariant that defines a valid attempt

An IPC acceptance attempt is one server-owned workflow or durable job with:

- explicit `sessionId`, `boardId`/worker context when applicable, `cpu1CoreId`,
  and `cpu2CoreId`;
- one immutable CPU1/CPU2 image pair and matching `.map` files;
- one declared reset, `loadSequence`, and `runSequence.runMode`; and
- bounded readiness polling plus preserved first-failure evidence; and
- a current board target identity marked `KNOWN`, with per-core SHA-256 values
  matching the pair used by the workflow. A new lease or worker restart makes
  this identity `UNKNOWN` until the pair is loaded again under that lease.

For F28P65x, use `coreId: 0` / `C28xx_CPU1` and `coreId: 2` /
`C28xx_CPU2`. A `corePattern` is an exact CCS selector, not a regular
expression. Never call a run, load, reconnect, or expression operation against
an implicit CCS-focused core.

Do not turn a sequence of manual calls into an IPC verdict. In particular,
`launchMulticoreDebug` followed by generic `runCores` does not implement the
CPU1/CPU2 handoff contract. Prefer one of the IPC workflows so ordering,
artifact preflight, readiness evidence, and diagnosis are recorded together.

## Standard routing

1. Before target access, inspect `c2000_getEnvironment`,
   `c2000_getServerHealth`, `c2000_getDaemonHealth`, and `c2000_listBoards` as
   applicable. A missing or unready board/worker is an infrastructure result,
   not an IPC result. Treat an `UNKNOWN` target identity as a blocked attempt;
   do not reuse a previous Scope/session. Load the exact pair through the
   current lease first.
2. Validate the image pair and maps in the configured read roots. Confirm
   device/build compatibility, freshness or declared hashes, and that every
   requested IPC symbol exists in the real map/symbol table. A missing symbol,
   stale `.out`/`.map`, or invalid artifact pair must fail before target
   mutation.
3. With no connected session, use `c2000_launchAndRunIpcAcceptance`. With an
   existing connected session, use `c2000_runIpcAcceptance`. Supply `0` and `2`
   explicitly and set the startup mode explicitly; do not rely on legacy
   boolean flags to imply who starts CPU2.
4. If CPU2 does not enter its application or the handoff times out, preserve
   the workflow result first, then use the read-only
   `c2000_runBootHandoffDiagnosis`. Use `c2000_runFullDebugBundle` when the
   failure needs a complete evidence package. Do not blindly rerun before
   capturing the first failure.
5. Use `c2000_submitTestPlan` for long-running or multi-board acceptance and
   retain its `jobId`; inspect `c2000_getTestRun` and
   `c2000_getTestArtifacts` rather than composing client-side retries.

If an operation returns a lease, worker, session, or target-access mismatch,
fail closed. Do not reuse an expired/fenced session or alternate between manual
CCS actions and the workflow. Do not bypass hidden MCP tools with CCS GUI, TI
active-target commands, shell, or private daemon RPC.

## Keep loading semantics separate from run authority

`loadSequence` answers “how are images loaded and RAM ownership prepared?”;
`runSequence` answers “who starts CPU2?” They are independent contracts and
must not be substituted for one another.

### RAM/debugger-owned startup

- If CPU1 must establish GS ownership before a CPU2 RAM image can be loaded,
  use `loadSequence.mode: "cpu1-run-before-cpu2"` with the declared bounded
  settle time. The workflow performs that sequence; do not reproduce it with
  separate client calls.
- After both images are loaded, use `runSequence.runMode:
  "debugger_runs_both"` when the debugger is the declared start authority.
  Keep CPU1 first when the product contract requires it.
- Use `c2000_analyzeRamOwnership` as host-side map evidence when needed. It
  does not itself connect, load, run, reset, or prove target state.
- The repository's `hybrid30k-dk9-owner-first` preset is valid only when the
  image pair and firmware contract are the matching Hybrid30K/DK9 case. Do not
  apply that name to an unrelated firmware family.

### Flash/firmware-owned startup

- When CPU1 owns the CPU2 handoff, use
  `runSequence.runMode: "cpu1_boots_cpu2"` only when the CPU2 image is already
  resident and the product firmware is supposed to release it. The server
  disconnects CPU2 during the CPU1 handoff and reconnects it before readiness
  polling/diagnosis.
- Never start CPU1 so that it releases CPU2 and then load the CPU2 image. That
  creates a release/alive timeout by construction for a Flash-owned handoff.
- For a freshly programmed Flash image, program the complete pair before the
  product boot. Then use the product-defined XRS/power reset and stop debugger
  control during the boot window; reconnect only for read-only evidence. A
  controlled MCP post-load boot is debugger-controlled evidence, not proof of a
  physical cold start.
- For an image already resident in Flash, use `c2000_loadSymbols` for matching
  `.out` symbols. Do not repeatedly call program-load as a symbol-only action,
  but only after the target-identity guard confirms that the current resident
  image matches the requested `.out`. `symbols-only` does not independently
  prove Flash contents. If identity is unknown or mismatched, stop and perform
  a controlled exact-pair load or a separately valid resident-image check. Do
  not repeat CPU2 Flash programming without the explicit destructive reload
  authorization required by the server.

### CPU2-pre-running mode

Use `runSequence.runMode: "cpu2_pre_running"` only when the firmware contract
explicitly requires CPU2 to be running before CPU1. It is not a generic
recovery tactic and must not be combined with the CPU1 owner-first RAM load
sequence. A CPU2-first manual experiment is not evidence for a CPU1-owned
product handoff.

## What counts as ready

Readiness is firmware-specific. Use explicit conditions from the actual image
and map, not a guessed field name. For the Hybrid30K watch contract described
by this project, the normal gate is:

- CPU1 and CPU2 stages are running;
- CPU1 reports CPU2 ready;
- CPU1's CPU2-boot error is clear; and
- CPU2 has applied the initial parameter snapshot.

The commonly used watch symbols are:

- CPU1: `g_stCoreCommCpu1Watch.emStage`,
  `g_stCoreCommCpu1Watch.uiCpu2Ready`,
  `g_stCoreCommCpu1Watch.ulCpu2BootLastError`;
- CPU2: `g_stCoreCommCpu2Watch.emStage`,
  `g_stCoreCommCpu2Watch.uiInitParamApplied`.

In the Hybrid30K incident that motivated this skill, raw stage `5` meant
`RUNNING` and raw stage `6` meant `ERROR`; verify the enum in the active
firmware before interpreting numeric stages. Likewise, the error mappings
`0x31010503` (CPU1 CPU2-release timeout) and `0x31010604` (CPU1 waiting for
CPU2-alive timeout) are contract-specific evidence, not universal C2000 codes.

Never add a watch expression merely because it sounds plausible. For example,
`g_stCpu2RtosWatch.uiCommTaskAlive` was absent from the firmware in the source
incident; its failure was an expression/test-script problem, not IPC evidence.

Do not conclude from the top-level tool-call `success` alone. Inspect at least
`ipcReady.matched`, `diagnosisCode`, `runPlan`, `startupContract`,
`artifactPreflight`, the per-core snapshot/PC evidence, and the completeness of
the returned bundle.

## Failure classification

Classify each attempt by the first failing boundary. Do not count every result
that says “not ready” as the same IPC failure.

| Observation | Classification | Correct next action |
| --- | --- | --- |
| Daemon/worker/board/lease unavailable, or no valid target access | Infrastructure / not attempted | Repair readiness or lease state; do not report IPC failure. |
| CPU2 program-load failure/timeout, pair mismatch, stale artifact, missing map symbol, or unknown expression | Artifact / harness | Fix the image, map, or test request; rerun as a fresh declared attempt. |
| CPU2 is in Boot ROM/halted/disconnected, PC read fails, or the session was manually reconnected during startup | Session / sequencing | Capture read-only diagnosis and correct the start contract; this is not yet firmware IPC evidence. |
| `emStage=ERROR` and a valid boot/release timeout is observed after a clean contract-compliant run | Target-side startup evidence | Preserve error code, PCs, stages, retry count, and handoff evidence; then investigate firmware, ownership, or target timing. |
| Ready conditions match on both cores with complete artifact and timing evidence | Acceptance pass | Record the exact image, mode, core identities, and durable evidence. |

A target-side timeout still does not automatically prove a firmware defect. If
CPU2 was held in Boot ROM, not resident, loaded after CPU1 released it, or the
run order contradicted the product contract, classify the root cause as a test
method/sequence failure and repeat with a clean contract.

## Anti-patterns learned from the incident

- Do not mix `COMM_VALIDATION_RAM`, `SAFE_VALIDATION_RAM`, formal Flash, or
  other image families in one acceptance claim.
- Do not mix `cpu1_boots_cpu2`, `debugger_runs_both`, and CPU2-pre-running
  experiments across retries and call the aggregate “IPC repeatedly failed.”
- Do not treat a load failure, expression-not-found error, PC read failure, or
  stale symbol table as an IPC-ready failure.
- Do not keep an old session alive while alternating CPU1 reload, CPU2 Resume,
  reconnect, and expression reads. That is one contaminated debug sequence,
  not independent startup attempts.
- Do not let two sessions share one DK9/XDS probe, and do not recover a board
  while another lease is active. A session close, worker restart, or external
  debugger access ends the current attempt; start a fresh lease/session and
  re-establish the image identity before observing again.
- Do not poll at a rate that perturbs CCS target timing. Prefer the workflow's
  bounded polling and retain its first-failure read set.

## Completion record

For every conclusion, retain:

- `sessionId`, board/probe/worker and lease identity when applicable;
- CPU1/CPU2 core IDs and names;
- `.out`/`.map` paths plus freshness/hash identity;
- target identity generation plus the per-core resident `.out` hashes;
- reset type, load mode, run mode, settle/poll settings;
- requested ready expressions and map-preflight result;
- first failing workflow stage, per-core state/PC, stage/error/retry fields;
- `ipcReady`, diagnosis, artifact/bundle completeness, and `jobId` if durable;
- evidence classification: real hardware, Mock, host-only, blocked,
  unsupported, or not-run.

Only call the run an IPC acceptance pass when the explicit ready conditions,
startup contract, artifact checks, and required evidence all agree. A later
successful rerun does not erase an earlier failure; it shows that the attempts
must be classified separately.
