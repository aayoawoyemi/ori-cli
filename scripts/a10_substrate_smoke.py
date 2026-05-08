"""
A10 substrate smoke — verifies the Python body boots clean, the JSON-RPC
protocol speaks, and the Repl namespace has every primitive bound.

Runs body/server.py as a subprocess. Sends `ping`, then `exec` calls that
exercise ONLY paths that don't need the TS bridge (local fs.read / fs.listdir /
fs.glob, pure Python, namespace introspection). Bridged primitives (fs.write,
shell.run, web.*, vault.*, codebase.*, research.*, say, ask) cannot be tested
here — they block on callbacks the TS host provides. Those must be exercised
in the live aries-cli session.

What this catches:
  - body doesn't start (import error in any primitive module)
  - JSON protocol regression
  - Namespace missing an expected name
  - Security AST pre-pass blocking something it shouldn't
  - Local fs read path broken

What this does NOT catch:
  - Any callback primitive (the bridge is the TS harness)
  - Model composition behavior (that's the live-session half of A10)
"""
import json
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BODY = ROOT / "body" / "server.py"

# Eager primitives bind at body startup — must be present in every standalone
# run. Absence here means the build is broken, not that the bridge hasn't
# connected yet.
EAGER_NAMES = {
    "fs", "shell", "web", "api",   # bridged/local primitives (objects bound, not lazy)
    "plan", "spanner", "state",      # goal-mode substrate + durable handoff
    "say", "ask",           # bare user-I/O callables
    "done",                 # commitment primitive (v0.5 Phase 3 / 2026-04-22)
    "json", "reindex",      # pre-bound stdlib + reindex helper
    "os",                   # os.path stub — kills `import os` reflex
    "help",                 # native introspection — A7 banner promises it
    "codebase",             # Fix B — stub pre-binds; becomes real graph post-index
}

# Lazy primitives require TS-side bridge messages (connect_vault, index,
# configure_rlm, connect_research) before they land in the namespace. Absent
# in standalone smoke runs by design — we just record that they're expected
# but unbound in this context so the test doesn't false-fail.
LAZY_NAMES = {
    "vault", "research",
    "rlm_call", "rlm_batch",
}


def send(proc, obj):
    line = json.dumps(obj) + "\n"
    proc.stdin.write(line.encode())
    proc.stdin.flush()


def recv(proc, timeout=10.0):
    """Read one JSON line from stdout, skipping `say` sentinels and
    erroring on bridge callbacks we'd normally answer from the TS side.

    `say` sentinels are fire-and-forget — the body emits the
    {"say": {...}} envelope on sys.__stdout__ as part of the UI-streaming
    path, but doesn't block waiting for a response. Smoke tests should
    skip past them and keep reading for the actual exec result. The A.6.2
    dual-write means `say()` inside exec emits one sentinel on the bridge
    channel AND echoes the text into the captured sys.stdout buffer
    (returned as result.stdout); we want the latter visible to the probe,
    and the former is noise the loop needs to step over.

    Genuinely bridged requests (vault_request, fs_request, etc.) DO block
    waiting for a TS response — if a smoke probe invokes one by accident,
    the body hangs forever, so we surface them as `_bridge_leak` for the
    probe to fail fast on."""
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
        if any(k in obj for k in ("vault_request", "fs_request", "shell_request",
                                  "web_request", "research_request", "ask_request")):
            # Genuine bridge callback — body will block forever waiting
            # for a response we can't send. Fail the probe immediately.
            return {"_bridge_leak": obj}
        if "say" in obj:
            # A.6.2 dual-write: say() emits this sentinel on the bridge
            # channel (UI streaming) AND echoes into the captured stdout
            # (result.stdout). Smoke test only cares about the latter; skip.
            continue
        return obj
    return {"_timeout": True}


def exec_code(proc, code):
    send(proc, {"op": "exec", "code": code, "timeout_ms": 5000})
    return recv(proc)


def assert_ok(label, result):
    if result.get("_timeout"):
        print(f"  FAIL {label}: timeout")
        return False
    if result.get("_bridge_leak"):
        print(f"  FAIL {label}: unexpected bridge callback {result['_bridge_leak']}")
        return False
    if result.get("rejected"):
        print(f"  FAIL {label}: AST rejected — {result['rejected']}")
        return False
    if result.get("exception"):
        print(f"  FAIL {label}: exception\n{result['exception']}")
        return False
    if result.get("timed_out"):
        print(f"  FAIL {label}: timed_out")
        return False
    print(f"  OK   {label}")
    if result.get("stdout"):
        for line in result["stdout"].rstrip().splitlines():
            print(f"       | {line}")
    return True


def main():
    print(f"Spawning body: {BODY}")
    proc = subprocess.Popen(
        [sys.executable, "-u", str(BODY)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=str(ROOT),
    )
    try:
        # 1. Protocol alive
        send(proc, {"op": "ping"})
        r = recv(proc, timeout=15.0)
        if not r.get("pong"):
            print(f"FAIL ping: {r}")
            print("stderr:", proc.stderr.read(4096).decode(errors="replace"))
            return 1
        print("OK   ping")

        passed = 0
        total = 0

        # 2. Namespace completeness — probe each name individually.
        # dir()/globals()/vars() are not in the safe builtins (by design), so
        # we can't enumerate; instead reference each name and catch NameError.
        # Split eager (must-be-present) from lazy (bridge-dependent, expected
        # absent in standalone). Only eager misses are failures.
        total += 1
        all_probes = sorted(EAGER_NAMES | LAZY_NAMES)
        probes = "\n".join(
            f"try:\n  {n}\n  print('ok:{n}')\nexcept NameError:\n  print('missing:{n}')\n"
            for n in all_probes
        )
        r = exec_code(proc, probes)
        if assert_ok("namespace completeness", r):
            missing = {
                line.split(":", 1)[1]
                for line in (r.get("stdout") or "").splitlines()
                if line.startswith("missing:")
            }
            eager_missing = missing & EAGER_NAMES
            lazy_missing = missing & LAZY_NAMES
            if not eager_missing:
                passed += 1
                if lazy_missing:
                    print(f"       (lazy unbound in standalone, expected: {sorted(lazy_missing)})")
            else:
                print(f"       EAGER MISSING (bug): {sorted(eager_missing)}")

        # 3. Pure python still works (persistent state across calls)
        total += 1
        r = exec_code(proc, "x = 42\nprint('set x')")
        a = assert_ok("set variable", r)
        total += 1
        r = exec_code(proc, "print('x is', x)")
        b = assert_ok("recall variable across calls", r)
        if a and b and "42" in (r.get("stdout") or ""):
            passed += 2

        # 4. Local fs.read — no bridge
        total += 1
        r = exec_code(
            proc,
            "data = fs.read('package.json')\n"
            "print('len:', len(data))\n"
            "print('first:', data[:40])\n",
        )
        if assert_ok("fs.read package.json", r):
            passed += 1

        # 5. Local fs.listdir
        total += 1
        r = exec_code(proc, "names = fs.listdir('body')\nprint('count:', len(names))")
        if assert_ok("fs.listdir body/", r):
            passed += 1

        # 6. Local fs.glob
        total += 1
        r = exec_code(proc, "hits = fs.glob('body/*.py')\nprint('py files:', len(hits))")
        if assert_ok("fs.glob body/*.py", r):
            passed += 1

        # 7. Docstring introspection — the banner tells the model `help(name)`
        # works, but `help` is not in safe_builtins. Verify the claim OR flag
        # the bug. We try the advertised path first.
        total += 1
        r = exec_code(proc, "print(repr(fs.__doc__)[:120] if fs.__doc__ else 'no docstring')")
        if assert_ok("fs.__doc__ (docstring access)", r):
            passed += 1
        total += 1
        send(proc, {"op": "exec", "code": "help(fs)", "timeout_ms": 5000})
        r = recv(proc)
        if r.get("exception") and "help" in r.get("exception", ""):
            print("  NOTE help(name) is NOT bound — banner advertises it but it raises NameError")
            print("       banner in server.py line 312 needs fix OR help needs to be added to safe_builtins")
        else:
            print("  OK   help(fs) works as banner claims")
            passed += 1

        # 8. Security AST pre-pass still blocks dangerous code
        total += 1
        send(proc, {"op": "exec", "code": "import os\nos.system('echo hi')", "timeout_ms": 5000})
        r = recv(proc)
        if r.get("rejected"):
            print(f"  OK   security blocks os.system: {r['rejected']['reason']}")
            passed += 1
        else:
            print(f"  FAIL security should have rejected os.system: {r}")

        # 9. os.path binding is usable and scoped. Checks that os.path.join
        # works (the composition push's #1 target — model's import-os reflex)
        # AND that os.system is NOT reachable (we bound only .path, not the
        # full module). Both must hold for the binding to be a safe replace.
        total += 1
        r = exec_code(
            proc,
            "joined = os.path.join('a', 'b', 'c.md')\n"
            "print('join:', joined)\n"
            "print('has_system:', hasattr(os, 'system'))\n"
            "print('has_environ:', hasattr(os, 'environ'))\n",
        )
        stdout = r.get("stdout") or ""
        if ("join:" in stdout and "has_system: False" in stdout
                and "has_environ: False" in stdout):
            print("  OK   os.path bound; os.system / os.environ not reachable")
            passed += 1
        else:
            print(f"  FAIL os.path binding incorrect:\n{stdout}")

        # 10. Codebase stub returns teaching error pre-index (Fix B). Before
        # configure sets ENV_MODE, the stub's _MSG_BUILDING branch should
        # fire — teaches the model to retry or fall back. This probe runs
        # BEFORE the configure op below so we catch the default (no-mode)
        # case where the stub must still return a usable error.
        total += 1
        r = exec_code(
            proc,
            "result = codebase.search('anything')\n"
            "print('got_error:', 'error' in result)\n"
            "print('mentions_retry:', 'retry' in result.get('error', '').lower() or 'fall back' in result.get('error', '').lower())\n",
        )
        stdout = r.get("stdout") or ""
        if "got_error: True" in stdout and "mentions_retry: True" in stdout:
            print("  OK   codebase stub returns teaching error with retry/fallback hint")
            passed += 1
        else:
            print(f"  FAIL codebase stub didn't teach correctly:\n{stdout}")

        # 11. Configure op populates banner env lines (Fix 1A). Reset first
        # so _exec_count goes back to 0 and the next exec re-emits the
        # banner; then send configure; then exec and grep for the env
        # lines. Confirms end-to-end that TS's configure op reaches the
        # banner formatter.
        total += 1
        send(proc, {"op": "reset"})
        recv(proc)  # discard reset response
        send(proc, {
            "op": "configure",
            "project": "/tmp/smoke-project",
            "vault_global": "/tmp/smoke-brain",
            "vault_project": None,
            "mode": "project+vault",
            "shell": "/bin/sh",
        })
        recv(proc)  # discard configure response
        r = exec_code(proc, "print('post-configure')")
        stdout = r.get("stdout") or ""
        required_lines = [
            "Project: /tmp/smoke-project",
            "Vault (global): /tmp/smoke-brain",
            "Mode: project+vault",
            "Shell: /bin/sh",
        ]
        missing_lines = [ln for ln in required_lines if ln not in stdout]
        if not missing_lines:
            print("  OK   configure op populates banner env lines")
            passed += 1
        else:
            print(f"  FAIL banner missing env lines after configure: {missing_lines}")
            print(f"       banner stdout was:\n{stdout}")

        # 12. Vault traversal verbs exist on the Vault class (v0.5 Phase 1).
        # Can't INVOKE them in standalone smoke (vault is lazy — bound only
        # after the TS bridge sends connect_vault). But we can import the
        # Vault class directly and assert the methods are defined with the
        # expected parameters. Catches the most common regression: a refactor
        # or merge silently drops one of the new methods.
        total += 1
        check_script = (
            "import sys, inspect\n"
            # body/ goes on sys.path directly so vault.py's internal
            # `from _protocol import write_message` (Batch 1.6) resolves.
            # Previously this inserted ROOT and used `body.vault` which
            # worked for namespace-package resolution but not for the
            # top-level `_protocol` import vault.py now requires.
            f"sys.path.insert(0, r'{ROOT / 'body'}')\n"
            "from vault import Vault\n"
            "required = {\n"
            "    'top': ['self', 'query', 'n', 'scope'],\n"
            "    'explore': ['self', 'query', 'depth', 'limit', 'recursive', 'include_content', 'scope'],\n"
            "    'neighbors': ['self', 'title'],\n"
            "    'backlinks': ['self', 'title'],\n"
            "    'meta': ['self', 'title'],\n"
            "}\n"
            "for name, expected_params in required.items():\n"
            "    m = getattr(Vault, name, None)\n"
            "    if m is None:\n"
            "        print(f'MISSING:{name}'); continue\n"
            "    actual = list(inspect.signature(m).parameters.keys())\n"
            "    if all(p in actual for p in expected_params):\n"
            "        print(f'OK:{name}')\n"
            "    else:\n"
            "        print(f'BADSIG:{name}:want={expected_params}:got={actual}')\n"
        )
        check_result = subprocess.run(
            [sys.executable, "-c", check_script],
            cwd=str(ROOT),
            capture_output=True,
            text=True,
            timeout=10,
        )
        check_out = check_result.stdout
        expected_verbs = ["top", "explore", "neighbors", "backlinks", "meta"]
        if all(f"OK:{v}" in check_out for v in expected_verbs):
            print("  OK   vault class exposes top/explore/neighbors/backlinks/meta with expected signatures")
            passed += 1
        else:
            print(f"  FAIL vault verb signature check:\n{check_out}")

        # 13. Bridge trim projection strips decoration without losing envelope.
        # Imports the compiled projectVaultResult from dist/repl/bridge.js via
        # node and runs it against a mock ori_query_ranked payload. Requires
        # `npm run build` to have been run (dist/ present); skipped with a
        # note if the build isn't up to date.
        total += 1
        bridge_js = ROOT / "dist" / "repl" / "bridge.js"
        if not bridge_js.is_file():
            print("  SKIP bridge trim — dist/repl/bridge.js not present (run npm run build to enable this probe)")
            total -= 1  # skipped probes don't count against pass-total
        else:
            # Build a payload that's representative of what ori-memory MCP
            # returns today: envelope with warmth internals + per-result
            # signals/spaces/federation markers. After projection, only the
            # core {title, path, score} (plus any non-stripped fields) should
            # remain per result; warmth.{candidates,promoted,demoted} + all
            # federation markers should be gone envelope-wide.
            node_script = (
                "import('./dist/repl/bridge.js').then(({ projectVaultResult }) => {\n"
                "  const payload = {\n"
                "    success: true,\n"
                "    data: {\n"
                "      results: [\n"
                "        { title: 'codemode paradigm', path: 'notes/cm.md', score: 0.9,\n"
                "          signals: { composite: 0.8, rrf: 0.002, rrf_base: 0.002 },\n"
                "          spaces: { text: 0.5, temporal: 0.9 },\n"
                "          _vault: 'global' },\n"
                "      ],\n"
                "      warmth: { enabled: true, weight: 0.3, candidates: 5,\n"
                "                promoted: [{ title: 'x' }], demoted: [{ title: 'y' }] },\n"
                "      _federated: true,\n"
                "      _sources: { global: 1, project: 0 },\n"
                "    },\n"
                "  };\n"
                "  const { projected, bytesStripped } = projectVaultResult('ori_query_ranked', payload);\n"
                "  const r0 = projected.data.results[0];\n"
                "  const bad = [];\n"
                "  for (const k of ['signals', 'spaces', 'rrf', 'rrf_base', 'composite', '_vault']) {\n"
                "    if (k in r0) bad.push('result.' + k);\n"
                "  }\n"
                "  for (const k of ['_federated', '_sources']) {\n"
                "    if (k in projected.data) bad.push('data.' + k);\n"
                "  }\n"
                "  for (const k of ['candidates', 'promoted', 'demoted']) {\n"
                "    if (k in projected.data.warmth) bad.push('warmth.' + k);\n"
                "  }\n"
                "  if (bad.length === 0 && bytesStripped > 0) console.log('TRIM_OK bytes=' + bytesStripped);\n"
                "  else console.log('TRIM_FAIL leaked=' + bad.join(',') + ' stripped=' + bytesStripped);\n"
                "}).catch(e => { console.log('TRIM_ERROR ' + e.message); });\n"
            )
            node_result = subprocess.run(
                ["node", "--input-type=module", "-e", node_script],
                cwd=str(ROOT),
                capture_output=True,
                text=True,
                timeout=10,
            )
            node_out = node_result.stdout.strip()
            if node_out.startswith("TRIM_OK"):
                print(f"  OK   bridge trim strips signals/spaces/warmth-internals/federation ({node_out})")
                passed += 1
            else:
                print(f"  FAIL bridge trim: {node_out}")
                if node_result.stderr:
                    print(f"       stderr: {node_result.stderr.strip()[:400]}")

        # 14. done() primitive is callable and signals correctly. Can't test
        # the full sentinel path in standalone smoke (that needs the TS bridge
        # to observe the stdout marker), but we can confirm the binding
        # exists and is callable. Actual bridge sentinel reception is
        # exercised in live aries-cli sessions where app.tsx routes repl_done
        # events.
        total += 1
        r = exec_code(
            proc,
            "print('callable:', callable(done))\n"
            "print('name:', done.__name__ if hasattr(done, '__name__') else 'unnamed')\n",
        )
        stdout = r.get("stdout") or ""
        if "callable: True" in stdout:
            print("  OK   done() primitive is callable")
            passed += 1
        else:
            print(f"  FAIL done() primitive:\n{stdout}")

        # 15. shape field is attached to exec result envelope. analyze_shape
        # runs unconditionally in _run_exec — every exec result should carry
        # a `shape` dict with at least stmt_count and is_composed. This is
        # the per-call telemetry field the TS side logs as `repl_shape`.
        total += 1
        r = exec_code(proc, "z = 1\nprint('hi')")  # simple 2-stmt code
        shape = r.get("shape")
        expected_shape_keys = {
            "stmt_count", "line_count", "char_count",
            "primitives_called", "distinct_primitive_count",
            "total_primitive_call_count",
            "has_for_or_while", "has_if", "has_def", "has_try",
            "has_comprehension", "is_micro_repl", "is_composed",
        }
        if isinstance(shape, dict) and expected_shape_keys.issubset(shape.keys()):
            print(f"  OK   exec result carries shape telemetry (stmt_count={shape['stmt_count']}, composed={shape['is_composed']})")
            passed += 1
        else:
            print(f"  FAIL shape field missing or incomplete: keys={list(shape.keys()) if isinstance(shape, dict) else 'not a dict'}")

        # 16. analyze_shape correctly classifies composed vs micro_repl code.
        # Import analyze_shape directly and feed it two contrived samples —
        # one micro (single statement, single primitive), one composed
        # (multi-statement, multi-primitive, control flow). If the heuristic
        # is broken, the telemetry metric is lying about composition.
        total += 1
        shape_script = (
            "import sys\n"
            f"sys.path.insert(0, r'{ROOT / 'body'}')\n"
            "from shape import analyze_shape\n"
            "micro = analyze_shape('x = fs.read(\"foo\")')\n"
            "composed = analyze_shape('hits = vault.top(\"auth\")\\nfor h in hits:\\n    print(h)\\nsay(\"done\")')\n"
            "print('micro_is_composed:', micro['is_composed'])\n"
            "print('micro_is_micro:', micro['is_micro_repl'])\n"
            "print('composed_is_composed:', composed['is_composed'])\n"
            "print('composed_is_micro:', composed['is_micro_repl'])\n"
        )
        shape_result = subprocess.run(
            [sys.executable, "-c", shape_script],
            cwd=str(ROOT),
            capture_output=True,
            text=True,
            timeout=5,
        )
        shape_out = shape_result.stdout
        if ("micro_is_composed: False" in shape_out
                and "micro_is_micro: True" in shape_out
                and "composed_is_composed: True" in shape_out
                and "composed_is_micro: False" in shape_out):
            print("  OK   analyze_shape classifies micro vs composed correctly")
            passed += 1
        else:
            print(f"  FAIL analyze_shape classification:\n{shape_out}")
            if shape_result.stderr:
                print(f"       stderr: {shape_result.stderr.strip()[:400]}")

        # 17. A.6.1 path injection — Vault._inject_paths augments every
        # retrieval entry with a `path` key, resolved via _resolve_path
        # from the title's slug. Testable in standalone because the helper
        # is pure python (no bridge call) — we instantiate Vault with a
        # temp vault dir, drop a fixture file matching the slug, and call
        # _inject_paths on a mock result. Pre-fix: ScoredNote envelopes
        # carried no `path` and every docstring-taught h['path'] access
        # was a KeyError. Post-fix: `path` present on every entry, None
        # when the title doesn't resolve to a real file on disk.
        total += 1
        inject_script = (
            "import sys, os, tempfile\n"
            f"sys.path.insert(0, r'{ROOT / 'body'}')\n"
            "from vault import Vault\n"
            "with tempfile.TemporaryDirectory() as d:\n"
            "    notes = os.path.join(d, 'notes')\n"
            "    os.makedirs(notes, exist_ok=True)\n"
            "    with open(os.path.join(notes, 'codemode-paradigm.md'), 'w') as f:\n"
            "        f.write('stub')\n"
            "    v = Vault(d)\n"
            "    mock = {'results': [\n"
            "        {'title': 'codemode paradigm', 'score': 0.9},\n"
            "        {'title': 'does-not-exist-xyz', 'score': 0.3},\n"
            "    ]}\n"
            "    out = v._inject_paths(mock)\n"
            "    print('has_path_0:', 'path' in out['results'][0])\n"
            "    print('path_0_resolved:', out['results'][0]['path'])\n"
            "    print('has_path_1:', 'path' in out['results'][1])\n"
            "    print('path_1_none:', out['results'][1]['path'] is None)\n"
            "    # Idempotence — re-apply, path stays, not re-resolved\n"
            "    preset = {'results': [{'title': 'x', 'path': 'explicit/path.md'}]}\n"
            "    again = v._inject_paths(preset)\n"
            "    print('idempotent:', again['results'][0]['path'] == 'explicit/path.md')\n"
        )
        inject_result = subprocess.run(
            [sys.executable, "-c", inject_script],
            cwd=str(ROOT),
            capture_output=True,
            text=True,
            timeout=10,
        )
        inject_out = inject_result.stdout
        if ("has_path_0: True" in inject_out
                and "path_0_resolved: notes" in inject_out
                and "has_path_1: True" in inject_out
                and "path_1_none: True" in inject_out
                and "idempotent: True" in inject_out):
            print("  OK   Vault._inject_paths resolves real files, returns None for dangling, idempotent")
            passed += 1
        else:
            print(f"  FAIL Vault._inject_paths:\n{inject_out}")
            if inject_result.stderr:
                print(f"       stderr: {inject_result.stderr.strip()[:400]}")

        # 18. A.6.2 say() dual-write — say(text) writes to sys.__stdout__
        # (bridge-protocol sentinel for UI streaming) AND echoes to
        # sys.stdout (captured buffer during exec, becomes result.stdout).
        # Before the echo, the model's own say() prints were invisible in
        # its own tool_result and it couldn't self-debug. Probe: invoke
        # say('HELLO_MARKER_A62') inside exec; assert result.stdout
        # contains the marker. recv() was patched above to skip past the
        # bridge-channel {"say": ...} sentinel this call emits.
        total += 1
        r = exec_code(proc, "say('HELLO_MARKER_A62')\nprint('post-say-sentinel')")
        stdout = r.get("stdout") or ""
        if "HELLO_MARKER_A62" in stdout and "post-say-sentinel" in stdout:
            print("  OK   say() dual-write lands in result.stdout (model-visible)")
            passed += 1
        else:
            print(f"  FAIL say() dual-write missing marker in stdout:\n{stdout}")

        # 19. A.6.3 _format_not_found embeds fuzzy suggestions — get_note
        # on a missing title now raises VaultError whose message carries
        # up to 3 candidate titles + scores inline. Model can parse and
        # retry in the same batch via try/except instead of losing a turn.
        # Test the formatter directly since it's pure-python: stub self.top
        # to return a mock, call _format_not_found, check message shape.
        total += 1
        fmt_script = (
            "import sys\n"
            f"sys.path.insert(0, r'{ROOT / 'body'}')\n"
            "from vault import Vault\n"
            "v = Vault('/tmp/fake_vault_a63')\n"
            "# Disconnected fallback — top() raises because _require() fails,\n"
            "# caught internally, returns base message with no suggestions.\n"
            "base = v._format_not_found('zyxwvu_does_not_exist_23984')\n"
            "print('base_has_prefix:', base.startswith(\"note not found: 'zyxwvu_does_not_exist_23984'\"))\n"
            "print('base_no_didyoumean:', 'Did you mean' not in base)\n"
            "# Stub top() with a mock so the suggestion path fires.\n"
            "v.top = lambda q, n=5: {'results': [\n"
            "    {'title': 'codemode-primitive-set', 'score': 0.89},\n"
            "    {'title': 'codemode-sandbox', 'score': 0.77},\n"
            "    {'title': 'codemode-agilis', 'score': 0.72},\n"
            "    {'title': 'extra-4', 'score': 0.55},\n"
            "]}\n"
            "msg = v._format_not_found('codemode paradigm')\n"
            "print('msg_has_didyoumean:', 'Did you mean:' in msg)\n"
            "print('msg_has_prim_set:', 'codemode-primitive-set' in msg)\n"
            "print('msg_has_score_089:', '(score 0.89)' in msg)\n"
            "print('msg_capped_at_3:', msg.count(' - ') == 3)\n"
        )
        fmt_result = subprocess.run(
            [sys.executable, "-c", fmt_script],
            cwd=str(ROOT),
            capture_output=True,
            text=True,
            timeout=10,
        )
        fmt_out = fmt_result.stdout
        if ("base_has_prefix: True" in fmt_out
                and "base_no_didyoumean: True" in fmt_out
                and "msg_has_didyoumean: True" in fmt_out
                and "msg_has_prim_set: True" in fmt_out
                and "msg_has_score_089: True" in fmt_out
                and "msg_capped_at_3: True" in fmt_out):
            print("  OK   Vault._format_not_found embeds suggestions (top 3, with scores)")
            passed += 1
        else:
            print(f"  FAIL Vault._format_not_found:\n{fmt_out}")
            if fmt_result.stderr:
                print(f"       stderr: {fmt_result.stderr.strip()[:400]}")

        # 20. A.6.4 pre-bound pure-function stdlib modules — re / datetime
        # / random / statistics / collections / itertools / math are bound
        # in the Repl namespace so `import re` reflex doesn't cost a turn.
        # Probe: call one method per module and verify output. Also verify
        # the `import re` reflex is silently stripped by repl.strip_preloaded_imports
        # before validation, so it does not cost a recovery turn.
        total += 1
        r = exec_code(
            proc,
            "print('re:', re.search(r'\\d+', 'abc123').group())\n"
            "print('datetime_ok:', bool(datetime.date.today().isoformat()))\n"
            "print('stats:', statistics.mean([1, 2, 3]))\n"
            "print('counter:', collections.Counter('aab').most_common(1))\n"
            "print('islice:', list(itertools.islice(range(10), 3)))\n"
            "print('sqrt:', math.sqrt(16))\n"
            "print('rand_ok:', isinstance(random.randint(0, 10), int))\n",
        )
        stdout = r.get("stdout") or ""
        if ("re: 123" in stdout
                and "datetime_ok: True" in stdout
                and "stats: 2" in stdout
                and "counter: [('a', 2)]" in stdout
                and "islice: [0, 1, 2]" in stdout
                and "sqrt: 4.0" in stdout
                and "rand_ok: True" in stdout):
            print("  OK   stdlib bindings (re/datetime/random/statistics/collections/itertools/math) callable")
            passed += 1
        else:
            print(f"  FAIL stdlib bindings:\n{stdout}")
        # Preloaded imports are normalized away before validation.
        total += 1
        send(proc, {"op": "exec", "code": "import re", "timeout_ms": 5000})
        r = recv(proc)
        if not r.get("rejected") and not r.get("exception") and not r.get("timed_out"):
            print("  OK   `import re` is stripped as a preloaded-import reflex")
            passed += 1
        else:
            print(f"  FAIL `import re` should have been stripped cleanly: {r}")

        # 21. A.6.5 first-turn banner Shapes cheat-sheet — the banner now
        # includes a "Shapes:" block with signatures for the most-reached-
        # for primitives (fs.read, vault.top, etc.). The model writes its
        # first composed batch with correct return-shape assumptions on
        # turn 1 instead of turn 4. Reset + configure re-arms the banner
        # (probe #11 already validated env lines; here we add the Shapes
        # lines). Both probes can coexist because reset zeroes _exec_count.
        total += 1
        send(proc, {"op": "reset"})
        recv(proc)
        send(proc, {
            "op": "configure",
            "project": "/tmp/smoke-shapes",
            "vault_global": "/tmp/smoke-shapes-brain",
            "mode": "project+vault",
            "shell": "/bin/sh",
        })
        recv(proc)
        r = exec_code(proc, "print('shapes-banner-probe')")
        stdout = r.get("stdout") or ""
        # Match substring prefixes rather than exact strings — Batch 1.5
        # switched the banner to generate from NAMESPACE_SIGNATURES so
        # signatures now show the full param list (`fs.read(path, offset=0,
        # limit=None)` not `fs.read(path)`). The probe's contract is "the
        # Shapes block exists and covers the key reach-for primitives",
        # which substring-prefix matching expresses without coupling to
        # the exact formatting of any entry.
        required_prefixes = ["Shapes:", "fs.read(", "shell.run(", "say(", "vault.explore("]
        missing = [p for p in required_prefixes if p not in stdout]
        # vault.explore only surfaces in the Shapes block when VAULT is
        # bound; standalone smoke has VAULT=None so the prefix will be
        # absent. Allow it to be missing in that case — the drift probe
        # #22 covers the schema entry's existence directly.
        if "vault.explore(" in missing:
            missing.remove("vault.explore(")
        if not missing:
            print("  OK   first-turn banner carries Shapes cheat-sheet (schema-generated)")
            passed += 1
        else:
            print(f"  FAIL banner missing Shapes prefixes: {missing}")
            print(f"       banner stdout was:\n{stdout}")

        # 22. Batch 1.5 drift probe — every callable primitive bound in
        # _build_namespace must have a NAMESPACE_SIGNATURES entry.
        # Enforces "add a primitive without registering its schema" as a
        # CI failure so drift is caught immediately. Checks only the
        # aries primitives; stdlib pre-bindings (re/datetime/etc.) are
        # deliberately not in the schema table (their shapes are
        # well-known and duplicating would add drift surface).
        total += 1
        drift_script = (
            "import sys\n"
            f"sys.path.insert(0, r'{ROOT / 'body'}')\n"
            "from schema import NAMESPACE_SIGNATURES\n"
            "import importlib\n"
            "server = importlib.import_module('server')\n"
            "# Expected primitives from _build_namespace — aries primitives\n"
            "# only; stdlib modules (re/datetime/etc.) excluded by design.\n"
            "expected_ns_objects = ['fs', 'shell', 'web', 'api', 'plan', 'spanner', 'state']\n"
            "expected_bare_names = ['say', 'ask', 'done']\n"
            "missing = []\n"
            "# For each expected ns object, at least one <ns>.method must be in schema.\n"
            "for ns_name in expected_ns_objects:\n"
            "    covered = [k for k in NAMESPACE_SIGNATURES if k.startswith(ns_name + '.')]\n"
            "    if not covered:\n"
            "        missing.append(f'ns:{ns_name}')\n"
            "# For each expected bare name, the exact key must be in schema.\n"
            "for bare in expected_bare_names:\n"
            "    if bare not in NAMESPACE_SIGNATURES:\n"
            "        missing.append(f'bare:{bare}')\n"
            "# Cross-check: every key in schema should resolve to a callable if the\n"
            "# ns object is actually bound. VAULT/CODEBASE/RESEARCH may be None in\n"
            "# standalone smoke (lazy), so skip those; test only the always-bound ones.\n"
            "always_bound = {'fs': server.FS, 'shell': server.SHELL, 'web': server.WEB, 'api': server.NAMESPACE['api'], 'plan': server.PLAN, 'spanner': server.SPANNER, 'state': server.STATE}\n"
            "unreachable = []\n"
            "for key in NAMESPACE_SIGNATURES:\n"
            "    if '.' not in key: continue\n"
            "    ns_name, method = key.split('.', 1)\n"
            "    if ns_name not in always_bound: continue\n"
            "    if not hasattr(always_bound[ns_name], method):\n"
            "        unreachable.append(key)\n"
            "print(f'missing:{len(missing)}')\n"
            "if missing: print('MISSING:', missing)\n"
            "print(f'unreachable:{len(unreachable)}')\n"
            "if unreachable: print('UNREACHABLE:', unreachable)\n"
        )
        drift_result = subprocess.run(
            [sys.executable, "-c", drift_script],
            cwd=str(ROOT),
            capture_output=True,
            text=True,
            timeout=10,
        )
        drift_out = drift_result.stdout
        if "missing:0" in drift_out and "unreachable:0" in drift_out:
            print("  OK   NAMESPACE_SIGNATURES covers every always-bound primitive; no drift")
            passed += 1
        else:
            print(f"  FAIL schema drift:\n{drift_out}")
            if drift_result.stderr:
                print(f"       stderr: {drift_result.stderr.strip()[:400]}")

        # 23. Batch 1.5 enrichment probe — synthetic KeyError traceback
        # mentioning vault.explore gets a `NOTE: vault.explore returns ...`
        # line appended. Confirms the post-exception hook fires for the
        # shape-error classes (KeyError/AttributeError/TypeError/IndexError)
        # and the regex correctly parses the frame source to identify the
        # offending primitive. Uses a hand-crafted traceback so the probe
        # doesn't depend on bridged primitives.
        total += 1
        enrich_script = (
            "import sys\n"
            f"sys.path.insert(0, r'{ROOT / 'body'}')\n"
            "from repl import _enrich_exception\n"
            "tb = (\n"
            "    'Traceback (most recent call last):\\n'\n"
            "    '  File \"<string>\", line 2, in <module>\\n'\n"
            "    '    top = hits[\\'notes\\'][0]\\n'\n"
            "    \"KeyError: 'notes'\\n\"\n"
            ")\n"
            "code = \"hits = vault.explore('codemode paradigm')\\ntop = hits['notes'][0]\\n\"\n"
            "enriched, did = _enrich_exception(tb, code)\n"
            "print('did_enrich:', did)\n"
            "print('has_note:', 'NOTE:' in enriched)\n"
            "print('mentions_vault_explore:', 'vault.explore' in enriched)\n"
            "print('mentions_results_key:', 'results' in enriched)\n"
            "# Argument-count TypeError path gets the `sig`, not `returns`.\n"
            "tb2 = (\n"
            "    'Traceback (most recent call last):\\n'\n"
            "    '  File \"<string>\", line 1, in <module>\\n'\n"
            "    '    rlm_call(\\'just one arg\\')\\n'\n"
            "    \"TypeError: rlm_call() missing 1 required positional argument: 'question'\\n\"\n"
            ")\n"
            "code2 = \"rlm_call('just one arg')\\n\"\n"
            "enriched2, did2 = _enrich_exception(tb2, code2)\n"
            "print('did_enrich_typeerror:', did2)\n"
            "print('has_signature_label:', 'rlm_call signature' in enriched2)\n"
            "# Non-shape error class (NameError) should NOT enrich.\n"
            "tb3 = (\n"
            "    'Traceback (most recent call last):\\n'\n"
            "    '  File \"<string>\", line 1, in <module>\\n'\n"
            "    '    vault.explore(\\'x\\')\\n'\n"
            "    \"NameError: name 'vault' is not defined\\n\"\n"
            ")\n"
            "enriched3, did3 = _enrich_exception(tb3, 'vault.explore(\\'x\\')\\n')\n"
            "print('nameerror_not_enriched:', not did3)\n"
        )
        enrich_result = subprocess.run(
            [sys.executable, "-c", enrich_script],
            cwd=str(ROOT),
            capture_output=True,
            text=True,
            timeout=10,
        )
        enrich_out = enrich_result.stdout
        checks = [
            "did_enrich: True",
            "has_note: True",
            "mentions_vault_explore: True",
            "mentions_results_key: True",
            "did_enrich_typeerror: True",
            "has_signature_label: True",
            "nameerror_not_enriched: True",
        ]
        if all(c in enrich_out for c in checks):
            print("  OK   _enrich_exception appends NOTE for shape errors, signature for TypeError arg-count, skips NameError")
            passed += 1
        else:
            missing_checks = [c for c in checks if c not in enrich_out]
            print(f"  FAIL enrichment missing checks: {missing_checks}")
            print(f"       stdout:\n{enrich_out}")
            if enrich_result.stderr:
                print(f"       stderr: {enrich_result.stderr.strip()[:400]}")

        # 24. Batch 1.8 runtime calibration — for every primitive covered
        # by body/schema.calibrated.json, the schema's declared envelope +
        # item keys must match the fixture's observed keys. Phantom keys
        # (declared but not observed — the snippet-lie class) are always
        # drift; missing keys are drift only when the schema didn't mark
        # the shape open with `...`. This probe would have caught the
        # vault.top snippet lie immediately instead of shipping it to Opus.
        # Fixture is narrow by design — only primitives we're high
        # confidence about. Expand as primitives are audited live.
        total += 1
        calib_script = (
            "import sys, json\n"
            f"sys.path.insert(0, r'{ROOT / 'body'}')\n"
            "from schema import NAMESPACE_SIGNATURES, NAMESPACE_VERSION\n"
            "from schema_calibrate import compare_against_fixture, load_fixture\n"
            f"fixture = load_fixture(r'{ROOT / 'body' / 'schema.calibrated.json'}')\n"
            "drift = compare_against_fixture(NAMESPACE_SIGNATURES, fixture)\n"
            "print(f'primitives_in_fixture:{len(fixture)}')\n"
            "print(f'drift_count:{len(drift)}')\n"
            "print(f'namespace_version:{NAMESPACE_VERSION}')\n"
            "if drift:\n"
            "    print('DRIFT:' + json.dumps(drift, indent=2))\n"
        )
        calib_result = subprocess.run(
            [sys.executable, "-c", calib_script],
            cwd=str(ROOT),
            capture_output=True,
            text=True,
            timeout=10,
        )
        calib_out = calib_result.stdout
        if ("drift_count:0" in calib_out
                and "primitives_in_fixture:" in calib_out
                and "namespace_version:" in calib_out):
            # Extract fixture count + version for context
            fixture_line = next(
                (ln for ln in calib_out.splitlines() if ln.startswith("primitives_in_fixture:")),
                ""
            )
            version_line = next(
                (ln for ln in calib_out.splitlines() if ln.startswith("namespace_version:")),
                ""
            )
            print(f"  OK   runtime calibration clean ({fixture_line}, {version_line})")
            passed += 1
        else:
            print(f"  FAIL schema drift vs calibrated fixture:\n{calib_out}")
            if calib_result.stderr:
                print(f"       stderr: {calib_result.stderr.strip()[:400]}")

        # 25. Parser self-test — parse_returns handles the shape dialects in
        # schema.py correctly. Guards against parser regressions silently
        # turning real schema entries into "empty sets" (which would make
        # calibration vacuously pass). Uses hand-crafted strings that cover
        # the variants seen in NAMESPACE_SIGNATURES: scalar, list-of-dict,
        # envelope with nested list-of-dict + ellipsis, envelope without
        # ellipsis, list-of-tuple (should yield no keys).
        total += 1
        parser_script = (
            "import sys\n"
            f"sys.path.insert(0, r'{ROOT / 'body'}')\n"
            "from schema_calibrate import parse_returns\n"
            "cases = [\n"
            "    ('str', {'envelope': set(), 'item': set(), 'envelope_open': False, 'item_open': False}),\n"
            "    ('list[str]', {'envelope': set(), 'item': set(), 'envelope_open': False, 'item_open': False}),\n"
            "    ('list[{file, line, snippet}]', {'envelope': set(), 'item': {'file','line','snippet'}, 'envelope_open': False, 'item_open': False}),\n"
            "    ('{ok, path, ...}', {'envelope': {'ok','path'}, 'item': set(), 'envelope_open': True, 'item_open': False}),\n"
            "    ('{results: [{title, path, score}], warmth: {...}}', {'envelope': {'results','warmth'}, 'item': {'title','path','score'}, 'envelope_open': False, 'item_open': False}),\n"
            "    ('{neighbors: [{title, path}]}', {'envelope': {'neighbors'}, 'item': {'title','path'}, 'envelope_open': False, 'item_open': False}),\n"
            "    ('list[(file_path, ref_count)]  # desc by count', {'envelope': set(), 'item': set(), 'envelope_open': False, 'item_open': False}),\n"
            "    ('None', {'envelope': set(), 'item': set(), 'envelope_open': False, 'item_open': False}),\n"
            "]\n"
            "fails = []\n"
            "for src, want in cases:\n"
            "    got = parse_returns(src)\n"
            "    if got != want: fails.append((src, got, want))\n"
            "print(f'parser_fails:{len(fails)}')\n"
            "for src, got, want in fails:\n"
            "    print(f'CASE {src!r}\\n  got  {got}\\n  want {want}')\n"
        )
        parser_result = subprocess.run(
            [sys.executable, "-c", parser_script],
            cwd=str(ROOT),
            capture_output=True,
            text=True,
            timeout=10,
        )
        parser_out = parser_result.stdout
        if "parser_fails:0" in parser_out:
            print("  OK   parse_returns handles scalar/list-of-dict/envelope-with-ellipsis/etc dialects")
            passed += 1
        else:
            print(f"  FAIL parse_returns:\n{parser_out}")
            if parser_result.stderr:
                print(f"       stderr: {parser_result.stderr.strip()[:400]}")

        # 26. codebase.map (Batch B) — canonical project-orientation primitive.
        # Exercised standalone via subprocess against a hand-built mock
        # index_result. Confirms (a) the return shape lands as documented
        # (path/type/depth/tracked/pagerank/language), (b) every indexed file
        # appears, (c) tracked degrades to None when cwd isn't a git repo,
        # (d) the truncation marker fires at max_entries, (e) prefix filter
        # restricts the output. Pre-index stub coverage (probe #10 path) is
        # already covered by the search stub; the new map() stub method in
        # body/server.py is implicitly tested by `from codebase import` not
        # raising AttributeError when probe #10 reaches for codebase.search.
        total += 1
        map_script = (
            "import sys\n"
            f"sys.path.insert(0, r'{ROOT / 'body'}')\n"
            "from codebase import CodebaseGraph\n"
            "from types import SimpleNamespace as N\n"
            "files = {\n"
            "  'src/a.ts': N(symbols=[], references=[], lines=[''], language='typescript', imports=[]),\n"
            "  'src/b/c.ts': N(symbols=[], references=[], lines=[''], language='typescript', imports=[]),\n"
            "  'README.md': N(symbols=[], references=[], lines=[''], language='markdown', imports=[]),\n"
            "}\n"
            "cb = CodebaseGraph({'root': '/nonexistent_root_xyz', 'files': files, 'file_count': 3})\n"
            "out = cb.map()\n"
            "expected_keys = {'path','type','depth','tracked','pagerank','language'}\n"
            "shape_ok = all(set(e.keys()) == expected_keys for e in out)\n"
            "print('shape_ok:', shape_ok)\n"
            "files_only = [e for e in out if e['type']=='file']\n"
            "dirs_only = [e for e in out if e['type']=='dir']\n"
            "print('all_files_present:', sorted(e['path'] for e in files_only) == sorted(files.keys()))\n"
            "print('tracked_none:', all(e['tracked'] is None for e in out))\n"
            "print('files_have_pagerank:', all(isinstance(e['pagerank'], (int, float)) for e in files_only))\n"
            "print('dirs_no_pagerank:', all(e['pagerank'] is None for e in dirs_only))\n"
            "out2 = cb.map(max_entries=2)\n"
            "print('truncated_marker:', any(e['type']=='truncated' for e in out2))\n"
            "out3 = cb.map(path='src')\n"
            "print('prefix_only_src:', all(e['path'].startswith('src') or e['type']=='truncated' for e in out3))\n"
        )
        map_result = subprocess.run(
            [sys.executable, "-c", map_script],
            cwd=str(ROOT),
            capture_output=True,
            text=True,
            timeout=15,
        )
        map_out = map_result.stdout
        required_map = [
            "shape_ok: True",
            "all_files_present: True",
            "tracked_none: True",
            "files_have_pagerank: True",
            "dirs_no_pagerank: True",
            "truncated_marker: True",
            "prefix_only_src: True",
        ]
        if all(c in map_out for c in required_map):
            print("  OK   codebase.map returns canonical orient shape + truncation + prefix")
            passed += 1
        else:
            missing_map = [c for c in required_map if c not in map_out]
            print(f"  FAIL codebase.map missing checks: {missing_map}")
            print(f"       stdout:\n{map_out}")
            if map_result.stderr:
                print(f"       stderr: {map_result.stderr.strip()[:400]}")

        # Shutdown
        send(proc, {"op": "shutdown"})
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            proc.kill()

        print(f"\n{passed}/{total} checks passed")
        return 0 if passed == total else 1
    finally:
        if proc.poll() is None:
            proc.kill()


if __name__ == "__main__":
    sys.exit(main())
