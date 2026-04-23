/**
 * Repl schema compliance smoke.
 *
 * Tests whether frontier models emit tool_use with `operations: minItems:3`
 * when the input_schema declares that constraint. Stream A's structural
 * composition mechanism is schema enforcement at the tool-contract layer —
 * if models don't comply (or if the provider validates server-side and
 * rejects), we need to know before the walk-codemode decisive test, not
 * after.
 *
 * This is a smoke, not a gate. Stream A ships with minItems:2 on the real
 * Repl tool regardless. The smoke tells us what emission behavior to
 * expect so we can interpret the walk-trace results correctly.
 *
 * Usage:
 *   npx tsx scripts/repl_schema_compliance.ts
 *   npx tsx scripts/repl_schema_compliance.ts --model opus-sub
 *
 * Outputs a 4-row tally of modes (a/b/c/d) per prompt + a per-provider
 * summary. Does NOT log to sessions — ephemeral output only.
 */
import { loadConfig } from '../src/config/load.js';
import { ModelRouter } from '../src/router/index.js';
import type { ToolDefinition, Message, StreamEvent } from '../src/router/types.js';

// Parse simple flags: --model <shortcut>
function parseArgs(argv: string[]): { model?: string } {
  const out: { model?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--model' && i + 1 < argv.length) {
      out.model = argv[i + 1];
      i++;
    }
  }
  return out;
}

// The stub tool: array of strings with minItems:3. Simpler than the real
// {plan, operations:[{purpose, code}]} schema because we're isolating the
// single question "does the model respect minItems on an array?" If the
// simple case works, the richer real schema almost certainly does too. If
// the simple case fails, the real schema will fail worse.
const STUB_TOOL: ToolDefinition = {
  name: 'TestBatch',
  description:
    'Submit a batch of operations to run. Each operation is a short descriptive string explaining what the step does. The harness concatenates and executes them. Use this tool to answer the user when the task has multiple logical steps.',
  input_schema: {
    type: 'object',
    properties: {
      operations: {
        type: 'array',
        description:
          'Array of 3 or more descriptive strings, one per operation.',
        minItems: 3,
        items: {
          type: 'string',
          description: 'One operation, as a short descriptive string.',
        },
      },
    },
    required: ['operations'],
  },
};

// 10 prompts — 3 naturally-1-op, 4 naturally-3+, 3 ambiguous. The natural-1-op
// prompts are the friction case: minItems:3 will force padding OR tool refusal.
// The natural-3+ prompts are the fit case: compliance should come easily.
// Ambiguous prompts probe whether the model leans toward composition or
// toward single-action answers when the task doesn't strongly indicate one.
const PROMPTS: { id: string; prompt: string; natural: '1op' | '3+ops' | 'ambiguous' }[] = [
  { id: 'sum',      prompt: 'Use the TestBatch tool to compute 2+2 and tell me the answer.', natural: '1op' },
  { id: 'echo',     prompt: 'Use the TestBatch tool to echo the word "hello" to me.',        natural: '1op' },
  { id: 'time',     prompt: 'Use the TestBatch tool to tell me what day of the week it is.', natural: '1op' },
  { id: 'refactor', prompt: 'Use the TestBatch tool to plan how you would refactor a function: find it, read it, identify callers, and propose a new signature.', natural: '3+ops' },
  { id: 'debug',    prompt: 'Use the TestBatch tool to debug a flaky test: gather the error, read the test file, read the module under test, form a hypothesis, and suggest a fix.', natural: '3+ops' },
  { id: 'review',   prompt: 'Use the TestBatch tool to review a pull request: list the changed files, read the diff, check for test coverage, and summarize the change.', natural: '3+ops' },
  { id: 'setup',    prompt: 'Use the TestBatch tool to set up a new Python project: create the directory, initialize git, add a pyproject.toml, write a README, and commit.', natural: '3+ops' },
  { id: 'explain',  prompt: 'Use the TestBatch tool to explain how HTTP caching works.',     natural: 'ambiguous' },
  { id: 'translate',prompt: 'Use the TestBatch tool to translate "good morning" into Spanish, French, and Japanese.', natural: 'ambiguous' },
  { id: 'summary',  prompt: 'Use the TestBatch tool to summarize the main ideas in a blog post about rate limiting.', natural: 'ambiguous' },
];

type Mode = 'a' | 'b' | 'c' | 'd';

interface Observation {
  id: string;
  natural: '1op' | '3+ops' | 'ambiguous';
  mode: Mode;
  mode_label: string;
  op_count: number;
  ops_preview: string[];
  error?: string;
}

// Classify an emitted operations array as compliant/distinct (a) or
// compliant/padded (b). The distinctness heuristic: if the unique-word
// count across all ops is < 2x the op count, the model is padding (repeats
// or very short/dummy entries). Not perfect — manual review recommended for
// borderline cases — but catches obvious {"step 1", "step 2", "step 3"}
// style padding, which is the main concern.
function classifyDistinctness(ops: string[]): 'a' | 'b' {
  const words = new Set<string>();
  for (const op of ops) {
    for (const word of op.toLowerCase().split(/\s+/)) {
      if (word.length > 2) words.add(word);
    }
  }
  const uniqueWords = words.size;
  const threshold = ops.length * 2;
  return uniqueWords >= threshold ? 'a' : 'b';
}

async function runPrompt(
  router: ModelRouter,
  prompt: string,
): Promise<{ toolUses: { name: string; input: Record<string, unknown> }[]; text: string; error?: string }> {
  const messages: Message[] = [{ role: 'user', content: prompt }];
  const systemPrompt =
    'You have access to a TestBatch tool. Use it to structure multi-step answers. Do not respond with plain text if the task can be handled by a tool call.';

  const toolUses: { name: string; input: Record<string, unknown> }[] = [];
  let text = '';
  // Track the currently-building tool_use id so we can associate emitted
  // input chunks with the right call. Anthropic/OpenAI both stream tool_use
  // inputs as deltas followed by a terminal tool_use_end with the final
  // parsed input dict.
  let currentInput: Record<string, unknown> | null = null;
  let currentName: string | null = null;

  try {
    for await (const event of router.stream(messages, systemPrompt, [STUB_TOOL])) {
      const e = event as StreamEvent;
      if (e.type === 'text') {
        text += e.content;
      } else if (e.type === 'tool_use_start') {
        currentName = e.name;
      } else if (e.type === 'tool_use_end') {
        toolUses.push({ name: currentName ?? e.name ?? 'unknown', input: e.input });
        currentInput = null;
        currentName = null;
      } else if (e.type === 'done') {
        break;
      }
    }
    return { toolUses, text };
  } catch (err) {
    return {
      toolUses,
      text,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function classify(result: { toolUses: { name: string; input: Record<string, unknown> }[]; text: string; error?: string }): {
  mode: Mode;
  label: string;
  opCount: number;
  opsPreview: string[];
} {
  // Mode (c): API rejected the request (likely schema violation).
  // Anthropic returns 400 on minItems violation; other providers may vary.
  if (result.error) {
    return { mode: 'c', label: 'rejected by provider', opCount: 0, opsPreview: [] };
  }

  // Mode (d): no tool_use emitted — model text-responded instead.
  if (result.toolUses.length === 0) {
    return { mode: 'd', label: 'text-only (refused tool)', opCount: 0, opsPreview: [] };
  }

  const firstCall = result.toolUses.find((tu) => tu.name === 'TestBatch');
  if (!firstCall) {
    return { mode: 'd', label: 'called a different tool (or none)', opCount: 0, opsPreview: [] };
  }

  const ops = firstCall.input.operations;
  if (!Array.isArray(ops)) {
    return { mode: 'c', label: 'operations field missing or wrong type', opCount: 0, opsPreview: [] };
  }

  const opsList = ops.map((o) => (typeof o === 'string' ? o : JSON.stringify(o)));

  // Mode (c) also: compliant shape but < 3 ops somehow (shouldn't happen if
  // provider validated server-side, but handle defensively for passthrough
  // providers).
  if (opsList.length < 3) {
    return {
      mode: 'c',
      label: `only ${opsList.length} ops (schema violation got through)`,
      opCount: opsList.length,
      opsPreview: opsList,
    };
  }

  // Compliant — distinguish (a) real composition from (b) padding.
  const distinctnessMode = classifyDistinctness(opsList);
  return {
    mode: distinctnessMode,
    label: distinctnessMode === 'a' ? 'compliant + distinct' : 'compliant but padded',
    opCount: opsList.length,
    opsPreview: opsList.slice(0, 3),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();

  const config = loadConfig(cwd);
  const router = new ModelRouter(config.models, config.experimental);

  if (args.model) {
    try {
      router.setModel(args.model);
    } catch (err) {
      console.error(`Failed to override model: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  }

  const activeModel = router.current.model;
  const activeProvider = router.current.name;
  console.log(`Running compliance smoke against: ${activeProvider} · ${activeModel}`);
  console.log('');

  const observations: Observation[] = [];
  const tally: Record<Mode, number> = { a: 0, b: 0, c: 0, d: 0 };

  for (const p of PROMPTS) {
    process.stdout.write(`  [${p.id}] (${p.natural}) ... `);
    const result = await runPrompt(router, p.prompt);
    const { mode, label, opCount, opsPreview } = classify(result);
    tally[mode] += 1;
    observations.push({
      id: p.id,
      natural: p.natural,
      mode,
      mode_label: label,
      op_count: opCount,
      ops_preview: opsPreview,
      error: result.error,
    });
    console.log(`mode ${mode} (${label}, ${opCount} ops)`);
  }

  console.log('');
  console.log('── Tally ──────────────────────────────');
  console.log(`  (a) compliant, distinct:        ${tally.a} / ${PROMPTS.length}`);
  console.log(`  (b) compliant, padded:          ${tally.b} / ${PROMPTS.length}`);
  console.log(`  (c) schema violation / reject:  ${tally.c} / ${PROMPTS.length}`);
  console.log(`  (d) refused tool (text-only):   ${tally.d} / ${PROMPTS.length}`);
  console.log('');

  console.log('── Per-prompt ─────────────────────────');
  for (const o of observations) {
    const preview = o.ops_preview.length
      ? ' → ' + o.ops_preview.map((s) => (s.length > 50 ? s.slice(0, 50) + '…' : s)).join(' | ')
      : '';
    console.log(`  [${o.id}] ${o.natural.padEnd(10)} mode=${o.mode} ${o.mode_label}${preview}`);
    if (o.error) console.log(`    error: ${o.error}`);
  }
  console.log('');

  // Emit machine-readable JSON summary on the last line for piping/parsing.
  const summary = {
    model: activeModel,
    provider: activeProvider,
    tally,
    observations,
  };
  console.log('── JSON summary (last line) ───────────');
  console.log(JSON.stringify(summary));
}

main().catch((err) => {
  console.error('Fatal:', err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
