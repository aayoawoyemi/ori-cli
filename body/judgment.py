"""
Shared utilities for Phase 8 judgment tools.

Pure Python, zero external dependencies. Used by CodebaseGraph methods
find_similar_patterns, suggest_location, find_convention, detect_duplication,
is_consistent_with.

Identifier tokenization, AST shape hashing, edit distance, code normalization.
"""
from __future__ import annotations

import hashlib
import re
from typing import Iterable, Optional


# -------- Identifier tokenization ------------------------------------------

_CAMEL_BOUNDARY = re.compile(r"(?<!^)(?=[A-Z][a-z])|(?<=[a-z0-9])(?=[A-Z])")
_NON_ALNUM = re.compile(r"[^A-Za-z0-9]+")


def tokenize_identifier(name: str) -> list[str]:
    """
    Split camelCase / snake_case / PascalCase / kebab-case into lowercase tokens.

    Acronyms are kept together when followed by lowercase boundary:
        'FooBarHTTP' -> ['foo', 'bar', 'http']
        'HTTPRequest' -> ['http', 'request']
        'parseHTMLString' -> ['parse', 'html', 'string']

    Non-alphanumeric separators (underscore, dash, dot, space) split tokens.
    """
    if not name:
        return []
    # Split on non-alphanumeric first
    chunks = [c for c in _NON_ALNUM.split(name) if c]
    tokens: list[str] = []
    for chunk in chunks:
        # Split camelCase boundaries within chunk
        parts = _CAMEL_BOUNDARY.split(chunk)
        for p in parts:
            if p:
                tokens.append(p.lower())
    return tokens


def jaccard(a: Iterable[str], b: Iterable[str]) -> float:
    """Jaccard similarity of two token sets. Empty/empty -> 0.0."""
    sa, sb = set(a), set(b)
    if not sa and not sb:
        return 0.0
    union = sa | sb
    if not union:
        return 0.0
    return len(sa & sb) / len(union)


def detect_casing(name: str) -> str:
    """
    Returns one of: 'camel' | 'pascal' | 'snake' | 'upper_snake'
                  | 'kebab' | 'lower' | 'upper' | 'mixed' | 'empty'
    """
    if not name:
        return "empty"
    if "_" in name:
        return "upper_snake" if name.isupper() else "snake"
    if "-" in name:
        return "kebab"
    if name.isupper():
        return "upper"
    if name.islower():
        return "lower"
    # Has mixed case, no separators
    if name[0].isupper():
        # PascalCase — rest can have lowercase
        return "pascal"
    # Starts lowercase, has an uppercase somewhere
    if any(c.isupper() for c in name):
        return "camel"
    return "mixed"


# -------- Code window normalization ----------------------------------------

_STRING_LIT = re.compile(r"(?:\"\"\"[\s\S]*?\"\"\"|'''[\s\S]*?'''|\"(?:\\.|[^\"\\])*\"|'(?:\\.|[^'\\])*')")
_NUMBER_LIT = re.compile(r"\b\d+(?:\.\d+)?\b")
_IDENTIFIER = re.compile(r"\b[A-Za-z_][A-Za-z0-9_]*\b")
_WHITESPACE = re.compile(r"\s+")

# Common keywords to preserve (not mask as IDENT)
_KEYWORDS: frozenset[str] = frozenset({
    # Control flow
    "if", "else", "elif", "for", "while", "do", "break", "continue",
    "return", "yield", "switch", "case", "default", "try", "catch",
    "finally", "except", "raise", "throw", "with", "match",
    # Declarations
    "function", "class", "def", "const", "let", "var", "public",
    "private", "protected", "static", "async", "await", "interface",
    "type", "enum", "struct", "impl", "trait", "fn", "import", "from",
    "export", "module", "package", "namespace", "use", "as",
    # Primitives
    "true", "false", "null", "undefined", "None", "True", "False",
    "void", "int", "str", "bool", "float", "double", "long", "short",
    "self", "this", "new", "in", "is", "not", "and", "or", "of",
    "lambda", "pass", "global", "nonlocal", "return", "print",
    # Normalization placeholders — must survive identifier masking
    "STR", "NUM",
})


def normalize_code_window(lines: list[str], mask_identifiers: bool = True) -> str:
    """
    Canonicalize a code window for pattern comparison.

    - String literals -> "STR"
    - Numeric literals -> "NUM"
    - Identifiers (non-keyword) -> "IDENT" (if mask_identifiers)
    - Whitespace collapsed to single space
    - Trailing/leading whitespace stripped

    Comments NOT stripped (caller's choice — pass pre-stripped lines if wanted).
    """
    text = "\n".join(lines)
    text = _STRING_LIT.sub('"STR"', text)
    text = _NUMBER_LIT.sub("NUM", text)
    if mask_identifiers:
        def _mask(m: re.Match) -> str:
            tok = m.group(0)
            if tok in _KEYWORDS:
                return tok
            return "IDENT"
        text = _IDENTIFIER.sub(_mask, text)
    text = _WHITESPACE.sub(" ", text).strip()
    return text


# -------- AST shape hashing ------------------------------------------------

def ast_shape_hash(node, depth_limit: int = 4) -> str:
    """
    Canonical hash of a tree-sitter node's structural shape.

    Strips all identifier text and literals. Keeps only the shape:
    node types + child structure.

    Two functions with identical control flow but different names/values
    hash to the same value. Different control flow hashes differently.

    Uses SHA1, returns hex digest. depth_limit caps recursion depth
    (children beyond depth_limit are hashed as node type only).
    """
    def _recurse(n, depth: int) -> str:
        if n is None:
            return "None"
        ntype = getattr(n, "type", None) or "unknown"
        if depth >= depth_limit:
            return ntype
        children = getattr(n, "children", None) or []
        if not children:
            return ntype
        child_hashes = [_recurse(c, depth + 1) for c in children]
        combined = ntype + "(" + ",".join(child_hashes) + ")"
        # For deep trees, compress to keep hash input small
        if len(combined) > 4096:
            combined = hashlib.sha1(combined.encode()).hexdigest()
        return combined

    shape = _recurse(node, 0)
    return hashlib.sha1(shape.encode()).hexdigest()[:16]  # 64-bit truncation


def ast_shape_sequence(node, depth_limit: int = 4) -> list[str]:
    """
    Flatten the direct children of a node into a shape-hash sequence.
    Useful for function bodies — each statement becomes one hash.
    """
    children = getattr(node, "children", None) or []
    return [ast_shape_hash(c, depth_limit) for c in children]


# -------- Edit distance ----------------------------------------------------

def hash_sequence_distance(seq_a: list[str], seq_b: list[str]) -> float:
    """
    Normalized Levenshtein distance between two sequences of strings.

    Returns 0.0 (identical) to 1.0 (fully disjoint).
    Each element is atomic — either equal or not.
    """
    la, lb = len(seq_a), len(seq_b)
    if la == 0 and lb == 0:
        return 0.0
    if la == 0 or lb == 0:
        return 1.0
    # Levenshtein DP
    prev = list(range(lb + 1))
    for i in range(1, la + 1):
        curr = [i] + [0] * lb
        for j in range(1, lb + 1):
            cost = 0 if seq_a[i - 1] == seq_b[j - 1] else 1
            curr[j] = min(
                curr[j - 1] + 1,      # insert
                prev[j] + 1,          # delete
                prev[j - 1] + cost,   # substitute
            )
        prev = curr
    dist = prev[lb]
    return dist / max(la, lb)


def hash_sequence_similarity(seq_a: list[str], seq_b: list[str]) -> float:
    """Convenience: 1.0 - distance."""
    return 1.0 - hash_sequence_distance(seq_a, seq_b)


# -------- Small helpers ----------------------------------------------------

def extract_topic_tokens(topic: str) -> list[str]:
    """
    Map a topic string to search tokens.

    Uses a small builtin dict for common topics. Falls back to splitting
    the topic itself if unknown.
    """
    key = topic.lower().strip()
    builtin = {
        "error handling": ["try", "catch", "except", "raise", "throw", "error"],
        "errors": ["try", "catch", "except", "raise", "throw", "error"],
        "logging": ["log", "logger", "console.log", "print", "debug", "info", "warn"],
        "api call": ["fetch", "axios", "request", "http", "get(", "post(", "put(", "delete("],
        "api calls": ["fetch", "axios", "request", "http", "get(", "post(", "put(", "delete("],
        "async": ["async", "await", "promise", "asyncio", "coroutine"],
        "validation": ["validate", "assert", "check", "verify", "schema"],
        "testing": ["test(", "it(", "describe(", "assert", "expect", "check("],
        "imports": ["import", "from", "require", "use ", "#include"],
        "exports": ["export", "module.exports", "__all__"],
        "config": ["config", "settings", "options", "env", "process.env"],
        "database": ["query", "sql", "db.", "insert", "update", "select", "delete"],
        "auth": ["auth", "token", "session", "login", "credential", "permission"],
        "routing": ["route", "router", "endpoint", "handler", "path", "url"],
        "caching": ["cache", "memo", "lru", "redis", "store"],
    }
    if key in builtin:
        return builtin[key]
    # Fallback: tokenize the topic
    return tokenize_identifier(key) or [key]
