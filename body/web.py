# File: body/web.py
# Purpose: Web primitive exposed to the model inside the code namespace.
#   Wraps the TS-side WebFetchTool and WebSearchTool so the model can fetch
#   URLs and search the web without having them as top-level tools. Same
#   philosophy as every other namespace primitive: no sibling tool in the
#   schema, no zigzag between tools. The model composes
#   `results = web.search(q); content = web.fetch(results[0]['url'])` in one
#   code call.
# Key pieces:
#   - Web class, instantiated once as module-global WEB
#   - fetch(url, max_length=50000) — proxies WebFetchTool via bridge
#   - search(query, max_results=10) — proxies WebSearchTool via bridge
#   - resolve(id, result) — called by server.py main loop on web_response
# Role: Registered under "web" in the code namespace. Mirrors the vault /
#   research / fs / shell callback pattern. If you change the transport
#   here, change it in the others — the bridge's routing code is uniform.

from __future__ import annotations

import json
import sys

from _protocol import write_message
import threading
from typing import Any


class WebError(Exception):
    """Raised when a web call is rejected, times out, or returns an error.
    Like ShellError, successful HTTP calls with 4xx/5xx status codes are
    surfaced in the result dict — the primitive doesn't decide whether a
    404 is fatal to the model's task."""
    pass


class Web:
    """
    Web primitive. Proxies fetch and search through the TS bridge.

    Identical pattern to Vault / Fs / Shell. `_request_id`, `_pending`,
    `_lock`, `_stdout_lock`, `_next_id`, `_call`, `resolve` — all mirror
    the canonical shape.
    """

    def __init__(self) -> None:
        self._request_id = 0
        self._pending: dict[int, dict[str, Any]] = {}
        # _lock guards _pending. _stdout_lock removed in Batch 1.6 —
        # see body/_protocol.py header.
        self._lock = threading.Lock()

    def resolve(self, request_id: int, result: Any) -> None:
        """Called by server.py main loop when web_response arrives from TS."""
        with self._lock:
            if request_id in self._pending:
                self._pending[request_id]["result"] = result
                self._pending[request_id]["event"].set()

    def _next_id(self) -> int:
        self._request_id += 1
        return self._request_id

    def _call(self, method: str, args: dict, timeout: float = 45.0) -> Any:
        """
        Send web_request via stdout, block on web_response.

        Timeout defaults to 45s — web requests can be slow (cold Jina reader
        starts, slow target sites). TS side has its own fetch timeout (30s
        for Jina + 15s for direct fallback) so the bridge should always
        respond within this window.
        """
        req_id = self._next_id()
        event = threading.Event()

        with self._lock:
            self._pending[req_id] = {"event": event, "result": None}

        # Atomic bridge write via _protocol.write_message (Batch 1.6).
        write_message({"web_request": {"id": req_id, "method": method, "args": args}})

        if not event.wait(timeout=timeout):
            with self._lock:
                self._pending.pop(req_id, None)
            raise WebError(f"web call timed out: {method}")

        with self._lock:
            entry = self._pending.pop(req_id)
            result = entry["result"]

        if isinstance(result, dict) and "error" in result:
            raise WebError(result["error"])

        return result

    # ── Primary verbs ──────────────────────────────────────────────────────

    def fetch(self, url: str, max_length: int = 50_000) -> str:
        """
        Fetch a URL and return the body as cleaned text/markdown.

        Uses Jina Reader under the hood (handles JS-rendered pages, returns
        markdown). Falls back to a direct HTTP fetch with basic HTML-to-text
        cleanup if Jina is unavailable.

        Args:
            url: fully qualified URL (http:// or https://).
            max_length: max characters to return. Content beyond this is
                truncated with a sentinel. Default 50,000 (~12k tokens).

        Returns:
            The page content as a single string. Markdown if Jina
            succeeded, cleaned text otherwise.

        Raises WebError for network failure, non-2xx responses, or timeout.
        """
        if not isinstance(url, str) or not url.strip():
            raise WebError("web.fetch: url must be a non-empty string")
        return self._call("fetch", {"url": url, "max_length": max_length})

    def read(self, url: str, max_length: int = 50_000) -> str:
        """
        Reader-mode URL fetch — alias for web.fetch.

        Pi uses `read('http://...')` as the universal URL primitive; we
        expose `web.read` for naming consistency so Pi-trained models hit
        the right name without a teaching round-trip. Identical behavior
        to web.fetch (Jina Reader under the hood, falls back to direct
        HTTP + HTML cleanup).

        Args, returns, exceptions: see web.fetch.
        """
        return self.fetch(url, max_length=max_length)

    def search(self, query: str, max_results: int = 10) -> list[dict]:
        """
        Search the web and return a list of result dicts.

        Backends (tried in order, first hit wins):
          1. Configured provider (Tavily / Brave / Serper / SerpAPI) — if
             the user set webSearch.provider + apiKey in their config or
             the matching env var. Best quality.
          2. DuckDuckGo JSON — no key, limited topic coverage.
          3. DuckDuckGo HTML scrape — no key, fragile last resort.

        If no provider is configured AND DDG falls back to nothing useful,
        the bridge returns a setup-instruction error (add a key or env var).
        The model's try/except should catch WebError and relay the setup
        guidance to the user.

        Args:
            query: search query string.
            max_results: maximum results to return. Providers may return
                fewer if not enough organic results. Default 10.

        Returns:
            List of dicts, each with {title, url, snippet}. May include an
            `answer` key on the first dict if the provider (Tavily/Serper)
            returned an answer box.
        """
        if not isinstance(query, str) or not query.strip():
            raise WebError("web.search: query must be a non-empty string")
        return self._call("search", {"query": query, "max_results": max_results})
