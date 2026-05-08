"""
Body fs path semantics tests. Hand-runnable: python body/test_fs_paths.py

Tests local fs primitives (read, listdir, glob) for path normalization,
relative/absolute handling, Windows slash behavior, missing-file errors,
non-ASCII filenames, and glob->read chaining. Write/edit tests require the
bridge and live in scripts/fs_paths_bridge_smoke.ts.
"""
import json
import os
import subprocess
import sys
import time
from pathlib import Path

# -- Setup ----------------------------------------------------------------
# sys.path for local imports (security, fs module)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from fs import _local_read, _local_listdir, _local_glob, FsError

# -- Encoding fix for Windows console output --------------------------------
# On Windows, stdout defaults to cp1252 which can't encode non-ASCII filenames
# in test output. This mirrors the PYTHONIOENCODING=utf-8 fix used by the body
# server itself. Without this, the test crashes when printing paths containing
# em-dashes or Greek characters in check() detail strings.
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")


ROOT = Path(__file__).resolve().parent.parent
TMP = ROOT / ".aries" / "tmp" / "fs-path-tests"

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


def setup():
    """Create fixture files for path tests."""
    TMP.mkdir(parents=True, exist_ok=True)
    # Basic text file
    (TMP / "hello.txt").write_text("hello world\n", encoding="utf-8")
    # Nested directory
    nested = TMP / "sub" / "deep"
    nested.mkdir(parents=True, exist_ok=True)
    (nested / "nested.txt").write_text("nested content\n", encoding="utf-8")
    # Non-ASCII filenames — em dash U+2014, Greek letters
    (TMP / "em\u2014dash.txt").write_text("em dash filename\n", encoding="utf-8")
    (TMP / "\u03b1\u03b2\u03b3.txt").write_text("greek filename\n", encoding="utf-8")
    (TMP / "sub" / "child.txt").write_text("child\n", encoding="utf-8")


def teardown():
    """Remove fixture directory."""
    import shutil
    if TMP.exists():
        shutil.rmtree(TMP, ignore_errors=True)


# -- Tests: fs.read path handling ------------------------------------------

def test_read_absolute_path():
    """Absolute paths resolve directly."""
    print("\n[fs.read - absolute paths]")
    abs_path = str(TMP / "hello.txt")
    content = _local_read(abs_path)
    check("read absolute path", content == "hello world\n", repr(content))


def test_read_relative_path():
    """Relative paths resolve from cwd."""
    print("\n[fs.read - relative paths]")
    rel = os.path.relpath(str(TMP / "hello.txt"), os.getcwd())
    content = _local_read(rel)
    check("read relative path", content == "hello world\n", repr(content))


def test_read_forward_slash_on_windows():
    """Forward slashes work on Windows (pathlib normalizes)."""
    print("\n[fs.read - slash normalization]")
    forward = str(TMP / "sub" / "deep" / "nested.txt").replace(os.sep, "/")
    content = _local_read(forward)
    check("read forward-slash path", content == "nested content\n", repr(content))


def test_read_backslash_on_windows():
    """Backslashes work on Windows."""
    print("\n[fs.read - backslash paths]")
    backslash = str(TMP / "sub" / "deep" / "nested.txt").replace("/", "\\")
    content = _local_read(backslash)
    check("read backslash path", content == "nested content\n", repr(content))


def test_read_mixed_slashes():
    """Mixed slashes are resolved by pathlib."""
    print("\n[fs.read - mixed slashes]")
    mixed = str(TMP) + "/sub\\deep/nested.txt"
    content = _local_read(mixed)
    check("read mixed-slash path", content == "nested content\n", repr(content))


def test_read_missing_file():
    """Missing file raises FsError with hint message."""
    print("\n[fs.read - missing file]")
    missing = str(TMP / "nonexistent.txt")
    raised = False
    msg = ""
    try:
        _local_read(missing)
    except FsError as e:
        raised = True
        msg = str(e)
    except Exception as e:
        raised = False
        msg = f"wrong exception type: {type(e).__name__}: {e}"

    check("read missing raises FsError", raised, msg[:200])
    check("read missing msg has path", "no file at" in msg, msg[:200])
    check("read missing msg has hint", "Similar files" in msg or "Files in" in msg or "Try:" in msg, msg[:200])


def test_read_missing_file_no_parent():
    """Missing file in nonexistent directory still raises FsError."""
    print("\n[fs.read - missing file, no parent dir]")
    missing = str(TMP / "no_such_dir" / "ghost.txt")
    raised = False
    msg = ""
    try:
        _local_read(missing)
    except FsError as e:
        raised = True
        msg = str(e)

    check("read missing (no parent) raises FsError", raised, msg[:200])
    check("read missing (no parent) no crash", "no file at" in msg, msg[:200])


def test_read_nonascii_filename():
    """Non-ASCII filenames (em-dash, Greek) read correctly."""
    print("\n[fs.read - non-ASCII filenames]")
    em_path = str(TMP / "em\u2014dash.txt")
    content = _local_read(em_path)
    check("read em-dash filename", content == "em dash filename\n", repr(content))

    greek_path = str(TMP / "\u03b1\u03b2\u03b3.txt")
    content = _local_read(greek_path)
    check("read greek filename", content == "greek filename\n", repr(content))


# -- Tests: fs.listdir path handling ---------------------------------------

def test_listdir_absolute():
    """listdir with absolute path."""
    print("\n[fs.listdir - absolute path]")
    entries = _local_listdir(str(TMP))
    check("listdir absolute returns list", isinstance(entries, list))
    check("listdir contains hello.txt", "hello.txt" in entries, str(entries))
    check("listdir sub/ has trailing slash", "sub/" in entries, str(entries))


def test_listdir_relative():
    """listdir with relative path."""
    print("\n[fs.listdir - relative path]")
    rel = os.path.relpath(str(TMP), os.getcwd())
    entries = _local_listdir(rel)
    check("listdir relative returns list", isinstance(entries, list))
    check("listdir relative contains hello.txt", "hello.txt" in entries, str(entries))


def test_listdir_missing_dir():
    """listdir on missing dir raises FsError."""
    print("\n[fs.listdir - missing dir]")
    raised = False
    msg = ""
    try:
        _local_listdir(str(TMP / "no_such"))
    except FsError as e:
        raised = True
        msg = str(e)
    check("listdir missing raises FsError", raised, msg[:200])
    check("listdir missing msg shape", "no directory at" in msg, msg[:200])


def test_listdir_on_file():
    """listdir on a file (not dir) raises FsError."""
    print("\n[fs.listdir - path is file, not dir]")
    raised = False
    msg = ""
    try:
        _local_listdir(str(TMP / "hello.txt"))
    except FsError as e:
        raised = True
        msg = str(e)
    check("listdir on file raises FsError", raised, msg[:200])
    check("listdir on file msg shape", "not a directory" in msg, msg[:200])


def test_listdir_nonascii():
    """listdir shows non-ASCII filenames."""
    print("\n[fs.listdir - non-ASCII entries]")
    entries = _local_listdir(str(TMP))
    check("listdir has em-dash file", "em\u2014dash.txt" in entries, str(entries))
    check("listdir has greek file", "\u03b1\u03b2\u03b3.txt" in entries, str(entries))


# -- Tests: fs.glob path handling ------------------------------------------

def test_glob_basic():
    """glob returns relative paths."""
    print("\n[fs.glob - basic pattern]")
    results = _local_glob("*.txt", str(TMP))
    check("glob returns list", isinstance(results, list))
    check("glob finds hello.txt", "hello.txt" in results, str(results))
    for r in results:
        check(f"glob result '{r}' is relative", not os.path.isabs(r), r)


def test_glob_recursive():
    """glob with ** pattern descends."""
    print("\n[fs.glob - recursive pattern]")
    results = _local_glob("**/*.txt", str(TMP))
    check("glob recursive finds nested", any("nested.txt" in r for r in results), str(results))
    check("glob recursive finds child", any("child.txt" in r for r in results), str(results))


def test_glob_nonascii():
    """glob matches non-ASCII filenames."""
    print("\n[fs.glob - non-ASCII filenames]")
    results = _local_glob("*.txt", str(TMP))
    check("glob finds em-dash file", any("\u2014" in r for r in results), str(results))
    check("glob finds greek file", any("\u03b1" in r for r in results), str(results))


def test_glob_to_read_compatibility():
    """
    glob output chains cleanly into read - the critical path question.
    glob returns paths relative to the base dir, so read needs base + result.
    """
    print("\n[fs.glob -> fs.read - path chaining]")
    base = str(TMP)
    results = _local_glob("*.txt", base)
    check("glob returned results", len(results) > 0, f"got {len(results)}")

    for r in results[:5]:
        joined = os.path.join(base, r)
        try:
            content = _local_read(joined)
            check(f"glob->read chain '{r}'", len(content) > 0, f"{len(content)} chars")
        except Exception as e:
            check(f"glob->read chain '{r}'", False, str(e))


def test_glob_to_read_recursive():
    """Recursive glob output also chains into read."""
    print("\n[fs.glob -> fs.read - recursive chain]")
    base = str(TMP)
    results = _local_glob("**/*.txt", base)
    check("recursive glob returned results", len(results) > 0, f"got {len(results)}")

    for r in results:
        joined = os.path.join(base, r)
        try:
            content = _local_read(joined)
            check(f"glob->read recursive '{r}'", len(content) > 0, f"{len(content)} chars")
        except Exception as e:
            check(f"glob->read recursive '{r}'", False, str(e))


def test_glob_slash_normalization():
    """
    On Windows, glob results may use backslash. Verify that
    os.path.join(base, glob_result) produces a readable path regardless.
    """
    print("\n[fs.glob - slash normalization in results]")
    base = str(TMP)
    results = _local_glob("**/*.txt", base)
    for r in results:
        p = Path(base) / r
        check(f"pathlib join '{r}'", p.exists(), str(p))


def test_glob_missing_dir():
    """glob on missing directory raises FsError."""
    print("\n[fs.glob - missing dir]")
    raised = False
    msg = ""
    try:
        _local_glob("*.txt", str(TMP / "no_such"))
    except FsError as e:
        raised = True
        msg = str(e)
    check("glob missing dir raises FsError", raised, msg[:200])
    check("glob missing dir msg shape", "no directory at" in msg, msg[:200])


def test_glob_on_file():
    """glob with base path pointing to a file raises FsError."""
    print("\n[fs.glob - base is file]")
    raised = False
    msg = ""
    try:
        _local_glob("*", str(TMP / "hello.txt"))
    except FsError as e:
        raised = True
        msg = str(e)
    check("glob on file raises FsError", raised, msg[:200])
    check("glob on file msg shape", "not a directory" in msg, msg[:200])


# -- Tests: workspace root behavior ----------------------------------------

def test_workspace_root_read():
    """
    Paths without leading slash resolve relative to cwd (the workspace root
    when the body is launched). This is the normal model usage pattern.
    """
    print("\n[workspace root - relative read]")
    known_file = "body/fs.py"
    if Path(ROOT / known_file).exists():
        orig_cwd = os.getcwd()
        os.chdir(str(ROOT))
        try:
            content = _local_read(known_file)
            check("workspace-root relative read", "class Fs" in content, f"{len(content)} chars")
        finally:
            os.chdir(orig_cwd)
    else:
        check("workspace-root relative read", False, f"{known_file} not found at {ROOT}")


def test_workspace_root_glob():
    """Glob with default path='.' uses cwd as base."""
    print("\n[workspace root - glob from cwd]")
    orig_cwd = os.getcwd()
    os.chdir(str(ROOT))
    try:
        results = _local_glob("body/*.py")
        check("workspace-root glob finds files", len(results) > 0, f"got {len(results)}")
        check("workspace-root glob finds fs.py", any("fs.py" in r for r in results), str(results[:5]))
    finally:
        os.chdir(orig_cwd)


# -- Tests: Windows-specific slash behavior --------------------------------

def test_glob_result_slash_direction():
    """
    Document what slash direction glob results use. On Windows pathlib.glob
    returns paths with backslash. str(match.relative_to(p)) preserves that.
    Informational - the test PASSES either way but reports what it finds.
    """
    print("\n[fs.glob - result slash direction (informational)]")
    base = str(TMP)
    results = _local_glob("**/*.txt", base)
    has_backslash = any("\\" in r for r in results)
    has_forward = any("/" in r for r in results)
    if sys.platform == "win32":
        check("glob results use backslash on Windows",
              has_backslash or not any(os.sep in r for r in results),
              f"backslash={has_backslash}, forward={has_forward}, sample={results[:3]}")
    else:
        check("glob results use forward slash on unix",
              has_forward or not any(os.sep in r for r in results),
              f"backslash={has_backslash}, forward={has_forward}, sample={results[:3]}")


# -- Main -----------------------------------------------------------------

def main():
    setup()
    try:
        test_read_absolute_path()
        test_read_relative_path()
        test_read_forward_slash_on_windows()
        test_read_backslash_on_windows()
        test_read_mixed_slashes()
        test_read_missing_file()
        test_read_missing_file_no_parent()
        test_read_nonascii_filename()
        test_listdir_absolute()
        test_listdir_relative()
        test_listdir_missing_dir()
        test_listdir_on_file()
        test_listdir_nonascii()
        test_glob_basic()
        test_glob_recursive()
        test_glob_nonascii()
        test_glob_to_read_compatibility()
        test_glob_to_read_recursive()
        test_glob_slash_normalization()
        test_glob_missing_dir()
        test_glob_on_file()
        test_workspace_root_read()
        test_workspace_root_glob()
        test_glob_result_slash_direction()
    finally:
        teardown()

    print(f"\n{'='*60}")
    print(f"  {pass_count} passed, {fail_count} failed")
    if fail_count > 0:
        sys.exit(1)
    print("  All path semantics tests passed.")


if __name__ == "__main__":
    main()
