/**
 * Types for the REPL bridge (TS ↔ Python body subprocess).
 */

export interface CodeExecution {
  code: string;
  turn_id?: string;
  timeout_ms?: number;
}

/**
 * Body version + content fingerprint reported by the ping op.
 *
 * Computed once at body startup (body/version.py). The bridge captures this
 * on every ping and compares contentHash against the on-disk source hash to
 * detect drift — i.e. body subprocess running stale code because source was
 * edited after the process started.
 *
 * version: human string from package.json or fallback
 * sha:     short git rev-parse HEAD if available, else ""
 * contentHash: SHA-256[:16] over canonical sorted body/*.py contents
 * startedAt:   ISO-8601 UTC timestamp of body startup
 */
export interface BodyInfo {
  version: string;
  sha: string;
  contentHash: string;
  startedAt: string;
}

export interface ReplRejection {
  reason: string;
}

export interface ScratchStatus {
  active: boolean;
  path?: string;
  intent?: string;
  mode?: string;
  char_count?: number;
  sections_filled?: string[];
  sections_empty?: string[];
  error?: string;
}

export interface ReplResult {
  stdout: string;
  stderr: string;
  exception: string | null;
  duration_ms: number;
  rejected: ReplRejection | null;
  timed_out: boolean;
  // Phase 4+ — populated when rlm_call is exposed in the namespace
  rlm_stats?: {
    call_count: number;
    total_tokens: number;
    calls: Array<{
      question: string;
      input_tokens: number;
      output_tokens: number;
    }>;
  };
  // Populated when the model called `done(value)` during exec. Last commit
  // wins if done() fires multiple times in one batch. The bridge also emits
  // a `repl_done` ReplEvent in real time (during exec) — this field is the
  // post-exec harvest for callers that don't subscribe to events.
  done?: { value: unknown };
  // Structured post-exec say() harvest. say(text) still emits a real-time
  // repl_say event and still echoes to captured stdout for legacy behavior.
  // Field name is deliberately NOT "say": the bridge reserves top-level
  // {"say": ...} frames for fire-and-forget callbacks before resolving exec
  // results. This result-envelope field keeps the protocols disjoint.
  say_texts?: string[];
  // Shape telemetry from body/shape.py — attached unconditionally by
  // _run_exec so every Repl result carries composition metrics. Consumed
  // by src/loop.ts to log a `repl_shape` session event per exec and a
  // `turn_metrics` aggregate at end-of-turn. If AST parsing failed on the
  // body side, `shape.error` will be present — still attached, so
  // downstream aggregators can filter rather than silently skipping.
  shape?: {
    stmt_count: number;
    line_count: number;
    char_count: number;
    primitives_called: string[];
    costs?: Record<string, number>;
    effects?: Record<string, number>;
    expensive_primitives?: string[];
    distinct_primitive_count: number;
    total_primitive_call_count: number;
    has_for_or_while: boolean;
    has_if: boolean;
    has_def: boolean;
    has_try: boolean;
    has_comprehension: boolean;
    is_micro_repl: boolean;
    is_composed: boolean;
    composition_kind?: 'micro' | 'fanout' | 'pipeline' | 'control_flow' | 'commit' | 'silent' | string;
    error?: string;
  };
  runtime?: {
    footer?: string;
    state?: {
      dir?: string;
      count?: number;
      receipts?: Array<{ key: string; summary: string; note?: string; updated_at?: string }>;
      last_produced?: Array<{ key: string; summary: string; note?: string; updated_at?: string }>;
      error?: string;
    };
    vars?: Array<{ name: string; summary: string }>;
    plan?: Record<string, unknown>;
    spanner?: Record<string, unknown>;
    scratch?: ScratchStatus;
    telemetry?: Array<Record<string, unknown>>;
    shape?: Record<string, unknown>;
  };
}

export type ReplEvent =
  | { type: 'exec_start'; code: string; turn_id?: string }
  | { type: 'exec_end'; result: ReplResult; turn_id?: string }
  | { type: 'bridge_ready' }
  | { type: 'bridge_restart'; reason: string; attempt: number }
  | { type: 'bridge_error'; error: string }
  // bridge_unhealthy fires when the heartbeat watchdog declares the body
  // unresponsive (>= MISS_THRESHOLD consecutive ping deadlines missed).
  // It's emitted as observability — the bridge itself reacts internally
  // by triggering a restart-with-replay; consumers do not need to do
  // anything with this event. Surfaced for telemetry and for tests
  // that want to assert the watchdog fired.
  | { type: 'bridge_unhealthy'; consecutiveMisses: number; msSinceLastPong: number }
  // bridge_recovered fires after a heartbeat-triggered restart has
  // completed AND replayed all bound state (configure / index / vault /
  // rlm / research). Distinct from `bridge_ready` (which fires on every
  // process spawn including initial start) — `bridge_recovered` only
  // fires after an unhealthy → restart → replay cycle. The UI does NOT
  // surface this to the user — silent recovery is the whole point — but
  // it's emitted so tests can wait for the post-restart steady state.
  | { type: 'bridge_recovered'; replayMs: number }
  // repl_say fires when Python calls say(text) during exec. Fire-and-forget
  // from the Python side; the UI may register a handler via setOnSay to
  // append the text to the assistant message stream. No response is sent
  // back to Python — the text is visible or not, and either way exec
  // continues. See body/speak.py for the Python-side contract.
  | { type: 'repl_say'; text: string }
  // repl_ask fires when Python calls ask(question). The Python side is
  // blocked on a threading.Event — the UI MUST eventually call
  // bridge.resolveAsk(id, answer) to unblock, or ask() will time out
  // after its configured timeout (default 300s in body/speak.py).
  | { type: 'repl_ask'; id: number; question: string }
  // repl_done fires when Python calls done(value) during exec. Real-time
  // observation channel — UI or telemetry can react immediately. The value
  // also appears post-exec as result.done on ReplResult, so callers that
  // don't subscribe to events still see the commit. Fire-and-forget from
  // Python (no bridge response needed); exec continues.
  | { type: 'repl_done'; value: unknown }
  // body_drift fires when the bridge detects that the running body subprocess
  // is stale relative to on-disk source. The body's reported contentHash
  // (computed at its startup) no longer matches the current on-disk hash.
  // Until the user restarts the CLI, structural body changes (e.g. the
  // composition wall) are not in effect. The UI surfaces this as "body:
  // stale, restart required" in the status bar. Bridge does not auto-restart
  // because that would lose REPL namespace state.
  | { type: 'body_drift'; runningHash: string; onDiskHash: string; runningStartedAt: string };

export interface ReplOptions {
  /** Path to body/server.py. Defaults to <repo>/body/server.py */
  serverPath?: string;
  /** Python executable. Defaults to 'python' on Windows, 'python3' elsewhere. */
  pythonCmd?: string;
  /** Default timeout for REPL requests, in ms. Defaults to 30_000. */
  timeoutMs?: number;
  /** Max automatic restarts before giving up. Defaults to 3. */
  maxRestarts?: number;
  /** Event callback for observability. */
  onEvent?: (e: ReplEvent) => void;
  /** Called after the body process restarts. Use to re-index codebase, reconnect vault, etc. */
  onRestart?: () => Promise<void>;
}

export interface IndexRequest {
  repoPath: string;
  includeExts?: string[];
  excludeDirs?: string[];
}

export interface IndexResult {
  ok: boolean;
  file_count: number;
  symbol_count: number;
  edge_count: number;
  unique_symbols: number;
  elapsed_ms: number;
  error?: string;
}

export interface CodebaseStats {
  schema_version?: string;
  file_count: number;
  edge_count: number;
  symbol_count: number;
  reference_count: number;
  unique_symbols: number;
}

export type SignatureLevel = 'lean' | 'standard' | 'deep' | 'max';

export interface CodebaseSignature {
  schema_version: string;
  level: SignatureLevel;
  approx_tokens: number;
  markdown: string;
  stats: { file_count: number; edge_count: number; symbol_count: number };
  entry_points: Array<{ path: string; score: number; descriptor?: string; comment?: string }>;
  authorities: Array<{ path: string; score: number; descriptor?: string; comment?: string }>;
  hubs: Array<{ path: string; score: number; descriptor?: string; comment?: string }>;
  modules: Array<{ label: string; file_count: number; sample: string[]; files?: string[] }>;
  type_hubs: Array<{ name: string; kind: string; def_file: string; reference_count: number }>;
  error?: string;
}

export interface VaultSignature {
  schema_version: string;
  level: SignatureLevel;
  approx_tokens: number;
  markdown: string;
  vault_path: string;
  stats: { note_count?: number; inbox_count?: number; orphan_count?: number };
  identity_line: string;
  orient_summary: string;
  active_goals: string[];
  authority_notes: Array<{ title: string; score: number; type: string }>;
  fading_notes: Array<{ title: string; vitality: number }>;
  error?: string;
}

export interface VaultConnectRequest {
  vaultPath: string;
}

export interface VaultConnectResult {
  ok: boolean;
  vault_path?: string;
  note_count?: number;
  inbox_count?: number;
  error?: string;
}

export interface VaultStatus {
  vaultRoot?: string;
  noteCount?: number;
  inboxCount?: number;
  orphanCount?: number;
  error?: string;
}

export interface RlmConfigRequest {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  maxCalls?: number;
}

export interface RlmConfigResult {
  ok: boolean;
  model?: string;
  error?: string;
}

export interface ResearchConnectResult {
  ok: boolean;
  error?: string;
}
