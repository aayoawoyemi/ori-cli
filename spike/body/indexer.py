"""
Minimal codebase indexer for the spike.

Scans a directory tree for .ts/.tsx files, extracts:
- Symbol mentions (class/function/const/let/export names)
- Keyword matches (configurable)
- File-level metadata (size, top exports)

Emits graph.json adjacent to this script.

This is SPIKE code — regex-based, not tree-sitter. Good enough to test the thesis.
"""
import json
import re
import sys
from pathlib import Path
from collections import defaultdict

# Regex patterns for TS/TSX symbol extraction
PATTERNS = {
    "class": re.compile(r"(?:export\s+)?(?:abstract\s+)?class\s+(\w+)"),
    "function": re.compile(r"(?:export\s+)?(?:async\s+)?function\s+(\w+)"),
    "const_arrow": re.compile(r"(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\("),
    "interface": re.compile(r"(?:export\s+)?interface\s+(\w+)"),
    "type": re.compile(r"(?:export\s+)?type\s+(\w+)\s*="),
    "enum": re.compile(r"(?:export\s+)?enum\s+(\w+)"),
}

# Keywords to build an index for (for fast search)
# Include common domain terms that agent might query
INDEX_KEYWORDS = {
    "permission", "tool", "loop", "memory", "vault", "hook",
    "session", "router", "compact", "warmth", "preflight",
    "postflight", "stream", "message", "agent", "echo",
    "reflection", "plan", "execute", "context", "compact",
}


def scan_file(path: Path, root: Path):
    """Extract symbols and keyword hits from a single file."""
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return None

    rel = str(path.relative_to(root)).replace("\\", "/")
    lines = text.split("\n")

    symbols = []
    for kind, pat in PATTERNS.items():
        for m in pat.finditer(text):
            line_no = text[:m.start()].count("\n") + 1
            symbols.append({
                "name": m.group(1),
                "kind": kind,
                "line": line_no,
            })

    # Build line-indexed keyword matches (lowercased substring match)
    keyword_hits = defaultdict(list)
    for i, line in enumerate(lines, start=1):
        lower = line.lower()
        for kw in INDEX_KEYWORDS:
            if kw in lower:
                keyword_hits[kw].append({
                    "line": i,
                    "snippet": line.strip()[:200],
                })

    return {
        "path": rel,
        "size": len(text),
        "line_count": len(lines),
        "symbols": symbols,
        "keywords": dict(keyword_hits),
        "lines": lines,  # full text for get_context
    }


def build_graph(root: Path) -> dict:
    """Walk the tree, build the graph."""
    files = {}
    for path in root.rglob("*.ts"):
        if "node_modules" in path.parts:
            continue
        entry = scan_file(path, root)
        if entry:
            files[entry["path"]] = entry
    for path in root.rglob("*.tsx"):
        if "node_modules" in path.parts:
            continue
        entry = scan_file(path, root)
        if entry:
            files[entry["path"]] = entry

    # Invert keyword index: keyword -> list of (file, line, snippet)
    keyword_index = defaultdict(list)
    for file_path, entry in files.items():
        for kw, hits in entry["keywords"].items():
            for hit in hits:
                keyword_index[kw].append({
                    "file": file_path,
                    "line": hit["line"],
                    "snippet": hit["snippet"],
                })

    return {
        "root": str(root),
        "files": files,
        "keyword_index": dict(keyword_index),
        "file_count": len(files),
    }


def main():
    if len(sys.argv) < 2:
        print("usage: python indexer.py <src_dir>", file=sys.stderr)
        sys.exit(1)
    root = Path(sys.argv[1]).resolve()
    if not root.is_dir():
        print(f"not a directory: {root}", file=sys.stderr)
        sys.exit(1)

    graph = build_graph(root)
    out_path = Path(__file__).parent / "graph.json"
    out_path.write_text(json.dumps(graph, indent=2), encoding="utf-8")

    print(f"indexed {graph['file_count']} files")
    print(f"keywords: {list(graph['keyword_index'].keys())}")
    print(f"wrote {out_path}")


if __name__ == "__main__":
    main()
