"""
NAMESPACE_SIGNATURES — the single authoritative source of primitive signatures
and return shapes for the Repl namespace. Three sinks read from this table:

  1. body/server.py:_format_first_turn_banner — generates the Shapes block
     shown in the first-turn banner, filtered to primitives actually bound
     in the live namespace this session.
  2. body/repl.py:_enrich_exception — post-processes tracebacks. When the
     model hits KeyError/AttributeError/TypeError/IndexError on a primitive
     call, we append `NOTE: <primitive> returns <shape>` so the next batch
     self-corrects without a discovery turn.
  3. scripts/a10_substrate_smoke.py — drift probe. Every primitive bound
     in _build_namespace must have an entry here, or the smoke fails CI.
     Adding a primitive without registering its schema is a hard error,
     not silent drift.

Why hand-authored vs. introspected: inspect.signature gives parameter names
but not return shapes. Return shapes are the load-bearing information — the
model already knows signatures from docstrings and training prior; what it
doesn't know is that vault.explore returns {results: [...]} not {notes:
[...]}. Maintaining ~120 lines of data is cheap; the smoke drift check
(added in Batch 1.5) makes drift detectable immediately rather than
compounding across sessions.

Format per entry:
  "<primitive dotted name>": {
      "sig":     "(param1, param2=default, ...)",
      "returns": "<shape description — dict keys, list-of-dict, str, etc>",
  }

The `sig` is the signature string the model sees on argument-count errors;
the `returns` is what it sees on shape errors. Both are plain strings — no
schema objects, no versioning yet (A.9.1 can hash this dict later for the
namespace_version gotcha invalidation without further work).

Primitive names use dots: "vault.explore", "fs.read". Bare-name primitives
(say, ask, done, rlm_call, rlm_batch, reindex) have no dot. Stdlib modules
(re, datetime, math, collections, itertools, random, statistics, os, json)
are deliberately NOT listed — Python's stdlib shapes are well-known and
duplicating them here would just add drift surface.

If you add a primitive to body/server.py:_build_namespace, add it here in
the same commit. The smoke probe will fail CI if you don't.
"""
from __future__ import annotations


NAMESPACE_SIGNATURES: dict[str, dict[str, str]] = {
    # ── fs (body/fs.py) ─────────────────────────────────────────────────
    "fs.read":    {"sig": "(path, offset=0, limit=None)",
                   "returns": "str"},
    "fs.listdir": {"sig": "(path='.')",
                   "returns": "list[str]"},
    "fs.glob":    {"sig": "(pattern, path='.')",
                   "returns": "list[str]"},
    "fs.write":   {"sig": "(path, content)",
                   "returns": "{ok, path, ...}"},
    "fs.edit":    {"sig": "(path, old, new, replace_all=False)",
                   "returns": "{ok, replacements, ...}"},
    "fs.patch":   {"sig": "(path, edits, replace_all=False)",
                   "returns": "{ok, results, ...}"},

    # ── vault (body/vault.py) ───────────────────────────────────────────
    # All vault retrievals share the {results: [...], ...} envelope. Access
    # pattern hint is deliberately inline in `returns` because tonight's
    # checkpoint trace (2026-04-23T05-15-50) caught Opus writing
    # `for h in hits:` on the dict — got TypeError because it iterated
    # string keys. The NOTE enrichment fired with the return shape; this
    # hint makes the correct access pattern visible in the banner + NOTE
    # output so Opus's training prior doesn't fill in the wrong shape.
    # vault.top is ranking-only: no snippet. ScoredNote from ori-memory is
    # {title, score, signals, spaces?, metadata?}; `path` is injected client-side
    # by Vault._inject_paths (A.6.1). For snippet-bearing hits, reach for
    # vault.explore — its PPR walk slices context around query terms. Keeping
    # top cheap and explore rich preserves the reason to distinguish the two.
    # (If ori-memory later exposes server-side snippets, add the field here
    # and to the bridge projection in the same commit — see ori/ROADMAP.md.)
    "vault.top":             {"sig": "(query, n=3, scope='both')",
                              "returns": "{results: [{title, path, score}], ...}  # iterate as result['results']; for snippets use vault.explore"},
    "vault.query_ranked":    {"sig": "(query, limit=10, include_archived=False, scope='both')",
                              "returns": "{results: [{title, path, score}], warmth: {...}}  # iterate as result['results']"},
    "vault.query_similar":   {"sig": "(query, limit=10, include_archived=False, scope='both')",
                              "returns": "{results: [{title, path, score}]}  # iterate as result['results']"},
    "vault.query_warmth":    {"sig": "(query, limit=10, scope='both')",
                              "returns": "{results: [{title, path, score}], warmth: {...}}  # empty results is valid signal; iterate as result['results']"},
    "vault.query_important": {"sig": "(limit=10, scope='both')",
                              "returns": "{results: [{title, path, score}]}  # iterate as result['results']"},
    "vault.query_fading":    {"sig": "(limit=10, include_archived=False, scope='both')",
                              "returns": "{results: [{title, path, score, days_since_active}]}  # iterate as result['results']"},
    "vault.explore":         {"sig": "(query, depth=2, limit=15, recursive=True, include_content=True, scope='both')",
                              "returns": "{results: [{title, path, score, snippet, body?}], count, paths, seed_count, ppr_alpha, depth, ppr_iterations, elapsed_ms}  # iterate as result['results']"},
    "vault.read":            {"sig": "(path)",
                              "returns": "str  # raises VaultError on escape/missing"},
    "vault.get_note":        {"sig": "(title)",
                              "returns": "str  # raises VaultError with fuzzy suggestions on miss"},
    "vault.neighbors":       {"sig": "(title)",
                              "returns": "{neighbors: [{title, path|None}]}  # iterate as result['neighbors']"},
    "vault.backlinks":       {"sig": "(title)",
                              "returns": "{backlinks: [{title, path}]}  # iterate as result['backlinks']"},
    "vault.meta":            {"sig": "(title)",
                              "returns": "dict  # yaml frontmatter as {key: value_str}"},
    "vault.add":             {"sig": "(title, content=None, type='insight', scope='project')",
                              "returns": "{ok, path, ...}"},
    "vault.orient":          {"sig": "(brief=True, scope='global')",
                              "returns": "{identity, goals, daily, reminders, ...}"},
    "vault.status":          {"sig": "(scope='global')",
                              "returns": "{noteCount, inboxCount, orphanCount, ...}"},
    "vault.signature":       {"sig": "(level='standard', max_tokens=1500)",
                              "returns": "{level, stats, authority_notes, active_goals, markdown, approx_tokens}"},

    # ── codebase (body/codebase.py) ─────────────────────────────────────
    # The codebase namespace is a graph + symbol index; primitives return
    # structured data for further composition (search → find_symbol →
    # get_context chains are common). Shapes below match the real return
    # types; tuple-returning methods are explicit about [(x, y), ...].
    "codebase.search":              {"sig": "(query, limit=50)",
                                     "returns": "list[{file, line, snippet}]"},
    "codebase.find_symbol":         {"sig": "(name)",
                                     "returns": "list[{file, line, kind}]"},
    "codebase.get_context":         {"sig": "(file_path, line_numbers=None, window=5)",
                                     "returns": "str  # formatted context; None line_numbers shows first 40 lines"},
    "codebase.show_dependents":     {"sig": "(file_path)",
                                     "returns": "list[(file_path, ref_count)]  # desc by count"},
    "codebase.show_dependencies":   {"sig": "(file_path)",
                                     "returns": "list[(file_path, ref_count)]  # desc by count"},
    "codebase.communities":         {"sig": "()",
                                     "returns": "dict[int, list[str]]  # {community_id: [file_paths]}"},
    "codebase.stats":               {"sig": "()",
                                     "returns": "{schema_version, root, file_count, edge_count, symbol_count, ...}"},
    "codebase.find_convention":     {"sig": "(topic, limit=5, authority_files=15, min_files=2)",
                                     "returns": "list[{pattern, example_file, example_line, occurrence_count, snippet, files}]"},
    "codebase.top_files":           {"sig": "(limit=10)",
                                     "returns": "list[{path, pagerank, symbols, references}]"},
    "codebase.list_files":          {"sig": "()",
                                     "returns": "list[str]  # sorted"},
    "codebase.map":                 {"sig": "(path='.', max_depth=5, max_entries=500)",
                                     "returns": "list[{path, type, depth, tracked, pagerank, language}]  # type in {'file','dir','truncated'}; tracked None for dirs/no-git; canonical orient primitive — subsumes list_files+top_files+git status"},
    "codebase.get_file_summary":    {"sig": "(file_path)",
                                     "returns": "{path, language, line_count, symbols: [...], reference_count, import_count}  # or {error: ...}"},
    "codebase.find_similar_patterns": {"sig": "(pattern, limit=10, mode='name')",
                                       "returns": "list[{name, kind, file, line, score, snippet}]  # mode in {name, signature, shape}"},
    "codebase.suggest_location":    {"sig": "(description, kind='file', limit=3)",
                                     "returns": "list[{community_id, label, sample_files, confidence, rationale}]"},
    "codebase.detect_duplication":  {"sig": "(snippet, threshold=0.75, limit=10, language=None)",
                                     "returns": "list[{file, line, name, kind, similarity, match_kind, snippet}]"},
    "codebase.is_consistent_with":  {"sig": "(snippet, reference, criteria='all', language=None)",
                                     "returns": "{deviation_score, findings, component_scores, reference_file_count}"},
    "codebase.pagerank":            {"sig": "(limit=None, personalization=None)",
                                     "returns": "list[(file_path, score)]  # desc"},
    "codebase.hits":                {"sig": "(limit=None)",
                                     "returns": "{hubs: [(path, score)], authorities: [(path, score)]}"},
    "codebase.trace_path":          {"sig": "(from_file, to_file, max_depth=5)",
                                     "returns": "list[str] | None  # [file1, ..., fileN] or None if unreachable"},
    "codebase.refresh_files":       {"sig": "(paths, root_dir)",
                                     "returns": "{refreshed: [...], errors: [...]}"},
    "codebase.signature":           {"sig": "(level='standard', max_tokens=1500)",
                                     "returns": "{level, stats, entry_points, authorities, hubs, modules, markdown, approx_tokens}"},

    # ── shell (body/shell.py) ───────────────────────────────────────────
    "shell.run": {"sig": "(cmd, timeout=30, cwd=None)",
                  "returns": "{stdout, stderr, code}"},

    # ── web (body/web.py) ───────────────────────────────────────────────
    "web.fetch":  {"sig": "(url, max_length=50000)",
                   "returns": "str"},
    "web.search": {"sig": "(query, max_results=10)",
                   "returns": "list[dict]  # provider-shaped hits"},

    # ── research (body/research.py) ─────────────────────────────────────
    "research.discover":      {"sig": "(query, limit=30, seeds=None)",
                               "returns": "list[{id, title, authors, date, url, sourceApi, citationCount, abstract}]"},
    "research.ingest":        {"sig": "(sources)",
                               "returns": "list[{id, title, url, sourceApi, sections_count, fulltext_len, handle}]"},
    "research.load":          {"sig": "(handle, field='sections')",
                               "returns": "list | str  # sections/references -> list; fullText -> str"},
    "research.fetch":         {"sig": "(url, focus='', title='')",
                               "returns": "{id, title, url, sourceApi, sections_count, fulltext_len, handle}"},
    "research.extract":       {"sig": "(source, focus='')",
                               "returns": "list[{claim, evidence, provenance, type, confidence}]"},
    "research.synthesize":    {"sig": "(findings, query)",
                               "returns": "{convergent, contradictions, gaps, findings, frontier}"},
    "research.session":       {"sig": "(slug)",
                               "returns": "{meta, sources, findings, graph, frontier}"},
    "research.save":          {"sig": "(session)",
                               "returns": "{ok, dir}"},
    "research.list_sessions": {"sig": "()",
                               "returns": "list[SessionMeta]"},

    # ── rlm (body/rlm.py) ──────────────────────────────────────────────
    # Bare names (no namespace object) — model calls rlm_call(...) not rlm.call(...)
    "rlm_call":  {"sig": "(slice, question, budget=1000)",
                  "returns": "str"},
    "rlm_batch": {"sig": "(pairs, budget_per=1000)",
                  "returns": "list[str]  # answers in input order"},

    # ── user I/O + turn commitment (body/speak.py + body/server.py) ────
    "say":  {"sig": "(text)",
             "returns": "None  # dual-writes: bridge sentinel + echo to captured stdout"},
    "ask":  {"sig": "(question, timeout=300)",
             "returns": "str"},
    "done": {"sig": "(value)",
             "returns": "None  # commits turn's final value; non-raising, last-commit-wins"},

    # ── session control (body/server.py) ───────────────────────────────
    "reindex": {"sig": "(repo_path)",
                "returns": "None  # rebuilds codebase graph"},
}


# Prefix sort order for substring matching in body/repl.py enrichment.
# Longest-first so "vault.query_ranked" wins over "vault.query" if both
# ever exist, and "codebase.show_dependents" wins over "codebase.show".
# Cached at import time — NAMESPACE_SIGNATURES is append-only at runtime
# so a static snapshot of the ordering is safe.
_PRIMITIVES_BY_LENGTH: list[str] = sorted(
    NAMESPACE_SIGNATURES.keys(), key=len, reverse=True
)


def primitives_by_length() -> list[str]:
    """Return primitive names sorted longest-first for substring matching.

    The enricher in body/repl.py scans a traceback source line for known
    primitive names. Without length-desc ordering, `vault.top` would match
    `vault.top_k` if that primitive ever exists. Sorting longest-first
    with first-match-wins (or checking all and picking rightmost by
    position) sidesteps the ambiguity.
    """
    return _PRIMITIVES_BY_LENGTH


def get(primitive: str) -> dict[str, str] | None:
    """Look up a primitive's {sig, returns} entry. Returns None if unknown.

    Thin wrapper so callers don't import the dict directly — keeps the
    import surface small and makes future refactors (e.g., lazy loading
    from a JSON file) a single-callsite change."""
    return NAMESPACE_SIGNATURES.get(primitive)


# Namespace version hash — pulled forward from A.9.1 (gotcha invalidation).
# Deterministic hash over the full schema table. When any primitive's sig or
# returns changes, the hash changes; gotchas keyed by this version become
# invalid and get pruned automatically. Cheap to compute now; load-bearing
# for Batch 6-7's gotcha layer without requiring a follow-up migration.
#
# Uses blake2b (stdlib, fast, cryptographically strong — overkill for drift
# detection but avoids bikeshedding on algorithm choice). 16-char digest is
# plenty for collision resistance across the ~50 primitives we'll ever have.
def _compute_namespace_version() -> str:
    import hashlib
    import json as _json

    canonical = _json.dumps(NAMESPACE_SIGNATURES, sort_keys=True,
                            separators=(",", ":"))
    return hashlib.blake2b(canonical.encode("utf-8"),
                           digest_size=8).hexdigest()


NAMESPACE_VERSION: str = _compute_namespace_version()
