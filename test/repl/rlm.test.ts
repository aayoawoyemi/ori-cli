/**
 * Phase 4 — rlm_call tests.
 *
 * Requires ANTHROPIC_API_KEY env var. Skips if missing.
 *
 * Run: ANTHROPIC_API_KEY=sk-... npx tsx test/repl/rlm.test.ts
 */
import { ReplBridge } from '../../src/repl/bridge.js';

const API_KEY = process.env.ANTHROPIC_API_KEY;

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
  if (!API_KEY) {
    console.log('  SKIP: no ANTHROPIC_API_KEY. Set it to run rlm tests.');
    process.exit(0);
  }

  const bridge = new ReplBridge({ timeoutMs: 120_000 });
  await bridge.start();

  // ---- Before configure: rlm_call NOT in namespace ----
  const r0 = await bridge.exec({ code: 'print(rlm_call)' });
  check('rlm_call undefined before configure',
    r0.exception !== null && r0.exception.includes('NameError'));

  // ---- Configure ----
  const cfg = await bridge.configureRlm({
    apiKey: API_KEY,
    model: 'claude-sonnet-4-5-20250929',
    maxCalls: 15,
  });
  check('configure_rlm ok', cfg.ok === true);

  // ---- Basic rlm_call ----
  const t1 = Date.now();
  const r1 = await bridge.exec({
    code: `
answer = rlm_call(
  "The Eiffel Tower is in Paris, France. It was built in 1889.",
  "What city is the Eiffel Tower in?",
  budget=100,
)
print(answer)
`,
    timeout_ms: 60_000,
  });
  const t1ms = Date.now() - t1;
  check('rlm_call returns string', r1.exception === null, r1.exception?.slice(0, 100));
  check('rlm_call finds Paris', r1.stdout.toLowerCase().includes('paris'));
  check('rlm_stats populated', r1.rlm_stats !== undefined && r1.rlm_stats.call_count === 1,
    `stats: ${JSON.stringify(r1.rlm_stats)}`);
  console.log(`       (single call: ${t1ms}ms, ${r1.rlm_stats?.total_tokens ?? '?'} tokens)`);

  // ---- rlm_batch parallel ----
  const t2 = Date.now();
  const r2 = await bridge.exec({
    code: `
pairs = [
  ("Paris is the capital of France.", "What country is Paris in?"),
  ("Tokyo is the capital of Japan.", "What country is Tokyo in?"),
  ("Berlin is the capital of Germany.", "What country is Berlin in?"),
  ("Rome is the capital of Italy.", "What country is Rome in?"),
]
answers = rlm_batch(pairs, budget_per=80)
for i, a in enumerate(answers):
  print(f"{i}: {a[:80]}")
`,
    timeout_ms: 60_000,
  });
  const t2ms = Date.now() - t2;
  check('rlm_batch runs', r2.exception === null, r2.exception?.slice(0, 100));
  check('rlm_batch returns 4 answers',
    r2.stdout.split('\n').filter(l => /^\d:/.test(l)).length === 4);
  check('rlm_batch stats cumulative',
    r2.rlm_stats !== undefined && r2.rlm_stats.call_count === 4,
    `stats: ${JSON.stringify({calls: r2.rlm_stats?.call_count, tokens: r2.rlm_stats?.total_tokens})}`);
  console.log(`       (4 parallel: ${t2ms}ms, ${r2.rlm_stats?.total_tokens ?? '?'} tokens)`);

  // ---- Stats reset between execs ----
  const r3 = await bridge.exec({ code: "print('no rlm here')" });
  check('stats reset between execs', r3.rlm_stats === undefined);

  // ---- Budget cap enforcement ----
  // Configure a very low cap and verify it's enforced
  await bridge.configureRlm({ apiKey: API_KEY, maxCalls: 2 });
  const r4 = await bridge.exec({
    code: `
for i in range(5):
  ans = rlm_call(f"fact {i}", "say hi", budget=60)
  print(f"{i}: {ans[:60]}")
`,
    timeout_ms: 120_000,
  });
  check('budget cap enforced',
    r4.exception === null && r4.stdout.includes('budget exhausted'),
    `stats: ${r4.rlm_stats?.call_count}`);
  check('call count stopped at cap',
    r4.rlm_stats !== undefined && r4.rlm_stats.call_count === 2);

  // ---- Reset cap to higher ----
  await bridge.configureRlm({ apiKey: API_KEY, maxCalls: 15 });

  // ---- Cross-substrate: codebase + rlm_call together ----
  await bridge.index({ repoPath: 'src' });
  const r5 = await bridge.exec({
    code: `
# Find a concept in the codebase, have a sub-reasoner summarize it
matches = codebase.search("trajectory", limit=20)
clusters = codebase.cluster_by_file(matches)

# Pick top 2 files
top_files = list(clusters.keys())[:2]
pairs = []
for f in top_files:
  lines = [m["line"] for m in clusters[f]]
  ctx = codebase.get_context(f, lines, window=3)
  pairs.append((ctx, f"What role does trajectory play in {f}? One sentence."))

if pairs:
  answers = rlm_batch(pairs, budget_per=100)
  for f, a in zip(top_files, answers):
    print(f"{f}: {a[:120]}")
`,
    timeout_ms: 120_000,
  });
  check('codebase + rlm_batch composition works',
    r5.exception === null && r5.stdout.length > 50,
    r5.exception?.slice(0, 80));
  check('sub-calls captured in stats',
    r5.rlm_stats !== undefined && r5.rlm_stats.call_count >= 1);

  await bridge.shutdown();

  console.log('');
  console.log(`${pass}/${pass + fail} passed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});
