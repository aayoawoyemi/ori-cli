/**
 * Plan-schema compliance stub — the gating experiment from your 2026-04-22
 * vault note "10 call stub test on opus minitems compliance is the gating
 * experiment before any composition harness work".
 *
 * The schema we just shipped on code requires:
 *   plan: { goal: minLength:20, steps: array minItems:2 items: minLength:12 }
 *
 * Anthropic's quoted compliance numbers (~98%+) come from `required`, `type`,
 * `enum`. `minItems` on tool-input arrays is a different axis and not separately
 * benchmarked. This bench measures: does Sonnet 4.6 actually respect the
 * minItems:2 constraint, and when it does, are the steps semantically
 * meaningful or padded?
 *
 * Method:
 *   - 10 prompts, each genuinely solvable in ONE Python expression
 *   - Run each at maxTurns:1 so we capture the model's FIRST emission only
 *   - Parse plan.steps + count cells in code
 *   - Classify outcomes per the vault note's decision matrix
 *
 * Outcome classifications:
 *   (a) compliant ≥2 steps, ≥2 cells, semantically distinct → ship as-is
 *   (b) compliant ≥2 steps, 1 cell — padding (steps ≠ cells) → tighten
 *   (c) <2 steps emitted (API validated and rejected, model retried) → schema
 *       fails on Sonnet, regroup
 *   (d) no code call at all -> tool too restrictive, loosen
 *
 * Usage:
 *   npx tsx bench/plan-schema-stub.ts
 *   npx tsx bench/plan-schema-stub.ts --model primary --runs 1
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

// Load .env if present.
try {
  const envText = readFileSync('.env', 'utf-8');
  for (const line of envText.split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!;
  }
} catch { /* no .env */ }

/**
 * Tasks chosen to be solvable in ONE Python expression. If the model emits
 * 2+ steps with 2+ cells, that's the schema doing structural work — not
 * task complexity demanding decomposition. The "using code" wording
 * biases the model to actually invoke the tool rather than answer in text.
 */
const STUB_TASKS = [
  'Print 2+2 using code.',
  'Print the result of 100 * 7 using code.',
  "Print 'hello world' using code.",
  'Compute and print sum(range(10)) using code.',
  "Print the length of the string 'aries-cli' using code.",
  'Use fs.listdir to list the current directory and print the count.',
  'Use fs.read to read package.json then print the first 100 chars.',
  "Use os.path.basename to print the basename of '/foo/bar/baz.py'.",
  "Use json.dumps to print the JSON of the dict {'a': 1, 'b': [2, 3]}.",
  'Compute the factorial of 5 with a for loop and print the result.',
];

type Outcome =
  | 'compliant'        // ≥2 steps, ≥2 cells (real composition)
  | 'padded_one_cell'  // ≥2 steps but only 1 cell (steps don't match)
  | 'one_step'         // 1 step emitted (would need API to NOT enforce minItems)
  | 'no_plan'          // emitted code without plan field at all
  | 'no_repl'          // didn't use code
  | 'error';           // exception

interface TaskResult {
  task: string;
  outcome: Outcome;
  goal?: string;
  steps?: string[];
  stepCount?: number;
  cellCount?: number;
  goalLength?: number;
  meanStepLength?: number;
  rawInput?: unknown;
  errorMessage?: string;
}

function countCells(code: string | undefined): number {
  if (!code) return 0;
  const matches = code.match(/^```(?:py|python|js|javascript|ts|typescript)\b/gm);
  return matches?.length ?? 0;
}

function classify(input: unknown, code: string | undefined): {
  outcome: Outcome;
  stepCount: number;
  cellCount: number;
} {
  const inp = (input ?? {}) as Record<string, unknown>;
  const cellCount = countCells(code);

  if (!('plan' in inp) || inp.plan == null) {
    // No plan field → schema didn't bite or repair shim swapped to legacy
    return { outcome: 'no_plan', stepCount: 0, cellCount };
  }
  const plan = inp.plan as { goal?: unknown; steps?: unknown };
  const stepsRaw = plan.steps;
  if (!Array.isArray(stepsRaw)) {
    return { outcome: 'no_plan', stepCount: 0, cellCount };
  }
  const stepCount = stepsRaw.length;

  if (stepCount < 2) {
    // Schema requires minItems:2; if we see <2 it means Anthropic's API
    // didn't enforce minItems for this request.
    return { outcome: 'one_step', stepCount, cellCount };
  }
  if (cellCount < 2) {
    // ≥2 steps but ≤1 cell — model padded steps without matching code.
    return { outcome: 'padded_one_cell', stepCount, cellCount };
  }
  return { outcome: 'compliant', stepCount, cellCount };
}

async function runOneTask(
  task: string,
  model: string,
  cwd: string,
): Promise<TaskResult> {
  const config = loadConfig(cwd);
  const router = new ModelRouter(config.models, config.experimental);
  router.setModel(model);

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

    const systemPrompt = buildSystemPrompt({ cwd, config, replEnabled: true });
    const session = new SessionStorage(cwd);
    const messages: Message[] = [{ role: 'user', content: task }];

    let firstReplCall: { input: unknown } | null = null;
    let errorMessage: string | undefined;

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
      // 4 turns gives room for: (1) first model call emitting code,
      // (2) tool exec, (3) second model call processing result. We exit
      // the for-await as soon as we capture the first code tool_call,
      // so the actual cap rarely matters — but maxTurns:1 was too tight
      // (errored before any emission was captured).
      maxTurns: 4,
    })) {
      if (event.type === 'tool_call' && event.toolCall.name === 'code' && !firstReplCall) {
        firstReplCall = { input: event.toolCall.input };
        // Captured the emission. Skip the rest of the loop — we don't
        // need the tool to execute (no side effects) and don't need the
        // second model call. Saves ~1-2s per task.
        break;
      }
      if (event.type === 'error') {
        errorMessage = event.error instanceof Error
          ? event.error.message
          : String(event.error);
        break;
      }
    }

    if (errorMessage) {
      return { task, outcome: 'error', errorMessage };
    }
    if (!firstReplCall) {
      return { task, outcome: 'no_repl' };
    }

    const inp = firstReplCall.input as Record<string, unknown>;
    const code = typeof inp.code === 'string' ? inp.code : undefined;
    const { outcome, stepCount, cellCount } = classify(firstReplCall.input, code);
    const plan = (inp.plan ?? {}) as { goal?: unknown; steps?: unknown };
    const goal = typeof plan.goal === 'string' ? plan.goal : undefined;
    const steps = Array.isArray(plan.steps)
      ? (plan.steps as unknown[]).filter((s): s is string => typeof s === 'string')
      : undefined;
    const meanStepLength = steps && steps.length > 0
      ? steps.reduce((a, s) => a + s.length, 0) / steps.length
      : undefined;

    return {
      task,
      outcome,
      goal,
      steps,
      stepCount,
      cellCount,
      goalLength: goal?.length,
      meanStepLength,
      rawInput: firstReplCall.input,
    };
  } catch (err) {
    return {
      task,
      outcome: 'error',
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (replHandle) await replHandle.shutdown();
  }
}

async function main() {
  const args = process.argv.slice(2);
  let modelInput = 'primary';
  let runs = 1;
  let taskFilter: number | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--model') modelInput = args[++i]!;
    if (args[i] === '--runs') runs = parseInt(args[++i]!, 10);
    if (args[i] === '--only') taskFilter = parseInt(args[++i]!, 10);
  }

  const tasks = taskFilter !== undefined
    ? [STUB_TASKS[taskFilter]!]
    : STUB_TASKS;

  console.log('='.repeat(72));
  console.log('Plan-schema compliance stub');
  console.log('='.repeat(72));
  console.log(`Model: ${modelInput}`);
  console.log(`Tasks: ${tasks.length}, Runs each: ${runs}`);
  console.log(`Schema: plan.goal minLength:20, plan.steps minItems:2 items minLength:12`);
  console.log('');

  const results: TaskResult[] = [];
  for (let r = 1; r <= runs; r++) {
    if (runs > 1) console.log(`--- Run ${r}/${runs} ---`);
    for (let i = 0; i < tasks.length; i++) {
      const t = tasks[i]!;
      const started = new Date().toISOString().slice(11, 19);
      process.stdout.write(`[${started}] task ${i + 1}/${tasks.length}: "${t.slice(0, 50)}"... `);
      const res = await runOneTask(t, modelInput, process.cwd());
      results.push(res);
      const stepsLabel = res.stepCount !== undefined ? `${res.stepCount}s` : '-';
      const cellsLabel = res.cellCount !== undefined ? `${res.cellCount}c` : '-';
      const tag = res.outcome === 'error'
        ? `ERROR: ${res.errorMessage?.slice(0, 60)}`
        : `${res.outcome.padEnd(16)} ${stepsLabel}/${cellsLabel}`;
      console.log(tag);
    }
  }

  // ── Outcome counts ────────────────────────────────────────────────────
  console.log('');
  console.log('='.repeat(72));
  console.log('OUTCOMES');
  console.log('='.repeat(72));
  const counts: Record<Outcome, number> = {
    compliant: 0,
    padded_one_cell: 0,
    one_step: 0,
    no_plan: 0,
    no_repl: 0,
    error: 0,
  };
  for (const r of results) counts[r.outcome]++;
  for (const k of Object.keys(counts) as Outcome[]) {
    const pct = (counts[k] / results.length * 100).toFixed(0);
    console.log(`  ${k.padEnd(20)} ${String(counts[k]).padStart(3)}/${results.length}  (${pct}%)`);
  }

  // ── Step + cell distribution among compliant ─────────────────────────
  const valid = results.filter(r =>
    r.outcome === 'compliant' || r.outcome === 'padded_one_cell' || r.outcome === 'one_step',
  );
  if (valid.length > 0) {
    const stepCounts = valid.map(r => r.stepCount ?? 0);
    const cellCounts = valid.map(r => r.cellCount ?? 0);
    const meanSteps = stepCounts.reduce((a, b) => a + b, 0) / stepCounts.length;
    const meanCells = cellCounts.reduce((a, b) => a + b, 0) / cellCounts.length;
    const maxSteps = Math.max(...stepCounts);
    const maxCells = Math.max(...cellCounts);
    console.log('');
    console.log(`mean steps: ${meanSteps.toFixed(1)} (max ${maxSteps})`);
    console.log(`mean cells: ${meanCells.toFixed(1)} (max ${maxCells})`);
    const meanGoalLen = valid
      .map(r => r.goalLength ?? 0)
      .reduce((a, b) => a + b, 0) / valid.length;
    const meanStepLen = valid
      .map(r => r.meanStepLength ?? 0)
      .reduce((a, b) => a + b, 0) / valid.length;
    console.log(`mean goal length: ${meanGoalLen.toFixed(0)} chars`);
    console.log(`mean step length: ${meanStepLen.toFixed(0)} chars`);
  }

  // ── Decision per vault note ──────────────────────────────────────────
  console.log('');
  console.log('='.repeat(72));
  console.log('VERDICT (per 2026-04-22 vault decision matrix)');
  console.log('='.repeat(72));
  const total = results.length;
  const compliantPct = counts.compliant / total;
  const paddedPct = counts.padded_one_cell / total;
  const oneStepPct = counts.one_step / total;
  const noReplPct = counts.no_repl / total;

  if (compliantPct >= 0.7) {
    console.log(`✓ (a) Compliant dominates (${(compliantPct * 100).toFixed(0)}%) — ship the schema as-is.`);
  } else if (paddedPct >= 0.4) {
    console.log(`~ (b) Padding dominant (${(paddedPct * 100).toFixed(0)}%) — schema fires but model gaming. Tighten step minLength or require step-cell parity.`);
  } else if (oneStepPct >= 0.3) {
    console.log(`✗ (c) ${(oneStepPct * 100).toFixed(0)}% emitted <2 steps — Anthropic API isn't enforcing minItems on this shape. Schema-level approach is dead at this layer.`);
  } else if (noReplPct >= 0.4) {
    console.log(`✗ (d) ${(noReplPct * 100).toFixed(0)}% refused code — tool too restrictive. Loosen schema (drop minLength on goal, drop step minLength).`);
  } else {
    console.log(`Mixed outcomes — review per-task results below before deciding.`);
  }

  // ── Per-task listing for spot-check ──────────────────────────────────
  console.log('');
  console.log('PER TASK');
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    console.log(`  [${i + 1}] ${r.outcome.padEnd(16)}  "${r.task.slice(0, 55)}"`);
    if (r.steps) {
      for (const s of r.steps) console.log(`        - ${s.slice(0, 80)}`);
    }
  }

  // Persist for follow-up.
  try {
    const dir = join('bench', 'results');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const path = join(dir, `plan-schema-stub-${modelInput}-${Date.now()}.json`);
    writeFileSync(path, JSON.stringify({ model: modelInput, runs, results, counts }, null, 2));
    console.log('');
    console.log(`Saved: ${path}`);
  } catch { /* non-fatal */ }
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
