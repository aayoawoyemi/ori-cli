"""
Ori vault Python wrapper.

Spawns `ori serve --mcp --vault <path>` and speaks JSON-RPC 2.0 over stdio.
Exposes a Vault object with methods that call Ori's MCP tools:
  - query_ranked, query_similar, query_warmth, query_important, query_fading
  - explore (deep PPR graph traversal)
  - add (inbox write)
  - orient (session briefing)
  - status (health)

This is the `vault` object in the REPL namespace. Same pattern as codebase:
structured Python API calls, no JSON tool calls from the model.
"""
from __future__ import annotations

import json
import subprocess
import threading
import time
from typing import Optional, Any


class VaultError(Exception):
    pass


class _McpClient:
    """JSON-RPC 2.0 client for Ori MCP server over stdio."""

    def __init__(self):
        self._proc: Optional[subprocess.Popen] = None
        self._request_id = 0
        self._pending: dict[int, dict[str, Any]] = {}
        self._lock = threading.Lock()
        self._cv = threading.Condition(self._lock)
        self._reader_thread: Optional[threading.Thread] = None
        self._closed = False

    def connect(self, vault_path: str, timeout: float = 10.0) -> None:
        """Spawn ori MCP server and complete the initialize handshake."""
        # On Windows, 'ori' is a .cmd shim — use shell=True to resolve it
        is_windows = subprocess.os.name == "nt"
        self._proc = subprocess.Popen(
            ["ori-memory", "serve", "--mcp", "--vault", vault_path],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            bufsize=1,  # line-buffered
            shell=is_windows,
        )
        # Start reader thread
        self._reader_thread = threading.Thread(target=self._reader_loop, daemon=True)
        self._reader_thread.start()

        # Send initialize handshake
        init_result = self._call("initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "ori-cli-body", "version": "0.1.0"},
        }, timeout=timeout)
        if init_result is None:
            raise VaultError("initialize handshake failed (no response)")

        # Send initialized notification (no response expected)
        self._notify("notifications/initialized", {})

    def _reader_loop(self):
        """Read JSON-RPC responses from stdout, dispatch to pending callers."""
        assert self._proc and self._proc.stdout
        for line in self._proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            req_id = msg.get("id")
            if req_id is None:
                continue
            with self._cv:
                if req_id in self._pending:
                    self._pending[req_id]["response"] = msg
                    self._cv.notify_all()
        # Process died — wake everyone up
        with self._cv:
            for p in self._pending.values():
                if "response" not in p:
                    p["response"] = {"error": {"message": "MCP process exited"}}
            self._cv.notify_all()
            self._closed = True

    def _next_id(self) -> int:
        self._request_id += 1
        return self._request_id

    def _call(self, method: str, params: dict, timeout: float = 30.0) -> Any:
        """Send a JSON-RPC call and wait for response."""
        if not self._proc or not self._proc.stdin or self._closed:
            raise VaultError("vault not connected")
        req_id = self._next_id()
        req = {"jsonrpc": "2.0", "id": req_id, "method": method, "params": params}
        with self._cv:
            self._pending[req_id] = {}
        try:
            self._proc.stdin.write(json.dumps(req) + "\n")
            self._proc.stdin.flush()
        except (BrokenPipeError, OSError) as e:
            raise VaultError(f"failed to write MCP request: {e}")

        deadline = time.time() + timeout
        with self._cv:
            while "response" not in self._pending[req_id]:
                remaining = deadline - time.time()
                if remaining <= 0:
                    del self._pending[req_id]
                    raise VaultError(f"MCP call timed out: {method}")
                self._cv.wait(timeout=remaining)
            response = self._pending.pop(req_id)["response"]

        if "error" in response:
            raise VaultError(f"MCP error: {response['error'].get('message', 'unknown')}")
        return response.get("result")

    def _notify(self, method: str, params: dict) -> None:
        """Send a JSON-RPC notification (no id, no response expected)."""
        if not self._proc or not self._proc.stdin:
            return
        req = {"jsonrpc": "2.0", "method": method, "params": params}
        try:
            self._proc.stdin.write(json.dumps(req) + "\n")
            self._proc.stdin.flush()
        except (BrokenPipeError, OSError):
            pass

    def call_tool(self, name: str, arguments: dict, timeout: float = 30.0) -> Any:
        """Call a tool via tools/call and unwrap MCP content wrapping."""
        result = self._call("tools/call", {"name": name, "arguments": arguments}, timeout=timeout)
        # MCP wraps tool responses in content: [{type: "text", text: json_str}]
        if isinstance(result, dict) and "content" in result:
            content = result["content"]
            if isinstance(content, list) and content and "text" in content[0]:
                try:
                    return json.loads(content[0]["text"])
                except json.JSONDecodeError:
                    return content[0]["text"]
        return result

    def disconnect(self) -> None:
        """Close stdin → EOF → triggers Ori flushSession → process exits."""
        if self._proc:
            try:
                if self._proc.stdin:
                    self._proc.stdin.close()
            except Exception:
                pass
            # Give Ori up to 2s to flush, then kill
            try:
                self._proc.wait(timeout=2.0)
            except subprocess.TimeoutExpired:
                self._proc.kill()
            self._proc = None
            self._closed = True

    def is_alive(self) -> bool:
        return self._proc is not None and self._proc.poll() is None


# ---------- Markdown parsers (for orient output) ----------

def _extract_identity_line(identity_md: str) -> str:
    """Pull the first meaningful line/heading from identity markdown."""
    if not identity_md:
        return ""
    import re
    # Remove frontmatter if present
    identity_md = re.sub(r"^---\n.*?\n---\n", "", identity_md, count=1, flags=re.DOTALL)
    for line in identity_md.split("\n"):
        stripped = line.strip()
        if not stripped or stripped.startswith("<!--"):
            continue
        # Heading lines
        if stripped.startswith("#"):
            return stripped.lstrip("# ").strip()[:160]
        # First prose line that's not an instruction
        if len(stripped) > 20 and not stripped.startswith("-"):
            return stripped[:160]
    return ""


def _extract_goals(goals_md: str, daily_md: str) -> list:
    """Pull active threads from goals.md. Returns empty if no structured goals found."""
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
    """Extract the Pending Today section from daily.md."""
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


# ---------- Vault API ----------

def _unwrap_data(result: Any) -> Any:
    """
    Ori tool responses often wrap actual data:
      {"success": true, "data": {...}, "warnings": [...]}
    Peel that off so callers get the payload directly.
    """
    if isinstance(result, dict) and "success" in result and "data" in result:
        return result["data"]
    return result


class Vault:
    """
    The `vault` object exposed in the REPL namespace.

    Methods correspond to Ori MCP tools — same primitives, Pythonic names.
    All methods return Python dicts/lists (not MCP wrapping, not JSON strings).
    """

    def __init__(self, vault_path: str):
        self._path = vault_path
        self._client = _McpClient()
        self._connected = False

    @property
    def path(self) -> str:
        return self._path

    @property
    def connected(self) -> bool:
        return self._connected

    def connect(self, timeout: float = 10.0) -> None:
        self._client.connect(self._path, timeout=timeout)
        self._connected = True

    def disconnect(self) -> None:
        self._client.disconnect()
        self._connected = False

    def _require(self):
        if not self._connected:
            raise VaultError("vault not connected")

    # -------- Retrieval --------

    def query_ranked(self, query: str, limit: int = 10, include_archived: bool = False) -> dict:
        """Full RRF-fused ranked retrieval with Q-value reranking."""
        self._require()
        return _unwrap_data(self._client.call_tool("ori_query_ranked", {
            "query": query, "limit": limit, "include_archived": include_archived,
        }))

    def query_similar(self, query: str, limit: int = 10, include_archived: bool = False) -> dict:
        """Composite vector search (semantic + metadata, single-signal)."""
        self._require()
        return _unwrap_data(self._client.call_tool("ori_query_similar", {
            "query": query, "limit": limit, "include_archived": include_archived,
        }))

    def query_warmth(self, query: str, limit: int = 10) -> dict:
        """Warmth-weighted retrieval (recency × access × echo)."""
        self._require()
        return _unwrap_data(self._client.call_tool("ori_query_warmth", {
            "query": query, "limit": limit,
        }))

    def query_important(self, limit: int = 10) -> dict:
        """PageRank ranking of notes by structural authority."""
        self._require()
        return _unwrap_data(self._client.call_tool("ori_query_important", {
            "limit": limit,
        }))

    def query_fading(self, limit: int = 10, include_archived: bool = False) -> dict:
        """Notes losing vitality (candidates for revisit or archive)."""
        self._require()
        return _unwrap_data(self._client.call_tool("ori_query_fading", {
            "limit": limit, "include_archived": include_archived,
        }))

    def explore(
        self,
        query: str,
        depth: int = 2,
        limit: int = 15,
        recursive: bool = True,
        include_content: bool = True,
    ) -> dict:
        """Deep PPR graph traversal (propagates through wiki-links)."""
        self._require()
        return _unwrap_data(self._client.call_tool("ori_explore", {
            "query": query,
            "depth": depth,
            "limit": limit,
            "recursive": recursive,
            "include_content": include_content,
        }, timeout=60.0))

    # -------- Introspection --------

    def orient(self, brief: bool = True) -> dict:
        """Session briefing — daily status, goals, health."""
        self._require()
        return _unwrap_data(self._client.call_tool("ori_orient", {"brief": brief}))

    def status(self) -> dict:
        """Vault health: note count, inbox, orphans."""
        self._require()
        return _unwrap_data(self._client.call_tool("ori_status", {}))

    # -------- Writes --------

    def add(self, title: str, content: Optional[str] = None, type: str = "insight") -> dict:
        """Create a note in inbox."""
        self._require()
        args: dict = {"title": title, "type": type}
        if content is not None:
            args["content"] = content
        return _unwrap_data(self._client.call_tool("ori_add", args))

    # -------- Ambient Signature Compilation --------

    SCHEMA_VERSION = "0.1.0"

    LEVEL_CONFIG: dict = {
        "lean": {
            "authorities": 3, "fading": 0,
            "include_stats": True,
            "include_identity": True,
            "include_goals": True,
            "include_orient_summary": False,
        },
        "standard": {
            "authorities": 7, "fading": 0,
            "include_stats": True,
            "include_identity": True,
            "include_goals": True,
            "include_orient_summary": True,
        },
        "deep": {
            "authorities": 12, "fading": 5,
            "include_stats": True,
            "include_identity": True,
            "include_goals": True,
            "include_orient_summary": True,
        },
        "max": {
            "authorities": 20, "fading": 8,
            "include_stats": True,
            "include_identity": True,
            "include_goals": True,
            "include_orient_summary": True,
        },
    }

    def signature(self, level: str = "standard", max_tokens: int = 1500) -> dict:
        """
        Compile the vault ambient signature — identity + pinned context
        loaded into model context every turn as stable prefix.

        Level controls content density. max_tokens is the hard cap.
        """
        self._require()
        if level not in self.LEVEL_CONFIG:
            level = "standard"
        cfg = self.LEVEL_CONFIG[level]

        # Gather data from vault
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
        # Progressive trim: shed fading → authorities → goals
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
        """Render vault signature dict to compact markdown."""
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
