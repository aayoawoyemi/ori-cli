"""Unit tests for body/judgment.py. Hand-runnable: python body/test_judgment.py"""
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from judgment import (
    tokenize_identifier, jaccard, detect_casing,
    normalize_code_window, ast_shape_hash, ast_shape_sequence,
    hash_sequence_distance, hash_sequence_similarity,
    extract_topic_tokens,
)

pass_count = 0
fail_count = 0


def check(name, cond, detail=""):
    global pass_count, fail_count
    if cond:
        print(f"  PASS  {name}" + (f" — {detail}" if detail else ""))
        pass_count += 1
    else:
        print(f"  FAIL  {name}" + (f" — {detail}" if detail else ""))
        fail_count += 1


# -------- tokenize_identifier --------
print("\n[tokenize_identifier]")
check("camelCase", tokenize_identifier("fooBarBaz") == ["foo", "bar", "baz"])
check("snake_case", tokenize_identifier("foo_bar_baz") == ["foo", "bar", "baz"])
check("PascalCase", tokenize_identifier("FooBarBaz") == ["foo", "bar", "baz"])
check("UPPER_SNAKE", tokenize_identifier("FOO_BAR_BAZ") == ["foo", "bar", "baz"])
check("kebab-case", tokenize_identifier("foo-bar-baz") == ["foo", "bar", "baz"])
check("acronym trailing", tokenize_identifier("FooBarHTTP") == ["foo", "bar", "http"])
check("acronym leading", tokenize_identifier("HTTPRequest") == ["http", "request"])
check("acronym middle", tokenize_identifier("parseHTMLString") == ["parse", "html", "string"],
      str(tokenize_identifier("parseHTMLString")))
check("empty", tokenize_identifier("") == [])
check("single", tokenize_identifier("foo") == ["foo"])
check("dotted", tokenize_identifier("foo.bar.baz") == ["foo", "bar", "baz"])
check("numbers", tokenize_identifier("parse2Html") == ["parse2", "html"],
      str(tokenize_identifier("parse2Html")))

# -------- jaccard --------
print("\n[jaccard]")
check("identical", jaccard({"a", "b", "c"}, {"a", "b", "c"}) == 1.0)
check("disjoint", jaccard({"a", "b"}, {"c", "d"}) == 0.0)
check("partial", jaccard({"a", "b"}, {"a", "c"}) == 1/3)
check("empty/empty", jaccard(set(), set()) == 0.0)
check("empty/full", jaccard(set(), {"a"}) == 0.0)

# -------- detect_casing --------
print("\n[detect_casing]")
check("camel", detect_casing("fooBar") == "camel")
check("pascal", detect_casing("FooBar") == "pascal")
check("snake", detect_casing("foo_bar") == "snake")
check("upper_snake", detect_casing("FOO_BAR") == "upper_snake")
check("kebab", detect_casing("foo-bar") == "kebab")
check("upper", detect_casing("FOOBAR") == "upper")
check("lower", detect_casing("foobar") == "lower")
check("empty", detect_casing("") == "empty")
check("single upper", detect_casing("X") == "upper")

# -------- normalize_code_window --------
print("\n[normalize_code_window]")
n1 = normalize_code_window(['const x = "hello world";'])
check("string literal masked", '"STR"' in n1 and "hello world" not in n1, n1)
n2 = normalize_code_window(["let n = 42;"])
check("number literal masked", "NUM" in n2 and "42" not in n2, n2)
n3 = normalize_code_window(["function greet(name) { return name; }"])
check("identifiers masked",
      "greet" not in n3 and "IDENT" in n3 and "function" in n3, n3)
n4 = normalize_code_window(["  if (x)   return 1;  "])
check("whitespace collapsed", "  " not in n4, n4)
n5a = normalize_code_window(["function foo(a) { return a + 1; }"])
n5b = normalize_code_window(["function bar(b) { return b + 2; }"])
check("same shape -> same normalized", n5a == n5b, f"{n5a} vs {n5b}")

# -------- ast_shape_hash + sequence (mock node) --------
print("\n[ast_shape_hash (mock nodes)]")

class MockNode:
    def __init__(self, type_name, children=None):
        self.type = type_name
        self.children = children or []

leaf = MockNode("identifier")
block_a = MockNode("function", [
    MockNode("identifier"),
    MockNode("block", [MockNode("return_statement", [MockNode("identifier")])]),
])
block_b = MockNode("function", [
    MockNode("identifier"),
    MockNode("block", [MockNode("return_statement", [MockNode("identifier")])]),
])
block_c = MockNode("function", [
    MockNode("identifier"),
    MockNode("block", [MockNode("if_statement", [MockNode("identifier"), MockNode("block")])]),
])

ha = ast_shape_hash(block_a)
hb = ast_shape_hash(block_b)
hc = ast_shape_hash(block_c)
check("identical structure -> same hash", ha == hb, f"{ha} == {hb}")
check("different structure -> different hash", ha != hc, f"{ha} != {hc}")
check("hash is hex string", all(c in "0123456789abcdef" for c in ha) and len(ha) == 16, ha)

# shape sequence of children
seq_a = ast_shape_sequence(block_a)
seq_b = ast_shape_sequence(block_b)
check("shape sequence equal for identical trees", seq_a == seq_b)
check("shape sequence has 2 children", len(seq_a) == 2)

# depth limit: nodes deeper than depth_limit hash as type only
deep = MockNode("a", [MockNode("b", [MockNode("c", [MockNode("d", [MockNode("e")])])])])
shallow = MockNode("a", [MockNode("b", [MockNode("c", [MockNode("d", [MockNode("different")])])])])
h_depth2 = ast_shape_hash(deep, depth_limit=2)
h_shallow_depth2 = ast_shape_hash(shallow, depth_limit=2)
check("depth_limit truncates comparison", h_depth2 == h_shallow_depth2,
      "structures differ only beyond depth 2")

# -------- hash_sequence_distance --------
print("\n[hash_sequence_distance]")
check("identical -> 0.0", hash_sequence_distance(["a", "b", "c"], ["a", "b", "c"]) == 0.0)
check("disjoint equal-length -> 1.0", hash_sequence_distance(["a", "b"], ["c", "d"]) == 1.0)
check("one edit in 3", abs(hash_sequence_distance(["a", "b", "c"], ["a", "x", "c"]) - 1/3) < 1e-9)
check("both empty -> 0.0", hash_sequence_distance([], []) == 0.0)
check("empty vs non-empty -> 1.0", hash_sequence_distance([], ["a"]) == 1.0)
check("similarity = 1 - distance",
      abs(hash_sequence_similarity(["a", "b"], ["a", "c"]) - 0.5) < 1e-9)
check("insertion",
      abs(hash_sequence_distance(["a", "b"], ["a", "b", "c"]) - 1/3) < 1e-9,
      str(hash_sequence_distance(["a", "b"], ["a", "b", "c"])))

# -------- extract_topic_tokens --------
print("\n[extract_topic_tokens]")
check("known topic error handling",
      "try" in extract_topic_tokens("error handling") and "catch" in extract_topic_tokens("error handling"))
check("known topic logging",
      "log" in extract_topic_tokens("logging"))
check("unknown topic fallback",
      len(extract_topic_tokens("foo bar widget")) > 0)
check("case-insensitive", extract_topic_tokens("Error Handling") == extract_topic_tokens("error handling"))

# -------- summary --------
print("")
print(f"{pass_count}/{pass_count + fail_count} passed")
sys.exit(0 if fail_count == 0 else 1)
