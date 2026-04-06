"""
JSON-RPC server over stdin/stdout.

Reads one JSON message per line. Writes one JSON response per line.

Protocol:
  IN:  {"op": "exec", "code": "..."}
  OUT: {"stdout": "...", "stderr": "...", "exception": null, "duration_ms": 42, "rlm_stats": {...}}

  IN:  {"op": "ping"}
  OUT: {"pong": true}
"""
import sys
import json
import io
import time
import traceback
from pathlib import Path

# Add this dir to path
sys.path.insert(0, str(Path(__file__).parent))

from codebase import CodebaseGraph
import rlm

# Load the codebase graph at startup
GRAPH_PATH = Path(__file__).parent / "graph.json"
if not GRAPH_PATH.exists():
    print(json.dumps({
        "fatal": f"graph.json not found at {GRAPH_PATH}. Run indexer.py first."
    }), flush=True)
    sys.exit(1)

codebase = CodebaseGraph(GRAPH_PATH)

# Build the REPL namespace
REPL_NAMESPACE = {
    "codebase": codebase,
    "rlm_call": rlm.rlm_call,
    "rlm_batch": rlm.rlm_batch,
    # safe builtins
    "print": print,
    "len": len,
    "list": list,
    "dict": dict,
    "set": set,
    "tuple": tuple,
    "str": str,
    "int": int,
    "float": float,
    "bool": bool,
    "sorted": sorted,
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
    "__builtins__": {},
}


def exec_code(code: str) -> dict:
    """Execute code in the REPL namespace, capture stdout/stderr."""
    rlm.reset_stats()

    stdout_buf = io.StringIO()
    stderr_buf = io.StringIO()

    old_stdout = sys.stdout
    old_stderr = sys.stderr
    sys.stdout = stdout_buf
    sys.stderr = stderr_buf

    exception = None
    start = time.time()
    try:
        exec(code, REPL_NAMESPACE)
    except Exception:
        exception = traceback.format_exc()
    finally:
        sys.stdout = old_stdout
        sys.stderr = old_stderr

    duration_ms = int((time.time() - start) * 1000)

    return {
        "stdout": stdout_buf.getvalue(),
        "stderr": stderr_buf.getvalue(),
        "exception": exception,
        "duration_ms": duration_ms,
        "rlm_stats": rlm.get_stats(),
    }


def main():
    # Signal ready
    sys.stderr.write(f"[body] loaded graph: {codebase.file_count} files\n")
    sys.stderr.flush()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError as e:
            print(json.dumps({"error": f"bad json: {e}"}), flush=True)
            continue

        op = msg.get("op")
        if op == "ping":
            print(json.dumps({"pong": True}), flush=True)
        elif op == "exec":
            code = msg.get("code", "")
            result = exec_code(code)
            print(json.dumps(result), flush=True)
        elif op == "shutdown":
            break
        else:
            print(json.dumps({"error": f"unknown op: {op}"}), flush=True)


if __name__ == "__main__":
    main()
