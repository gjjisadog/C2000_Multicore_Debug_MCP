class C2000HilError(RuntimeError):
    """Structured daemon/tool failure."""

    def __init__(self, code: str, message: str, details=None):
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message
        self.details = details or {}


class DaemonUnavailable(C2000HilError):
    pass


class HardwareGateSkipped(RuntimeError):
    """Raised internally so the pytest plugin can report a precise skip."""
