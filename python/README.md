# c2000-hil

Thin Python/pytest client for the public `c2000-debugd` RPC. It does not load
CCS libraries, open XDS110, inspect SQLite, or implement board leases.

Normal `pytest` runs do not contact hardware. Set `C2000_HIL_MODE=mock` for a
configured mock daemon, or explicitly opt into hardware with
`C2000_HARDWARE_TEST=1`.
