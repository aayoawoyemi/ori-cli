"""Body API contract tests. Hand-runnable: python body/test_api_contract.py"""
import json
import os
import subprocess
import sys
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
BODY = ROOT / "body" / "server.py"
FIXTURE_DIR = ROOT / ".aries" / "tmp"
FIXTURE_PATH = FIXTURE_DIR / "body-api-contract.txt"
STATE_DIR = FIXTURE_DIR / "body-state-contract"


pass_count = 0
fail_count = 0


def check(name, cond, detail=""):
    global pass_count, fail_count
    if cond:
        print(f"  PASS  {name}" + (f" - {detail}" if detail else ""))
        pass_count += 1
    else:
        print(f"  FAIL  {name}" + (f" - {detail}" if detail else ""))
        fail_count += 1


def send(proc, obj):
    proc.stdin.write((json.dumps(obj) + "\n").encode("utf-8"))
    proc.stdin.flush()


def recv(proc, timeout=10.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        line = proc.stdout.readline()
        if not line:
            time.sleep(0.05)
            continue
        try:
            obj = json.loads(line)
        except Exception:
            continue
        if any(k in obj for k in ("vault_request", "fs_request", "shell_request", "web_request", "research_request", "ask_request")):
            return {"_bridge_leak": obj}
        if "say" in obj:
            continue
        if set(obj.keys()) == {"done"}:
            continue
        return obj
    return {"_timeout": True}


def exec_code(proc, code):
    send(proc, {"op": "exec", "code": code, "timeout_ms": 5000})
    return recv(proc)


def result_ok(result):
    return (
        not result.get("_timeout")
        and not result.get("_bridge_leak")
        and not result.get("rejected")
        and not result.get("exception")
        and not result.get("timed_out")
    )


def done_value(result):
    done = result.get("done")
    if isinstance(done, dict):
        return done.get("value")
    return None


def main():
    FIXTURE_DIR.mkdir(parents=True, exist_ok=True)
    FIXTURE_PATH.write_text("alpha\nbeta\nem dash: —\n", encoding="utf-8")

    proc = subprocess.Popen(
        [sys.executable, "-u", str(BODY)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=str(ROOT),
    )
    try:
        send(proc, {"op": "ping"})
        ping = recv(proc, timeout=15.0)
        check("body ping", ping.get("pong") is True, repr(ping))
        send(proc, {"op": "configure", "project": str(ROOT), "state_dir": str(STATE_DIR)})
        configured = recv(proc, timeout=15.0)
        check("body configure state_dir", configured.get("ok") is True, repr(configured))

        print("\n[api inspector contract]")
        code = r'''
rows = api.list()
names = [row["name"] for row in rows]
described = {name: api.describe(name) for name in names}
costs = api.costs()
stub = api.stub()
bad = api.describe("__definitely_missing__")
done({
  "names": names,
  "rows": rows,
  "described": described,
  "costs": costs,
  "stub": stub,
  "bad": bad,
})
'''
        r = exec_code(proc, code)
        check("api inspector exec ok", result_ok(r), repr(r)[:500])
        value = done_value(r) or {}
        names = value.get("names") or []
        rows = value.get("rows") or []
        described = value.get("described") or {}
        costs = value.get("costs") or {}
        stub = value.get("stub") or ""
        bad = value.get("bad") or {}

        check("api.list returns rows", isinstance(rows, list) and len(rows) >= 8, f"{len(rows)} rows")
        check("api.list names unique", len(names) == len(set(names)), repr(names))
        check("api.describe covers every listed primitive",
              all(isinstance(described.get(name), dict) and not described[name].get("error") for name in names))
        check("every listed primitive has sig/returns/cost/effects",
              all(all(k in described[name] for k in ("sig", "returns", "cost", "effects")) for name in names))
        check("every return shape is nonempty",
              all(str(described[name].get("returns", "")).strip() for name in names))
        check("api.stub includes every listed primitive name",
              all((name.split(".", 1)[0] in stub and name.split(".")[-1] in stub) for name in names))
        grouped = sorted(n for group in (costs.get("groups") or {}).values() for n in group)
        check("api.costs groups exactly listed names", grouped == sorted(names), f"grouped={len(grouped)} names={len(names)}")
        check("api.describe unknown has suggestions shape",
              isinstance(bad.get("error"), str) and isinstance(bad.get("suggestions"), list), repr(bad))

        print("\n[local fs path/read contract]")
        code = r'''
p = ".aries/tmp/body-api-contract.txt"
content = fs.read(p)
matches = fs.glob("body-api-contract.txt", ".aries/tmp")
missing_error = ""
try:
    fs.read(".aries/tmp/does-not-exist.txt")
except Exception as e:
    missing_error = type(e).__name__ + ":" + str(e)
done({
  "content": content,
  "matches": matches,
  "missing_error": missing_error,
})
'''
        r = exec_code(proc, code)
        check("local fs exec ok", result_ok(r), repr(r)[:500])
        value = done_value(r) or {}
        check("fs.read preserves UTF-8", "em dash: —" in (value.get("content") or ""), repr(value.get("content")))
        check("fs.glob output can feed fs.read", any(str(p).endswith("body-api-contract.txt") for p in (value.get("matches") or [])), repr(value.get("matches")))
        check("missing fs.read raises typed-ish error", "Error" in (value.get("missing_error") or ""), repr(value.get("missing_error")))

        print("\n[done and shape telemetry contract]")
        r = exec_code(proc, 'x = 1\ny = x + 1\ndone({"ok": True, "y": y})')
        value = done_value(r) or {}
        shape = r.get("shape") or {}
        check("done structured value", value == {"ok": True, "y": 2}, repr(value))
        check("exec result carries shape", all(k in shape for k in ("stmt_count", "is_composed", "primitives_called")), repr(shape))

        print("\n[state contract]")
        code = r'''
state.delete("alpha")
put_result = state.put("alpha", [1, 2, {"x": True}], note="body test")
got = state.get("alpha")
listed = state.list("a")
has_before = state.has("alpha")
receipts_before = state.receipts("a")
deleted = state.delete("alpha")
has_after = state.has("alpha")
defaulted = state.get("alpha", "missing")
bad_key = ""
bad_value = ""
try:
    state.put("../bad", 1)
except Exception as e:
    bad_key = type(e).__name__
try:
    state.put("bad_value", {1, 2, 3})
except Exception as e:
    bad_value = type(e).__name__
state.put("survives_reset", {"ok": True})
done({
  "put_result": put_result,
  "got": got,
  "listed": listed,
  "has_before": has_before,
  "receipts_before": receipts_before,
  "deleted": deleted,
  "has_after": has_after,
  "defaulted": defaulted,
  "bad_key": bad_key,
  "bad_value": bad_value,
})
'''
        r = exec_code(proc, code)
        check("state exec ok", result_ok(r), repr(r)[:500])
        value = done_value(r) or {}
        check("state put/get roundtrip", value.get("got") == [1, 2, {"x": True}], repr(value.get("got")))
        check("state list/has/delete/default", value.get("listed") == ["alpha"] and value.get("has_before") is True and value.get("has_after") is False and value.get("defaulted") == "missing", repr(value))
        receipts = value.get("receipts_before") or []
        check("state receipts summarize", isinstance(receipts, list) and receipts and receipts[0].get("summary") == "list[3]", repr(receipts))
        check("state rejects invalid key and non-json value", value.get("bad_key") == "ValueError" and value.get("bad_value") == "TypeError", repr(value))

        send(proc, {"op": "reset"})
        reset = recv(proc, timeout=15.0)
        check("reset ok", reset.get("ok") is True, repr(reset))
        r = exec_code(proc, 'done({"survives": state.get("survives_reset")})')
        value = done_value(r) or {}
        check("state survives reset", value.get("survives") == {"ok": True}, repr(value))

    finally:
        try:
            proc.terminate()
        except Exception:
            pass

    print(f"\n{pass_count} passed, {fail_count} failed")
    return 1 if fail_count else 0


if __name__ == "__main__":
    raise SystemExit(main())
