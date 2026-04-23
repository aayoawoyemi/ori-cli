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
import os.path as _ospath
from types import SimpleNamespace as _SimpleNamespace
from pathlib import Path

# Pure-function stdlib modules bound into the Repl namespace at build
# time (A.6.4, 2026-04). Kills the model's `import re` / `import datetime`
# reflex that currently costs a turn on every session — the AST pre-pass
# blocks every `import`, and the model doesn't know re is already available
# under a bare name until it's tried. Only pure computation modules are
# bound: no network, no fs, no process side-effects. DO NOT extend this
# list with subprocess / threading / socket / urllib / pickle / ctypes /
# pathlib (ambiguous — has side-effecting methods) / `os` (the stub on
# line 35 bounds it to os.path-only for exactly this reason). The
# `import` block still fires on explicit `import re` inside exec — the
# pre-binding sidesteps the reflex, it doesn't relax the guard.
import re as _re
import datetime as _datetime
import random as _random
import statistics as _statistics
import collections as _collections
import itertools as _itertools
import math as _math

# Namespace-bound `os` surface for the REPL sandbox. Only `.path` is exposed
# — the full os module stays blocked. A10 surfaced that Sonnet 4.6's top
# `import` reflex is `import os` for os.path.join / normpath / basename,
# which are pure string functions with zero side-effect surface. Binding
# an `os` stub with just `.path` populated kills the import reflex without
# opening os.system, os.remove, os.environ, os.getpid. If a future need
# arises for another os.* member, extend this stub with that specific
# member — never bind the whole `os` module.
_OS_STUB = _SimpleNamespace(path=_ospath)


# ── Codebase-not-ready stub (Fix B — A10 follow-up) ──────────────────────
# Problem: bridge.index() runs asynchronously at startup. If the model fires
# its first codebase.search / find_symbol / etc. BEFORE the index completes,
# _build_namespace's `if CODEBASE is not None` guard leaves `codebase` unbound
# and the model gets NameError. NameError is uninformative — the model
# doesn't learn that (a) the index is still compiling and (b) it can either
# retry or fall back to fs.glob + shell.run.
#
# This stub stands in for the real CodebaseGraph during the indexing window.
# Every public method returns a structured error with a recovery hint. The
# stub is replaced with the real graph as soon as indexing completes (see
# the index op handler). Once replaced, there's no way to observe the stub
# again unless an index rebuild is triggered.
#
# Keep the public surface in sync with body/codebase.py's CodebaseGraph —
# if you add a method there, add it here. The teaching error is the same
# across methods; only the method name in the message differs.
class _CodebaseNotReady:
    # Two distinct failure modes map to two distinct teaching messages.
    # The stub reads ENV_MODE (set by the configure op) to pick the right
    # message at error time, not at bind time — because the mode may not
    # be known when this stub is first instantiated.
    _MSG_BUILDING = (
        "codebase index still compiling (runs in background at startup — usually "
        "~5s for small repos, longer for large ones). Either retry this same call "
        "in a moment, or fall back to fs.glob + shell.run('grep ...') for now. "
        "This stub goes away once indexing completes."
    )
    _MSG_VAULT_ONLY = (
        "codebase index is disabled in vault-only mode (cwd is the vault itself — "
        "a vault is markdown notes, not source code). For file operations use "
        "fs.glob + fs.read + shell.run. For memory operations use vault.*."
    )

    def _err(self, method: str) -> dict:
        msg = self._MSG_VAULT_ONLY if ENV_MODE == "vault-only" else self._MSG_BUILDING
        return {"error": f"codebase.{method}: {msg}"}

    def search(self, *_args, **_kwargs): return self._err("search")
    def find_symbol(self, *_args, **_kwargs): return self._err("find_symbol")
    def get_context(self, *_args, **_kwargs): return self._err("get_context")
    def show_dependents(self, *_args, **_kwargs): return self._err("show_dependents")
    def communities(self, *_args, **_kwargs): return self._err("communities")
    def find_convention(self, *_args, **_kwargs): return self._err("find_convention")
    def stats(self, *_args, **_kwargs): return self._err("stats")
    def refresh_files(self, *_args, **_kwargs): return self._err("refresh_files")

_CODEBASE_STUB = _CodebaseNotReady()

# Ensure body/ is importable regardless of cwd
sys.path.insert(0, str(Path(__file__).parent))

import repl
from fs import Fs
from shell import Shell
from web import Web
from speak import Speak
from shape import analyze_shape

# Lazy imports (heavy deps) — only loaded when ops are used
_indexer = None
_codebase_module = None
_vault_module = None
_research_module = None
_rlm_module = None
CODEBASE = None  # CodebaseGraph instance, exposed via REPL namespace
VAULT = None  # Vault proxy instance, exposed via REPL namespace
RESEARCH = None  # Research proxy instance, exposed via REPL namespace

# ── Environment-awareness globals (Fix 1A — A10 finding) ─────────────────
# Display-only metadata populated by the `configure` op that the TS harness
# sends after `ping` succeeds and BEFORE the first exec. Purpose: make the
# first-turn banner honest about *where* the body is running.
#
# Name prefix is ENV_* (not bare PROJECT/SHELL/etc) on purpose: the module
# already has primitive bindings named SHELL (the Shell() instance on line
# 55) and is likely to add more in the future (VAULT, RESEARCH already
# exist). Display metadata and primitive instances must not share a name
# space — a bare `SHELL` display-global would shadow the primitive at
# module load time and break ns["shell"] binding in _build_namespace.
# Keep ENV_* reserved for banner display, never for primitive wiring.
#
# Fields:
#   - ENV_PROJECT      : absolute path to cwd (the "project root" from the
#                        user's perspective). Display-only metadata.
#   - ENV_VAULT_GLOBAL : absolute path to the global vault (~/brain typ).
#                        Actual vault connection is still via connect_vault.
#   - ENV_VAULT_PROJECT: absolute path to the project-local .ori/ once Fix
#                        1B lands. Today always None until that ships.
#   - ENV_MODE         : "project+vault" or "vault-only". Computed on the
#                        TS side by comparing resolve(cwd) to the vault
#                        path. Banner reflects it so the model doesn't
#                        expect codebase operations when cwd IS the vault.
#   - ENV_SHELL        : "cmd.exe" or "/bin/sh" — the shell shell.run will
#                        spawn. Announced so the model avoids Unix-isms on
#                        Windows (grep/rg/etc failed in A10 on Windows).
#
# Default None so the banner degrades gracefully if configure was never
# sent (standalone smoke tests, TS regression dropping the op). The
# formatter omits lines whose value is None — we never display "None".
ENV_PROJECT = None
ENV_VAULT_GLOBAL = None
ENV_VAULT_PROJECT = None
ENV_MODE = None
ENV_SHELL = None

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


# ── done() commitment primitive ──────────────────────────────────────────
# done(value) is the namespace primitive for explicit turn commitment. The
# model writes `done(answer)` as the last op of a batch when it has the
# final result and wants to close the turn cleanly. Following the RLM paper
# precedent (FINAL / FINAL_VAR) — making commitment syntactic rather than
# implicit-text-only gives frontier models a clean exit and surfaces the
# committed value in telemetry for measurement.
#
# Two-path delivery:
#   1. Real-time sentinel — writes {"done": {"value": ...}} to sys.__stdout__
#      so the bridge can emit a ReplEvent during exec (UI can observe).
#   2. Result envelope — module-global _done_sink buffers committed values
#      for the current exec; _run_exec harvests the buffer after the worker
#      thread completes and attaches result["done"] = {"value": last_commit}.
#      This gives the loop a post-exec field to react to without having to
#      intercept the event stream.
#
# Last-commit-wins if done() fires multiple times in the same batch. Rare
# enough that documenting-last-write is simpler than concatenating.
_done_sink: list = []
_done_sink_lock = threading.Lock()


def _safe_for_json(value):
    """Coerce value to something json.dumps() won't choke on. Non-serializable
    inputs fall back to str() — the committed value is for telemetry/narrative,
    not round-trip computation, so string coercion is acceptable."""
    try:
        json.dumps(value)
        return value
    except (TypeError, ValueError):
        return str(value)


def _done_primitive(value=None):
    """Commit `value` as the turn's final answer and signal turn-end intent.

    Non-raising: execution of the surrounding batch continues. The harness
    records the committed value in telemetry and the loop decides whether
    to force turn-end based on its own policy. If called multiple times,
    the last call wins.

    Typical usage — last op of a batch:
        done(my_answer)
        # or
        done({"result": my_answer, "files_touched": paths})
    """
    safe = _safe_for_json(value)
    # Write the real-time sentinel to the REAL stdout (not the captured
    # stream that repl.py redirects during exec). Same rationale as say()
    # and ask_request — the bridge protocol must not be swallowed by the
    # stdout capture, or the bridge will never see the signal.
    payload = json.dumps({"done": {"value": safe}})
    with _stdout_lock:
        sys.__stdout__.write(payload + "\n")
        sys.__stdout__.flush()
    # Also buffer for _run_exec to harvest post-exec and attach to result.
    with _done_sink_lock:
        _done_sink.append(safe)


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
        # __import__ is needed for internal stdlib machinery (e.g.
        # datetime.date.today()'s C-extension fallback does a runtime
        # lookup that KeyErrors without it). Safe to expose because the
        # AST pre-pass already lists __import__ in FORBIDDEN_NAMES and
        # FORBIDDEN_ATTRS (body/security.py) — any model-written
        # __import__('os') / getattr(x, '__import__') / etc. is rejected
        # before exec runs. Internal body code and pre-bound stdlib
        # modules (A.6.4) don't go through the AST pass, so they can
        # resolve this entry at runtime without tripping the guard.
        "__import__": _builtins.__import__,
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
        # help() is bound as the API-discovery primitive the banner advertises
        # (`Discovery: obj.__doc__ shows the API... help(name) also works`).
        # Pure docstring introspection — no privilege-escalation surface beyond
        # what obj.__doc__ already exposes. Keep dir/vars/globals BLOCKED:
        # those enumerate scope and are useful to sandbox-escape patterns;
        # help is not. If a future refactor deletes help() from the banner,
        # this binding can go with it — but leaving it costs essentially
        # nothing and matches Python's default discovery idiom.
        "help": _builtins.help,
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
    # done(value) — commit final answer, signal turn-end. See _done_primitive
    # at module top for the two-path delivery (real-time sentinel + post-exec
    # result-envelope harvest). Bound as a bare name (not done.* / commit.*)
    # because it IS the commitment verb and should read as a Python builtin
    # alongside say/ask. Keep in sync with _BANNER_PRIMITIVES below.
    ns["done"] = _done_primitive
    ns["json"] = _json
    # os.path pre-bound via the _OS_STUB SimpleNamespace defined at module
    # top. See the comment there for the full rationale. The model types
    # `os.path.join(...)` as its default path-manipulation move; without
    # this binding the `import os` reflex burns a turn on every session.
    ns["os"] = _OS_STUB
    # Pure-function stdlib modules — see the import comment at module top
    # for the binding rationale and the explicit "not bound" list. Keep
    # _BANNER_PRIMITIVES in sync (so `help(re)` discovery works) and keep
    # this list in sync with the A.6.4 contract (pure computation only).
    ns["re"] = _re
    ns["datetime"] = _datetime
    ns["random"] = _random
    ns["statistics"] = _statistics
    ns["collections"] = _collections
    ns["itertools"] = _itertools
    ns["math"] = _math
    # Always available: reindex to point the body at a different project
    ns["reindex"] = _reindex
    # Phase 2: expose codebase object. When indexing completes, `codebase`
    # is the real CodebaseGraph. During the indexing window (async startup)
    # `codebase` is a stub that returns teaching errors instead of raising
    # NameError. Fix B — A10 surfaced that an early codebase.search() call
    # before index completion was silently failing (NameError → model
    # paraphrased as "no matches"). The stub makes the "not ready yet"
    # state observable to the model with a retry hint.
    ns["codebase"] = CODEBASE if CODEBASE is not None else _CODEBASE_STUB
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
# Bumped 30000 → 90000 on 2026-04-21 (v0.5 Phase 1.5). The TS bridge default
# was 30s and vault.explore needs 30-60s server-side, which guaranteed bridge
# timeouts on the walk-codemode-region trace. Body-side default matches the
# bridge so msg.get("timeout_ms", DEFAULT_TIMEOUT_MS) doesn't accidentally
# fall back to a tighter budget than the bridge enforces. See bridge.ts and
# config/defaults.ts for the full rationale.
DEFAULT_TIMEOUT_MS = 90000

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
    "say", "ask", "done", "json", "os", "reindex",
    # Stdlib modules pre-bound in A.6.4 (2026-04) — kills the import-reflex
    # turn-tax. Order matches the "most-reached-for" first so the banner's
    # Namespace line reads as rough-frequency. Keep in sync with the ns
    # bindings in _build_namespace above.
    "re", "datetime", "random", "statistics",
    "collections", "itertools", "math",
]

# Shape cheat-sheet (A.6.5, 2026-04) — one-line signatures for the most-
# reached-for primitives, rendered in the first-turn banner so the model
# writes its first composed batch with correct return-shape assumptions
# on turn 1 instead of turn 4. Walks the cost down from probe-then-use
# ("print(type(result))" costs an op) to assume-correctly. Keep shapes
# terse; anything that needs more context belongs in the primitive's
# docstring (accessible via `help(name)`), not here.
#
# If a primitive's return shape changes, update the matching line below
# OR delete the line entirely (silence is better than a lying cheat-
# sheet). Never teach a key the primitive doesn't return — that was the
# A.6.1 root-cause pattern we're systematically eliminating.
_BANNER_SHAPES = [
    ("fs.read(path)",                 "str"),
    ("fs.listdir(path)",              "list[str]"),
    ("fs.glob(pattern)",              "list[str]"),
    ("shell.run(cmd, timeout=30)",    "{stdout, stderr, code}"),
    ("codebase.search(q, n=20)",      "list[{file, line, symbol, snippet}]"),
    ("vault.top(q, n=3)",             "{results: [{title, path, score, snippet, ...}]}"),
    ("vault.neighbors(title)",        "{neighbors: [{title, path|None}]}"),
    ("vault.get_note(title)",         "str   (raises VaultError with suggestions on miss)"),
    ("rlm_call(slice, question)",     "str"),
    ("say(text) / ask(q) / done(v)",  "user-facing I/O + turn commit"),
]


def _format_first_turn_banner() -> str:
    """Return the '=== Aries body ready ===' banner text for the first exec.

    Prepended verbatim to the first exec's stdout. Trailing newline so the
    model's own print() output lands on a clean line under the banner.

    Environment lines (Project/Vault/Mode/Shell) come from module globals
    populated by the `configure` op — see the PROJECT/VAULT_GLOBAL block at
    the top of this file. If `configure` hasn't fired (standalone substrate
    smoke, regression, etc.) those lines are simply omitted rather than
    displayed with "None" values — a degraded banner is better than a
    misleading one.

    Ordering is deliberate: environment before namespace. The model should
    know *where* it is before it knows *what* it has. A10 found that a
    wrong-cwd session (ori launched from ~/brain, but the model thinks
    it's in the aries-cli project) burns 2-3 turns before discovering the
    mismatch via errors. Announcing cwd first makes the mismatch
    immediately visible to the model AND to the user reading the trace.
    """
    available = [p for p in _BANNER_PRIMITIVES if p in NAMESPACE]
    lines = ["=== Aries body ready ==="]

    # Environment block — only emit lines whose value was populated.
    # The `(none)` phrasing on VAULT_PROJECT is intentional: the model
    # needs to know the project vault slot EXISTS as a concept even when
    # empty, so it knows vault.add(scope="project") is the way to create
    # one. Without that phrasing the model may not realize the slot is
    # available at all.
    if ENV_PROJECT:
        lines.append(f"Project: {ENV_PROJECT}")
    if ENV_VAULT_GLOBAL:
        lines.append(f"Vault (global): {ENV_VAULT_GLOBAL}")
    if ENV_VAULT_PROJECT:
        lines.append(f"Vault (project): {ENV_VAULT_PROJECT}")
    elif ENV_PROJECT and ENV_MODE == "project+vault":
        # Only advertise the empty project-vault slot when we're actually
        # in a project (not when cwd == vault — brain doesn't get a
        # project-layered vault on top of itself).
        lines.append('Vault (project): (none — vault.add(scope="project") will create .ori/ here)')
    if ENV_MODE:
        lines.append(f"Mode: {ENV_MODE}")
    if ENV_SHELL:
        lines.append(f"Shell: {ENV_SHELL}")
        # Shell syntax hint added 2026-04-21 (v0.5 Phase 1.5). The Opus
        # walk-codemode trace burned 2 calls probing shell syntax (echo + a
        # shell.run with `&&` that errored on cmd.exe). The model knows the
        # shell name from the line above, but doesn't translate "cmd.exe" into
        # "no &&, use dir" without explicit syntax cues. Spell it out so the
        # syntax-mismatch turn-tax goes to zero. Detection is intentionally
        # crude — .exe means Windows, anything else assumed Unix-like — because
        # ENV_SHELL is populated TS-side from the documented two-value set
        # ("cmd.exe" | "/bin/sh") and we'd rather under-emit a hint than
        # assert the wrong syntax for an unknown shell.
        _shell_lower = ENV_SHELL.lower()
        if _shell_lower.endswith(".exe") or _shell_lower.startswith("cmd"):
            lines.append(
                "Shell syntax: Windows cmd — use `dir` not `ls`, no `&&` chains "
                "(separate shell.run calls or `;`), prefer fs.glob/fs.read/codebase.* "
                "over Unix CLI tools (grep/rg/find/sed) which won't be on PATH."
            )
        else:
            lines.append(
                "Shell syntax: Unix — `ls`, `grep`, `&&` chains all work; "
                "forward-slash paths."
            )

    lines.extend([
        f"Namespace: {', '.join(available)}",
        "State: empty — variables you define here persist across Repl calls in this session",
        "Discovery: obj.__doc__ shows the API for any primitive; fs.read.__doc__ works on methods too",
        "Idiom: compose multiple operations in one call — reads, searches, summaries, edits, says — using Python control flow. One composed call is the shape that wins.",
    ])
    # Shape cheat-sheet (A.6.5). Render the subset of _BANNER_SHAPES whose
    # leading primitive (name before the first `.` or `(`) is actually
    # available in the namespace this session. Filter exists so e.g. a
    # vault-less session doesn't advertise vault.* shapes. Column-align
    # the "→" so the sheet reads as a table at a glance.
    visible_shapes = []
    for sig, ret in _BANNER_SHAPES:
        head = sig.split("(", 1)[0].split(".", 1)[0].split("/", 1)[0].strip()
        # `say / ask / done` line has multiple heads joined by ` / ` — always
        # visible when any of say/ask/done are in namespace (they always are).
        if head in available or head in {"say", "ask", "done"}:
            visible_shapes.append((sig, ret))
    if visible_shapes:
        pad = max(len(sig) for sig, _ in visible_shapes)
        lines.append("Shapes:")
        for sig, ret in visible_shapes:
            # ASCII arrow so the banner round-trips through every terminal
            # encoding (Windows cp1252 can't encode U+2192 and crashes
            # when the smoke test re-prints the body's stdout). Pretty
            # typography isn't worth a platform-portability footgun on
            # the most-read teaching surface we have.
            lines.append(f"  {sig.ljust(pad)} -> {ret}")
    lines.append("")
    return "\n".join(lines)


def handle_sync(msg: dict):
    """Handle synchronous (non-exec) ops. Returns response dict or None for shutdown."""
    global NAMESPACE, CODEBASE, VAULT, RESEARCH
    op = msg.get("op")

    if op == "ping":
        return {"pong": True, "version": "0.2.0-single-mcp"}

    elif op == "configure":
        # Populates environment-awareness module globals consumed by the
        # first-turn banner. The TS harness fires this right after `ping`
        # succeeds and BEFORE the first exec, so by the time the banner
        # renders the values are already set. All fields are optional —
        # the banner's formatter handles missing values cleanly.
        #
        # This is NOT the place to wire vault connections or codebase
        # indexes. Those have their own ops (connect_vault, index) with
        # their own response shapes. This op is purely metadata the body
        # displays back to the model on turn one. Keep it that way —
        # routing through one configure op would couple unrelated
        # lifecycles and complicate error handling.
        global ENV_PROJECT, ENV_VAULT_GLOBAL, ENV_VAULT_PROJECT, ENV_MODE, ENV_SHELL
        ENV_PROJECT = msg.get("project") or ENV_PROJECT
        ENV_VAULT_GLOBAL = msg.get("vault_global") or ENV_VAULT_GLOBAL
        ENV_VAULT_PROJECT = msg.get("vault_project") or ENV_VAULT_PROJECT
        ENV_MODE = msg.get("mode") or ENV_MODE
        ENV_SHELL = msg.get("shell") or ENV_SHELL
        return {"ok": True}

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

    # Attach shape telemetry. Analysis is pure inspection of the submitted
    # code (parses the AST separately from security.check_ast — cheap). Runs
    # unconditionally because the metrics are how we measure whether the
    # schema-enforcement change actually moves composition-ratio; disabling
    # it would blind the experiment. If the parse fails, analyze_shape
    # returns a dict with an `error` field rather than raising, so exec
    # results always carry a shape entry.
    result["shape"] = analyze_shape(code)

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

    # Harvest done() commits from this exec. Last-write-wins if the batch
    # called done() multiple times. Buffer lives at module scope (see
    # _done_sink / _done_primitive at top of file) and must be cleared after
    # each exec so stale commits don't bleed into the next batch.
    with _done_sink_lock:
        if _done_sink:
            result["done"] = {"value": _done_sink[-1]}
            _done_sink.clear()

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
