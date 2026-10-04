# c2000-hil

Thin Python/pytest client for the public `c2000-debugd` RPC. It does not load
CCS libraries, open XDS110, inspect SQLite, or implement board leases.

Normal `pytest` runs do not contact hardware. Set `C2000_HIL_MODE=mock` for a
configured mock daemon, or explicitly opt into hardware with
`C2000_HARDWARE_TEST=1`.

Select a board with `--c2000-board-id` or `C2000_BOARD_ID` (the command-line
option takes precedence). An explicit ID must match a registered board eligible
for the selected mode; otherwise fixture setup fails without acquiring another
board. With no explicit ID, the fixture selects the first eligible board and
skips if none are available.

For SDK development, install `python -m pip install "./python[pytest]"` from
the repository root, then run `python -m pytest python/tests -o pythonpath= -q`
to test the installed package. CI runs these fake-daemon tests without hardware
opt-in. `python scripts/verify-python-package.py` checks package metadata and
source integrity and requires Python 3.11 or newer.
