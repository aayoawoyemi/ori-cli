"""
AST-based shape analysis for submitted Repl code.

Telemetry primitive — measures whether each submission is a real multi-step
composition or a schema-minimum filler. The result dict gets attached to the
exec result envelope as `shape` (see body/server.py:_run_exec) and logged
from the TS side as a session event (see src/loop.ts).

Why this lives in its own module rather than inline in repl.py or server.py:
the analysis is pure inspection (no side effects, no namespace mutation),
safe to call from anywhere, and easier to unit-test in isolation. Keeping it
separate also keeps body/repl.py focused on sandboxed-exec mechanics —
shape analysis is orthogonal to security checks and execution.

Why not reuse body/security.py's check_ast tree: check_ast raises on
rejection and doesn't return the parsed tree. Re-parsing here costs a
sub-millisecond on a few hundred lines — negligible. The duplication is
cheaper than refactoring security.py's public surface.
"""
import ast


# Bare names that count as namespace primitives when called as `name(...)`
# at any depth in the AST. Mirrors the bare-name bindings in server.py's
# _build_namespace (say/ask/done/rlm_call/rlm_batch/reindex/help). If you
# add a bare-name primitive to server.py, add it here too.
_BARE_PRIMITIVE_NAMES = {
    "say", "ask", "done",
    "rlm_call", "rlm_batch",
    "reindex", "help",
}

# Namespace object names. Methods called as `obj.method(...)` get recorded
# as primitives of the form "obj.method". Mirrors the object bindings in
# server.py's _build_namespace. If you add a namespace object (e.g. a new
# cloud or db primitive in the future), add it here too.
_NAMESPACE_OBJECTS = {
    "fs", "shell", "web",
    "codebase", "vault", "research",
    "json", "os",
}

# Python 3.11+ added TryStar (except*); 3.10 and earlier only have Try.
# Build the tuple dynamically so the analyzer works on any reasonable Python.
_TRY_TYPES: tuple = (ast.Try,) if not hasattr(ast, "TryStar") else (ast.Try, getattr(ast, "TryStar"))


def analyze_shape(code: str) -> dict:
    """Parse `code` and return shape metrics.

    Metrics:
      stmt_count                   — top-level statements, excluding pass / docstring bare literals
      line_count                   — raw newline count + 1
      char_count                   — len(code)
      primitives_called            — list of "fs.read" / "done" style strings, in order
      distinct_primitive_count     — unique entries in primitives_called
      total_primitive_call_count   — duplicates-preserved length
      has_for_or_while             — bool
      has_if                       — bool
      has_def                      — bool (includes def / async def / lambda)
      has_try                      — bool (Try + TryStar if available)
      has_comprehension            — bool (list / dict / set / generator)
      is_micro_repl                — stmt<=2 AND distinct_primitives<=1 AND no control flow
      is_composed                  — stmt>=3 AND (distinct_primitives>=2 OR has control flow)

    Never raises. Unparseable code (syntax error) returns a zero-filled dict
    with an `error` key — telemetry should not disrupt exec flow.
    """
    result: dict = {
        "stmt_count": 0,
        "line_count": code.count("\n") + 1,
        "char_count": len(code),
        "primitives_called": [],
        "distinct_primitive_count": 0,
        "total_primitive_call_count": 0,
        "has_for_or_while": False,
        "has_if": False,
        "has_def": False,
        "has_try": False,
        "has_comprehension": False,
        "is_micro_repl": False,
        "is_composed": False,
    }

    try:
        tree = ast.parse(code)
    except (SyntaxError, ValueError) as exc:
        # Parse failure is not a metric — it's a data-quality problem. Surface
        # it so downstream aggregators can filter instead of silently skewing
        # averages. The telemetry consumer is responsible for deciding what
        # to do with shape records that have an `error` field.
        result["error"] = f"parse failed: {exc}"
        return result

    # ── Statement count ────────────────────────────────────────────────
    # Only top-level statements count for composition analysis. Statements
    # nested inside functions / ifs / loops are control-flow structure, not
    # independent actions — they're captured by has_* flags instead. Filter
    # out two no-op shapes: bare `pass` and bare constant expressions (the
    # latter covers module-level docstrings and accidental `"hello world"`
    # lines the model might drop in).
    stmt_count = 0
    for stmt in tree.body:
        if isinstance(stmt, ast.Pass):
            continue
        if isinstance(stmt, ast.Expr) and isinstance(stmt.value, ast.Constant):
            continue
        stmt_count += 1
    result["stmt_count"] = stmt_count

    # ── Walk for primitives and control flow ───────────────────────────
    primitives: list = []
    has_control_flow = False

    for node in ast.walk(tree):
        # Call-site detection. Two shapes count:
        #   Name('say')(...)                 → bare primitive call
        #   Attribute(Name('fs'), 'read')(...) → namespace method call
        # Deeper attribute chains (a.b.c(...)) are ignored — the model's
        # namespace API surface is one-level, and counting deeper would
        # create false positives (e.g. result.data.append would register
        # as primitive "data.append" which is noise).
        if isinstance(node, ast.Call):
            func = node.func
            if isinstance(func, ast.Name) and func.id in _BARE_PRIMITIVE_NAMES:
                primitives.append(func.id)
            elif isinstance(func, ast.Attribute) and isinstance(func.value, ast.Name):
                obj_name = func.value.id
                if obj_name in _NAMESPACE_OBJECTS:
                    primitives.append(f"{obj_name}.{func.attr}")

        # Control-flow detection. Comprehensions count because they encode
        # a for-loop + optional filter + expression, which is genuine
        # composition — distinguishing them from bare for-loops at the
        # metric level lets us see whether the model prefers the Pythonic
        # one-liner or the imperative multi-statement form.
        if isinstance(node, (ast.For, ast.While, ast.AsyncFor)):
            result["has_for_or_while"] = True
            has_control_flow = True
        elif isinstance(node, ast.If):
            result["has_if"] = True
            has_control_flow = True
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
            result["has_def"] = True
            has_control_flow = True
        elif isinstance(node, _TRY_TYPES):
            result["has_try"] = True
            has_control_flow = True
        elif isinstance(node, (ast.ListComp, ast.DictComp, ast.SetComp, ast.GeneratorExp)):
            result["has_comprehension"] = True
            has_control_flow = True

    result["primitives_called"] = primitives
    result["distinct_primitive_count"] = len(set(primitives))
    result["total_primitive_call_count"] = len(primitives)

    # ── Derived classifications ────────────────────────────────────────
    # is_micro_repl: the fragmentation signature. Two or fewer statements,
    # at most one primitive, no control flow — the shape we're trying to
    # force the model away from. Even under minItems:2 schema enforcement,
    # the model CAN emit a batch whose concatenated code still looks like
    # this (e.g. two trivial ops). The classification surfaces that case
    # in telemetry so we can tighten constraints if it proves common.
    result["is_micro_repl"] = (
        stmt_count <= 2
        and result["distinct_primitive_count"] <= 1
        and not has_control_flow
    )
    # is_composed: the target shape. Three or more statements AND either
    # multiple primitives OR control flow — real multi-step work. Used as
    # the success metric for the schema-enforcement thesis.
    result["is_composed"] = (
        stmt_count >= 3
        and (result["distinct_primitive_count"] >= 2 or has_control_flow)
    )

    return result
