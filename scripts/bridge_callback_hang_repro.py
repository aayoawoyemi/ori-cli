"""
A.6.6 redo — bridge-callback hang repro.

The original scripts/done_hang_repro.py (Batch 2) exercised the `_async_raise`
+ stdout-lock deadlock hypothesis for pure-Python busy-loop execs. It got
0/100 on master, which we (correctly, per the pre-committed decision tree)
interpreted as "hypothesis not confirmed for that mechanism" — and skipped
the atomic-write refactor on that basis.

Tonight's live checkpoint session surfaced a different variant: three 122s
bridge timeouts on a workload involving vault.explore (a bridge-callback
primitive that blocks the worker thread in `event.wait` until TS sends
`vault_response` back). The standalone repro never exercised that path —
it has no TS bridge at all.

This repro spawns `body/server.py` AND a minimal bridge coroutine in the
Python test itself — reading body stdout, pattern-matching `fs_request`
(the only bridge-callback primitive we can test standalone, since vault/
research need a connected MCP we can't spawn here), and sending
`fs_response` back via stdin. Each trial cycle:

    1. fs.write(tmp, "content")  — bridged call. Bridge answers promptly.
    2. Tight busy loop with timeout_ms=2000 — triggers _async_raise.
       Previously, this would fire at a bytecode boundary that could be
       inside a proxy's `with self._stdout_lock:` block. After Batch 1.6
       there is no such lock; atomic os.write cannot deadlock.
    3. fs.read(tmp) — normal local read (no bridge).
    4. done(seq) — sentinel write (previously under module-level
       _stdout_lock, now atomic os.write).

Ship gate: 0 hangs in N trials post-fix (Batch 1.6 lands the atomic-write
refactor). Pre-fix run (if we check out afd7bda) would hypothetically
reproduce. A real confirmation requires reverting the refactor on a branch
and comparing — for the real-world walk-codemode failure, the fix's
plausibility rests on "we removed the only shared lock that could
deadlock under _async_raise," which is true by construction.

Usage:
    python scripts/bridge_callback_hang_repro.py                # 50 trials
    python scripts/bridge_callback_hang_repro.py --trials 200   # more confidence
    python scripts/bridge_callback_hang_repro.py --quiet        # summary only

Exit codes:
    0 — 0 hangs (ship gate met).
    1 — 1-5 hangs (iterate; tolerance for platform noise).
    2 — >=6 hangs (refactor didn't remove the hang path; investigate).
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BODY = ROOT / "body" / "server.py"

DEFAULT_TRIALS = 50
HANG_THRESHOLD_S = 8.0


class MockBridge:
    """Minimal in-process TS bridge. Reads body stdout in a background
    thread; for each `fs_request` message, writes a synthetic fs_response
    back via body stdin. All other sentinels (say/done/vault_request/etc.)
    are forwarded to a shared queue so the main thread can treat them as
    noise or consume them for exec-result routing.

    Designed to mirror the TS bridge's behavior in `handleFsCallback` at
    just enough fidelity to keep the body's worker thread unblocked
    during an fs.write/fs.edit/fs.patch call. Real TS bridge handles
    permission prompts, workspace-scope gates, etc.; the mock just
    answers {ok: true} so the body's exec completes normally.
    """

    def __init__(self, proc: subprocess.Popen, tmp_dir: Path) -> None:
        self.proc = proc
        self.tmp_dir = tmp_dir
        self.results_q: list[dict] = []
        self.results_lock = threading.Lock()
        self.stop_flag = False
        self.reader = threading.Thread(target=self._read_loop, daemon=True)

    def start(self) -> None:
        self.reader.start()

    def stop(self) -> None:
        self.stop_flag = True

    def _read_loop(self) -> None:
        """Pump body stdout. fs_request → synthesize a fs_response. Other
        messages → push to results_q for the main thread to pick up."""
        while not self.stop_flag:
            line = self.proc.stdout.readline()
            if not line:
                if self.proc.poll() is not None:
                    return
                time.sleep(0.005)
                continue
            try:
                obj = json.loads(line)
            except Exception:
                continue
            # fs_request: the body's Fs proxy is waiting on event.wait.
            # Answer with a minimal success envelope that matches the
            # real bridge's shape (TS side returns {ok: true, path, ...}).
            fs_req = obj.get("fs_request")
            if fs_req:
                self._answer_fs_request(fs_req)
                continue
            # Positive-match on real results BEFORE the sentinel skip —
            # exec result envelopes carry BOTH `duration_ms` AND `done`
            # (the latter from the _done_sink harvest), so filtering on
            # "done" first would eat our own results. Same bug I hit in
            # the original done_hang_repro — fixed identically here.
            if "duration_ms" in obj or "pong" in obj or "shutdown" in obj:
                with self.results_lock:
                    self.results_q.append(obj)
                continue
            # Fire-and-forget sentinels from inside exec — skip past.
            if "say" in obj or "done" in obj:
                continue

    def _answer_fs_request(self, req: dict) -> None:
        """Satisfy the body's fs_request as a real-ish TS bridge would.

        For `write` / `edit` / `patch` we actually perform the filesystem
        operation in-process — the real TS bridge does this via
        workspace-scoped paths; we skip the scope check but keep the
        side-effect so downstream `fs.read` ops in the same trial can
        see the file on disk."""
        req_id = req.get("id")
        method = req.get("method")
        args = req.get("args", {})
        try:
            if method == "write":
                path = args.get("path", "")
                content = args.get("content", "")
                with open(path, "w", encoding="utf-8") as f:
                    f.write(content)
                result = {"ok": True, "path": path, "bytes": len(content)}
            elif method == "edit":
                # Simple find-replace; not used in this repro but kept
                # for faithfulness to the real bridge shape.
                path = args.get("path", "")
                old, new = args.get("old", ""), args.get("new", "")
                with open(path, "r", encoding="utf-8") as f:
                    body = f.read()
                body = body.replace(old, new, 1)
                with open(path, "w", encoding="utf-8") as f:
                    f.write(body)
                result = {"ok": True, "replacements": 1, "path": path}
            else:
                result = {"ok": True}
        except Exception as e:
            result = {"error": f"mock bridge fs {method}: {e}"}
        self.send({"fs_response": {"id": req_id, "result": result}})

    def send(self, obj: dict) -> None:
        payload = (json.dumps(obj) + "\n").encode("utf-8")
        self.proc.stdin.write(payload)
        self.proc.stdin.flush()

    def take_result(self, deadline: float) -> dict | None:
        """Pop the next exec-result (duration_ms-bearing) from the queue,
        or return None if deadline elapses. Used by the main trial loop
        to wait for a specific exec to finish."""
        while time.time() < deadline:
            with self.results_lock:
                if self.results_q:
                    return self.results_q.pop(0)
            time.sleep(0.005)
        return None


def trial_cycle(
    bridge: MockBridge,
    seq: int,
    threshold: float,
    tmp_path: Path,
) -> list[tuple[str, float, str]]:
    """Run one 4-op cycle with bridge callbacks. Each op's deadline is
    budget + threshold; exceeding that counts as a hang. Returns a list
    of (label, elapsed_s, outcome) — outcome is "ok", "timed_out_ok"
    (for the intended busy-loop kill), "exc:<head>" (any exception
    raised in the exec), or "HANG" for bridge-level silence."""
    results: list[tuple[str, float, str]] = []
    tmp_file = str(tmp_path / f"trial_{seq}.txt")
    ops = [
        # label,           code,                                                                   budget
        (f"fswrite_{seq}", f"fs.write({tmp_file!r}, 'hello world'); print('ok')",                  5),
        (f"busy_{seq}",    "x = 0\nwhile True:\n    x += 1",                                       2),
        (f"fsread_{seq}",  f"print(len(fs.read({tmp_file!r})))",                                   5),
        (f"done_{seq}",    f"done({seq})",                                                         5),
    ]
    for label, code, budget in ops:
        t0 = time.time()
        bridge.send({"op": "exec", "code": code, "timeout_ms": int(budget * 1000)})
        r = bridge.take_result(t0 + budget + threshold)
        elapsed = time.time() - t0
        if r is None:
            results.append((label, elapsed, "HANG"))
            return results
        if r.get("timed_out"):
            results.append((label, elapsed, "timed_out_ok"))
            continue
        if r.get("exception"):
            exc_head = (r.get("exception") or "").splitlines()[-1][:80]
            results.append((label, elapsed, f"exc:{exc_head}"))
            continue
        results.append((label, elapsed, "ok"))
    return results


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--trials", type=int, default=DEFAULT_TRIALS)
    ap.add_argument("--threshold", type=float, default=HANG_THRESHOLD_S)
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    print(f"Spawning body: {BODY}")
    print(f"Trials: {args.trials}, hang threshold: {args.threshold}s\n")

    proc = subprocess.Popen(
        [sys.executable, "-u", str(BODY)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=str(ROOT),
    )
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        bridge = MockBridge(proc, tmp_path)
        bridge.start()
        try:
            bridge.send({"op": "ping"})
            r = bridge.take_result(time.time() + 10)
            if not r or not r.get("pong"):
                print(f"FAIL: body never responded to ping: {r}")
                return 3
            if not args.quiet:
                print("  ping OK\n")

            hangs = 0
            t_start = time.time()
            trials_run = 0

            for seq in range(args.trials):
                trials_run += 1
                cycle = trial_cycle(bridge, seq, args.threshold, tmp_path)
                any_hang = any(o == "HANG" for _, _, o in cycle)
                if any_hang:
                    hangs += 1
                if not args.quiet or any_hang:
                    for label, elapsed, outcome in cycle:
                        print(f"  trial {trials_run:3d} {label:18s} {elapsed:6.2f}s  {outcome}")
                if any_hang:
                    print(f"  trial {trials_run}: HANG — body unrecoverable, stopping early")
                    break

            total = time.time() - t_start
            print(f"\nCompleted {trials_run}/{args.trials} trials in {total:.1f}s")
            print(f"Hangs: {hangs}/{trials_run}")

            if hangs == 0:
                return 0
            if hangs <= 5:
                return 1
            return 2
        finally:
            bridge.stop()
            try:
                bridge.send({"op": "shutdown"})
                proc.wait(timeout=3)
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass


if __name__ == "__main__":
    sys.exit(main())
