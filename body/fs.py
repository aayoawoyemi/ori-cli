# File: body/fs.py
# Purpose: Unified filesystem primitive exposed to the model inside the Repl
#   namespace. Read-side operations (read, listdir, glob) run locally in the
#   Python process for speed. Write-side operations (write, edit, patch) route
#   through the TS bridge via fs_request/fs_response callbacks so the TS host
#   can enforce workspace-scope checks, capture edit snapshots, and — later —
#   wire into the permission-approval flow.
# Key pieces:
#   - Fs class, instantiated once at server startup as module-global FS
#   - Local methods: read / listdir / glob — no bridge round-trip
#   - Proxy methods: write / edit / patch — block on stdout→stdin RPC
#   - resolve(id, result) — called by server.py main loop when fs_response
#     arrives from TS, unblocks the waiting thread
# Role: Registered under the name "fs" in the Repl namespace by server.py's
#   _build_namespace. Mirrors the exact callback pattern used by vault.py and
#   research.py (same threading.Event blocking, same stdout_lock protection,
#   same request_id/pending dict shape). See ORI.md "callback pattern" rule:
#   we do not invent a new transport for bridged primitives.

from __future__ import annotations

import json

from _protocol import write_message
import os
import pathlib
import sys
import threading
from typing import Any


class FsError(Exception):
    """Raised for filesystem errors surfaced to the model. Message is the text
    the model will see in its tool_result — keep it teaching, not cryptic."""
    pass


# ── Local read helpers ──────────────────────────────────────────────────────
# These three mirror the SimpleNamespace helpers that previously lived inline
# in server.py._build_namespace. Kept local (no bridge round-trip) because
# reads don't require permission approval, and the round-trip would double
# the cost of every file inspection the model does. If we later need to
# enforce read-side workspace boundaries (e.g. "don't read outside the
# repo"), add the check here — don't push it to the bridge.

_MAX_READ_BYTES = 2_000_000  # 2MB cap — prevents pathological model reads


def _local_read(path: str, offset: int = 0, limit: int | None = None) -> str:
    p = pathlib.Path(path).expanduser().resolve()
    if not p.exists():
        raise FsError(f"fs.read: no file at {p}")
    size = p.stat().st_size
    if size > _MAX_READ_BYTES:
        raise FsError(f"fs.read: file exceeds {_MAX_READ_BYTES} bytes ({size})")
    text = p.read_text(encoding="utf-8", errors="replace")
    lines = text.splitlines(keepends=True)
    end = offset + limit if limit is not None else len(lines)
    return "".join(lines[offset:end])


def _local_listdir(path: str = ".") -> list[str]:
    p = pathlib.Path(path).expanduser().resolve()
    if not p.exists():
        raise FsError(f"fs.listdir: no directory at {p}")
    if not p.is_dir():
        raise FsError(f"fs.listdir: {p} is not a directory")
    # Trailing slash signals directory in the output — makes it easy for the
    # model to distinguish files from subdirs without a second stat() call.
    return sorted(entry.name + ("/" if entry.is_dir() else "") for entry in p.iterdir())


def _local_glob(pattern: str, path: str = ".") -> list[str]:
    p = pathlib.Path(path).expanduser().resolve()
    if not p.exists():
        raise FsError(f"fs.glob: no directory at {p}")
    if not p.is_dir():
        raise FsError(f"fs.glob: {p} is not a directory")
    results: list[str] = []
    for match in p.glob(pattern):
        results.append(str(match.relative_to(p)))
        # Hard cap at 200 — pathological globs like "**/*" on a big repo would
        # otherwise dump thousands of paths into the model context. 200 is
        # the same cap the old SimpleNamespace version used; changing it is
        # a separate decision with its own trade-off.
        if len(results) >= 200:
            break
    return sorted(results)


# ── Fs proxy ─────────────────────────────────────────────────────────────────
# Local + proxy methods on one object so the model sees a unified namespace.
# The model does not need to know which operations go over the wire and which
# run locally — that's a harness decision. Symmetry of naming matters.

class Fs:
    """
    Filesystem primitive for the Repl namespace.

    Reads run locally, writes route through the TS bridge. See module
    docstring for the architectural rationale.

    Pattern is identical to vault.Vault and research.Research:
    - `_request_id`, `_pending`, `_lock`, `_stdout_lock`, `_next_id`, `_call`,
      and `resolve` all mirror vault.py line-for-line.
    - If you change the protocol here, change it in vault.py and research.py
      in the same commit — the bridge's routing code treats them the same.
    """

    def __init__(self) -> None:
        self._request_id = 0
        self._pending: dict[int, dict[str, Any]] = {}
        # _lock guards _pending (Python state). _stdout_lock removed in
        # Batch 1.6 — protocol writes go through _protocol.write_message
        # which is atomic via os.write. See _protocol.py header.
        self._lock = threading.Lock()

    # ── Lifecycle ──────────────────────────────────────────────────────────
    # Fs has no "connect" step (unlike Vault, which needs a vault path).
    # It's always available. Kept `resolve()` on the class so server.py's
    # main loop can route fs_response messages uniformly.

    def resolve(self, request_id: int, result: Any) -> None:
        """Called by server.py main loop when fs_response arrives from TS."""
        with self._lock:
            if request_id in self._pending:
                self._pending[request_id]["result"] = result
                self._pending[request_id]["event"].set()

    def _next_id(self) -> int:
        self._request_id += 1
        return self._request_id

    def _call(self, method: str, args: dict, timeout: float = 30.0) -> Any:
        """
        Send fs_request to stdout, block until fs_response arrives on stdin.

        Timeout is generous (30s) because Edit on a large file with fuzzy
        matching is not instant, and permission prompts (when wired) can
        block on the user. If the timeout fires, the pending entry is
        cleaned up and the caller gets FsError — matches vault's behavior.
        """
        req_id = self._next_id()
        event = threading.Event()

        with self._lock:
            self._pending[req_id] = {"event": event, "result": None}

        # Protocol write via _protocol.write_message — atomic os.write on
        # sys.__stdout__.fileno(), bypasses the captured sys.stdout that
        # repl.py redirects during exec. Batch 1.6 (2026-04-23).
        write_message({"fs_request": {"id": req_id, "method": method, "args": args}})

        if not event.wait(timeout=timeout):
            with self._lock:
                self._pending.pop(req_id, None)
            raise FsError(f"fs call timed out: {method}")

        with self._lock:
            entry = self._pending.pop(req_id)
            result = entry["result"]

        # TS surfaces errors as {"error": "..."} — lift them into FsError
        # so the model's except-handler can catch them as actual exceptions,
        # not opaque dicts. Matches vault.py error lifting.
        if isinstance(result, dict) and "error" in result:
            raise FsError(result["error"])

        return result

    # ── Local (read-only, no bridge) ───────────────────────────────────────

    def read(self, path: str, offset: int = 0, limit: int | None = None) -> str:
        """
        Read a file from disk. Absolute or relative paths accepted.

        Args:
            path: file to read
            offset: line offset to start from (0-indexed)
            limit: max lines to return (None = all)

        Raises FsError if the file is missing or exceeds the 2MB cap.
        """
        return _local_read(path, offset, limit)

    def listdir(self, path: str = ".") -> list[str]:
        """List a directory. Directories get a trailing slash in the output."""
        return _local_listdir(path)

    def glob(self, pattern: str, path: str = ".") -> list[str]:
        """Glob a pattern under a path. Capped at 200 results."""
        return _local_glob(pattern, path)

    # ── Proxy (writes, via TS bridge) ──────────────────────────────────────
    # These block on the bridge. The TS side handles workspace-scope checks,
    # permission prompts (when wired), and edit snapshots. The Python side
    # is intentionally thin — it does not validate paths, check content, or
    # simulate the write. Doing any of that here duplicates logic that must
    # live on the TS side anyway (because the bridge is the authority for
    # mutations).

    def write(self, path: str, content: str) -> dict:
        """
        Write a file. Creates parent directories. Overwrites existing content.

        Args:
            path: target file path (absolute or relative)
            content: full file content as a string

        Returns a dict with `{ok, path, bytes}` on success.
        Raises FsError if the write is rejected (outside workspace, permission
        denied, etc) — the message explains what to try instead.
        """
        return self._call("write", {"path": path, "content": content})

    def edit(self, path: str, old: str, new: str, replace_all: bool = False) -> dict:
        """
        Replace `old` with `new` in `path`. Uses the same fuzzy-matching logic
        as the EditTool (handles whitespace, indent, and escape differences).

        Args:
            path: file to edit
            old: string to find (must be unique unless replace_all=True)
            new: replacement string
            replace_all: replace every occurrence instead of requiring uniqueness

        Returns a dict with `{ok, path, diff, strategy}` on success.
        """
        return self._call("edit", {
            "path": path,
            "old": old,
            "new": new,
            "replace_all": replace_all,
        })

    def patch(self, path: str, edits: list[tuple[str, str]], replace_all: bool = False) -> dict:
        """
        Apply multiple (old, new) edits to `path` in a single bridge round-trip.

        Faster than calling edit() in a loop when you have several small
        changes in the same file — one permission prompt, one snapshot,
        one diff. Edits apply in order; each sees the result of the previous.

        Args:
            path: file to patch
            edits: list of (old_string, new_string) tuples
            replace_all: apply replace_all semantics to every edit

        Returns `{ok, path, diff, applied}`.
        """
        # Tuples serialize fine as JSON arrays; TS side receives [string, string] pairs.
        return self._call("patch", {
            "path": path,
            "edits": [list(e) for e in edits],
            "replace_all": replace_all,
        })
