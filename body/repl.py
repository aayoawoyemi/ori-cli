"""
Sandboxed exec() with timeout enforcement.

Runs user code in a restricted namespace with:
- AST pre-pass (via security.check_ast)
- Timeout via thread + async exception injection
- Captured stdout/stderr
- Structured error responses (not just tracebacks)
- Post-exec traceback enrichment for wrong-shape errors (Batch 1.5, 2026-04)

Thread-based timeout works on Windows and POSIX. Uses ctypes to inject
an asynchronous exception into the worker thread when the timeout fires.
"""
import sys
import io
import re as _re
import time
import threading
import ctypes
import traceback

from security import check_ast, SecurityError
from schema import NAMESPACE_SIGNATURES, primitives_by_length


# Exception classes that indicate a wrong-shape assumption against a
# primitive's return value. Enrichment fires for these; other classes
# (NameError, SyntaxError, ValueError, etc.) are left alone because
# appending a return-shape hint would mislead — "name 'codebase' is not
# defined" is an availability problem, not a shape problem.
_SHAPE_ERROR_CLASSES = frozenset({
    "KeyError", "AttributeError", "TypeError", "IndexError",
})

# Frame regex for parsing traceback format. The interpreter emits
# user-code frames as `File "<string>", line N, in <scope>\n    <source>`.
# We capture (lineno, source) for each such frame — the last one is the
# frame that raised. Non-`<string>` frames (stdlib, C extensions) are
# skipped because they indicate a chained / internal error, not user-
# shape error; enriching those would attach a wrong shape hint.
_FRAME_RE = _re.compile(
    r'File "<string>", line (\d+), in [^\n]+\n\s*([^\n]+)'
)


def _async_raise(thread_id: int, exc_type) -> None:
    """Inject an async exception into a running thread."""
    res = ctypes.pythonapi.PyThreadState_SetAsyncExc(
        ctypes.c_long(thread_id), ctypes.py_object(exc_type)
    )
    if res == 0:
        raise ValueError(f"invalid thread id: {thread_id}")
    if res > 1:
        ctypes.pythonapi.PyThreadState_SetAsyncExc(ctypes.c_long(thread_id), None)
        raise SystemError("PyThreadState_SetAsyncExc failed to inject exception")


# Registry of the currently-running worker thread id, set by execute()
# below and cleared in its finally. Used by cancel_current() so the
# body's cancel_exec handler can inject KeyboardInterrupt directly into
# the WORKER thread (not the outer thread that's just waiting in t.join).
# Single-slot because repl.execute is serialized at the body level —
# only one exec runs at a time. Cross-thread reads are safe because
# Python int assignments are GIL-atomic.
_CURRENT_WORKER_TID = None


def cancel_current() -> bool:
    """Inject KeyboardInterrupt into the currently-running worker thread.

    Returns True if an inject was attempted (worker was registered and
    PyThreadState_SetAsyncExc didn't error), False if no worker is
    running. A True return does NOT guarantee the worker unwound — on
    Windows, an OS-level wait (WaitForSingleObject under threading.Event)
    holds the GIL release indefinitely, so the async exception sits in
    PyThreadState until the wait returns to Python. Caller should
    join the outer exec thread with a short budget to confirm.
    """
    tid = _CURRENT_WORKER_TID
    if tid is None:
        return False
    try:
        _async_raise(tid, KeyboardInterrupt)
        return True
    except Exception:
        return False


def _find_primitive_in_line(line: str) -> str | None:
    """Return the rightmost primitive name present in `line`, or None.

    Uses length-desc ordering so `vault.query_ranked` beats `vault.query`
    on substring conflict. Picks the rightmost match so a chained call
    like `fs.read(hits[0]['path'])` attributes to `fs.read` (where the
    KeyError fires) rather than an earlier `vault.top` assignment that
    set `hits`.
    """
    best_name = None
    best_pos = -1
    for name in primitives_by_length():
        pos = line.rfind(name)
        if pos > best_pos:
            best_pos = pos
            best_name = name
    return best_name


def _find_primitive_in_code(code: str, failing_lineno: int) -> str | None:
    """Walk backward from the failing line through the original code to
    find the nearest primitive call assigned to a variable.

    Used when the failing frame's source line itself doesn't contain a
    primitive — e.g., `hits['notes'][0]` fails with KeyError but the
    primitive call that produced `hits` is 2 lines up. Caps the walk at
    20 lines to bound cost; that's well beyond any real composed batch's
    relevant context.
    """
    code_lines = code.splitlines()
    start = failing_lineno - 2  # convert to 0-index, step back one
    for i in range(start, max(-1, start - 20), -1):
        if i < 0 or i >= len(code_lines):
            continue
        hit = _find_primitive_in_line(code_lines[i])
        if hit:
            return hit
    return None


def _enrich_exception(tb: str, code: str) -> tuple[str, bool]:
    """Post-process a traceback string. If the last line is a wrong-shape
    error class AND we can identify the offending primitive, append a
    `NOTE: <primitive> returns <shape>` line. Return (maybe_enriched_tb,
    did_enrich).

    Never raises. Any internal failure (regex miss, unexpected traceback
    shape, unknown primitive) returns the original traceback unchanged
    with did_enrich=False. Enrichment is cosmetic teaching; a bug here
    must never corrupt a successful error report.

    For argument-count TypeErrors (message contains "takes" or "got"),
    appends the `sig` instead of `returns` so the model sees what the
    correct call looks like rather than what it returns.
    """
    try:
        if not tb:
            return tb, False
        # Last non-empty line is the exception class + message.
        tail_lines = [ln for ln in tb.rstrip().splitlines() if ln.strip()]
        if not tail_lines:
            return tb, False
        last_line = tail_lines[-1]
        exc_class = last_line.split(":", 1)[0].strip()

        # ── SyntaxError + TS-like code → hint that Repl is Python ──────
        # When Python raises SyntaxError on code that contains TypeScript-like
        # patterns (const, let, =>, interface, export), append a teaching hint.
        # This replaces the removed client-side looksLikeTypeScriptOrJavaScript
        # regex (repl.ts, deleted 2026-04-25) which false-positived on TS content
        # inside Python string literals. The Python AST is authoritative.
        # Output intentionally contains "TypeScript/JavaScript" so that
        # classifyToolRejection in loop.ts triggers tsOrJsInPythonRepl path.
        if exc_class == "SyntaxError":
            ts_hints = ["const ", "let ", "function ", "=>", "interface ", "export ", "var "]
            if any(h in code for h in ts_hints):
                return (
                    tb.rstrip()
                    + "\nNOTE: This looks like TypeScript/JavaScript — Repl runs "
                    + "Python. For TS file work, use fs.read/fs.edit/fs.write "
                    + "from Python.\n"
                ), True

        if exc_class not in _SHAPE_ERROR_CLASSES:
            return tb, False

        # Parse user-code frames. If there are none (internal-only
        # traceback — shouldn't happen in practice but safe to bail),
        # skip enrichment.
        frames = _FRAME_RE.findall(tb)
        if not frames:
            return tb, False
        lineno_str, failing_source = frames[-1]
        try:
            failing_lineno = int(lineno_str)
        except ValueError:
            return tb, False

        # First look in the failing source line itself — most common
        # case. If nothing, walk back through the original code for
        # the variable-assignment context.
        primitive = _find_primitive_in_line(failing_source)
        if primitive is None:
            primitive = _find_primitive_in_code(code, failing_lineno)
        if primitive is None:
            return tb, False

        entry = NAMESPACE_SIGNATURES.get(primitive)
        if not entry:
            return tb, False

        # Argument-count TypeErrors get the signature instead of returns.
        # Python's TypeError messages for these look like:
        #   "foo() takes 2 positional arguments but 3 were given"
        #   "foo() got an unexpected keyword argument 'bar'"
        #   "foo() missing 1 required positional argument: 'question'"
        # "missing" is the one the rlm_call(single_arg) failure hits; the
        # original heuristic had only takes/got and failed the enrichment
        # smoke on that case. Kept the check narrow — we want to treat
        # structural argument errors as signature problems, but NOT shape
        # errors that also say "TypeError" (e.g. "string indices must be
        # integers, not 'str'" — that's a returns-shape problem).
        want_sig = exc_class == "TypeError" and (
            "takes" in last_line
            or "got " in last_line  # trailing space — avoid matching "forgot" etc.
            or "missing" in last_line
        )
        if want_sig:
            hint = f"{primitive} signature {entry['sig']}"
        else:
            hint = f"{primitive} returns {entry['returns']}"
        return tb.rstrip() + f"\nNOTE: {hint}\n", True
    except Exception:
        # Enrichment must never propagate. Silent fallback preserves
        # the original traceback for the model to read.
        return tb, False


def _async_raise(thread_id: int, exc_type) -> None:
    """Inject an async exception into a running thread."""
    res = ctypes.pythonapi.PyThreadState_SetAsyncExc(
        ctypes.c_long(thread_id), ctypes.py_object(exc_type)
    )
    if res == 0:
        raise ValueError(f"invalid thread id: {thread_id}")
    if res > 1:
        ctypes.pythonapi.PyThreadState_SetAsyncExc(ctypes.c_long(thread_id), None)
        raise SystemError("PyThreadState_SetAsyncExc failed to inject exception")


def execute(code: str, namespace: dict, timeout_ms: int = 30000) -> dict:
    """
    Execute code in a sandboxed namespace with timeout enforcement.

    Returns a dict with:
      - stdout: str
      - stderr: str
      - exception: str | None (traceback if code raised)
      - duration_ms: int
      - rejected: {"reason": str} | None (AST security rejection)
      - timed_out: bool
    """
    start = time.time()

    # AST pre-pass — runs BEFORE any exec
    try:
        check_ast(code)
    except SecurityError as e:
        return {
            "stdout": "",
            "stderr": "",
            "exception": None,
            "duration_ms": int((time.time() - start) * 1000),
            "rejected": {"reason": str(e)},
            "timed_out": False,
        }

    stdout_buf = io.StringIO()
    stderr_buf = io.StringIO()

    state = {"exception": None, "done": False}

    def worker():
        old_stdout, old_stderr = sys.stdout, sys.stderr
        sys.stdout, sys.stderr = stdout_buf, stderr_buf
        try:
            exec(code, namespace)
        except BaseException:
            state["exception"] = traceback.format_exc()
        finally:
            sys.stdout, sys.stderr = old_stdout, old_stderr
            state["done"] = True

    t = threading.Thread(target=worker, daemon=True)
    t.start()
    # Register the worker tid so the body's cancel_exec handler can target
    # it via cancel_current(). Cleared in the finally below regardless of
    # how we exit (timeout, exception, normal completion).
    global _CURRENT_WORKER_TID
    _CURRENT_WORKER_TID = t.ident
    try:
        t.join(timeout=timeout_ms / 1000.0)
    finally:
        _CURRENT_WORKER_TID = None

    timed_out = False
    if not state["done"]:
        # Kill the thread via async exception injection
        try:
            _async_raise(t.ident, TimeoutError)
        except Exception:
            pass
        t.join(timeout=1.0)
        timed_out = True

    duration_ms = int((time.time() - start) * 1000)

    enriched = False
    if timed_out:
        exception_str = f"TimeoutError: execution exceeded {timeout_ms}ms"
    else:
        exception_str = state["exception"]
        # Enrich wrong-shape tracebacks with the offending primitive's
        # return shape so the model's next batch self-corrects without
        # a discovery turn. See _enrich_exception docstring. Timed-out
        # execs don't carry user traceback — skip enrichment for them.
        if exception_str:
            exception_str, enriched = _enrich_exception(exception_str, code)

    return {
        "stdout": stdout_buf.getvalue(),
        "stderr": stderr_buf.getvalue(),
        "exception": exception_str,
        "duration_ms": duration_ms,
        "rejected": None,
        "timed_out": timed_out,
        # `enriched` — boolean, true when _enrich_exception appended a
        # NOTE line. Exposed for telemetry: session logs can count how
        # often the schema-as-source-of-truth feature actually fired,
        # and a post-ship delta in .aries/repl-traces/ shows whether
        # the wrong-shape failure class dropped. Not used by the TS
        # side today; downstream can ignore if they don't need it.
        "enriched": enriched,
    }
