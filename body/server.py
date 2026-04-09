"""
JSON-RPC server over stdin/stdout.

Protocol:
  Requests (one JSON object per line):
    {"op": "ping"}                              → {"pong": true}
    {"op": "exec", "code": "...",
     "timeout_ms": 30000}                       → {stdout, stderr, exception, duration_ms, rejected, timed_out}
    {"op": "reset"}                             → {"ok": true}
    {"op": "shutdown"}                          → (process exits)

  Vault callback protocol (during exec):
    Python stdout: {"vault_request": {"id": 1, "method": "ori_query_ranked", "args": {...}}}
    TS stdin:      {"vault_response": {"id": 1, "result": {...}}}

Phase 1: minimal namespace (safe builtins only). Phases 2-4 add codebase,
vault, rlm_call to the namespace.
"""
import sys
import json
import threading
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
VAULT = None  # Vault proxy instance, exposed via REPL namespace


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


def _reindex(path: str) -> dict:
    """Reindex the codebase on a new directory. Available in REPL as reindex()."""
    global CODEBASE
    idx_mod, cb_mod = _lazy_load_indexer()
    idx_result = idx_mod.index_repo(path)
    CODEBASE = cb_mod.CodebaseGraph(idx_result)
    _rebuild_namespace()
    return CODEBASE.stats()


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
    # Always available: fs.read() for arbitrary file access
    import types as _types
    import pathlib as _pathlib

    def _fs_read(path: str, offset: int = 0, limit: int | None = None) -> str:
        p = _pathlib.Path(path).expanduser().resolve()
        if not p.exists():
            raise FileNotFoundError(f"fs.read: no file at {p}")
        if p.stat().st_size > 2_000_000:
            raise ValueError(f"fs.read: file exceeds 2MB ({p.stat().st_size} bytes)")
        text = p.read_text(encoding="utf-8", errors="replace")
        lines = text.splitlines(keepends=True)
        end = offset + limit if limit is not None else len(lines)
        return "".join(lines[offset:end])

    ns["fs"] = _types.SimpleNamespace(read=_fs_read)
    # Always available: reindex to point the body at a different project
    ns["reindex"] = _reindex
    # Phase 2: expose codebase object if indexed
    if CODEBASE is not None:
        ns["codebase"] = CODEBASE
    # Phase 3: expose vault proxy if connected
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

# Lock for stdout writes — both main thread and exec worker may write
_stdout_lock = threading.Lock()


def _write_response(response: dict) -> None:
    """Thread-safe write to stdout."""
    with _stdout_lock:
        sys.__stdout__.write(json.dumps(response) + "\n")
        sys.__stdout__.flush()


def handle_sync(msg: dict):
    """Handle synchronous (non-exec) ops. Returns response dict or None for shutdown."""
    global NAMESPACE, CODEBASE, VAULT
    op = msg.get("op")

    if op == "ping":
        return {"pong": True, "version": "0.2.0-single-mcp"}

    elif op == "reset":
        NAMESPACE = _build_namespace()
        return {"ok": True}

    elif op == "index":
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
        # Handled in background thread via _run_vault_op (proxy deadlock prevention)
        if VAULT is None:
            return {"error": "vault not connected"}
        return {"error": "vault_signature should be routed to background thread"}

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
            # Create proxy — no MCP subprocess spawned.
            # Vault calls route through TS bridge via stdout/stdin callbacks.
            VAULT = v_mod.Vault(vault_path)
            VAULT.connect()
            _rebuild_namespace()
            return {
                "ok": True,
                "vault_path": vault_path,
                "proxy": True,  # Signal to TS that this is the proxy pattern
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
        # Handled in background thread via _run_vault_op (proxy deadlock prevention)
        if VAULT is None:
            return {"error": "vault not connected"}
        return {"error": "vault_status should be routed to background thread"}

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


def _run_exec(msg: dict) -> None:
    """Run exec in a thread, write result to stdout when done."""
    code = msg.get("code", "")
    timeout_ms = msg.get("timeout_ms", DEFAULT_TIMEOUT_MS)
    if _rlm_module is not None:
        _rlm_module.reset_stats()
    result = repl.execute(code, NAMESPACE, timeout_ms)
    if _rlm_module is not None and _rlm_module.is_configured():
        stats = _rlm_module.get_stats()
        if stats["call_count"] > 0:
            result["rlm_stats"] = stats
    _write_response(result)


def _run_vault_op(op: str, msg: dict) -> None:
    """Run vault ops in a thread so vault proxy callbacks don't deadlock."""
    try:
        if op == "vault_signature":
            level = msg.get("level", "standard")
            max_tokens = msg.get("max_tokens", 1500)
            result = VAULT.signature(level=level, max_tokens=max_tokens)
        elif op == "vault_status":
            result = VAULT.status()
        else:
            result = {"error": f"unknown vault op: {op}"}
        _write_response(result)
    except Exception as e:
        import traceback
        _write_response({"error": f"{op} failed: {e}", "traceback": traceback.format_exc()})


def main():
    sys.stderr.write("[body] ready\n")
    sys.stderr.flush()

    # Track whether an exec is in flight so we know to route vault_responses
    exec_thread: threading.Thread | None = None

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            msg = json.loads(line)
        except json.JSONDecodeError as e:
            _write_response({"error": f"bad json: {e}"})
            continue

        # Route vault responses to the proxy (arrives from TS during exec)
        if "vault_response" in msg:
            if VAULT is not None:
                vr = msg["vault_response"]
                VAULT.resolve(vr["id"], vr["result"])
            continue

        # If there's a previous exec thread, wait for it before accepting new ops
        if exec_thread is not None:
            exec_thread.join()
            exec_thread = None

        op = msg.get("op")

        if op == "exec":
            # Run exec in a background thread so the main loop stays responsive
            # for vault_response messages that arrive during execution.
            exec_thread = threading.Thread(target=_run_exec, args=(msg,), daemon=True)
            exec_thread.start()
            continue

        # Vault ops that make proxy calls must also run in a thread to avoid
        # deadlocking the main loop (proxy writes vault_request to stdout,
        # then blocks waiting for vault_response on stdin — main loop must
        # be free to route those responses).
        if op in ("vault_signature", "vault_status") and VAULT is not None:
            exec_thread = threading.Thread(target=_run_vault_op, args=(op, msg), daemon=True)
            exec_thread.start()
            continue

        response = handle_sync(msg)
        if response is None:
            _write_response({"ok": True, "shutdown": True})
            break
        _write_response(response)

    # Clean up any running exec thread
    if exec_thread is not None:
        exec_thread.join(timeout=5.0)


if __name__ == "__main__":
    main()
