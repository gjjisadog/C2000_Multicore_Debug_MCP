---
name: c2000-multicore-debug
description: Safely run F28P65x CPU1/CPU2 and multi-board CAN workflows through the daemon, with global board permits and lease fencing.
---

# C2000 Multicore Debug

Use server-side workflows. Preserve explicit `sessionId` and `coreId`; never
depend on CCS focus or use TI MCP active-target controls. F28P65x uses
`coreId = 0` for `C28xx_CPU1` and `coreId = 2` for `C28xx_CPU2`.
Use those exact CCS names for `corePattern`; do not send regular expressions.

Before any board-bound work:

1. Read daemon health and verify `boardConcurrency.limit` can fit the requested
   physical boards.
2. List boards. If the list is empty or health reports
   `boards.registrationRequired`, stop and call `c2000_registerBoard` with a
   serial-bound `.ccxml`; do not try alternate launch tools or direct DSS.
3. Require distinct `boardId` and `probeSerial`; do not select leased or
   quarantined boards.
4. Keep `.ccxml`, `.out`, and `.map` under `allowedReadRoots`, and evidence
   `outputDir` under `allowedWriteRoots`.
5. Submit one durable job and retain its `jobId`.

Do not manually restart or re-port the daemon to repair a stale MCP proxy.
The proxy rediscovers a restarted daemon after connection/authentication
failure. A request timeout is not automatically retried because the target
operation may already have started.

For a CPU2 RAM image whose GS ownership or release is initialized by CPU1, set
`loadSequence.mode` to `cpu1-run-before-cpu2` and choose an explicit
`cpu1SettleMs`. Leave the default sequence unchanged for ordinary or Flash
loads.

When the program is already resident in Flash and only debug symbols are
needed, use `c2000_loadSymbols`. Never substitute `c2000_loadProgram`, because
that can erase or reprogram target Flash.

Treat `verify-mcp-registry` as same-session load-record verification only; it
never verifies resident Flash. `verify-only` is a deprecated alias. After
fresh Flash programming, use `c2000_runReloadAndDiagnose.postLoadBoot` for an
explicit post-load reset and CPU1-first start. This sequence does not write PC;
if firmware needs a nonstandard entry address, stop and require a target-
specific, explicitly approved procedure.

Two-board CAN requires an atomic pair permit. Treat
`InsufficientBoardConcurrency` as a configuration error, not a barrier timeout.

Every board-bound command must carry a current lease context containing
`leaseId`, secret `leaseToken`, monotonically increasing `fencingToken` and
`leaseGeneration`, owner, board/probe, and worker identity. Never retry
`LeaseExpired`, `LeaseInvalidated`, or `LeaseFencingRejected` with the old
context. After repeated renewal failure, stop target commands and recover from
persisted metadata only; never claim the old DSS session was restored.

PCAN rules:

- Mock is simulation evidence only.
- `pcan-basic` is Windows x64 hardware evidence and must fail closed.
- Never redistribute PCANBasic.dll or silently fall back to Mock.
- `verify:pcan:hardware` is opt-in and proves preflight only.
- Claim two-board acceptance only after an explicit hardware acceptance run.

Recovery is ownership-safe: default to dry-run and terminate only daemon-owned
processes whose PID, start time, daemon/worker identity, board, and probe all
match. Never kill external CCS, DSLite, DebugServer, or an ambiguous/PID-reused
process.
