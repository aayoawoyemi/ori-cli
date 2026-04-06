# Codebase Graph Artifact Contract

**Schema version:** `0.2.0`
**Owner:** `body/indexer.py` (producer), `body/codebase.py` (consumer)

## Purpose

This document freezes the contract between the indexer and the graph consumer. It has two layers — a **searchable snapshot** (R2a) and a **graph substrate** (R2b) — merged into one in-memory representation for v0.2. Future versions may separate them if persistence or cross-process sharing becomes necessary.

Distinction thanks to Codex audit (April 2026): the current artifact is both. Keep that in mind when refactoring.

---

## R2a — Searchable Snapshot

**Producer:** `indexer.index_repo(repo_path, include_exts, exclude_dirs)` returns:

```python
{
  "root": str,              # absolute repo path
  "files": dict[str, FileRecord],  # keyed by relative path (forward-slash)
  "file_count": int,
  "symbol_count": int,
  "elapsed_ms": int,
}
```

**FileRecord** (per file):

| Field | Type | Purpose |
|---|---|---|
| `path` | `str` | relative, forward-slash path |
| `language` | `str` | one of: typescript, tsx, javascript, python |
| `lines` | `list[str]` | full file content (line-split) — used by `get_context` |
| `symbols` | `list[Symbol]` | definitions found via tags.scm |
| `references` | `list[Reference]` | calls + instantiations found via tags.scm |
| `imports` | `list[str]` | raw import source strings |

**Symbol**: `{name: str, kind: str, line: int}` where `kind ∈ {class, function, method, interface, type, enum}`.

**Reference**: `{name: str, kind: str, line: int}` where `kind ∈ {call, class}`.

**Consumer methods using R2a:**
- `search(query, limit)` → substring match over `lines`
- `find_symbol(name)` → lookup in `_symbol_to_files` map
- `get_context(file, line_numbers, window)` → slice of `lines`
- `get_file_summary(file)` → metadata from `FileRecord`
- `list_files()` → keys of `files` dict

---

## R2b — Graph Substrate

**Producer:** `CodebaseGraph.__init__(index_result)` builds a rustworkx `PyDiGraph` where:

- **Nodes:** file paths (one node per file, node data = path)
- **Edges:** directed `A → B` when file A references at least one symbol defined in file B
- **Edge weight:** count of references from A to B
- **Self-loops:** skipped

**Guarantees:**
- `len(nodes) == file_count`
- Edges are deduplicated: exactly one edge per (src, dst) ordered pair
- Weights are positive integers

**Derived:**

| Computation | Method | Backend |
|---|---|---|
| PageRank (personalized optional) | `pagerank(limit, personalization)` | rustworkx |
| HITS hubs+authorities | `hits(limit)` | rustworkx |
| Louvain communities | `communities()` | networkx |

**Consumer methods using R2b:**
- `top_files(limit)` → PageRank ranking
- `hits(limit)` → `{hubs: [(path, score)], authorities: [(path, score)]}`
- `communities()` → `{community_id: [file_paths]}`
- `show_dependents(file)` → predecessors in graph → `[(path, weight)]`
- `show_dependencies(file)` → successors → `[(path, weight)]`
- `trace_path(from, to, max_depth)` → shortest path in graph

---

## Stats Shape (Consumer Introspection)

`CodebaseGraph.stats()` returns the contract fingerprint:

```python
{
  "schema_version": "0.2.0",
  "file_count": int,
  "edge_count": int,
  "symbol_count": int,
  "reference_count": int,
  "unique_symbols": int,
}
```

This is the stable introspection surface. TypeScript clients use `CodebaseStats` in `src/repl/types.ts` to match.

---

## Language Support

| Language | Extensions | Grammar | Tags Query |
|---|---|---|---|
| TypeScript | `.ts` | tree-sitter-language-pack / typescript | `TAGS_TYPESCRIPT` |
| TSX | `.tsx` | tree-sitter-language-pack / tsx | `TAGS_TYPESCRIPT` |
| JavaScript | `.js`, `.jsx`, `.mjs`, `.cjs` | tree-sitter-language-pack / javascript | `TAGS_JAVASCRIPT` |
| Python | `.py` | tree-sitter-language-pack / python | `TAGS_PYTHON` |

Add more languages by:
1. Adding an extension → language mapping to `LANGUAGE_BY_EXT`
2. Adding a tags query constant to `TAGS_BY_LANG`
3. Ensuring the grammar is available in `tree-sitter-language-pack`

---

## Known Limitations (v0.2)

- **No cross-language resolution.** A TS file calling a Python extension via subprocess gets no cross-lang edge.
- **Name collision.** If two files define symbols with the same name (e.g., two `execute` methods), references to that symbol create edges to BOTH defining files. Over-connected but not incorrect.
- **No symbol-level graph.** Only file-level. Symbol-to-symbol dependencies are implicit in file-to-file edges.
- **No incremental update.** Full re-index on every `index` op. Phase 5/6 will add file-watch + delta updates.
- **Content inline with structure.** `lines` is stored per FileRecord, so the artifact is memory-heavy. Acceptable for v0.2 (same-process Python), will need splitting when we persist to disk.

---

## Version History

- **0.2.0** (April 5, 2026) — First contract formalization. Post-Codex audit. Same in-memory representation as un-versioned v0.1 but explicitly documented as dual R2a/R2b.
- **0.1.x** (pre) — Spike regex-based indexer. No real graph edges. Deprecated.
