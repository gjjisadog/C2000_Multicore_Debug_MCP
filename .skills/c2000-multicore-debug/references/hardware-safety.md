# Hardware safety and evidence

Hardware evidence is classified separately from host and Mock evidence.
`MOCK` proves simulation, orchestration, or persistence only; it cannot be
upgraded to `HARDWARE_TARGET`, `HARDWARE_BUS`, or a physical acceptance claim.
XDSDFU/preflight proves host/probe readiness, not a connected target session.

Board registration binds board id, probe serial, device, and `.ccxml`. Workers
are isolated and daemon-owned. Recovery defaults to dry-run and may affect
only an owned identity with matching PID/start time/daemon/worker/board/probe;
never kill ambiguous or external CCS, DSS, DebugServer, or DSLite processes.

Do not add target write permissions to verification tools. Build, map, review,
and host regression may write only configured host evidence. Fault injection,
program load, reset, run, RAM ownership changes, Flash programming, and CAN
hardware actions retain the existing tool profile, safety guard, permit, lease,
and durable job restrictions.

PCAN hardware is opt-in and requires the official local driver. A successful
CAN write means queued-to-adapter, not delivered. Full physical evidence needs
firmware TX, independent bus capture, and peer firmware RX/application facts.
