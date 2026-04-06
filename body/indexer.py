"""
Tree-sitter based codebase indexer.

Walks a repository, parses each source file with the appropriate tree-sitter
grammar, and extracts:
  - Symbol definitions (class, function, method, interface, type, enum)
  - Symbol references (calls, class instantiations)
  - Imports (for file-dependency edges)

Output: structured dicts ready for CodebaseGraph to consume.

Uses tree-sitter-language-pack (bundles pre-built grammar binaries).
"""
from __future__ import annotations

import os
import time
from pathlib import Path
from typing import Optional

from tree_sitter_language_pack import get_parser, get_language
from tree_sitter import Query, QueryCursor


# -------- tags queries per language ---------------------------------------

TAGS_TYPESCRIPT = r"""
(class_declaration
  name: (type_identifier) @name.definition.class) @definition.class

(abstract_class_declaration
  name: (type_identifier) @name.definition.class) @definition.class

(interface_declaration
  name: (type_identifier) @name.definition.interface) @definition.interface

(type_alias_declaration
  name: (type_identifier) @name.definition.type) @definition.type

(enum_declaration
  name: (identifier) @name.definition.enum) @definition.enum

(function_declaration
  name: (identifier) @name.definition.function) @definition.function

(method_definition
  name: (property_identifier) @name.definition.method) @definition.method

(lexical_declaration
  (variable_declarator
    name: (identifier) @name.definition.function
    value: (arrow_function))) @definition.function

(call_expression
  function: (identifier) @name.reference.call) @reference.call

(call_expression
  function: (member_expression
    property: (property_identifier) @name.reference.call)) @reference.call

(new_expression
  constructor: (identifier) @name.reference.class) @reference.class
"""

TAGS_JAVASCRIPT = r"""
(class_declaration
  name: (identifier) @name.definition.class) @definition.class

(function_declaration
  name: (identifier) @name.definition.function) @definition.function

(method_definition
  name: (property_identifier) @name.definition.method) @definition.method

(lexical_declaration
  (variable_declarator
    name: (identifier) @name.definition.function
    value: (arrow_function))) @definition.function

(call_expression
  function: (identifier) @name.reference.call) @reference.call

(call_expression
  function: (member_expression
    property: (property_identifier) @name.reference.call)) @reference.call

(new_expression
  constructor: (identifier) @name.reference.class) @reference.class
"""

TAGS_PYTHON = r"""
(class_definition
  name: (identifier) @name.definition.class) @definition.class

(function_definition
  name: (identifier) @name.definition.function) @definition.function

(call
  function: (identifier) @name.reference.call) @reference.call

(call
  function: (attribute
    attribute: (identifier) @name.reference.call)) @reference.call
"""


# -------- language mapping -------------------------------------------------

LANGUAGE_BY_EXT = {
    ".ts": "typescript",
    ".tsx": "tsx",
    ".js": "javascript",
    ".jsx": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".py": "python",
}

TAGS_BY_LANG = {
    "typescript": TAGS_TYPESCRIPT,
    "tsx": TAGS_TYPESCRIPT,
    "javascript": TAGS_JAVASCRIPT,
    "python": TAGS_PYTHON,
}


# -------- skip patterns ----------------------------------------------------

DEFAULT_EXCLUDE_DIRS = frozenset({
    "node_modules", "dist", "build", ".git", ".aries", ".next",
    ".cache", "__pycache__", ".venv", "venv", ".pytest_cache",
    "coverage", ".turbo", ".vercel", "spike",
})


# -------- data shapes ------------------------------------------------------

class Symbol:
    __slots__ = ("name", "kind", "line")
    def __init__(self, name: str, kind: str, line: int):
        self.name = name
        self.kind = kind
        self.line = line
    def to_dict(self):
        return {"name": self.name, "kind": self.kind, "line": self.line}


class Reference:
    __slots__ = ("name", "kind", "line")
    def __init__(self, name: str, kind: str, line: int):
        self.name = name
        self.kind = kind
        self.line = line
    def to_dict(self):
        return {"name": self.name, "kind": self.kind, "line": self.line}


class FileRecord:
    __slots__ = ("path", "language", "lines", "symbols", "references", "imports")
    def __init__(self, path: str, language: str, lines: list[str]):
        self.path = path
        self.language = language
        self.lines = lines
        self.symbols: list[Symbol] = []
        self.references: list[Reference] = []
        self.imports: list[str] = []


# -------- parsing ----------------------------------------------------------

# Cache compiled queries per language (created lazily)
_QUERY_CACHE: dict[str, Query] = {}


def _get_query(language: str) -> Optional[Query]:
    """Compile (and cache) the tags query for a language."""
    if language in _QUERY_CACHE:
        return _QUERY_CACHE[language]
    tags_src = TAGS_BY_LANG.get(language)
    if not tags_src:
        return None
    try:
        lang_obj = get_language(language)
        query = Query(lang_obj, tags_src)
        _QUERY_CACHE[language] = query
        return query
    except Exception as e:
        print(f"[indexer] failed to compile query for {language}: {e}")
        return None


def _extract_imports(root_node, src_bytes: bytes, language: str) -> list[str]:
    """Walk AST, pull import source strings."""
    imports: list[str] = []

    def walk(node):
        # TypeScript/JavaScript: import_statement
        if node.type in ("import_statement", "import_clause"):
            for child in node.children:
                if child.type == "string":
                    # strip quotes
                    raw = src_bytes[child.start_byte:child.end_byte].decode("utf-8", errors="replace")
                    imports.append(raw.strip("'\""))
        # Python: import_statement / import_from_statement
        elif node.type in ("import_from_statement", "import_statement"):
            for child in node.children:
                if child.type in ("dotted_name", "relative_import"):
                    raw = src_bytes[child.start_byte:child.end_byte].decode("utf-8", errors="replace")
                    imports.append(raw)
        for child in node.children:
            walk(child)

    walk(root_node)
    return imports


def _run_tags_query(tree, query: Query, src_bytes: bytes) -> tuple[list[Symbol], list[Reference]]:
    """Run tags query against parse tree. Returns (symbols, references)."""
    symbols: list[Symbol] = []
    references: list[Reference] = []

    cursor = QueryCursor(query)
    matches = cursor.matches(tree.root_node)

    for _pattern_idx, captures in matches:
        # captures is dict[str, list[Node]]
        name_cap = None
        kind = None
        is_def = False

        for cap_name, nodes in captures.items():
            if not nodes:
                continue
            node = nodes[0]
            if cap_name.startswith("name.definition."):
                name_cap = node
                kind = cap_name.replace("name.definition.", "")
                is_def = True
            elif cap_name.startswith("name.reference."):
                name_cap = node
                kind = cap_name.replace("name.reference.", "")
                is_def = False

        if name_cap is None or kind is None:
            continue
        name = src_bytes[name_cap.start_byte:name_cap.end_byte].decode("utf-8", errors="replace")
        line = name_cap.start_point[0] + 1

        if is_def:
            symbols.append(Symbol(name, kind, line))
        else:
            references.append(Reference(name, kind, line))

    return symbols, references


def index_file(path: Path, rel_path: str) -> Optional[FileRecord]:
    """Parse one file, extract symbols/references/imports. None on failure."""
    ext = path.suffix.lower()
    language = LANGUAGE_BY_EXT.get(ext)
    if not language:
        return None

    try:
        src_bytes = path.read_bytes()
    except Exception:
        return None

    # Skip huge files (>1MB)
    if len(src_bytes) > 1_000_000:
        return None

    try:
        src_text = src_bytes.decode("utf-8", errors="replace")
    except Exception:
        return None

    lines = src_text.split("\n")
    record = FileRecord(rel_path, language, lines)

    try:
        parser = get_parser(language)
        tree = parser.parse(src_bytes)
    except Exception:
        return record  # keep file but no symbols

    # Tags (symbols + references)
    query = _get_query(language)
    if query:
        try:
            symbols, references = _run_tags_query(tree, query, src_bytes)
            record.symbols = symbols
            record.references = references
        except Exception as e:
            print(f"[indexer] tags query failed for {rel_path}: {e}")

    # Imports
    try:
        record.imports = _extract_imports(tree.root_node, src_bytes, language)
    except Exception as e:
        print(f"[indexer] import extraction failed for {rel_path}: {e}")

    return record


def _walk_files(root: Path, include_exts: set[str], exclude_dirs: set[str]):
    """Yield (full_path, rel_path) for each source file."""
    for dirpath, dirnames, filenames in os.walk(root):
        # prune excluded dirs in-place
        dirnames[:] = [d for d in dirnames if d not in exclude_dirs and not d.startswith(".")]
        for fname in filenames:
            if not any(fname.endswith(ext) for ext in include_exts):
                continue
            full = Path(dirpath) / fname
            rel = full.relative_to(root).as_posix()
            yield full, rel


def index_repo(
    repo_path: str | Path,
    include_exts: Optional[list[str]] = None,
    exclude_dirs: Optional[list[str]] = None,
) -> dict:
    """
    Index a repository. Returns dict with:
      files: dict[rel_path, FileRecord]
      file_count: int
      symbol_count: int
      elapsed_ms: int
    """
    start = time.time()
    root = Path(repo_path).resolve()
    if not root.is_dir():
        raise ValueError(f"not a directory: {root}")

    exts = set(include_exts) if include_exts else set(LANGUAGE_BY_EXT.keys())
    skip = set(exclude_dirs) if exclude_dirs is not None else set(DEFAULT_EXCLUDE_DIRS)

    files: dict[str, FileRecord] = {}
    symbol_count = 0

    for full_path, rel_path in _walk_files(root, exts, skip):
        record = index_file(full_path, rel_path)
        if record:
            files[rel_path] = record
            symbol_count += len(record.symbols)

    elapsed_ms = int((time.time() - start) * 1000)

    return {
        "root": str(root),
        "files": files,
        "file_count": len(files),
        "symbol_count": symbol_count,
        "elapsed_ms": elapsed_ms,
    }


if __name__ == "__main__":
    import sys
    target = sys.argv[1] if len(sys.argv) > 1 else "."
    result = index_repo(target)
    print(f"[indexer] indexed {result['file_count']} files, {result['symbol_count']} symbols in {result['elapsed_ms']}ms")
    # Top files by symbol count
    top = sorted(result["files"].values(), key=lambda r: -len(r.symbols))[:10]
    for r in top:
        print(f"  {r.path}: {len(r.symbols)} symbols, {len(r.references)} refs, {len(r.imports)} imports")
