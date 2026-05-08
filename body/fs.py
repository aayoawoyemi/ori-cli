# File: body/fs.py
# Purpose: Unified filesystem primitive exposed to the model inside code
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
# Role: Registered under the name "fs" in the code namespace by server.py's
#   _build_namespace. Mirrors the exact callback pattern used by vault.py and
#   research.py (same threading.Event blocking, same stdout_lock protection,
#   same request_id/pending dict shape). See ARIES.md "callback pattern" rule:
#   we do not invent a new transport for bridged primitives.

from __future__ import annotations

import json

from _protocol import write_message
import os
import pathlib
import re
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
        # Suggest alternatives when the model tries a wrong path. Common
        # failure mode: off-by-one directory level or filename typo.
        hint = f"fs.read: no file at {p}"
        parent = p.parent
        if parent.exists():
            siblings = [e.name for e in parent.iterdir() if e.is_file()]
            close = [s for s in siblings if p.stem.lower() in s.lower()]
            if close:
                hint += f"\n  Similar files in {parent}: {', '.join(close[:5])}"
            elif siblings:
                hint += f"\n  Files in {parent}: {', '.join(siblings[:8])}"
        hint += f"\n  Try: codebase.search(\"{p.stem}\") or fs.glob(\"*{p.suffix or ''}\", \"{parent}\")"
        raise FsError(hint)
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

# â”€â”€ Codebase-aware fs.read footer â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
# When a codebase index is available, fs.read appends a structural footer
# (symbols, dependents, tip) to help the model navigate from a single read.
# server.py sets _CODEBASE_REF after index completes. This avoids circular
# imports â€” fs.py never imports from server.py.
_CODEBASE_REF = None  # set by server.py after indexing


def _structural_footer(path: str) -> str:
    """Build a structural footer for an indexed file, or empty string."""
    cb = _CODEBASE_REF
    if cb is None:
        return ""
    # Normalize the path to match codebase index keys
    p = pathlib.Path(path).expanduser().resolve()
    # Try to find the file in the index by matching suffixes
    rel = None
    for indexed_path in cb.files:
        if p.as_posix().endswith(indexed_path) or indexed_path.endswith(p.name):
            try:
                if pathlib.Path(indexed_path).resolve() == p:
                    rel = indexed_path
                    break
            except Exception:
                pass
        if p.as_posix().replace("\\", "/").endswith(indexed_path.replace("\\", "/")):
            rel = indexed_path
            break
    if rel is None:
        return ""
    summary = cb.get_file_summary(rel)
    if "error" in summary:
        return ""
    # Build compact footer
    parts = ["\n--- codebase context ---"]
    syms = summary.get("symbols", [])
    if syms:
        sym_strs = [f"{s.get('kind','?')} {s['name']} (L{s.get('line','?')})" for s in syms[:12]]
        parts.append(f"Symbols: {', '.join(sym_strs)}")
    deps = cb.show_dependents(rel)
    if deps:
        dep_strs = [f"{d[0]}" for d in deps[:8]]
        parts.append(f"Imported by: {', '.join(dep_strs)}")
    imports = cb.show_dependencies(rel)
    if imports:
        imp_strs = [f"{d[0]}" for d in imports[:8]]
        parts.append(f"Imports: {', '.join(imp_strs)}")
    parts.append("TIP: codebase.get_context(file, [line], window) for targeted reads")
    parts.append("---")
    return "\n".join(parts) + "\n"


# ── Defensive: strip codebase footer from write inputs ─────────────────────
# Fs.read no longer auto-appends the codebase footer (removed 2026-05-03 — see
# Fs.read docstring for the incident). This regex backstops the model anyway:
# any fs.write/edit/patch input ending in a footer block gets the block
# stripped before it reaches disk. Anchored at end-of-string to avoid eating
# anything in the middle of a legitimate document.
#
# Pattern shape (must stay in sync with _structural_footer's emit format):
#   "\n--- codebase context ---\n<body>\n---\n?"
# The leading newline is optional because fs.read used to do `content + footer`
# without a separator — so the boundary is `<last char of content>\n--- ...`
# but `<last char>` may itself be a newline (giving "\n\n--- ...").
_CODEBASE_FOOTER_RE = re.compile(
    r"\n?--- codebase context ---\n.*?\n---\n?\Z",
    re.DOTALL,
)


def _strip_codebase_footer(text: str) -> str:
    """Strip a trailing codebase-context footer from `text`, if present."""
    if not text or "--- codebase context ---" not in text:
        return text
    return _CODEBASE_FOOTER_RE.sub("", text)


class Fs:
    """
    Filesystem primitive for the code namespace.

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

        Returns RAW file content — byte-for-byte equal to disk so that
        read-modify-write idioms (`fs.write(p, fs.read(p).replace(...))`)
        round-trip cleanly. For symbol / dependent navigation use the
        explicit `fs.context(path)` method or `codebase.get_file_summary`.

        History: between 2026-05-02 and 2026-05-03 this method auto-
        appended a structural footer to indexed files. A model-driven
        bulk-rename loop on three body/*.py files round-tripped that
        footer to disk via fs.write, producing SyntaxError on body
        startup and a 10× bench-token regression that masqueraded as a
        prompt issue. Footer removed; explicit opt-in only. The defensive
        strip in fs.write/edit/patch (see _strip_codebase_footer) is the
        backstop against any cached/copy-pasted footer-laden content
        that might still be in flight.
        """
        return _local_read(path, offset, limit)

    def context(self, path: str) -> str:
        """
        Return the codebase-context block for `path` if it's indexed:
        symbols, dependents, dependencies, and a navigation tip. Empty
        string if the codebase index is unset or `path` isn't in it.

        Use this when you want the structural overview without re-reading
        the file. The block is the same one fs.read used to auto-append
        before 2026-05-03 — exposed as an explicit primitive instead so
        callers never accidentally round-trip it back to disk.
        """
        return _structural_footer(path)

    def listdir(self, path: str = ".") -> list[str]:
        """List a directory. Directories get a trailing slash in the output."""
        return _local_listdir(path)

    def glob(self, pattern: str, path: str = ".") -> list[str]:
        """Glob a pattern under a path. Capped at 200 results."""
        return _local_glob(pattern, path)

    # ── Read helpers absorbed from standalone tools (Pi-parity Batch 3) ──
    # These previously lived as standalone Tools (Grep, Glob, navigation
    # helpers). After codemode consolidation the model only sees code, so
    # these helpers replace the tool surface. All read-only, no bridge.

    def grep(
        self,
        pattern: str,
        path: str,
        ignore_case: bool = False,
        literal: bool = False,
        context: int = 0,
    ) -> list[dict]:
        """
        Regex search a single file. Returns a list of matching line records:
        [{"line": <1-indexed>, "text": <line content>}].

        Args:
            pattern: regex (or literal string if literal=True)
            path: file to search
            ignore_case: match case-insensitively
            literal: treat pattern as a plain string, not a regex
            context: include this many lines before/after each match
        """
        import re as _re

        flags = _re.IGNORECASE if ignore_case else 0
        rx = _re.compile(_re.escape(pattern) if literal else pattern, flags)

        try:
            text = _local_read(path)
        except FsError:
            raise
        lines = text.split("\n")

        matched_indices: list[int] = []
        for i, line in enumerate(lines):
            if rx.search(line):
                matched_indices.append(i)

        # Expand with context window
        if context > 0:
            keep: set[int] = set()
            for i in matched_indices:
                lo = max(0, i - context)
                hi = min(len(lines) - 1, i + context)
                for j in range(lo, hi + 1):
                    keep.add(j)
            matched_indices = sorted(keep)

        return [{"line": i + 1, "text": lines[i]} for i in matched_indices]

    def rgrep(
        self,
        pattern: str,
        path: str = ".",
        glob_pattern: str = "*",
        ignore_case: bool = False,
        literal: bool = False,
        limit: int = 100,
        hidden: bool = False,
    ) -> list[dict]:
        """
        Recursive regex search across files matching `glob_pattern` under
        `path`. Returns:
        [{"file": <relative path>, "line": <1-indexed>, "text": <line>}]

        Honors .gitignore in spirit (skips node_modules, .git, dist, build
        by default; flip `hidden=True` to include dotfiles/dotfolders too).

        Args:
            pattern: regex (or literal if literal=True)
            path: directory to walk
            glob_pattern: filename glob filter (e.g. "*.ts", "**/*.py")
            ignore_case, literal: as in grep()
            limit: cap on total match records returned
            hidden: include dotfiles/dotfolders
        """
        import re as _re
        import fnmatch as _fnmatch

        flags = _re.IGNORECASE if ignore_case else 0
        rx = _re.compile(_re.escape(pattern) if literal else pattern, flags)

        # Default skip set — keep in sync with _local_glob (uses pathlib's
        # glob which doesn't auto-skip these). Adding .aries to skip our
        # own session traces by default.
        SKIP = {"node_modules", ".git", "dist", "build", "__pycache__", ".aries", ".venv", "venv"}

        results: list[dict] = []
        root = pathlib.Path(path).expanduser().resolve()

        # Walk via pathlib.rglob so we honor the user-supplied glob_pattern.
        # If glob_pattern doesn't contain a separator, treat it as a basename
        # glob (apply to filename only). With a separator, it's a path glob.
        path_glob = "/" in glob_pattern or "\\" in glob_pattern
        try:
            for entry in root.rglob("**/*" if not glob_pattern else glob_pattern):
                if not entry.is_file():
                    continue
                if not hidden and any(p.startswith(".") for p in entry.relative_to(root).parts):
                    continue
                if any(p in SKIP for p in entry.relative_to(root).parts):
                    continue
                if not path_glob and not _fnmatch.fnmatch(entry.name, glob_pattern):
                    # We pre-filtered with rglob's pattern but redundant filter
                    # is cheap and catches edge cases on Windows.
                    continue
                try:
                    text = entry.read_text(encoding="utf-8", errors="replace")
                except (OSError, UnicodeDecodeError):
                    continue
                rel = entry.relative_to(root).as_posix()
                for i, line in enumerate(text.split("\n")):
                    if rx.search(line):
                        results.append({"file": rel, "line": i + 1, "text": line})
                        if len(results) >= limit:
                            return results
        except OSError as exc:
            raise FsError(f"fs.rgrep: failed to walk {root}: {exc}")

        return results

    def tree(
        self,
        path: str = ".",
        max_depth: int = 3,
        show_hidden: bool = False,
    ) -> str:
        """
        Render a directory tree as text. Returns a string ready to print.

        Args:
            path: root directory
            max_depth: how many levels deep to render (default 3)
            show_hidden: include dotfiles/dotfolders
        """
        SKIP = {"node_modules", ".git", "dist", "build", "__pycache__", ".aries", ".venv", "venv"}
        root = pathlib.Path(path).expanduser().resolve()
        if not root.exists():
            raise FsError(f"fs.tree: no directory at {root}")
        if not root.is_dir():
            raise FsError(f"fs.tree: not a directory: {root}")

        lines: list[str] = [root.name + "/"]

        def _walk(dir_path: pathlib.Path, prefix: str, depth: int) -> None:
            if depth >= max_depth:
                return
            try:
                entries = sorted(dir_path.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
            except OSError:
                return
            entries = [
                e for e in entries
                if (show_hidden or not e.name.startswith("."))
                and e.name not in SKIP
            ]
            for i, entry in enumerate(entries):
                is_last = i == len(entries) - 1
                connector = "└── " if is_last else "├── "
                suffix = "/" if entry.is_dir() else ""
                lines.append(f"{prefix}{connector}{entry.name}{suffix}")
                if entry.is_dir():
                    extension = "    " if is_last else "│   "
                    _walk(entry, prefix + extension, depth + 1)

        _walk(root, "", 0)
        return "\n".join(lines)

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
        # Defensive strip — see _strip_codebase_footer rationale. fs.read no
        # longer emits the footer, but cached strings from the model's prior
        # turns or the read-modify-write loop that triggered the 2026-05-03
        # incident could still arrive here.
        return self._call("write", {"path": path, "content": _strip_codebase_footer(content)})

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
        # Strip on both sides — `old` could match against a footer-laden read
        # output from the pre-fix era, and `new` could carry a footer if the
        # model derived it from such output. See _strip_codebase_footer.
        return self._call("edit", {
            "path": path,
            "old": _strip_codebase_footer(old),
            "new": _strip_codebase_footer(new),
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
        # Strip footer on both old and new of every pair — same rationale as fs.edit.
        return self._call("patch", {
            "path": path,
            "edits": [[_strip_codebase_footer(o), _strip_codebase_footer(n)] for (o, n) in edits],
            "replace_all": replace_all,
        })


    def edit_lines(self, path: str, start: int, end: int, new_content: str) -> dict:
        """
        Replace lines start through end (1-indexed, inclusive) with new_content.

        Unambiguous alternative to edit() for large multi-line replacements
        where exact-string matching is fragile. Use codebase.get_context to
        find line numbers first, then edit_lines to replace the range.

        Args:
            path: file to edit
            start: first line to replace (1-indexed)
            end: last line to replace (1-indexed, inclusive)
            new_content: replacement text (replaces the entire range)

        Returns {ok, path, diff, lines_removed, lines_added}.
        """
        # Strip footer — same rationale as fs.edit / fs.patch.
        return self._call("edit_lines", {
            "path": path,
            "start": start,
            "end": end,
            "new_content": _strip_codebase_footer(new_content),
        })
