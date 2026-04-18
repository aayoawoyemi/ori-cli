"""
Research proxy — routes all research calls through the TS bridge.

Mirrors body/vault.py exactly. Sends research_request messages to stdout
and blocks until research_response arrives on stdin (routed by server.py's
main loop, which must process research_response BEFORE exec_thread.join()).

Protocol (during exec):
  Python stdout: {"research_request": {"id": 1, "method": "discover", "args": {...}}}
  TS stdin:      {"research_response": {"id": 1, "result": [...]}}
  TS stdin:      {"cancel_research": {"id": 1}}   ← unblocks the pending call
"""
from __future__ import annotations

import json
import sys
import threading
from typing import Optional, Any


class ResearchError(Exception):
    pass


class Research:
    """
    Research proxy that routes all calls through the TS bridge.

    Sends research_request messages to stdout and blocks until research_response
    arrives on stdin (routed by server.py's main loop). The key invariant:
    server.py must route research_response BEFORE exec_thread.join() — same
    rule as vault_response — or this will deadlock.
    """

    def __init__(self) -> None:
        self._connected = False
        self._request_id = 0
        self._pending: dict[int, dict[str, Any]] = {}
        self._lock = threading.Lock()
        self._stdout_lock = threading.Lock()

    @property
    def connected(self) -> bool:
        return self._connected

    def connect(self) -> None:
        self._connected = True

    def disconnect(self) -> None:
        self._connected = False

    def resolve(self, request_id: int, result: Any) -> None:
        """Called by server.py main loop when research_response arrives from TS."""
        with self._lock:
            if request_id in self._pending:
                self._pending[request_id]["result"] = result
                self._pending[request_id]["event"].set()

    def cancel(self, request_id: int) -> None:
        """Unblock a pending call when cancel_research arrives from TS."""
        with self._lock:
            if request_id in self._pending:
                self._pending[request_id]["result"] = {"error": "cancelled"}
                self._pending[request_id]["event"].set()

    def _next_id(self) -> int:
        self._request_id += 1
        return self._request_id

    def _require(self) -> None:
        if not self._connected:
            raise ResearchError("research not connected")

    def _call(self, method: str, args: dict, timeout: float = 60.0) -> Any:
        """Send research_request via stdout, block until research_response on stdin."""
        self._require()
        req_id = self._next_id()
        event = threading.Event()

        with self._lock:
            self._pending[req_id] = {"event": event, "result": None}

        msg = json.dumps({"research_request": {"id": req_id, "method": method, "args": args}})
        with self._stdout_lock:
            sys.__stdout__.write(msg + "\n")
            sys.__stdout__.flush()

        if not event.wait(timeout=timeout):
            with self._lock:
                self._pending.pop(req_id, None)
            raise ResearchError(f"research call timed out: {method}")

        with self._lock:
            entry = self._pending.pop(req_id)
            result = entry["result"]

        if isinstance(result, dict) and "error" in result:
            raise ResearchError(f"research error ({method}): {result['error']}")

        return result

    # -------- Research API --------

    def discover(self, query: str, limit: int = 30, seeds: Optional[list] = None) -> list:
        """
        Find sources across Arxiv, Semantic Scholar, OpenAlex, GitHub, Exa, Reddit.
        Returns list of dicts: id, title, authors, date, url, sourceApi, citationCount, abstract.
        """
        args: dict = {"query": query, "limit": limit}
        if seeds is not None:
            args["seeds"] = seeds
        return self._call("discover", args, timeout=45.0)

    def ingest(self, sources: list) -> list:
        """
        Fetch full content for a list of DiscoveredSource dicts.
        Returns handle metadata only — fullText is stored server-side.
        Each item: id, title, url, sourceApi, sections_count, fulltext_len, handle.
        Pass the handle to load() or extract() to access the content.
        """
        return self._call("ingest", {"sources": sources}, timeout=240.0)

    def load(self, handle: str, field: str = "sections") -> Any:
        """
        Load stored content for a handle returned by ingest().
        field: 'sections' (list of {heading, content}), 'fullText' (str), 'references' (list).
        """
        return self._call("load", {"handle": handle, "field": field}, timeout=60.0)

    def fetch(self, url: str, focus: str = "", title: str = "") -> dict:
        """
        Targeted URL drill-down — replaces WebFetch inside research mode.
        Pulls the URL through Jina Reader, stores it as an ingested source,
        and returns handle metadata. Pass the handle to extract() to pull findings.
        Returns dict with: id, title, url, sourceApi, sections_count, fulltext_len, handle.
        """
        args: dict = {"url": url}
        if focus:
            args["focus"] = focus
        if title:
            args["title"] = title
        return self._call("fetch", args, timeout=90.0)

    def extract(self, source: Any, focus: str = "") -> list:
        """
        Extract findings from a handle string or an IngestedSource dict.
        focus: optional context string to guide extraction ("focus on X").
        Returns list of Finding dicts: claim, evidence, provenance, type, confidence.
        """
        return self._call("extract", {"source": source, "focus": focus}, timeout=180.0)

    def synthesize(self, findings: list, query: str) -> dict:
        """
        Cross-source analysis on a list of Finding dicts.
        Returns SynthesisReport: convergent, contradictions, gaps, findings, frontier.
        """
        return self._call("synthesize", {"findings": findings, "query": query}, timeout=180.0)

    def session(self, slug: str) -> dict:
        """
        Load an existing research session by slug, or create a new empty one.
        Returns dict with: meta, sources, findings, graph, frontier.
        (report is not stored as JSON — call synthesize(findings, query) to regenerate.)
        """
        return self._call("session", {"slug": slug}, timeout=60.0)

    def save(self, session: dict) -> dict:
        """
        Persist a session to disk.
        session must have: meta (dict with slug, query, depth), sources, findings,
        graph (nodes/edges), frontier (list of source IDs).
        Returns {ok: True, dir: <path>}.
        """
        return self._call("save", {"session": session}, timeout=60.0)

    def list_sessions(self) -> list:
        """List all saved research sessions. Returns list of SessionMeta dicts."""
        return self._call("list_sessions", {}, timeout=60.0)
