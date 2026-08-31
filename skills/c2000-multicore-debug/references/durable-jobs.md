# Durable jobs and leases

`c2000_submitTestPlan` queues work and returns a stable `jobId`; the daemon
owns scheduling, SQLite state, worker routing, board permits, and recovery.
Use `c2000_getTestRun` for terminal status and retain events/artifacts.

Every target-bound command must carry the current lease context: lease id and
secret, fencing token/generation, owner, board/probe, and worker identity. The
live supervisor route must match the lease before each target step. A
`LeaseExpired`, `LeaseInvalidated`, `LeaseFencingRejected`,
`LeaseWorkerMismatch`, or `WorkerIdentityMismatch` result is fail-closed; do
not replay the old context.

Non-idempotent expression writes, fault injection, run/reset/reconnect, and
destructive reload steps require explicit plans and are not blindly retried.
Use `on: always` cleanup where the job contract supports it. Keep retry and
recovery decisions in the daemon rather than composing client-side calls.

For two boards, require distinct registered board/probe identities and enough
`maxParallelBoards` capacity. CAN pair permits are atomic. A hardware
regression must use this same durable boundary; the verification layer does
not create another target job system.
