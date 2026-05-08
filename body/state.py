"""Durable session-scoped state primitive for the Python body.

`state.*` is the explicit cross-phase handoff contract. Python variables stay
available as fast scratch in the persistent REPL, but planned work should write
handoff values here so later phases and resumed cells can prove the contract
was satisfied.
"""
from __future__ import annotations

import json
import math
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable


_KEY_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _is_json_value(value: Any) -> bool:
    if value is None or isinstance(value, (str, bool, int)):
        return True
    if isinstance(value, float):
        return math.isfinite(value)
    if isinstance(value, list):
        return all(_is_json_value(item) for item in value)
    if isinstance(value, dict):
        return all(isinstance(k, str) and _is_json_value(v) for k, v in value.items())
    return False


def _summary(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "bool"
    if isinstance(value, int) and not isinstance(value, bool):
        return "int"
    if isinstance(value, float):
        return "float"
    if isinstance(value, str):
        return f"str[{len(value)}]"
    if isinstance(value, list):
        return f"list[{len(value)}]"
    if isinstance(value, dict):
        return f"dict[{len(value)}]"
    return type(value).__name__


def _validate_key(key: str) -> str:
    text = str(key)
    if not _KEY_RE.match(text):
        raise ValueError(
            "state key must match [A-Za-z0-9][A-Za-z0-9_.-]{0,127}; "
            "slashes, spaces, and empty keys are not allowed"
        )
    return text


def _validate_prefix(prefix: str) -> str:
    text = str(prefix or "")
    if text == "":
        return text
    if len(text) > 128 or "/" in text or "\\" in text or " " in text:
        raise ValueError("state prefix must be empty or a key prefix without slashes/spaces")
    return text


class State:
    """Small JSON-backed key/value store exposed as `state` in the REPL."""

    def __init__(
        self,
        state_dir: Callable[[], str | None],
        project_root: Callable[[], str | None] | None = None,
    ):
        self._state_dir = state_dir
        self._project_root = project_root or (lambda: None)
        self._events: list[dict[str, Any]] = []

    def configure(self, state_dir: str | None) -> None:
        if state_dir:
            self._dir(explicit=state_dir).mkdir(parents=True, exist_ok=True)

    def put(self, key: str, value: Any, note: str = "") -> dict[str, Any]:
        """Persist a JSON value under `key` and return its receipt."""
        k = _validate_key(key)
        if not _is_json_value(value):
            raise TypeError("state.put only accepts JSON values: dict/list/str/int/float/bool/None")
        # json.dumps with allow_nan=False is the final guard for finite JSON.
        json.dumps(value, allow_nan=False)
        doc = self._load()
        doc.setdefault("values", {})[k] = value
        receipt = {
            "key": k,
            "summary": _summary(value),
            "note": str(note or ""),
            "updated_at": _now(),
        }
        doc.setdefault("receipts", {})[k] = receipt
        self._save(doc)
        event = {"type": "state_put", "key": k, "receipt": receipt}
        self._events.append({"timestamp": _now(), **event})
        return {"ok": True, **receipt}

    def get(self, key: str, default: Any = None) -> Any:
        """Return a stored value, or `default` when the key is absent."""
        k = _validate_key(key)
        return self._load().get("values", {}).get(k, default)

    def has(self, key: str) -> bool:
        """Return whether `key` exists in session state."""
        k = _validate_key(key)
        return k in self._load().get("values", {})

    def list(self, prefix: str = "") -> list[str]:
        """Return stored keys, optionally filtered by prefix."""
        p = _validate_prefix(prefix)
        keys = sorted(self._load().get("values", {}).keys())
        return [k for k in keys if k.startswith(p)]

    def delete(self, key: str) -> dict[str, Any]:
        """Delete `key` from state if present."""
        k = _validate_key(key)
        doc = self._load()
        existed = k in doc.get("values", {})
        doc.setdefault("values", {}).pop(k, None)
        doc.setdefault("receipts", {}).pop(k, None)
        self._save(doc)
        self._events.append({
            "type": "state_delete",
            "timestamp": _now(),
            "key": k,
            "deleted": existed,
        })
        return {"ok": True, "key": k, "deleted": existed}

    def receipts(self, prefix: str = "") -> list[dict[str, Any]]:
        """Return compact receipts for stored keys, optionally by prefix."""
        p = _validate_prefix(prefix)
        receipts = self._load().get("receipts", {})
        rows = [dict(v) for k, v in receipts.items() if k.startswith(p)]
        rows.sort(key=lambda row: str(row.get("key", "")))
        return rows

    def status(self) -> dict[str, Any]:
        """Return runtime status for result footers."""
        receipts = self.receipts()
        return {
            "dir": str(self._dir()),
            "count": len(receipts),
            "receipts": receipts,
        }

    def drain_events(self) -> list[dict[str, Any]]:
        events = self._events[:]
        self._events.clear()
        return events

    def _dir(self, explicit: str | None = None) -> Path:
        configured = explicit or self._state_dir()
        if configured:
            return Path(configured).resolve()
        root = Path(self._project_root() or ".").resolve()
        return root / ".aries" / "state"

    def _path(self) -> Path:
        return self._dir() / "state.json"

    def _load(self) -> dict[str, Any]:
        path = self._path()
        if not path.exists():
            return {"values": {}, "receipts": {}}
        try:
            doc = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {"values": {}, "receipts": {}}
        if not isinstance(doc, dict):
            return {"values": {}, "receipts": {}}
        values = doc.get("values") if isinstance(doc.get("values"), dict) else {}
        receipts = doc.get("receipts") if isinstance(doc.get("receipts"), dict) else {}
        return {"values": values, "receipts": receipts}

    def _save(self, doc: dict[str, Any]) -> None:
        path = self._path()
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(doc, ensure_ascii=True, sort_keys=True, indent=2), encoding="utf-8")
        tmp.replace(path)
