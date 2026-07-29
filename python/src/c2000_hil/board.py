from pathlib import Path
from typing import Any, Optional

from .client import DaemonClient
from .models import FailureAttachment, VariableMatch


DEFAULT_CORE_MAP = [
    {"coreId": 0, "coreName": "CPU1", "corePattern": "C28xx_CPU1"},
    {"coreId": 2, "coreName": "CPU2", "corePattern": "C28xx_CPU2"},
]


class C2000Board:
    """One explicit daemon-owned board lease represented by a debug session."""

    def __init__(self, client: DaemonClient, board_id: str):
        self.client = client
        self.board_id = board_id
        self.session_id: Optional[str] = None
        self.adapter_session_id: Optional[str] = None
        self.worker_generation: Optional[int] = None
        self.last_job_id: Optional[str] = None
        self.released = False

    def acquire(self) -> "C2000Board":
        if self.session_id:
            return self
        result = self.client.invoke(
            "c2000_createDebugSession",
            {
                "boardId": self.board_id,
                "sessionName": "pytest-hil",
                "coreMap": DEFAULT_CORE_MAP,
                "allowAutoProbeAllocation": False,
            },
        )
        self.session_id = str(result["sessionId"])
        self.adapter_session_id = _optional_string(result.get("adapterSessionId"))
        generation = result.get("workerGeneration")
        self.worker_generation = int(generation) if isinstance(generation, int) else None
        self.released = False
        return self

    def release(self) -> None:
        if not self.session_id or self.released:
            return
        session_id = self.session_id
        self.released = True
        try:
            self.client.invoke("c2000_closeDebugSession", {"sessionId": session_id})
        finally:
            self.session_id = None

    def submit_test_plan(self, plan: dict) -> dict:
        result = self.client.invoke("c2000_submitTestPlan", {"plan": plan})
        self.last_job_id = _job_id(result)
        return result

    def load_programs(self, cpu1: str, cpu2: str, cpu1_map: Optional[str] = None, cpu2_map: Optional[str] = None) -> dict:
        programs = [
            _program(0, cpu1, cpu1_map),
            _program(2, cpu2, cpu2_map),
        ]
        return self.client.invoke("c2000_loadPrograms", {"sessionId": self._session(), "programs": programs})

    def run(self, core_id: int) -> dict:
        return self.client.invoke("c2000_runCore", {"sessionId": self._session(), "coreId": core_id})

    def pause(self, core_id: int) -> dict:
        return self.client.invoke("c2000_haltCore", {"sessionId": self._session(), "coreId": core_id})

    def reset(self, core_id: int, reset_type: str = "default") -> dict:
        return self.client.invoke(
            "c2000_reset",
            {"sessionId": self._session(), "coreId": core_id, "resetType": reset_type},
        )

    def get_target_state(self, core_id: int) -> dict:
        return self.client.invoke("c2000_getTargetState", {"sessionId": self._session(), "coreId": core_id})

    def wait_for_variable(
        self,
        core_id: int,
        symbol: str,
        equals: Any,
        timeout: float,
        interval: float = 0.1,
    ) -> VariableMatch:
        raw = self.client.invoke(
            "c2000_waitUntilExpression",
            {
                "sessionId": self._session(),
                "coreId": core_id,
                "expression": symbol,
                "expected": equals,
                "timeoutMs": max(1, int(timeout * 1000)),
                "intervalMs": max(1, int(interval * 1000)),
            },
            timeout=max(timeout + 2.0, self.client.timeout),
        )
        last = raw.get("lastResult")
        value = last.get("value") if isinstance(last, dict) else None
        return VariableMatch(
            matched=bool(raw.get("matched")),
            timed_out=bool(raw.get("timedOut")),
            value=value,
            symbol=symbol,
            core_id=core_id,
            core_name=_optional_string(raw.get("coreName")),
            raw=raw,
        )

    def cancel_job(self, job_id: Optional[str] = None) -> dict:
        selected = job_id or self.last_job_id
        if not selected:
            raise ValueError("job_id is required before any job has been submitted")
        return self.client.invoke("c2000_cancelTestRun", {"jobId": selected})

    def collect_artifacts(self, job_id: Optional[str] = None) -> dict:
        selected = job_id or self.last_job_id
        if not selected:
            raise ValueError("job_id is required before any job has been submitted")
        return self.client.invoke("c2000_getTestArtifacts", {"jobId": selected})

    def failure_attachment(self) -> FailureAttachment:
        if not self.last_job_id:
            return FailureAttachment(None, None, None, None)
        result = _best_effort(self.client, "c2000_getTestRun", {"jobId": self.last_job_id, "includeSteps": True, "includeEvents": False})
        artifacts = _best_effort(self.client, "c2000_getTestArtifacts", {"jobId": self.last_job_id})
        bundle = _best_effort(self.client, "c2000_collectFailureBundle", {"jobId": self.last_job_id})
        export = artifacts.get("artifactExport") if isinstance(artifacts, dict) else None
        artifact_path = export.get("rootPath") if isinstance(export, dict) else None
        return FailureAttachment(
            self.last_job_id,
            result,
            _optional_string(artifact_path),
            _optional_string(bundle.get("bundlePath") if isinstance(bundle, dict) else None),
        )

    def _session(self) -> str:
        if not self.session_id:
            raise RuntimeError("Board is not acquired")
        return self.session_id


def _program(core_id: int, out_file: str, map_file: Optional[str]) -> dict:
    value = {
        "coreId": core_id,
        "programUri": str(Path(out_file)),
        "ramOwnershipPolicy": "require-map" if map_file else "skip",
        "loadPolicy": "always",
    }
    if map_file:
        value["mapUri"] = str(Path(map_file))
    return value


def _job_id(result: dict) -> Optional[str]:
    value = result.get("jobId")
    return str(value) if value else None


def _optional_string(value) -> Optional[str]:
    return str(value) if value is not None else None


def _best_effort(client: DaemonClient, tool: str, arguments: dict) -> Optional[dict]:
    try:
        return client.invoke(tool, arguments)
    except Exception:
        return None
