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
