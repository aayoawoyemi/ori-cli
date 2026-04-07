"""
Ori vault proxy — routes all vault calls through the TS bridge.

Instead of spawning its own `ori-memory serve --mcp` process, this proxy
writes vault_request messages to stdout and blocks until the TS bridge
calls the single TS-owned Ori MCP and sends vault_response back via stdin.

This ensures one Ori engine instance per CLI session — all Q-value updates,
co-occurrence learning, and stage-learner training happen in one place.
"""
from __future__ import annotations

import json
import sys
import threading
from typing import Optional, Any


class VaultError(Exception):
    pass


# ---------- Markdown parsers (for signature rendering) ----------

def _extract_identity_line(identity_md: str) -> str:
    if not identity_md:
        return ""
    import re
    identity_md = re.sub(r"^---\n.*?\n---\n", "", identity_md, count=1, flags=re.DOTALL)
    for line in identity_md.split("\n"):
        stripped = line.strip()
        if not stripped or stripped.startswith("<!--"):
            continue
        if stripped.startswith("#"):
            return stripped.lstrip("# ").strip()[:160]
        if len(stripped) > 20 and not stripped.startswith("-"):
            return stripped[:160]
    return ""


def _extract_goals(goals_md: str, daily_md: str) -> list:
    goals: list = []
    if not goals_md:
        return goals
    lines = goals_md.split("\n")
    in_active = False
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("#"):
            lower = stripped.lower()
            in_active = any(k in lower for k in ("active", "current", "threads", "priorit"))
            continue
        if in_active and stripped.startswith("- "):
            item = stripped.lstrip("- ").strip()
            if item and not item.startswith("[x]"):
                item = item.replace("[ ]", "").replace("[x]", "").strip()
                goals.append(item[:160])
                if len(goals) >= 10:
                    break
    return goals


def _extract_pending_today(daily_md: str) -> str:
    if not daily_md:
        return ""
    import re
    m = re.search(r"##\s*(?:Pending Today|Today)\s*\n(.*?)(?=\n##|\Z)", daily_md, re.DOTALL)
    if m:
        lines: list[str] = []
        for line in m.group(1).strip().split("\n"):
            s = line.strip()
            if s.startswith("- [ ]") or s.startswith("- [x]"):
                lines.append(s)
            elif s and not s.startswith("<!--"):
                lines.append(s)
            if len(lines) >= 10:
                break
        return "\n".join(lines)
    return ""


def _unwrap_data(result: Any) -> Any:
    if isinstance(result, dict) and "success" in result and "data" in result:
        return result["data"]
    return result


# ---------- Vault Proxy ----------

class Vault:
    """
    Vault proxy that routes all calls through the TS bridge.

    Same API as the old Vault class, but instead of owning an MCP subprocess,
    sends vault_request messages to stdout and blocks until vault_response
    arrives on stdin (routed by server.py's main loop).
    """

    def __init__(self, vault_path: str):
        self._path = vault_path
        self._connected = False
        self._request_id = 0
        self._pending: dict[int, dict[str, Any]] = {}
        self._lock = threading.Lock()
        self._stdout_lock = threading.Lock()

    @property
    def path(self) -> str:
        return self._path

    @property
    def connected(self) -> bool:
        return self._connected

    def connect(self, timeout: float = 10.0) -> None:
        # No MCP spawn — TS owns the connection. Just mark as ready.
        self._connected = True

    def disconnect(self) -> None:
        self._connected = False

    def resolve(self, request_id: int, result: Any) -> None:
        """Called by server.py main loop when vault_response arrives from TS."""
        with self._lock:
            if request_id in self._pending:
                self._pending[request_id]["result"] = result
                self._pending[request_id]["event"].set()

    def _next_id(self) -> int:
        self._request_id += 1
        return self._request_id

    def _require(self):
        if not self._connected:
            raise VaultError("vault not connected")

    def _call(self, method: str, args: dict, timeout: float = 30.0) -> Any:
        """Send vault_request via stdout, block until vault_response on stdin."""
        self._require()
        req_id = self._next_id()
        event = threading.Event()

        with self._lock:
            self._pending[req_id] = {"event": event, "result": None}

        # Write request to stdout — TS bridge intercepts this
        msg = json.dumps({"vault_request": {"id": req_id, "method": method, "args": args}})
        with self._stdout_lock:
            # Write to the REAL stdout (not the captured one during exec)
            sys.__stdout__.write(msg + "\n")
            sys.__stdout__.flush()

        # Block until response arrives
        if not event.wait(timeout=timeout):
            with self._lock:
                self._pending.pop(req_id, None)
            raise VaultError(f"vault call timed out: {method}")

        with self._lock:
            entry = self._pending.pop(req_id)
            result = entry["result"]

        if isinstance(result, dict) and "error" in result:
            raise VaultError(f"vault error: {result['error']}")

        return result

    # -------- Retrieval --------

    def query_ranked(self, query: str, limit: int = 10, include_archived: bool = False) -> dict:
        return _unwrap_data(self._call("ori_query_ranked", {
            "query": query, "limit": limit, "include_archived": include_archived,
        }))

    def query_similar(self, query: str, limit: int = 10, include_archived: bool = False) -> dict:
        return _unwrap_data(self._call("ori_query_similar", {
            "query": query, "limit": limit, "include_archived": include_archived,
        }))

    def query_warmth(self, query: str, limit: int = 10) -> dict:
        return _unwrap_data(self._call("ori_warmth", {
            "query": query, "limit": limit,
        }))

    def query_important(self, limit: int = 10) -> dict:
        return _unwrap_data(self._call("ori_query_important", {
            "limit": limit,
        }))

    def query_fading(self, limit: int = 10, include_archived: bool = False) -> dict:
        return _unwrap_data(self._call("ori_query_fading", {
            "limit": limit, "include_archived": include_archived,
        }))

    def explore(self, query: str, depth: int = 2, limit: int = 15,
                recursive: bool = True, include_content: bool = True) -> dict:
        return _unwrap_data(self._call("ori_explore", {
            "query": query, "depth": depth, "limit": limit,
            "recursive": recursive, "include_content": include_content,
        }, timeout=60.0))

    # -------- Introspection --------

    def orient(self, brief: bool = True) -> dict:
        return _unwrap_data(self._call("ori_orient", {"brief": brief}))

    def status(self) -> dict:
        return _unwrap_data(self._call("ori_status", {}))

    # -------- Writes --------

    def add(self, title: str, content: Optional[str] = None, type: str = "insight") -> dict:
        args: dict = {"title": title, "type": type}
        if content is not None:
            args["content"] = content
        return _unwrap_data(self._call("ori_add", args))

    # -------- Ambient Signature Compilation --------

    SCHEMA_VERSION = "0.1.0"

    LEVEL_CONFIG: dict = {
        "lean": {
            "authorities": 3, "fading": 0,
            "include_stats": True, "include_identity": True,
            "include_goals": True, "include_orient_summary": False,
        },
        "standard": {
            "authorities": 7, "fading": 0,
            "include_stats": True, "include_identity": True,
            "include_goals": True, "include_orient_summary": True,
        },
        "deep": {
            "authorities": 12, "fading": 5,
            "include_stats": True, "include_identity": True,
            "include_goals": True, "include_orient_summary": True,
        },
        "max": {
            "authorities": 20, "fading": 8,
            "include_stats": True, "include_identity": True,
            "include_goals": True, "include_orient_summary": True,
        },
    }

    def signature(self, level: str = "standard", max_tokens: int = 1500) -> dict:
        self._require()
        if level not in self.LEVEL_CONFIG:
            level = "standard"
        cfg = self.LEVEL_CONFIG[level]

        status_data = {}
        if cfg["include_stats"]:
            try:
                status_data = self.status() or {}
            except Exception:
                status_data = {}

        authority_notes = []
        try:
            imp_result = self.query_important(limit=cfg["authorities"])
            if isinstance(imp_result, dict):
                authority_notes = imp_result.get("results", [])
        except Exception:
            authority_notes = []

        fading_notes = []
        if cfg["fading"] > 0:
            try:
                fading_result = self.query_fading(limit=cfg["fading"])
                if isinstance(fading_result, dict):
                    fading_notes = fading_result.get("results", [])
            except Exception:
                fading_notes = []

        orient_summary = ""
        active_goals: list = []
        identity_line = ""
        if cfg["include_orient_summary"]:
            try:
                orient_data = self.orient(brief=False)
                if isinstance(orient_data, dict):
                    identity_line = _extract_identity_line(orient_data.get("identity", ""))
                    active_goals = _extract_goals(orient_data.get("goals", ""), orient_data.get("daily", ""))
                    orient_summary = _extract_pending_today(orient_data.get("daily", ""))
            except Exception:
                pass

        signature = {
            "level": level,
            "schema_version": self.SCHEMA_VERSION,
            "vault_path": self._path,
            "stats": {
                "note_count": status_data.get("noteCount"),
                "inbox_count": status_data.get("inboxCount"),
                "orphan_count": status_data.get("orphanCount"),
            },
            "identity_line": identity_line,
            "orient_summary": orient_summary,
            "active_goals": active_goals[: 5 if level == "lean" else 15],
            "authority_notes": [
                {
                    "title": n.get("title", ""),
                    "score": round(n.get("score", 0.0), 4) if isinstance(n.get("score"), (int, float)) else 0,
                    "type": n.get("type", ""),
                }
                for n in authority_notes
            ],
            "fading_notes": [
                {
                    "title": n.get("title", ""),
                    "vitality": round(n.get("vitality", 0.0), 4) if isinstance(n.get("vitality"), (int, float)) else 0,
                }
                for n in fading_notes
            ],
        }

        md = self._render_markdown(signature)
        while len(md) > max_tokens * 4 and len(signature["fading_notes"]) > 0:
            signature["fading_notes"] = signature["fading_notes"][:-1]
            md = self._render_markdown(signature)
        while len(md) > max_tokens * 4 and len(signature["authority_notes"]) > 3:
            signature["authority_notes"] = signature["authority_notes"][:-1]
            md = self._render_markdown(signature)
        while len(md) > max_tokens * 4 and len(signature["active_goals"]) > 2:
            signature["active_goals"] = signature["active_goals"][:-1]
            md = self._render_markdown(signature)

        signature["markdown"] = md
        signature["approx_tokens"] = len(md) // 4
        return signature

    def _render_markdown(self, sig: dict) -> str:
        lines = []
        s = sig["stats"]
        if s.get("note_count") is not None:
            lines.append(
                f"# Vault: {s['note_count']} notes, {s.get('inbox_count', 0)} inbox, {s.get('orphan_count', 0)} orphans"
            )
        else:
            lines.append(f"# Vault: {sig['vault_path']}")
        lines.append("")

        if sig.get("identity_line"):
            lines.append(f"**Identity:** {sig['identity_line'][:200]}")
            lines.append("")

        if sig.get("active_goals"):
            lines.append("## Active Goals")
            for g in sig["active_goals"]:
                if isinstance(g, dict):
                    title = g.get("title", "") or g.get("text", "") or str(g)
                    status = g.get("status", "")
                    status_part = f" ({status})" if status else ""
                    lines.append(f"- {title[:120]}{status_part}")
                elif isinstance(g, str):
                    lines.append(f"- {g[:120]}")
            lines.append("")

        if sig.get("authority_notes"):
            lines.append("## Authority Notes (most-connected)")
            for n in sig["authority_notes"]:
                type_part = f" [{n['type']}]" if n.get("type") else ""
                lines.append(f"- {n['title'][:100]}{type_part}")
            lines.append("")

        if sig.get("fading_notes"):
            lines.append("## Fading (needs revisit)")
            for n in sig["fading_notes"]:
                lines.append(f"- {n['title'][:100]} (vitality: {n['vitality']})")
            lines.append("")

        if sig.get("orient_summary") and len(sig["orient_summary"]) > 0:
            summary = sig["orient_summary"][:600]
            lines.append("## Today")
            lines.append(summary)

        return "\n".join(lines).rstrip()
