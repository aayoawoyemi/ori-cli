"""
JSON-RPC server over stdin/stdout.

Protocol:
  Requests (one JSON object per line):
    {"op": "ping"}                              → {"pong": true}
    {"op": "exec", "code": "...",
     "timeout_ms": 30000}                       → {stdout, stderr, exception, duration_ms, rejected, timed_out}
    {"op": "reset"}                             → {"ok": true}
    {"op": "shutdown"}                          → (process exits)

Phase 1: minimal namespace (safe builtins only). Phases 2-4 add codebase,
vault, rlm_call to the namespace.
"""
import sys
import json
import builtins as _builtins
from pathlib import Path

# Ensure body/ is importable regardless of cwd
sys.path.insert(0, str(Path(__file__).parent))

import repl

# Lazy imports (heavy deps) — only loaded when ops are used
_indexer = None
_codebase_module = None
_vault_module = None
_rlm_module = None
CODEBASE = None  # CodebaseGraph instance, exposed via REPL namespace
VAULT = None  # Vault instance, exposed via REPL namespace


def _lazy_load_indexer():
    global _indexer, _codebase_module
    if _indexer is None:
        import indexer as _idx_mod
        import codebase as _cb_mod
        _indexer = _idx_mod
        _codebase_module = _cb_mod
    return _indexer, _codebase_module


def _lazy_load_vault():
    global _vault_module
    if _vault_module is None:
        import vault as _v_mod
        _vault_module = _v_mod
    return _vault_module


def _lazy_load_rlm():
    global _rlm_module
    if _rlm_module is None:
        import rlm as _rlm_mod
        _rlm_module = _rlm_mod
    return _rlm_module


# Phase 1 namespace — safe builtins only. No codebase, no vault, no rlm_call yet.
def _build_namespace() -> dict:
    # Essential language machinery needed by class statements, decorators, etc.
    # We scope __builtins__ to a minimal dict instead of {} so class/def work,
    # but we exclude dangerous callables (eval, exec, open, __import__, etc.)
    # which are also blocked structurally by the AST pre-pass.
    safe_builtins = {
        "__build_class__": _builtins.__build_class__,
        "__name__": "__sandbox__",
    }
    ns = {
        "__builtins__": safe_builtins,
        # Safe builtins
        "print": print,
        "len": len,
        "list": list,
        "dict": dict,
        "set": set,
        "tuple": tuple,
        "frozenset": frozenset,
        "str": str,
        "int": int,
        "float": float,
        "bool": bool,
        "bytes": bytes,
        "sorted": sorted,
        "reversed": reversed,
        "enumerate": enumerate,
        "zip": zip,
        "range": range,
        "map": map,
        "filter": filter,
        "sum": sum,
        "min": min,
        "max": max,
        "any": any,
        "all": all,
        "abs": abs,
        "round": round,
        "divmod": divmod,
        "repr": repr,
        "ord": ord,
        "chr": chr,
        "hex": hex,
        "oct": oct,
        "bin": bin,
        "hash": hash,
        "id": id,
        "isinstance": isinstance,
        "issubclass": issubclass,
        "iter": iter,
        "next": next,
        "callable": callable,
        # Exception types for try/except
        "BaseException": BaseException,
        "Exception": Exception,
        "ArithmeticError": ArithmeticError,
        "ZeroDivisionError": ZeroDivisionError,
        "OverflowError": OverflowError,
        "FloatingPointError": FloatingPointError,
        "ValueError": ValueError,
        "TypeError": TypeError,
        "KeyError": KeyError,
        "IndexError": IndexError,
        "AttributeError": AttributeError,
        "NameError": NameError,
        "RuntimeError": RuntimeError,
        "RecursionError": RecursionError,
        "StopIteration": StopIteration,
        "StopAsyncIteration": StopAsyncIteration,
        "LookupError": LookupError,
        "UnicodeDecodeError": UnicodeDecodeError,
        "NotImplementedError": NotImplementedError,
        "AssertionError": AssertionError,
        "TimeoutError": TimeoutError,
        # Built-in singletons
        "None": None,
        "True": True,
        "False": False,
    }
    # Phase 2: expose codebase object if indexed
    if CODEBASE is not None:
        ns["codebase"] = CODEBASE
    # Phase 3: expose vault object if connected
    if VAULT is not None:
        ns["vault"] = VAULT
    # Phase 4: expose rlm_call / rlm_batch if configured
    if _rlm_module is not None and _rlm_module.is_configured():
        ns["rlm_call"] = _rlm_module.rlm_call
        ns["rlm_batch"] = _rlm_module.rlm_batch
    return ns


def _rebuild_namespace():
    """Rebuild NAMESPACE (called after index, reset, etc)."""
    global NAMESPACE
    NAMESPACE = _build_namespace()


NAMESPACE = _build_namespace()
DEFAULT_TIMEOUT_MS = 30000


def handle(msg: dict):
    """Handle one JSON-RPC request. Returns response dict or None for shutdown."""
    global NAMESPACE, CODEBASE, VAULT
    op = msg.get("op")

    if op == "ping":
        return {"pong": True, "version": "0.1.0-phase1"}

    elif op == "exec":
        code = msg.get("code", "")
        timeout_ms = msg.get("timeout_ms", DEFAULT_TIMEOUT_MS)
        # Reset rlm stats before exec, attach to result after
        if _rlm_module is not None:
            _rlm_module.reset_stats()
        result = repl.execute(code, NAMESPACE, timeout_ms)
        if _rlm_module is not None and _rlm_module.is_configured():
            stats = _rlm_module.get_stats()
            if stats["call_count"] > 0:
                result["rlm_stats"] = stats
        return result

    elif op == "reset":
        NAMESPACE = _build_namespace()
        return {"ok": True}

    elif op == "index":
        # Build codebase graph
        repo_path = msg.get("repo_path", ".")
        include_exts = msg.get("include_exts")
        exclude_dirs = msg.get("exclude_dirs")
        try:
            idx_mod, cb_mod = _lazy_load_indexer()
            idx_result = idx_mod.index_repo(
                repo_path,
                include_exts=include_exts,
                exclude_dirs=exclude_dirs,
            )
            CODEBASE = cb_mod.CodebaseGraph(idx_result)
            _rebuild_namespace()
            stats = CODEBASE.stats()
            return {
                "ok": True,
                "file_count": stats["file_count"],
                "symbol_count": stats["symbol_count"],
                "edge_count": stats["edge_count"],
                "unique_symbols": stats["unique_symbols"],
                "elapsed_ms": idx_result["elapsed_ms"],
            }
        except Exception as e:
            import traceback
            return {"error": f"index failed: {e}", "traceback": traceback.format_exc()}

    elif op == "refresh_files":
        if CODEBASE is None:
            return {"error": "codebase not indexed"}
        paths = msg.get("paths", [])
        root_dir = msg.get("root_dir", ".")
        try:
            return CODEBASE.refresh_files(paths, root_dir)
        except Exception as e:
            import traceback
            return {"error": f"refresh failed: {e}", "traceback": traceback.format_exc()}

    elif op == "codebase_stats":
        if CODEBASE is None:
            return {"error": "codebase not indexed"}
        return CODEBASE.stats()

    elif op == "codebase_signature":
        if CODEBASE is None:
            return {"error": "codebase not indexed"}
        try:
            level = msg.get("level", "standard")
            max_tokens = msg.get("max_tokens", 1500)
            return CODEBASE.signature(level=level, max_tokens=max_tokens)
        except Exception as e:
            import traceback
            return {"error": f"signature failed: {e}", "traceback": traceback.format_exc()}

    elif op == "vault_signature":
        if VAULT is None:
            return {"error": "vault not connected"}
        try:
            level = msg.get("level", "standard")
            max_tokens = msg.get("max_tokens", 1500)
            return VAULT.signature(level=level, max_tokens=max_tokens)
        except Exception as e:
            import traceback
            return {"error": f"vault_signature failed: {e}", "traceback": traceback.format_exc()}

    elif op == "connect_vault":
        vault_path = msg.get("vault_path")
        if not vault_path:
            return {"error": "vault_path required"}
        try:
            v_mod = _lazy_load_vault()
            if VAULT is not None:
                try:
                    VAULT.disconnect()
                except Exception:
                    pass
            VAULT = v_mod.Vault(vault_path)
            VAULT.connect(timeout=15.0)
            _rebuild_namespace()
            status = VAULT.status()
            return {
                "ok": True,
                "vault_path": vault_path,
                "note_count": status.get("noteCount"),
                "inbox_count": status.get("inboxCount"),
            }
        except Exception as e:
            import traceback
            return {"error": f"vault connect failed: {e}", "traceback": traceback.format_exc()}

    elif op == "disconnect_vault":
        if VAULT is not None:
            try:
                VAULT.disconnect()
            except Exception:
                pass
            VAULT = None
            _rebuild_namespace()
        return {"ok": True}

    elif op == "vault_status":
        if VAULT is None:
            return {"error": "vault not connected"}
        try:
            return VAULT.status()
        except Exception as e:
            return {"error": str(e)}

    elif op == "configure_rlm":
        api_key = msg.get("api_key")
        if not api_key:
            return {"error": "api_key required"}
        try:
            rlm_mod = _lazy_load_rlm()
            rlm_mod.configure(
                api_key=api_key,
                model=msg.get("model"),
                max_calls=msg.get("max_calls"),
            )
            _rebuild_namespace()
            return {"ok": True, "model": msg.get("model", "default")}
        except Exception as e:
            import traceback
            return {"error": f"configure_rlm failed: {e}", "traceback": traceback.format_exc()}

    elif op == "shutdown":
        return None  # signal shutdown

    else:
        return {"error": f"unknown op: {op}"}


def main():
    sys.stderr.write("[body] ready\n")
    sys.stderr.flush()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            msg = json.loads(line)
        except json.JSONDecodeError as e:
            print(json.dumps({"error": f"bad json: {e}"}), flush=True)
            continue

        response = handle(msg)
        if response is None:
            # shutdown
            print(json.dumps({"ok": True, "shutdown": True}), flush=True)
            break
        print(json.dumps(response), flush=True)


if __name__ == "__main__":
    main()
