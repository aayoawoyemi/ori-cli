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

from _protocol import write_message


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
    The `vault` primitive exposed in the Repl namespace. Ori Mnemos memory
    substrate — markdown-native persistent notes with wiki-links, warmth
    signals, and Q-value reranked retrieval.

    Proxy that routes all calls through the TS bridge: sends vault_request
    messages to stdout, blocks until vault_response arrives on stdin
    (routed by server.py's main loop).

    # Verb hierarchy (2026-04-21 rewrite — grounded in 53-session telemetry).

    Two defaults, two intents:
        vault.top(query)      → retrieval. "Give me the top notes on this."
                                Composite-ranked, multi-signal, fast. Use FIRST.
        vault.explore(query)  → mapping.   "Walk the region around this."
                                PPR spreading activation, slower, richer. Use
                                when you want the cluster, not just matches.

    Access (after top/explore returns paths):
        vault.read(path)         → full content of a note by relative path
        vault.get_note(title)    → full content by title (slug-resolved)

    Writes:
        vault.add(title, body)   → durable insight for future sessions

    Session meta:
        vault.orient(brief=True) → identity + goals + today's pending
        vault.status()           → vault health stats

    Escape hatches (use only when you specifically need the bias):
        vault.query_ranked(q, limit)  → like top but with custom limit + full envelope
        vault.query_warmth(context)   → filter currently-warm notes by context
        vault.query_important()       → backbone authorities (no query)
        vault.query_fading()          → notes decaying fastest (no query)
        vault.query_similar(q)        → pure-semantic (no graph signal). Rarely useful —
                                        1 call across 53 sessions in field telemetry.

    # Recall contract (load-bearing).

    When you pull something relevant from the vault, surface it to
    the user with a `Recall:` prefix in your speech. Example:
        Recall: you noted in `codemode-paradigm` that the 10x turn
        reduction was validated in phase-0.
    Silent recall is invisible smartness — the user has no way to see
    what memory is shaping the answer. The `Recall:` prefix makes
    compounded memory legible. This is a voice-level rule, not just
    a retrieval rule.

    # Composed usage (match this shape — single call, multi-op).

        # Retrieval: top is the default.
        hits = vault.top("codemode routing enforcement", n=3)
        for h in hits['results']:
            say(f"Recall: {h['title']} (score {h['score']:.2f})")

        # Mapping: explore when you want the neighborhood, not just matches.
        region = vault.explore("ambient agent UI", depth=2, limit=10)
        for h in region['results']:
            if 'presence' in h['title'].lower():
                print(vault.read(h['path']))

        # Capture a durable insight for future sessions.
        vault.add(
            title="A8 default-mode filter proved cleaner than registry strip",
            content="Runtime filter at loop.ts:267 preserves research/plan/explore modes without registry mutation.",
            type="learning",
        )

    Call `help(vault.<method>)` for per-method details.
    """

    def __init__(self, vault_path: str):
        self._path = vault_path
        self._connected = False
        self._request_id = 0
        self._pending: dict[int, dict[str, Any]] = {}
        # _lock guards _pending (Python state). _stdout_lock removed in
        # Batch 1.6 — see body/_protocol.py header for rationale.
        self._lock = threading.Lock()

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

        # Atomic bridge write via _protocol.write_message (Batch 1.6).
        # os.write on sys.__stdout__.fileno() bypasses the captured
        # sys.stdout that repl.py redirects during exec AND eliminates
        # the deadlock window from the former `with _stdout_lock:` block.
        write_message({"vault_request": {"id": req_id, "method": method, "args": args}})

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

    def top(self, query: str, n: int = 3, scope: str = "both") -> dict:
        """
        RETRIEVAL DEFAULT — give me the top N most relevant notes on this
        query, period. Use this FIRST for any "what does the vault know
        about X" question. Pairs with vault.explore (the mapping default);
        pick between them by intent — top for targeted retrieval, explore
        for walking the region.

        ## Use this instead of query_ranked + slice.

        Do NOT write:
            hits = vault.query_ranked(q, limit=10)
            top = hits['results'][:3]   # hand-slicing
        Do write:
            hits = vault.top(q, n=3)
            for h in hits['results']:
                say(f"Recall: {h['title']}")

        Why: `top` is the preferred verb for the common case. It's what the
        architecture expects you to reach for. The full variants (ranked,
        similar, warmth, important, fading, explore) remain available for
        the specific use cases where their biases matter — but 80% of
        vault retrieval is "show me the top few hits," and this verb
        collapses that common case to one call with a stable-shape return.

        Args:
            query: natural-language search string
            n: number of top hits to return (default 3)
            scope: "both" (default — merge global + project), "global", or "project"

        Returns {"results": [...]} — exactly the same envelope every other
        retrieval verb returns. `n` items max, pre-sorted descending by score,
        already de-duped if federated. No variant metadata, no decoration —
        the shape is uniform across scopes and across calls.

        Example (composed):
            hits = vault.top("codemode paradigm")
            for h in hits['results']:
                body = vault.read(h['path'])
                say(f"Recall {h['title']}: {body[:200]}...")
        """
        # Implementation: thin wrapper over ori_query_ranked with a hard
        # cap on limit. The TS bridge side federates when scope="both" and
        # returns the same {results: [...]} envelope as single-vault calls
        # (A10 finding — no decoration, uniform shape). We don't plumb `n`
        # as a separate MCP argument because the bridge already truncates
        # after federation merge; we just pass limit=n through.
        return self._inject_paths(_unwrap_data(self._call("ori_query_ranked", {
            "query": query, "limit": n, "include_archived": False,
            "scope": scope,
        })))

    # Scope defaults (Fix 1B — project-layered vaults). Every vault method
    # accepts a `scope` kwarg that the TS bridge uses to route the call:
    #   - scope="global"  -> ~/brain (cross-project memory, research,
    #                        general knowledge)
    #   - scope="project" -> <cwd>/.ori/ (project-local, low-noise notes
    #                        specific to this codebase). Auto-created on
    #                        first vault.add(scope="project") if missing.
    #   - scope="both"    -> retrieval merges both vaults, re-ranks, de-
    #                        dups by (title, path). Writes don't support
    #                        this — they need a single target.
    # The defaults below are chosen per-method:
    #   - Retrievals default to "both" -> maximum compounding. The user
    #     wants to see everything relevant unless they explicitly filter.
    #   - add defaults to "project" -> keeps noise local. Global is a
    #     deliberate promote via scope="global".
    #   - orient/status default to "global" -> the global brain IS the
    #     identity substrate; project vaults don't carry identity.

    def query_ranked(self, query: str, limit: int = 10, include_archived: bool = False,
                     scope: str = "both") -> dict:
        """
        Full-envelope Q-value reranked search. ESCAPE HATCH —
        use vault.top(query, n=3) as the retrieval default. Reach for
        query_ranked only when you specifically need more than 3 results
        or want to inspect the raw envelope for debugging.

        Under the hood: 4 base signals (composite, keyword, graph, warmth)
        fused via RRF + Phase B Q-value reranking. vault.top is a thin
        wrapper over this with a hard limit cap and a trimmed shape.

        Args:
            query: natural-language search string
            limit: max results (default 10)
            include_archived: set True to surface retired notes
            scope: "both" (default — merge global + project vaults),
                   "global" (only ~/brain), or "project" (only <cwd>/.ori/).

        Returns {"results": [...], "warmth": {...}, ...}. Each result has
        `title`, `score`, `path`. Use vault.read(path) for full note content.

        Example (when you actually need the full envelope):
            hits = vault.query_ranked("permission gate codemode", limit=20)
            for h in hits['results']:
                # scan all 20 for a specific marker
                if 'plan-mode' in h['path']:
                    print(vault.read(h['path']))
                    break
        """
        return self._inject_paths(_unwrap_data(self._call("ori_query_ranked", {
            "query": query, "limit": limit, "include_archived": include_archived,
            "scope": scope,
        })))

    def query_similar(self, query: str, limit: int = 10, include_archived: bool = False,
                      scope: str = "both") -> dict:
        """
        Pure-semantic embedding-space nearest neighbors. No graph walk,
        no Q-value rerank, no RRF fusion — just cosine similarity.
        ESCAPE HATCH — rarely the right call. Six-week telemetry (53 REPL
        sessions, 2026-04-05 → 2026-04-21) recorded one invocation total.
        vault.top already fuses semantic similarity with graph + warmth +
        Q-value signals and almost always returns a better ranking.

        Reach for this only when you have a specific reason to want a
        graph-blind, warmth-blind probe — e.g. debugging whether the graph
        signal is helping or hurting rank on a particular topic.

        Args: query, limit (default 10), include_archived, scope.
        Returns {"results": [...]}. Each result: title, score, path.
        """
        return self._inject_paths(_unwrap_data(self._call("ori_query_similar", {
            "query": query, "limit": limit, "include_archived": include_archived,
            "scope": scope,
        })))

    def query_warmth(self, query: str, limit: int = 10, scope: str = "both") -> dict:
        """
        Warmth-biased retrieval. ESCAPE HATCH with a specific bias —
        prioritizes notes currently "hot" (recently active, high-boost)
        over archive-wide relevance. Answers "what am I currently thinking
        about re: X" instead of "what does my archive know about X."

        Use for session handoffs (what's still live from recent work),
        orient flows (what's warm right now), or when you want recency-
        weighted recall. For standard retrieval, vault.top handles the
        warmth signal as part of its RRF fusion; you don't need this tool
        to benefit from warmth.

        EMPTY RESULTS ARE SIGNAL, NOT FAILURE. query_warmth filters the
        warm set by your query — if nothing in the currently-hot notes
        matches the topic, the return is `{"results": []}` and that is
        the correct answer. It means "nothing you've been thinking about
        recently touches this topic." Do NOT treat empty-warmth as an
        error and do NOT retry with different parameters. Fall back to
        query_ranked for archive-wide search; that's the right tool when
        the topic isn't currently warm.

        Args:
            query: natural-language search string (filter, not retriever)
            limit: max results (default 10)
            scope: "both" (default), "global", or "project".

        Returns {"results": [...], "warmth": {...}}.

        Example (handles empty correctly — no retry, just fallback):
            hits = vault.query_warmth("codemode", limit=5)
            if hits['results']:
                for h in hits['results'][:3]:
                    say(f"Recall: {h['title']} (warmth {h.get('boost', 0):.2f})")
            else:
                # Not currently warm — fall back to full archive search.
                ranked = vault.query_ranked("codemode", limit=3)
                for h in ranked['results']:
                    say(f"Archive: {h['title']}")
        """
        # MCP's ori_warmth tool expects `context` (the topic to filter warmth
        # by), not `query` — the body's public API keeps `query` because that's
        # what callers know and the docstring documents, but we translate at
        # the wire. Without this translation MCP rejects with
        # "Invalid type for context: expected string" because `query` lands
        # nowhere in the MCP schema. Found 2026-04-28 while profiling user-
        # reported "orient takes 50s" — Sonnet was hitting this error and
        # retrying / re-thinking, which accounted for the bulk of the 50s.
        return self._inject_paths(_unwrap_data(self._call("ori_warmth", {
            "context": query, "limit": limit, "scope": scope,
        })))

    def query_important(self, limit: int = 10, scope: str = "both") -> dict:
        """
        Globally most-important notes regardless of query — backbone
        authorities by PageRank-adjacent signal (high in-degree + high
        boost + high Q-value). ESCAPE HATCH — no query parameter, returns
        vault backbone.

        Use for orient flows, new-session warm-up, or "show me what matters"
        without a topic hook. For topic-specific importance, vault.top
        already weights graph signal in its RRF fusion.

        Args:
            limit: max results (default 10)
            scope: "both" (default), "global", or "project".

        Returns {"results": [...]}.

        Example:
            hits = vault.query_important(limit=10)
            for h in hits['results'][:5]:
                print(f"{h['title']}  ({h['score']:.2f})")
        """
        return self._inject_paths(_unwrap_data(self._call("ori_query_important", {
            "limit": limit, "scope": scope,
        })))

    def query_fading(self, limit: int = 10, include_archived: bool = False,
                     scope: str = "both") -> dict:
        """
        Notes whose warmth is decaying fastest — ideas you haven't touched
        in a while that are slipping out of ambient context. The inverse of
        query_warmth. ESCAPE HATCH — no query, returns decay-ordered set.

        Use for "what am I losing that I shouldn't be" checks, prune sweeps,
        or to rescue notes before they fall below recall threshold. Not a
        retrieval tool — a vault-health view tool.

        Args:
            limit: max results (default 10)
            include_archived: set True to include archived notes
            scope: "both" (default), "global", or "project".

        Returns {"results": [...]}.

        Example:
            hits = vault.query_fading(limit=5)
            for h in hits['results'][:3]:
                say(f"Fading: {h['title']} — last active {h.get('days_since_active', '?')}d ago")
        """
        return self._inject_paths(_unwrap_data(self._call("ori_query_fading", {
            "limit": limit, "include_archived": include_archived, "scope": scope,
        })))

    def explore(self, query: str, depth: int = 2, limit: int = 15,
                recursive: bool = True, include_content: bool = True,
                scope: str = "both") -> dict:
        """
        MAPPING DEFAULT — walk the region around a query via spreading
        activation (PPR at α=0.45) across wiki-links. Seeds from the
        query-matched notes, expands `depth` levels out via the link graph,
        surfaces structurally-adjacent notes that wouldn't rank on text
        alone.

        When to use explore vs top:
          - vault.top(query)     → "Give me the top notes on this topic."
          - vault.explore(query) → "Show me the region around this topic."
        Both are first-class defaults; pick by intent. Top is faster
        (~200ms typical). Explore is slower (up to 60s timeout) but
        returns the graph neighborhood, not just matches.

        Args:
            query: natural-language search string
            depth: wiki-link walk depth (default 2, max ~4 useful)
            limit: max results to return
            recursive: walk link graph multi-step vs single-step
            include_content: attach note body to each result
            scope: "both" (default), "global", or "project". Graph walks
                   happen per-vault; cross-vault link traversal is NOT
                   supported — a wiki-link in a project note pointing to
                   a title that lives only in the global vault won't be
                   followed by the walk. Use scope="both" for merged
                   results; walks remain vault-local.

        Example (map a topical region):
            hits = vault.explore("codemode paradigm", depth=2, limit=20)
            for h in hits['results']:
                print(f"  {h['title']}")
        """
        return self._inject_paths(_unwrap_data(self._call("ori_explore", {
            "query": query, "depth": depth, "limit": limit,
            "recursive": recursive, "include_content": include_content,
            "scope": scope,
        }, timeout=60.0)))

    # -------- Introspection --------

    def orient(self, brief: bool = True, scope: str = "global") -> dict:
        """Session briefing. Default scope="global" because identity
        (goals, reminders, warmth landscape) lives in ~/brain, not in
        project vaults. Pass scope="project" to orient against a project-
        local vault's goals.md/reminders.md if it has them."""
        return _unwrap_data(self._call("ori_orient", {"brief": brief, "scope": scope}))

    def status(self, scope: str = "global") -> dict:
        """Vault health status. Default scope="global"."""
        return _unwrap_data(self._call("ori_status", {"scope": scope}))

    # -------- Writes --------

    def add(self, title: str, content: Optional[str] = None, type: str = "insight",
            scope: str = "project") -> dict:
        """
        Write a new note to the vault inbox. The ONLY path for durable
        memory writes — no silent keyword-heuristic path. Title becomes
        the filename (slugified). Content is the markdown body.

        Args:
            title: one-line note title (becomes slug + filename)
            content: markdown body; if None, creates a stub note
            type: "insight" | "learning" | "decision" | "moc" | others —
              controls vault routing (some types go to self/ vs notes/)
            scope: "project" (DEFAULT — note goes to <cwd>/.ori/, creating
                   it automatically on first add) or "global" (note goes
                   to ~/brain for cross-project insights). Project default
                   keeps project-specific noise local; promote to global
                   deliberately when an insight generalizes.

        Example:
            vault.add(
                title="rlm_batch empty response quirk traces to max_tokens floor",
                content=(
                    "Qwen 14B (and similar small reasoning models) return"
                    " empty string when max_tokens < ~200 because reasoning"
                    " overhead eats the output budget. Floor at 250 in"
                    " _call_single. See body/rlm.py:140."
                ),
                type="learning",
            )
        """
        args: dict = {"title": title, "type": type, "scope": scope}
        if content is not None:
            args["content"] = content
        return _unwrap_data(self._call("ori_add", args))

    # -------- File Reading (bounded to vault) --------

    def read(self, path: str) -> str:
        """
        Read a file from the vault by relative path. Bounded to vault dir —
        attempts to escape via .. or absolute paths raise VaultError.

        Args:
            path: relative path from vault root (e.g. "notes/codemode.md")

        Use after query_ranked/explore when you want the full note body:
            hits = vault.query_ranked("rlm fallback", limit=3)
            if hits['results']:
                print(vault.read(hits['results'][0]['path']))
        """
        # 2026-04-25 — explicit None guard. vault.explore/top can return
        # results where `path` is None: those are wiki-link stubs that
        # exist in the graph (some other note has a [[link]] to them) but
        # have no backing markdown file yet. Aries-self caught itself
        # passing such a None into vault.read in a live session — without
        # this guard the call dies in os.path.join with a cryptic TypeError
        # that the enrichment system can't structurally map back to "you
        # tried to read a stub." This message tells the model exactly
        # what happened and what to do — `if h['path']:` filter or
        # try/except VaultError around the read.
        if path is None:
            raise VaultError(
                "path is None — wiki-link stub without a backing file. "
                "Filter results with `if h['path']:` before reading, or "
                "wrap vault.read in try/except VaultError."
            )
        import os
        full = os.path.normpath(os.path.join(self._path, path))
        if not full.startswith(os.path.normpath(self._path)):
            raise VaultError(f"path escapes vault: {path}")
        if not os.path.isfile(full):
            raise VaultError(f"not found: {path}")
        with open(full, "r", encoding="utf-8") as f:
            return f.read()

    def get_note(self, title: str) -> str:
        """
        Read a note by title — convenience wrapper that slugifies and
        searches the standard vault directories (notes/, ops/, self/,
        inbox/). Use when you know the title but not the exact path.

        Args:
            title: human-readable title (will be slugified to find file)

        Raises VaultError if the note isn't found in any standard dir.
        On miss, the error message embeds up to 3 fuzzy-matched
        suggestions with scores — handle with try/except in a batch
        and retry against `suggestions[0]` without losing a turn:

            try:
                text = vault.get_note("codemode paradigm")
            except VaultError as e:
                # error message format:
                # "note not found: '<title>'\nDid you mean:\n  - <title> (score 0.89)\n  - ..."
                say(f"miss: {e}")

        Example:
            text = vault.get_note("codemode paradigm")
            if "stack frame" in text:
                say("Recall: codemode paradigm frames work as stack frames")
        """
        # Delegate path resolution to the shared helper so get_note and the
        # traversal verbs (neighbors/meta) stay consistent on slug + prefix
        # conventions. Added 2026-04-21.
        rel_path = self._resolve_path(title)
        if rel_path is None:
            raise VaultError(self._format_not_found(title))
        return self.read(rel_path)

    def _format_not_found(self, title: str) -> str:
        """Build a VaultError message that includes fuzzy suggestions when
        possible. Added 2026-04 (A.6.3) — prior behavior raised a bare
        'note not found: <title>' with no recovery path, forcing the model
        to lose a turn rebuilding context. Model now parses the error
        message inside try/except and retries in the same batch.

        Returns a string ready to pass to VaultError. Never raises — if
        the fuzzy lookup itself fails (vault not connected, MCP timeout),
        we fall back to the plain message rather than obscure the original
        not-found signal with a different error.
        """
        base = f"note not found: '{title}'"
        try:
            hits = self.top(title, n=5)
        except Exception:
            return base
        if not isinstance(hits, dict):
            return base
        results = hits.get("results", [])
        if not isinstance(results, list):
            return base
        lines = []
        for entry in results[:3]:
            if not isinstance(entry, dict):
                continue
            h_title = entry.get("title", "")
            h_score = entry.get("score", 0.0)
            if not isinstance(h_title, str) or not h_title:
                continue
            try:
                score_str = f"{float(h_score):.2f}"
            except (TypeError, ValueError):
                score_str = "?"
            lines.append(f"  - {h_title} (score {score_str})")
        if not lines:
            return base
        return base + "\nDid you mean:\n" + "\n".join(lines)

    def _inject_paths(self, result: Any) -> Any:
        """Walk result['results'] and add a 'path' key to each entry via
        _resolve_path(title). Idempotent — safe to apply even when path
        is already present (future-proof for when Ori ships it server-
        side). Dangling titles (not yet backed by a file) get path=None.
        Zero MCP cost — pure in-process slug resolution.

        Added 2026-04 (A.6.1) — ScoredNote server-side didn't carry path,
        but every retrieval docstring taught the model to read h['path'].
        Fixed the KeyError-every-time retrieval→read composition failure
        surfaced in the walk-codemode trace.

        Non-dict / unexpected-shape inputs pass through unchanged — this
        helper is defensive by design because it wraps every retrieval
        envelope, including error shapes we don't want to mangle.
        """
        if not isinstance(result, dict):
            return result
        results = result.get("results")
        if not isinstance(results, list):
            return result
        for entry in results:
            if not isinstance(entry, dict):
                continue
            if "path" in entry and entry["path"] is not None:
                # Respect pre-populated paths. When Ori eventually ships
                # path server-side, we want this helper to no-op rather
                # than overwrite the authoritative value.
                continue
            title = entry.get("title")
            if isinstance(title, str) and title:
                entry["path"] = self._resolve_path(title)
        return result

    def _resolve_path(self, title: str) -> Optional[str]:
        """
        Title → relative path inside the vault, or None if no matching file
        exists. Matches the slug convention used by vault.add (lowercase,
        spaces-to-dashes, .md extension) and scans the standard directories.
        Extracted 2026-04-21 so neighbors/meta can resolve without the
        VaultError-raising behavior of get_note — dangling links should
        return None, not throw.
        """
        import os
        slug = title.lower().replace(" ", "-")
        if not slug.endswith(".md"):
            slug += ".md"
        # Standard vault layout: notes/ for insights, ops/ for operational
        # docs, self/ for identity notes, inbox/ for unprocessed captures.
        # Scan in that order — notes/ holds the bulk of the graph so it's
        # cheapest to check first for typical traffic.
        for prefix in ["notes", "ops", "self", "inbox"]:
            candidate = os.path.join(prefix, slug)
            full = os.path.normpath(os.path.join(self._path, candidate))
            if os.path.isfile(full):
                return candidate
        # Fall back to raw relative-path variants for callers that already
        # know the path without the prefix (e.g. the link target was typed
        # with an extension, or it's a top-level file like index.md).
        for variant in [slug, title if title.endswith(".md") else title + ".md", title]:
            full = os.path.normpath(os.path.join(self._path, variant))
            if full.startswith(os.path.normpath(self._path)) and os.path.isfile(full):
                return variant
        return None

    # -------- Traversal (graph navigation via wiki-links) --------
    #
    # Precision walks with predictable shape. All three verbs return
    # {<key>: [...]} with {title, path} entries. neighbors + meta are
    # fs-local (no MCP cost); backlinks routes through ori_query because
    # the inbound edge index lives server-side. Added 2026-04-21 as the
    # v0.5 Phase 1 traversal primitives — codemode composition now covers
    # deliberate single-hop graph walking without falling back to the
    # heavier explore() call.

    def neighbors(self, title: str) -> dict:
        """
        Outbound wiki-link neighbors — the notes this note points AT.
        fs-local: reads the note body, regex-extracts [[links]], dedupes
        preserving first-occurrence order, and resolves each link to a
        path if it exists in the vault.

        Returns {"neighbors": [{"title": str, "path": str | None}]}. A
        None path means the link is dangling (target not yet written).

        Pair with vault.read to follow whichever neighbor looks relevant.
        Zero MCP cost — safe to fan out across many seeds in one call.

        Example:
            links = vault.neighbors("codemode paradigm")
            for n in links['neighbors']:
                if n['path']:
                    print(f"[[{n['title']}]] → {n['path']}")
        """
        import re
        # Resolve to body via the shared get_note path — raises VaultError
        # if the seed itself is missing, which is the right signal: caller
        # asked for neighbors of a non-existent note.
        body = self.get_note(title)
        # Pattern captures [[target]] and [[target|alias]]; alias is
        # cosmetic, the first capture group is the target title used for
        # path resolution.
        pattern = re.compile(r"\[\[([^\]|]+)(?:\|[^\]]*)?\]\]")
        seen: set[str] = set()
        results: list[dict] = []
        for m in pattern.finditer(body):
            link_title = m.group(1).strip()
            # Case-insensitive dedupe — wiki-links may vary in casing but
            # still point at the same target file on disk.
            key = link_title.lower()
            if not link_title or key in seen:
                continue
            seen.add(key)
            # None path = dangling link. Expose anyway so the caller sees
            # the edge; dangling edges are still valuable signal when
            # mapping intent vs actual vault coverage.
            results.append({"title": link_title, "path": self._resolve_path(link_title)})
        return {"neighbors": results}

    def backlinks(self, title: str) -> dict:
        """
        Inbound wiki-link backlinks — the notes that point AT this note.
        Routes to ori_query with kind="backlinks" (server-side graph
        lookup using the indexed edge set).

        Returns {"backlinks": [{"title": str, "path": str}]}. Empty list
        if no indexed note references this title.

        Inverse of vault.neighbors. Answers "who references this note?" —
        essential for understanding which work depends on a given decision
        or insight.

        Example:
            back = vault.backlinks("predictable apis over prose rails")
            for b in back['backlinks']:
                say(f"Cited in: {b['title']}")
        """
        # Server may return the results under different keys depending on
        # version (backlinks, results, or bare list). Normalize to a
        # stable {backlinks: [{title, path}]} contract so callers never
        # have to probe shape — predictable APIs, not prose rails.
        raw = _unwrap_data(self._call("ori_query", {
            "kind": "backlinks", "note": title,
        }))
        entries: list = []
        if isinstance(raw, dict):
            entries = raw.get("backlinks") or raw.get("results") or []
        elif isinstance(raw, list):
            entries = raw
        normalized = [
            {
                "title": e.get("title", "") if isinstance(e, dict) else "",
                "path": (e.get("path", "") if isinstance(e, dict) else ""),
            }
            for e in entries
        ]
        return {"backlinks": normalized}

    def meta(self, title: str) -> dict:
        """
        YAML frontmatter of a note as a dict — surfaces type, tags,
        description, dates, and any other metadata the author declared at
        the top of the markdown file. fs-local.

        Returns the frontmatter as a plain dict (str → str). Values stay
        as raw strings (lists like "[learning, ai-agents]" are NOT parsed
        into Python lists) because the parse is intentionally minimal —
        pulling pyyaml as a dep would be overkill for a probe that only
        needs type/tags/description in 99% of cases.

        Use to disambiguate notes by type (decision vs learning vs insight)
        or filter by tag without loading full body.

        Example:
            hits = vault.explore("codemode paradigm")
            for h in hits['results']:
                m = vault.meta(h['title'])
                if m.get('type') == 'decision':
                    print(vault.read(h['path']))
        """
        body = self.get_note(title)
        # Ori / Obsidian frontmatter convention: file opens with `---`,
        # closes with `---`, simple key: value lines in between. Anything
        # that doesn't match this shape returns {} rather than raising —
        # a note without frontmatter is valid.
        if not body.startswith("---\n"):
            return {}
        end = body.find("\n---", 4)
        if end == -1:
            return {}
        fm_block = body[4:end].strip()
        result: dict = {}
        for line in fm_block.split("\n"):
            s = line.strip()
            # Skip blanks + comment lines. Keys may contain dashes /
            # underscores; values are everything after the first colon.
            if not s or s.startswith("#") or ":" not in s:
                continue
            key, _, value = s.partition(":")
            result[key.strip()] = value.strip()
        return result

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
