"""Unit tests for body/security.py. Hand-runnable: python body/test_security.py"""
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from security import check_ast, SecurityError, strip_preloaded_imports


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


def rejects(code, expected="import statements are forbidden"):
    try:
        check_ast(code)
    except SecurityError as e:
        return expected in str(e)
    return False


print("\n[strip - preloaded singles]")
for mod in ["json", "re", "datetime", "random", "statistics", "collections", "itertools", "math"]:
    out = strip_preloaded_imports(f"import {mod}")
    check(f"strip import {mod}", out.strip() == "", repr(out))


print("\n[strip - preloaded multi]")
out = strip_preloaded_imports("import json, re")
check("strip comma imports", "import" not in out, repr(out))
out = strip_preloaded_imports("import re; import math")
check("strip semicolon imports", "import" not in out, repr(out))
out = strip_preloaded_imports("import json\nimport re\nx = 1")
check("strip multi-line imports", "import" not in out and "x = 1" in out, repr(out))


print("\n[strip - preserved]")
preserved_cases = [
    ("alias", "import json as j", "import json as j"),
    ("mixed unsafe", "import json, sys", "import json, sys"),
    ("from collections", "from collections import Counter", "from collections import Counter"),
    ("from datetime", "from datetime import datetime", "from datetime import datetime"),
    ("os", "import os", "import os"),
    ("subprocess", "import subprocess", "import subprocess"),
]
for name, code, needle in preserved_cases:
    out = strip_preloaded_imports(code)
    check(name, needle in out, repr(out))


print("\n[strip - code preserved around imports]")
out = strip_preloaded_imports("import json\nx = 1")
check("statement after import remains", out.strip() == "x = 1", repr(out))
out = strip_preloaded_imports("x = 1\nimport json\ny = x + 1")
check("statements around import remain", "x = 1" in out and "y = x + 1" in out and "import" not in out, repr(out))


print("\n[strip - nested imports left alone]")
nested = "def f():\n    import json\n    return 1"
out = strip_preloaded_imports(nested)
check("nested import preserved", "import json" in out and "def f" in out, repr(out))


print("\n[strip - syntax error passes through]")
for code in ["import )", "def ("]:
    out = strip_preloaded_imports(code)
    check(f"syntax unchanged {code!r}", out == code, repr(out))


print("\n[check_ast - strip to reject pipeline]")
out = strip_preloaded_imports("import sys")
check("unsafe import unchanged before check", out == "import sys", repr(out))
check("unsafe import still rejected", rejects(out))
check("from import still rejected", rejects(strip_preloaded_imports("from collections import Counter")))
check("alias import still rejected", rejects(strip_preloaded_imports("import json as j")))
check("safe import strips then validates", not rejects(strip_preloaded_imports("import json\nx = 1")))


print(f"\n{pass_count} passed, {fail_count} failed")
if fail_count:
    sys.exit(1)
