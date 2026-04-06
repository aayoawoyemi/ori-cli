/**
 * Quick benchmark â€” bare tool-calling vs Ori harness on one multi-file refactor.
 *
 * Task: rename `tickTurn` to `advanceTurn` across the codebase.
 *   - Definition in src/memory/warmContext.ts
 *   - Callers in src/loop.ts (+ anywhere else)
 *   - All references must update; behavior identical.
 *
 * Why this task: multi-file coordinated edit. Blast-radius awareness is the
 * harness's thesis. Bare tool-calling must grep â†’ read each file â†’ edit each.
 * REPL harness can do `codebase.find_symbol('tickTurn')` + `show_dependents`
 * in one call, then edit deterministically.
 *
 * Variants:
 *   BARE     â€” legacy tools only (Read/Glob/Grep/Edit/Write), no REPL, no signatures
 *   HARNESS  â€” REPL mandatory, codebase signature, Phase 8 tools available
 *
 * Runs: 3 per (variant). Total: 6 runs.
 *
 * Usage:
 *   DASHSCOPE_API_KEY=... npx tsx bench/quick.ts
 *   DASHSCOPE_API_KEY=... npx tsx bench/quick.ts --model deepseek
 *   DASHSCOPE_API_KEY=... npx tsx bench/quick.ts --runs 5
 */
import {
  mkdtempSync, cpSync, rmSync, existsSync, readFileSync, writeFileSync,
  mkdirSync, symlinkSync,
} from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelRouter } from '../src/router/index.js';
import {
  createCoreRegistry, registerReplTool, stripNavigationTools,
} from '../src/tools/registry.js';
import { buildSystemPrompt } from '../src/prompt.js';
import { SessionStorage } from '../src/session/storage.js';
import { agentLoop } from '../src/loop.js';
import { setupReplBridge } from '../src/repl/setup.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';
import { loadConfig } from '../src/config/load.js';
import type { Message } from '../src/router/types.js';
import type { AriesConfig } from '../src/config/types.js';

// -------- Post-run quality checks --------

// Baseline tsc errors in the original codebase (pre-existing, not caused by model edits).
// Cached on first call.
let _baselineTypeErrors = -1;
function getBaselineTypeErrors(workspace: string): number {
  if (_baselineTypeErrors >= 0) return _baselineTypeErrors;
  try {
    execSync('npx tsc --noEmit 2>&1', { cwd: workspace, encoding: 'utf-8', timeout: 30_000 });
    _baselineTypeErrors = 0;
  } catch (err) {
    const output = (err as { stdout?: string }).stdout ?? '';
    _baselineTypeErrors = (output.match(/error TS\d+/g) || []).length;
  }
  return _baselineTypeErrors;
}

function runTypecheck(workspace: string): { passed: boolean; errorCount: number; newErrors: number } {
  const baseline = getBaselineTypeErrors(workspace);
  try {
    execSync('npx tsc --noEmit 2>&1', { cwd: workspace, encoding: 'utf-8', timeout: 30_000 });
    return { passed: true, errorCount: 0, newErrors: 0 };
  } catch (err) {
    const output = (err as { stdout?: string }).stdout ?? '';
    const errorCount = (output.match(/error TS\d+/g) || []).length;
    const newErrors = Math.max(0, errorCount - baseline);
    return { passed: newErrors === 0, errorCount, newErrors };
  }
}

async function runJudge(
  task: TaskSpec,
  workspace: string,
  modelInput: string,
): Promise<{ score: number; rationale: string }> {
  // Collect the diff: what changed vs original
  let diff = '';
  try {
    // Compare key files against originals by reading both
    const keyFiles = ['src/memory/warmContext.ts', 'src/loop.ts'];
    for (const f of keyFiles) {
      const wsPath = join(workspace, f);
      if (existsSync(wsPath)) {
        diff += `=== ${f} ===\n${readFileSync(wsPath, 'utf-8').slice(0, 3000)}\n\n`;
      }
    }
  } catch { /* skip */ }

  if (!diff) return { score: 50, rationale: 'no diff to judge' };

  // Use a cheap model for judging â€” prefer deepseek (cheapest available)
  const judgeRouter = new ModelRouter(DEFAULT_CONFIG.models, DEFAULT_CONFIG.experimental);
  const judgeCandidates = ['deepseek', 'qwen3.6', 'flash', modelInput];
  let judgeReady = false;
  for (const jm of judgeCandidates) {
    try {
      judgeRouter.setModel(jm);
      judgeReady = true;
      break;
    } catch { /* next */ }
  }
  if (!judgeReady) return { score: 50, rationale: 'no judge model available' };

  const judgePrompt = `You are a code quality judge. Rate the following code change on a scale of 0-100.

TASK: ${task.title}
REQUIREMENTS: ${task.prompt}

CODE STATE AFTER CHANGES:
${diff.slice(0, 6000)}

Rate on these criteria:
- Completeness: Did the rename happen everywhere? (40 points)
- Correctness: No broken syntax, no typos, no accidental changes? (30 points)
- Cleanliness: No unnecessary changes, no collateral damage? (30 points)

Respond with ONLY a JSON object: {"score": <0-100>, "rationale": "<one sentence>"}`;

  try {
    let judgeText = '';
    for await (const event of judgeRouter.stream(
      [{ role: 'user', content: judgePrompt }],
      'You are a code reviewer. Respond only with JSON.',
      [],
      { maxTokens: 200 },
    )) {
      if (event.type === 'text') judgeText += event.text;
    }
    // Extract JSON from response
    const jsonMatch = judgeText.match(/\{[\s\S]*?"score"\s*:\s*(\d+)[\s\S]*?"rationale"\s*:\s*"([^"]*)"[\s\S]*?\}/);
    if (jsonMatch) {
      return { score: parseInt(jsonMatch[1]!, 10), rationale: jsonMatch[2]! };
    }
    return { score: 50, rationale: `parse failed: ${judgeText.slice(0, 100)}` };
  } catch (err) {
    return { score: 50, rationale: `judge error: ${(err as Error).message.slice(0, 80)}` };
  }
}

const MAX_TURNS = 15;

// Load .env
try {
  const envText = readFileSync('.env', 'utf-8');
  for (const line of envText.split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!;
  }
} catch { /* no .env */ }

// -------- Task --------
interface TaskSpec {
  id: string;
  title: string;
  prompt: string;
  validate: (workspace: string, finalText: string, error?: string) => {
    passed: boolean;
    reason: string;
  };
}

const TASKS: TaskSpec[] = [
  {
    id: 'rename',
    title: 'Rename tickTurn â†’ advanceTurn across codebase',
    prompt: [
      'Rename the function `tickTurn` to `advanceTurn` across the entire codebase.',
      '',
      'Requirements:',
      '- Update the definition in src/memory/warmContext.ts (and its export).',
      '- Update ALL callers wherever they appear.',
      '- Preserve the behavior exactly. Only the name changes.',
      '- Do not touch unrelated code.',
      '',
      'When done, briefly confirm which files you edited.',
    ].join('\n'),
    validate: (workspace, _finalText, error) => {
      if (error) return { passed: false, reason: `error: ${error.slice(0, 80)}` };
      const wc = join(workspace, 'src', 'memory', 'warmContext.ts');
      const loop = join(workspace, 'src', 'loop.ts');
      if (!existsSync(wc)) return { passed: false, reason: 'warmContext.ts missing' };
      if (!existsSync(loop)) return { passed: false, reason: 'loop.ts missing' };
      const wcBody = readFileSync(wc, 'utf-8');
      const loopBody = readFileSync(loop, 'utf-8');
      if (!/export function advanceTurn/.test(wcBody)) {
        return { passed: false, reason: 'warmContext.ts: advanceTurn not exported' };
      }
      if (/\btickTurn\b/.test(wcBody)) {
        return { passed: false, reason: 'warmContext.ts still has tickTurn' };
      }
      if (/\btickTurn\b/.test(loopBody)) {
        return { passed: false, reason: 'loop.ts still has tickTurn' };
      }
      if (!/advanceTurn\s*\(/.test(loopBody)) {
        return { passed: false, reason: 'loop.ts does not call advanceTurn()' };
      }
      return { passed: true, reason: 'ok' };
    },
  },
  {
    id: 'explore',
    title: 'Trace the permission flow',
    prompt: [
      'Trace the permission flow in this codebase.',
      '',
      'Explain the complete path from the moment a user chooses a permission mode in the UI',
      'to where that mode actually gates tool execution in the agent loop.',
      '',
      'Your answer should:',
      '- Name the key files involved, in order',
      '- Identify where permissionMode is set and where it is read',
      '- Describe the 3 or 4 permission modes and their behaviors',
      '- List any dialogs or confirmation steps',
      '',
      'Be concrete. Reference file paths and variable names.',
    ].join('\n'),
    validate: (_workspace, finalText, error) => {
      if (error) return { passed: false, reason: `error: ${error.slice(0, 80)}` };
      if (!finalText || finalText.length < 200) {
        return { passed: false, reason: `answer too short (${finalText.length} chars)` };
      }
      // Heuristic scoring: answer must mention key concepts
      const t = finalText.toLowerCase();
      const checks = [
        { key: 'permissionMode', match: /permissionmode/i.test(finalText) },
        { key: 'loop|agentLoop', match: /loop\.ts|agentloop/i.test(finalText) },
        { key: 'registry|tool', match: /registry|tool.*(call|exec)/i.test(finalText) },
        { key: 'mode names', match: /(yolo|accept|plan|default).*(yolo|accept|plan|default)/i.test(finalText) },
        { key: 'ui|app.tsx', match: /app\.tsx|ui\/|keystroke|shortcut|alt\+m/i.test(t) },
      ];
      const hits = checks.filter(c => c.match).length;
      if (hits < 4) {
        const missing = checks.filter(c => !c.match).map(c => c.key).join(', ');
        return { passed: false, reason: `${hits}/5 concepts, missing: ${missing}` };
      }
      return { passed: true, reason: `${hits}/5 concepts covered` };
    },
  },
];

// -------- Workspace --------
function copyWorkspace(repoRoot: string): string {
  const dest = mkdtempSync(join(tmpdir(), 'quick-bench-'));
  cpSync(repoRoot, dest, {
    recursive: true,
    filter: (src) => {
      const norm = src.replace(/\\/g, '/');
      if (norm.includes('/node_modules/')) return false;
      if (norm.includes('/.git/')) return false;
      if (norm.includes('/dist/')) return false;
      if (norm.includes('/.aries/sessions/')) return false;
      if (norm.includes('/body/__pycache__/')) return false;
      if (norm.includes('/bench/results/')) return false;
      return true;
    },
  });
  // Symlink node_modules for typecheck (avoids copying ~200MB)
  const nmSrc = join(repoRoot, 'node_modules');
  const nmDst = join(dest, 'node_modules');
  if (existsSync(nmSrc) && !existsSync(nmDst)) {
    try {
      // junction doesn't need admin on Windows
      execSync(`mklink /J "${nmDst}" "${nmSrc}"`, { stdio: 'ignore', shell: 'cmd.exe' });
    } catch { /* skip if fails */ }
  }
  return dest;
}

// -------- Variants --------
interface VariantSpec {
  id: 'BARE' | 'HARNESS-STRICT';
  useRepl: boolean;
  stripLegacyNav: boolean;
  includeSignatures: boolean;
}
const VARIANTS: VariantSpec[] = [
  { id: 'BARE',            useRepl: false, stripLegacyNav: false, includeSignatures: false },
  { id: 'HARNESS-STRICT',  useRepl: true,  stripLegacyNav: true,  includeSignatures: true  },
  // To run just HARNESS-STRICT (budget-patched prompt): npx tsx bench/quick.ts --variant HARNESS-STRICT
];

// -------- Metrics --------
interface RunMetrics {
  variant: string;
  task: string;
  run: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  toolBreakdown: Record<string, number>;
  wallMs: number;
  success: boolean;
  reason: string;
  error?: string;
  typecheckPassed?: boolean;
  typecheckErrors?: number;
  judgeScore?: number;      // 0-100
  judgeRationale?: string;
}

async function runVariant(
  variant: VariantSpec,
  task: TaskSpec,
  run: number,
  config: AriesConfig,
  modelInput: string,
  repoRoot: string,
  verbose: boolean = false,
): Promise<RunMetrics> {
  const workspace = copyWorkspace(repoRoot);
  const m: RunMetrics = {
    variant: variant.id, task: task.id, run,
    turns: 0, inputTokens: 0, outputTokens: 0,
    toolCalls: 0, toolBreakdown: {},
    wallMs: 0, success: false, reason: '',
  };

  const router = new ModelRouter(config.models, config.experimental);
  const registry = createCoreRegistry();
  let replHandle = null;
  let codebaseSignatureMd: string | undefined;

  try {
    router.setModel(modelInput);

    if (variant.useRepl) {
      replHandle = await setupReplBridge({
        config: config.repl,
        cwd: workspace,
        anthropicApiKey: process.env.ANTHROPIC_API_KEY,
        rlmModel: router.info.model,
      });
      if (!replHandle) throw new Error('REPL bridge failed');
      registerReplTool(registry, () => replHandle);
      if (variant.stripLegacyNav) {
        stripNavigationTools(registry);
        // STRICT: also remove Bash â€” the escape hatch Qwen was using.
        // Edit/Write remain (model needs them; Repl can't write files).
        (registry as any).tools.delete('Bash');
      }

      if (variant.includeSignatures) {
        const idx = await replHandle.bridge.index({ repoPath: workspace });
        if (idx.ok) {
          const sig = await replHandle.bridge.codebaseSignature(
            config.signature.codebase.level,
            config.signature.codebase.maxTokens,
          );
          if (!('error' in sig) || !sig.error) {
            codebaseSignatureMd = sig.markdown;
          }
        }
      }
    }

    const systemPrompt = buildSystemPrompt({
      cwd: workspace,
      config,
      codebaseSignature: codebaseSignatureMd,
      replEnabled: variant.useRepl,
    });

    const session = new SessionStorage(workspace);
    const messages: Message[] = [{ role: 'user', content: task.prompt }];

    const start = Date.now();
    let finalText = '';
    let turnInTok = 0, turnOutTok = 0;
    let turnTools: string[] = [];
    let activeToolCount = 0;

    // Post-edit refresh callback: keep codebase graph current after mutations
    const onFileMutated = replHandle
      ? async (paths: string[]) => {
          // Convert absolute paths to relative for the codebase graph
          const relPaths = paths.map(p => {
            const abs = p.startsWith('/') || p.includes(':\\') ? p : join(workspace, p);
            return abs.replace(workspace.replace(/\\/g, '/') + '/', '')
              .replace(workspace.replace(/\//g, '\\') + '\\', '')
              .replace(/\\/g, '/');
          });
          await replHandle!.bridge.refreshFiles(relPaths, workspace);
        }
      : undefined;

    for await (const event of agentLoop({
      messages, systemPrompt, router, registry,
      toolContext: { cwd: workspace },
      vault: null, projectBrain: null, session, hooks: {},
      permissionMode: 'yolo' as const, maxTurns: MAX_TURNS,
      onFileMutated,
      dynamicTools: variant.useRepl,
    })) {
      if (event.type === 'model_start') {
        // Flush previous turn summary before incrementing
        if (verbose && m.turns > 0) {
          const toolsStr = turnTools.length ? turnTools.join(',') : '-';
          // Estimate tool schema tokens: ~100 tokens per tool definition
          const schemaTokens = activeToolCount * 100;
          console.log(`    t${m.turns}: in=${turnInTok} out=${turnOutTok} cum=${m.inputTokens + m.outputTokens} tools=[${toolsStr}] schemas=${activeToolCount}(~${schemaTokens}tok)`);
        }
        turnInTok = 0; turnOutTok = 0; turnTools = [];
        // Estimate active tool count for this variant
        activeToolCount = variant.useRepl ? 1 : 9; // REPL phase starts with 1 tool; bare has all
        m.turns++;
      }
      if (event.type === 'text') finalText += event.content;
      if (event.type === 'tool_call') {
        m.toolCalls++;
        const n = event.toolCall.name;
        m.toolBreakdown[n] = (m.toolBreakdown[n] ?? 0) + 1;
        turnTools.push(n);
      }
      if (event.type === 'usage') {
        const inT = event.inputTokens ?? 0;
        const outT = event.outputTokens ?? 0;
        m.inputTokens += inT;
        m.outputTokens += outT;
        turnInTok += inT;
        turnOutTok += outT;
      }
      if (event.type === 'error') {
        m.error = event.error instanceof Error ? event.error.message : String(event.error);
        break;
      }
    }
    // Final turn flush
    if (verbose && m.turns > 0) {
      const toolsStr = turnTools.length ? turnTools.join(',') : '-';
      const schemaTokens = activeToolCount * 100;
      console.log(`    t${m.turns}: in=${turnInTok} out=${turnOutTok} cum=${m.inputTokens + m.outputTokens} tools=[${toolsStr}] schemas=${activeToolCount}(~${schemaTokens}tok)`);
    }
    m.wallMs = Date.now() - start;
    const result = task.validate(workspace, finalText, m.error);
    m.success = result.passed;
    m.reason = result.reason;

    // Post-run quality: typecheck
    if (m.success && task.id !== 'explore') {
      const tc = runTypecheck(workspace);
      m.typecheckPassed = tc.passed;
      m.typecheckErrors = tc.errorCount;
    }

    // Save diff for post-hoc judging
    if (task.id !== 'explore') {
      try {
        const diffDir = join('bench', 'results', 'diffs');
        if (!existsSync(diffDir)) { mkdirSync(diffDir, { recursive: true }); }
        const keyFiles = ['src/memory/warmContext.ts', 'src/loop.ts'];
        let diffContent = `# ${variant.id} run ${run} â€” ${m.success ? 'PASS' : 'FAIL'} (${m.reason})\n`;
        diffContent += `# turns=${m.turns} tokens=${m.inputTokens + m.outputTokens} wall=${(m.wallMs/1000).toFixed(1)}s\n\n`;
        for (const f of keyFiles) {
          const wsPath = join(workspace, f);
          if (existsSync(wsPath)) {
            diffContent += `=== ${f} ===\n${readFileSync(wsPath, 'utf-8')}\n\n`;
          }
        }
        writeFileSync(
          join(diffDir, `${task.id}-${variant.id}-run${run}-${modelInput}.md`),
          diffContent,
        );
      } catch { /* non-fatal */ }
    }
  } catch (err) {
    m.error = (err as Error).message;
    m.reason = `exception: ${m.error.slice(0, 60)}`;
  } finally {
    if (replHandle) await replHandle.shutdown();
    // Remove node_modules junction before recursive delete (Windows EBUSY)
    try {
      const nmJunction = join(workspace, 'node_modules');
      if (existsSync(nmJunction)) {
        execSync(`rmdir "${nmJunction}"`, { stdio: 'ignore', shell: 'cmd.exe' });
      }
    } catch { /* skip */ }
    rmSync(workspace, { recursive: true, force: true });
  }

  return m;
}

// -------- Stats --------
function summarize(nums: number[]): { mean: number; median: number } {
  if (nums.length === 0) return { mean: 0, median: 0 };
  const sorted = [...nums].sort((a, b) => a - b);
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  const median = sorted.length % 2 === 0
    ? (sorted[sorted.length/2 - 1]! + sorted[sorted.length/2]!) / 2
    : sorted[Math.floor(sorted.length/2)]!;
  return { mean, median };
}

// -------- Main --------
async function main() {
  const args = process.argv.slice(2);
  let modelInput = 'qwen3.6';
  let runs = 3;
  let verbose = false;
  let variantFilter: string | undefined;
  let taskFilter: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--model') modelInput = args[++i]!;
    if (args[i] === '--runs') runs = Number(args[++i]);
    if (args[i] === '--verbose' || args[i] === '-v') verbose = true;
    if (args[i] === '--variant') variantFilter = args[++i]!;
    if (args[i] === '--task') taskFilter = args[++i]!;
  }

  // Load user config (picks up auth: oauth + experimental flags from ~/.aries/config.yaml)
  const loaded = loadConfig(process.cwd());
  const config: AriesConfig = {
    ...loaded,
    repl: { ...loaded.repl, enabled: true },
  };
  const repoRoot = process.cwd();

  console.log('='.repeat(72));
  console.log('Quick bench â€” bare tool-calling vs Ori harness (strict)');
  console.log('='.repeat(72));
  console.log(`Tasks: ${TASKS.map(t => t.id).join(', ')}`);
  console.log(`Model: ${modelInput}`);
  console.log(`Runs per (variant, task): ${runs}`);
  console.log(`Variants: ${VARIANTS.map(v => v.id).join(', ')}`);
  console.log(`HARNESS-STRICT strips: Read, Grep, Glob, Bash (leaves Edit, Write, Repl)`);
  console.log('');

  const activeTasks = taskFilter ? TASKS.filter(t => t.id === taskFilter) : TASKS;
  const activeVariants = variantFilter ? VARIANTS.filter(v => v.id === variantFilter) : VARIANTS;

  const results: RunMetrics[] = [];
  for (const task of activeTasks) {
    console.log(`--- Task: ${task.id} (${task.title}) ---`);
    for (const variant of activeVariants) {
      for (let r = 1; r <= runs; r++) {
        const started = new Date().toISOString().slice(11, 19);
        process.stdout.write(`[${started}] ${variant.id} run ${r}/${runs}...${verbose ? '\n' : ' '}`);
        const m = await runVariant(variant, task, r, config, modelInput, repoRoot, verbose);
        results.push(m);
        if (verbose) process.stdout.write('  ');
        const dur = (m.wallMs / 1000).toFixed(1);
        const status = m.success ? 'PASS' : 'FAIL';
        console.log(`${status} Â· turns=${m.turns} Â· tools=${m.toolCalls} Â· tok=${m.inputTokens + m.outputTokens} Â· ${dur}s Â· ${m.reason}`);
      }
    }
    console.log('');
  }

  // Per-task summary
  console.log('='.repeat(72));
  console.log('SUMMARY (median per cell)');
  console.log('='.repeat(72));
  const hdr = 'task        variant          pass  turns  tools  in_tok  wall_s  tsc  judge';
  console.log(hdr);
  console.log('-'.repeat(hdr.length));
  for (const task of activeTasks) {
    for (const variant of activeVariants) {
      const rows = results.filter(x => x.task === task.id && x.variant === variant.id);
      if (rows.length === 0) continue;
      const passed = rows.filter(x => x.success).length;
      const turns = summarize(rows.map(x => x.turns)).median;
      const tools = summarize(rows.map(x => x.toolCalls)).median;
      const inT = summarize(rows.map(x => x.inputTokens)).median;
      const wall = summarize(rows.map(x => x.wallMs / 1000)).median;
      const tscPassed = rows.filter(x => x.typecheckPassed).length;
      const judgeScores = rows.map(x => x.judgeScore).filter(x => x !== undefined) as number[];
      const judgeMedian = judgeScores.length > 0 ? summarize(judgeScores).median : NaN;
      console.log(
        `${task.id.padEnd(11)} ${variant.id.padEnd(16)} ${passed}/${rows.length}   ` +
        `${turns.toFixed(1).padStart(5)}  ${tools.toFixed(1).padStart(5)}  ` +
        `${inT.toFixed(0).padStart(6)}  ${wall.toFixed(1).padStart(6)}  ` +
        `${tscPassed}/${rows.length}  ${isNaN(judgeMedian) ? ' n/a' : judgeMedian.toFixed(0).padStart(4)}`
      );
    }
  }

  // Tool breakdown per (task, variant)
  console.log('');
  console.log('TOOL BREAKDOWN (aggregate across runs)');
  for (const task of TASKS) {
    for (const variant of VARIANTS) {
      const rows = results.filter(x => x.task === task.id && x.variant === variant.id);
      const agg: Record<string, number> = {};
      for (const r of rows) {
        for (const [k, v] of Object.entries(r.toolBreakdown)) {
          agg[k] = (agg[k] ?? 0) + v;
        }
      }
      const entries = Object.entries(agg).sort((a, b) => b[1] - a[1]);
      const line = entries.map(([k, v]) => `${k}=${v}`).join(' Â· ') || '(no tool calls)';
      console.log(`  ${task.id}/${variant.id}: ${line}`);
    }
  }

  // Delta per task
  console.log('');
  console.log('DELTA per task (HARNESS vs BARE; negative = harness wins)');
  const delta = (b: number, h: number) => {
    if (b === 0) return 'n/a';
    const pct = ((h - b) / b) * 100;
    return `${pct >= 0 ? '+' : ''}${pct.toFixed(0)}%`;
  };
  for (const task of TASKS) {
    const bare = results.filter(r => r.task === task.id && r.variant === 'BARE');
    const harness = results.filter(r => r.task === task.id && r.variant === 'HARNESS-STRICT');
    if (!bare.length || !harness.length) continue;
    const bT = summarize(bare.map(x => x.turns)).median;
    const hT = summarize(harness.map(x => x.turns)).median;
    const bTok = summarize(bare.map(x => x.inputTokens + x.outputTokens)).median;
    const hTok = summarize(harness.map(x => x.inputTokens + x.outputTokens)).median;
    const bWall = summarize(bare.map(x => x.wallMs/1000)).median;
    const hWall = summarize(harness.map(x => x.wallMs/1000)).median;
    const bP = bare.filter(x => x.success).length / bare.length;
    const hP = harness.filter(x => x.success).length / harness.length;
    console.log(`  [${task.id}]  turns ${delta(bT, hT)}  tokens ${delta(bTok, hTok)}  wall ${delta(bWall, hWall)}  pass ${(bP*100).toFixed(0)}%â†’${(hP*100).toFixed(0)}%`);
  }

  const resultsPath = join('bench', 'results', `quick-${modelInput}-${Date.now()}.json`);
  try {
    writeFileSync(resultsPath, JSON.stringify({
      tasks: TASKS.map(t => t.id), model: modelInput, runs, results,
    }, null, 2));
    console.log('');
    console.log(`Saved: ${resultsPath}`);
  } catch { /* bench/results may not exist */ }
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});

