"""Request-scoped composition scratch — the substrate for the compose sub-loop.

A temporary markdown file the model uses as its working notebook for ONE
top-level user request. Created when the harness routes a request to compose
mode; deleted when the request loop ends or the session shuts down.

Why this exists: every advisory-prompt rule in Aries history has failed
(Loop2 corrective prose, the earlier wall prose, the current `#goal` system
prompt). Every visibility-based mechanism has worked (smolagents transcript
replay → 0% to 47% reuse, state.* receipts in footer). The scratch is the
next clean application of "the model adapts to what it SEES every turn, not
what it was TOLD once at session start." The file lands in the model's
context every turn during compose mode (Tier 4); the model can't ignore it.

Scope:
  - Per-request (one file per top-level user message)
  - Auto-deleted on terminal events (done committed, error, max_turns, abort)
  - Sweeper deletes orphans older than 24h as belt-and-suspenders cleanup
  - Path: <project>/.aries/tmp/requests/<session_id>-<request_id>.md

Lifecycle:
  - Harness calls scratch.start(intent, user_request, mode) when compose
    mode is selected for a new request. File is written with the template
    + pre-filled User request and Mode sections.
  - Model can append/set sections via scratch.append(section, text) or
    scratch.set(section, text). The harness in Tier 3 will also write to
    Findings via parsed <compose_update> blocks, and to Next Repl preflight
    via parsed <compose_preflight> blocks.
  - Harness calls scratch.close() when the request loop terminates. File
    is unlinked. Idempotent.

The model can also call these primitives directly via the namespace, which
is intentional: the harness drives the typical flow but the model can take
explicit control when needed (e.g., to reset the scratch mid-request, to
record a finding the harness wouldn't catch).
"""
from __future__ import annotations

import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable


# Section names recognized by append/set. The model can write to any of these;
# unknown section names are rejected so we don't silently accumulate junk.
KNOWN_SECTIONS: tuple[str, ...] = (
    "interpretation",
    "plan",
    "preflight",
    "findings",
    "verification",
    "repair",
    "final",
)

# Section render order in the .md file. The User request and Mode sections
# are pre-filled at start() and never written to via append/set — they're
# header metadata, not working sections.
SECTION_ORDER: tuple[str, ...] = (
    "interpretation",  # what I think the user wants, ambiguities
    "plan",            # loose 1-4 stage outline
    "preflight",       # latest <compose_preflight> block (overwritten each cell)
    "findings",        # append-only log of <compose_update> entries
    "verification",    # filled when applicable
    "repair",          # filled only when verification fails
    "final",           # final answer readiness check
)

# Human-readable display names for the section headings.
SECTION_DISPLAY: dict[str, str] = {
    "interpretation": "Interpretation",
    "plan": "Working plan",
    "preflight": "Next Repl preflight",
    "findings": "Findings",
    "verification": "Verification",
    "repair": "Repair",
    "final": "Final answer readiness",
}

FINAL_READINESS_TEMPLATE = """Completion audit before final done(value):
- Restate the objective as concrete deliverables or success criteria.
- Map every explicit requirement, named file, command, test, gate, and deliverable to concrete evidence.
- Inspect current files, command output, test results, runtime state, or other real evidence for each item.
- Check that each passing test, verifier, manifest, or green status covers the requirement it is being used as evidence for.
- List missing, incomplete, weakly verified, or uncovered requirements.
- If anything is missing or uncertain, continue with verify or repair work before finalizing."""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _sanitize_id(value: str, fallback: str = "anon") -> str:
    """Strip a value down to safe filename characters."""
    cleaned = re.sub(r"[^A-Za-z0-9_.-]", "_", str(value or "").strip())
    return cleaned[:64] or fallback


def _initial_template(intent: str, user_request: str, mode: str) -> str:
    """Return the starter markdown body. Sections are present but mostly empty."""
    lines = [
        "# Request Scratch",
        "",
        f"- intent: {intent.strip() or '(none)'}",
        f"- mode: {mode.strip() or 'compose'}",
        f"- created_at: {_now()}",
        "",
        "## User request",
        user_request.strip() or "(empty)",
        "",
    ]
    for section in SECTION_ORDER:
        lines.append(f"## {SECTION_DISPLAY[section]}")
        lines.append(FINAL_READINESS_TEMPLATE if section == "final" else "")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def _parse_sections(text: str) -> dict[str, str]:
    """Best-effort split of the file into section bodies keyed by section name."""
    out: dict[str, str] = {}
    if not text:
        return out
    # Map display name (lowercased) → key
    display_to_key = {SECTION_DISPLAY[k].lower(): k for k in SECTION_ORDER}
    current_key: str | None = None
    buffer: list[str] = []
    for line in text.splitlines():
        m = re.match(r"^##\s+(.+?)\s*$", line)
        if m:
            if current_key is not None:
                out[current_key] = "\n".join(buffer).strip()
            heading = m.group(1).strip().lower()
            current_key = display_to_key.get(heading)
            buffer = []
            continue
        if current_key is not None:
            buffer.append(line)
    if current_key is not None:
        out[current_key] = "\n".join(buffer).strip()
    return out


def _render(intent: str, user_request: str, mode: str, sections: dict[str, str]) -> str:
    """Render the file from header metadata + section bodies."""
    lines = [
        "# Request Scratch",
        "",
        f"- intent: {intent.strip() or '(none)'}",
        f"- mode: {mode.strip() or 'compose'}",
        "",
        "## User request",
        user_request.strip() or "(empty)",
        "",
    ]
    for section in SECTION_ORDER:
        lines.append(f"## {SECTION_DISPLAY[section]}")
        body = sections.get(section, "").strip()
        lines.append(body if body else "")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


class Scratch:
    """Per-request scratch markdown file. Bound as `scratch` in the namespace.

    All paths are computed from project_root + session_id + request_id, all
    of which are passed in by the harness via configure(). The model never
    needs to think about paths — scratch.* primitives just work once the
    harness has configured the session.
    """

    def __init__(
        self,
        project_root_fn: Callable[[], str | None],
        session_id_fn: Callable[[], str | None],
        request_id_fn: Callable[[], str | None],
    ):
        self._project_root = project_root_fn
        self._session_id = session_id_fn
        self._request_id = request_id_fn
        self._intent: str = ""
        self._mode: str = "compose"
        self._user_request: str = ""
        self._events: list[dict[str, Any]] = []

    # ── Lifecycle ───────────────────────────────────────────────────────

    def start(self, intent: str, user_request: str = "", mode: str = "compose") -> dict:
        """Create the scratch file with the given intent + verbatim user request.

        Idempotent: if the path already exists, the file is overwritten with
        a fresh template (any prior content is discarded). The harness calls
        this once per compose-mode request before the agent loop begins.
        """
        path = self._path()
        if path is None:
            return {"error": "scratch.start: no session_id/request_id configured"}
        path.parent.mkdir(parents=True, exist_ok=True)
        self._intent = str(intent).strip()
        self._user_request = str(user_request).strip()
        self._mode = str(mode).strip() or "compose"
        body = _initial_template(self._intent, self._user_request, self._mode)
        self._atomic_write(path, body)
        self._emit("scratch_started", path=str(path), intent=self._intent, mode=self._mode)
        return {"ok": True, "path": str(path), "intent": self._intent, "mode": self._mode}

    def close(self) -> dict:
        """Unlink the scratch file. Idempotent — no-op if no scratch exists."""
        path = self._path()
        existed = bool(path and path.exists())
        if path and existed:
            try:
                path.unlink()
            except OSError:
                pass
        self._emit("scratch_closed", path=str(path) if path else None, existed=existed)
        return {"ok": True, "existed": existed, "path": str(path) if path else None}

    # ── Read ────────────────────────────────────────────────────────────

    def status(self) -> dict:
        """Return the current scratch state. Useful for the runtime footer."""
        path = self._path()
        active = bool(path and path.exists())
        if not active:
            return {"active": False}
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            return {"active": False, "error": "unreadable"}
        sections = _parse_sections(text)
        filled = [k for k in SECTION_ORDER if sections.get(k)]
        return {
            "active": True,
            "path": str(path),
            "intent": self._intent,
            "mode": self._mode,
            "char_count": len(text),
            "sections_filled": filled,
            "sections_empty": [k for k in SECTION_ORDER if k not in filled],
        }

    def read(self) -> str:
        """Return the full current scratch contents, or empty string if absent."""
        path = self._path()
        if not path or not path.exists():
            return ""
        try:
            return path.read_text(encoding="utf-8")
        except OSError:
            return ""

    # ── Write ───────────────────────────────────────────────────────────

    def append(self, section: str, text: str) -> dict:
        """Append a line/paragraph to a section. Section must be in KNOWN_SECTIONS.

        Used for append-only logs like Findings — every <compose_update>
        adds an entry rather than overwriting. The appended text is prefixed
        with a timestamp marker so the temporal sequence is visible.
        """
        return self._mutate(section, text, mode="append")

    def set(self, section: str, text: str) -> dict:
        """Replace a section's contents. For sections that should hold the
        latest value rather than accumulating (e.g. preflight = next-cell-draft,
        which is overwritten on each new <compose_preflight> block).
        """
        return self._mutate(section, text, mode="set")

    def _mutate(self, section: str, text: str, mode: str) -> dict:
        if section not in KNOWN_SECTIONS:
            return {
                "error": f"scratch.{mode}: unknown section '{section}'; "
                         f"valid: {', '.join(KNOWN_SECTIONS)}",
            }
        path = self._path()
        if path is None:
            return {"error": f"scratch.{mode}: no session_id/request_id configured"}
        if not path.exists():
            return {"error": f"scratch.{mode}: no active scratch; call scratch.start(...) first"}
        try:
            existing = path.read_text(encoding="utf-8")
        except OSError as e:
            return {"error": f"scratch.{mode}: cannot read scratch: {e}"}
        sections = _parse_sections(existing)
        addition = str(text).strip()
        if mode == "append":
            ts = _now()
            entry = f"- [{ts}] {addition}" if addition else ""
            existing_body = sections.get(section, "").strip()
            sections[section] = (existing_body + ("\n" if existing_body and entry else "") + entry).strip()
        else:  # set
            sections[section] = addition
        new_body = _render(self._intent, self._user_request, self._mode, sections)
        self._atomic_write(path, new_body)
        self._emit(f"scratch_{mode}", section=section, chars=len(addition))
        return {"ok": True, "section": section, "mode": mode, "path": str(path)}

    # ── Telemetry ───────────────────────────────────────────────────────

    def drain_events(self) -> list[dict]:
        events = self._events[:]
        self._events.clear()
        return events

    def _emit(self, event_type: str, **data: Any) -> None:
        self._events.append({"type": event_type, "timestamp": _now(), **data})

    # ── Paths ───────────────────────────────────────────────────────────

    def _path(self) -> Path | None:
        root = self._project_root() or ""
        sid = self._session_id() or ""
        rid = self._request_id() or ""
        if not root or not sid or not rid:
            return None
        sid_safe = _sanitize_id(sid, "sess")
        rid_safe = _sanitize_id(rid, "req")
        return Path(root).resolve() / ".aries" / "tmp" / "requests" / f"{sid_safe}-{rid_safe}.md"

    def _atomic_write(self, path: Path, body: str) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_text(body, encoding="utf-8")
        tmp.replace(path)


def sweep_orphan_scratches(project_root: str, max_age_hours: float = 24.0) -> int:
    """Delete scratch files older than max_age_hours. Returns count deleted.

    Belt-and-suspenders cleanup for sessions that crashed without normal
    teardown (kill -9, OS reboot, etc.). The harness registers this as an
    onCleanupSync hook in src/lifecycle.ts so it fires on every clean exit
    too — costless when the requests dir is empty.
    """
    requests_dir = Path(project_root).resolve() / ".aries" / "tmp" / "requests"
    if not requests_dir.exists():
        return 0
    cutoff = datetime.now(timezone.utc).timestamp() - (max_age_hours * 3600)
    deleted = 0
    for path in requests_dir.glob("*.md"):
        try:
            if path.stat().st_mtime < cutoff:
                path.unlink()
                deleted += 1
        except OSError:
            pass
    return deleted
