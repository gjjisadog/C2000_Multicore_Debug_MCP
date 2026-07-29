from types import SimpleNamespace

import pytest

from c2000_hil.board import C2000Board
from c2000_hil import pytest_plugin


class FakeClient:
    def __init__(self):
        self.calls = []
        self.timeout = 1.0

    def health(self):
        self.calls.append(("health", {}))
        return {"status": "ready"}

    def invoke(self, tool, arguments=None, timeout=None):
        arguments = arguments or {}
        self.calls.append((tool, arguments))
        if tool == "c2000_listBoards":
            return {"success": True, "boards": [{"boardId": "mock-a", "tags": ["mock"]}]}
        if tool == "c2000_createDebugSession":
            return {
                "success": True,
                "sessionId": "session-a",
                "adapterSessionId": "adapter-a",
                "workerGeneration": 7,
            }
        if tool == "c2000_waitUntilExpression":
            return {
                "success": True,
                "matched": arguments["expected"] == 1,
                "timedOut": arguments["expected"] != 1,
                "coreName": "CPU2",
                "lastResult": {"value": 1},
            }
        if tool == "c2000_submitTestPlan":
            return {"success": True, "jobId": "job-a"}
        if tool == "c2000_getTestRun":
            return {"success": True, "jobId": "job-a", "status": "FAILED"}
        if tool == "c2000_getTestArtifacts":
            return {"success": True, "artifactExport": {"rootPath": "artifacts/job-a"}}
        if tool == "c2000_collectFailureBundle":
            return {"success": True, "bundlePath": "artifacts/job-a/failure-bundle"}
        return {"success": True}


def test_board_acquires_daemon_owned_lease_and_releases():
    client = FakeClient()
    board = C2000Board(client, "mock-a").acquire()
    assert board.session_id == "session-a"
    create = client.calls[0]
    assert create[0] == "c2000_createDebugSession"
    assert create[1]["boardId"] == "mock-a"
    assert [core["coreId"] for core in create[1]["coreMap"]] == [0, 2]
    assert "leaseToken" not in create[1]
    board.release()
    assert client.calls[-1] == ("c2000_closeDebugSession", {"sessionId": "session-a"})
    board.release()
    assert [name for name, _ in client.calls].count("c2000_closeDebugSession") == 1


def test_wait_for_variable_timeout_contract_and_job_cancel():
    client = FakeClient()
    board = C2000Board(client, "mock-a").acquire()
    matched = board.wait_for_variable(2, "g_ready", 1, timeout=0.2)
    assert matched.matched and matched.core_id == 2 and matched.core_name == "CPU2"
    timed_out = board.wait_for_variable(2, "g_ready", 0, timeout=0.2)
    assert timed_out.timed_out and not timed_out.matched
    board.submit_test_plan({"planVersion": 1})
    board.cancel_job()
    assert client.calls[-1] == ("c2000_cancelTestRun", {"jobId": "job-a"})


def test_failure_attachment_keeps_job_and_paths():
    client = FakeClient()
    board = C2000Board(client, "mock-a").acquire()
    board.last_job_id = "job-a"
    attachment = board.failure_attachment()
    assert attachment.job_id == "job-a"
    assert attachment.result["status"] == "FAILED"
    assert attachment.artifact_path == "artifacts/job-a"
    assert attachment.failure_bundle_path.endswith("failure-bundle")


def test_fixture_without_opt_in_does_not_construct_client(monkeypatch):
    monkeypatch.delenv("C2000_HARDWARE_TEST", raising=False)
    monkeypatch.delenv("C2000_HIL_MODE", raising=False)
    monkeypatch.setattr(pytest_plugin, "DaemonClient", lambda *_: pytest.fail("daemon was touched"))
    request = _request()
    fixture = pytest_plugin.c2000_board.__wrapped__(request)
    with pytest.raises(pytest.skip.Exception, match="opt-in"):
        next(fixture)


def test_fixture_teardown_releases_and_failure_attaches(monkeypatch):
    monkeypatch.setenv("C2000_HIL_MODE", "mock")
    client = FakeClient()
    monkeypatch.setattr(pytest_plugin, "DaemonClient", lambda *_: client)
    request = _request(failed=True)
    fixture = pytest_plugin.c2000_board.__wrapped__(request)
    board = next(fixture)
    board.last_job_id = "job-a"
    with pytest.raises(StopIteration):
        next(fixture)
    assert client.calls[-1][0] == "c2000_closeDebugSession"
    assert request.node.user_properties[0][0] == "c2000_failure"
    assert request.node.user_properties[0][1]["job_id"] == "job-a"


def test_hardware_opt_in_skips_when_ccs_is_not_configured(monkeypatch):
    monkeypatch.setenv("C2000_HARDWARE_TEST", "1")
    monkeypatch.delenv("C2000_HIL_MODE", raising=False)
    client = FakeClient()
    monkeypatch.setattr(pytest_plugin, "DaemonClient", lambda *_: client)
    fixture = pytest_plugin.c2000_board.__wrapped__(_request())
    with pytest.raises(pytest.skip.Exception, match="CCS adapter"):
        next(fixture)


def test_sdk_source_has_no_direct_hardware_or_sqlite_backend():
    import c2000_hil.board as board_module
    import c2000_hil.client as client_module
    source = open(board_module.__file__, encoding="utf-8").read() + open(client_module.__file__, encoding="utf-8").read()
    assert "sqlite3" not in source.lower()
    assert "xds110" not in source.lower()
    assert "dss" not in source.lower()
    assert "invoke(" in source


def _request(failed=False):
    node = SimpleNamespace(
        rep_call=SimpleNamespace(failed=failed),
        user_properties=[],
        get_closest_marker=lambda _name: None,
    )
    config = SimpleNamespace(getoption=lambda _name: None)
    return SimpleNamespace(node=node, config=config)
