# Phase 8 — Judgment Tools

**Goal:** give the REPL agent *taste*. It can already search code and compose operations. Now it can judge: "does this match convention", "where should this live", "is this a duplicate".

**Scope:** 5 new methods on `codebase` object. Zero new Python dependencies. All structural + lexical first; `rlm_call` used only where semantic reasoning genuinely beats structural analysis.

---

## 1. What Already Exists (do NOT rebuild)

In `body/codebase.py`:
- `show_dependents(file_path)` — predecessors with weights ✅
- `show_dependencies(file_path)` — successors with weights ✅
- `trace_path(from_file, to_file, max_depth=5)` — shortest path ✅
- `find_symbol(name)` — where defined ✅
- `communities()` — Louvain clusters ✅
- `pagerank()`, `hits()`, `top_files()` ✅
- `_community_label(members)` — majority-directory labeler ✅

**Reuse these aggressively.** Judgment tools are composed over primitives, not rebuilt from scratch.

---

## 2. New Methods to Add

### 2.1 `find_similar_patterns(pattern, limit=10, mode="name")`

**Input modes:**
- `mode="name"` — `pattern` is a string (symbol name or name fragment). Tokenize via snake_case/camelCase split, Jaccard over tokens against all indexed symbol names.
- `mode="shape"` — `pattern` is a code snippet (string). Parse with tree-sitter → AST shape hash → scan files for similar hashes.
- `mode="signature"` — `pattern` is a dict `{kind, name_contains}`, filters symbols by kind + substring.

**Output:** `list[dict]` of `{name, kind, file, line, score, snippet}` sorted by score desc.

**Implementation:**
- `name` mode: no parsing needed, O(n symbols). Token intersection / union.
- `shape` mode: parse the snippet once; walk each indexed file's tree-sitter AST, compute shape hashes for function/method/class bodies, compare via edit distance on hash sequences.
- `signature` mode: direct filter over `self._symbol_to_files` and symbol kinds.

**Why this design:** name-mode covers 80% of "how is this done elsewhere" queries with zero parsing cost. Shape-mode is the structural heavyweight. Signature is the cheap precision filter.

### 2.2 `suggest_location(description, kind="file", limit=3)`

**Input:** `description: str` — plain English of what's being added. `kind ∈ {"file", "symbol"}`.

**Output:** `list[dict]` of `{community_label, community_id, sample_files, rationale, confidence}`.

**Implementation:**
1. Pull communities + labels via `_community_label`.
2. Tokenize description (lowercase, split on whitespace + punctuation).
3. Score each community by: overlap of description tokens with (a) community label tokens, (b) symbol names in community's top-3 PageRank files, (c) first-comment lines of those files.
4. Return top-`limit` with computed rationale string ("matches on: error-handling, routing").

**No rlm_call.** Keep deterministic. If the agent needs semantic ranking it can compose `suggest_location()` + `rlm_call()` itself.

### 2.3 `find_convention(topic, limit=5)`

**Input:** `topic: str` — a concept ("error handling", "logging", "api call").

**Output:** `list[dict]` of `{pattern_signature, example_file, example_line, occurrence_count, snippet}`.

**Implementation:**
1. Map topic → search tokens. Small builtin dict: `{"error handling": ["try", "catch", "except", "raise", "error"], "logging": ["log", "logger", "console.log", "print"], ...}`. Accept raw tokens if topic unknown.
2. Scan top-10 PageRank files. For each match line, grab window of 3 lines before + 2 after.
3. Normalize the window: strip string literals, collapse whitespace, replace identifiers with `IDENT`.
4. Group normalized windows by equality; count occurrences.
5. Return patterns appearing in ≥2 high-authority files, sorted by occurrence count.

**Why:** a "convention" is just a pattern that repeats across files the codebase trusts. Authority-weighted repetition = de facto standard.

### 2.4 `detect_duplication(snippet, threshold=0.75, limit=10)`

**Input:** `snippet: str` (code), `threshold: float` (0-1), `limit: int`.

**Output:** `list[dict]` of `{file, line, similarity, match_kind}` where `match_kind ∈ {"exact", "structural", "fuzzy"}`.

**Implementation:**
1. Detect language from snippet heuristics (or accept optional `language` param). Default: use project's most-common language.
2. Parse snippet with tree-sitter. Extract function/block nodes → compute shape hashes.
3. For each indexed file matching that language: parse (use cached AST if indexer exposes it, else reparse), extract same-level node hashes.
4. Match via hash equality (exact) → normalized-edit-distance on hash sequences (structural) → token Jaccard fallback (fuzzy).
5. Filter by threshold, sort by similarity desc, cap at `limit`.

**Key helper:** `ast_shape_hash(node, depth_limit=4)` in `judgment.py`.

### 2.5 `is_consistent_with(snippet, reference, criteria="all")`

**Input:**
- `snippet: str`
- `reference: str | list[str]` — file path(s) to compare against, OR a language keyword (e.g. `"typescript"`) meaning "compare against all TS files' aggregate style".
- `criteria: "naming" | "structure" | "imports" | "all"`.

**Output:** `{deviation_score: float, findings: list[{aspect, expected, actual, severity}]}` where `severity ∈ {"info", "warn", "error"}`.

**Implementation per aspect:**

| Aspect | Expected signal | Actual signal | Score contribution |
|---|---|---|---|
| `naming` | Casing distribution of symbols in reference files | Casing of snippet's symbols | % mismatched |
| `structure` | Shape-hash frequency of reference ASTs | Shape hashes of snippet AST | KL-divergence on distributions |
| `imports` | Import style (named, default, namespace) + ordering in reference | Snippet's imports | 0/1 per rule |

`deviation_score = weighted_mean(aspect_scores)`.

Weights: naming 0.3, structure 0.5, imports 0.2. Tuned later.

---

## 3. Shared Utilities — `body/judgment.py` (NEW FILE)

```python
# body/judgment.py

def tokenize_identifier(name: str) -> list[str]:
    """Split camelCase/snake_case/PascalCase into lowercase tokens."""
    # 'fooBarBaz' -> ['foo', 'bar', 'baz']
    # 'foo_bar_baz' -> ['foo', 'bar', 'baz']
    # 'FooBarHTTP' -> ['foo', 'bar', 'http']

def jaccard(a: set, b: set) -> float:
    """Jaccard similarity. Empty/empty -> 0.0."""

def ast_shape_hash(node, depth_limit: int = 4) -> str:
    """
    Canonical hash of a tree-sitter node's shape.
    Strips identifier text and literals, keeps node types + structure.
    Returns hex digest.
    """

def hash_sequence_distance(seq_a: list[str], seq_b: list[str]) -> float:
    """
    Normalized edit distance between two hash sequences, 0.0 (identical) to 1.0 (disjoint).
    Use Levenshtein over list-of-strings, normalize by max length.
    """

def detect_casing(name: str) -> str:
    """Returns 'camel' | 'pascal' | 'snake' | 'upper_snake' | 'kebab' | 'mixed'."""

def normalize_code_window(lines: list[str]) -> str:
    """Strip string literals, collapse whitespace, replace identifiers with 'IDENT'."""
```

All pure-Python, no external deps.

---

## 4. File Changes

### `body/judgment.py` — NEW
Shared utilities listed above. ~200 lines.

### `body/codebase.py` — MODIFY
Add 5 methods at the end of `CodebaseGraph`, after `top_files`. ~350 lines added.

Import from `judgment.py`:
```python
from .judgment import (
    tokenize_identifier, jaccard, ast_shape_hash,
    hash_sequence_distance, detect_casing, normalize_code_window,
)
```

Access tree-sitter parser via lazy import (same pattern as indexer). Methods that need AST parsing cache compiled parser per language.

### `body/server.py` — MODIFY (tiny)
No new ops needed — judgment tools are called through REPL namespace, already exposed via `codebase` object.

### `src/prompt.ts` — MODIFY
Update the `codebase` section in the "Your Body — the Repl Tool" prompt block (around lines 136-145). Add 5 new method signatures:

```
- `codebase.find_similar_patterns(pattern, limit, mode)` → patterns matching by name/shape/signature
- `codebase.suggest_location(description, kind)` → where new code fits, ranked by community
- `codebase.find_convention(topic)` → recurring patterns across high-authority files
- `codebase.detect_duplication(snippet, threshold)` → duplicate/near-duplicate matches
- `codebase.is_consistent_with(snippet, reference, criteria)` → naming/structure/import deviation score
```

Keep each line short — prompt cache budget matters.

### `test/repl/judgment.test.ts` — NEW
Integration tests running through the bridge (same pattern as existing `codebase.test.ts`).

Test scenarios on aries-cli itself:
1. `find_similar_patterns("assembleCurrentState", mode="name")` → should surface `assembleWarmContext`, `runPreflight`, etc.
2. `find_similar_patterns` with a simple async arrow function snippet, mode="shape" → finds structurally similar functions.
3. `suggest_location("new vault query helper")` → top community includes `src/memory/` or `body/`.
4. `find_convention("error handling")` → returns try/catch patterns from top PageRank TS files.
5. `detect_duplication` with a copy of an existing function → similarity > 0.9, match_kind="exact".
6. `detect_duplication` with a function that was renamed + slightly edited → similarity ~0.7-0.9, match_kind="structural".
7. `is_consistent_with` — consistent snippet → deviation < 0.3. Intentionally-inconsistent snippet (snake_case in a camelCase codebase) → deviation > 0.5, naming finding surfaces.

### `body/test_judgment.py` — NEW
Pure Python unit tests for `judgment.py` helpers.

- `tokenize_identifier` — 10 cases covering camel, pascal, snake, upper_snake, acronyms
- `jaccard` — empty, identical, partial, disjoint
- `detect_casing` — 8 cases
- `ast_shape_hash` — identical trees → identical hash; different identifiers same shape → same hash; different structure → different hash
- `hash_sequence_distance` — identical lists → 0.0, disjoint → 1.0, one-edit → 1/max
- `normalize_code_window` — string literal replacement, identifier masking

Run: `python -m pytest body/test_judgment.py` (or plain `python body/test_judgment.py` if no pytest).

Hand-runnable without the bridge.

---

## 5. Build Order

Strict sequence — each step validates the last:

1. **`body/judgment.py`** — write utilities + run `body/test_judgment.py`. All helpers pass before moving on.
2. **`codebase.find_similar_patterns`** (name mode only first) + test. Simplest lift, no AST.
3. **`codebase.suggest_location`** + test. Reuses communities + labels. No new parsing.
4. **`codebase.find_convention`** + test. Adds `normalize_code_window` usage.
5. **AST shape hashing** — extend judgment.py with tree-sitter integration. Verify on known TS/Python snippets.
6. **`codebase.find_similar_patterns` (shape mode)** + test.
7. **`codebase.detect_duplication`** + test. Heaviest — needs AST cache strategy decided.
8. **`codebase.is_consistent_with`** + test. Highest-value, most sensitive.
9. **`src/prompt.ts`** — wire 5 methods into system prompt.
10. **Full regression** — all existing tests still pass. Typecheck clean.

**AST caching decision** (resolve during step 5): re-parse per call, or cache parsed trees in `FileRecord`? Recommendation: lazy-parse with an LRU cache keyed on `file_path`, max 100 entries. The indexer already parses once for tags; storing the full tree in `FileRecord` blows memory on large repos.

---

## 6. Non-Goals for Phase 8

- **No embedding index.** If find_similar_patterns name+shape modes aren't good enough, Phase 9 (Warmth Signals) adds embeddings properly.
- **No cross-language detection.** Duplication/consistency check operates within one language only.
- **No auto-fix suggestions.** `is_consistent_with` reports findings; the model decides what to do with them.
- **No RLM-based ranking in judgment tools.** The model composes judgment calls with rlm_call itself in Python; judgment tools stay deterministic.

---

## 7. Success Criteria

Judgment tools are "done" when:

1. All 5 methods callable from REPL on aries-cli and return non-trivial output.
2. `is_consistent_with` flags a deliberately-off snippet (snake_case in a camelCase codebase) with a naming finding.
3. `detect_duplication` flags a copy-pasted function as similarity > 0.9.
4. `find_convention("error handling")` returns try/catch patterns from real files.
5. `suggest_location` puts memory-related descriptions in the memory community.
6. All tests pass.
7. Agent can chain them in a single REPL block to answer "where should this new handler live, and does my draft match convention?" in one turn.

---

## 8. Open Questions (resolve during build)

1. **Language detection for `detect_duplication` snippet input** — heuristic sniffing (check for `def`/`function`/`class` keywords) vs required `language` param. Recommend: optional param, default = heuristic + project's dominant language.
2. **How to expose `kind="react-component"` in `is_consistent_with`** — pattern library, or always require a reference file? Recommend: v1 requires file path(s); curated patterns are Phase 8.5 if needed.
3. **Normalization aggressiveness in `find_convention`** — strip comments? Keep them? Recommend: strip comments for the similarity hash but include original snippet in output.

---

**End of plan.**
