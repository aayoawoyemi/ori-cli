/**
 * Phase 5 — Codebase ambient signature tests.
 *
 * Verifies the signature compiler: compact, structured, within budget,
 * includes all expected sections.
 *
 * Run: npx tsx test/repl/signature.test.ts
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

  // ---- Before indexing: signature fails cleanly ----
  const r0 = await bridge.codebaseSignature('standard', 1000);
  check('signature errors before index', r0.error !== undefined && r0.error.includes('not indexed'));

  // ---- Index and generate signature ----
  await bridge.index({ repoPath: 'src' });
  const sig = await bridge.codebaseSignature('standard', 1000);

  check('signature generated', !sig.error);
  check('has schema_version', sig.schema_version === '0.2.0');
  check('has level field', sig.level === 'standard');
  check('under token budget', sig.approx_tokens < 1100,
    `${sig.approx_tokens} tokens`);
  check('has markdown', typeof sig.markdown === 'string' && sig.markdown.length > 100);

  // ---- Content checks ----
  check('includes file count header', /\d+ files/.test(sig.markdown));
  check('has entry_points section', sig.entry_points.length > 0);
  check('has authorities section', sig.authorities.length > 0);
  check('has hubs section', sig.hubs.length > 0);
  check('has modules', sig.modules.length > 0);
  check('has type_hubs', sig.type_hubs.length > 0);

  // ---- Quality checks: HITS separation ----
  // Authorities should NOT equal hubs (they're supposed to be different sets)
  const authPaths = new Set(sig.authorities.map(a => a.path));
  const hubPaths = new Set(sig.hubs.map(h => h.path));
  const overlap = [...authPaths].filter(p => hubPaths.has(p)).length;
  check('authorities and hubs differ structurally',
    overlap < Math.min(authPaths.size, hubPaths.size),
    `overlap: ${overlap}`);

  // ---- Type hubs should include known core types ----
  const typeHubNames = sig.type_hubs.map(t => t.name);
  check('type_hubs includes Tool interface',
    typeHubNames.some(n => n === 'Tool' || n === 'ToolResult' || n === 'Message'),
    `got: ${typeHubNames.join(', ')}`);

  // ---- Modules should have labels (not just "root") ----
  const nonRootLabels = sig.modules.filter(m => m.label !== 'root').length;
  check('modules have meaningful labels',
    nonRootLabels >= sig.modules.length / 2,
    `${nonRootLabels}/${sig.modules.length} non-root`);

  // ---- Budget enforcement ----
  const smallSig = await bridge.codebaseSignature('standard', 400);
  check('respects smaller budget', smallSig.approx_tokens < 550,
    `${smallSig.approx_tokens} tokens at 400 target`);
  check('smaller signature drops modules', smallSig.modules.length <= sig.modules.length);

  // ---- Level progression: lean → standard → deep → max ----
  const lean = await bridge.codebaseSignature('lean', 10_000);
  const std = await bridge.codebaseSignature('standard', 10_000);
  const deep = await bridge.codebaseSignature('deep', 10_000);
  const max = await bridge.codebaseSignature('max', 10_000);

  check('lean < standard tokens', lean.approx_tokens < std.approx_tokens,
    `${lean.approx_tokens} vs ${std.approx_tokens}`);
  check('standard < deep tokens', std.approx_tokens < deep.approx_tokens,
    `${std.approx_tokens} vs ${deep.approx_tokens}`);
  check('deep < max tokens', deep.approx_tokens < max.approx_tokens,
    `${deep.approx_tokens} vs ${max.approx_tokens}`);
  check('lean has level marker', lean.level === 'lean');
  check('max has level marker', max.level === 'max');

  // ---- Deep adds file_first_comments (not in standard) ----
  const hasComment = deep.entry_points.some(e => 'comment' in e);
  check('deep includes first comments', hasComment);

  // ---- Deep/max include module files (not in standard) ----
  const deepModuleFiles = deep.modules[0]?.files !== undefined;
  check('deep includes module files', deepModuleFiles);

  // ---- Max has more entries than standard ----
  check('max has more entry_points than standard',
    max.entry_points.length > std.entry_points.length);
  check('max has more type_hubs than standard',
    max.type_hubs.length > std.type_hubs.length);

  // ---- Markdown renders cleanly ----
  check('markdown starts with header', sig.markdown.startsWith('#'));
  check('markdown contains Authorities section',
    sig.markdown.includes('Authorities') || sig.markdown.includes('Top'));

  await bridge.shutdown();

  console.log('');
  console.log(`${pass}/${pass + fail} passed`);
  if (fail === 0) {
    console.log('');
    console.log('--- Sample signature (first 400 chars) ---');
    console.log(sig.markdown.slice(0, 400));
  }
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});
