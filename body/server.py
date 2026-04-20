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
from fs import Fs
from shell import Shell
from web import Web
from speak import Speak

# Lazy imports (heavy deps) — only loaded when ops are used
_indexer = None
_codebase_module = None
_vault_module = None
_research_module = None
_rlm_module = None
CODEBASE = None  # CodebaseGraph instance, exposed via REPL namespace
VAULT = None  # Vault proxy instance, exposed via REPL namespace
RESEARCH = None  # Research proxy instance, exposed via REPL namespace

# Fs is always available (no connect step, no heavy deps), so instantiate it
# eagerly at module import. Lives for the full process lifetime. resolve()
# is called by the main loop when fs_response messages arrive — see the
# routing block in main() alongside the vault_response/research_response
# branches. Same pattern as those three proxies (vault, research, fs).
FS = Fs()

# Shell is also always available — no config needed. Same lifecycle as FS.
# resolve() called from the shell_response branch in main(). This is the
# codemode-era replacement for the top-level Bash tool: the model composes
# `shell.run("npm test")` inside Python instead of reaching for a sibling tool.
SHELL = Shell()

# Web mirrors Shell/Fs — always available, no config at the Python level.
# Provider selection (Tavily/Brave/etc) lives on the TS side and is pulled
# from AriesConfig.webSearch at dispatch time. The model just calls
# `web.fetch(url)` / `web.search(q)` without caring about backend config.
WEB = Web()

# Speak provides the agent's voice inside codemode: say() for fire-and-forget
# user-visible text, ask() for blocking input prompts. Same lifecycle as
# FS/SHELL/WEB — module-global, always available, no connect step. Namespace
# registration below binds ns["say"] = SPEAK.say and ns["ask"] = SPEAK.ask so
# the model calls them as bare functions (not speak.say / speak.ask), which
# matches the codemode intent: user-facing I/O should read like builtins, not
# namespaced API surface. See CODEMODE_ROADMAP.md §A6 for why the turn-break
# cost of text content blocks makes these primitives the critical path for
# collapsing N-turn tasks into single Repl calls.
SPEAK = Speak()


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


def _lazy_load_research():
    global _research_module
    if _research_module is None:
        import research as _r_mod
        _research_module = _r_mod
    return _research_module


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
        "hasattr": hasattr,
        "type": type,
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
    # fs is the unified filesystem primitive — read-side runs locally, write-side
    # routes through the bridge. Defined in body/fs.py. Replaces the inline
    # SimpleNamespace that previously lived here (which only had read/listdir/glob
    # and couldn't do mutations). Mutations now flow through the TS bridge, same
    # callback pattern as vault/research.
    #
    # History: this used to be a SimpleNamespace constructed inline with three
    # local helper functions (_fs_read, _fs_listdir, _fs_glob). Replaced
    # 2026-04-19 with body/fs.py's Fs class as part of codemode Phase A1 —
    # fs.write/fs.edit/fs.patch needed bridge callbacks so the TS side can
    # own workspace-scope checks, permission prompts, and edit snapshots.
    import json as _json
    ns["fs"] = FS
    # shell.run inside the Repl replaces the top-level Bash tool. See
    # body/shell.py header for the design rationale (no zigzag blocks,
    # because the model is already in Python — there's nothing to zigzag to).
    ns["shell"] = SHELL
    # web.fetch / web.search replace the top-level WebFetch / WebSearch tools.
    # Model composes search+fetch in a single Repl call instead of two
    # sequential tool calls.
    ns["web"] = WEB
    # say / ask are bound as BARE names — not speak.say / speak.ask — because
    # they are the agent's primary I/O channel to the user and should read as
    # part of the Python builtin surface. `say("hello")` matches `print("hello")`
    # in ergonomic weight; forcing `speak.say("hello")` would signal "this is
    # a subsystem" when in fact it's the default conversational channel once
    # the top-level text-block path gets stripped in A8. See body/speak.py
    # header for the full rationale.
    ns["say"] = SPEAK.say
    ns["ask"] = SPEAK.ask
    ns["json"] = _json
    # Always available: reindex to point the body at a different project
    ns["reindex"] = _reindex
    # Phase 2: expose codebase object if indexed
    if CODEBASE is not None:
        ns["codebase"] = CODEBASE
    # Phase 3: expose vault proxy if connected
    if VAULT is not None:
        ns["vault"] = VAULT
    # Phase 3b: expose research proxy if connected
    if RESEARCH is not None:
        ns["research"] = RESEARCH
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

# Session exec counter — bumped on every _run_exec entry. The first-turn
# banner is prepended to stdout only when this hits 1. Reset to 0 by the
# reset op so /reset re-arms the banner for a fresh session. Not thread-safe
# by itself, but only touched by _run_exec (which runs single-threaded per
# exec because main() joins the prior exec_thread before accepting another
# op — see main() ~line 510) and the reset op handler (which runs on the
# main loop, not the exec worker), so the ordering is safe.
_exec_count = 0

# Lock for stdout writes — both main thread and exec worker may write
_stdout_lock = threading.Lock()


def _write_response(response: dict) -> None:
    """Thread-safe write to stdout."""
    with _stdout_lock:
        sys.__stdout__.write(json.dumps(response) + "\n")
        sys.__stdout__.flush()


# ── First-turn banner ────────────────────────────────────────────────────
# The model's prompt doesn't describe the namespace anymore — A9 deletes
# that prose. Instead, the environment self-documents via the first Repl
# tool_result. When _run_exec fires the first exec of the session, this
# banner gets prepended to stdout so the model sees what's loaded before
# any of its own output. Structural discoverability beats prose teaching.
#
# Keep PRIMITIVES in sync with _build_namespace: if a new namespace
# primitive is registered there, add it here too or the model won't know
# it's available on first glance. The `available` filter drops primitives
# that aren't actually loaded in this session (codebase without an index,
# vault without a connection, etc.) — don't advertise capabilities the
# model can't use.

_BANNER_PRIMITIVES = [
    "codebase", "vault", "research",
    "fs", "shell", "web",
    "rlm_call", "rlm_batch",
    "say", "ask", "json", "reindex",
]


def _format_first_turn_banner() -> str:
    """Return the '=== Aries body ready ===' banner text for the first exec.

    Prepended verbatim to the first exec's stdout. Trailing newline so the
    model's own print() output lands on a clean line under the banner.
    """
    available = [p for p in _BANNER_PRIMITIVES if p in NAMESPACE]
    lines = [
        "=== Aries body ready ===",
        f"Namespace: {', '.join(available)}",
        "State: empty — variables you define here persist across Repl calls in this session",
        "Discovery: help(name) shows the API for any primitive; help(fs.read) works on methods too",
        "Idiom: compose multiple operations in one call — reads, searches, summaries, edits, says — using Python control flow. One composed call is the shape that wins.",
        "",
    ]
    return "\n".join(lines)


def handle_sync(msg: dict):
    """Handle synchronous (non-exec) ops. Returns response dict or None for shutdown."""
    global NAMESPACE, CODEBASE, VAULT, RESEARCH
    op = msg.get("op")

    if op == "ping":
        return {"pong": True, "version": "0.2.0-single-mcp"}

    elif op == "reset":
        global _exec_count
        NAMESPACE = _build_namespace()
        # Re-arm the first-turn banner so the next exec shows it again.
        # /reset is effectively "new session" from the model's perspective;
        # the environment reintroduces itself.
        _exec_count = 0
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

    elif op == "connect_research":
        try:
            r_mod = _lazy_load_research()
            if RESEARCH is not None:
                try:
                    RESEARCH.disconnect()
                except Exception:
                    pass
            RESEARCH = r_mod.Research()
            RESEARCH.connect()
            _rebuild_namespace()
            return {"ok": True, "proxy": True}
        except Exception as e:
            import traceback
            return {"error": f"research connect failed: {e}", "traceback": traceback.format_exc()}

    elif op == "disconnect_research":
        if RESEARCH is not None:
            try:
                RESEARCH.disconnect()
            except Exception:
                pass
            RESEARCH = None
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
                base_url=msg.get("base_url"),
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
    """Run exec in a thread, write result to stdout when done.

    First-exec side effect: on the FIRST exec of each session, the namespace
    banner is prepended to the result's stdout. The model sees the banner
    before any output its own code produced. This is how the environment
    self-documents (A7) after the prompt stops describing it (A9). Banner
    stays silent on subsequent execs — the model only needs it once to
    orient. /reset zeros _exec_count so a fresh session re-arms the banner.
    """
    global _exec_count
    code = msg.get("code", "")
    timeout_ms = msg.get("timeout_ms", DEFAULT_TIMEOUT_MS)
    if _rlm_module is not None:
        _rlm_module.reset_stats()

    _exec_count += 1
    is_first_exec = (_exec_count == 1)

    result = repl.execute(code, NAMESPACE, timeout_ms)

    if is_first_exec:
        # Prepend rather than replace — the model's own print() output
        # still needs to land in stdout. Banner then code-stdout, separated
        # by the banner's trailing blank line.
        banner = _format_first_turn_banner()
        result["stdout"] = banner + result.get("stdout", "")

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

        # Route research responses — MUST be before exec_thread.join() to avoid
        # deadlock. Same rule as vault_response: exec thread blocks waiting for
        # this response, so the main loop must be free to route it.
        if "research_response" in msg:
            if RESEARCH is not None:
                rr = msg["research_response"]
                RESEARCH.resolve(rr["id"], rr["result"])
            continue

        # Route fs responses — same deadlock rule as vault/research. The exec
        # thread is blocked in Fs._call() waiting on a threading.Event; main
        # loop stays responsive so it can fire the event via FS.resolve().
        # FS is module-global (not None-checkable like VAULT/RESEARCH) because
        # it's always instantiated — keep the branch structure identical for
        # consistency in case we ever gate it.
        if "fs_response" in msg:
            fr = msg["fs_response"]
            FS.resolve(fr["id"], fr["result"])
            continue

        # Route shell responses — identical shape to fs_response. Exec thread
        # blocks in Shell._call() waiting for the event, main loop routes the
        # response. Shell is module-global (same lifecycle as FS).
        if "shell_response" in msg:
            sr = msg["shell_response"]
            SHELL.resolve(sr["id"], sr["result"])
            continue

        # Route web responses — same pattern. Web is module-global.
        if "web_response" in msg:
            wr = msg["web_response"]
            WEB.resolve(wr["id"], wr["result"])
            continue

        # Route ask responses — ask() is the only blocking speak primitive.
        # say() is fire-and-forget and therefore has no *_response branch.
        # SPEAK is module-global (same lifecycle as FS/SHELL/WEB) so no
        # None-check is needed. If ask() timed out on the Python side the
        # _pending entry is already gone and resolve() is a no-op — safe.
        if "ask_response" in msg:
            ar = msg["ask_response"]
            SPEAK.resolve(ar["id"], ar["result"])
            continue

        # Unblock a timed-out or aborted research call
        if "cancel_research" in msg:
            if RESEARCH is not None:
                cr = msg["cancel_research"]
                RESEARCH.cancel(cr["id"])
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
