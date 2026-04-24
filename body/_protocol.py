"""
Single atomic-write helper for the body↔bridge JSON protocol.

Why this exists: every proxy in body/ used to hold its own
`threading.Lock` around `sys.__stdout__.write(msg + "\n"); flush()`. That
protected against Python-level concurrent writes at the cost of exposing
a deadlock window — `_async_raise(TimeoutError)` (body/repl.py's timeout
mechanism) can fire at Python bytecode boundaries inside the `with
lock:` block, and while Python's with-statement semantics *should*
release the lock during async-exception unwinding, the empirical
evidence (walk-codemode 95s hang + subsequent 122s bridge-callback
timeouts) suggests the cleanup path is not reliable under load. The
threat model that justified the locks (concurrent writers fighting over
stdout) doesn't exist in practice: body/server.py's main loop joins the
prior exec thread before starting a new one, and main itself never
writes during exec, so there is only ever ONE writer at a time.

The fix: drop the Python locks and rely on OS-level pipe-write
atomicity. Both POSIX (pipe(7)) and Windows (WriteFile on anonymous
pipes) serialize pipe writes for messages under PIPE_BUF (4096 bytes on
Linux, similar on Windows). All our protocol messages are 100-500
bytes; the largest ones (exec results carrying captured stdout/stderr)
may exceed that, but they are emitted from only one writer at a time
(the worker thread's _run_exec → _write_response path) so non-atomic
writes across syscalls are fine — nothing interleaves with them.

`os.write` is a single syscall. `sys.__stdout__.buffer.write` wraps a
BufferedWriter that could (in principle) flush at arbitrary points and
interleave partial writes if we ever had two writers. Going straight to
`os.write(fd, bytes)` sidesteps that concern entirely.

Usage (replaces every `with lock: sys.__stdout__.write(...); flush()`):
    from _protocol import write_message
    write_message({"vault_request": {"id": req_id, "method": m, "args": a}})

No lock, no flush, no encoding boilerplate at the call site. Just the
dict you'd have passed to json.dumps anyway.
"""
from __future__ import annotations

import json
import os
import sys


def write_message(obj: dict) -> None:
    """Serialize `obj` to a single JSON line and write atomically to
    bridge stdout via os.write on sys.__stdout__.fileno().

    Partial writes are handled via a memoryview loop — POSIX write(2)
    can return before delivering all bytes on very large messages, though
    in practice pipes always deliver fully for sub-PIPE_BUF payloads.
    The loop costs ~5ns in the fast path and makes the helper robust to
    any future large-message case.

    Never raises on the happy path. OSError (broken pipe, etc.) will
    propagate — that's the correct behavior; a downstream writer that
    can't reach the bridge should surface the failure, not swallow it.

    Not thread-safe in the pathological case where TWO threads call
    write_message concurrently with messages >PIPE_BUF each. body/ does
    not currently have that shape (main loop and worker thread do not
    run concurrently for writes) and this helper documents the
    invariant. If a future change introduces concurrent writers, either
    split the large messages into <PIPE_BUF chunks or add a coarse-
    grained lock — but do NOT put the lock back around the original
    write/flush pattern, which is what deadlocked in the first place.
    """
    payload = (json.dumps(obj) + "\n").encode("utf-8")
    fd = sys.__stdout__.fileno()
    view = memoryview(payload)
    while view:
        n = os.write(fd, view)
        if n <= 0:
            # Kernel returned 0 or negative — shouldn't happen on a
            # healthy pipe. Break to avoid infinite loop; any truncated
            # message surfaces as malformed JSON on the bridge side,
            # which the bridge already handles with an error envelope.
            break
        view = view[n:]
