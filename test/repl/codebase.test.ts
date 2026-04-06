/**
 * Phase 2 E2E — codebase graph indexing + REPL composition.
 *
 * Verifies:
 *   - bridge.index() indexes the repo
 *   - `codebase` is exposed in REPL namespace after indexing
 *   - search/pagerank/hits/communities work via exec
 *
 * Run: npx tsx test/repl/codebase.test.ts
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

  // ---- Before indexing: codebase should NOT be in namespace ----
  const r0 = await bridge.exec({ code: 'print(codebase)' });
  check('codebase undefined before index',
    r0.exception !== null && r0.exception.includes('NameError'));

  // ---- Index the repo ----
  const indexResult = await bridge.index({ repoPath: 'src' });
  check('index ok', indexResult.ok === true);
  check('index found files', indexResult.file_count > 50, `files: ${indexResult.file_count}`);
  check('index found symbols', indexResult.symbol_count > 200, `symbols: ${indexResult.symbol_count}`);
  check('index built edges', indexResult.edge_count > 50, `edges: ${indexResult.edge_count}`);
  check('index fast', indexResult.elapsed_ms < 5000, `${indexResult.elapsed_ms}ms`);

  // ---- codebase stats via API ----
  const stats = await bridge.codebaseStats();
  check('stats has file_count', 'file_count' in stats && (stats as any).file_count > 0);

  // ---- codebase.search() via exec ----
  const r1 = await bridge.exec({
    code: `
matches = codebase.search("permission", limit=100)
print(f"matches={len(matches)}")
files = set(m["file"] for m in matches)
print(f"files={len(files)}")
`,
  });
  check('search runs', r1.exception === null, r1.exception?.slice(0, 80));
  check('search finds matches', r1.stdout.includes('matches=') && !r1.stdout.includes('matches=0'));

  // ---- PageRank ----
  const r2 = await bridge.exec({
    code: `
top = codebase.top_files(limit=5)
for entry in top:
    print(f"{entry['path']}: pr={entry['pagerank']}")
`,
  });
  check('pagerank works', r2.exception === null && r2.stdout.includes('pr='));

  // ---- HITS dual ranking ----
  const r3 = await bridge.exec({
    code: `
hits = codebase.hits(limit=3)
auths = [p for p, _ in hits["authorities"]]
hubs = [p for p, _ in hits["hubs"]]
print(f"authorities:{auths}")
print(f"hubs:{hubs}")
# Authorities should be foundational (define things), hubs should orchestrate
`,
  });
  check('HITS runs', r3.exception === null && r3.stdout.includes('authorities:') && r3.stdout.includes('hubs:'));

  // ---- Communities ----
  const r4 = await bridge.exec({
    code: `
comms = codebase.communities()
multi = [(cid, len(files)) for cid, files in comms.items() if len(files) > 1]
print(f"communities={len(comms)}, multi_file={len(multi)}")
`,
  });
  check('communities detected', r4.exception === null && r4.stdout.includes('communities='));

  // ---- show_dependents / show_dependencies ----
  const r5 = await bridge.exec({
    code: `
# repl/types.ts should have many dependents since types are imported widely
deps = codebase.show_dependents("repl/types.ts")
print(f"types.ts dependents: {len(deps)}")
print(f"first: {deps[:3]}")
`,
  });
  check('show_dependents works', r5.exception === null && r5.stdout.includes('dependents:'));

  // ---- Composition: search → cluster → get_context (the spike pattern) ----
  const r6 = await bridge.exec({
    code: `
matches = codebase.search("preflight", limit=30)
clusters = codebase.cluster_by_file(matches)
print(f"preflight appears in {len(clusters)} files")
# Pull context for one file
if clusters:
    first_file = list(clusters.keys())[0]
    lines = [m["line"] for m in clusters[first_file]]
    ctx = codebase.get_context(first_file, lines, window=2)
    print(f"context length: {len(ctx)} chars")
`,
  });
  check('composition pattern works', r6.exception === null && r6.stdout.includes('preflight appears in'));

  // ---- get_file_summary ----
  const r7 = await bridge.exec({
    code: `
summary = codebase.get_file_summary("loop.ts")
print(f"loop.ts: lang={summary['language']}, lines={summary['line_count']}, symbols={len(summary['symbols'])}")
`,
  });
  check('file_summary works', r7.exception === null && r7.stdout.includes('loop.ts:'));

  await bridge.shutdown();

  console.log('');
  console.log(`${pass}/${pass + fail} passed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});
