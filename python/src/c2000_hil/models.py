from dataclasses import dataclass
from typing import Any, Optional


@dataclass(frozen=True)
class VariableMatch:
    matched: bool
    timed_out: bool
    value: Any
    symbol: str
    core_id: int
    core_name: Optional[str]
    raw: dict


@dataclass(frozen=True)
class FailureAttachment:
    job_id: Optional[str]
    result: Optional[dict]
    artifact_path: Optional[str]
    failure_bundle_path: Optional[str]
