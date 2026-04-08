"""
CodebaseGraph — the `codebase` object exposed in the REPL namespace.

Wraps the indexer output into a rustworkx graph with:
  - PageRank (personalized via seed vector)
  - HITS (hub + authority scores)
  - Louvain community detection
  - Search, get_context, cluster_by_file, show_dependents, show_dependencies

Files are nodes. Edges: file A references symbol X defined in file B → A→B edge,
weight = number of references from A to B.
"""
from __future__ import annotations

from collections import defaultdict, OrderedDict
from typing import Optional
import rustworkx as rx

from judgment import (
    tokenize_identifier,
    jaccard,
    detect_casing,
    normalize_code_window,
    ast_shape_hash,
    ast_shape_sequence,
    hash_sequence_similarity,
    extract_topic_tokens,
)

# Languages we can parse for AST-based judgment. Keep aligned with indexer.
_LANG_BY_EXT = {
    ".ts": "typescript", ".tsx": "tsx",
    ".js": "javascript", ".jsx": "javascript",
    ".mjs": "javascript", ".cjs": "javascript",
    ".py": "python",
}

# Node types that count as "function-like" top-level units per language.
_FUNCTION_NODE_TYPES = {
    "typescript": {
        "function_declaration", "method_definition", "class_declaration",
        "abstract_class_declaration", "interface_declaration",
        "type_alias_declaration", "enum_declaration", "arrow_function",
        "function_expression", "generator_function_declaration",
    },
    "tsx": {
        "function_declaration", "method_definition", "class_declaration",
        "abstract_class_declaration", "interface_declaration",
        "type_alias_declaration", "enum_declaration", "arrow_function",
        "function_expression", "generator_function_declaration",
    },
    "javascript": {
        "function_declaration", "method_definition", "class_declaration",
        "arrow_function", "function_expression", "generator_function_declaration",
    },
    "python": {
        "function_definition", "async_function_definition", "class_definition",
    },
}

# Lazy parser cache — populated on first use per language
_PARSER_CACHE: dict = {}


def _get_cached_parser(language: str):
    """Lazy-init tree-sitter parser. Returns None if language unsupported."""
    if language in _PARSER_CACHE:
        return _PARSER_CACHE[language]
    try:
        from tree_sitter_language_pack import get_parser
        parser = get_parser(language)
        _PARSER_CACHE[language] = parser
        return parser
    except Exception:
        _PARSER_CACHE[language] = None
        return None


class CodebaseGraph:
    def __init__(self, index_result: dict):
        self.root: str = index_result["root"]
        self.files: dict = index_result["files"]  # path -> FileRecord
        self.file_count: int = index_result["file_count"]

        # Build symbol_to_file: symbol_name -> set of files that define it
        self._symbol_to_files: dict[str, set[str]] = defaultdict(set)
        for path, rec in self.files.items():
            for sym in rec.symbols:
                self._symbol_to_files[sym.name].add(path)

        # Build rustworkx directed graph
        self._graph = rx.PyDiGraph()
        self._node_ids: dict[str, int] = {}
        self._id_to_path: dict[int, str] = {}

        # Add all files as nodes
        for path in self.files:
            nid = self._graph.add_node(path)
            self._node_ids[path] = nid
            self._id_to_path[nid] = path

        # Add edges: for each reference in A, if defined in B, add edge A→B
        edge_weights: dict[tuple[int, int], int] = defaultdict(int)
        for path, rec in self.files.items():
            if path not in self._node_ids:
                continue
            src_id = self._node_ids[path]
            for ref in rec.references:
                defining_files = self._symbol_to_files.get(ref.name, set())
                for def_path in defining_files:
                    if def_path == path:
                        continue  # skip self-reference
                    dst_id = self._node_ids[def_path]
                    edge_weights[(src_id, dst_id)] += 1

        for (src, dst), weight in edge_weights.items():
            self._graph.add_edge(src, dst, weight)

        self._edge_count = len(edge_weights)

        # Compute rankings lazily (populated on first access)
        self._pagerank: Optional[dict[str, float]] = None
        self._hub: Optional[dict[str, float]] = None
        self._authority: Optional[dict[str, float]] = None
        self._communities: Optional[dict[str, int]] = None

        # Phase 8 judgment caches (lazy, LRU-bounded)
        self._tree_cache: "OrderedDict[str, object]" = OrderedDict()
        self._shapes_cache: "OrderedDict[str, list[dict]]" = OrderedDict()
        self._TREE_CACHE_MAX = 100
        self._SHAPES_CACHE_MAX = 200

    # -------- Stats --------

    @property
    def edge_count(self) -> int:
        return self._edge_count

    SCHEMA_VERSION = "0.2.0"

    def stats(self) -> dict:
        return {
            "schema_version": self.SCHEMA_VERSION,
            "root": self.root,
            "file_count": self.file_count,
            "edge_count": self._edge_count,
            "symbol_count": sum(len(r.symbols) for r in self.files.values()),
            "reference_count": sum(len(r.references) for r in self.files.values()),
            "unique_symbols": len(self._symbol_to_files),
        }

    # -------- Rankings --------

    def _ensure_pagerank(self, personalization: Optional[dict[str, float]] = None):
        if self._pagerank is not None and personalization is None:
            return self._pagerank
        try:
            pers_vec = None
            if personalization:
                pers_vec = {
                    self._node_ids[p]: w
                    for p, w in personalization.items()
                    if p in self._node_ids
                }
            result = rx.pagerank(self._graph, personalization=pers_vec)
            scores = {self._id_to_path[nid]: score for nid, score in result.items()}
            if personalization is None:
                self._pagerank = scores
            return scores
        except Exception as e:
            print(f"[codebase] pagerank failed: {e}")
            return {p: 1.0 / max(1, self.file_count) for p in self.files}

    def _ensure_hits(self):
        if self._hub is not None:
            return self._hub, self._authority
        try:
            hits_result = rx.hits(self._graph)
            # rustworkx returns (hubs, authorities) as two CentralityMapping objects
            if isinstance(hits_result, tuple) and len(hits_result) == 2:
                hubs_raw, auths_raw = hits_result
                self._hub = {self._id_to_path[nid]: s for nid, s in hubs_raw.items()}
                self._authority = {self._id_to_path[nid]: s for nid, s in auths_raw.items()}
            else:
                # Fallback if API differs
                self._hub = {p: 0.0 for p in self.files}
                self._authority = {p: 0.0 for p in self.files}
        except Exception as e:
            print(f"[codebase] hits failed: {e}")
            self._hub = {p: 0.0 for p in self.files}
            self._authority = {p: 0.0 for p in self.files}
        return self._hub, self._authority

    def _ensure_communities(self):
        if self._communities is not None:
            return self._communities
        # rustworkx has no Louvain; use networkx (already a common dep)
        try:
            import networkx as nx
            from networkx.algorithms import community as nxc

            # Build an undirected networkx graph from edge weights
            nxg = nx.Graph()
            for path in self.files:
                nxg.add_node(path)
            for (src_id, dst_id), _ in self._iter_edges():
                src_path = self._id_to_path[src_id]
                dst_path = self._id_to_path[dst_id]
                weight = self._graph.get_edge_data(src_id, dst_id) or 1
                if nxg.has_edge(src_path, dst_path):
                    nxg[src_path][dst_path]["weight"] += weight
                else:
                    nxg.add_edge(src_path, dst_path, weight=weight)

            partitions = nxc.louvain_communities(nxg, weight="weight", seed=42)
            comm_map: dict[str, int] = {}
            for comm_id, members in enumerate(partitions):
                for path in members:
                    comm_map[path] = comm_id
            self._communities = comm_map
        except Exception as e:
            print(f"[codebase] louvain failed: {e}")
            self._communities = {p: 0 for p in self.files}
        return self._communities

    def _iter_edges(self):
        """Yield ((src_id, dst_id), edge_data) for all edges in the graph."""
        for edge_idx in self._graph.edge_indices():
            endpoints = self._graph.get_edge_endpoints_by_index(edge_idx)
            if endpoints:
                yield endpoints, self._graph.get_edge_data_by_index(edge_idx)

    def pagerank(self, limit: Optional[int] = None, personalization: Optional[dict[str, float]] = None) -> list[tuple[str, float]]:
        """Return files ranked by PageRank (desc). Optional personalization seed."""
        scores = self._ensure_pagerank(personalization)
        items = sorted(scores.items(), key=lambda x: -x[1])
        return items[:limit] if limit else items

    def hits(self, limit: Optional[int] = None) -> dict:
        """Return {hubs: [(path, score)], authorities: [(path, score)]}."""
        hubs, auths = self._ensure_hits()
        h = sorted(hubs.items(), key=lambda x: -x[1])
        a = sorted(auths.items(), key=lambda x: -x[1])
        return {
            "hubs": h[:limit] if limit else h,
            "authorities": a[:limit] if limit else a,
        }

    def communities(self) -> dict[int, list[str]]:
        """Return {community_id: [file_paths]}."""
        comm_map = self._ensure_communities()
        out: dict[int, list[str]] = defaultdict(list)
        for path, cid in comm_map.items():
            out[cid].append(path)
        return dict(out)

    # -------- Search --------

    def search(self, query: str, limit: int = 50) -> list[dict]:
        """
        Search for a term across file contents. Returns list of:
          {file, line, snippet}
        Case-insensitive substring match.
        """
        q = query.lower()
        results = []
        for path, rec in self.files.items():
            for i, line in enumerate(rec.lines, start=1):
                if q in line.lower():
                    results.append({
                        "file": path,
                        "line": i,
                        "snippet": line.strip()[:200],
                    })
                    if len(results) >= limit:
                        return results
        return results

    def find_symbol(self, name: str) -> list[dict]:
        """Find where a symbol is defined. Returns list of {file, line, kind}."""
        out = []
        for path in self._symbol_to_files.get(name, set()):
            rec = self.files[path]
            for sym in rec.symbols:
                if sym.name == name:
                    out.append({"file": path, "line": sym.line, "kind": sym.kind})
        return out

    # -------- Graph navigation --------

    def show_dependents(self, file_path: str) -> list[tuple[str, int]]:
        """Files that reference symbols defined in file_path. Returns [(path, weight)]."""
        if file_path not in self._node_ids:
            return []
        nid = self._node_ids[file_path]
        out = []
        for pred_id in self._graph.predecessor_indices(nid):
            edge_data = self._graph.get_edge_data(pred_id, nid)
            out.append((self._id_to_path[pred_id], edge_data or 1))
        return sorted(out, key=lambda x: -x[1])

    def show_dependencies(self, file_path: str) -> list[tuple[str, int]]:
        """Files whose symbols file_path references. Returns [(path, weight)]."""
        if file_path not in self._node_ids:
            return []
        nid = self._node_ids[file_path]
        out = []
        for succ_id in self._graph.successor_indices(nid):
            edge_data = self._graph.get_edge_data(nid, succ_id)
            out.append((self._id_to_path[succ_id], edge_data or 1))
        return sorted(out, key=lambda x: -x[1])

    def trace_path(self, from_file: str, to_file: str, max_depth: int = 5) -> Optional[list[str]]:
        """Shortest path between two files in the reference graph."""
        if from_file not in self._node_ids or to_file not in self._node_ids:
            return None
        src = self._node_ids[from_file]
        dst = self._node_ids[to_file]
        try:
            paths = rx.all_shortest_paths(self._graph, src, dst)
            if paths:
                first = list(paths[0])
                if len(first) <= max_depth + 1:
                    return [self._id_to_path[i] for i in first]
            return None
        except Exception:
            return None

    # -------- Context --------

    def cluster_by_file(self, matches: list[dict]) -> dict[str, list[dict]]:
        """Group match dicts by 'file' field."""
        out: dict[str, list[dict]] = defaultdict(list)
        for m in matches:
            out[m["file"]].append(m)
        return dict(out)

    def get_context(
        self,
        file_path: str,
        line_numbers: Optional[list[int]] = None,
        window: int = 5,
    ) -> str:
        """
        Return context window around specific lines, or file preview.
        """
        if file_path not in self.files:
            return f"(file not found: {file_path})"

        rec = self.files[file_path]
        lines = rec.lines

        if line_numbers is None:
            preview = "\n".join(f"{i+1:4d}  {l}" for i, l in enumerate(lines[:40]))
            return f"=== {file_path} (first 40 lines of {len(lines)}) ===\n{preview}"

        # Merge overlapping windows
        ranges: list[tuple[int, int]] = []
        for ln in sorted(set(line_numbers)):
            start = max(1, ln - window)
            end = min(len(lines), ln + window)
            if ranges and start <= ranges[-1][1] + 2:
                ranges[-1] = (ranges[-1][0], max(end, ranges[-1][1]))
            else:
                ranges.append((start, end))

        segments = []
        for start, end in ranges:
            block = []
            for i in range(start, end + 1):
                if 1 <= i <= len(lines):
                    block.append(f"{i:4d}  {lines[i-1]}")
            segments.append("\n".join(block))
        body = "\n  ...\n".join(segments)
        return f"=== {file_path} ===\n{body}"

    def get_file_summary(self, file_path: str) -> dict:
        """Return metadata about a file: symbols, size, line count."""
        if file_path not in self.files:
            return {"error": f"not found: {file_path}"}
        rec = self.files[file_path]
        return {
            "path": file_path,
            "language": rec.language,
            "line_count": len(rec.lines),
            "symbols": [s.to_dict() for s in rec.symbols],
            "reference_count": len(rec.references),
            "import_count": len(rec.imports),
        }

    def list_files(self) -> list[str]:
        return sorted(self.files.keys())

    def top_files(self, limit: int = 10) -> list[dict]:
        """Top N files by PageRank with basic metadata."""
        ranked = self.pagerank(limit=limit)
        out = []
        for path, score in ranked:
            rec = self.files[path]
            out.append({
                "path": path,
                "pagerank": round(score, 4),
                "symbols": len(rec.symbols),
                "references": len(rec.references),
            })
        return out

    # -------- Ambient Signature Compilation --------

    # Content density per level — controls what goes in the signature.
    LEVEL_CONFIG: dict = {
        "lean": {
            "top_files": 3, "authorities": 3, "hubs": 3,
            "modules": 3, "type_hubs": 3,
            "symbols_per_file": 0,
            "include_descriptors": False,
            "include_def_files": False,
            "include_module_files": False,
            "include_first_comment": False,
        },
        "standard": {
            "top_files": 5, "authorities": 5, "hubs": 5,
            "modules": 8, "type_hubs": 6,
            "symbols_per_file": 4,
            "include_descriptors": True,
            "include_def_files": True,
            "include_module_files": False,
            "include_first_comment": False,
        },
        "deep": {
            "top_files": 8, "authorities": 8, "hubs": 8,
            "modules": 12, "type_hubs": 10,
            "symbols_per_file": 8,
            "include_descriptors": True,
            "include_def_files": True,
            "include_module_files": True,
            "include_first_comment": True,
        },
        "max": {
            "top_files": 15, "authorities": 12, "hubs": 12,
            "modules": 20, "type_hubs": 15,
            "symbols_per_file": 16,
            "include_descriptors": True,
            "include_def_files": True,
            "include_module_files": True,
            "include_first_comment": True,
        },
    }

    def _file_descriptor(self, path: str, symbols_per_file: int = 4) -> str:
        """
        Produce a one-line descriptor for a file.
        Lists top N symbol names (where N = symbols_per_file).
        """
        rec = self.files.get(path)
        if not rec or not rec.symbols or symbols_per_file <= 0:
            return ""
        names = []
        for sym in rec.symbols[:symbols_per_file]:
            names.append(sym.name)
        return ", ".join(names)

    def _file_first_comment(self, path: str) -> str:
        """Extract the first comment line from a file (for deep/max levels)."""
        rec = self.files.get(path)
        if not rec:
            return ""
        for line in rec.lines[:8]:
            stripped = line.strip()
            if not stripped:
                continue
            if stripped.startswith("//"):
                return stripped.lstrip("/ ").strip()[:120]
            if stripped.startswith("/**") or stripped.startswith("/*"):
                content = stripped.lstrip("/*").strip()
                if content:
                    return content[:120]
            if stripped.startswith("*") and not stripped.startswith("*/"):
                return stripped.lstrip("* ").strip()[:120]
            # First non-comment line — stop looking
            if stripped.startswith("import") or stripped.startswith("export") or stripped.startswith("from"):
                return ""
        return ""

    def _community_label(self, members: list[str]) -> str:
        """
        Generate a human-readable label for a community via majority-directory
        heuristic. Returns the most common top-level directory among members,
        with coverage annotation when mixed.
        """
        if not members:
            return "empty"

        from collections import Counter
        top_dirs = Counter()
        for m in members:
            if "/" in m:
                top_dirs[m.split("/")[0] + "/"] += 1
            else:
                top_dirs["root"] += 1

        if not top_dirs:
            return "root"

        majority, count = top_dirs.most_common(1)[0]
        total = len(members)
        if count == total:
            return majority  # pure cluster
        if count >= total * 0.75:
            return f"{majority} (+mixed)"
        # Mixed — list top 2 dirs
        top_two = top_dirs.most_common(2)
        if len(top_two) >= 2:
            return f"{top_two[0][0]} + {top_two[1][0]}"
        return majority

    def _type_hubs(self, limit: int = 5) -> list[dict]:
        """
        Find the most-referenced type/interface/class symbols.
        Uses text search across file contents (catches type annotations
        and generic args that the tags query misses).
        Returns [{name, kind, def_file, reference_count}].
        """
        import re
        # Find all type-like definitions
        type_kinds = {"type", "interface", "class", "enum"}
        name_to_def: dict[str, tuple[str, str]] = {}
        for path, rec in self.files.items():
            for sym in rec.symbols:
                if sym.kind in type_kinds:
                    name_to_def.setdefault(sym.name, (sym.kind, path))

        # Count files mentioning each type name (excluding def file)
        # Use word-boundary regex to avoid substring matches
        scored: list[tuple[str, int]] = []
        for name, (kind, def_file) in name_to_def.items():
            # Skip too-short or too-common names (noise)
            if len(name) < 3:
                continue
            pattern = re.compile(r"\b" + re.escape(name) + r"\b")
            ref_files = 0
            for path, rec in self.files.items():
                if path == def_file:
                    continue
                content = "\n".join(rec.lines)
                if pattern.search(content):
                    ref_files += 1
            if ref_files > 0:
                scored.append((name, ref_files))

        scored.sort(key=lambda x: -x[1])
        out = []
        for name, count in scored[:limit]:
            kind, def_file = name_to_def[name]
            out.append({
                "name": name,
                "kind": kind,
                "def_file": def_file,
                "reference_count": count,
            })
        return out

    def signature(self, level: str = "standard", max_tokens: int = 1500) -> dict:
        """
        Compile the codebase ambient signature — a structural summary
        loaded into model context every turn as stable prefix.

        Args:
          level: "lean" | "standard" | "deep" | "max" — content density
          max_tokens: hard cap. If rendered markdown exceeds, progressively trim.

        Level determines WHAT goes in. max_tokens determines WHERE TO STOP.
        """
        if level not in self.LEVEL_CONFIG:
            level = "standard"
        cfg = self.LEVEL_CONFIG[level]

        hits = self.hits(limit=cfg["hubs"] + cfg["authorities"])
        top_pr = self.pagerank(limit=cfg["top_files"] + 2)
        communities = self.communities()
        type_hubs = self._type_hubs(limit=cfg["type_hubs"])
        spf = cfg["symbols_per_file"]

        def _make_entry(path, score):
            entry = {"path": path, "score": round(score, 4)}
            if cfg["include_descriptors"]:
                entry["descriptor"] = self._file_descriptor(path, symbols_per_file=spf)
            if cfg["include_first_comment"]:
                entry["comment"] = self._file_first_comment(path)
            return entry

        # Entry points: top by PageRank
        entry_points = [_make_entry(p, s) for p, s in top_pr[:cfg["top_files"]]]

        # Authorities: top HITS authorities (foundational)
        authorities = [_make_entry(p, s) for p, s in hits["authorities"][:cfg["authorities"]]]

        # Hubs: top HITS hubs (orchestrators)
        hubs = [_make_entry(p, s) for p, s in hits["hubs"][:cfg["hubs"]]]

        # Modules: multi-file communities only
        pr_all = self._ensure_pagerank()
        modules = []
        for cid, members in sorted(communities.items()):
            if len(members) < 2:
                continue
            label = self._community_label(members)
            members_sorted = sorted(members, key=lambda p: -pr_all.get(p, 0))
            mod = {
                "label": label,
                "file_count": len(members),
                "sample": members_sorted[:3],
            }
            if cfg["include_module_files"]:
                # Include full file list at deep/max (capped)
                mod["files"] = members_sorted[: min(len(members), 10)]
            modules.append(mod)
        modules.sort(key=lambda m: -m["file_count"])
        modules = modules[: cfg["modules"]]

        # Strip descriptors for hubs/authorities at lean (keep paths only)
        if not cfg["include_descriptors"]:
            for lst in (entry_points, authorities, hubs):
                for e in lst:
                    e.pop("descriptor", None)

        stats = self.stats()
        signature = {
            "level": level,
            "stats": {
                "file_count": stats["file_count"],
                "edge_count": stats["edge_count"],
                "symbol_count": stats["symbol_count"],
            },
            "entry_points": entry_points,
            "authorities": authorities,
            "hubs": hubs,
            "modules": modules,
            "type_hubs": type_hubs,
        }

        # Render + progressive trim to budget
        md = self._render_markdown(signature)
        # Progressive trim order: shed modules → type_hubs → hubs → authorities → entry_points
        while len(md) > max_tokens * 4 and len(signature["modules"]) > 2:
            signature["modules"] = signature["modules"][:-1]
            md = self._render_markdown(signature)
        while len(md) > max_tokens * 4 and len(signature["type_hubs"]) > 2:
            signature["type_hubs"] = signature["type_hubs"][:-1]
            md = self._render_markdown(signature)
        while len(md) > max_tokens * 4 and len(signature["hubs"]) > 3:
            signature["hubs"] = signature["hubs"][:-1]
            md = self._render_markdown(signature)
        while len(md) > max_tokens * 4 and len(signature["authorities"]) > 3:
            signature["authorities"] = signature["authorities"][:-1]
            md = self._render_markdown(signature)

        signature["markdown"] = md
        signature["approx_tokens"] = len(md) // 4
        signature["schema_version"] = self.SCHEMA_VERSION
        return signature

    def _render_markdown(self, sig: dict) -> str:
        """Render signature dict to compact markdown."""
        lines = []
        s = sig["stats"]
        lines.append(
            f"# Codebase: {s['file_count']} files, {s['edge_count']} edges, {s['symbol_count']} symbols"
        )
        lines.append("")

        def _render_file_entry(e: dict) -> str:
            desc_parts = []
            if "descriptor" in e and e["descriptor"]:
                desc_parts.append(e["descriptor"])
            if "comment" in e and e["comment"]:
                desc_parts.append(f"// {e['comment']}")
            suffix = " — " + " · ".join(desc_parts) if desc_parts else ""
            return f"- `{e['path']}`{suffix}"

        if sig["entry_points"]:
            lines.append("## Top (by PageRank)")
            for ep in sig["entry_points"]:
                lines.append(_render_file_entry(ep))
            lines.append("")
        if sig["authorities"]:
            lines.append("## Authorities (foundational — referenced widely)")
            for a in sig["authorities"]:
                lines.append(_render_file_entry(a))
            lines.append("")
        if sig["hubs"]:
            lines.append("## Hubs (orchestrators — reference many)")
            for h in sig["hubs"]:
                lines.append(_render_file_entry(h))
            lines.append("")
        if sig["modules"]:
            lines.append("## Modules")
            for m in sig["modules"]:
                if "files" in m and m["files"]:
                    files = ", ".join(f"`{p}`" for p in m["files"])
                    lines.append(f"- **{m['label']}** ({m['file_count']} files): {files}")
                else:
                    sample = ", ".join(f"`{p}`" for p in m["sample"])
                    lines.append(f"- **{m['label']}** ({m['file_count']} files): {sample}")
            lines.append("")
        if sig["type_hubs"]:
            lines.append("## Type Hubs (widely referenced types)")
            for t in sig["type_hubs"]:
                lines.append(
                    f"- `{t['name']}` ({t['kind']}) — {t['reference_count']} refs, defined in `{t['def_file']}`"
                )
        return "\n".join(lines).rstrip()

    # ════════════════════════════════════════════════════════════════════════
    # Post-edit refresh — re-parse changed files without full reindex
    # ════════════════════════════════════════════════════════════════════════

    def refresh_files(self, paths: list[str], root_dir: str) -> dict:
        """
        Re-parse specific files from disk and update the graph in-place.
        Call after Edit/Write to keep the codebase view current.

        Args:
          paths: list of relative paths (as stored in self.files)
          root_dir: absolute path to repo root

        Returns: {refreshed: [...], errors: [...]}
        """
        from pathlib import Path
        refreshed: list[str] = []
        errors: list[str] = []

        for rel_path in paths:
            full = Path(root_dir) / rel_path
            if not full.exists():
                errors.append(f"not found: {rel_path}")
                continue
            try:
                from indexer import index_file
                record = index_file(full, rel_path)
                if record is None:
                    errors.append(f"parse failed: {rel_path}")
                    continue

                # Update file record
                old_rec = self.files.get(rel_path)
                self.files[rel_path] = record

                # Update symbol index
                # Remove old symbols for this file
                for sym_name in list(self._symbol_to_files.keys()):
                    self._symbol_to_files[sym_name].discard(rel_path)
                    if not self._symbol_to_files[sym_name]:
                        del self._symbol_to_files[sym_name]
                # Add new symbols
                for sym in record.symbols:
                    self._symbol_to_files[sym.name].add(rel_path)

                # Rebuild edges for this file
                nid = self._node_ids.get(rel_path)
                if nid is not None:
                    # Remove all edges from/to this node
                    edges_to_remove = []
                    for edge_idx in self._graph.edge_indices():
                        endpoints = self._graph.get_edge_endpoints_by_index(edge_idx)
                        if endpoints and (endpoints[0] == nid or endpoints[1] == nid):
                            edges_to_remove.append(edge_idx)
                    for idx in sorted(edges_to_remove, reverse=True):
                        self._graph.remove_edge_by_index(idx)

                    # Re-add edges from this file
                    edge_weights: dict[int, int] = defaultdict(int)
                    for ref in record.references:
                        defining_files = self._symbol_to_files.get(ref.name, set())
                        for def_path in defining_files:
                            if def_path == rel_path:
                                continue
                            dst_id = self._node_ids.get(def_path)
                            if dst_id is not None:
                                edge_weights[dst_id] += 1
                    for dst_id, weight in edge_weights.items():
                        self._graph.add_edge(nid, dst_id, weight)

                    # Re-add edges TO this file from other files
                    new_syms = {s.name for s in record.symbols}
                    for other_path, other_rec in self.files.items():
                        if other_path == rel_path:
                            continue
                        other_nid = self._node_ids.get(other_path)
                        if other_nid is None:
                            continue
                        w = 0
                        for ref in other_rec.references:
                            if ref.name in new_syms:
                                w += 1
                        if w > 0:
                            self._graph.add_edge(other_nid, nid, w)

                # Invalidate caches
                self._pagerank = None
                self._hub = None
                self._authority = None
                self._communities = None
                self._shapes_cache.pop(rel_path, None)
                self._tree_cache.pop(rel_path, None)

                refreshed.append(rel_path)
            except Exception as e:
                errors.append(f"{rel_path}: {e}")

        self._edge_count = sum(1 for _ in self._graph.edge_indices())
        return {"refreshed": refreshed, "errors": errors}

    # ════════════════════════════════════════════════════════════════════════
    # Phase 8 — Judgment Tools
    # ════════════════════════════════════════════════════════════════════════

    # ---- Language + AST helpers -------------------------------------------

    def _language_for_path(self, path: str) -> Optional[str]:
        """Infer language from file extension. None if unsupported."""
        lower = path.lower()
        for ext, lang in _LANG_BY_EXT.items():
            if lower.endswith(ext):
                return lang
        # Fall back to FileRecord.language if already indexed
        rec = self.files.get(path)
        if rec:
            return getattr(rec, "language", None)
        return None

    def _dominant_language(self) -> Optional[str]:
        """Return the most common language across indexed files."""
        if hasattr(self, "_cached_dom_lang"):
            return self._cached_dom_lang
        counts: dict[str, int] = defaultdict(int)
        for rec in self.files.values():
            lang = getattr(rec, "language", None)
            if lang:
                counts[lang] += 1
        self._cached_dom_lang = max(counts, key=counts.get) if counts else None
        return self._cached_dom_lang

    def _cache_get(self, cache: OrderedDict, key: str, max_size: int):
        if key in cache:
            cache.move_to_end(key)
            return cache[key]
        return None

    def _cache_put(self, cache: OrderedDict, key: str, value, max_size: int):
        cache[key] = value
        cache.move_to_end(key)
        while len(cache) > max_size:
            cache.popitem(last=False)

    def _get_tree(self, path: str):
        """LRU-cached parse tree for a file. Returns None if unsupported/unparseable."""
        hit = self._cache_get(self._tree_cache, path, self._TREE_CACHE_MAX)
        if hit is not None:
            return hit
        language = self._language_for_path(path)
        if not language:
            return None
        parser = _get_cached_parser(language)
        if parser is None:
            return None
        rec = self.files.get(path)
        if not rec:
            return None
        try:
            src = "\n".join(rec.lines).encode("utf-8", errors="replace")
            tree = parser.parse(src)
            self._cache_put(self._tree_cache, path, tree, self._TREE_CACHE_MAX)
            return tree
        except Exception:
            return None

    def _parse_snippet(self, source: str, language: Optional[str] = None):
        """Parse a raw snippet. Returns tree or None."""
        lang = language or self._dominant_language()
        if not lang:
            return None
        parser = _get_cached_parser(lang)
        if parser is None:
            return None
        try:
            return parser.parse(source.encode("utf-8", errors="replace"))
        except Exception:
            return None

    def _iter_function_nodes(self, root_node, language: str):
        """
        Walk an AST and yield function-like nodes with metadata.
        Yields: {name, line, kind, node}
        """
        target_types = _FUNCTION_NODE_TYPES.get(language, set())
        if not target_types:
            return

        def _extract_name(node) -> str:
            # Find first identifier-like child
            for c in node.children:
                if c.type in ("identifier", "type_identifier", "property_identifier"):
                    try:
                        return node.text.decode("utf-8", errors="replace")[
                            c.start_byte - node.start_byte : c.end_byte - node.start_byte
                        ]
                    except Exception:
                        return ""
                # Also: check child_by_field_name if available (some grammars)
            return ""

        def walk(node):
            if node.type in target_types:
                yield {
                    "name": _extract_name(node),
                    "line": node.start_point[0] + 1,
                    "kind": node.type,
                    "node": node,
                }
            for c in node.children:
                yield from walk(c)

        yield from walk(root_node)

    def _file_shapes(self, path: str) -> list[dict]:
        """
        For each function-like node in file, return:
          {name, line, kind, shape_hash, seq}
        Cached per file.
        """
        hit = self._cache_get(self._shapes_cache, path, self._SHAPES_CACHE_MAX)
        if hit is not None:
            return hit
        tree = self._get_tree(path)
        lang = self._language_for_path(path)
        if tree is None or lang is None:
            self._cache_put(self._shapes_cache, path, [], self._SHAPES_CACHE_MAX)
            return []
        out: list[dict] = []
        for info in self._iter_function_nodes(tree.root_node, lang):
            node = info["node"]
            out.append({
                "name": info["name"],
                "line": info["line"],
                "kind": info["kind"],
                "shape_hash": ast_shape_hash(node, depth_limit=5),
                "seq": ast_shape_sequence(node, depth_limit=4),
            })
        self._cache_put(self._shapes_cache, path, out, self._SHAPES_CACHE_MAX)
        return out

    # ---- find_similar_patterns --------------------------------------------

    def find_similar_patterns(
        self,
        pattern,
        limit: int = 10,
        mode: str = "name",
    ) -> list[dict]:
        """
        Find symbols/patterns similar to the input.

        Modes:
          name      — pattern: str (symbol name). Jaccard over identifier tokens.
          signature — pattern: dict {kind?, name_contains?}. Direct filter.
          shape     — pattern: str (code snippet). AST shape-sequence similarity.

        Returns: list[{name, kind, file, line, score, snippet}]
        """
        if mode == "name":
            if not isinstance(pattern, str):
                return []
            query_tokens = set(tokenize_identifier(pattern))
            if not query_tokens:
                return []
            scored: list[dict] = []
            for sym_name, def_files in self._symbol_to_files.items():
                if sym_name == pattern:
                    continue
                sym_tokens = set(tokenize_identifier(sym_name))
                score = jaccard(query_tokens, sym_tokens)
                if score <= 0:
                    continue
                for def_file in def_files:
                    rec = self.files.get(def_file)
                    if not rec:
                        continue
                    for sym in rec.symbols:
                        if sym.name != sym_name:
                            continue
                        snippet = ""
                        if 0 < sym.line <= len(rec.lines):
                            snippet = rec.lines[sym.line - 1].strip()[:200]
                        scored.append({
                            "name": sym_name,
                            "kind": sym.kind,
                            "file": def_file,
                            "line": sym.line,
                            "score": round(score, 3),
                            "snippet": snippet,
                        })
                        break
            scored.sort(key=lambda x: -x["score"])
            return scored[:limit]

        if mode == "signature":
            if not isinstance(pattern, dict):
                return []
            kind_filter = pattern.get("kind")
            name_sub = (pattern.get("name_contains") or "").lower()
            out: list[dict] = []
            for path, rec in self.files.items():
                for sym in rec.symbols:
                    if kind_filter and sym.kind != kind_filter:
                        continue
                    if name_sub and name_sub not in sym.name.lower():
                        continue
                    snippet = ""
                    if 0 < sym.line <= len(rec.lines):
                        snippet = rec.lines[sym.line - 1].strip()[:200]
                    out.append({
                        "name": sym.name,
                        "kind": sym.kind,
                        "file": path,
                        "line": sym.line,
                        "score": 1.0,
                        "snippet": snippet,
                    })
                    if len(out) >= limit:
                        return out
            return out

        if mode == "shape":
            if not isinstance(pattern, str):
                return []
            tree = self._parse_snippet(pattern)
            if tree is None:
                return []
            lang = self._dominant_language()
            if not lang:
                return []
            # Take first function-like node from snippet; fall back to root
            query_seq = None
            for info in self._iter_function_nodes(tree.root_node, lang):
                query_seq = ast_shape_sequence(info["node"], depth_limit=4)
                break
            if query_seq is None:
                query_seq = ast_shape_sequence(tree.root_node, depth_limit=4)
            if not query_seq:
                return []
            scored: list[dict] = []
            for path in self.files:
                for shape in self._file_shapes(path):
                    sim = hash_sequence_similarity(query_seq, shape["seq"])
                    if sim < 0.3:
                        continue
                    rec = self.files[path]
                    snippet = ""
                    if 0 < shape["line"] <= len(rec.lines):
                        snippet = rec.lines[shape["line"] - 1].strip()[:200]
                    scored.append({
                        "name": shape["name"] or "(anonymous)",
                        "kind": shape["kind"],
                        "file": path,
                        "line": shape["line"],
                        "score": round(sim, 3),
                        "snippet": snippet,
                    })
            scored.sort(key=lambda x: -x["score"])
            return scored[:limit]

        raise ValueError(f"unknown mode: {mode!r}. Use 'name' | 'signature' | 'shape'.")

    # ---- suggest_location -------------------------------------------------

    def suggest_location(
        self,
        description: str,
        kind: str = "file",
        limit: int = 3,
    ) -> list[dict]:
        """
        Rank communities by relevance to a description.

        Returns: list[{community_id, label, sample_files, confidence, rationale}]
        """
        if not description or not description.strip():
            return []
        desc_tokens = set(tokenize_identifier(description))
        # Add whitespace-split tokens too (for multi-word descriptions)
        for w in description.lower().split():
            desc_tokens.add(w.strip(".,;:!?"))
        desc_tokens.discard("")

        communities = self.communities()
        pr_all = self._ensure_pagerank()
        scored: list[dict] = []

        for cid, members in communities.items():
            if len(members) < 1:
                continue
            label = self._community_label(members)
            members_sorted = sorted(members, key=lambda p: -pr_all.get(p, 0))
            sample = members_sorted[:3]

            # Score components
            label_tokens = set(tokenize_identifier(label.replace("/", " ").replace("(+mixed)", "")))
            label_score = jaccard(desc_tokens, label_tokens)

            # Symbol name overlap in top files
            symbol_tokens: set[str] = set()
            for p in members_sorted[:5]:
                rec = self.files.get(p)
                if not rec:
                    continue
                for sym in rec.symbols[:12]:
                    symbol_tokens.update(tokenize_identifier(sym.name))
            symbol_score = jaccard(desc_tokens, symbol_tokens)

            # Path/directory token overlap
            path_tokens: set[str] = set()
            for p in members_sorted[:5]:
                path_tokens.update(tokenize_identifier(p.replace("/", " ").replace(".", " ")))
            path_score = jaccard(desc_tokens, path_tokens)

            # Weighted composite
            confidence = 0.4 * label_score + 0.4 * symbol_score + 0.2 * path_score
            if confidence <= 0:
                continue

            # Rationale: which tokens matched
            matched = desc_tokens & (label_tokens | symbol_tokens | path_tokens)
            rationale_parts = []
            if label_score > 0:
                rationale_parts.append(f"label={label!r}")
            if symbol_score > 0:
                rationale_parts.append(f"symbols ({len(desc_tokens & symbol_tokens)} shared)")
            if path_score > 0:
                rationale_parts.append(f"paths ({len(desc_tokens & path_tokens)} shared)")
            rationale = "matches: " + ", ".join(rationale_parts)
            if matched:
                rationale += f" | tokens: {', '.join(sorted(matched)[:5])}"

            scored.append({
                "community_id": cid,
                "label": label,
                "file_count": len(members),
                "sample_files": sample,
                "confidence": round(confidence, 3),
                "rationale": rationale,
            })

        scored.sort(key=lambda x: -x["confidence"])
        return scored[:limit]

    # ---- find_convention --------------------------------------------------

    def find_convention(
        self,
        topic: str,
        limit: int = 5,
        authority_files: int = 15,
        min_files: int = 2,
    ) -> list[dict]:
        """
        Extract recurring patterns around a topic across high-authority files.

        A "convention" = normalized match-line pattern that repeats across
        at least `min_files` distinct top-PageRank files.

        Signature granularity: single line (the match line itself).
        Context: 3-line window shown in snippet output.

        Returns: list[{pattern, example_file, example_line, occurrence_count,
                       file_count, snippet, files}]
        """
        tokens = extract_topic_tokens(topic)
        if not tokens:
            return []

        # Top files by PageRank to scan
        top = [p for p, _ in self.pagerank(limit=authority_files)]
        if not top:
            return []

        # Group (normalized_line) -> list[(file, line)]
        groups: dict[str, list[tuple[str, int]]] = defaultdict(list)
        originals: dict[str, tuple[str, int, str]] = {}

        for path in top:
            rec = self.files.get(path)
            if not rec:
                continue
            lines = rec.lines
            for i, line in enumerate(lines):
                line_lower = line.lower()
                hit = False
                for tok in tokens:
                    if tok in line_lower:
                        hit = True
                        break
                if not hit:
                    continue
                normalized = normalize_code_window([line], mask_identifiers=True)
                if len(normalized) < 10:
                    continue
                groups[normalized].append((path, i + 1))
                if normalized not in originals:
                    # 3-line context window for display
                    ctx_lines = lines[max(0, i - 1) : min(len(lines), i + 2)]
                    ex_snippet = "\n".join(l.rstrip() for l in ctx_lines)
                    if len(ex_snippet) > 300:
                        ex_snippet = ex_snippet[:300] + "..."
                    originals[normalized] = (path, i + 1, ex_snippet)

        conventions: list[dict] = []
        for norm, occurrences in groups.items():
            unique_files = {p for p, _ in occurrences}
            if len(unique_files) < min_files:
                continue
            ex_file, ex_line, ex_snippet = originals[norm]
            conventions.append({
                "pattern": norm[:200],
                "example_file": ex_file,
                "example_line": ex_line,
                "occurrence_count": len(occurrences),
                "file_count": len(unique_files),
                "snippet": ex_snippet,
                "files": sorted(unique_files)[:8],
            })

        conventions.sort(key=lambda c: (-c["file_count"], -c["occurrence_count"]))
        return conventions[:limit]

    # ---- detect_duplication -----------------------------------------------

    def detect_duplication(
        self,
        snippet: str,
        threshold: float = 0.75,
        limit: int = 10,
        language: Optional[str] = None,
    ) -> list[dict]:
        """
        Find indexed functions/blocks similar to the input snippet.

        match_kind:
          "exact"      — shape hash identical
          "structural" — shape sequence similarity >= threshold
          "fuzzy"      — normalized-text match only (fallback)

        Returns: list[{file, line, name, kind, similarity, match_kind}]
        """
        lang = language or self._dominant_language()
        if not lang:
            return []
        tree = self._parse_snippet(snippet, language=lang)
        if tree is None:
            return []

        # Extract candidate nodes from snippet (top-level functions/classes/blocks).
        snippet_nodes: list[dict] = []
        for info in self._iter_function_nodes(tree.root_node, lang):
            snippet_nodes.append({
                "hash": ast_shape_hash(info["node"], depth_limit=5),
                "seq": ast_shape_sequence(info["node"], depth_limit=4),
            })
        # If no function-like nodes found, use whole tree
        if not snippet_nodes:
            snippet_nodes.append({
                "hash": ast_shape_hash(tree.root_node, depth_limit=5),
                "seq": ast_shape_sequence(tree.root_node, depth_limit=4),
            })

        # Normalized text fallback for fuzzy matching
        snippet_norm = normalize_code_window(snippet.split("\n"), mask_identifiers=True)

        scored: list[dict] = []
        for path in self.files:
            path_lang = self._language_for_path(path)
            if path_lang != lang and not (lang in ("typescript", "tsx") and path_lang in ("typescript", "tsx")):
                continue
            for shape in self._file_shapes(path):
                best_sim = 0.0
                best_kind = "fuzzy"
                for sn in snippet_nodes:
                    if sn["hash"] == shape["shape_hash"]:
                        best_sim = 1.0
                        best_kind = "exact"
                        break
                    sim = hash_sequence_similarity(sn["seq"], shape["seq"])
                    if sim > best_sim:
                        best_sim = sim
                        best_kind = "structural" if sim >= threshold else "fuzzy"
                if best_sim < threshold and best_kind != "exact":
                    continue
                rec = self.files[path]
                snippet_text = ""
                if 0 < shape["line"] <= len(rec.lines):
                    snippet_text = rec.lines[shape["line"] - 1].strip()[:200]
                scored.append({
                    "file": path,
                    "line": shape["line"],
                    "name": shape["name"] or "(anonymous)",
                    "kind": shape["kind"],
                    "similarity": round(best_sim, 3),
                    "match_kind": best_kind,
                    "snippet": snippet_text,
                })

        scored.sort(key=lambda x: -x["similarity"])
        return scored[:limit]

    # ---- is_consistent_with -----------------------------------------------

    def is_consistent_with(
        self,
        snippet: str,
        reference,
        criteria: str = "all",
        language: Optional[str] = None,
    ) -> dict:
        """
        Compare snippet against reference file(s) for style consistency.

        Args:
          snippet: code to evaluate
          reference: str (file path) | list[str] (multiple paths) | language keyword
          criteria: "naming" | "structure" | "imports" | "all"

        Returns: {deviation_score: float, findings: list[{aspect, expected, actual, severity}]}
        """
        # Resolve reference files
        ref_files: list[str] = []
        if isinstance(reference, list):
            ref_files = [p for p in reference if p in self.files]
        elif isinstance(reference, str):
            if reference in self.files:
                ref_files = [reference]
            else:
                # Treat as language keyword
                for path, rec in self.files.items():
                    if getattr(rec, "language", None) == reference:
                        ref_files.append(path)
                # Cap for performance
                ref_files = ref_files[:30]
        if not ref_files:
            return {
                "deviation_score": 0.0,
                "findings": [{
                    "aspect": "reference",
                    "expected": "at least one matching file",
                    "actual": "none found",
                    "severity": "error",
                }],
            }

        lang = language or self._language_for_path(ref_files[0]) or self._dominant_language()
        if not lang:
            return {"deviation_score": 0.0, "findings": []}

        findings: list[dict] = []
        component_scores: dict[str, float] = {}

        do_naming = criteria in ("naming", "all")
        do_structure = criteria in ("structure", "all")
        do_imports = criteria in ("imports", "all")

        # --- Parse snippet once ---
        snippet_tree = self._parse_snippet(snippet, language=lang)

        # --- NAMING ---
        if do_naming:
            # Per-language acceptable casings (pascal+camel both fine in JS/TS etc.)
            _ACCEPTABLE = {
                "typescript": {"camel", "pascal", "upper_snake"},
                "tsx": {"camel", "pascal", "upper_snake"},
                "javascript": {"camel", "pascal", "upper_snake"},
                "python": {"snake", "pascal", "upper_snake", "lower"},
            }
            # Reference casing distribution (observed from actual files)
            ref_casings: dict[str, int] = defaultdict(int)
            for p in ref_files:
                rec = self.files.get(p)
                if not rec:
                    continue
                for sym in rec.symbols:
                    c = detect_casing(sym.name)
                    if c not in ("empty", "mixed"):
                        ref_casings[c] += 1
            # Allowed = per-language defaults ∪ any observed casing with >5% share
            total_ref = sum(ref_casings.values()) or 1
            allowed = set(_ACCEPTABLE.get(lang, set()))
            for c, n in ref_casings.items():
                if n / total_ref >= 0.05:
                    allowed.add(c)
            allowed.discard("lower")  # single-word lower is ambiguous

            # Snippet casings
            snippet_names: list[str] = []
            if snippet_tree is not None:
                for info in self._iter_function_nodes(snippet_tree.root_node, lang):
                    if info["name"]:
                        snippet_names.append(info["name"])

            if snippet_names and allowed:
                mismatches = []
                for n in snippet_names:
                    c = detect_casing(n)
                    if c not in allowed and c not in ("empty", "mixed"):
                        mismatches.append((n, c))
                if mismatches:
                    component_scores["naming"] = len(mismatches) / len(snippet_names)
                    findings.append({
                        "aspect": "naming",
                        "expected": f"one of {{{', '.join(sorted(allowed))}}}",
                        "actual": ", ".join(f"{n}({c})" for n, c in mismatches[:3]),
                        "severity": "warn" if len(mismatches) < len(snippet_names) else "error",
                    })
                else:
                    component_scores["naming"] = 0.0
            else:
                component_scores["naming"] = 0.0

        # --- STRUCTURE ---
        if do_structure:
            # Reference shape-hash distribution
            ref_hashes: dict[str, int] = defaultdict(int)
            for p in ref_files:
                for shape in self._file_shapes(p):
                    ref_hashes[shape["shape_hash"]] += 1
            # Snippet shape hashes
            snippet_hashes: list[str] = []
            if snippet_tree is not None:
                for info in self._iter_function_nodes(snippet_tree.root_node, lang):
                    snippet_hashes.append(ast_shape_hash(info["node"], depth_limit=5))

            # Skip structure analysis on tiny samples (1-2 functions) —
            # novel shape there doesn't mean inconsistency.
            if len(snippet_hashes) >= 3 and ref_hashes:
                ref_set = set(ref_hashes.keys())
                novel = [h for h in snippet_hashes if h not in ref_set]
                structure_score = len(novel) / len(snippet_hashes)
                component_scores["structure"] = structure_score
                if structure_score > 0.7:
                    findings.append({
                        "aspect": "structure",
                        "expected": f"shapes common in reference ({len(ref_set)} distinct)",
                        "actual": f"{len(novel)}/{len(snippet_hashes)} novel shape(s)",
                        "severity": "warn" if structure_score < 0.9 else "info",
                    })
            else:
                component_scores["structure"] = 0.0

        # --- IMPORTS ---
        if do_imports:
            # Reference import styles
            ref_import_lines: list[str] = []
            for p in ref_files:
                rec = self.files.get(p)
                if not rec:
                    continue
                for line in rec.lines[:20]:
                    ls = line.strip()
                    if ls.startswith(("import ", "from ", "require(", "const ", "export ")) and (
                        "import" in ls or "require" in ls or "from" in ls
                    ):
                        ref_import_lines.append(ls)

            # Snippet imports
            snippet_imports: list[str] = []
            for line in snippet.split("\n")[:20]:
                ls = line.strip()
                if ls.startswith(("import ", "from ", "require(")) or (
                    ls.startswith("const ") and "require(" in ls
                ):
                    snippet_imports.append(ls)

            if snippet_imports and ref_import_lines:
                # Compare import-style patterns (does snippet use 'import from' if ref uses 'const require'?)
                ref_has_esm = any("import " in l and " from " in l for l in ref_import_lines)
                ref_has_cjs = any("require(" in l for l in ref_import_lines)
                snip_has_esm = any("import " in l and " from " in l for l in snippet_imports)
                snip_has_cjs = any("require(" in l for l in snippet_imports)

                mismatch = False
                if ref_has_esm and not ref_has_cjs and snip_has_cjs:
                    mismatch = True
                    findings.append({
                        "aspect": "imports",
                        "expected": "ESM imports (import/from)",
                        "actual": "CommonJS (require)",
                        "severity": "warn",
                    })
                elif ref_has_cjs and not ref_has_esm and snip_has_esm:
                    mismatch = True
                    findings.append({
                        "aspect": "imports",
                        "expected": "CommonJS (require)",
                        "actual": "ESM imports (import/from)",
                        "severity": "warn",
                    })
                component_scores["imports"] = 1.0 if mismatch else 0.0
            else:
                component_scores["imports"] = 0.0

        # Weighted composite
        weights = {"naming": 0.3, "structure": 0.5, "imports": 0.2}
        if criteria != "all":
            # Single-criterion: use its score directly
            deviation = component_scores.get(criteria, 0.0)
        else:
            total_w = 0.0
            total_score = 0.0
            for k, w in weights.items():
                if k in component_scores:
                    total_score += w * component_scores[k]
                    total_w += w
            deviation = total_score / total_w if total_w > 0 else 0.0

        return {
            "deviation_score": round(deviation, 3),
            "findings": findings,
            "component_scores": {k: round(v, 3) for k, v in component_scores.items()},
            "reference_file_count": len(ref_files),
        }
