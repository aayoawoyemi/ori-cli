/**
 * Per-CLI metric extraction.
 *
 * Each parser takes raw stdout (and optionally stderr / supplementary files)
 * and returns a Metrics object in the common shape.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Metrics {
  tokens: {
    input: number;
    cached: number;
    output: number;
    total: number;
  };
  toolCalls: {
    total: number;
    byTool: Record<string, number>;
  };
  observedModel?: string;
  loop2?: {
    // Turns = model round-trips. Counts every loop2_turn_complete event,
    // including the final natural-stop turn that emits prose without cells.
    // This is the head-to-head metric vs Claude Code's tool_use count.
    turns: number;
    // Batches = turns that produced an <execution_result>. Excludes natural-
    // stop terminal turns. Equals turns - 1 on a clean done()-terminated run.
    batches: number;
    // Cells = total Python cells executed across all batches.
    cells: number;
    // Thinking events = model-visible thinking chunks persisted by Loop2.
    thinkingEvents: number;
    // Deterministic per-turn structural predicate events.
    turnPredicates: number;
    // Composition quality breakdown. High rejected/exception counts indicate
    // wasted parallel guessing (model fanning out hopeful probes) rather than
    // composed dataflow.
    cellsByStatus: {
      ok: number;
      exception: number;
      rejected: number;
      timeout: number;
    };
  };
  loop3?: {
    turns: number;
    toolCalls: number;
    cells: number;
    thinkingEvents: number;
    elapsedMs: number;
    activeElapsedMs: number;
    idleMs: number;
    shapeRecords: number;
    composedCells: number;
    microCells: number;
    pureProbes: number;
    usefulOperations: number;
    batchedReadCells: number;
    batchedVerificationCells: number;
    variableReuseCells: number;
    crossCellStateReuseCells: number;
    cellsWithPriorStateAvailable: number;
    cellsWithoutReuseAfterAvailableState: number;
    structuredDone: boolean;
    cellsByStatus: {
      ok: number;
      exception: number;
      rejected: number;
      timeout: number;
    };
  };
  compose?: {
    requests: {
      total: number;
      quick: number;
      compose: number;
      goal: number;
    };
    cells: {
      total: number;
      quick: number;
      compose: number;
      goal: number;
      perRequest: number;
      perComposeRequest: number;
    };
    preflights: {
      parsed: number;
      scout: number;
      composed: number;
      verify: number;
      repair: number;
      commit: number;
      coveragePct: number;
    };
    updatesParsed: number;
    gateRejections: {
      total: number;
      preflightRequired: number;
      updateRequired: number;
      scoutBudgetExceeded: number;
    };
    microCellsByMode: {
      quick: number;
      compose: number;
      goal: number;
      unknown: number;
    };
    closure: {
      // Per-request closure counters. A compose-mode request "closed with a
      // commit" if it emitted a commit-kind preflight OR fired an exempt
      // commit-only cell (V2 — done(answer) without preflight). It "closed
      // with done" if loop3 saw a structured done(...) inside the request
      // scope. The Pct fields divide these counts by composeOrGoalRequests.
      composeOrGoalRequests: number;
      commitsCount: number;
      donesCount: number;
      commitRatePct: number;
      doneRatePct: number;
    };
  };
  finalAnswer: string;
  /** Raw transcript (for archival). */
  transcript: string;
}

// ── Claude Code (--output-format stream-json) ──────────────────────────────

interface ClaudeStreamEvent {
  type: string;
  message?: {
    content?: Array<{ type: string; text?: string; name?: string }>;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
  result?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

export function parseClaude(stdout: string): Metrics {
  const lines = stdout.split('\n').filter((l) => l.trim());
  let inputTokens = 0;
  let cachedTokens = 0;
  let outputTokens = 0;
  let finalAnswer = '';
  const byTool: Record<string, number> = {};

  for (const line of lines) {
    let event: ClaudeStreamEvent;
    try {
      event = JSON.parse(line) as ClaudeStreamEvent;
    } catch {
      continue;
    }

    // Aggregate tool_use blocks per assistant message
    if (event.type === 'assistant' && event.message?.content) {
      for (const block of event.message.content) {
        if (block.type === 'tool_use' && block.name) {
          byTool[block.name] = (byTool[block.name] ?? 0) + 1;
        }
      }
      // Usage on assistant message_delta is the most accurate per-turn
      const u = event.message.usage;
      if (u) {
        inputTokens += u.input_tokens ?? 0;
        cachedTokens += u.cache_read_input_tokens ?? 0;
        outputTokens += u.output_tokens ?? 0;
      }
    }

    // Final result event has the textual answer
    if (event.type === 'result' && typeof event.result === 'string') {
      finalAnswer = event.result;
      // Result event also carries final usage; prefer it if present
      const u = event.usage;
      if (u && (u.input_tokens ?? 0) > 0) {
        inputTokens = u.input_tokens ?? inputTokens;
        cachedTokens = u.cache_read_input_tokens ?? cachedTokens;
        outputTokens = u.output_tokens ?? outputTokens;
      }
    }
  }

  const totalTools = Object.values(byTool).reduce((a, b) => a + b, 0);

  return {
    tokens: {
      input: inputTokens,
      cached: cachedTokens,
      output: outputTokens,
      total: inputTokens + cachedTokens + outputTokens,
    },
    toolCalls: { total: totalTools, byTool },
    finalAnswer,
    transcript: stdout,
  };
}

// ── pi-coding-agent (--mode json) ──────────────────────────────────────────

interface PiEvent {
  type?: string;
  // pi emits assistant_message_event / message_start / message_end / etc.
  // Final assistant message has content array with text + toolCall blocks
  message?: {
    role?: string;
    content?: Array<{ type: string; text?: string; name?: string }>;
    usage?: {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
    };
  };
  assistantMessageEvent?: { partial?: { content?: Array<{ type: string; text?: string; name?: string }> } };
  toolCallId?: string;
  toolName?: string;
}

export function parsePi(stdout: string): Metrics {
  const lines = stdout.split('\n').filter((l) => l.trim());
  let inputTokens = 0;
  let cachedTokens = 0;
  let outputTokens = 0;
  let finalAnswer = '';
  const byTool: Record<string, number> = {};
  const seenToolCallIds = new Set<string>();

  for (const line of lines) {
    let event: PiEvent;
    try {
      event = JSON.parse(line) as PiEvent;
    } catch {
      continue;
    }

    // Tool execution events carry toolCallId + toolName
    if (event.type === 'tool_execution_start' && event.toolName && event.toolCallId) {
      if (!seenToolCallIds.has(event.toolCallId)) {
        seenToolCallIds.add(event.toolCallId);
        byTool[event.toolName] = (byTool[event.toolName] ?? 0) + 1;
      }
    }

    // Assistant message_end has full content + usage
    if (event.type === 'message_end' && event.message?.role === 'assistant') {
      const content = event.message.content ?? [];
      for (const block of content) {
        if (block.type === 'text' && typeof block.text === 'string') {
          finalAnswer = block.text; // last text block wins
        }
      }
      const u = event.message.usage;
      if (u) {
        inputTokens += u.input ?? 0;
        cachedTokens += u.cacheRead ?? 0;
        outputTokens += u.output ?? 0;
      }
    }
  }

  const totalTools = Object.values(byTool).reduce((a, b) => a + b, 0);

  return {
    tokens: {
      input: inputTokens,
      cached: cachedTokens,
      output: outputTokens,
      total: inputTokens + cachedTokens + outputTokens,
    },
    toolCalls: { total: totalTools, byTool },
    finalAnswer,
    transcript: stdout,
  };
}

// ── aries-cli (session log + stdout) ───────────────────────────────────────

interface AriesEvent {
  type?: string;
  stage?: string;
  model?: string;
  name?: string;
  content?: string;
  content_head?: string;
  content_tail?: string;
  code_head?: string;
  code_tail?: string;
  tool_call_id?: string;
  value?: unknown;
  value_type?: string;
  provider?: string;
  primitives_called?: string[];
  is_micro_repl?: boolean;
  is_composed?: boolean;
  stmt_count?: number;
  total_primitive_call_count?: number;
  cell_count?: number;
  elapsed_ms?: number;
  active_elapsed_ms?: number;
  idle_ms?: number;
  status?: string;
  request_id?: string;
  mode?: 'quick' | 'compose' | 'goal';
  reason_code?: string;
  cell_kind?: string;
  channel?: string;
  preflights_parsed?: number;
  updates_parsed?: number;
  gate_rejections?: number;
  scout_count?: number;
  repl_count?: number;
  hasDoneCall?: boolean;
  hasClosedPyFence?: boolean;
  hasOnlyProse?: boolean;
  hasMalformedFence?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  timestamp?: number;
}

function formatUnknown(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function pushUnique(parts: string[], value: unknown): void {
  if (typeof value !== 'string') return;
  const text = value.trim();
  if (!text) return;
  if (parts[parts.length - 1] === text) return;
  parts.push(text);
}

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

function primitiveList(event: AriesEvent): string[] {
  return Array.isArray(event.primitives_called)
    ? event.primitives_called.filter((p): p is string => typeof p === 'string')
    : [];
}

function usefulPrimitiveCount(event: AriesEvent): number {
  return primitiveList(event).filter((p) => !LOW_VALUE_PRIMITIVES.has(p)).length;
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
  'rlm_call', 'say', 'set', 'shell', 'sorted', 'statistics', 'str', 'sum',
  'tuple', 'vault', 'web',
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
} {
  const available = new Set<string>();
  let cellsWithPriorStateAvailable = 0;
  let stateReuseCells = 0;

  for (const code of codes) {
    const refs = referencedNames(code);
    const usedPrior = [...refs].some((name) => available.has(name));
    if (available.size > 0) cellsWithPriorStateAvailable++;
    if (usedPrior) stateReuseCells++;
    for (const name of assignedNames(code)) available.add(name);
  }

  return {
    cellsWithPriorStateAvailable,
    stateReuseCells,
    cellsWithoutReuseAfterAvailableState: Math.max(0, cellsWithPriorStateAvailable - stateReuseCells),
  };
}

function isPureProbe(shape: AriesEvent, codeText: string): boolean {
  const primitives = primitiveList(shape);
  const lowValueOnly = primitives.length === 0 || primitives.every((p) => LOW_VALUE_PRIMITIVES.has(p));
  const tinyShape = shape.is_micro_repl === true && (shape.stmt_count ?? 0) <= 2;
  const probeCode = /\b(api\.stub|api\.describe|api\.costs|dir\(|help\(|print\()/m.test(codeText);
  return tinyShape && (lowValueOnly || probeCode);
}

export function parseAries(stdout: string, _stderr: string, sessionStartedAt: number, sessionId?: string): Metrics {
  const sessionsDir = join(homedir(), '.aries', 'sessions');
  let logPath: string | null = null;

  if (existsSync(sessionsDir)) {
    // Prefer the exact session id injected by the bench runner. The old
    // newest-mtime heuristic is unsafe when another Aries process is live:
    // whichever session writes last wins, and the bench silently grades the
    // wrong transcript. Exact id keeps the measurement tied to the process we
    // spawned.
    if (sessionId) {
      for (const sessId of readdirSync(sessionsDir)) {
        const fp = join(sessionsDir, sessId, `${sessionId}.jsonl`);
        if (existsSync(fp)) {
          logPath = fp;
          break;
        }
      }
    }
  }

  if (!logPath && existsSync(sessionsDir)) {
    // Fallback for older Aries builds that do not honor ARIES_SESSION_ID:
    // find the session log file most recently created/modified after start.
    const candidates: { path: string; mtime: number }[] = [];
    for (const sessId of readdirSync(sessionsDir)) {
      const sessPath = join(sessionsDir, sessId);
      try {
        const stat = statSync(sessPath);
        if (!stat.isDirectory()) continue;
        for (const f of readdirSync(sessPath)) {
          if (!f.endsWith('.jsonl')) continue;
          const fp = join(sessPath, f);
          const fstat = statSync(fp);
          if (fstat.mtimeMs >= sessionStartedAt - 1000) {
            candidates.push({ path: fp, mtime: fstat.mtimeMs });
          }
        }
      } catch {
        // skip
      }
    }
    candidates.sort((a, b) => b.mtime - a.mtime);
    if (candidates.length > 0) logPath = candidates[0]!.path;
  }

  let inputTokens = 0;
  let cachedTokens = 0;
  let outputTokens = 0;
  let finalAnswer = '';
  const byTool: Record<string, number> = {};
  let transcript = stdout;
  let lastDoneOutput = '';
  const loop2AssistantText: string[] = [];
  let loop2Turns = 0;
  let loop2Batches = 0;
  let loop2Cells = 0;
  let loop2ThinkingEvents = 0;
  let loop2TurnPredicates = 0;
  const loop2CellsByStatus = { ok: 0, exception: 0, rejected: 0, timeout: 0 };
  const loop3AssistantText: string[] = [];
  const loop3CodeText: string[] = [];
  let loop3Turns = 0;
  let loop3ToolCalls = 0;
  let loop3Cells = 0;
  let loop3ThinkingEvents = 0;
  let loop3ElapsedMs = 0;
  let loop3ActiveElapsedMs = 0;
  let loop3IdleMs = 0;
  const loop3CellsByStatus = { ok: 0, exception: 0, rejected: 0, timeout: 0 };
  const loop3CodeByToolCall = new Map<string, string>();
  let loop3ShapeRecords = 0;
  let loop3ComposedCells = 0;
  let loop3MicroCells = 0;
  let loop3PureProbes = 0;
  let loop3UsefulOperations = 0;
  let loop3BatchedReadCells = 0;
  let loop3BatchedVerificationCells = 0;
  let loop3VariableReuseCells = 0;
  let loop3CrossCellStateReuseCells = 0;
  let loop3CellsWithPriorStateAvailable = 0;
  let loop3CellsWithoutReuseAfterAvailableState = 0;
  let loop3StructuredDone = false;
  let loop3DoneCommittedSeen = false;
  let observedModel = '';
  let activeRequestMode: 'quick' | 'compose' | 'goal' | null = null;
  const composeRequests = { total: 0, quick: 0, compose: 0, goal: 0 };
  const composeCells = { total: 0, quick: 0, compose: 0, goal: 0 };
  const composePreflights = { parsed: 0, scout: 0, composed: 0, verify: 0, repair: 0, commit: 0 };
  let composeUpdatesParsed = 0;
  const composeGateRejections = { total: 0, preflightRequired: 0, updateRequired: 0, scoutBudgetExceeded: 0 };
  const composeMicroCellsByMode = { quick: 0, compose: 0, goal: 0, unknown: 0 };
  // Per-request closure tracking. Reset on request_mode_selected, latched on
  // signals during the request, banked at request_completed. Quick requests
  // never count toward closure denominators — the discipline is for compose/
  // goal modes only. A request "had commit signal" if it parsed a commit-kind
  // preflight OR fired an exempt commit-only cell (V2 — done(answer) without
  // preflight). It "had structured done" if loop3 emitted done_committed or
  // a 'done' completion channel inside the request scope.
  let composeOrGoalRequests = 0;
  let composeRequestsWithCommit = 0;
  let composeRequestsWithDone = 0;
  let requestHadCommit = false;
  let requestHadStructuredDone = false;

  const archivedJsonl = !logPath && stdout.trimStart().startsWith('{"type"');
  if (logPath || archivedJsonl) {
    const log = logPath ? readFileSync(logPath, 'utf-8') : stdout;
    transcript = log;
    for (const line of log.split('\n').filter((l) => l.trim())) {
      let event: AriesEvent;
      try {
        event = JSON.parse(line) as AriesEvent;
      } catch {
        continue;
      }

      if (event.type === 'tool_call' && event.name) {
        byTool[event.name] = (byTool[event.name] ?? 0) + 1;
      }
      if (event.type === 'provider_event' && event.model) {
        observedModel = event.model;
      } else if (event.type === 'model_selected' && event.model) {
        observedModel = event.model;
      } else if (event.type === 'meta' && event.model && !observedModel) {
        observedModel = event.model;
      }
      if (event.type === 'loop2_turn_complete') {
        loop2Turns++;
      }
      if (event.type === 'loop3_turn_complete') {
        loop3Turns++;
        const elapsed = event.elapsed_ms ?? 0;
        const idle = event.idle_ms ?? 0;
        loop3ElapsedMs += elapsed;
        loop3ActiveElapsedMs += event.active_elapsed_ms ?? Math.max(0, elapsed - idle);
        loop3IdleMs += idle;
      }
      if (event.type === 'loop2_thinking') {
        loop2ThinkingEvents++;
      }
      if (event.type === 'loop3_thinking') {
        loop3ThinkingEvents++;
      }
      if (event.type === 'loop3_tool_use') {
        loop3ToolCalls++;
        byTool.loop3_repl = (byTool.loop3_repl ?? 0) + 1;
        pushUnique(loop3CodeText, event.code_head);
        if (event.code_tail !== event.code_head) {
          pushUnique(loop3CodeText, event.code_tail);
        }
        if (typeof event.tool_call_id === 'string') {
          loop3CodeByToolCall.set(event.tool_call_id, `${event.code_head ?? ''}\n${event.code_tail ?? ''}`);
        }
      }
      if (event.type === 'loop3_repl_shape') {
        loop3ShapeRecords++;
        if (event.is_composed === true) loop3ComposedCells++;
        if (event.is_micro_repl === true) loop3MicroCells++;
        if (event.is_micro_repl === true) {
          composeMicroCellsByMode[activeRequestMode ?? 'unknown']++;
        }
        const primitives = primitiveList(event);
        const codeText = typeof event.tool_call_id === 'string' ? (loop3CodeByToolCall.get(event.tool_call_id) ?? '') : '';
        if (isPureProbe(event, codeText)) loop3PureProbes++;
        loop3UsefulOperations += usefulPrimitiveCount(event);
        if (primitives.filter((p) => READ_PRIMITIVES.has(p)).length >= 2) loop3BatchedReadCells++;
        if (primitives.filter((p) => VERIFY_PRIMITIVES.has(p)).length >= 2) loop3BatchedVerificationCells++;
        if (hasVariableReuse(codeText)) loop3VariableReuseCells++;
      }
      if (event.type === 'loop2_turn_predicate') {
        loop2TurnPredicates++;
      }
      if (event.type === 'loop2_execution_result') {
        loop2Batches++;
        byTool.loop2_exec = (byTool.loop2_exec ?? 0) + 1;
      }
      if (event.type === 'loop2_cell_result') {
        loop2Cells++;
        // Categorize by status. Rejected/exception cells are the composition-
        // quality signal — model fanning out parallel guesses rather than
        // composing later cells from earlier cell outputs.
        const s = event.status;
        if (s === 'ok' || s === 'exception' || s === 'rejected' || s === 'timeout') {
          loop2CellsByStatus[s]++;
        }
      }
      if (event.type === 'loop3_cell_result') {
        loop3Cells++;
        const s = event.status;
        if (s === 'ok' || s === 'exception' || s === 'rejected' || s === 'timeout') {
          loop3CellsByStatus[s]++;
        }
      }
      if (event.type === 'request_mode_selected') {
        const mode = event.mode;
        if (mode === 'quick' || mode === 'compose' || mode === 'goal') {
          activeRequestMode = mode;
          composeRequests.total++;
          composeRequests[mode]++;
          // Reset per-request closure flags. A request only counts toward
          // commit/done denominators if it's compose-or-goal mode AND it
          // reaches request_completed (so we know the model actually closed
          // the request, not crashed mid-flight).
          requestHadCommit = false;
          requestHadStructuredDone = false;
        }
      }
      if (event.type === 'request_completed') {
        const mode = event.mode;
        const replCount = event.repl_count ?? 0;
        if (mode === 'quick' || mode === 'compose' || mode === 'goal') {
          composeCells.total += replCount;
          composeCells[mode] += replCount;
        }
        if (mode === 'compose' || mode === 'goal') {
          composeOrGoalRequests++;
          if (requestHadCommit) composeRequestsWithCommit++;
          if (requestHadStructuredDone) composeRequestsWithDone++;
        }
        activeRequestMode = null;
        requestHadCommit = false;
        requestHadStructuredDone = false;
      }
      if (event.type === 'compose_preflight_parsed') {
        composePreflights.parsed++;
        const kind = typeof event.cell_kind === 'string' ? event.cell_kind.toLowerCase() : '';
        if (kind === 'scout') composePreflights.scout++;
        else if (kind === 'composed') composePreflights.composed++;
        else if (kind === 'verify') composePreflights.verify++;
        else if (kind === 'repair') composePreflights.repair++;
        else if (kind === 'commit') {
          composePreflights.commit++;
          // Commit-kind preflight = explicit closure declaration.
          if (activeRequestMode === 'compose' || activeRequestMode === 'goal') {
            requestHadCommit = true;
          }
        }
      }
      if (event.type === 'compose_update_parsed') {
        composeUpdatesParsed++;
      }
      if (event.type === 'compose_gate_rejected') {
        composeGateRejections.total++;
        if (event.reason_code === 'preflight_required') composeGateRejections.preflightRequired++;
        else if (event.reason_code === 'update_required') composeGateRejections.updateRequired++;
        else if (event.reason_code === 'scout_budget_exceeded') composeGateRejections.scoutBudgetExceeded++;
      }
      if (event.type === 'compose_gate_exempt') {
        // V2 (2026-05-08): exempt_commit_only fires when a cell containing
        // only done/say/ask/plan.*/state.put/scratch.* gets through the gate.
        // This is the OTHER closure path — the model didn't bother declaring
        // a commit preflight, just fired done(answer) directly. Counts as a
        // commit signal. exempt_repair_after_exception is a different
        // bypass (repair preflight satisfies update_required after a
        // failed cell) and is NOT a closure event.
        if (event.reason_code === 'exempt_commit_only') {
          if (activeRequestMode === 'compose' || activeRequestMode === 'goal') {
            requestHadCommit = true;
          }
        }
      }
      // Structured done detection inside request scope. Both events fire on
      // a clean done(value) commit; loop3_completion(channel:done) is the
      // turn-level summary, loop3_done_committed is the cell-level event.
      // Either is sufficient.
      if (event.type === 'loop3_done_committed' ||
          (event.type === 'loop3_completion' && event.channel === 'done')) {
        if (activeRequestMode === 'compose' || activeRequestMode === 'goal') {
          requestHadStructuredDone = true;
        }
      }
      if (event.type === 'usage') {
        inputTokens += event.inputTokens ?? 0;
        cachedTokens += event.cacheReadTokens ?? 0;
        outputTokens += event.outputTokens ?? 0;
      }
      if (event.type === 'assistant' && typeof event.content === 'string') {
        // Tool-using codemode turns often log empty assistant content before
        // the Repl call. Do not let those structural assistant messages erase
        // the actual answer channel below.
        if (event.content.trim()) finalAnswer = event.content;
      }
      if (event.type === 'loop2_assistant') {
        pushUnique(loop2AssistantText, event.content_head);
        if (event.content_tail !== event.content_head) {
          pushUnique(loop2AssistantText, event.content_tail);
        }
      }
      if (event.type === 'loop3_assistant_text') {
        pushUnique(loop3AssistantText, event.content_head);
        if (event.content_tail !== event.content_head) {
          pushUnique(loop3AssistantText, event.content_tail);
        }
      }
      if (event.type === 'done_committed') {
        lastDoneOutput = formatUnknown(event.value);
      }
      if (event.type === 'loop2_done_committed') {
        lastDoneOutput = formatUnknown(event.value);
      }
      if (event.type === 'loop3_done_committed') {
        lastDoneOutput = formatUnknown(event.value);
        loop3DoneCommittedSeen = true;
        // "structured done path" means completion happened via done(...),
        // regardless of value type (string/object/etc).
        loop3StructuredDone = true;
      }
      if (event.type === 'loop3_completion' && event.channel === 'done') {
        loop3DoneCommittedSeen = true;
        loop3StructuredDone = true;
      }
    }
    if (!finalAnswer.trim()) {
      finalAnswer = [...loop2AssistantText, ...loop3AssistantText, ...loop3CodeText, lastDoneOutput].filter((part) => part.trim()).join('\n\n');
      if (!finalAnswer.trim()) finalAnswer = stdout;
    }
    const crossReuse = crossCellReuse(loop3CodeText);
    loop3CrossCellStateReuseCells = crossReuse.stateReuseCells;
    loop3CellsWithPriorStateAvailable = crossReuse.cellsWithPriorStateAvailable;
    loop3CellsWithoutReuseAfterAvailableState = crossReuse.cellsWithoutReuseAfterAvailableState;
    if (loop3DoneCommittedSeen) loop3StructuredDone = true;
  } else {
    // Fall back to stdout if no session log found
    finalAnswer = stdout;
  }

  const totalTools = Object.values(byTool).reduce((a, b) => a + b, 0);

  return {
    tokens: {
      input: inputTokens,
      cached: cachedTokens,
      output: outputTokens,
      total: inputTokens + cachedTokens + outputTokens,
    },
    toolCalls: { total: totalTools, byTool },
    ...(observedModel ? { observedModel } : {}),
    ...(loop2Turns > 0 || loop2Batches > 0 || loop2Cells > 0 || loop2ThinkingEvents > 0 || loop2TurnPredicates > 0
      ? {
          loop2: {
            turns: loop2Turns,
            batches: loop2Batches,
            cells: loop2Cells,
            thinkingEvents: loop2ThinkingEvents,
            turnPredicates: loop2TurnPredicates,
            cellsByStatus: loop2CellsByStatus,
          },
        }
      : {}),
    ...(loop3Turns > 0 || loop3ToolCalls > 0 || loop3Cells > 0 || loop3ThinkingEvents > 0 || loop3ShapeRecords > 0
      ? {
          loop3: {
            turns: loop3Turns,
            toolCalls: loop3ToolCalls,
            cells: loop3Cells,
            thinkingEvents: loop3ThinkingEvents,
            elapsedMs: loop3ElapsedMs,
            activeElapsedMs: loop3ActiveElapsedMs,
            idleMs: loop3IdleMs,
            shapeRecords: loop3ShapeRecords,
            composedCells: loop3ComposedCells,
            microCells: loop3MicroCells,
            pureProbes: loop3PureProbes,
            usefulOperations: loop3UsefulOperations,
            batchedReadCells: loop3BatchedReadCells,
            batchedVerificationCells: loop3BatchedVerificationCells,
            variableReuseCells: loop3VariableReuseCells,
            crossCellStateReuseCells: loop3CrossCellStateReuseCells,
            cellsWithPriorStateAvailable: loop3CellsWithPriorStateAvailable,
            cellsWithoutReuseAfterAvailableState: loop3CellsWithoutReuseAfterAvailableState,
            structuredDone: loop3StructuredDone,
            cellsByStatus: loop3CellsByStatus,
          },
        }
      : {}),
    ...(composeRequests.total > 0 || composePreflights.parsed > 0 || composeGateRejections.total > 0
      ? {
          compose: {
            requests: composeRequests,
            cells: {
              ...composeCells,
              perRequest: composeRequests.total > 0 ? composeCells.total / composeRequests.total : 0,
              perComposeRequest: (composeRequests.compose + composeRequests.goal) > 0
                ? (composeCells.compose + composeCells.goal) / (composeRequests.compose + composeRequests.goal)
                : 0,
            },
            preflights: {
              ...composePreflights,
              coveragePct: (composeCells.total + composeGateRejections.total) > 0
                ? Math.min(100, Math.round((composePreflights.parsed / (composeCells.total + composeGateRejections.total)) * 100))
                : 0,
            },
            updatesParsed: composeUpdatesParsed,
            gateRejections: composeGateRejections,
            microCellsByMode: composeMicroCellsByMode,
            closure: {
              composeOrGoalRequests,
              commitsCount: composeRequestsWithCommit,
              donesCount: composeRequestsWithDone,
              commitRatePct: composeOrGoalRequests > 0
                ? Math.round((composeRequestsWithCommit / composeOrGoalRequests) * 100)
                : 0,
              doneRatePct: composeOrGoalRequests > 0
                ? Math.round((composeRequestsWithDone / composeOrGoalRequests) * 100)
                : 0,
            },
          },
        }
      : {}),
    finalAnswer,
    transcript,
  };
}
