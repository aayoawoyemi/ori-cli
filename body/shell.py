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


# 2026-04-25 — unix-ism table for failure-time hint enrichment.
# Aries-self surfaced this friction in a live session: model reaches for
# grep / ls / cat / find / sed / awk / && reflexively (Unix training prior),
# they fail on cmd.exe with cryptic errors that don't suggest the harness
# alternative. We don't BLOCK these (they're legitimate on a real Unix host;
# Windows users with Git Bash on PATH may also have them working) — we only
# nudge AFTER a failure. The hint shows up in the model's view of stderr,
# next to the actual failure, so the next batch reaches for the right
# primitive without losing a turn to discovery.
#
# Format: command-name → (replacement primitive, one-line why).
# Entries here should be conservative — only commands where the harness
# primitive is a real drop-in. Don't add `awk` here just because it failed
# once; only add it when codebase.* / fs.* covers the common use case.
_UNIX_HINTS: dict[str, tuple[str, str]] = {
    "grep":  ("codebase.search(query)",
              "structured search across the indexed codebase, no shell"),
    "ls":    ("fs.listdir(path)",
              "Python list of names; faster than spawning a shell"),
    "cat":   ("fs.read(path)",
              "returns file contents as str; bounded to 2MB"),
    "find":  ("fs.glob(pattern, path)",
              "glob-style file search; capped at 200 results"),
    "sed":   ("fs.edit(path, old, new) or fs.patch(path, edits)",
              "structured fuzzy-match edits, no regex escaping"),
    "head":  ("fs.read(path, limit=N)",
              "limit kwarg returns first N lines"),
    "tail":  ("fs.read(path, offset=-N)",
              "negative offset returns last N lines"),
    "wc":    ("len(fs.read(path).splitlines())",
              "Python len + splitlines; cheaper than a shell call"),
}


def _detect_unix_isms(cmd: str) -> list[str]:
    """Return the list of unix-ism names found in the command string.

    Cheap regex-free scan: split on whitespace, &&, ||, |, ;, then check
    each token against _UNIX_HINTS keys. Catches the common cases
    (`grep foo bar`, `ls | cat`, `cd x && grep y`) without touching the
    expensive regex engine.

    False-positive safe: only matches the FIRST token of each command
    segment (the actual program name), so `--grep` flags and filenames
    containing 'grep' don't trigger.
    """
    import re
    # Split on shell separators. Keep order so we report hits left-to-right.
    segments = re.split(r"\s*(?:&&|\|\||\||;)\s*", cmd)
    found: list[str] = []
    seen: set[str] = set()
    for seg in segments:
        seg = seg.strip()
        if not seg:
            continue
        first = seg.split(None, 1)[0]
        # Strip path prefix (e.g., "/usr/bin/grep" → "grep") so the table
        # match works regardless of whether the model reached for the
        # bare name or a full path.
        bare = first.rsplit("/", 1)[-1].rsplit("\\", 1)[-1]
        if bare in _UNIX_HINTS and bare not in seen:
            found.append(bare)
            seen.add(bare)
    return found


def _format_unix_hint(detected: list[str]) -> str:
    """Render the unix-ism hint as a stderr-appended block. Multi-line so
    the model can scan it visually and pick the right replacement. Format
    mirrors the [harness:cutoff] marker style for consistency — `[harness:`
    prefix + dotted detail tag tells the model "this came from the harness,
    not the underlying tool."""
    lines = [
        "",
        "[harness:shell-hint] Unix command(s) failed on this platform. "
        "Prefer the harness primitive for these:"
    ]
    for name in detected:
        replacement, why = _UNIX_HINTS[name]
        lines.append(f"  {name} → {replacement}  ({why})")
    return "\n".join(lines)


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
        result = self._call("run", args, timeout=timeout + 10.0)

        # 2026-04-25 — failure-time unix-ism hint. Only fires when the
        # command FAILED (non-zero exit) AND a unix-ism was detected in
        # the command string. Two-AND because:
        #   - On a Unix host (or Windows + Git Bash), `grep` etc. work
        #     fine and we shouldn't nag.
        #   - On Windows cmd.exe, the failure is the signal that the
        #     model reached for a Unix idiom that doesn't exist here.
        # Surfacing the hint via stderr keeps it next to the actual error
        # the model is parsing — they read both in the same glance and
        # the next batch reaches for the harness primitive instead.
        if isinstance(result, dict) and result.get("code", 0) != 0:
            detected = _detect_unix_isms(cmd)
            if detected:
                hint = _format_unix_hint(detected)
                existing_stderr = result.get("stderr", "") or ""
                result["stderr"] = existing_stderr.rstrip() + hint
        return result
