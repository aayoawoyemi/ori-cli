import { existsSync, mkdirSync, appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TurnRecord {
  turn: number;
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costEstimate: number;      // USD
  timestamp: number;         // epoch ms
  durationMs?: number;       // wall time for this turn
}

export interface SessionSummary {
  sessionId: string;
  startedAt: number;
  turns: number;
  totalInput: number;
  totalOutput: number;
  totalCacheRead: number;
  totalCacheWrite: number;
  totalCost: number;
  primaryModel: string;
}

// ── Cost tables (USD per million tokens) ──────────────────────────────────────

interface CostTier {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const COST_PER_M: Record<string, CostTier> = {
  // Anthropic
  'claude-opus-4-6':              { input: 15,  output: 75,  cacheRead: 1.5,  cacheWrite: 18.75 },
  'claude-sonnet-4-6':            { input: 3,   output: 15,  cacheRead: 0.3,  cacheWrite: 3.75 },
  'claude-haiku-4-5-20251001':    { input: 0.8, output: 4,   cacheRead: 0.08, cacheWrite: 1 },
  // Google
  'gemini-2.5-pro':               { input: 1.25, output: 10,  cacheRead: 0.315, cacheWrite: 4.5 },
  'gemini-2.5-flash':             { input: 0.15, output: 0.6, cacheRead: 0.0375, cacheWrite: 0.15 },
  // OpenAI
  'gpt-4o':                       { input: 2.5,  output: 10,  cacheRead: 1.25, cacheWrite: 2.5 },
  'gpt-5':                        { input: 10,   output: 30,  cacheRead: 2.5,  cacheWrite: 10 },
  'o4-mini':                      { input: 1.1,  output: 4.4, cacheRead: 0.275, cacheWrite: 1.1 },
  // DeepSeek
  'deepseek-chat':                { input: 0.27, output: 1.1, cacheRead: 0.07, cacheWrite: 0.27 },
  'deepseek-reasoner':            { input: 0.55, output: 2.19, cacheRead: 0.14, cacheWrite: 0.55 },
  // Qwen (DashScope)
  'qwen3.6-plus':                 { input: 0.8, output: 2,   cacheRead: 0.2, cacheWrite: 0.8 },
  'qwen3-235b-a22b':              { input: 0.8, output: 2,   cacheRead: 0.2, cacheWrite: 0.8 },
  // Groq (free tier for now)
  'llama-3.3-70b-versatile':      { input: 0.59, output: 0.79, cacheRead: 0, cacheWrite: 0 },
};

// Fallback for unknown models
const DEFAULT_COST: CostTier = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };

function getCostTier(model: string): CostTier {
  return COST_PER_M[model] ?? DEFAULT_COST;
}

function estimateCost(model: string, input: number, output: number, cacheRead: number, cacheWrite: number): number {
  const tier = getCostTier(model);
  return (
    (input * tier.input / 1_000_000) +
    (output * tier.output / 1_000_000) +
    (cacheRead * tier.cacheRead / 1_000_000) +
    (cacheWrite * tier.cacheWrite / 1_000_000)
  );
}

// ── Tracker ───────────────────────────────────────────────────────────────────

export class UsageTracker {
  private turns: TurnRecord[] = [];
  private sessionId: string;
  private startedAt: number;
  private primaryModel: string;
  private usageDir: string;
  private turnStartTime: number | null = null;

  constructor(sessionId: string, primaryModel: string, ariesDir?: string) {
    this.sessionId = sessionId;
    this.startedAt = Date.now();
    this.primaryModel = primaryModel;
    this.usageDir = join(ariesDir ?? join(homedir(), '.aries'), 'usage');

    // Ensure usage directory exists
    if (!existsSync(this.usageDir)) {
      mkdirSync(this.usageDir, { recursive: true });
    }
  }

  /** Call before each model request to measure wall time. */
  markTurnStart(): void {
    this.turnStartTime = Date.now();
  }

  /** Record a completed turn's token usage. */
  recordTurn(
    model: string,
    provider: string,
    inputTokens: number,
    outputTokens: number,
    cacheReadTokens = 0,
    cacheWriteTokens = 0,
  ): TurnRecord {
    const durationMs = this.turnStartTime ? Date.now() - this.turnStartTime : undefined;
    this.turnStartTime = null;

    const cost = estimateCost(model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens);
    const record: TurnRecord = {
      turn: this.turns.length + 1,
      model,
      provider,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      costEstimate: cost,
      timestamp: Date.now(),
      durationMs,
    };

    this.turns.push(record);
    this.persistTurn(record);
    return record;
  }

  // ── Queries ───────────────────────────────────────────────────────────

  /** All turns this session. */
  get allTurns(): readonly TurnRecord[] {
    return this.turns;
  }

  /** Session totals. */
  get totals(): {
    turns: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    totalTokens: number;
    cost: number;
    durationMs: number;
  } {
    let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, dur = 0;
    for (const t of this.turns) {
      input += t.inputTokens;
      output += t.outputTokens;
      cacheRead += t.cacheReadTokens;
      cacheWrite += t.cacheWriteTokens;
      dur += t.durationMs ?? 0;
    }
    return {
      turns: this.turns.length,
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      totalTokens: input + output,
      cost: this.turns.reduce((s, t) => s + t.costEstimate, 0),
      durationMs: dur,
    };
  }

  /** Get the last N turns. */
  lastTurns(n: number): TurnRecord[] {
    return this.turns.slice(-n);
  }

  // ── Historical queries ────────────────────────────────────────────────

  /** Load all sessions for a given date (YYYY-MM-DD). */
  static loadDay(date: string, ariesDir?: string): TurnRecord[] {
    const dir = join(ariesDir ?? join(homedir(), '.aries'), 'usage');
    const file = join(dir, `${date}.jsonl`);
    if (!existsSync(file)) return [];

    const lines = readFileSync(file, 'utf-8').split('\n').filter(Boolean);
    const records: TurnRecord[] = [];
    for (const line of lines) {
      try {
        records.push(JSON.parse(line) as TurnRecord);
      } catch { /* skip malformed */ }
    }
    return records;
  }

  /** Aggregate totals for a date range. */
  static aggregateRange(startDate: string, endDate: string, ariesDir?: string): {
    days: { date: string; turns: number; input: number; output: number; cost: number }[];
    total: { turns: number; input: number; output: number; cost: number };
  } {
    const days: { date: string; turns: number; input: number; output: number; cost: number }[] = [];
    let totalTurns = 0, totalInput = 0, totalOutput = 0, totalCost = 0;

    const start = new Date(startDate);
    const end = new Date(endDate);
    const current = new Date(start);

    while (current <= end) {
      const dateStr = current.toISOString().slice(0, 10);
      const records = UsageTracker.loadDay(dateStr, ariesDir);

      let input = 0, output = 0, cost = 0;
      for (const r of records) {
        input += r.inputTokens;
        output += r.outputTokens;
        cost += r.costEstimate;
      }

      if (records.length > 0) {
        days.push({ date: dateStr, turns: records.length, input, output, cost });
        totalTurns += records.length;
        totalInput += input;
        totalOutput += output;
        totalCost += cost;
      }

      current.setDate(current.getDate() + 1);
    }

    return {
      days,
      total: { turns: totalTurns, input: totalInput, output: totalOutput, cost: totalCost },
    };
  }

  // ── Persistence ───────────────────────────────────────────────────────

  private persistTurn(record: TurnRecord): void {
    const dateStr = new Date(record.timestamp).toISOString().slice(0, 10);
    const file = join(this.usageDir, `${dateStr}.jsonl`);
    const line = JSON.stringify({ ...record, sessionId: this.sessionId }) + '\n';

    try {
      appendFileSync(file, line, 'utf-8');
    } catch {
      // Telemetry should never crash the app
    }
  }

  /** Write session summary (call at session end). */
  persistSessionSummary(): void {
    const totals = this.totals;
    const summary: SessionSummary = {
      sessionId: this.sessionId,
      startedAt: this.startedAt,
      turns: totals.turns,
      totalInput: totals.inputTokens,
      totalOutput: totals.outputTokens,
      totalCacheRead: totals.cacheReadTokens,
      totalCacheWrite: totals.cacheWriteTokens,
      totalCost: totals.cost,
      primaryModel: this.primaryModel,
    };

    const dateStr = new Date(this.startedAt).toISOString().slice(0, 10);
    const file = join(this.usageDir, `${dateStr}-sessions.jsonl`);

    try {
      appendFileSync(file, JSON.stringify(summary) + '\n', 'utf-8');
    } catch {
      // Never crash
    }
  }
}

// ── Formatting helpers (for UI) ─────────────────────────────────────────────

export function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function formatCost(usd: number): string {
  if (usd < 0.01) return `$${(usd * 100).toFixed(2)}¢`;
  return `$${usd.toFixed(3)}`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}
