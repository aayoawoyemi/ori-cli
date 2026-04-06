"""
CodebaseGraph — the `codebase` object exposed in the REPL namespace.

Loads graph.json and exposes search/cluster/get_context methods.
"""
import json
from pathlib import Path
from collections import defaultdict


class CodebaseGraph:
    def __init__(self, graph_path: Path):
        raw = json.loads(graph_path.read_text(encoding="utf-8"))
        self.root = raw["root"]
        self.files = raw["files"]
        self.keyword_index = raw["keyword_index"]
        self.file_count = raw["file_count"]

    def search(self, keyword: str) -> list:
        """
        Return list of matches for a keyword.
        Each match: {file, line, snippet}
        """
        keyword = keyword.lower()
        # Try exact keyword index first (fast path)
        if keyword in self.keyword_index:
            return list(self.keyword_index[keyword])

        # Fallback: substring scan across all indexed keywords
        out = []
        for kw, hits in self.keyword_index.items():
            if keyword in kw or kw in keyword:
                out.extend(hits)
        return out

    def cluster_by_file(self, matches: list) -> dict:
        """Group matches by file. Returns {file: [matches]}."""
        out = defaultdict(list)
        for m in matches:
            out[m["file"]].append(m)
        return dict(out)

    def get_context(self, file_path: str, line_numbers: list = None,
                    window: int = 5) -> str:
        """
        Return context window around specific lines, or whole file.
        If line_numbers provided, returns windows around those lines.
        """
        if file_path not in self.files:
            return f"(file not found: {file_path})"

        lines = self.files[file_path]["lines"]

        if line_numbers is None:
            # Return first N lines as a summary
            preview = "\n".join(f"{i+1:4d}  {l}" for i, l in enumerate(lines[:40]))
            return f"=== {file_path} (first 40 lines of {len(lines)}) ===\n{preview}"

        # Build windows around each line
        segments = []
        seen_ranges = []
        for ln in sorted(set(line_numbers)):
            start = max(1, ln - window)
            end = min(len(lines), ln + window)
            # merge overlapping ranges
            if seen_ranges and start <= seen_ranges[-1][1] + 2:
                seen_ranges[-1] = (seen_ranges[-1][0], max(end, seen_ranges[-1][1]))
            else:
                seen_ranges.append((start, end))

        for start, end in seen_ranges:
            window_lines = []
            for i in range(start, end + 1):
                if 1 <= i <= len(lines):
                    window_lines.append(f"{i:4d}  {lines[i-1]}")
            segments.append("\n".join(window_lines))

        body = "\n  ...\n".join(segments)
        return f"=== {file_path} ===\n{body}"

    def get_file_summary(self, file_path: str) -> dict:
        """Return metadata: symbols, size, line count."""
        if file_path not in self.files:
            return {"error": f"not found: {file_path}"}
        entry = self.files[file_path]
        return {
            "path": file_path,
            "size": entry["size"],
            "line_count": entry["line_count"],
            "symbols": entry["symbols"],
        }

    def list_files(self) -> list:
        return sorted(self.files.keys())
