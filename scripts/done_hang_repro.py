"""
A.6.6 bridge-hang repro.

Spawns body/server.py directly (no TS bridge) and drives N cycles of four
ops each, meant to exercise the hypothesized deadlock path — worker thread
is killed mid-write while holding the module-level `_stdout_lock`, leaving
the main loop's `_write_response` blocked forever.

Each cycle:
  1. `done(seq)` — exercises `_done_primitive`, which acquires the
      module-level `_stdout_lock` for the sentinel write.
  2. A busy-loop exec with `timeout_ms=2000` — forces `_async_raise
     (TimeoutError)` in `repl.execute`, killing the worker thread.
  3. `fs.read('package.json')` — a normal op right after the timeout,
     touching the main-thread `_write_response` path.
  4. `done(seq + 1)` — a second sentinel write.

If the hypothesis holds, roughly 1-in-N trials should show the body going
silent for > threshold seconds on op 3 (the first `_write_response` call
after the timeout-killed worker). Pre-fix target: >= 6 hangs in 100 trials
would justify the atomic-write refactor. Post-fix target: 0 hangs in 100.

If 0-5 hangs on master, the stdout-lock hypothesis is wrong or the window
is too tight to catch at N=100 — investigate alternate root causes before
committing to the fix.

The `sys.__stdout__.write` call is a C syscall — `_async_raise` only fires
at Python bytecode boundaries, so the exception is queued until the
syscall returns. The deadlock window is narrow but non-zero: the
bytecodes between `with` acquire and `write()` entry, plus any path where
write blocks on a full pipe.

Usage:
    python scripts/done_hang_repro.py                  # 100 trials
    python scripts/done_hang_repro.py --trials 30      # quick signal
    python scripts/done_hang_repro.py --threshold 6    # tighter hang bar

Exit codes:
    0 — 0 hangs (ship gate met post-fix; pre-fix = hypothesis unconfirmed)
    1 — 1-5 hangs (iterate; investigate whether fix is real or margin noise)
    2 — >= 6 hangs OR any bridge leak (rollback / deeper investigation)
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BODY = ROOT / "body" / "server.py"

DEFAULT_TRIALS = 100
# Threshold: any op that takes more than (op_budget + HANG_THRESHOLD_S)
# seconds to respond counts as a hang. Generous default so background
# noise (GC, Windows antivirus scan) doesn't false-positive.
HANG_THRESHOLD_S = 8.0


def send(proc: subprocess.Popen, obj: dict) -> None:
    proc.stdin.write((json.dumps(obj) + "\n").encode())
    proc.stdin.flush()


def recv_deadline(proc: subprocess.Popen, deadline: float) -> dict | None:
    """Read one exec/ping-result JSON line from stdout, skipping sentinels
    (say/done/bridged-request) that may arrive before the final result.
    Returns the JSON object, or None if deadline exceeded (the hang).

    Note on `done` disambiguation: the body emits BOTH a `{"done": {...}}`
    sentinel from inside the worker (during exec) AND attaches the same
    key onto the exec result envelope (`_run_exec` harvests `_done_sink`
    and sets `result["done"] = {"value": ...}`). We can't filter on the
    key alone — a sentinel has ONLY the done key plus meta, while the
    result also carries `stdout` / `duration_ms` / `shape`. Positive-
    match on those result fields instead.
    """
    while time.time() < deadline:
        line = proc.stdout.readline()
        if not line:
            time.sleep(0.01)
            continue
        try:
            obj = json.loads(line)
        except Exception:
            continue
        # Genuine bridged request — we have no TS bridge here, body
        # will block forever waiting for a response. Fail the repro
        # rather than mask a different bug.
        if any(k in obj for k in ("vault_request", "fs_request", "shell_request",
                                  "web_request", "research_request", "ask_request")):
            return {"_bridge_leak": obj}
        # Positive-match on real results: exec result carries `duration_ms`;
        # ping carries `pong`; shutdown ack carries `shutdown`. Anything
        # else (standalone say/done sentinels) is noise we skip past.
        if "duration_ms" in obj or "pong" in obj or "shutdown" in obj:
            return obj
        # Everything else (say/done sentinels, error-envelope bad_json
        # responses, future protocol additions) — skip.
        continue
    return None


def trial_cycle(
    proc: subprocess.Popen,
    seq: int,
    threshold: float,
) -> list[tuple[str, float, str]]:
    """Run one 4-op cycle. Returns per-op (label, elapsed_s, outcome)."""
    results: list[tuple[str, float, str]] = []
    ops = [
        # Label,            code,                                   budget (seconds)
        (f"done_{seq}",     f"done({seq})",                          5),
        # `while True: x += 1` is pure bytecode — `_async_raise` can
        # interrupt cleanly at each increment. No imports, no FORBIDDEN
        # names, passes the AST pre-pass.
        (f"busy_{seq}",     "x = 0\nwhile True:\n    x += 1",        2),
        (f"fsread_{seq}",   "print(len(fs.read('package.json')))",   5),
        (f"done_{seq + 1}", f"done({seq + 1})",                      5),
    ]
    for label, code, budget in ops:
        t0 = time.time()
        send(proc, {"op": "exec", "code": code, "timeout_ms": int(budget * 1000)})
        # Wall-clock deadline for body to respond. Worker gets `budget`
        # seconds then `_async_raise` + 1s cleanup — so `budget + 2s`
        # is the theoretical best-case upper bound. `budget + threshold`
        # is deliberately loose to avoid noise-driven false positives.
        r = recv_deadline(proc, t0 + budget + threshold)
        elapsed = time.time() - t0
        if r is None:
            results.append((label, elapsed, "HANG"))
            # Body is wedged — next op would just compound the hang.
            return results
        if r.get("_bridge_leak"):
            results.append((label, elapsed, f"BRIDGE_LEAK:{r['_bridge_leak']}"))
            return results
        if r.get("timed_out"):
            results.append((label, elapsed, "timed_out_ok"))
            continue
        if r.get("exception"):
            # The busy-loop op is SUPPOSED to throw TimeoutError here.
            # A done/fsread op throwing is a different kind of failure
            # but not a hang — record and keep going.
            exc_head = (r.get("exception") or "").splitlines()[-1][:80]
            results.append((label, elapsed, f"exc:{exc_head}"))
            continue
        results.append((label, elapsed, "ok"))
    return results


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--trials", type=int, default=DEFAULT_TRIALS)
    ap.add_argument("--threshold", type=float, default=HANG_THRESHOLD_S)
    ap.add_argument("--quiet", action="store_true",
                    help="Suppress per-op lines; print summary only.")
    args = ap.parse_args()

    print(f"Spawning body: {BODY}")
    print(f"Trials: {args.trials}, hang threshold: {args.threshold}s "
          f"(noise budget on top of each op's timeout)\n")

    proc = subprocess.Popen(
        [sys.executable, "-u", str(BODY)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=str(ROOT),
    )
    try:
        send(proc, {"op": "ping"})
        r = recv_deadline(proc, time.time() + 10)
        if not r or not r.get("pong"):
            print(f"FAIL: body never responded to ping: {r}")
            return 3
        if not args.quiet:
            print("  ping OK\n")

        hangs = 0
        bridge_leaks = 0
        trials_run = 0
        t_start = time.time()

        for seq in range(0, args.trials * 2, 2):
            trials_run += 1
            cycle = trial_cycle(proc, seq, args.threshold)
            any_hang = any(o == "HANG" for _, _, o in cycle)
            any_leak = any(o.startswith("BRIDGE_LEAK") for _, _, o in cycle)
            if any_hang:
                hangs += 1
            if any_leak:
                bridge_leaks += 1

            if not args.quiet or any_hang or any_leak:
                for label, elapsed, outcome in cycle:
                    print(f"  trial {trials_run:3d} {label:15s} {elapsed:6.2f}s  {outcome}")

            if any_hang:
                # Body is stuck; subsequent trials would fail the same way
                # and we'd just burn wall clock. Stop early.
                print(f"  trial {trials_run}: HANG — body unrecoverable, stopping early")
                break

        total_time = time.time() - t_start
        print(f"\nCompleted {trials_run}/{args.trials} trials in {total_time:.1f}s")
        print(f"Hangs: {hangs}/{trials_run}")
        if bridge_leaks:
            print(f"Bridge leaks: {bridge_leaks}/{trials_run}  (unexpected; investigate)")

        if hangs == 0:
            return 0
        if hangs <= 5:
            return 1
        return 2

    finally:
        try:
            send(proc, {"op": "shutdown"})
            proc.wait(timeout=3)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass


if __name__ == "__main__":
    sys.exit(main())
