/**
 * Types for the REPL bridge (TS ↔ Python body subprocess).
 */

export interface CodeExecution {
  code: string;
  turn_id?: string;
  timeout_ms?: number;
}

export interface ReplRejection {
  reason: string;
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
}

export type ReplEvent =
  | { type: 'exec_start'; code: string; turn_id?: string }
  | { type: 'exec_end'; result: ReplResult; turn_id?: string }
  | { type: 'bridge_ready' }
  | { type: 'bridge_restart'; reason: string; attempt: number }
  | { type: 'bridge_error'; error: string };

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
