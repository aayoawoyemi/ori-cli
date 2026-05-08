/**
 * Effort A/B grid — composition-shape probe.
 *
 * Tests whether the Anthropic-docs claim ("low effort combines ops into fewer
 * tool calls; high effort makes more tool calls") actually holds for Aries CLI's
 * codemode-only surface (code is the only action tool in default mode).
 *
 * Hypothesis from the 2026-04-22 vault notes:
 *   - Default effort=high configures Aries for fragmentation
 *   - Dropping to low/medium should produce more cells per code call (composition)
 *
 * Probe task: same shape as the user's 2026-05-02 "find vault note on sprite 0"
 * test that fragmented into 8 code calls. Multi-strategy search is the canonical
 * composition trigger — tempts the model to do query → read → broaden → glob →
 * rg as separate calls when it could be one batch with parallel cells.
 *
 * Metrics:
 *   - code calls (lower = more composition)
 *   - Avg cells per code call (higher = more composition)
 *   - Total tokens
 *   - Wall time
 *
 * Usage:
 *   npx tsx bench/effort-grid.ts
 *   npx tsx bench/effort-grid.ts --model sonnet
 *   npx tsx bench/effort-grid.ts --efforts low,medium
 *   npx tsx bench/effort-grid.ts --task <custom-prompt>
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ModelRouter } from '../src/router/index.js';
import {
  createCoreRegistry, registerCodeTool,
} from '../src/tools/registry.js';
import { buildSystemPrompt } from '../src/prompt.js';
import { SessionStorage } from '../src/session/storage.js';
import { agentLoop } from '../src/loop.js';
import { setupReplBridge } from '../src/repl/setup.js';
import { loadConfig } from '../src/config/load.js';
import type { Message } from '../src/router/types.js';
import type { EffortLevel } from '../src/router/types.js';

// Load .env for API keys (DeepSeek, OpenRouter, etc — Anthropic uses OAuth via config).
try {
  const envText = readFileSync('.env', 'utf-8');
  for (const line of envText.split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!;
  }
} catch { /* no .env */ }

const DEFAULT_PROBE = [
  'Find any vault note titled or about "sprite 0" (or "sprite zero").',
  '',
  'Search the vault by semantic query, by filename glob, and by full-text rg.',
  'If you find candidates, read the most promising one and report what it contains.',
  'If you find nothing, tell me what you searched and what you saw.',
].join('\n');

const DEFAULT_MAX_TURNS = 20;

interface RunMetrics {
  effort: EffortLevel;
  replCalls: number;
  cellsTotal: number;
  cellsPerCall: number;     // mean
  cellsMaxInCall: number;   // largest single batch
  toolCallsTotal: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** Count of thinking deltas streamed back. Proxy for "did adaptive
   *  thinking actually fire" — low effort should drop this near zero. */
  thinkingEvents: number;
  /** Approx total chars of thinking content streamed. */
  thinkingChars: number;
  // ── Script-shape metrics (per-cell averages across all code calls) ──
  // The question these answer: is the agent writing programs in cells, or
  // is each cell just one primitive call dressed up as a notebook entry?
  /** Total non-comment, non-blank statements across all cells. */
  totalStatements: number;
  /** Mean statements per cell. >1 suggests programs; ≈1 suggests one-liners. */
  meanStatementsPerCell: number;
  /** Cells with control flow (if / for / while / def / try / comprehension). */
  cellsWithControlFlow: number;
  /** Total primitive calls across all cells (vault.*, codebase.*, fs.*, shell.*, web.*, rlm_*, say/ask/done/print/display). */
  primitiveCallsTotal: number;
  /** Mean primitive calls per cell. The "operations density" we actually care about. */
  primitiveCallsPerCell: number;
  /** Smart primitive calls (codebase.search, find_symbol, get_file_summary, get_context, show_dependents, show_dependencies, find_convention). */
  smartPrimitiveCalls: number;
  /** Dumb primitive calls (fs.read, fs.glob, fs.rgrep, fs.tree, fs.listdir, shell.run). */
  dumbPrimitiveCalls: number;
  wallMs: number;
  turns: number;
  finalTextChars: number;
  hitTurnCap: boolean;
  error?: string;
}

const SMART_PRIMITIVES = [
  'codebase.search',
  'codebase.find_symbol',
  'codebase.get_file_summary',
  'codebase.get_context',
  'codebase.show_dependents',
  'codebase.show_dependencies',
  'codebase.find_convention',
  'codebase.find_similar_patterns',
  'codebase.suggest_location',
  'codebase.detect_duplication',
  'codebase.trace_path',
  'vault.top',
  'vault.explore',
  'vault.query_ranked',
  'vault.query_similar',
  'vault.query_warmth',
  'vault.query_important',
  'vault.query_fading',
  'vault.read',
  'vault.get_note',
  'vault.neighbors',
  'vault.backlinks',
  'rlm_call',
  'rlm_batch',
];

const DUMB_PRIMITIVES = [
  'fs.read',
  'fs.glob',
  'fs.rgrep',
  'fs.grep',
  'fs.tree',
  'fs.listdir',
  'shell.run',
];

const ANY_PRIMITIVE = [
  ...SMART_PRIMITIVES,
  ...DUMB_PRIMITIVES,
  'fs.write', 'fs.edit', 'fs.patch',
  'web.read', 'web.fetch', 'web.search',
  'codebase.map', 'codebase.list_files', 'codebase.stats',
  'vault.add', 'vault.orient', 'vault.status',
  'say', 'ask', 'done', 'print', 'display', 'reindex',
];

/**
 * Cell shape stats from a single cell's code body.
 * Detected via simple regex — not a full AST parse, but enough to tell
 * "for h in hits: print(h)" from "vault.top('foo')". Strips strings and
 * comments first to avoid false positives on code-in-string-literals.
 */
function analyzeCell(code: string): {
  statements: number;
  hasControlFlow: boolean;
  primitiveCalls: number;
  smartCalls: number;
  dumbCalls: number;
} {
  // Strip Python strings + comments to avoid matching keywords/primitive
  // names inside string literals (false positives).
  const blank = (m: string) => m.replace(/[^\n]/g, ' ');
  const stripped = code
    .replace(/"""[\s\S]*?"""/g, blank)
    .replace(/'''[\s\S]*?'''/g, blank)
    .replace(/"(?:\\.|[^"\\\n])*"/g, blank)
    .replace(/'(?:\\.|[^'\\\n])*'/g, blank)
    .replace(/#[^\n]*/g, blank);

  // Count non-blank, non-comment lines as a proxy for statement count.
  // Could miss multi-line continuations or undercount semicolon-separated
  // statements, but find-note tasks rarely use either.
  const lines = stripped.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  const statements = lines.length;

  const hasControlFlow =
    /^\s*(?:for|while|if|elif|else|def|try|except|finally|with)\b/m.test(stripped) ||
    /\bfor\s+\w+\s+in\b/.test(stripped) || // comprehensions
    /\[[^\]]*\bfor\s+\w+\s+in\b/.test(stripped);

  let primitiveCalls = 0;
  let smartCalls = 0;
  let dumbCalls = 0;

  // Count occurrences of each primitive — escape dots so regex is literal.
  const countOccurrences = (needle: string) => {
    const escaped = needle.replace(/\./g, '\\.');
    // Bare-name primitives (say/ask/done/print/display) must not match
    // method names; require word boundary on both sides.
    const pat = needle.includes('.')
      ? new RegExp(escaped + '\\s*\\(', 'g')
      : new RegExp('\\b' + escaped + '\\s*\\(', 'g');
    const m = stripped.match(pat);
    return m?.length ?? 0;
  };

  for (const p of ANY_PRIMITIVE) primitiveCalls += countOccurrences(p);
  for (const p of SMART_PRIMITIVES) smartCalls += countOccurrences(p);
  for (const p of DUMB_PRIMITIVES) dumbCalls += countOccurrences(p);

  return { statements, hasControlFlow, primitiveCalls, smartCalls, dumbCalls };
}

/**
 * Parse code field into cell bodies and analyze each.
 */
function analyzeAllCells(code: string | undefined): {
  cellCount: number;
  totalStatements: number;
  cellsWithControlFlow: number;
  primitiveCallsTotal: number;
  smartCalls: number;
  dumbCalls: number;
} {
  if (!code) {
    return { cellCount: 0, totalStatements: 0, cellsWithControlFlow: 0, primitiveCallsTotal: 0, smartCalls: 0, dumbCalls: 0 };
  }
  // Split on fence openers, drop the first element (text before first fence).
  // Each subsequent chunk: <metadata>\n<body>\n``` ... — strip the closing fence.
  const parts = code.split(/^```(?:py|python|js|javascript|ts|typescript)\b[^\n]*\n/gm).slice(1);
  const cells = parts.map(p => p.replace(/```\s*$/m, ''));
  let totalStatements = 0;
  let cellsWithControlFlow = 0;
  let primitiveCallsTotal = 0;
  let smartCalls = 0;
  let dumbCalls = 0;
  for (const body of cells) {
    const r = analyzeCell(body);
    totalStatements += r.statements;
    if (r.hasControlFlow) cellsWithControlFlow++;
    primitiveCallsTotal += r.primitiveCalls;
    smartCalls += r.smartCalls;
    dumbCalls += r.dumbCalls;
  }
  return {
    cellCount: cells.length,
    totalStatements,
    cellsWithControlFlow,
    primitiveCallsTotal,
    smartCalls,
    dumbCalls,
  };
}

/**
 * Count cells from a code call's input.code field.
 *
 * Cells are markdown-fenced blocks: ```py id="..." ... ```. We count fence
 * openers (lines starting with ```py or ```python). Crude but matches what
 * cellParser.ts does at parse time and is independent of body execution.
 */
function countCells(code: string | undefined): number {
  if (!code) return 0;
  const matches = code.match(/^```(?:py|python|js|javascript|ts|typescript)\b/gm);
  return matches?.length ?? 0;
}

async function runEffort(
  effort: EffortLevel,
  model: string,
  task: string,
  cwd: string,
  maxTurns: number,
  verbose: boolean,
): Promise<RunMetrics> {
  const m: RunMetrics = {
    effort,
    replCalls: 0, cellsTotal: 0, cellsPerCall: 0, cellsMaxInCall: 0,
    toolCallsTotal: 0,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
    thinkingEvents: 0, thinkingChars: 0,
    totalStatements: 0, meanStatementsPerCell: 0,
    cellsWithControlFlow: 0,
    primitiveCallsTotal: 0, primitiveCallsPerCell: 0,
    smartPrimitiveCalls: 0, dumbPrimitiveCalls: 0,
    wallMs: 0, turns: 0, finalTextChars: 0, hitTurnCap: false,
  };

  // Reload config per run so state is clean (router caches effort, etc).
  const config = loadConfig(cwd);
  const router = new ModelRouter(config.models, config.experimental);
  router.setModel(model);
  router.setEffort(effort);

  const registry = createCoreRegistry();
  let replHandle: Awaited<ReturnType<typeof setupReplBridge>> = null;

  try {
    replHandle = await setupReplBridge({
      config: { ...config.repl, enabled: true },
      cwd,
      rlmModel: router.info.model,
    });
    if (!replHandle) throw new Error('code bridge failed');
    registerCodeTool(registry, () => replHandle);

    const systemPrompt = buildSystemPrompt({
      cwd,
      config,
      replEnabled: true,
    });

    const session = new SessionStorage(cwd);
    const messages: Message[] = [{ role: 'user', content: task }];
    const cellsPerReplCall: number[] = [];
    let finalText = '';
    const start = Date.now();

    for await (const event of agentLoop({
      messages,
      systemPrompt,
      router,
      registry,
      toolContext: { cwd },
      vault: null,
      projectBrain: null,
      session,
      hooks: {},
      permissionMode: 'yolo' as const,
      maxTurns,
    })) {
      if (event.type === 'model_start') m.turns++;
      if (event.type === 'text') finalText += event.content;
      if (event.type === 'thinking') {
        m.thinkingEvents++;
        m.thinkingChars += event.content?.length ?? 0;
      }
      if (event.type === 'tool_call') {
        m.toolCallsTotal++;
        if (event.toolCall.name === 'code') {
          m.replCalls++;
          const code = (event.toolCall.input as { code?: string })?.code;
          const shape = analyzeAllCells(code);
          cellsPerReplCall.push(shape.cellCount);
          m.cellsTotal += shape.cellCount;
          if (shape.cellCount > m.cellsMaxInCall) m.cellsMaxInCall = shape.cellCount;
          m.totalStatements += shape.totalStatements;
          m.cellsWithControlFlow += shape.cellsWithControlFlow;
          m.primitiveCallsTotal += shape.primitiveCallsTotal;
          m.smartPrimitiveCalls += shape.smartCalls;
          m.dumbPrimitiveCalls += shape.dumbCalls;
          if (verbose) {
            console.log(
              `    [${effort}] code call ${m.replCalls}: ${shape.cellCount} cells, ` +
              `${shape.totalStatements} stmts, ${shape.primitiveCallsTotal} prim ` +
              `(${shape.smartCalls}s/${shape.dumbCalls}d), ctrl-flow ${shape.cellsWithControlFlow}`
            );
          }
        }
      }
      if (event.type === 'usage') {
        m.inputTokens += event.inputTokens ?? 0;
        m.outputTokens += event.outputTokens ?? 0;
        m.cacheReadTokens += event.cacheReadTokens ?? 0;
      }
      if (event.type === 'error') {
        m.error = event.error instanceof Error ? event.error.message : String(event.error);
        break;
      }
    }
    if (m.turns >= maxTurns && !m.error) {
      m.hitTurnCap = true;
    }

    m.wallMs = Date.now() - start;
    m.finalTextChars = finalText.length;
    m.cellsPerCall = m.replCalls > 0 ? m.cellsTotal / m.replCalls : 0;
    m.meanStatementsPerCell = m.cellsTotal > 0 ? m.totalStatements / m.cellsTotal : 0;
    m.primitiveCallsPerCell = m.cellsTotal > 0 ? m.primitiveCallsTotal / m.cellsTotal : 0;
  } catch (err) {
    m.error = err instanceof Error ? err.message : String(err);
  } finally {
    if (replHandle) await replHandle.shutdown();
  }

  return m;
}

async function main() {
  const args = process.argv.slice(2);
  // Default to 'primary' so the bench picks up the user's configured auth
  // (oauth for Sonnet 4.6 via Max plan, etc.). The 'sonnet' shortcut defaults
  // to api_key auth and 401s when ANTHROPIC_API_KEY is unset.
  let modelInput = 'primary';
  let efforts: EffortLevel[] = ['low', 'medium', 'high', 'max'];
  let task = DEFAULT_PROBE;
  let verbose = false;
  let maxTurns = DEFAULT_MAX_TURNS;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--model') modelInput = args[++i]!;
    if (args[i] === '--efforts') {
      const list = (args[++i] ?? '').split(',').map(s => s.trim()) as EffortLevel[];
      const allowed: EffortLevel[] = ['low', 'medium', 'high', 'max'];
      efforts = list.filter(e => allowed.includes(e));
      if (efforts.length === 0) {
        console.error('No valid efforts specified.');
        process.exit(1);
      }
    }
    if (args[i] === '--task') task = args[++i]!;
    if (args[i] === '--max-turns') maxTurns = parseInt(args[++i]!, 10);
    if (args[i] === '--verbose' || args[i] === '-v') verbose = true;
  }

  console.log('='.repeat(72));
  console.log('Effort A/B grid — composition-shape probe');
  console.log('='.repeat(72));
  console.log(`Model:   ${modelInput}`);
  console.log(`Efforts: ${efforts.join(', ')}`);
  console.log(`Task:    ${task.split('\n')[0]!.slice(0, 60)}...`);
  console.log('');

  const results: RunMetrics[] = [];
  for (const effort of efforts) {
    process.stdout.write(`[${new Date().toISOString().slice(11, 19)}] effort=${effort}... `);
    const m = await runEffort(effort, modelInput, task, process.cwd(), maxTurns, verbose);
    results.push(m);
    if (verbose) process.stdout.write('  ');
    if (m.error) {
      console.log(`ERROR: ${m.error}`);
    } else {
      const cap = m.hitTurnCap ? ' [HIT-CAP]' : '';
      console.log(
        `repl=${m.replCalls} cells=${m.cellsTotal} (${m.cellsPerCall.toFixed(1)}/c) ` +
        `stmts=${m.totalStatements} (${m.meanStatementsPerCell.toFixed(1)}/c) ` +
        `prim=${m.primitiveCallsTotal} (${m.smartPrimitiveCalls}s/${m.dumbPrimitiveCalls}d) ` +
        `cf=${m.cellsWithControlFlow}c ` +
        `turns=${m.turns}${cap} think=${m.thinkingEvents}ev ` +
        `wall=${(m.wallMs/1000).toFixed(1)}s`
      );
    }
  }

  // ── Summary table ────────────────────────────────────────────────────
  console.log('');
  console.log('='.repeat(72));
  console.log('SUMMARY');
  console.log('='.repeat(72));
  const hdr = 'effort   repl  cells  c/c  stmt  s/c  prim  p/c  smart  dumb  cf  turns  think  wall_s';
  console.log(hdr);
  console.log('-'.repeat(hdr.length));
  for (const r of results) {
    if (r.error) {
      console.log(`${r.effort.padEnd(7)}  ERROR: ${r.error.slice(0, 60)}`);
      continue;
    }
    console.log(
      `${r.effort.padEnd(7)} ${String(r.replCalls).padStart(4)} ${String(r.cellsTotal).padStart(6)} ` +
      `${r.cellsPerCall.toFixed(1).padStart(4)} ` +
      `${String(r.totalStatements).padStart(5)} ${r.meanStatementsPerCell.toFixed(1).padStart(4)} ` +
      `${String(r.primitiveCallsTotal).padStart(5)} ${r.primitiveCallsPerCell.toFixed(1).padStart(4)} ` +
      `${String(r.smartPrimitiveCalls).padStart(5)} ${String(r.dumbPrimitiveCalls).padStart(5)} ` +
      `${String(r.cellsWithControlFlow).padStart(3)} ` +
      `${String(r.turns).padStart(6)} ${String(r.thinkingEvents).padStart(5)} ` +
      `${(r.wallMs/1000).toFixed(1).padStart(7)}`
    );
  }
  // Quick legend so columns are readable.
  console.log('');
  console.log('  c/c=cells per call · stmt=total stmts · s/c=stmts per cell');
  console.log('  prim=primitive calls · p/c=primitives per cell');
  console.log('  smart=codebase.*/vault.* · dumb=fs.read/rg/shell.run · cf=cells with control flow');

  // ── Composition-density delta ────────────────────────────────────────
  console.log('');
  const valid = results.filter(r => !r.error);
  if (valid.length >= 2) {
    const baseline = valid.find(r => r.effort === 'high') ?? valid[valid.length - 1]!;
    console.log(`Composition density vs effort=${baseline.effort}:`);
    for (const r of valid) {
      if (r.effort === baseline.effort) continue;
      const replDelta = baseline.replCalls > 0
        ? ((r.replCalls - baseline.replCalls) / baseline.replCalls) * 100
        : 0;
      const cellsDelta = baseline.cellsPerCall > 0
        ? ((r.cellsPerCall - baseline.cellsPerCall) / baseline.cellsPerCall) * 100
        : 0;
      const sign = (n: number) => n >= 0 ? `+${n.toFixed(0)}%` : `${n.toFixed(0)}%`;
      console.log(`  ${r.effort.padEnd(7)}  code calls ${sign(replDelta)}   cells/call ${sign(cellsDelta)}`);
    }
  }

  // Persist for follow-up.
  try {
    const dir = join('bench', 'results');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const path = join(dir, `effort-grid-${modelInput}-${Date.now()}.json`);
    writeFileSync(path, JSON.stringify({ model: modelInput, task, results }, null, 2));
    console.log('');
    console.log(`Saved: ${path}`);
  } catch { /* non-fatal */ }
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
