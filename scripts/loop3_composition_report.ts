import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

type Json = Record<string, any>;

const READ_PRIMITIVES = new Set([
  'fs.read',
  'fs.glob',
  'codebase.search',
  'codebase.get_context',
  'codebase.map',
  'vault.search',
  'vault.top',
]);

const VERIFY_PRIMITIVES = new Set([
  'shell.run',
  'fs.read',
  'codebase.search',
]);

const LOW_VALUE_PRIMITIVES = new Set([
  'api.stub',
  'api.describe',
  'api.costs',
  'help',
]);

const COST_PER_M: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  'claude-opus-4-6': { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-haiku-4-5-20251001': { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
};

const DEFAULT_COST = COST_PER_M['claude-sonnet-4-6']!;

function readJsonl(path: string): Json[] {
  return readFileSync(path, 'utf-8')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      try {
        return JSON.parse(line) as Json;
      } catch (error) {
        return { type: 'parse_error', line: index + 1, error: String(error) };
      }
    });
}

function newestSessionPath(): string | null {
  const root = join(homedir(), '.aries', 'sessions');
  if (!existsSync(root)) return null;

  let newest: { path: string; mtimeMs: number } | null = null;
  for (const project of readdirSync(root)) {
    const dir = join(root, project);
    let stat;
    try {
      stat = statSync(dir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.jsonl')) continue;
      const path = join(dir, file);
      let fileStat;
      try {
        fileStat = statSync(path);
      } catch {
        continue;
      }
      if (!newest || fileStat.mtimeMs > newest.mtimeMs) {
        newest = { path, mtimeMs: fileStat.mtimeMs };
      }
    }
  }
  return newest?.path ?? null;
}

function primitiveList(event: Json): string[] {
  return Array.isArray(event.primitives_called)
    ? event.primitives_called.filter((p: unknown): p is string => typeof p === 'string')
    : [];
}

function usefulPrimitiveCount(event: Json): number {
  return primitiveList(event).filter((p) => !LOW_VALUE_PRIMITIVES.has(p)).length;
}

function hasStructuredDone(events: Json[]): boolean {
  return events.some((event) =>
    event.type === 'loop3_done_committed'
    && event.value_type !== 'string'
    && event.value_type !== 'undefined'
    && event.value_type !== 'null'
  );
}

function codeFor(toolUse: Json): string {
  return `${toolUse.code_head ?? ''}\n${toolUse.code_tail ?? ''}`;
}

function hasVariableReuse(code: string): boolean {
  const assigned = [...code.matchAll(/^\s*([A-Za-z_]\w*)\s*=/gm)]
    .map((match) => match[1])
    .filter((name): name is string => Boolean(name));
  for (const name of new Set(assigned)) {
    const uses = [...code.matchAll(new RegExp(`\\b${name}\\b`, 'g'))].length;
    if (uses >= 2) return true;
  }
  return false;
}

const PYTHON_KEYWORDS = new Set([
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break',
  'class', 'continue', 'def', 'del', 'elif', 'else', 'except', 'finally',
  'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal',
  'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield',
]);

const BUILTIN_OR_NAMESPACE_NAMES = new Set([
  'api', 'ask', 'bool', 'codebase', 'collections', 'datetime', 'dict', 'display',
  'done', 'enumerate', 'fs', 'help', 'int', 'itertools', 'json', 'len', 'list',
  'math', 'max', 'min', 'os', 'print', 'random', 'range', 're', 'rlm_batch',
  'rlm_call', 'say', 'set', 'shell', 'sorted', 'spanner', 'statistics', 'str',
  'sum', 'tuple', 'vault', 'web', 'plan',
]);

function assignedNames(code: string): Set<string> {
  const names = new Set<string>();
  for (const match of code.matchAll(/^\s*([A-Za-z_]\w*)\s*=/gm)) {
    if (match[1]) names.add(match[1]);
  }
  for (const match of code.matchAll(/^\s*for\s+([A-Za-z_]\w*)\s+in\b/gm)) {
    if (match[1]) names.add(match[1]);
  }
  for (const match of code.matchAll(/^\s*with\s+.+?\s+as\s+([A-Za-z_]\w*)\b/gm)) {
    if (match[1]) names.add(match[1]);
  }
  return names;
}

function referencedNames(code: string): Set<string> {
  const stripped = code
    .replace(/"""[\s\S]*?"""/g, ' ')
    .replace(/'''[\s\S]*?'''/g, ' ')
    .replace(/"(?:\\.|[^"\\])*"/g, ' ')
    .replace(/'(?:\\.|[^'\\])*'/g, ' ')
    .replace(/#[^\n]*/g, ' ');
  const refs = new Set<string>();
  for (const match of stripped.matchAll(/\b[A-Za-z_]\w*\b/g)) {
    const name = match[0];
    if (!PYTHON_KEYWORDS.has(name) && !BUILTIN_OR_NAMESPACE_NAMES.has(name)) {
      refs.add(name);
    }
  }
  return refs;
}

function crossCellReuse(codes: string[]): {
  cellsWithPriorStateAvailable: number;
  stateReuseCells: number;
  cellsWithoutReuseAfterAvailableState: number;
  reusedNames: string[];
} {
  const available = new Set<string>();
  const reused = new Set<string>();
  let cellsWithPriorStateAvailable = 0;
  let stateReuseCells = 0;

  for (const code of codes) {
    const refs = referencedNames(code);
    const usedPrior = [...refs].filter((name) => available.has(name));
    if (available.size > 0) cellsWithPriorStateAvailable++;
    if (usedPrior.length > 0) {
      stateReuseCells++;
      for (const name of usedPrior) reused.add(name);
    }
    for (const name of assignedNames(code)) available.add(name);
  }

  return {
    cellsWithPriorStateAvailable,
    stateReuseCells,
    cellsWithoutReuseAfterAvailableState: Math.max(0, cellsWithPriorStateAvailable - stateReuseCells),
    reusedNames: [...reused].sort(),
  };
}

function isPureProbe(shape: Json | undefined, toolUse: Json | undefined): boolean {
  if (!shape && !toolUse) return false;
  const primitives = shape ? primitiveList(shape) : [];
  const code = toolUse ? codeFor(toolUse) : '';
  const lowValueOnly = primitives.length === 0 || primitives.every((p) => LOW_VALUE_PRIMITIVES.has(p));
  const tinyShape = !shape || (shape.is_micro_repl === true && (shape.stmt_count ?? 0) <= 2);
  const probeCode = /\b(api\.stub|api\.describe|api\.costs|dir\(|help\(|print\()/m.test(code);
  return tinyShape && (lowValueOnly || probeCode);
}

function pct(numerator: number, denominator: number): string {
  if (denominator <= 0) return '0%';
  return `${Math.round((numerator / denominator) * 100)}%`;
}

function estimateCost(model: string, input: number, output: number, cacheRead: number, cacheWrite: number): number {
  const tier = COST_PER_M[model] ?? DEFAULT_COST;
  return (
    (input * tier.input / 1_000_000)
    + (output * tier.output / 1_000_000)
    + (cacheRead * tier.cacheRead / 1_000_000)
    + (cacheWrite * tier.cacheWrite / 1_000_000)
  );
}

function main(): void {
  const arg = process.argv[2];
  const sessionPath = arg ?? newestSessionPath();
  if (!sessionPath) {
    console.error('No session path provided and no ~/.aries/sessions/*.jsonl file found.');
    process.exit(1);
  }
  if (!existsSync(sessionPath)) {
    console.error(`Session not found: ${sessionPath}`);
    process.exit(1);
  }

  const events = readJsonl(sessionPath);
  const toolUses = events.filter((event) => event.type === 'loop3_tool_use');
  const shapes = events.filter((event) => event.type === 'loop3_repl_shape');
  const cells = Math.max(toolUses.length, shapes.length);
  const shapeByToolCall = new Map<string, Json>();
  for (const shape of shapes) {
    if (typeof shape.tool_call_id === 'string') shapeByToolCall.set(shape.tool_call_id, shape);
  }

  const perCell = toolUses.map((toolUse, index) => {
    const shape = typeof toolUse.tool_call_id === 'string'
      ? shapeByToolCall.get(toolUse.tool_call_id)
      : shapes[index];
    return { toolUse, shape };
  });

  const pureProbeCount = perCell.filter(({ shape, toolUse }) => isPureProbe(shape, toolUse)).length;
  const usefulOps = perCell.map(({ shape }) => shape ? usefulPrimitiveCount(shape) : 0);
  const totalUsefulOps = usefulOps.reduce((sum, count) => sum + count, 0);
  const batchedReadCells = perCell.filter(({ shape }) =>
    shape && primitiveList(shape).filter((p) => READ_PRIMITIVES.has(p)).length >= 2
  ).length;
  const batchedVerifyCells = perCell.filter(({ shape }) =>
    shape && primitiveList(shape).filter((p) => VERIFY_PRIMITIVES.has(p)).length >= 2
  ).length;
  const variableReuseCells = perCell.filter(({ toolUse }) => hasVariableReuse(codeFor(toolUse))).length;
  const crossReuse = crossCellReuse(perCell.map(({ toolUse }) => codeFor(toolUse)));
  const composedCells = shapes.filter((shape) => shape.is_composed === true).length;
  const microCells = shapes.filter((shape) => shape.is_micro_repl === true).length;
  const usage = events
    .filter((event) => event.type === 'usage')
    .reduce(
      (sum, event) => ({
        input: sum.input + (Number(event.inputTokens) || 0),
        output: sum.output + (Number(event.outputTokens) || 0),
        cacheRead: sum.cacheRead + (Number(event.cacheReadTokens) || 0),
        cacheWrite: sum.cacheWrite + (Number(event.cacheWriteTokens) || 0),
      }),
      { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    );
  const observedModel = events.find((event) => event.type === 'provider_event' && typeof event.model === 'string' && event.model.trim())?.model
    ?? events.find((event) => event.type === 'model_selected' && typeof event.model === 'string' && event.model.trim())?.model
    ?? events.find((event) => event.type === 'meta' && typeof event.model === 'string' && event.model.trim())?.model
    ?? 'claude-sonnet-4-6';
  const completion = [...events].reverse().find((event) => event.type === 'loop3_completion');
  const loop3Turns = events.filter((event) => event.type === 'loop3_turn_complete');
  const totalElapsedMs = loop3Turns.reduce((sum, event) => sum + (Number(event.elapsed_ms) || 0), 0);
  const activeElapsedMs = loop3Turns.reduce((sum, event) => {
    const elapsed = Number(event.elapsed_ms) || 0;
    const idle = Number(event.idle_ms) || 0;
    const active = Number(event.active_elapsed_ms);
    return sum + (Number.isFinite(active) && active > 0 ? active : Math.max(0, elapsed - idle));
  }, 0);
  const idleMs = loop3Turns.reduce((sum, event) => sum + (Number(event.idle_ms) || 0), 0);

  const report = {
    session: sessionPath,
    session_id: basename(sessionPath, '.jsonl'),
    model: observedModel,
    turns: loop3Turns.length,
    cells,
    elapsed_ms: totalElapsedMs,
    active_elapsed_ms: activeElapsedMs,
    idle_ms: idleMs,
    shape_records: shapes.length,
    pure_probes_inferred: pureProbeCount,
    useful_operations_total: totalUsefulOps,
    useful_operations_per_cell: cells > 0 ? Number((totalUsefulOps / cells).toFixed(2)) : 0,
    composed_cells: composedCells,
    micro_cells: microCells,
    batched_independent_reads_inferred: batchedReadCells > 0,
    batched_read_cells: batchedReadCells,
    batched_independent_verification_inferred: batchedVerifyCells > 0,
    batched_verification_cells: batchedVerifyCells,
    used_python_variables_across_steps_inferred: variableReuseCells > 0,
    variable_reuse_cells: variableReuseCells,
    cross_cell_state_reuse_cells: crossReuse.stateReuseCells,
    cross_cell_state_reuse_density: pct(crossReuse.stateReuseCells, Math.max(crossReuse.cellsWithPriorStateAvailable, 1)),
    cells_without_reuse_after_available_state: crossReuse.cellsWithoutReuseAfterAvailableState,
    cross_cell_reused_names: crossReuse.reusedNames,
    structured_done: hasStructuredDone(events),
    done_path: completion?.channel ?? (hasStructuredDone(events) ? 'done' : 'unknown'),
    tokens: {
      input: usage.input,
      output: usage.output,
      cache_read: usage.cacheRead,
      cache_write: usage.cacheWrite,
      total: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
    },
    estimated_cost_usd: Number(estimateCost(observedModel, usage.input, usage.output, usage.cacheRead, usage.cacheWrite).toFixed(4)),
    composition_density: pct(composedCells, Math.max(shapes.length, 1)),
    probe_density: pct(pureProbeCount, Math.max(cells, 1)),
  };

  console.log(JSON.stringify(report, null, 2));
}

main();
