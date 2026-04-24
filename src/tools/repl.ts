/**
 * Repl tool — lets the model execute Python in the body subprocess.
 *
 * Schema is structurally composed: the model submits {plan, operations[]}
 * where operations is an array of {purpose, code} entries. The harness
 * concatenates operations[].code into one Python block and executes as a
 * single batch. Single-op submissions are structurally impossible to emit —
 * the input_schema enforces minItems:2 at the tool-contract level, and all
 * three supported providers (Anthropic/OpenAI-compat/Google) validate
 * input_schema server-side before the tool_use reaches us. This is the
 * structural attack on Repl fragmentation — prior prose-level discipline
 * (2026-04-05 budget experiment: 2/6 → 0/6) did not work; schema-level
 * enforcement is trained tool-use behavior in frontier models.
 */
import type { Tool, ToolContext } from './types.js';
import type { ToolDefinition, ToolResult } from '../router/types.js';
import type { ReplHandle } from '../repl/setup.js';

// ── Repl tool description — the structural teaching channel ──────────────
// Why this description is long and example-heavy: the `description` field
// is part of the tool schema, which every provider (Anthropic, OpenAI-
// compat, OpenRouter, Google) sends to the model on every request BEFORE
// the model emits any tool_use. It lives in the cached prefix, so it costs
// nothing per turn after cache warms. A prompt paragraph describing the
// same thing is soft (ignorable, not provider-uniform, not cache-aligned);
// a packed tool description is structural (part of the contract, seen
// first-turn, cross-model, cached).
//
// The examples matter more than the prose. Models in-context-learn from
// patterns. Three composed examples + one anti-pattern teach what real
// multi-op Python batches look like. Every example uses the {plan, ops}
// shape because that's now the only valid submission.
//
// Keep in sync with the namespace registered in body/server.py's
// _build_namespace and with the first-turn banner in _format_first_turn_banner.

const REPL_DESCRIPTION = `Execute a batch of composed Python operations in your persistent namespace. State (variables, computations) survives across Repl calls and across ops within the same batch.

Pre-loaded primitives: codebase, vault, fs, shell, web, rlm_call, rlm_batch, say, ask, done, json, os.path, reindex. All namespace primitives return structured, schema-stable output — chain them aggressively and access fields directly (result['field']) without intermediate print() probes. The first Repl call in a session returns a banner listing exactly what's loaded.

## How to submit

You do NOT submit raw code. You submit {plan, operations}:
- plan: one sentence describing what this batch accomplishes end-to-end (≥60 characters — write a real plan, not a placeholder)
- operations: array of 2+ {purpose, code} entries (minimum 2, max 20 per batch)
  - purpose: short label for this step (≥8 characters — "read file" is fine, "step 1" is not)
  - code: the actual Python for this step (≥10 characters)

The harness concatenates operations[].code into one Python block with a # op: <purpose> header comment above each, then executes as one batch. Variables set in op N are visible in op N+1 because they run in the same Python namespace. Use control flow (for/if/try/def/comprehension) inside any op.

## The shape that wins

Before you emit the batch, write the whole task as one coherent Python script, then split it into labeled operations. If the task needs 4 reads + 1 summary, that's 5 operations. If it needs 1 search + 3 reads + 1 edit + 1 say, that's 6 operations. Don't submit a 2-op batch that does minimal work just to satisfy the floor — write the real operations. The model that composes in 1 batch of 5 ops lands tasks in 1/N the turns and 1/N the tokens vs N sequential calls.

Use done(value) as the last op when you have the final answer in hand and want to commit cleanly. say(text) emits user-visible output; done(value) signals turn termination with the committed value preserved in the trace.

## Examples

# Example: search → read top 3 → parallel summarize
{
  "plan": "Find the auth middleware across the repo, read the top three candidate files, and summarize each in parallel.",
  "operations": [
    {"purpose": "search repo", "code": "hits = codebase.search('auth middleware', limit=20)"},
    {"purpose": "take top 3", "code": "top = hits[:3]"},
    {"purpose": "batch-read + ask rlm", "code": "pairs = [(fs.read(h['file']), 'what does this file do?') for h in top]\\nsummaries = rlm_batch(pairs)"},
    {"purpose": "emit per-file summary", "code": "for h, s in zip(top, summaries):\\n    say(f\\"{h['file']}: {s}\\")"},
    {"purpose": "commit result",  "code": "done({'files': [h['file'] for h in top]})"}
  ]
}

# Example: verify-then-edit
{
  "plan": "Read src/auth.ts, verify the target pattern exists, apply the replacement, confirm to the user.",
  "operations": [
    {"purpose": "read file", "code": "content = fs.read('src/auth.ts')"},
    {"purpose": "verify target", "code": "assert 'oldPattern' in content, 'target not present'"},
    {"purpose": "apply edit", "code": "fs.edit('src/auth.ts', 'oldPattern', 'newPattern')"},
    {"purpose": "confirm", "code": "say('Edited src/auth.ts — 1 replacement.')"}
  ]
}

# Example: walk a vault region → read top hit → extract thesis via rlm_call
{
  "plan": "Explore a vault region for the top hit, read the note, extract the thesis with rlm_call, and commit the answer.",
  "operations": [
    {"purpose": "explore region", "code": "hits = vault.explore('codemode paradigm', depth=2, limit=5)"},
    {"purpose": "read top hit",   "code": "top = hits['results'][0]; note = vault.read(top['path'])"},
    {"purpose": "extract thesis", "code": "thesis = rlm_call(note, 'What is the core thesis in one sentence?')"},
    {"purpose": "report",         "code": "say(f\\"Recall: {top['title']} — {thesis}\\")"},
    {"purpose": "commit",         "code": "done({'title': top['title'], 'thesis': thesis})"}
  ]
}

Anti-pattern: submitting a 2-op batch of [{purpose: "step 1", code: "x = 1"}, {purpose: "step 2", code: "print(x)"}] to satisfy the floor. That's schema-gaming, not composition. Write real operations that do real work. If the task only needs one action + a report, do one action + say(report) — two ops, both substantive.

Restrictions: no imports (namespace pre-loads what you need — use os.path.join etc. directly), no eval/exec/open, no dunder attribute access.`;

// ── Teaching error messages for client-side validation ────────────────────
// The input_schema enforces these constraints at the provider API layer.
// Client-side validation here is belt-and-suspenders — it catches edge
// cases the provider might miss and gives the model a teaching message
// rather than a generic schema-rejection.

function rejectPlan(reason: string): ToolResult {
  return {
    id: '',
    name: 'Repl',
    output: `Repl rejected: plan field ${reason}. Write one sentence (≥60 chars) describing what this batch accomplishes end-to-end. Not a placeholder — a real plan. Example: "Find the auth middleware across the repo, read the top three candidate files, and summarize each." Resubmit with a real plan.`,
    isError: true,
  };
}

function rejectOperations(reason: string): ToolResult {
  return {
    id: '',
    name: 'Repl',
    output: `Repl rejected: operations field ${reason}. Submit an array of at least 2 {purpose, code} entries. Each purpose must be ≥8 chars, each code must be ≥10 chars. Don't fragment across multiple Repl calls — compose the operations in one batch. If your task is minimal (one action + a confirmation), that's still 2 ops: [{purpose: "do the thing", code: "..."}, {purpose: "confirm", code: "say(...)"}].`,
    isError: true,
  };
}

function rejectOp(index: number, reason: string): ToolResult {
  return {
    id: '',
    name: 'Repl',
    output: `Repl rejected: operations[${index}] ${reason}. Each op needs a descriptive purpose (≥8 chars) and real Python code (≥10 chars). Resubmit with substantive ops — don't pad with placeholder text.`,
    isError: true,
  };
}

// ── Input repair shim (Batch 1.7 — 2026-04-23) ────────────────────────
// Frontier models occasionally emit broken input shapes on first batch
// of a session — Opus's own diagnosis called this "jammed the operations
// array into the wrong JSON field; pure model serialization noise on a
// complex nested schema." The rejection path works as a teaching signal
// but costs a round-trip. Repair-then-run-with-note is better: the work
// ships AND the model sees what the correct shape should have been.
//
// repairInput runs BEFORE the client-side validation in execute(). On a
// match, it returns the repaired input plus a human-readable note that
// gets appended to the eventual tool_result output. If no repair
// matches, un-repairable inputs fall through to the existing rejection
// path unchanged. Zero risk to well-formed submissions — they hit the
// early `no-repair-needed` branch and short-circuit.
//
// Repair cases (first-match wins):
//   1. Pre-Stream-A `{code: "..."}` — wraps into {plan, operations} with
//      one real op + one confirm op (pads to minItems=2).
//   2. `{plan, code}` — code at root instead of in operations[0]. Moves
//      it into operations with the same pad.
//   3. `{plan, operations: "[...json...]"}` — operations double-serialized
//      as a JSON string. JSON.parse it into a real array.
//   4. `{plan, ops: [...]}` — wrong key name ("ops" vs "operations").
//      Rename in place.
//   5. Valid shape but some ops lack `purpose` — synthesize from the
//      op's leading `# comment` or generate from position + first line.
//
// Cases deliberately NOT repaired:
//   - Genuine 1-op submissions (`{plan, operations: [<one op>]}`). Padding
//     to 2 ops on the harness side would defeat the schema floor — the
//     minItems=2 contract is how we structurally prevent fragmentation.
//     Let that hit the rejection path so the model learns to compose.

interface RepairResult {
  input: Record<string, unknown>;
  note: string | null;
}

function repairInput(input: Record<string, unknown>): RepairResult {
  // Already valid in shape terms — only repair nested ops if purpose is missing.
  if (typeof input.plan === 'string' && Array.isArray(input.operations)) {
    const ops = input.operations as Array<Record<string, unknown>>;
    const purposeMissing = ops.some(
      (op) =>
        op && typeof op === 'object' &&
        typeof op.code === 'string' && typeof op.purpose !== 'string',
    );
    if (!purposeMissing) return { input, note: null };
    const repairedOps = ops.map((op, i) => {
      if (op && typeof op === 'object' && typeof op.code === 'string' && typeof op.purpose !== 'string') {
        const firstLine = (op.code as string).split('\n', 1)[0].trim();
        const fromComment = firstLine.startsWith('#')
          ? firstLine.replace(/^#+\s*/, '').trim()
          : '';
        const synth =
          fromComment.length >= 8
            ? fromComment.slice(0, 60)
            : `step ${i + 1}: ${firstLine.slice(0, 40) || 'run'}`;
        return { ...op, purpose: synth };
      }
      return op;
    });
    return {
      input: { ...input, operations: repairedOps },
      note: "synthesized missing `purpose` fields from op leading comments or positions — include `purpose` explicitly on each op next time",
    };
  }

  // Case 1: pre-Stream-A single `{code: "..."}` submission.
  if (
    typeof input.code === 'string' &&
    input.operations === undefined &&
    input.plan === undefined
  ) {
    const code = (input.code as string).trim();
    return {
      input: {
        plan: 'Execute the submitted Python block — input was repaired from the pre-Stream-A {code: ...} shape to {plan, operations}.',
        operations: [
          { purpose: 'execute submitted code', code },
          { purpose: 'confirm completion', code: "say('ok — repaired from single-code submission')" },
        ],
      },
      note: "repaired from pre-Stream-A `{code: ...}` shape. Submit {plan, operations: [{purpose, code}, ...]} with ≥2 substantive ops next time; composed work is why this harness exists.",
    };
  }

  // Case 2: `{plan, code}` — plan present but code at root (no operations).
  if (
    typeof input.plan === 'string' &&
    typeof input.code === 'string' &&
    input.operations === undefined
  ) {
    return {
      input: {
        plan: input.plan,
        operations: [
          { purpose: 'execute submitted code', code: input.code as string },
          { purpose: 'confirm completion', code: "say('ok — repaired from plan+code shape')" },
        ],
      },
      note: "moved `code` at root into operations[0] — submit code INSIDE the operations array as {purpose, code} entries, not at the input root",
    };
  }

  // Case 3: `{plan, operations: "[json...]"}` — operations stringified.
  if (typeof input.plan === 'string' && typeof input.operations === 'string') {
    try {
      const parsed = JSON.parse(input.operations);
      if (Array.isArray(parsed)) {
        return {
          input: { ...input, operations: parsed },
          note: "JSON-parsed a stringified operations value — submit operations as a raw JSON array, not a JSON-encoded string",
        };
      }
    } catch {
      // Fall through to rejection — un-parseable string isn't something
      // we can reasonably repair.
    }
  }

  // Case 4: `{plan, ops: [...]}` — wrong key name.
  if (
    typeof input.plan === 'string' &&
    Array.isArray((input as Record<string, unknown>).ops) &&
    input.operations === undefined
  ) {
    const renamed = { ...input, operations: (input as Record<string, unknown>).ops };
    delete (renamed as Record<string, unknown>).ops;
    return {
      input: renamed,
      note: "renamed `ops` to `operations` — the field must be called `operations` (plural, full word)",
    };
  }

  // No repair matched — let the existing validation path reject.
  return { input, note: null };
}

export class ReplTool implements Tool {
  readonly name = 'Repl';
  readonly description = REPL_DESCRIPTION;
  readonly readOnly = false;

  constructor(private getHandle: () => ReplHandle | null) {}

  definition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: 'object',
        properties: {
          plan: {
            type: 'string',
            description:
              'One sentence (≥60 chars) describing what this batch accomplishes end-to-end. Write a real plan, not a placeholder.',
            minLength: 60,
          },
          operations: {
            type: 'array',
            description:
              'At least 2 {purpose, code} entries. Harness concatenates operations[].code into one Python block with a # op: <purpose> header per op; variables persist across ops within the batch.',
            minItems: 2,
            maxItems: 20,
            items: {
              type: 'object',
              properties: {
                purpose: {
                  type: 'string',
                  description:
                    'Short label for this step (≥8 chars). E.g., "read file", "apply edit", "emit summary". Not "step 1".',
                  minLength: 8,
                },
                code: {
                  type: 'string',
                  description:
                    'Python code for this step (≥10 chars). Use control flow inside an op; reference vars set in prior ops.',
                  minLength: 10,
                },
              },
              required: ['purpose', 'code'],
            },
          },
        },
        required: ['plan', 'operations'],
      },
    };
  }

  async execute(
    rawInput: Record<string, unknown>,
    _ctx: ToolContext,
  ): Promise<ToolResult> {
    const handle = this.getHandle();
    if (!handle) {
      return {
        id: '',
        name: this.name,
        output: 'REPL not available. Set `repl.enabled: true` in config and restart.',
        isError: true,
      };
    }

    // ── Input repair (Batch 1.7) ────────────────────────────────────────
    // Runs BEFORE schema validation. Common model serialization jitter
    // (pre-Stream-A {code: ...} shape, stringified operations, wrong key
    // name, missing purpose) gets auto-fixed and a teaching note is
    // appended to the tool_result. Un-repairable shapes fall through to
    // the existing rejection path unchanged. See repairInput() header
    // for the full case list + rationale on what we deliberately do NOT
    // repair (1-op submissions — padding would defeat the schema floor).
    const { input, note: repairNote } = repairInput(rawInput);
    if (repairNote && _ctx.log && _ctx.toolUseId) {
      _ctx.log({
        type: 'input_repaired',
        tool_use_id: _ctx.toolUseId,
        note: repairNote,
        timestamp: Date.now(),
      });
    }

    // ── Validate {plan, operations} shape ──────────────────────────────
    // The provider API rejects schema violations server-side, so most
    // invalid submissions never reach here. These client-side checks
    // are the safety net for (a) providers with lax server-side
    // validation and (b) edge cases the schema can't express (all-blank
    // purposes that technically satisfy minLength via whitespace, etc).
    const plan = input.plan;
    if (typeof plan !== 'string') return rejectPlan('missing or not a string');
    if (plan.trim().length < 60) return rejectPlan(`is ${plan.trim().length} chars, need ≥60`);

    const ops = input.operations;
    if (!Array.isArray(ops)) return rejectOperations('missing or not an array');
    if (ops.length < 2) return rejectOperations(`has ${ops.length} entries, need ≥2`);
    if (ops.length > 20) return rejectOperations(`has ${ops.length} entries, max 20 per batch — split into multiple Repl calls if you genuinely need more`);

    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      if (!op || typeof op !== 'object') return rejectOp(i, 'is not an object');
      const { purpose, code: opCode } = op as { purpose?: unknown; code?: unknown };
      if (typeof purpose !== 'string') return rejectOp(i, 'missing purpose field');
      if (purpose.trim().length < 8) return rejectOp(i, `purpose is ${purpose.trim().length} chars, need ≥8`);
      if (typeof opCode !== 'string') return rejectOp(i, 'missing code field');
      if (opCode.trim().length < 10) return rejectOp(i, `code is ${opCode.trim().length} chars, need ≥10`);
    }

    // ── Concatenate ops into one Python block ──────────────────────────
    // Each op gets a `# op: <purpose>` header comment so AST walkers and
    // exception tracebacks can attribute failures to specific ops. Double
    // newline between ops keeps the AST clean (each op's statements are
    // top-level in the combined block, not accidentally nested).
    const typedOps = ops as Array<{ purpose: string; code: string }>;
    const code = typedOps
      .map((op) => `# op: ${op.purpose}\n${op.code}`)
      .join('\n\n');

    // ── Client-side lint on the concatenated code ──────────────────────
    // The AST guard on the Python side rejects these too, but catching
    // locally saves a bridge round-trip and produces teaching messages.
    //
    // History: the earlier version of this rejection message omitted half
    // the bound names (said nothing about json/say/ask/shell/web/reindex)
    // and explicitly asserted "stdlib is not available" — which is false
    // because body/server.py:231 binds `json` directly into the namespace.
    // A10 caught the drift: model typed `import json`, got rejected, saw
    // "stdlib not available," worked around a module that was already
    // there. The message must stay in sync with _build_namespace. If you
    // add or remove a bound name in body/server.py, update this list too.
    const importMatch = code.match(/^\s*(?:import|from)\s+[\w.]+/m);
    if (importMatch) {
      return {
        id: '',
        name: this.name,
        output: `Repl rejected: imports are forbidden (you wrote "${importMatch[0].trim()}"). The Repl namespace is PRE-LOADED — use these objects directly, no import needed:\n  - fs.read / fs.listdir / fs.glob / fs.write / fs.edit / fs.patch\n  - shell.run(cmd, timeout=30, cwd=None)\n  - web.fetch(url) / web.search(query)\n  - codebase.search / find_symbol / get_context / show_dependents / communities / find_convention\n  - vault.top(q, n) / vault.explore(q) — retrieval + mapping defaults\n  - vault.neighbors(title) / vault.backlinks(title) / vault.meta(title) — precision traversal\n  - vault.read(path) / vault.get_note(title) / vault.add(title, content) / vault.orient\n  - vault.query_ranked / query_warmth / query_similar / query_important / query_fading — escape hatches\n  - research.plan / read / extract / synthesize / save\n  - rlm_call(slice, question) / rlm_batch([...])\n  - say(text) / ask(question) — user-visible I/O\n  - done(value) — commit final answer and terminate the turn\n  - json — pre-bound module (json.loads, json.dumps) — do NOT import it\n  - os.path — pre-bound (os.path.join, os.path.normpath, os.path.basename, etc.) — do NOT import os\n  - reindex(path) — re-point the codebase graph\nUse help(name) to see the API for any primitive — help(fs), help(vault.top), etc.\nResubmit WITHOUT the import. Every stdlib path you'd normally reach for has a namespace primitive above.`,
        isError: true,
      };
    }

    // TypeScript syntax sneaking into Python Repl (Sonnet does this occasionally).
    // Runs on the concatenated code so TS that snuck into any op is caught.
    if (/^\s*(?:const|let|var|function|interface|type)\s+\w+/m.test(code)) {
      return {
        id: '',
        name: this.name,
        output: `Repl rejected: one of your ops looks like TypeScript/JavaScript. The Repl runs Python. Rewrite using Python syntax (def not function, = not const, dict not interface, etc).`,
        isError: true,
      };
    }

    const result = await handle.exec({ code }, _ctx.signal);

    // ── Telemetry: shape + done events, plus turn-stats aggregation ─────
    // Fires BEFORE the rejection/timeout short-circuits so we capture
    // shape data even for rejected execs — micro-batch rejections are
    // themselves telemetry-worthy. Skip only if logger/correlation
    // context is missing (manual invocation paths, tests).
    const shape = result.shape;
    if (_ctx.log && _ctx.toolUseId && shape) {
      _ctx.log({
        type: 'repl_shape',
        tool_use_id: _ctx.toolUseId,
        stmt_count: shape.stmt_count,
        distinct_primitive_count: shape.distinct_primitive_count,
        total_primitive_call_count: shape.total_primitive_call_count,
        has_for_or_while: shape.has_for_or_while,
        has_if: shape.has_if,
        has_def: shape.has_def,
        has_try: shape.has_try,
        has_comprehension: shape.has_comprehension,
        is_micro_repl: shape.is_micro_repl,
        is_composed: shape.is_composed,
        primitives_called: shape.primitives_called,
        parse_error: shape.error,
        timestamp: Date.now(),
      });
    }
    if (_ctx.log && _ctx.toolUseId && result.done) {
      _ctx.log({
        type: 'done_committed',
        tool_use_id: _ctx.toolUseId,
        value: result.done.value,
        timestamp: Date.now(),
      });
    }
    if (_ctx.turnStats) {
      _ctx.turnStats.replCalls += 1;
      if (shape?.is_composed) _ctx.turnStats.anyComposed = true;
      if (shape?.is_micro_repl) _ctx.turnStats.anyMicro = true;
      if (result.done) _ctx.turnStats.committed = true;
    }

    if (result.rejected) {
      return {
        id: '',
        name: this.name,
        output: `AST guard rejected: ${result.rejected.reason}`,
        isError: true,
      };
    }

    if (result.timed_out) {
      return {
        id: '',
        name: this.name,
        output: `Timed out after ${result.duration_ms}ms`,
        isError: true,
      };
    }

    // Format output for the model
    const parts: string[] = [];
    if (result.stdout) parts.push(result.stdout.trimEnd());
    if (result.stderr) parts.push(`[stderr]\n${result.stderr.trimEnd()}`);
    if (result.exception) parts.push(`[exception]\n${result.exception.trimEnd()}`);

    const statsParts: string[] = [`${result.duration_ms}ms`, `${typedOps.length} ops`];
    if (result.rlm_stats && result.rlm_stats.call_count > 0) {
      statsParts.push(
        `${result.rlm_stats.call_count} rlm calls`,
        `${result.rlm_stats.total_tokens} tokens`,
      );
    }
    parts.push(`(${statsParts.join(' · ')})`);

    // Prepend the repair note so the model sees what the harness fixed
    // BEFORE reading the output. The note is a one-line teaching signal
    // — same ergonomic role as Batch 1.5's exception enrichment NOTE.
    const output = parts.join('\n\n') || '(no output)';
    const finalOutput = repairNote
      ? `NOTE: harness repaired input shape — ${repairNote}\n\n${output}`
      : output;

    return {
      id: '',
      name: this.name,
      output: finalOutput,
      isError: result.exception !== null,
    };
  }
}
