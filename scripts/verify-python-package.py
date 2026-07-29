"""Offline-safe packaging smoke for the pure-Python HIL SDK."""

import ast
import pathlib
import sys
import tomllib

ROOT = pathlib.Path(__file__).resolve().parents[1]
PYTHON_ROOT = ROOT / "python"
SOURCE_ROOT = PYTHON_ROOT / "src"

metadata = tomllib.loads((PYTHON_ROOT / "pyproject.toml").read_text(encoding="utf-8"))
assert metadata["project"]["version"] == "0.7.0"
assert metadata["project"]["name"] == "c2000-hil"
for source_path in SOURCE_ROOT.rglob("*.py"):
    compile(source_path.read_text(encoding="utf-8"), str(source_path), "exec")

sys.dont_write_bytecode = True
sys.path.insert(0, str(SOURCE_ROOT))
import c2000_hil  # noqa: E402

assert c2000_hil.__version__ == metadata["project"]["version"]
board_source = (SOURCE_ROOT / "c2000_hil" / "board.py").read_text(encoding="utf-8")
client_source = (SOURCE_ROOT / "c2000_hil" / "client.py").read_text(encoding="utf-8")
for forbidden in ("sqlite3", "debugserver", "xds110"):
    assert forbidden not in (board_source + client_source).lower()
ast.parse(board_source)
ast.parse(client_source)
print("Python SDK packaging smoke passed (pure Python, daemon RPC only).")
