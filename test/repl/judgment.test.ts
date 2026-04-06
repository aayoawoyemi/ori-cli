/**
 * Phase 8 — judgment tools integration test.
 *
 * Exercises find_similar_patterns, suggest_location, find_convention,
 * detect_duplication, is_consistent_with through the REPL bridge against
 * aries-cli's own src/.
 *
 * Run: npx tsx test/repl/judgment.test.ts
 */
import { ReplBridge } from '../../src/repl/bridge.js';

let pass = 0;
let fail = 0;

function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
    pass++;
  } else {
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
    fail++;
  }
}

async function main() {
  const bridge = new ReplBridge({ timeoutMs: 30_000 });
  await bridge.start();
  await bridge.index({ repoPath: 'src' });

  // ---- 1. find_similar_patterns(name) ----
  const r1 = await bridge.exec({
    code: `
results = codebase.find_similar_patterns("assembleCurrentState", limit=5, mode="name")
print(f"count={len(results)}")
for r in results:
    print(f"name={r['name']} score={r['score']}")
`,
  });
  check('similar(name) runs clean', r1.exception === null && !r1.rejected,
    r1.exception ?? r1.rejected?.reason ?? '');
  check('similar(name) finds results', r1.stdout.includes('count=') && !r1.stdout.includes('count=0'),
    r1.stdout.split('\n')[0]);
  check('similar(name) surfaces assemble-family helpers',
    /name=assembleWarm|name=assembleCurrent|assemble/i.test(r1.stdout),
    r1.stdout.split('\n').slice(0, 3).join(' | '));

  // ---- 2. find_similar_patterns(signature) ----
  const r2 = await bridge.exec({
    code: `
results = codebase.find_similar_patterns({"kind": "function", "name_contains": "assemble"}, limit=5, mode="signature")
print(f"count={len(results)}")
for r in results:
    print(f"name={r['name']} kind={r['kind']}")
`,
  });
  check('similar(signature) runs clean', r2.exception === null && !r2.rejected);
  check('similar(signature) finds assemble functions',
    r2.stdout.includes('name=assemble'), r2.stdout.split('\n')[1] ?? '');

  // ---- 3. find_similar_patterns(shape) ----
  const r3 = await bridge.exec({
    code: `
snippet = '''async function fetchAndLog(x) {
  try {
    const r = await fetch(x);
    return r.json();
  } catch (e) {
    console.error(e);
    return null;
  }
}
'''
results = codebase.find_similar_patterns(snippet, limit=5, mode="shape")
print(f"count={len(results)}")
for r in results[:3]:
    print(f"score={r['score']} name={r['name']} kind={r['kind']}")
`,
  });
  check('similar(shape) runs clean', r3.exception === null && !r3.rejected,
    r3.exception ?? '');
  check('similar(shape) returns at least one match',
    /score=/.test(r3.stdout), r3.stdout.slice(0, 200));

  // ---- 4. suggest_location ----
  const r4 = await bridge.exec({
    code: `
results = codebase.suggest_location("memory vault helper", limit=3)
print(f"count={len(results)}")
for r in results:
    print(f"conf={r['confidence']} label={r['label']} sample={r['sample_files'][:2]}")
`,
  });
  check('suggest_location runs clean', r4.exception === null && !r4.rejected);
  check('suggest_location finds a community',
    !r4.stdout.includes('count=0'), r4.stdout.split('\n').slice(0, 2).join(' | '));
  check('suggest_location routes memory+vault to memory area',
    /memory\//.test(r4.stdout), r4.stdout.split('\n').slice(0, 3).join(' | '));

  // ---- 5. find_convention ----
  const r5 = await bridge.exec({
    code: `
results = codebase.find_convention("imports", limit=3)
print(f"count={len(results)}")
for r in results:
    print(f"files={r['file_count']} occ={r['occurrence_count']} pattern={r['pattern'][:60]}")
`,
  });
  check('find_convention(imports) runs clean', r5.exception === null && !r5.rejected);
  check('find_convention(imports) finds recurring patterns',
    !r5.stdout.includes('count=0'), r5.stdout.split('\n')[0]);
  check('find_convention surfaces an import pattern',
    /pattern=.*import/i.test(r5.stdout), r5.stdout.split('\n')[1] ?? '');

  // ---- 6. detect_duplication (pull a real function via codebase.files, feed back in) ----
  const r6 = await bridge.exec({
    code: `
target = codebase.find_symbol("extractIdentityLine")
assert target, "extractIdentityLine not found in index"
target_file = target[0]["file"]
target_line = target[0]["line"]
rec = codebase.files[target_file]
# Grab the function body by scanning from target_line until brace balance returns to 0
start = target_line - 1
depth = 0
end = start
seen_open = False
for i in range(start, min(start + 60, len(rec.lines))):
    for ch in rec.lines[i]:
        if ch == "{":
            depth += 1
            seen_open = True
        elif ch == "}":
            depth -= 1
    if seen_open and depth == 0:
        end = i + 1
        break
exact_source = "\\n".join(rec.lines[start:end])
results = codebase.detect_duplication(exact_source, threshold=0.7, limit=5)
print(f"count={len(results)}")
for r in results[:3]:
    print(f"sim={r['similarity']} kind={r['match_kind']} name={r['name']} file={r['file']}")
`,
  });
  check('detect_duplication runs clean', r6.exception === null && !r6.rejected,
    r6.exception ?? '');
  check('detect_duplication finds an exact match (sim=1.0)',
    /sim=1\.0 kind=exact/.test(r6.stdout), r6.stdout.split('\n').slice(0, 3).join(' | '));

  // ---- 7. is_consistent_with (good) ----
  const r7 = await bridge.exec({
    code: `
snippet = "function runThing(x) { return x + 1; }"
result = codebase.is_consistent_with(snippet, "typescript", criteria="all")
print(f"deviation={result['deviation_score']} findings={len(result['findings'])}")
`,
  });
  check('consistent(good) runs clean', r7.exception === null && !r7.rejected);
  check('consistent(good) low deviation',
    /deviation=0\.[0-2]\d* /.test(r7.stdout + ' ') || r7.stdout.includes('deviation=0.0'),
    r7.stdout.trim());

  // ---- 8. is_consistent_with (bad snake_case) ----
  const r8 = await bridge.exec({
    code: `
snippet = "function run_thing(input_val) { return input_val + 1; }"
result = codebase.is_consistent_with(snippet, "typescript", criteria="naming")
print(f"deviation={result['deviation_score']}")
for f in result['findings']:
    print(f"sev={f['severity']} aspect={f['aspect']} actual={f['actual']}")
`,
  });
  check('consistent(bad) runs clean', r8.exception === null && !r8.rejected);
  check('consistent(bad) high deviation',
    /deviation=(0\.[5-9]|1\.)/.test(r8.stdout), r8.stdout.split('\n')[0] ?? '');
  check('consistent(bad) raises naming finding',
    /aspect=naming/.test(r8.stdout), r8.stdout.trim());

  // ---- 9. Composition: suggest → consistency chain in one block ----
  const r9 = await bridge.exec({
    code: `
loc = codebase.suggest_location("vault query helper", limit=1)
refs = loc[0]["sample_files"] if loc else ["memory/vault.ts"]
draft = '''async function queryThing(v) { return await v.query_ranked("x", 5); }'''
result = codebase.is_consistent_with(draft, refs, criteria="all")
print(f"locs={len(loc)} refs={refs[:2]} dev={result['deviation_score']}")
`,
  });
  check('composition (suggest + is_consistent) chain', r9.exception === null && !r9.rejected,
    r9.exception ?? '');
  check('composition yields a deviation score', /dev=/.test(r9.stdout), r9.stdout.trim());

  console.log('');
  console.log(`${pass}/${pass + fail} passed`);
  await bridge.shutdown();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
