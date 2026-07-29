"""Authenticated newline-delimited JSON client for c2000-debugd."""

import json
import os
import socket
import uuid
from pathlib import Path
from typing import Any, Optional

from .errors import C2000HilError, DaemonUnavailable


class DaemonClient:
    """Calls only the public daemon RPC; it never starts CCS or reads SQLite."""

    def __init__(self, runtime_dir: Optional[os.PathLike] = None, timeout: float = 10.0):
        configured = runtime_dir or os.environ.get("C2000_MCP_DAEMON_RUNTIME_DIR") or "runtime"
        self.runtime_dir = Path(configured).resolve()
        self.timeout = timeout

    def health(self) -> dict:
        return self._rpc("health", {})

    def invoke(self, tool_name: str, arguments: Optional[dict] = None, timeout: Optional[float] = None) -> dict:
        envelope = self._rpc(
            "invokeTool",
            {
                "requestId": str(uuid.uuid4()),
                "toolName": tool_name,
                "arguments": arguments or {},
            },
            timeout,
        )
        result = envelope.get("result") if isinstance(envelope, dict) else None
        if not isinstance(result, dict):
            raise C2000HilError("DaemonProtocolError", "Daemon tool response did not contain a result object")
        if result.get("success") is False:
            error = result.get("error") or {}
            raise C2000HilError(
                str(error.get("code", "ToolFailed")),
                str(error.get("message", f"{tool_name} failed")),
                error.get("details"),
            )
        return result

    def _rpc(self, method: str, params: dict, timeout: Optional[float] = None) -> dict:
        instance_path = self.runtime_dir / "debugd-instance.json"
        try:
            instance = json.loads(instance_path.read_text(encoding="utf-8"))
            token_path = Path(instance["authTokenFile"])
            token = token_path.read_text(encoding="utf-8").strip()
            host = instance["host"]
            port = int(instance["port"])
        except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
            raise DaemonUnavailable("DaemonUnavailable", f"Cannot read daemon discovery metadata: {exc}") from exc
        if host != "127.0.0.1" or not token:
            raise DaemonUnavailable("DaemonInstanceInvalid", "Daemon discovery metadata is invalid")
        request_id = str(uuid.uuid4())
        request = {
            "type": "request",
            "id": request_id,
            "method": method,
            "authToken": token,
            "params": params,
        }
        try:
            with socket.create_connection((host, port), timeout=timeout or self.timeout) as connection:
                connection.settimeout(timeout or self.timeout)
                connection.sendall((json.dumps(request, separators=(",", ":")) + "\n").encode("utf-8"))
                response = _receive_line(connection)
        except (OSError, TimeoutError) as exc:
            raise DaemonUnavailable("DaemonUnavailable", f"Cannot call c2000-debugd: {exc}") from exc
        try:
            decoded = json.loads(response)
        except json.JSONDecodeError as exc:
            raise C2000HilError("DaemonProtocolError", "Daemon returned invalid JSON") from exc
        if decoded.get("type") != "response" or decoded.get("id") != request_id:
            raise C2000HilError("DaemonProtocolError", "Daemon response identity mismatch")
        if not decoded.get("ok"):
            error = decoded.get("error") or {}
            raise C2000HilError(
                str(error.get("code", "DaemonProtocolError")),
                str(error.get("message", "Daemon RPC failed")),
                error.get("details"),
            )
        result = decoded.get("result")
        if not isinstance(result, dict):
            raise C2000HilError("DaemonProtocolError", "Daemon RPC result was not an object")
        return result


def _receive_line(connection: socket.socket, limit: int = 16 * 1024 * 1024) -> str:
    chunks = bytearray()
    while len(chunks) < limit:
        chunk = connection.recv(65536)
        if not chunk:
            break
        chunks.extend(chunk)
        newline = chunks.find(b"\n")
        if newline >= 0:
            return chunks[:newline].decode("utf-8")
    raise C2000HilError("DaemonProtocolError", "Daemon response was incomplete or too large")
