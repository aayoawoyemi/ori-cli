# File: body/speak.py
# Purpose: User-facing I/O primitives exposed directly in the Repl namespace
#   as bare `say` and `ask` functions. Without them, a long-running Repl call
#   is silent to the user — the UI sees nothing until exec completes and the
#   tool_result comes back. With them, the Python body narrates progress in
#   real time (say) and can request input mid-execution without ending the
#   Repl call (ask). Together they break the request-response turn model:
#   one Repl call can span a full conversational exchange instead of forcing
#   the model to stop-and-speak-and-restart via text content blocks.
# Key pieces:
#   - Speak class, instantiated once at server startup as module-global SPEAK
#   - say(text) — fire-and-forget stdout notification, non-blocking
#   - ask(question, timeout) — blocking proxy, returns the user's typed string
#   - resolve(id, result) — called by server.py main loop when ask_response
#     arrives from TS, fires the threading.Event and unblocks ask()
# Role: Registered in the Repl namespace by server.py as ns["say"] and
#   ns["ask"] (bare names, NOT speak.say / speak.ask — the model calls them
#   like Python builtins). Mirrors the vault/research/fs callback pattern
#   exactly for the blocking path (ask); adds a simpler non-blocking path
#   (say) since no response is needed. See CODEMODE_ROADMAP.md §A6 and
#   ORI.md "callback pattern" rule — we do not invent a new transport.
#
# Why the file is named `speak` and not `io`:
#   body/ is inserted at sys.path[0] by server.py so modules can import each
#   other without package qualification. Naming this file `io.py` would
#   shadow Python's stdlib `io` module for every file in body/ that does
#   `import io` (today that includes json dependencies, future additions
#   likely too). `speak` is short, verb-flavored, and collision-free.

from __future__ import annotations

import json
import sys
import threading
from typing import Any


class AskError(Exception):
    """Raised when an ask() call times out or the TS side returns an error.

    Message is the text the model will see in its tool_result stderr — keep
    it teaching, not cryptic, so the model knows what to try next."""
    pass


class Speak:
    """
    User-facing I/O for the Repl namespace.

    say() is fire-and-forget — writes a notification to sys.__stdout__ and
    returns immediately. Text appears in the user's message stream as
    assistant voice. The Python code keeps running while the UI renders.

    ask() is blocking — writes a request to sys.__stdout__, blocks on
    threading.Event for ask_response, returns the user's typed answer as
    a string. Mirrors body/fs.py's callback pattern line-for-line —
    threading.Event for blocking, _pending dict for correlation, _stdout_lock
    for thread-safe writes. If you change this protocol, change fs.py and
    vault.py in the same commit (the bridge routes them identically).
    """

    def __init__(self) -> None:
        self._request_id = 0
        self._pending: dict[int, dict[str, Any]] = {}
        self._lock = threading.Lock()
        self._stdout_lock = threading.Lock()

    # ── Lifecycle ──────────────────────────────────────────────────────────
    # Speak has no "connect" step (same as Fs / Shell / Web). Always available
    # from process start. resolve() is kept on the class so server.py's main
    # loop can route ask_response messages uniformly with fs_response / etc.

    def resolve(self, request_id: int, result: Any) -> None:
        """Called by server.py main loop when ask_response arrives from TS."""
        with self._lock:
            if request_id in self._pending:
                self._pending[request_id]["result"] = result
                self._pending[request_id]["event"].set()

    def _next_id(self) -> int:
        self._request_id += 1
        return self._request_id

    # ── say — fire-and-forget ──────────────────────────────────────────────
    # No request_id, no threading.Event, no _pending entry. Just write the
    # notification to __stdout__ and return. The UI may or may not render it
    # depending on whether app.tsx registered an onSay handler; either way,
    # Python keeps running. Design rationale: say() is called rapidly in
    # loops ("processing file 1 of 50..."); paying a bridge round-trip per
    # call would halve throughput for nothing in return. If the pipe is
    # broken we're already in bigger trouble than a dropped say().

    def say(self, text: str) -> None:
        """
        Push `text` to the user's message stream. Non-blocking — Python
        execution continues immediately after the stdout write. Use during
        long-running Repl calls to narrate progress so the user isn't
        looking at a blank screen while the agent works.

        Args:
            text: the string to display. Coerced to str if not already.

        Dual-write behavior (added 2026-04, A.6.2): say() writes the text
        TWICE — once to sys.__stdout__ (the REAL stdout, where the bridge
        protocol reads the {"say": {...}} sentinel and streams it to the
        user's message feed in real time), and once to sys.stdout (the
        captured buffer during exec, which becomes result.stdout in the
        model's tool_result). The first write is the user-visible path;
        the second is the model-visible path — without the echo, the
        model writing `say(f"title: {x}")` to inspect x sees an empty
        tool_result and can't self-debug. Before dual-write, the Opus
        walk-codemode trace burned 3+ ops on blind-iteration because
        its own `say()` prints were invisible to it. Terminal UIs render
        the bridge sentinel stream — they do not double-display the
        echoed copy because tool_result doesn't surface to the user's
        message feed, it goes back to the model as input.
        """
        if not isinstance(text, str):
            text = str(text)
        msg = json.dumps({"say": {"text": text}})
        with self._stdout_lock:
            sys.__stdout__.write(msg + "\n")
            sys.__stdout__.flush()
        # Echo to sys.stdout so the model sees its own output in
        # tool_result. repl.py redirects sys.stdout during exec; this
        # print() lands in the captured buffer that becomes result.stdout.
        # Outside exec (e.g. standalone smoke tests importing Speak
        # directly), sys.stdout is the real stdout and this is a no-op
        # visual duplicate — harmless.
        print(text)

    # ── ask — blocking proxy ───────────────────────────────────────────────
    # Full callback round-trip with threading.Event. Timeout defaults to 5
    # minutes because the UI modal may block on a human who walked away
    # from the keyboard; a 30s timeout would surface as spurious AskError.
    # If the caller needs a tighter deadline (e.g. "answer in 10s or use
    # default X"), they can pass timeout explicitly.

    def ask(self, question: str, timeout: float = 300.0) -> str:
        """
        Pop a blocking prompt to the user. Python execution pauses here
        until the user types a response (or timeout fires).

        Args:
            question: the prompt shown in the UI modal
            timeout: max seconds to wait for input (default 300 = 5 min)

        Returns:
            The user's typed response as a string. Empty string if the user
            cancelled the modal (Esc) — check `if not answer:` to detect.

        Raises:
            AskError if the call times out or the TS side reports a failure.
        """
        if not isinstance(question, str):
            question = str(question)

        req_id = self._next_id()
        event = threading.Event()

        with self._lock:
            self._pending[req_id] = {"event": event, "result": None}

        # Same sys.__stdout__ vs sys.stdout rationale as say(): repl.py's
        # sys.stdout capture would swallow the request if we wrote to the
        # captured stream, leaving TS never to receive it and Python blocking
        # forever on the Event. Always use __stdout__ for bridge protocol.
        msg = json.dumps({"ask_request": {"id": req_id, "question": question}})
        with self._stdout_lock:
            sys.__stdout__.write(msg + "\n")
            sys.__stdout__.flush()

        if not event.wait(timeout=timeout):
            # Timeout cleanup — drop the pending entry so if the response
            # eventually arrives, resolve() won't fire into stale state.
            with self._lock:
                self._pending.pop(req_id, None)
            raise AskError(f"ask() timed out after {timeout}s waiting for user response")

        with self._lock:
            entry = self._pending.pop(req_id)
            result = entry["result"]

        # TS surfaces errors as {"error": "..."}; lift into AskError so the
        # model's except-handler can catch them as exceptions, not opaque
        # dicts. Matches fs.py / vault.py error lifting.
        if isinstance(result, dict) and "error" in result:
            raise AskError(result["error"])
        # Normal shape: {"answer": "..."}. Defensive fallback to str() for any
        # unexpected shape so the model never gets a surprise dict back.
        if isinstance(result, dict) and "answer" in result:
            return result["answer"]
        return str(result) if result is not None else ""
