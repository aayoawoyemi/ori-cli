"""
AST pre-pass security guards for the REPL sandbox.

Blocks escape routes that allow walking Python's object hierarchy to reach
dangerous builtins: __class__, __subclasses__, __mro__, __bases__, imports, etc.

This is a structural guard, not a bulletproof sandbox. It raises SecurityError
BEFORE exec() is called, so the guarded code never runs. Combined with a
namespace-restricted exec (no __builtins__, no imports allowed), this blocks
the common attack vectors documented in Python sandbox research.

For v0 spike and Phase 1, this is the primary defense. Docker + Firecracker
come in later phases for untrusted workloads.
"""
import ast


# Attributes that allow walking the object hierarchy to escape the sandbox.
FORBIDDEN_ATTRS = frozenset({
    "__class__",
    "__subclasses__",
    "__mro__",
    "__bases__",
    "__base__",
    "__globals__",
    "__builtins__",
    "__dict__",
    "__code__",
    "__closure__",
    "__func__",
    "__import__",
    "__reduce__",
    "__reduce_ex__",
    "__getattribute__",
    "__setattr__",
    "__delattr__",
    "__subclasshook__",
    "__init_subclass__",
    "__class_getitem__",
    "__mro_entries__",
    "f_globals",
    "f_locals",
    "f_back",
    "gi_frame",
    "gi_code",
    "cr_frame",
    "cr_code",
})

# Names that bypass the namespace allowlist.
FORBIDDEN_NAMES = frozenset({
    "eval",
    "exec",
    "compile",
    "open",
    "__import__",
    "breakpoint",
    "exit",
    "quit",
    "globals",
    "locals",
    "vars",
    "input",
    "getattr",
    "setattr",
    "delattr",
})


class SecurityError(Exception):
    """Raised when code fails the AST pre-pass."""
    pass


PRELOADED_FOR_STRIP = frozenset({
    "json",
    "re",
    "datetime",
    "random",
    "statistics",
    "collections",
    "itertools",
    "math",
})


def _is_strippable_import(node: ast.AST) -> bool:
    """Return True for top-level imports that are pure muscle memory.

    Only `import module` is eligible. `from module import name` changes the
    binding shape the model expects, and aliased imports would leave later
    references like `j.dumps(...)` undefined if stripped.
    """
    if not isinstance(node, ast.Import):
        return False
    return all(
        alias.asname is None and alias.name in PRELOADED_FOR_STRIP
        for alias in node.names
    )


def strip_preloaded_imports(code: str) -> str:
    """Silently remove top-level imports for modules already in the namespace.

    Loop3 dogfood showed Sonnet writing `import json` from Python muscle
    memory even though `json` is already pre-bound. Rejecting that loses the
    cell and forces a corrective retry, which is the category this runtime is
    avoiding. This is a transformer, not a validator: it handles only the
    harmless preloaded-module no-op case, then `check_ast` remains the
    authority for unsafe imports and every other security rule.

    Deliberately excluded:
    - ImportFrom (`from collections import Counter`) because stripping would
      remove the binding the code is asking for.
    - Aliases (`import json as j`) because stripping would create NameError.
    - Nested imports because they may be intentionally scoped.

    `ast.unparse` can normalize whitespace and line numbers. That tradeoff is
    acceptable for this narrow pass because the transformed statements are
    semantically no-ops in the Aries body namespace.
    """
    try:
        tree = ast.parse(code)
    except SyntaxError:
        return code

    kept = [node for node in tree.body if not _is_strippable_import(node)]
    if len(kept) == len(tree.body):
        return code

    tree.body = kept
    ast.fix_missing_locations(tree)
    return ast.unparse(tree)


def check_ast(code: str) -> None:
    """
    Parse and validate code against security rules.
    Raises SecurityError if code is unsafe. Returns None if safe.
    """
    try:
        tree = ast.parse(code)
    except SyntaxError as e:
        raise SecurityError(f"syntax error: {e.msg} (line {e.lineno})")

    for node in ast.walk(tree):
        # Block all imports
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            raise SecurityError("import statements are forbidden")

        # Block forbidden attribute access (e.g., obj.__class__)
        if isinstance(node, ast.Attribute):
            if node.attr in FORBIDDEN_ATTRS:
                raise SecurityError(f"forbidden attribute: .{node.attr}")

        # Block forbidden name references (e.g., eval, open)
        if isinstance(node, ast.Name):
            if node.id in FORBIDDEN_NAMES:
                raise SecurityError(f"forbidden name: {node.id}")

        # Block forbidden strings used as attribute lookup keys
        # (guards against getattr(obj, '__class__') patterns even if getattr is blocked)
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            if node.value in FORBIDDEN_ATTRS:
                # Allow in print() etc — conservative check: flag if it looks like lookup
                # Skip this check in Phase 1 to avoid false positives on legitimate strings
                pass
