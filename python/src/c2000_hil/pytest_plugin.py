import os

import pytest

from .board import C2000Board
from .client import DaemonClient


def pytest_addoption(parser):
    group = parser.getgroup("c2000-hil")
    group.addoption("--c2000-board-id", action="store", default=None)
    group.addoption("--c2000-runtime-dir", action="store", default=None)


def pytest_configure(config):
    config.addinivalue_line("markers", "c2000_hardware: requires explicit C2000_HARDWARE_TEST=1")
    config.addinivalue_line("markers", "c2000_pcan: requires a registered PCAN-capable board")
    config.addinivalue_line("markers", "c2000_two_boards: requires at least two matching boards")


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_makereport(item, call):
    outcome = yield
    report = outcome.get_result()
    setattr(item, f"rep_{report.when}", report)


@pytest.fixture
def c2000_board(request):
    mode = os.environ.get("C2000_HIL_MODE", "").lower()
    hardware = os.environ.get("C2000_HARDWARE_TEST") == "1"
    if not hardware and mode != "mock":
        pytest.skip("C2000 HIL is opt-in: set C2000_HIL_MODE=mock or C2000_HARDWARE_TEST=1")
    client = DaemonClient(request.config.getoption("--c2000-runtime-dir"))
    health = client.health()
    boards_result = client.invoke("c2000_listBoards", {})
    boards = boards_result.get("boards", [])
    matching = [board for board in boards if _board_is_eligible(board, mode)]
    if not matching:
        pytest.skip("No matching registered C2000 board")
    if hardware:
        try:
            server_health = client.invoke("c2000_getServerHealth", {})
            preflight = client.invoke("c2000_getHardwarePreflight", {})
        except Exception as error:
            pytest.skip(f"CCS/XDS110 hardware preflight unavailable: {error}")
        _hardware_gates(request, server_health, preflight, matching)
    requested_id = request.config.getoption("--c2000-board-id") or os.environ.get("C2000_BOARD_ID")
    selected = next((board for board in matching if board.get("boardId") == requested_id), matching[0])
    board = C2000Board(client, str(selected["boardId"])).acquire()
    try:
        yield board
    finally:
        report = getattr(request.node, "rep_call", None)
        if report is not None and report.failed:
            attachment = board.failure_attachment()
            request.node.user_properties.append(("c2000_failure", attachment.__dict__))
        board.release()


def _board_is_eligible(board, mode):
    if not isinstance(board, dict):
        return False
    tags = {str(tag).lower() for tag in board.get("tags", [])}
    return mode != "mock" or "mock" in tags


def _hardware_gates(request, health, preflight, boards):
    adapter = (((health or {}).get("configuration") or {}).get("adapterMode"))
    if adapter not in ("ccs", "auto"):
        pytest.skip("CCS adapter is not configured")
    xdsdfu = preflight.get("xdsdfu", {}) if isinstance(preflight, dict) else {}
    if not xdsdfu.get("probeReady"):
        pytest.skip("No XDS110 probe was enumerated")
    if request.node.get_closest_marker("c2000_pcan"):
        if not any("pcan" in {str(tag).lower() for tag in board.get("tags", [])} for board in boards):
            pytest.skip("PCAN is not configured")
    if request.node.get_closest_marker("c2000_two_boards") and len(boards) < 2:
        pytest.skip("Two matching boards are required")
