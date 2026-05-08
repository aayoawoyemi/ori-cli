"""AST-based composition telemetry for submitted code cells."""
from __future__ import annotations

import ast

from schema import primitive_metadata


_BARE_PRIMITIVE_NAMES = {
    "say",
    "ask",
    "done",
    "rlm_call",
    "rlm_batch",
    "reindex",
    "help",
}

_NAMESPACE_OBJECTS = {
    "fs",
    "shell",
    "web",
    "codebase",
    "vault",
    "research",
    "api",
    "plan",
    "spanner",
    "state",
    "scratch",
    "json",
    "os",
}

_TRY_TYPES: tuple = (ast.Try,) if not hasattr(ast, "TryStar") else (ast.Try, getattr(ast, "TryStar"))


def analyze_shape(code: str) -> dict:
    """Return non-blocking telemetry about a submitted Python program."""
    result: dict = {
        "stmt_count": 0,
        "line_count": code.count("\n") + 1,
        "char_count": len(code),
        "primitives_called": [],
        "costs": {},
        "effects": {},
        "expensive_primitives": [],
        "distinct_primitive_count": 0,
        "total_primitive_call_count": 0,
        "has_for_or_while": False,
        "has_if": False,
        "has_def": False,
        "has_try": False,
        "has_comprehension": False,
        "is_micro_repl": False,
        "is_composed": False,
        "composition_kind": "silent",
    }

    try:
        tree = ast.parse(code)
    except (SyntaxError, ValueError) as exc:
        result["error"] = f"parse failed: {exc}"
        return result

    stmt_count = 0
    for stmt in tree.body:
        if isinstance(stmt, ast.Pass):
            continue
        if isinstance(stmt, ast.Expr) and isinstance(stmt.value, ast.Constant):
            continue
        stmt_count += 1
    result["stmt_count"] = stmt_count

    primitives: list[str] = []
    has_control_flow = False

    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            func = node.func
            if isinstance(func, ast.Name) and func.id in _BARE_PRIMITIVE_NAMES:
                primitives.append(func.id)
            elif isinstance(func, ast.Attribute) and isinstance(func.value, ast.Name):
                obj_name = func.value.id
                if obj_name in _NAMESPACE_OBJECTS:
                    primitives.append(f"{obj_name}.{func.attr}")

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
    costs: dict[str, int] = {}
    effects: dict[str, int] = {}
    expensive: list[str] = []
    for primitive in primitives:
        meta = primitive_metadata(primitive)
        cost = meta.get("cost", "local")
        costs[cost] = costs.get(cost, 0) + 1
        if cost not in ("local",):
            expensive.append(primitive)
        for effect in meta.get("effects", []):
            effects[effect] = effects.get(effect, 0) + 1
    result["costs"] = costs
    result["effects"] = effects
    result["expensive_primitives"] = expensive
    result["distinct_primitive_count"] = len(set(primitives))
    result["total_primitive_call_count"] = len(primitives)

    primitive_set = set(primitives)
    work_primitives = [
        p for p in primitives
        if p not in {"say", "done"} and not p.startswith("api.")
    ]
    work_distinct = len(set(work_primitives))
    has_commit = "done" in primitive_set

    if stmt_count == 0 and not primitives:
        kind = "silent"
    elif has_control_flow:
        kind = "control_flow"
    elif len(work_primitives) >= 3 and work_distinct >= 1:
        kind = "fanout"
    elif work_distinct >= 2 or (work_primitives and has_commit and stmt_count >= 2):
        kind = "pipeline"
    elif has_commit:
        kind = "commit"
    else:
        kind = "micro"

    result["composition_kind"] = kind
    result["is_micro_repl"] = kind == "micro" and stmt_count <= 2
    result["is_composed"] = kind in {"fanout", "pipeline", "control_flow"}
    return result
