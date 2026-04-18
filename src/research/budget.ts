/**
 * Token budget for a research session. Lets the pipeline decide when to
 * stop spending on model calls (extract, reflect, synthesize, etc.) before
 * the user-configured ceiling is hit.
 *
 * This is deliberately a heuristic — we estimate prompt + response token cost
 * from character length (~4 chars / token for English). Good enough for
 * budget gating; token-accurate accounting would require per-provider
 * tokenizers and isn't worth the plumbing for a stop-spending gate.
 */
export class Budget {
  private readonly _max: number;
  private _spent: number = 0;
  private _exhausted = false;

  constructor(maxTokens: number) {
    this._max = Math.max(0, maxTokens);
  }

  get max(): number { return this._max; }
  get spent(): number { return this._spent; }
  get exhausted(): boolean { return this._exhausted; }

  remaining(): number {
    return Math.max(0, this._max - this._spent);
  }

  /** True if there's enough headroom for a call of the given minimum size. */
  hasRemaining(minTokens: number = 0): boolean {
    return this.remaining() > minTokens;
  }

  deduct(tokens: number): void {
    this._spent += Math.max(0, tokens);
    if (this._spent >= this._max) {
      this._exhausted = true;
    }
  }

  /**
   * Hard limit enforcement. Call before any expensive operation.
   * Throws BudgetExhaustedError when the budget is spent beyond headroom.
   * Unlike hasRemaining (soft check), this is the gate that actually stops work.
   */
  enforce(minTokens: number = 0): void {
    if (!this.hasRemaining(minTokens)) {
      this._exhausted = true;
      throw new BudgetExhaustedError(this._max, this._spent, minTokens);
    }
  }

  /** Estimate token cost of a string (~4 chars/token) and deduct. */
  estimateAndDeduct(...texts: string[]): void {
    const total = texts.reduce((acc, t) => acc + (t?.length ?? 0), 0);
    this.deduct(Math.ceil(total / 4));
  }

  toJSON(): { max: number; spent: number; remaining: number } {
    return { max: this._max, spent: this._spent, remaining: this.remaining() };
  }
}

export class BudgetExhaustedError extends Error {
  readonly max: number;
  readonly spent: number;
  readonly minTokens: number;

  constructor(max: number, spent: number, minTokens: number) {
    super(`Budget exhausted: spent ${spent}/${max} tokens (needed ${minTokens} more)`);
    this.name = 'BudgetExhaustedError';
    this.max = max;
    this.spent = spent;
    this.minTokens = minTokens;
  }
}

/** Default token budget per depth. Tune as the engine improves. */
export const DEPTH_BUDGETS: Record<'quick' | 'standard' | 'deep' | 'exhaustive', number> = {
  quick:      50_000,
  standard:   200_000,
  deep:       800_000,
  exhaustive: 3_000_000,
};
