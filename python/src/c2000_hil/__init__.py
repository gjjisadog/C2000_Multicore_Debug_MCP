"""Thin, daemon-only C2000 HIL SDK."""

from .board import C2000Board
from .client import DaemonClient
from .errors import C2000HilError, DaemonUnavailable, HardwareGateSkipped
from .models import FailureAttachment, VariableMatch

__all__ = [
    "C2000Board",
    "C2000HilError",
    "DaemonClient",
    "DaemonUnavailable",
    "FailureAttachment",
    "HardwareGateSkipped",
    "VariableMatch",
]

__version__ = "0.7.0"
