import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

// ── Types ───────────────────────────────────────────────────────────────────

export type SessionEntry =
  | { type: 'meta'; model: string; vault: string | null; cwd: string; agentName: string; timestamp: number }
  | { type: 'model_selected'; provider: string; model: string; effort?: string; shortcut?: string | null; timestamp: number }
  | { type: 'user'; content: string; timestamp: number }
  | { type: 'assistant'; content: string; timestamp: number }
  | { type: 'tool_call'; id: string; name: string; input: Record<string, unknown>; timestamp: number }
  | { type: 'tool_result'; id: string; name: string; output: string; isError: boolean; timestamp: number }
  | { type: 'code_execution'; code: string; stdout: string; stderr: string; exception: string | null; duration_ms: number; rejected: { reason: string } | null; timed_out: boolean; rlm_stats?: { call_count: number; total_tokens: number }; timestamp: number }
  // Shape telemetry per Repl exec. Added 2026-04-22 for the schema-enforced
  // Repl composition experiment — metrics measure whether the model is
  // composing real multi-step work or filling minItems with trivial ops.
  // Correlates with tool_call/tool_result via tool_use_id. See body/shape.py
  // for the source metrics and the plan-file risk register for the
  // hypothesis being measured.
  | { type: 'repl_plan'; tool_use_id: string; goal: string; step_count: number; steps_preview: string[]; cells_emitted: number; timestamp: number }
  | { type: 'repl_shape';
    ops_count: number; tool_use_id: string; stmt_count: number; distinct_primitive_count: number; total_primitive_call_count: number; has_for_or_while: boolean; has_if: boolean; has_def: boolean; has_try: boolean; has_comprehension: boolean; is_micro_repl: boolean; is_composed: boolean; composition_kind?: string; primitives_called: string[]; costs?: Record<string, number>; effects?: Record<string, number>; expensive_primitives?: string[]; parse_error?: string; timestamp: number }
  // End-of-turn aggregate. Added 2026-04-22 alongside repl_shape. Captures
  // per-turn counts: Repl-call count, whether any call this turn was
  // composed / micro, whether done() fired. This is the turn-level signal
  // the composition experiment reports against — a session with high
  // any_composed and high committed is the target behavior.
  | { type: 'turn_metrics'; turn_index: number; repl_calls: number; any_composed: boolean; any_micro: boolean; committed: boolean; timestamp: number }
  // Fires when the model called done(value) during a Repl exec. The value
  // is stored raw (no truncation) so post-hoc analysis can inspect what
  // frontier models actually commit. If values grow unbounded in practice,
  // add a serialized-size cap here — until then, raw is more useful.
  | { type: 'done_committed'; tool_use_id: string; value: unknown; timestamp: number }
  // Fires when the Batch 1.7 input-repair shim rewrites a broken submission
  // shape before validation. `note` is the human-readable explanation appended
  // to the tool_result so the model learns. Lets us measure how often frontier
  // models emit pre-Stream-A / wrong-key / stringified-operations shapes —
  // if a given repair case never fires across 50+ sessions, drop it.
  | { type: 'input_repaired'; tool_use_id: string; note: string; timestamp: number }
  | { type: 'input_rejected'; tool_use_id: string; shape: Record<string, string>; timestamp: number }
  // Batch 2 (Pi parity): cell-level Repl events. cell_reset_requested fires
  // when a cell carries `rst=true` metadata — until body-side kernel reset
  // lands the harness logs the intent and proceeds without resetting. When
  // body support arrives this becomes a kernel_reset_committed event.
  | { type: 'cell_reset_requested'; tool_use_id: string; cell_index: number; cell_id?: string; timestamp: number }
  | { type: 'preflight'; projectNotes: string[]; vaultNotes: string[]; timestamp: number }
  | { type: 'postflight'; importance: number; reflected: boolean; timestamp: number }
  | { type: 'compact_boundary'; summary: string; insightsSaved: number; pruneOnly: boolean; timestamp: number }
  | { type: 'interrupted'; reason: string; timestamp: number }
  // Batch 3 — telemetry for the per-model max_tokens lift. Logged when
  // the provider observes stop_reason=max_tokens (or context_window).
  // Surfaces cutoff frequency post-cap-lift so we can tell whether
  // 128K is enough or composed batches still saturate. Partial tool
  // inputs are intentionally not logged — CC's pattern doesn't surface
  // them and the model recovers naturally without partial state.
  | { type: 'cutoff_warning'; reason: 'max_tokens' | 'context_window'; message: string; timestamp: number }
  // Max-tokens recovery loop (CC query.ts:1185-1257). Logged on each
  // auto-continuation attempt and when recovery exhausts. Telemetry for
  // how often truncation requires multi-turn recovery vs. single-turn.
  | { type: 'max_output_recovery'; attempt: number; timestamp: number }
  | { type: 'max_output_recovery_exhausted'; attempts: number; timestamp: number }
  // 2026-05-01 loop redesign — done() honored as exit signal + text-only
  // nudge + generalized forced-continuation. Telemetry tracks adoption:
  //   task_done — done() committed, loop exits clean. Climbs from baseline
  //     (~0% pre-fix) toward majority-of-task-ending-turns once model
  //     in-context-learns that done() is the canonical exit.
  //   task_nudge_injected — model emitted text-only without done(); harness
  //     injected one-shot reminder. Should be rare (<5%) once Repl + done()
  //     flow is healthy. Spike indicates model class regression.
  //   forced_continuation — generalized from inline research/plan blocks.
  //     gate names: 'research', 'plan', future modes.
  //   steering_drained — mid-turn user input applied between assistant
  //     turns. Diagnostic for how often users course-correct mid-pursuit.
  | { type: 'task_done'; turn: number; timestamp: number }
  | { type: 'task_nudge_injected'; turn: number; text_length: number; timestamp: number }
  | { type: 'forced_continuation'; gate: string; attempt: number; maxRetries: number; timestamp: number }
  | { type: 'steering_drained'; count: number; timestamp: number }
  // Per-model-call usage emitted on every assistant turn. Logged for bench
  // harness consumption (bench/2026-04/runner). cacheRead/Write are the
  // Anthropic prompt-cache fields; absent for providers that don't surface
  // them. inputTokens excludes cache reads (Anthropic billing semantics).
  | { type: 'usage'; inputTokens: number; outputTokens: number; totalTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; timestamp: number }
  // Provider lifecycle telemetry. Added after 2026-05-03 headless bench
  // stalled with only meta+user logged: no assistant, no usage, no tool
  // event. These breadcrumbs mark whether a run reached the upstream
  // request, received the first stream event, slept on rate-limit backoff,
  // or failed before any model-visible output. Bench parsers can ignore
  // them; incident triage cannot.
  | { type: 'provider_event'; stage: 'request_start' | 'first_event' | 'backoff' | 'request_error'; provider: string; model: string; attempt?: number; elapsedMs?: number; backoffMs?: number; reason?: string; message?: string; rawEventCount?: number; msSinceFirstEvent?: number; timestamp: number }
  // Loop2 spike telemetry (2026-05-04). Headless-only in v1. Keeps the
  // existing JSONL format and adds loop2-specific markers for bench and
  // diagnosis without rewriting the broader session schema.
  | { type: 'loop2_assistant'; turn: number; chars: number; content_head?: string; content_tail?: string; partial_on_error?: boolean; timestamp: number }
  | { type: 'loop2_thinking'; turn: number; chars: number; timestamp: number }
  | { type: 'loop2_extraction'; turn: number; cell_count: number; has_any_fence: boolean; notes: string[]; timestamp: number }
  | { type: 'loop2_turn_predicate'; turn: number; hasDoneCall: boolean; hasClosedPyFence: boolean; hasOnlyProse: boolean; hasMalformedFence: boolean; timestamp: number }
  | { type: 'loop2_cell_batch_start'; turn: number; cell_count: number; timestamp: number }
  | { type: 'loop2_cell_result'; turn: number; cell_index: number; cell_id?: string; status: 'ok' | 'exception' | 'rejected' | 'timeout'; duration_ms: number; timestamp: number }
  | { type: 'loop2_execution_result'; turn: number; cell_count: number; status: 'ok' | 'error' | 'note'; duration_ms: number; timestamp: number }
  | { type: 'loop2_done_committed'; turn: number; value: unknown; timestamp: number }
  | { type: 'loop2_turn_complete'; turn: number; cell_count: number; done_committed: boolean; status: 'ok' | 'error' | 'note'; timestamp: number }
  | { type: 'loop3_thinking'; turn: number; chars: number; timestamp: number }
  | { type: 'loop3_model_start'; turn: number; provider: string; message_count: number; timestamp: number }
  | { type: 'loop3_assistant_text'; turn: number; chars: number; content_head?: string; content_tail?: string; partial_on_error?: boolean; timestamp: number }
  | { type: 'loop3_action_start'; turn: number; tool_call_id: string; action_kind: 'code' | 'final'; cell_id?: string; code_chars?: number; timeout_ms?: number; timestamp: number }
  | { type: 'loop3_permission'; turn: number; tool_call_id: string; mode: string; decision: 'auto_allow' | 'allow' | 'always' | 'deny'; prompt_shown: boolean; elapsed_ms: number; timestamp: number }
  | { type: 'loop3_tool_use'; turn: number; tool_call_id?: string; cell_id?: string; code_chars: number; code_head?: string; code_tail?: string; code?: string; timeout_ms?: number; timestamp: number }
  | { type: 'loop3_repl_shape';
    turn: number; tool_call_id?: string; cell_id?: string; stmt_count: number; line_count?: number; char_count?: number; distinct_primitive_count: number; total_primitive_call_count: number; has_for_or_while: boolean; has_if: boolean; has_def: boolean; has_try: boolean; has_comprehension: boolean; is_micro_repl: boolean; is_composed: boolean; composition_kind?: string; primitives_called: string[]; costs?: Record<string, number>; effects?: Record<string, number>; expensive_primitives?: string[]; parse_error?: string; timestamp: number }
  | { type: 'loop3_runtime_state'; turn: number; tool_call_id?: string; cell_id?: string; footer?: string; state?: Record<string, unknown>; vars?: Array<{ name: string; summary: string }>; plan?: Record<string, unknown>; spanner?: Record<string, unknown>; timestamp: number }
  | { type: 'loop3_body_telemetry'; turn: number; tool_call_id?: string; cell_id?: string; event: Record<string, unknown>; timestamp: number }
  | { type: 'loop3_execution_start'; turn: number; tool_call_id: string; cell_id?: string; substrate_available: boolean; timestamp: number }
  | { type: 'loop3_cell_result'; turn: number; tool_call_id?: string; cell_id?: string; status: 'ok' | 'exception' | 'rejected' | 'timeout'; duration_ms: number; stdout_chars?: number; stderr_chars?: number; say_count?: number; done_value_type?: string; done_value_chars?: number; timestamp: number }
  | { type: 'loop3_tool_result'; turn: number; tool_call_id?: string; cell_count: number; status: 'ok' | 'exception' | 'rejected' | 'timeout'; duration_ms: number; done_committed: boolean; result_chars?: number; output?: string; timestamp: number }
  | { type: 'loop3_transcript'; assistant: string; user: string; timestamp: number }
  | { type: 'loop3_stream_recovery'; turn: number; recovered: boolean; acted_this_turn: boolean; error_name?: string; error_message?: string; timestamp: number }
  | { type: 'loop3_done_committed'; turn: number; value: unknown; value_type?: string; value_chars?: number; value_head?: string; value_tail?: string; timestamp: number }
  | { type: 'loop3_completion'; turn: number; channel: 'done' | 'natural_text' | 'max_turns' | 'error'; assistant_chars: number; cell_count: number; elapsed_ms: number; active_elapsed_ms?: number; idle_ms?: number; timestamp: number }
  | { type: 'loop3_turn_complete'; turn: number; cell_count: number; done_committed: boolean; acted: boolean; assistant_chars: number; elapsed_ms: number; active_elapsed_ms?: number; idle_ms?: number; timestamp: number }
  | { type: 'loop3_ask'; phase: 'shown' | 'resolved' | 'cancelled'; id: number; question_chars?: number; question_head?: string; answer_chars?: number; timestamp: number }
  // ── Compose sub-loop telemetry (Tier 3) ─────────────────────────────
  // Per-request lifecycle, emitted at the boundary points where bench
  // rollups can measure adoption (auto-router accuracy), discipline
  // (preflight coverage, gate rejections), and outcomes (terminated_via
  // distribution per mode). request_id is the join key across these and
  // the scratch_* events emitted from app.tsx.
  | { type: 'request_mode_selected'; request_id: string; mode: 'quick' | 'compose' | 'goal'; reason: string; matched_trigger?: string; input_chars: number; timestamp: number }
  | { type: 'scratch_created'; request_id: string; mode: 'quick' | 'compose' | 'goal'; intent_chars: number; timestamp: number }
  | { type: 'scratch_setup_error'; request_id: string; error: string; timestamp: number }
  | { type: 'scratch_closed'; request_id: string; mode: 'quick' | 'compose' | 'goal'; terminated_via: 'natural' | 'error' | 'abort' | 'max_turns'; preflights_parsed?: number; updates_parsed?: number; gate_rejections?: number; scout_count?: number; repl_count?: number; timestamp: number }
  | { type: 'scratch_close_error'; request_id: string; error: string; timestamp: number }
  | { type: 'request_completed'; request_id: string; mode: 'quick' | 'compose' | 'goal'; terminated_via: 'natural' | 'error' | 'abort' | 'max_turns'; preflights_parsed?: number; updates_parsed?: number; gate_rejections?: number; scout_count?: number; repl_count?: number; timestamp: number }
  | { type: 'compose_preflight_parsed'; request_id: string; cell_kind?: string; primitives?: string[]; purpose_chars?: number; timestamp: number }
  | { type: 'compose_update_parsed'; request_id: string; findings_chars?: number; next_move_chars?: number; timestamp: number }
  | { type: 'compose_gate_rejected'; request_id: string; reason_code: 'preflight_required' | 'update_required' | 'scout_budget_exceeded'; repl_count?: number; scout_count?: number; budget?: number; timestamp: number }
  // V2 (2026-05-08): structural exemption from the compose gate. Two cases:
  //   exempt_commit_only — cell uses only done/say/ask/plan.*/state.put/scratch.*
  //   exempt_repair_after_exception — repair preflight follows an exceptioned cell
  // Bench rollups use this to distinguish "model behaved" from "gate caught
  // a real lapse" from "gate let an exempt cell through." Without this we
  // can't tell whether commit_rate is from the model or from V2's exemption.
  | { type: 'compose_gate_exempt'; request_id: string; reason_code: 'exempt_commit_only' | 'exempt_repair_after_exception'; cell_code_chars?: number; repl_count?: number; timestamp: number }
  | { type: 'compose_parser_warning'; request_id: string; warning: string; timestamp: number }
  | { type: 'compose_scratch_sync_error'; request_id: string; turn: number; section: 'preflight' | 'findings'; error: string; timestamp: number }
  | { type: 'repl_after_preflight'; request_id: string; repl_count: number; scout_count: number; status?: 'ok' | 'exception' | 'rejected' | 'timeout'; timestamp: number }
  | { type: 'loop3_compose_blocks'; turn: number; request_id: string; new_preflight: boolean; new_update: boolean; timestamp: number }
  | { type: 'loop3_compose_gate_rejected'; turn: number; tool_call_id: string; request_id: string; reason_code?: string; reason: string; timestamp: number }
  // Startup readiness gate for codebase indexing. If the model can see the
  // code tool in a source project, the codebase graph must already be ready
  // before the first model call. Otherwise the model burns turns learning
  // that codebase.search is a temporary stub.
  | { type: 'codebase_index'; stage: 'start' | 'ready' | 'skipped' | 'error'; file_count?: number; symbol_count?: number; edge_count?: number; elapsed_ms?: number; reason?: string; message?: string; timestamp: number }
  | { type: 'error'; message: string; timestamp: number };

export interface SessionMeta {
  id: string;
  title: string | null;
  userTitle: string | null;
  createdAt: number;
  lastActiveAt: number;
  messageCount: number;
  model: string;
  cwd: string;
  costEstimate: number;
}

// ── Session Index ──────────────────────────────────────────────────────────

function indexPath(sessionDir: string): string {
  return join(sessionDir, 'sessions.json');
}

function readIndex(sessionDir: string): SessionMeta[] {
  const p = indexPath(sessionDir);
  if (!existsSync(p)) return [];
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as SessionMeta[];
  } catch {
    return [];
  }
}

function writeIndex(sessionDir: string, index: SessionMeta[]): void {
  try {
    writeFileSync(indexPath(sessionDir), JSON.stringify(index, null, 2), 'utf-8');
  } catch {
    // Index write should never crash the agent
  }
}

// ── Session Storage ─────────────────────────────────────────────────────────

export class SessionStorage {
  private filePath: string;
  private sessionDir: string;
  readonly sessionId: string;
  readonly cwd: string;
  private logCount = 0;

  constructor(cwd: string) {
    this.cwd = cwd;
    const projectHash = createHash('md5').update(cwd).digest('hex').slice(0, 12);
    this.sessionDir = join(homedir(), '.aries', 'sessions', projectHash);
    mkdirSync(this.sessionDir, { recursive: true });

    // Bench/session isolation hook. Normal sessions use a timestamp id; the
    // 2026-04 bench runner can set ARIES_SESSION_ID so its parser can read
    // the exact JSONL it spawned instead of racing every other live Aries
    // process for "newest modified session file".
    const forcedSessionId = process.env.ARIES_SESSION_ID;
    this.sessionId = forcedSessionId && /^[a-zA-Z0-9_.-]+$/.test(forcedSessionId)
      ? forcedSessionId
      : Date.now().toString(36);
    this.filePath = join(this.sessionDir, `${this.sessionId}.jsonl`);
  }

  get path(): string { return this.filePath; }
  get dir(): string { return this.sessionDir; }

  log(entry: SessionEntry): void {
    try {
      const line = JSON.stringify(entry) + '\n';
      appendFileSync(this.filePath, line, 'utf-8');
      this.logCount++;
      // Flush index on early entries (meta at 1, user at ~2) and every 20 logs
      // so interrupted sessions are always visible in the session list
      if (this.logCount <= 5 || this.logCount % 20 === 0) {
        this.touch(this.logCount);
      }
    } catch {
      // Session logging should never crash the agent
    }
  }

  static readSession(filePath: string): SessionEntry[] {
    if (!existsSync(filePath)) return [];
    try {
      const content = readFileSync(filePath, 'utf-8');
      return content
        .split('\n')
        .filter(line => line.trim().length > 0)
        .map(line => JSON.parse(line) as SessionEntry);
    } catch {
      return [];
    }
  }

  // ── Metadata Index ───────────────────────────────────────────────────

  createMeta(model: string, sessionName?: string): void {
    const index = readIndex(this.sessionDir);
    const meta: SessionMeta = {
      id: this.sessionId,
      title: null,
      userTitle: sessionName ?? null,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      messageCount: 0,
      model,
      cwd: this.cwd,
      costEstimate: 0,
    };
    index.unshift(meta);
    writeIndex(this.sessionDir, index);
  }

  updateMeta(patch: Partial<Pick<SessionMeta, 'title' | 'userTitle' | 'lastActiveAt' | 'messageCount' | 'costEstimate' | 'model'>>): void {
    const index = readIndex(this.sessionDir);
    const entry = index.find(s => s.id === this.sessionId);
    if (!entry) return;
    if (patch.title !== undefined) entry.title = patch.title;
    if (patch.userTitle !== undefined) entry.userTitle = patch.userTitle;
    if (patch.lastActiveAt !== undefined) entry.lastActiveAt = patch.lastActiveAt;
    if (patch.messageCount !== undefined) entry.messageCount = patch.messageCount;
    if (patch.costEstimate !== undefined) entry.costEstimate = patch.costEstimate;
    if (patch.model !== undefined) entry.model = patch.model;
    writeIndex(this.sessionDir, index);
  }

  setTitle(title: string): void {
    this.updateMeta({ title });
  }

  rename(userTitle: string): void {
    this.updateMeta({ userTitle });
  }

  touch(messageCount: number, costEstimate?: number): void {
    this.updateMeta({
      lastActiveAt: Date.now(),
      messageCount,
      ...(costEstimate !== undefined ? { costEstimate } : {}),
    });
  }

  // ── Listing ──────────────────────────────────────────────────────────

  listSessions(): SessionMeta[] {
    const index = readIndex(this.sessionDir);
    if (index.length > 0) {
      // Merge index with any orphaned JSONL files not in the index
      const indexedIds = new Set(index.map(s => s.id));
      const orphaned = this.scanLegacySessions().filter(s => !indexedIds.has(s.id));
      const merged = [...index, ...orphaned]
        .filter(s => s.id !== this.sessionId)
        .sort((a, b) => b.lastActiveAt - a.lastActiveAt);
      return merged;
    }
    // Fallback: scan JSONL files if no index exists (legacy sessions)
    return this.scanLegacySessions();
  }

  getLastSession(): SessionMeta | null {
    const sessions = this.listSessions();
    return sessions[0] ?? null;
  }

  getSessionPath(id: string): string {
    return join(this.sessionDir, `${id}.jsonl`);
  }

  findSession(query: string): SessionMeta | null {
    const sessions = this.listSessions();
    // Try exact ID match
    const byId = sessions.find(s => s.id === query);
    if (byId) return byId;
    // Try numeric index (1-based)
    const num = parseInt(query, 10);
    if (!isNaN(num) && num >= 1 && num <= sessions.length) {
      return sessions[num - 1]!;
    }
    // Fuzzy title match
    const lower = query.toLowerCase();
    return sessions.find(s =>
      (s.userTitle ?? s.title ?? '')
        .toLowerCase()
        .includes(lower)
    ) ?? null;
  }

  private scanLegacySessions(): SessionMeta[] {
    if (!existsSync(this.sessionDir)) return [];
    try {
      return readdirSync(this.sessionDir)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => {
          const p = join(this.sessionDir, f);
          const id = basename(f, '.jsonl');
          if (id === this.sessionId) return null;
          const stat = statSync(p);
          // Peek at the first line for meta info
          let model = 'unknown';
          let cwd = this.cwd;
          try {
            const firstLine = readFileSync(p, 'utf-8').split('\n')[0];
            if (firstLine) {
              const entry = JSON.parse(firstLine);
              if (entry.type === 'meta') {
                model = entry.model ?? model;
                cwd = entry.cwd ?? cwd;
              }
            }
          } catch { /* ignore */ }
          return {
            id,
            title: null,
            userTitle: null,
            createdAt: stat.birthtimeMs,
            lastActiveAt: stat.mtimeMs,
            messageCount: 0,
            model,
            cwd,
            costEstimate: 0,
          } as SessionMeta;
        })
        .filter((s): s is SessionMeta => s !== null)
        .sort((a, b) => b.lastActiveAt - a.lastActiveAt);
    } catch {
      return [];
    }
  }
}
