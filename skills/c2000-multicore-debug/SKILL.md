---
name: c2000-multicore-debug
description: Safely run F28P65x CPU1/CPU2 and multi-board CAN workflows through the daemon, with global board permits and lease fencing.
---

# C2000 Multicore Debug

Use server-side workflows. Preserve explicit `sessionId` and `coreId`; never
depend on CCS focus or use TI MCP active-target controls.

Before multi-board work:

1. Read daemon health and verify `boardConcurrency.limit` can fit the requested
   physical boards.
2. List boards and require distinct `boardId` and `probeSerial`.
3. Do not select leased or quarantined boards.
4. Submit one durable job and retain its `jobId`.

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
