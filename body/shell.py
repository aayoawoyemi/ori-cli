# File: body/shell.py
# Purpose: Shell execution primitive exposed to the model inside the Repl
#   namespace. Wraps the TS child_process.exec — the model writes
#   `result = shell.run("npm test")` and gets back {stdout, stderr, code,
#   duration_ms}. Replaces the need for a top-level Bash tool entirely.
# Key pieces:
#   - Shell class, instantiated once at server startup as module-global SHELL
#   - run(cmd, timeout=30, cwd=None) — blocks on bridge, returns dict
#   - resolve(id, result) — called by server.py main loop on shell_response
# Role: Registered under the name "shell" in the Repl namespace by
#   _build_namespace. Mirrors vault.py / research.py / fs.py callback pattern
#   line-for-line. Same threading.Event blocking, same stdout_lock protection,
#   same request_id/pending shape. See ORI.md "callback pattern" rule.
#
# Design note on the zigzag problem:
#   The top-level Bash tool has elaborate blocklists (cat/grep/find blocked
#   when Repl is on, sed/awk blocked always, etc.) to stop the model from
#   zigzagging between Bash and Repl for navigation tasks. shell.run does
#   NOT need those blocks. The model is already inside Python when it calls
#   shell.run — there's no zigzag to prevent. It called shell.run because
#   it genuinely wanted shell (build, test, git, install). Don't replicate
#   the top-level Bash safety theater here.
#
#   The one exception: catastrophic commands that the user never intended
#   the agent to have authority for (sudo, mkfs, dd to block devices).
#   Those are checked on the TS side in dispatchShellMethod before execution.

from __future__ import annotations

import json
import sys

from _protocol import write_message
import threading
from typing import Any, Optional


class ShellError(Exception):
    """Raised when a shell call is rejected, times out, or the bridge errors.
    Successful commands with non-zero exit codes are NOT errors — they return
    normally with the code field set. Callers check `result['code']` to
    distinguish."""
    pass


class Shell:
    """
    Shell execution primitive. Proxies shell commands through the TS bridge.

    Pattern is identical to Vault / Research / Fs. If you change this,
    change those in the same commit — the bridge's routing treats them
    uniformly.

    Return-value convention:
    - Success: `{ok: True, stdout, stderr, code, duration_ms}`. Note that
      `code != 0` is still `ok: True` — the shell ran, it just exited
      non-zero. That's data, not an error.
    - Timeout / rejected / bridge error: raises ShellError. The shell was
      NOT run, or was killed mid-run. Distinct from a successful run with
      a non-zero exit.
    """

    def __init__(self) -> None:
        self._request_id = 0
        self._pending: dict[int, dict[str, Any]] = {}
        # _lock guards _pending. _stdout_lock removed in Batch 1.6 —
        # see body/_protocol.py header.
        self._lock = threading.Lock()

    def resolve(self, request_id: int, result: Any) -> None:
        """Called by server.py main loop when shell_response arrives from TS."""
        with self._lock:
            if request_id in self._pending:
                self._pending[request_id]["result"] = result
                self._pending[request_id]["event"].set()

    def _next_id(self) -> int:
        self._request_id += 1
        return self._request_id

    def _call(self, method: str, args: dict, timeout: float = 60.0) -> Any:
        """
        Send shell_request via stdout, block until shell_response on stdin.

        Timeout here is the BRIDGE timeout (how long we wait for TS to
        respond at all), not the command timeout (how long the shell
        command itself runs). Command timeout is a separate arg passed
        to run(). Bridge timeout = command_timeout + 10s to cover the
        TS-side overhead of spawn/kill/capture.
        """
        req_id = self._next_id()
        event = threading.Event()

        with self._lock:
            self._pending[req_id] = {"event": event, "result": None}

        # Atomic bridge write via _protocol.write_message (Batch 1.6).
        write_message({"shell_request": {"id": req_id, "method": method, "args": args}})

        if not event.wait(timeout=timeout):
            with self._lock:
                self._pending.pop(req_id, None)
            raise ShellError(f"shell call timed out waiting for bridge: {method}")

        with self._lock:
            entry = self._pending.pop(req_id)
            result = entry["result"]

        if isinstance(result, dict) and "error" in result:
            raise ShellError(result["error"])

        return result

    # ── Primary verb ───────────────────────────────────────────────────────

    def run(self, cmd: str, timeout: int = 30, cwd: Optional[str] = None) -> dict:
        """
        Execute a shell command. Blocks until the command finishes or times out.

        Args:
            cmd: the command to run (passed through the system shell —
                `/bin/sh -c` on Unix, `cmd.exe /c` on Windows). Supports
                pipes, redirects, env-var expansion, and other shell
                features. This is intentional; the model may compose
                (`npm test | grep FAIL`). No escaping is done — treat the
                cmd string as code you're writing.
            timeout: command timeout in seconds (hard cap: 600). If the
                command exceeds this, the child process is killed and
                ShellError is raised with whatever stdout/stderr was
                captured before the kill.
            cwd: working directory. Defaults to the Aries workspace root
                (set by setup.ts via bridge.setCwd). If provided, must be
                an absolute path inside the workspace — the TS side
                enforces this the same way fs.write does, so writing a
                file via `shell.run("echo x > /etc/hosts")` still fails
                the workspace boundary check.

        Returns:
            {
                "ok": True,              # always True on non-error return
                "stdout": str,           # captured stdout, as string
                "stderr": str,           # captured stderr, as string
                "code": int,             # exit code (0 = success)
                "duration_ms": int,      # wall clock
            }

        Raises:
            ShellError: if the bridge rejects the command, the command
                times out (and is killed), or cwd escapes the workspace.
                A successful command with a non-zero exit is NOT an error
                — the model decides whether non-zero matters.
        """
        if not isinstance(cmd, str) or not cmd.strip():
            raise ShellError("shell.run: cmd must be a non-empty string")
        if timeout < 1 or timeout > 600:
            raise ShellError("shell.run: timeout must be between 1 and 600 seconds")

        args: dict = {"cmd": cmd, "timeout": timeout}
        if cwd is not None:
            args["cwd"] = cwd

        # Bridge-side timeout = command timeout + 10s slack. If the command
        # takes 30s, we wait 40s for a response (gives TS time to kill a
        # stuck process and send back partial output).
        return self._call("run", args, timeout=timeout + 10.0)
