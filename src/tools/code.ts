/**
 * code tool — lets the model execute Python in the body subprocess.
 *
 * Schema: `{code: string}`. The `code` field is markdown-fenced cells (Pi/
 * Jupyter idiom) that the harness parses into a list of cells, each executed
 * independently in the same persistent namespace. Cells can carry metadata in
 * the opening fence: `id="..."` (label), `t="15s"` (timeout). The parser still
 * recognizes `rst=true` from an earlier design, but the bridge does not yet
 * implement kernel reset; do not advertise it as usable model-facing syntax.
 *
 * History:
 * - Pre-rebuild schema was `{plan, operations: [{purpose, code}]}` (custom
 *   JSON wrapping with separate plan + per-op purpose fields). Replaced
 *   with markdown cells because models are heavily trained on Jupyter
 *   notebooks; JSON wrapping was unnecessary friction. Cell `id` absorbs
 *   the `purpose` role; `plan` was dropped (it was redundant with the
 *   thinking block).
 * - 2026-05-02: a structured `plan: {goal, steps}` field with minItems:2
 *   was added back as an attempted structural composition fix. Reverted
 *   same day after the 10-call stub on Sonnet 4.6 (bench/plan-schema-stub.ts)
 *   showed Anthropic's API does NOT enforce minItems/minLength on tool
 *   input schemas — every emission was a 1-step plan and the API
 *   rubber-stamped it. Schema-level composition enforcement is dead at
 *   this layer. The structural composition fix that DID land:
 *   intent-routed banner in body/server.py + enriched fs.read in body/fs.py
 *   (smart-primitives angle). See note `smart-primitives-fix-...md`.
 * - Repair shim translates legacy `{plan, operations}` and the brief
 *   `{plan, code}` interlude → `{code}`. No data loss.
 * - Per-cell client-side checks: ≥4 char code minimum, language must be
 *   py/python (v1; js deferred), AST guards run server-side per-cell.
 */
import type { Tool, ToolContext } from './types.js';
import type { ToolDefinition, ToolResult } from '../router/types.js';
import type { ReplHandle } from '../repl/setup.js';
import type { ReplResult } from '../repl/types.js';
import { parseCells, legacyOpsToCellString, type ParsedCell } from './cellParser.js';

// ── code tool description ───────────────────────────────────────────────
// Lives in the cached prefix on every request — shorter = faster cache
// fill. Description teaches the technical contract; the system prompt
// teaches WHEN to compose; the first-turn banner teaches the namespace.
const CODE_DESCRIPTION = `Run Python in Aries' persistent code substrate using markdown-fenced cells.

Submit {code}. The \`code\` field is one or more fenced code blocks. Each opening fence carries metadata:
  \`\`\`py id="title" t="15s"

  - id="..."   cell label (shown in trace)
  - t="15s"    timeout (default 30s)

State persists across cells in one call AND across separate code calls.

**Synthesis is your text reply, not a code call.** After gathering data, write the synthesis as text and yield. Inside a cell, raw \`print()\` is diagnostic and may be capped/hidden from model-visible output; \`say(text)\` and \`done(value)\` are the intentional output channels. Use \`say()\` for model/user-visible observations and \`done()\` for committed results.

Pre-loaded: fs, shell, web, vault, codebase, api, state, ProjectSave, rlm_call, rlm_batch, say, ask, done, json, os.path, re, collections, itertools, math, datetime, random, statistics, display, print. Use api.stub(), api.describe(name), and api.costs() for live namespace inspection. Use state.* for durable cross-phase handoff. On error, the traceback identifies the failing cell.

Restrictions: no imports, no eval/exec/open, no dunder access.`;

// ── Teaching error messages ───────────────────────────────────────────────

function rejectCode(reason: string): ToolResult {
  return {
    id: '',
    name: CODE_TOOL_NAME,
    output: `code rejected: code field ${reason}. Submit a string containing one or more markdown-fenced cells:\n\n\`\`\`py id="step1"\n# python code here\n\`\`\``,
    isError: true,
  };
}

function rejectParse(reason: string): ToolResult {
  return {
    id: '',
    name: CODE_TOOL_NAME,
    output: `code rejected: ${reason}\n\nFormat reminder:\n\n\`\`\`py id="<title>" t="15s"\n# python code here\n\`\`\`\n\nMultiple cells supported. Cells share state.`,
    isError: true,
  };
}

function rejectCell(index: number, id: string | undefined, reason: string): ToolResult {
  const label = id ? `"${id}" ` : '';
  return {
    id: '',
    name: CODE_TOOL_NAME,
    output: `code rejected: cell ${index} ${label}${reason}.`,
    isError: true,
  };
}

// ── TS-shape detector (restored 2026-04-26 with string-literal pre-pass) ──
// History: this detector existed → was removed 2026-04-25 because the regexes
// false-positived on TS content INSIDE Python string literals (fs.write call
// bodies, triple-quoted blocks, raw strings holding `=>`). The fix was
// always the same: strip Python string contents before running TS patterns.
// This restores the detector with that pre-pass.
//
// Why keep the detector at all (instead of letting Python's SyntaxError
// teach): the intercept fires BEFORE the body subprocess executes the op.
// That kills the round-trip where the model writes 50 lines of TS, the
// body parses and SyntaxErrors, the model reads the traceback, retries.
// A fast pre-execution intercept routes the model to fs.read/fs.edit on
// the first attempt — same teaching content, one fewer bridge round-trip.
function stripPythonStringsAndComments(code: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, ' ');
  return code
    .replace(/"""[\s\S]*?"""/g, blank)
    .replace(/'''[\s\S]*?'''/g, blank)
    .replace(/"(?:\\.|[^"\\\n])*"/g, blank)
    .replace(/'(?:\\.|[^'\\\n])*'/g, blank)
    .replace(/#[^\n]*/g, blank);
}

function looksLikeTypeScriptOrJavaScript(code: string): boolean {
  const stripped = stripPythonStringsAndComments(code);
  const tsPatterns = [
    // ES imports are TS/JS, but plain `import json` and
    // `from collections import Counter` are Python. Let the import-specific
    // lint below explain those instead of misrouting them through the
    // TS/JS repair path.
    /^\s*import\s+type\b/m,
    /^\s*import\s*[{*]/m,
    /^\s*import\s+\w+(?:\s*,\s*[{*\w][^;\n]*)?\s+from\s+['"]/m,
    /^\s*import\s+['"]/m,
    /^\s*export\s+(?:type\s+|interface\s+|class\s+|const\s+|function\s+)/m,
    /^\s*(?:const|let|var|function|interface|type)\s+\w+/m,
    /^\s*(?:async\s+)?function\s+\w+\s*\(/m,
    /^\s*\w+\s*:\s*(?:string|number|boolean|unknown|Record<|Array<|\w+\[\])/m,
    /=>/,
  ];
  return tsPatterns.some((pattern) => pattern.test(stripped));
}

function stripFirstTurnBanner(stdout: string): { stdout: string; stripped: boolean } {
  if (!stdout.startsWith('=== Aries body ready ===')) {
    return { stdout, stripped: false };
  }

  const lines = stdout.split('\n');
  const shapesIdx = lines.findIndex((line) => line.trim() === 'Shapes:');
  const anchorIdx = shapesIdx >= 0
    ? shapesIdx
    : lines.findIndex((line) => line.startsWith('State persists across code calls.'));
  if (anchorIdx < 0) {
    return { stdout: '', stripped: true };
  }

  const blankAfterBanner = lines.findIndex((line, idx) => idx > anchorIdx && line.trim() === '');
  if (blankAfterBanner < 0) {
    return { stdout: '', stripped: true };
  }

  return {
    stdout: lines.slice(blankAfterBanner + 1).join('\n'),
    stripped: true,
  };
}

const BANNER_STRIPPED_NOTE =
  '[Aries namespace banner omitted from model-visible output. Inspect the live API with api.stub(), api.describe(name), api.costs().]';

type CodeIoMode = 'normal' | 'commit';

function codeIoMode(): CodeIoMode {
  const raw = (process.env.ARIES_CODE_IO_MODE ?? '').trim().toLowerCase();
  // Commit mode is now the default substrate contract: print() is diagnostic
  // noise, say()/done() are the intentional channels. Keep explicit escape
  // hatches for debugging old traces without making the daily-driver path
  // opt-in again.
  return raw === 'normal' || raw === 'verbose' || raw === 'debug' ? 'normal' : 'commit';
}

function codeDebugStdoutChars(): number {
  const raw = Number(process.env.ARIES_CODE_DEBUG_STDOUT_CHARS ?? '0');
  if (!Number.isFinite(raw) || raw < 0) return 0;
  return Math.floor(raw);
}

function tail(text: string, maxChars: number): string {
  if (maxChars <= 0 || text.length <= maxChars) return text;
  return text.slice(text.length - maxChars);
}

function formatUnknown(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    const json = JSON.stringify(value, null, 2);
    return json ?? String(value);
  } catch {
    return String(value);
  }
}

// ── Input repair shim ────────────────────────────────────────────────────
// Catches model serialization jitter. Pre-cell shapes get translated into a
// `code` string with cell syntax. Repair adds a teaching note to the result.
//
// Cases (first-match wins):
//   1. Legacy `{plan, operations: [{purpose, code}]}` → markdown cells
//   2. Legacy `{plan, operations}` with stringified operations → parse + cells
//   3. Legacy `{plan, ops: [...]}` (wrong key) → cells
//   4. Pre-Stream-A `{code: "..."}` already cells-shaped → no-op (validated)
//   5. `{code, plan}` with both → strip plan, keep code
//   6. `{operations: [...]}` without plan → cells (synthesizes plan)
//
// All cases that produce cells log the legacy shape so we can track migration.

interface RepairResult {
  /** Repaired input — guaranteed to have `code: string` if note is non-null. */
  input: Record<string, unknown>;
  /** Teaching note appended to tool_result. null = no repair needed. */
  note: string | null;
}

function hasFencedCell(code: string): boolean {
  return /^```(?:py|python)?\b/m.test(code);
}

function rawCodeToCellString(code: string, id = 'step1'): string {
  return `\`\`\`py id="${id}"\n${code.trimEnd()}\n\`\`\``;
}

function repairInput(input: Record<string, unknown>): RepairResult {
  // Canonical shape: {code: string}. Pass through.
  if (typeof input.code === 'string' && input.plan === undefined && input.operations === undefined) {
    if (!hasFencedCell(input.code)) {
      return {
        input: { code: rawCodeToCellString(input.code) },
        note: 'wrapped legacy raw `{code}` string into a markdown Python cell. Going forward, submit fenced cells directly.',
      };
    }
    return { input, note: null };
  }

  // {code, plan: ...} — plan field was tried 2026-05-02 and reverted same
  // day after the 10-call stub showed Anthropic's API doesn't enforce
  // minItems/minLength on tool inputs (model emitted 1-step plans, API
  // rubber-stamped them, no structural enforcement). Drop plan silently
  // so older clients/sessions don't break.
  if (typeof input.code === 'string' && (input.plan !== undefined) && input.operations === undefined) {
    if (!hasFencedCell(input.code)) {
      return {
        input: { code: rawCodeToCellString(input.code) },
        note: 'translated legacy `{plan, code}` shape into a markdown Python cell. Going forward, submit `{code: <markdown cells>}` directly.',
      };
    }
    return { input: { code: input.code }, note: null };
  }

  // Case 1: legacy {plan, operations: [{purpose, code}]}
  if (Array.isArray(input.operations)) {
    const ops = input.operations as Array<Record<string, unknown>>;
    const validOps = ops.filter(
      (op): op is { purpose?: string; code: string } =>
        op != null && typeof op === 'object' && typeof op.code === 'string',
    );
    if (validOps.length > 0) {
      return {
        input: { code: legacyOpsToCellString(validOps) },
        note: "translated legacy `{plan, operations}` shape into markdown cells. Going forward, submit `{code: <markdown cells>}` directly: ```py id=\"step1\"\\n<code>\\n``` (one or more cells).",
      };
    }
  }

  // Case 2: stringified operations
  if (typeof input.operations === 'string') {
    try {
      const parsed = JSON.parse(input.operations);
      if (Array.isArray(parsed)) {
        const validOps = parsed.filter(
          (op): op is { purpose?: string; code: string } =>
            op != null && typeof op === 'object' && typeof op.code === 'string',
        );
        if (validOps.length > 0) {
          return {
            input: { code: legacyOpsToCellString(validOps) },
            note: "JSON-parsed your stringified operations and translated to markdown cells. Submit `{code: <markdown cells>}` directly next time.",
          };
        }
      }
    } catch {
      /* fall through */
    }
  }

  // Case 3: {plan, ops: [...]} (wrong key name)
  if (Array.isArray((input as Record<string, unknown>).ops)) {
    const ops = (input as Record<string, unknown>).ops as Array<Record<string, unknown>>;
    const validOps = ops.filter(
      (op): op is { purpose?: string; code: string } =>
        op != null && typeof op === 'object' && typeof op.code === 'string',
    );
    if (validOps.length > 0) {
      return {
        input: { code: legacyOpsToCellString(validOps) },
        note: "renamed `ops` → `code` and translated to markdown cells. Submit `{code: <markdown cells>}` directly.",
      };
    }
  }

  // Case 6: {operations: [...]} without plan
  if (Array.isArray(input.operations) && input.plan === undefined) {
    const ops = input.operations as Array<Record<string, unknown>>;
    const validOps = ops.filter(
      (op): op is { purpose?: string; code: string } =>
        op != null && typeof op === 'object' && typeof op.code === 'string',
    );
    if (validOps.length > 0) {
      return {
        input: { code: legacyOpsToCellString(validOps) },
        note: "translated `{operations}` into markdown cells. Submit `{code: <markdown cells>}` directly.",
      };
    }
  }

  // No repair matched — let validation reject.
  return { input, note: null };
}

export const CODE_TOOL_NAME = 'code';

export class CodeTool implements Tool {
  readonly name = CODE_TOOL_NAME;
  readonly description = CODE_DESCRIPTION;
  readonly readOnly = false;

  constructor(private getHandle: () => ReplHandle | null) {}

  definition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: 'object',
        properties: {
          code: {
            type: 'string',
            description:
              'Markdown-fenced cells. Each cell opens with ```py id="<title>" t="<duration>" rst=<bool>. Body is Python code. Cells share state across the batch and across separate code calls.',
          },
        },
        required: ['code'],
      },
    };
  }

  async execute(rawInput: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const handle = this.getHandle();
    if (!handle) {
      return {
        id: '',
        name: this.name,
        output: 'code substrate not available. Set `repl.enabled: true` in config and restart.',
        isError: true,
      };
    }

    // ── Input repair (legacy shape compatibility) ─────────────────────────
    const { input, note: repairNote } = repairInput(rawInput);
    if (repairNote && _ctx.log && _ctx.toolUseId) {
      _ctx.log({
        type: 'input_repaired',
        tool_use_id: _ctx.toolUseId,
        note: repairNote,
        timestamp: Date.now(),
      });
    }

    // ── Validate {code} shape ──────────────────────────────────────────
    const code = input.code;
    if (typeof code !== 'string') {
      if (_ctx.log && _ctx.toolUseId) {
        const shape: Record<string, string> = {};
        for (const [k, v] of Object.entries(rawInput)) {
          shape[k] = Array.isArray(v) ? `array(${v.length})` : typeof v;
        }
        _ctx.log({
          type: 'input_rejected',
          tool_use_id: _ctx.toolUseId,
          shape,
          timestamp: Date.now(),
        });
      }
      return rejectCode('missing or not a string');
    }
    if (code.trim().length < 1) {
      return rejectCode('is empty');
    }

    // ── Parse cells ─────────────────────────────────────────────────────
    const parseResult = parseCells(code);
    if (parseResult.error) {
      if (_ctx.log && _ctx.toolUseId) {
        _ctx.log({
          type: 'input_rejected',
          tool_use_id: _ctx.toolUseId,
          shape: { code: 'string', cells: `array(${parseResult.cells.length})`, parse_error: parseResult.error },
          timestamp: Date.now(),
        });
      }
      return rejectParse(parseResult.error);
    }
    const cells = parseResult.cells;
    if (cells.length > 20) {
      return rejectParse(`${cells.length} cells in one batch — max 20. Split into multiple code calls if you genuinely need more.`);
    }

    // Per-cell client-side validation
    for (const cell of cells) {
      if (cell.code.trim().length < 4) {
        return rejectCell(cell.index, cell.id, `code is ${cell.code.trim().length} chars, need ≥4`);
      }
    }

    // ── Per-cell execution ─────────────────────────────────────────────
    // Each cell runs independently via the bridge. Persistent namespace
    // across cells. If one fails, the rest still run.
    interface CellResult {
      cell: ParsedCell;
      stdout: string;
      stderr: string;
      exception: string | null;
      duration_ms: number;
      rejected: boolean;
      rejectedReason?: string;
      timed_out: boolean;
      lintError?: string;
      skipped?: boolean;
      done?: { value: unknown };
      say?: string[];
      rlm_stats?: ReplResult['rlm_stats'];
      shape?: ReplResult['shape'];
      bannerStripped?: boolean;
    }
    const cellResults: CellResult[] = [];
    let totalDuration = 0;
    const BATCH_TIMEOUT = 90_000;
    let anyError = false;

    for (const cell of cells) {
      // Batch timeout guard
      if (totalDuration >= BATCH_TIMEOUT) {
        cellResults.push({
          cell,
          stdout: '',
          stderr: '',
          exception: null,
          duration_ms: 0,
          rejected: false,
          timed_out: false,
          skipped: true,
        });
        continue;
      }

      // Per-cell client-side lint: TS/JS shape detection
      if (looksLikeTypeScriptOrJavaScript(cell.code)) {
        cellResults.push({
          cell,
          stdout: '',
          stderr: '',
          exception: null,
          duration_ms: 0,
          rejected: false,
          timed_out: false,
          lintError:
            'Looks like TypeScript/JavaScript. code runs Python. ' +
            'Use fs.read/fs.edit/fs.write from Python for TS file work, and ' +
            'shell.run("npm run typecheck") to validate. ' +
            'If you meant Python, rewrite with def (not function), = (not const), dict (not interface).',
        });
        anyError = true;
        continue;
      }

      // Per-cell client-side lint: import check
      const importMatch = cell.code.match(/^\s*(?:import|from)\s+[\w.]+/m);
      if (importMatch) {
        cellResults.push({
          cell,
          stdout: '',
          stderr: '',
          exception: null,
          duration_ms: 0,
          rejected: false,
          timed_out: false,
          lintError:
            `Imports are forbidden (you wrote "${importMatch[0].trim()}"). ` +
            'Use pre-loaded modules (json, os.path, re, collections, itertools, math, datetime, random, statistics) ' +
            'and namespace primitives. Inspect live names with api.stub().',
        });
        anyError = true;
        continue;
      }

      // TODO Batch 4+: per-cell `rst=true` should call a kernel-reset
      // bridge command before exec. For now, log the intent so we don't
      // silently drop the metadata; treat as no-op until body support lands.
      if (cell.reset && _ctx.log && _ctx.toolUseId) {
        _ctx.log({
          type: 'cell_reset_requested',
          tool_use_id: _ctx.toolUseId,
          cell_index: cell.index,
          cell_id: cell.id,
          timestamp: Date.now(),
        });
      }

      // Format cell code with header for output readability
      const cellHeader = cell.id
        ? `# cell ${cell.index}: ${cell.id}`
        : `# cell ${cell.index}`;
      const cellCode = `${cellHeader}\n${cell.code}`;

      let result: ReplResult;
      try {
        result = await handle.exec({ code: cellCode }, _ctx.signal);
      } catch (err) {
        const restartErr = err as { name?: string; restartReason?: string };
        if (restartErr?.name === 'BodyRestartedError') {
          cellResults.push({
            cell,
            stdout: '',
            stderr: '',
            exception: null,
            duration_ms: 0,
            rejected: false,
            timed_out: false,
            lintError:
              `[harness:restart] body became unresponsive and was restarted ` +
              `(reason: ${restartErr.restartReason ?? 'unknown'}). Bound state ` +
              `(project, vault, rlm config, codebase index) was preserved; ` +
              `Python namespace from prior code batches was reset. Retry ` +
              `this batch — subsequent cells in this same code call were ` +
              `skipped to avoid duplicating side effects on a fresh body.`,
          });
          anyError = true;
          break;
        }
        throw err;
      }

      if (result.exception || result.rejected || result.timed_out) {
        anyError = true;
      }
      totalDuration += result.duration_ms;

      const sanitizedStdout = stripFirstTurnBanner(result.stdout);

      cellResults.push({
        cell,
        stdout: sanitizedStdout.stdout,
        stderr: result.stderr,
        exception: result.exception,
        duration_ms: result.duration_ms,
        rejected: result.rejected !== null,
        rejectedReason: result.rejected?.reason,
        timed_out: result.timed_out,
        done: result.done,
        say: result.say_texts ?? [],
        rlm_stats: result.rlm_stats,
        shape: result.shape,
        bannerStripped: sanitizedStdout.stripped,
      });
    }

      // â”€â”€ Telemetry: plan field (composition experiment) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      // Log the plan object when present so we can correlate step count
      // with actual cells emitted. The plan is not evaluated by the harness;
      // it's chain-of-thought baked into the schema. Telemetry tells us
      // whether articulating steps actually produces composed calls.
      const plan = rawInput.plan as { goal?: string; steps?: string[] } | undefined;
      if (_ctx.log && _ctx.toolUseId && plan && typeof plan === 'object') {
        _ctx.log({
          type: 'repl_plan',
          tool_use_id: _ctx.toolUseId,
          goal: typeof plan.goal === 'string' ? plan.goal.slice(0, 200) : '',
          step_count: Array.isArray(plan.steps) ? plan.steps.length : 0,
          steps_preview: Array.isArray(plan.steps) ? plan.steps.map(s => String(s).slice(0, 80)) : [],
          cells_emitted: cells.length,
          timestamp: Date.now(),
        });
      }

      // â”€â”€ Telemetry: shape from first cell that returned shape data â”€â”€â”€â”€â”€â”€
      const firstShape = cellResults.find((r) => r.shape)?.shape;
      if (_ctx.log && _ctx.toolUseId && firstShape) {
        _ctx.log({
          type: 'repl_shape',
        tool_use_id: _ctx.toolUseId,
        ops_count: cells.length,
        stmt_count: firstShape.stmt_count,
        distinct_primitive_count: firstShape.distinct_primitive_count,
        total_primitive_call_count: firstShape.total_primitive_call_count,
        has_for_or_while: firstShape.has_for_or_while,
        has_if: firstShape.has_if,
        has_def: firstShape.has_def,
        has_try: firstShape.has_try,
        has_comprehension: firstShape.has_comprehension,
        is_micro_repl: firstShape.is_micro_repl,
        is_composed: firstShape.is_composed,
        primitives_called: firstShape.primitives_called,
        costs: firstShape.costs,
        effects: firstShape.effects,
        expensive_primitives: firstShape.expensive_primitives,
        parse_error: firstShape.error,
        timestamp: Date.now(),
      });
    }
    // done(): last-commit-wins across all cells
    const lastDone = [...cellResults].reverse().find((r) => r.done)?.done;
    if (_ctx.log && _ctx.toolUseId && lastDone) {
      _ctx.log({
        type: 'done_committed',
        tool_use_id: _ctx.toolUseId,
        value: lastDone.value,
        timestamp: Date.now(),
      });
    }
    if (_ctx.turnStats) {
      _ctx.turnStats.replCalls += 1;
      _ctx.turnStats.replCellCount += cells.length;  // accumulate across all code calls this turn
      if (firstShape?.is_composed) _ctx.turnStats.anyComposed = true;
      if (firstShape?.is_micro_repl) _ctx.turnStats.anyMicro = true;
      if (lastDone) _ctx.turnStats.committed = true;
    }

    // ── Format per-cell output ─────────────────────────────────────────
    const outputParts: string[] = [];
    let failedCount = 0;
    let totalRlmCalls = 0;
    let totalRlmTokens = 0;
    const costCounts: Record<string, number> = {};
    const effectCounts: Record<string, number> = {};
    const expensivePrimitiveCounts: Record<string, number> = {};
    const ioMode = codeIoMode();
    const debugStdoutChars = codeDebugStdoutChars();

    for (const r of cellResults) {
      const label = r.cell.id ? `${r.cell.index}: ${r.cell.id}` : `${r.cell.index}`;
      const header = r.skipped
        ? `# cell ${label} [skipped: batch timeout exceeded]`
        : r.lintError
          ? `# cell ${label} [lint error]`
          : `# cell ${label} (${r.duration_ms}ms)`;

      const parts: string[] = [header];

      if (r.lintError) {
        parts.push(r.lintError);
        failedCount++;
      } else if (r.skipped) {
        failedCount++;
      } else {
        if (r.bannerStripped) parts.push(BANNER_STRIPPED_NOTE);
        if (ioMode === 'commit') {
          // Commit-mode IO spike (2026-05-03): invert the model-visible
          // reward channel. Ordinary print() becomes diagnostic noise; say()
          // and done() are the only unbounded output paths. This is the
          // by-construction test for the "code is a REPL pretending to be a
          // program" failure mode: fragmented print/look/decide calls stop
          // returning useful observations unless the model intentionally
          // commits them with say()/done().
          if (r.say && r.say.length > 0) {
            parts.push(r.say.join('\n'));
          }
          if (r.done) {
            parts.push(`[done]\n${formatUnknown(r.done.value)}`);
          }
          if (r.stdout && debugStdoutChars > 0) {
            const stdout = r.stdout.trimEnd();
            const suffix = tail(stdout, debugStdoutChars);
            const label = stdout.length > debugStdoutChars
              ? `[debug stdout: last ${debugStdoutChars} chars]`
              : '[debug stdout]';
            parts.push(`${label}\n${suffix}`);
          }
        } else if (r.stdout) {
          parts.push(r.stdout.trimEnd());
        }
        if (r.stderr) parts.push(`[stderr]\n${r.stderr.trimEnd()}`);
        if (r.exception) {
          parts.push(`[exception]\n${r.exception.trimEnd()}`);
          failedCount++;
        }
        if (r.rejected) {
          parts.push(`AST guard rejected: ${r.rejectedReason}`);
          failedCount++;
        }
        if (r.timed_out) {
          parts.push(`Timed out after ${r.duration_ms}ms`);
          failedCount++;
        }
        if (r.rlm_stats && r.rlm_stats.call_count > 0) {
          totalRlmCalls += r.rlm_stats.call_count;
          totalRlmTokens += r.rlm_stats.total_tokens;
        }
        for (const [tier, count] of Object.entries(r.shape?.costs ?? {})) {
          costCounts[tier] = (costCounts[tier] ?? 0) + count;
        }
        for (const [effect, count] of Object.entries(r.shape?.effects ?? {})) {
          effectCounts[effect] = (effectCounts[effect] ?? 0) + count;
        }
        for (const primitive of r.shape?.expensive_primitives ?? []) {
          expensivePrimitiveCounts[primitive] = (expensivePrimitiveCounts[primitive] ?? 0) + 1;
        }
      }

      outputParts.push(parts.join('\n'));
    }

    // Footer with aggregate stats
    const footerParts: string[] = [`${totalDuration}ms total`, `${cells.length} cells`];
    if (failedCount > 0) footerParts.push(`${failedCount} failed`);
    if (totalRlmCalls > 0) footerParts.push(`${totalRlmCalls} rlm calls`, `${totalRlmTokens} tokens`);
    const nonLocalCosts = Object.entries(costCounts)
      .filter(([tier, count]) => tier !== 'local' && count > 0)
      .sort(([a], [b]) => a.localeCompare(b));
    if (nonLocalCosts.length > 0) {
      footerParts.push(`cost ${nonLocalCosts.map(([tier, count]) => `${tier}=${count}`).join(',')}`);
    }
    const notableEffects = ['write', 'exec', 'network', 'commit', 'prompt']
      .map((effect) => [effect, effectCounts[effect] ?? 0] as const)
      .filter(([, count]) => count > 0);
    if (notableEffects.length > 0) {
      footerParts.push(`effects ${notableEffects.map(([effect, count]) => `${effect}=${count}`).join(',')}`);
    }
    const expensivePrimitiveSummary = Object.entries(expensivePrimitiveCounts)
      .sort(([a], [b]) => a.localeCompare(b));
    if (expensivePrimitiveSummary.length > 0) {
      footerParts.push(`expensive ${expensivePrimitiveSummary.map(([name, count]) => `${name}x${count}`).join(',')}`);
    }
    outputParts.push(`(${footerParts.join(' · ')})`);

    const output = outputParts.join('\n\n') || '(no output)';
    const finalOutput = repairNote
      ? `NOTE: harness repaired input shape -- ${repairNote}\n\n${output}`
      : output;

    return {
      id: '',
      name: this.name,
      output: finalOutput,
      isError: anyError,
    };
  }
}
