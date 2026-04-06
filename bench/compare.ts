/**
 * Phase 7 benchmark runner.
 *
 * Variants:
 *   BASELINE           - legacy tools only, no REPL, no signatures
 *   HARNESS-ADDITIVE   - Repl + legacy tools
 *   HARNESS-MANDATORY  - Repl + legacy nav stripped
 *
 * Tasks:
 *   read, write, refactor
 *
 * Runs each (task x variant) N times and reports summary stats.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=... npx tsx bench/compare.ts
 *   ANTHROPIC_API_KEY=... npx tsx bench/compare.ts --runs 5 --tasks read,write,refactor
 *   ANTHROPIC_API_KEY=... npx tsx bench/compare.ts --task "custom prompt"
 */

import {
  mkdtempSync,
  cpSync,
  rmSync,
  existsSync,
  readFileSync,
  mkdirSync,
  appendFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ModelRouter } from '../src/router/index.js';
import { createCoreRegistry, registerReplTool, stripNavigationTools } from '../src/tools/registry.js';
import { buildSystemPrompt } from '../src/prompt.js';
import { SessionStorage } from '../src/session/storage.js';
import { agentLoop } from '../src/loop.js';
import { setupReplBridge } from '../src/repl/setup.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';
import type { Message } from '../src/router/types.js';
import type { AriesConfig } from '../src/config/types.js';
import { loadConfig } from '../src/config/load.js';

const MAX_TURNS = 20;
const JUDGE_WEIGHTS = {
  effectiveness: 0.5,
  cost: 0.3,
  latency: 0.2,
} as const;

type VariantId = 'BASELINE' | 'HARNESS-ADDITIVE' | 'HARNESS-MANDATORY';
type TaskId = 'read' | 'write' | 'refactor';

interface TaskSpec {
  id: TaskId;
  title: string;
  prompt: string;
  validate: (workspace: string, finalText: string, error?: string) => boolean;
}

interface RunMetrics {
  variant: VariantId;
  task: TaskId;
  run: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  toolBreakdown: Record<string, number>;
  wallMs: number;
  finalText: string;
  success: boolean;
  error?: string;
}

interface VariantSpec {
  id: VariantId;
  label: string;
  useRepl: boolean;
  stripLegacyNav: boolean;
}

const VARIANTS: VariantSpec[] = [
  {
    id: 'BASELINE',
    label: 'BASELINE (legacy tools)',
    useRepl: false,
    stripLegacyNav: false,
  },
  {
    id: 'HARNESS-ADDITIVE',
    label: 'HARNESS-ADDITIVE (REPL + legacy)',
    useRepl: true,
    stripLegacyNav: false,
  },
  {
    id: 'HARNESS-MANDATORY',
    label: 'HARNESS-MANDATORY (REPL-only)',
    useRepl: true,
    stripLegacyNav: true,
  },
];

const TASKS: TaskSpec[] = [
  {
    id: 'read',
    title: 'Permission-system exploration',
    prompt: 'Explain the permission system in this codebase. How does it flow from user keystroke to tool execution?',
    validate: (_workspace, finalText, error) => !error && /permission/i.test(finalText),
  },
  {
    id: 'write',
    title: 'Add Count tool',
    prompt: [
      'Add a new tool named Count.',
      'Requirements:',
      '- Create src/tools/count.ts with a CountTool class implementing Tool interface.',
      '- Input schema: { text: string }.',
      '- Output should report character count, word count, and line count.',
      '- Register Count in src/tools/registry.ts core tools section.',
      '- Keep style consistent with existing tools.',
      '- Do not touch unrelated files.',
    ].join('\n'),
    validate: (workspace, _finalText, error) => {
      if (error) return false;
      const p = join(workspace, 'src', 'tools', 'count.ts');
      if (!existsSync(p)) return false;
      const body = readFileSync(p, 'utf-8');
      return /class\s+CountTool/.test(body) && /character/i.test(body);
    },
  },
  {
    id: 'refactor',
    title: 'Refactor stripNavigationTools',
    prompt: [
      'Refactor src/tools/registry.ts so stripNavigationTools no longer accesses private state via (registry as any).tools.',
      'Requirements:',
      '- Add a proper unregister(name: string) method on ToolRegistry.',
      '- Update stripNavigationTools to call registry.unregister(name).',
      '- Keep behavior unchanged.',
      '- Do not edit unrelated files.',
    ].join('\n'),
    validate: (workspace, _finalText, error) => {
      if (error) return false;
      const p = join(workspace, 'src', 'tools', 'registry.ts');
      if (!existsSync(p)) return false;
      const body = readFileSync(p, 'utf-8');
      return body.includes('unregister(name: string)') && !body.includes('(registry as any).tools');
    },
  },
];

function parseArgs(argv: string[]): {
  runs: number;
  taskIds: Set<TaskId>;
  customTask?: string;
  logDir: string;
  modelInput: string;
} {
  let runs = 3;
  let taskIds = new Set<TaskId>(['read', 'write', 'refactor']);
  let customTask: string | undefined;
  let logDir = join('bench', 'results');
  let modelInput = 'sonnet';

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--runs') {
      runs = Math.max(1, parseInt(argv[++i] ?? '3', 10));
    } else if (a === '--tasks') {
      const raw = (argv[++i] ?? '').split(',').map(s => s.trim()).filter(Boolean);
      const allowed = new Set<TaskId>();
      for (const t of raw) {
        if (t === 'read' || t === 'write' || t === 'refactor') allowed.add(t);
      }
      if (allowed.size > 0) taskIds = allowed;
    } else if (a === '--task') {
      customTask = argv[++i] ?? '';
      taskIds = new Set<TaskId>(['read']);
    } else if (a === '--log-dir') {
      logDir = argv[++i] ?? logDir;
    } else if (a === '--model') {
      modelInput = (argv[++i] ?? modelInput).trim();
    }
  }

  return { runs, taskIds, customTask, logDir, modelInput };
}

function copyWorkspace(src: string): string {
  const dest = mkdtempSync(join(tmpdir(), 'aries-bench-'));
  cpSync(src, dest, {
    recursive: true,
    filter: (path) => {
      const norm = path.replace(/\\/g, '/');
      if (norm.includes('/.git/')) return false;
      if (norm.endsWith('/.git')) return false;
      if (norm.includes('/node_modules/')) return false;
      if (norm.endsWith('/node_modules')) return false;
      if (norm.includes('/dist/')) return false;
      if (norm.includes('/.aries/sessions/')) return false;
      if (norm.includes('/body/__pycache__/')) return false;
      return true;
    },
  });
  return dest;
}

async function runVariant(
  variant: VariantSpec,
  task: TaskSpec,
  run: number,
  config: AriesConfig,
  modelInput: string,
  repoRoot: string,
): Promise<RunMetrics> {
  const workspace = copyWorkspace(repoRoot);
  const metrics: RunMetrics = {
    variant: variant.id,
    task: task.id,
    run,
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    toolCalls: 0,
    toolBreakdown: {},
    wallMs: 0,
    finalText: '',
    success: false,
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
      if (!replHandle) throw new Error('REPL bridge failed to start');

      registerReplTool(registry, () => replHandle);
      if (variant.stripLegacyNav) stripNavigationTools(registry);

      const idxResult = await replHandle.bridge.index({ repoPath: workspace });
      if (idxResult.ok) {
        const sig = await replHandle.bridge.codebaseSignature(
          config.signature.codebase.level,
          config.signature.codebase.maxTokens,
        );
        if (!('error' in sig) || !sig.error) {
          codebaseSignatureMd = sig.markdown;
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
    for await (const event of agentLoop({
      messages,
      systemPrompt,
      router,
      registry,
      toolContext: { cwd: workspace },
      vault: null,
      projectBrain: null,
      session,
      hooks: {},
      permissionMode: 'yolo' as const,
      maxTurns: MAX_TURNS,
    })) {
      if (event.type === 'model_start') metrics.turns++;
      if (event.type === 'text') metrics.finalText += event.content;
      if (event.type === 'tool_call') {
        metrics.toolCalls++;
        const name = event.toolCall.name;
        metrics.toolBreakdown[name] = (metrics.toolBreakdown[name] ?? 0) + 1;
      }
      if (event.type === 'usage') {
        metrics.inputTokens += event.inputTokens ?? 0;
        metrics.outputTokens += event.outputTokens ?? 0;
      }
      if (event.type === 'error') {
        metrics.error = event.error instanceof Error ? event.error.message : String(event.error);
        break;
      }
    }
    metrics.wallMs = Date.now() - start;
    metrics.success = task.validate(workspace, metrics.finalText, metrics.error);
  } catch (err) {
    metrics.error = (err as Error).message;
  } finally {
    if (replHandle) await replHandle.shutdown();
    rmSync(workspace, { recursive: true, force: true });
  }

  return metrics;
}

function summarize(nums: number[]): { mean: number; median: number; min: number; max: number } {
  const sorted = [...nums].sort((a, b) => a - b);
  const mean = sorted.reduce((a, b) => a + b, 0) / Math.max(1, sorted.length);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
  return {
    mean,
    median,
    min: sorted[0] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
  };
}

function fmt(x: number): string {
  return Number.isFinite(x) ? x.toFixed(2) : 'inf';
}

function normalizeLowerBetter(value: number, best: number, worst: number): number {
  if (!Number.isFinite(value)) return 0;
  if (worst <= best) return 1;
  return (worst - value) / (worst - best);
}

function computeEfficiency(rows: RunMetrics[]): {
  tokensPerSuccess: number;
  secondsPerSuccess: number;
  callsPerSuccess: number;
  turnsPerSuccess: number;
  successesPerMillionTokens: number;
  successesPerMinute: number;
} {
  const successCount = rows.filter(r => r.success).length;
  const totalTokens = rows.reduce((acc, r) => acc + r.inputTokens + r.outputTokens, 0);
  const totalSeconds = rows.reduce((acc, r) => acc + (r.wallMs / 1000), 0);
  const totalCalls = rows.reduce((acc, r) => acc + r.toolCalls, 0);
  const totalTurns = rows.reduce((acc, r) => acc + r.turns, 0);
  const denom = Math.max(1, successCount);

  return {
    tokensPerSuccess: totalTokens / denom,
    secondsPerSuccess: totalSeconds / denom,
    callsPerSuccess: totalCalls / denom,
    turnsPerSuccess: totalTurns / denom,
    successesPerMillionTokens: successCount / Math.max(1e-9, totalTokens / 1_000_000),
    successesPerMinute: successCount / Math.max(1e-9, totalSeconds / 60),
  };
}

interface VariantAggregate {
  variant: VariantId;
  successRate: number;
  tokensPerSuccess: number;
  secondsPerSuccess: number;
  callsPerSuccess: number;
  turnsPerSuccess: number;
  meanTokens: number;
  meanSeconds: number;
}

function aggregateByVariant(rows: RunMetrics[]): Map<VariantId, VariantAggregate> {
  const out = new Map<VariantId, VariantAggregate>();
  for (const variant of VARIANTS) {
    const subset = rows.filter(r => r.variant === variant.id);
    if (subset.length === 0) continue;
    const successRate = subset.filter(r => r.success).length / subset.length;
    const eff = computeEfficiency(subset);
    const toks = summarize(subset.map(r => r.inputTokens + r.outputTokens));
    const time = summarize(subset.map(r => r.wallMs / 1000));
    out.set(variant.id, {
      variant: variant.id,
      successRate,
      tokensPerSuccess: eff.tokensPerSuccess,
      secondsPerSuccess: eff.secondsPerSuccess,
      callsPerSuccess: eff.callsPerSuccess,
      turnsPerSuccess: eff.turnsPerSuccess,
      meanTokens: toks.mean,
      meanSeconds: time.mean,
    });
  }
  return out;
}

function formatDiagnostics(rows: RunMetrics[]): string[] {
  const notes: string[] = [];
  const overall = aggregateByVariant(rows);
  const baseline = overall.get('BASELINE');
  const additive = overall.get('HARNESS-ADDITIVE');
  const mandatory = overall.get('HARNESS-MANDATORY');
  if (!baseline || !additive || !mandatory) return notes;

  if (additive.meanTokens > baseline.meanTokens && additive.meanSeconds > baseline.meanSeconds) {
    notes.push(
      'Additive harness is slower and more expensive than baseline in aggregate, consistent with mixed-affordance zigzag (legacy tools + REPL both available).',
    );
  }

  const writeRefactor = rows.filter(r => r.task === 'write' || r.task === 'refactor');
  const wrAgg = aggregateByVariant(writeRefactor);
  const wrBase = wrAgg.get('BASELINE');
  const wrMand = wrAgg.get('HARNESS-MANDATORY');
  if (wrBase && wrMand) {
    const tokenDelta = (wrMand.tokensPerSuccess - wrBase.tokensPerSuccess) / Math.max(1, wrBase.tokensPerSuccess);
    const secDelta = (wrMand.secondsPerSuccess - wrBase.secondsPerSuccess) / Math.max(1, wrBase.secondsPerSuccess);
    if (tokenDelta > 0.15 || secDelta > 0.15) {
      notes.push(
        'Mandatory REPL underperforms on write/refactor tasks. Likely remaining gap: mutation path still relies on legacy Write/Edit and lacks specialized judgment tools for low-turn edits (Phase 8 pending).',
      );
    }
  }

  const readRows = rows.filter(r => r.task === 'read');
  const readAgg = aggregateByVariant(readRows);
  const readMand = readAgg.get('HARNESS-MANDATORY');
  const readBase = readAgg.get('BASELINE');
  if (readMand && readBase && readMand.tokensPerSuccess < readBase.tokensPerSuccess) {
    notes.push(
      'Mandatory REPL remains structurally strong for exploration/read tasks, where composed codebase+vault+RLM operations reduce navigation overhead.',
    );
  }

  const highTurnMand = rows
    .filter(r => r.variant === 'HARNESS-MANDATORY')
    .some(r => r.turns >= 10 || r.toolCalls >= 10);
  if (highTurnMand) {
    notes.push(
      'Some mandatory runs show high turn/tool churn, indicating missing task-specific heuristics and judgment primitives before full efficiency convergence.',
    );
  }

  return notes;
}

function printRun(m: RunMetrics): void {
  const total = m.inputTokens + m.outputTokens;
  const status = m.success ? 'ok' : 'fail';
  console.log(
    `  run ${String(m.run).padStart(2)}  ${m.variant.padEnd(18)} ` +
    `turns=${String(m.turns).padStart(2)} calls=${String(m.toolCalls).padStart(2)} ` +
    `tokens=${String(total).padStart(7)} time=${(m.wallMs / 1000).toFixed(1).padStart(6)}s ${status}`,
  );
  if (m.error) console.log(`    error: ${m.error}`);
}

function printSummary(task: TaskSpec, rows: RunMetrics[]): void {
  console.log('');
  console.log(`=== ${task.id.toUpperCase()} :: ${task.title} ===`);
  const byVariant = new Map<VariantId, {
    successRate: number;
    tokensPerSuccess: number;
    secondsPerSuccess: number;
  }>();

  for (const variant of VARIANTS) {
    const subset = rows.filter(r => r.variant === variant.id);
    if (subset.length === 0) continue;
    const successRate = subset.filter(r => r.success).length / subset.length;
    const eff = computeEfficiency(subset);
    byVariant.set(variant.id, {
      successRate,
      tokensPerSuccess: eff.tokensPerSuccess,
      secondsPerSuccess: eff.secondsPerSuccess,
    });
  }

  const tokenValues = Array.from(byVariant.values()).map(v => v.tokensPerSuccess);
  const secValues = Array.from(byVariant.values()).map(v => v.secondsPerSuccess);
  const bestTokens = Math.min(...tokenValues);
  const worstTokens = Math.max(...tokenValues);
  const bestSecs = Math.min(...secValues);
  const worstSecs = Math.max(...secValues);

  for (const variant of VARIANTS) {
    const subset = rows.filter(r => r.variant === variant.id);
    if (subset.length === 0) continue;
    const toks = summarize(subset.map(r => r.inputTokens + r.outputTokens));
    const time = summarize(subset.map(r => r.wallMs));
    const turns = summarize(subset.map(r => r.turns));
    const calls = summarize(subset.map(r => r.toolCalls));
    const successRate = subset.filter(r => r.success).length / subset.length;
    const eff = computeEfficiency(subset);
    const costScore = normalizeLowerBetter(eff.tokensPerSuccess, bestTokens, worstTokens);
    const latencyScore = normalizeLowerBetter(eff.secondsPerSuccess, bestSecs, worstSecs);
    const effectivenessScore = successRate;
    const judgeScore =
      (JUDGE_WEIGHTS.effectiveness * effectivenessScore)
      + (JUDGE_WEIGHTS.cost * costScore)
      + (JUDGE_WEIGHTS.latency * latencyScore);

    console.log(`  ${variant.id}`);
    console.log(
      `    success=${(successRate * 100).toFixed(0)}% ` +
      `tokens(mean/med/min/max)=${Math.round(toks.mean)}/${Math.round(toks.median)}/${Math.round(toks.min)}/${Math.round(toks.max)} ` +
      `time_s(mean/med)=${(time.mean / 1000).toFixed(1)}/${(time.median / 1000).toFixed(1)} ` +
      `turns(mean)=${turns.mean.toFixed(1)} calls(mean)=${calls.mean.toFixed(1)}`,
    );
    console.log(
      `    efficiency(lower-better): tokens/success=${fmt(eff.tokensPerSuccess)} ` +
      `sec/success=${fmt(eff.secondsPerSuccess)} calls/success=${fmt(eff.callsPerSuccess)} turns/success=${fmt(eff.turnsPerSuccess)}`,
    );
    console.log(
      `    efficiency(higher-better): success/1M-tokens=${fmt(eff.successesPerMillionTokens)} ` +
      `success/min=${fmt(eff.successesPerMinute)}`,
    );
    console.log(
      `    pillars(raw): effectiveness=${fmt(successRate * 100)}% ` +
      `cost_tokens_per_success=${fmt(eff.tokensPerSuccess)} ` +
      `latency_sec_per_success=${fmt(eff.secondsPerSuccess)}`,
    );
    console.log(
      `    pillars(normalized 0-100): effectiveness=${fmt(effectivenessScore * 100)} ` +
      `cost=${fmt(costScore * 100)} latency=${fmt(latencyScore * 100)}`,
    );
    console.log(
      `    judge(default 50/30/20): ${fmt(judgeScore * 100)}`,
    );
  }
}

async function main(): Promise<void> {
  const { runs, taskIds, customTask, logDir, modelInput } = parseArgs(process.argv.slice(2));
  const repoRoot = resolve(process.cwd());
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const resolvedLogDir = resolve(repoRoot, logDir);
  mkdirSync(resolvedLogDir, { recursive: true });
  const logPath = join(resolvedLogDir, `phase7-bench-${runId}.jsonl`);
  const summaryPath = join(resolvedLogDir, `phase7-bench-${runId}.summary.json`);

  const loaded = loadConfig(repoRoot);
  const baseConfig: AriesConfig = {
    ...DEFAULT_CONFIG,
    ...loaded,
    models: {
      ...DEFAULT_CONFIG.models,
      ...loaded.models,
      primary: {
        ...DEFAULT_CONFIG.models.primary,
        ...loaded.models.primary,
      },
    },
    repl: {
      ...DEFAULT_CONFIG.repl,
      ...loaded.repl,
      enabled: true,
    },
    signature: {
      ...DEFAULT_CONFIG.signature,
      ...loaded.signature,
    },
  };

  const tasks = TASKS
    .filter(t => taskIds.has(t.id))
    .map(t => (customTask && t.id === 'read')
      ? { ...t, title: 'Custom read task', prompt: customTask }
      : t);

  console.log(`Repo: ${repoRoot}`);
  console.log(`Model input: ${modelInput}`);
  console.log(`Runs per (task x variant): ${runs}`);
  console.log(`Tasks: ${tasks.map(t => t.id).join(', ')}`);
  console.log(`Log JSONL: ${logPath}`);

  const allRows: RunMetrics[] = [];

  for (const task of tasks) {
    console.log('');
    console.log(`Task ${task.id}: ${task.title}`);
    for (let run = 1; run <= runs; run++) {
      for (const variant of VARIANTS) {
        const config = {
          ...baseConfig,
          repl: { ...baseConfig.repl, enabled: variant.useRepl },
        };
        const row = await runVariant(variant, task, run, config, modelInput, repoRoot);
        allRows.push(row);
        printRun(row);
        appendFileSync(
          logPath,
          JSON.stringify({
            type: 'run',
            ts: new Date().toISOString(),
            ...row,
            totalTokens: row.inputTokens + row.outputTokens,
          }) + '\n',
          'utf-8',
        );
      }
    }
    printSummary(task, allRows.filter(r => r.task === task.id));
  }

  console.log('');
  console.log('=== OVERALL ===');
  const overallByVariant = new Map<VariantId, {
    successRate: number;
    tokensPerSuccess: number;
    secondsPerSuccess: number;
  }>();
  for (const variant of VARIANTS) {
    const subset = allRows.filter(r => r.variant === variant.id);
    if (subset.length === 0) continue;
    const successRate = subset.filter(r => r.success).length / subset.length;
    const eff = computeEfficiency(subset);
    overallByVariant.set(variant.id, {
      successRate,
      tokensPerSuccess: eff.tokensPerSuccess,
      secondsPerSuccess: eff.secondsPerSuccess,
    });
  }
  const overallTokenValues = Array.from(overallByVariant.values()).map(v => v.tokensPerSuccess);
  const overallSecValues = Array.from(overallByVariant.values()).map(v => v.secondsPerSuccess);
  const overallBestTokens = Math.min(...overallTokenValues);
  const overallWorstTokens = Math.max(...overallTokenValues);
  const overallBestSecs = Math.min(...overallSecValues);
  const overallWorstSecs = Math.max(...overallSecValues);

  for (const variant of VARIANTS) {
    const subset = allRows.filter(r => r.variant === variant.id);
    if (subset.length === 0) continue;
    const toks = summarize(subset.map(r => r.inputTokens + r.outputTokens));
    const time = summarize(subset.map(r => r.wallMs));
    const successRate = subset.filter(r => r.success).length / subset.length;
    const eff = computeEfficiency(subset);
    const costScore = normalizeLowerBetter(eff.tokensPerSuccess, overallBestTokens, overallWorstTokens);
    const latencyScore = normalizeLowerBetter(eff.secondsPerSuccess, overallBestSecs, overallWorstSecs);
    const effectivenessScore = successRate;
    const judgeScore =
      (JUDGE_WEIGHTS.effectiveness * effectivenessScore)
      + (JUDGE_WEIGHTS.cost * costScore)
      + (JUDGE_WEIGHTS.latency * latencyScore);
    console.log(
      `  ${variant.id.padEnd(18)} success=${(successRate * 100).toFixed(0)}% ` +
      `tokens(mean)=${Math.round(toks.mean)} time_s(mean)=${(time.mean / 1000).toFixed(1)} ` +
      `tokens/success=${fmt(eff.tokensPerSuccess)} sec/success=${fmt(eff.secondsPerSuccess)} ` +
      `success/1M-tokens=${fmt(eff.successesPerMillionTokens)} success/min=${fmt(eff.successesPerMinute)} ` +
      `pillars(e/c/l)=(${fmt(effectivenessScore * 100)}/${fmt(costScore * 100)}/${fmt(latencyScore * 100)}) ` +
      `judge=${fmt(judgeScore * 100)}`,
    );
  }

  const diagnostics = formatDiagnostics(allRows);
  if (diagnostics.length > 0) {
    console.log('');
    console.log('=== DIAGNOSTICS (Likely Gaps) ===');
    for (const note of diagnostics) {
      console.log(`  - ${note}`);
    }
  }

  const summary = {
    runId,
    ts: new Date().toISOString(),
    repoRoot,
    modelInput,
    primaryModelDefault: baseConfig.models.primary.model,
    auth: baseConfig.models.primary.auth,
    runs,
    tasks: tasks.map(t => t.id),
    overall: Array.from(aggregateByVariant(allRows).values()),
    diagnostics,
    rows: allRows.map(r => ({
      ...r,
      totalTokens: r.inputTokens + r.outputTokens,
    })),
  };
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf-8');
  console.log(`Summary JSON: ${summaryPath}`);
}

main().catch((e) => {
  console.error('bench fatal:', e);
  process.exit(1);
});

