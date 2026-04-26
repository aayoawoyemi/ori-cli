"""
Runtime calibration for NAMESPACE_SIGNATURES.

Batch 1.5 made schema.py the source of truth for the first-turn banner Shapes
block, the _enrich_exception NOTE, and the substrate smoke drift probe. Batch
1.5's drift probe only checked *existence* — every bound primitive had an
entry. It did not check that the declared `returns` string matched the shape
the primitive actually produces at runtime. That gap let vault.top ship with
`returns: "{results: [{title, path, score, snippet}], ...}"` even though
ori-memory's ScoredNote carries no snippet and our bridge projection doesn't
synthesize one. Aries self-diagnosed the lie mid-session; Batch 1.8 exists
to make the harness stop lying structurally.

Two moving parts here:

1. parse_returns(returns_str) — extracts the *declared* shape out of the
   schema's human-readable `returns` string. Returns:
     {"envelope": set[str], "item": set[str]}
   where envelope is the top-level dict's keys and item is the first
   list[{...}] element's keys (if any). Shapes that aren't dicts (plain
   str, None, list[str], list[tuple]) return empty sets — nothing to
   calibrate, no drift possible.

2. compare_against_fixture(schema_table, fixture_entries) — for every
   primitive present in BOTH the schema and the fixture, asserts the
   declared key sets equal the calibrated key sets. Missing-from-fixture is
   OK (fixture can be partial); primitive-in-fixture-but-not-schema is a
   harder error (removed primitive that didn't get its calibration cleaned
   up). Returns a list of drift records; empty list = green.

Why fixture-based instead of live-runtime invocation: most bridge primitives
(vault.*, codebase.*, research.*) can't be exercised in standalone smoke —
they block on TS-side callbacks. A live-session calibrator would need a
running aries-cli which defeats "fast CI probe." Fixture is a committed
snapshot regenerated manually when primitives change; the probe compares
schema against fixture and fails loudly on drift. When ori-memory adds
snippet server-side (see ori/ROADMAP.md → Consumer Requests), update the
fixture in the same commit that updates the schema.

Fixture format (body/schema.calibrated.json):
  {
    "version": 1,
    "captured_at": "YYYY-MM-DD",
    "notes": "...",
    "primitives": {
      "<dotted name>": { "envelope": [...], "item": [...] }
    }
  }

Parser is forgiving — schema entries were hand-authored with inline comments
and access-pattern hints, so we strip `# ...` trailing text, handle nested
braces, and ignore lexical noise like `...` continuation and trailing `?`
on optional keys.
"""
from __future__ import annotations

import json
from pathlib import Path


def _strip_comment(s: str) -> str:
    # `#` inside braces is unlikely but be safe — only treat as comment if
    # the `#` is at depth 0 (outside all {}/[]/() groups).
    depth = 0
    for i, ch in enumerate(s):
        if ch in "{[(":
            depth += 1
        elif ch in "}])":
            depth -= 1
        elif ch == "#" and depth == 0:
            return s[:i]
    return s


def _find_matching(s: str, start: int, open_c: str, close_c: str) -> int:
    """Return index of the closing bracket that matches s[start]=open_c,
    or -1 if unbalanced. Tracks only the brace type we care about so
    nested lists/parens don't confuse the counter."""
    depth = 0
    for idx in range(start, len(s)):
        if s[idx] == open_c:
            depth += 1
        elif s[idx] == close_c:
            depth -= 1
            if depth == 0:
                return idx
    return -1


def _split_top_keys(inner: str) -> set[str]:
    """Split a brace-body by top-level commas and extract identifier keys.

    Input example: `results: [{title, path, score}], warmth: {...}`
    Output:        {'results', 'warmth'}

    Rules:
      - Split at commas where depth == 0 (skip nested [], {}, ()).
      - For each part, take the text before `:` as the key name.
      - Drop `...` continuation markers.
      - Strip trailing `?` (optional-key marker, e.g., `body?`).
      - Ignore anything that isn't a valid python identifier after cleanup —
        defends against weirdly-quoted values like `'global' | 'project'`.
    """
    keys: set[str] = set()
    depth = 0
    parts: list[str] = []
    buf: list[str] = []
    for ch in inner:
        if ch in "{[(":
            depth += 1
        elif ch in "}])":
            depth -= 1
        if ch == "," and depth == 0:
            parts.append("".join(buf))
            buf = []
        else:
            buf.append(ch)
    if buf:
        parts.append("".join(buf))

    for raw in parts:
        p = raw.strip()
        if not p or p == "...":
            continue
        name = p.split(":", 1)[0].strip()
        name = name.rstrip("?")
        # Extract leading identifier only. Schema entries sometimes carry
        # inline type hints like `path|None` or `foo | str` that must be
        # stripped — the KEY is the identifier at the start; everything
        # after the first non-ident char belongs to the type annotation,
        # not the key name.
        ident: list[str] = []
        for ch in name:
            if ch.isalnum() or ch == "_":
                ident.append(ch)
            else:
                break
        name = "".join(ident)
        if name and (name[0].isalpha() or name[0] == "_"):
            keys.add(name)
    return keys


def _has_ellipsis(inner: str) -> bool:
    """True if the brace-body contains a top-level `...` continuation
    marker, meaning "and other keys exist." Schema writers use this to
    say "these keys at minimum, more may appear" — so the comparator
    should skip the observed-but-not-declared check for open shapes.

    Nested `...` (inside a sub-brace) doesn't count as the OUTER being
    open; we only respect depth-0 ellipses.
    """
    depth = 0
    for idx, ch in enumerate(inner):
        if ch in "{[(":
            depth += 1
        elif ch in "}])":
            depth -= 1
        elif ch == "." and depth == 0:
            # Look for three consecutive dots at depth 0.
            if inner[idx:idx + 3] == "...":
                return True
    return False


def parse_returns(returns_str: str) -> dict:
    """Parse a schema `returns` string into declared envelope + item keys.

    Returns:
      {
        "envelope": set[str],
        "item": set[str],
        "envelope_open": bool,  # True if the envelope has `...` continuation
        "item_open": bool,      # True if the list-of-dict inner has `...`
      }

    Shapes that don't have dicts (scalars, None, list[str], list[tuple])
    return empty sets and False flags. `envelope_open=True` tells the
    comparator "skip the observed-not-declared check" — schema writers
    use `...` to say "these keys at minimum." Phantom keys (declared but
    not observed — the snippet case) are ALWAYS reported regardless of
    open flags because declaring a key that isn't there is always a lie.

    Multiple list[{...}] blocks with different shapes would need per-key
    tracking — not worth the complexity today. Common case is a single
    `results: [{...}]` list, which is what the fixture covers.
    """
    core = _strip_comment(returns_str).strip()
    envelope: set[str] = set()
    item: set[str] = set()
    envelope_open = False
    item_open = False

    if core.startswith("{"):
        end = _find_matching(core, 0, "{", "}")
        if end > 0:
            body = core[1:end]
            envelope = _split_top_keys(body)
            envelope_open = _has_ellipsis(body)

    # Find the first nested `[{...}]` (list of dicts) anywhere in the
    # string — works whether the shape is outermost list-of-dict or a
    # nested `results: [{...}]` inside an envelope.
    lb = core.find("[{")
    if lb >= 0:
        brace_start = core.index("{", lb)
        brace_end = _find_matching(core, brace_start, "{", "}")
        if brace_end > 0:
            inner = core[brace_start + 1:brace_end]
            item = _split_top_keys(inner)
            item_open = _has_ellipsis(inner)

    return {
        "envelope": envelope,
        "item": item,
        "envelope_open": envelope_open,
        "item_open": item_open,
    }


def compare_against_fixture(
    schema_table: dict[str, dict[str, str]],
    fixture_primitives: dict[str, dict[str, list[str]]],
) -> list[dict]:
    """Diff schema's declared shapes against the fixture's observed shapes.

    Returns a list of drift records. Each record:
      {
        "primitive": "<dotted name>",
        "envelope_declared_only": [...],   # in schema, not in fixture
        "envelope_observed_only": [...],   # in fixture, not in schema
        "item_declared_only": [...],
        "item_observed_only": [...],
      }
    Any non-empty `*_only` field is drift; empty list of records = green.

    Primitives absent from the fixture are skipped (fixture can be partial —
    we don't force-cover every primitive). Primitives in the fixture but
    absent from the schema ARE reported as drift because that means a
    primitive was removed without cleaning up its calibration entry.
    """
    drift: list[dict] = []

    for name, observed in fixture_primitives.items():
        decl_entry = schema_table.get(name)
        if decl_entry is None:
            drift.append({
                "primitive": name,
                "envelope_declared_only": [],
                "envelope_observed_only": sorted(observed.get("envelope", [])),
                "item_declared_only": [],
                "item_observed_only": sorted(observed.get("item", [])),
                "reason": "primitive in fixture but not in schema",
            })
            continue

        parsed = parse_returns(decl_entry["returns"])
        decl_env = parsed["envelope"]
        decl_item = parsed["item"]
        obs_env = set(observed.get("envelope", []))
        obs_item = set(observed.get("item", []))

        # Phantoms (declared but not observed) are always drift — this is
        # the snippet-lie class of failure we're trying to eliminate.
        env_phantom = decl_env - obs_env
        item_phantom = decl_item - obs_item
        # Missing (observed but not declared) are only drift when the
        # schema did NOT mark the shape open with `...`. Open shapes
        # allow extra keys; closed shapes don't.
        env_missing = set() if parsed["envelope_open"] else obs_env - decl_env
        item_missing = set() if parsed["item_open"] else obs_item - decl_item

        if env_phantom or env_missing or item_phantom or item_missing:
            drift.append({
                "primitive": name,
                "envelope_declared_only": sorted(env_phantom),
                "envelope_observed_only": sorted(env_missing),
                "item_declared_only": sorted(item_phantom),
                "item_observed_only": sorted(item_missing),
            })

    return drift


def load_fixture(path: str | Path) -> dict[str, dict[str, list[str]]]:
    """Load the calibrated fixture JSON and return its `primitives` dict.

    Raises FileNotFoundError / json.JSONDecodeError to the caller — callers
    that want to degrade gracefully (e.g., smoke probe in a repo without
    the fixture checked in) can catch and skip.
    """
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    return data.get("primitives", {})
