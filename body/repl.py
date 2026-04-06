"""
Sandboxed exec() with timeout enforcement.

Runs user code in a restricted namespace with:
- AST pre-pass (via security.check_ast)
- Timeout via thread + async exception injection
- Captured stdout/stderr
- Structured error responses (not just tracebacks)

Thread-based timeout works on Windows and POSIX. Uses ctypes to inject
an asynchronous exception into the worker thread when the timeout fires.
"""
import sys
import io
import time
import threading
import ctypes
import traceback

from security import check_ast, SecurityError


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
    t.join(timeout=timeout_ms / 1000.0)

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

    if timed_out:
        exception_str = f"TimeoutError: execution exceeded {timeout_ms}ms"
    else:
        exception_str = state["exception"]

    return {
        "stdout": stdout_buf.getvalue(),
        "stderr": stderr_buf.getvalue(),
        "exception": exception_str,
        "duration_ms": duration_ms,
        "rejected": None,
        "timed_out": timed_out,
    }
