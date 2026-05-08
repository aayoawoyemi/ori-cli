"""Body version + content hash + git sha.

Computed once at body startup (cached at module import). The ping op surfaces
this in its response so the TS bridge can detect when the running body
subprocess is stale (source files modified after body started).

Why this exists: body/server.py and friends run as a long-lived Python
subprocess spawned by the CLI. Source edits don't hot-reload — the running
process keeps its old code until the CLI restarts. Until 2026-05-08 there
was no signal in the UI that body and source had drifted. The recent dogfood
that ran the planned-phase composition wall transcript may have been against
a stale body subprocess (pre-wall code), which the user couldn't tell.

The fix: compute and surface a fingerprint of the loaded source. Bridge
compares against the on-disk source's fingerprint; mismatch → "body: stale,
restart required" badge in the status bar.

Fields:
  - version: human-readable string. Pulled from package.json if reachable
    from the body's location, else falls back to a hardcoded default.
  - sha: git rev-parse HEAD if a .git/ exists at the repo root, else "".
    Captures repo-level provenance. Coarser than content_hash but useful
    cross-machine.
  - content_hash: SHA-256 over the canonical-sorted contents of every .py
    file under body/. This is the load-bearing field for drift detection.
    Any source edit to body/*.py changes this hash.
  - started_at: ISO-8601 UTC timestamp of when this module was imported,
    which is effectively when the body subprocess started. Used to compare
    against on-disk source mtimes.
"""
from __future__ import annotations

import hashlib
import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path


_BODY_DIR = Path(__file__).resolve().parent
_REPO_ROOT = _BODY_DIR.parent


def _read_package_version() -> str:
    """Read version from package.json. Falls back to a known default."""
    pkg = _REPO_ROOT / "package.json"
    try:
        data = json.loads(pkg.read_text(encoding="utf-8"))
        version = data.get("version")
        if isinstance(version, str) and version:
            return version
    except (OSError, json.JSONDecodeError):
        pass
    return "0.2.0-single-mcp"


def _git_sha() -> str:
    """Return short git sha for HEAD, or empty string if unavailable.

    We don't error on missing git — body must boot in environments without
    git history (npm-installed CLI, sandboxed runners, etc.).
    """
    try:
        out = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=str(_REPO_ROOT),
            capture_output=True,
            text=True,
            timeout=2,
            check=False,
        )
        if out.returncode == 0:
            return out.stdout.strip()
    except (FileNotFoundError, subprocess.SubprocessError, OSError):
        pass
    return ""


def _content_hash() -> str:
    """SHA-256 over body/*.py source contents (sorted by posix relpath).

    Sort order matters: it's the canonical key. Sorted explicitly by posix
    relative path (forward slashes, case-sensitive) so Python and the TS
    bridge port produce identical hashes regardless of OS path conventions.
    Any change to any body/*.py file flips the hash. Subdirectories are
    included recursively. Skips __pycache__ and .pyc files.
    """
    h = hashlib.sha256()
    files: list[tuple[str, Path]] = []
    for p in _BODY_DIR.rglob("*.py"):
        if "__pycache__" in p.parts:
            continue
        rel = p.relative_to(_BODY_DIR).as_posix()
        files.append((rel, p))
    files.sort(key=lambda pair: pair[0])
    for rel, path in files:
        h.update(rel.encode("utf-8"))
        h.update(b"\0")
        try:
            h.update(path.read_bytes())
        except OSError:
            # Unreadable source file should be loud, not silent. The hash
            # will skip its content but the rel name still updates the
            # hash — so disappearance/appearance of the file is detected.
            h.update(b"<unreadable>")
        h.update(b"\0\0")
    return h.hexdigest()[:16]


def _started_at() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# Computed once at module import. The ping op returns these fields so the
# bridge can compare against the on-disk source state and detect drift.
VERSION: str = _read_package_version()
SHA: str = _git_sha()
CONTENT_HASH: str = _content_hash()
STARTED_AT: str = _started_at()


def info() -> dict:
    """Return body version info for inclusion in ping responses."""
    return {
        "version": VERSION,
        "sha": SHA,
        "content_hash": CONTENT_HASH,
        "started_at": STARTED_AT,
    }
