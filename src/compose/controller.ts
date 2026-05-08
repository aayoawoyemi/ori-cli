/**
 * ComposeController — the request-scoped state machine for the compose
 * sub-loop. Lives inside the loop3 agent for the duration of one user
 * request; closes (and discards state) when the request loop terminates.
 *
 * Responsibilities:
 *   1. Track per-request state: mode, requestId, scoutCount, replCount,
 *      most recent preflight + update.
 *   2. Parse compose_preflight / compose_update blocks from accumulated
 *      assistant text and update internal state.
 *   3. Gate Repl execution: returns {allowed, reason} for each tool call
 *      based on current preflight/update presence and the scout budget.
 *   4. Emit telemetry events to the session log so bench rollups can
 *      measure preflight coverage, gate rejections, scout overruns, etc.
 *
 * The controller does NOT touch the scratch markdown file — that's owned
 * by the body's Scratch primitive, called via bridge.composeStart /
 * composeClose by the surrounding app (handleSubmit). Splitting concerns:
 * the controller is the in-memory state machine; the scratch is the
 * durable artifact. The two communicate only via mode transitions.
 *
 * Gate semantics (V1):
 *   - mode === 'quick' → always allow. No preflight, no scratch, no gate.
 *   - mode === 'compose' / 'goal':
 *       - First Repl in the request: requires a preceding <compose_preflight>.
 *         Reject with PreflightRequired if absent.
 *       - Subsequent Repls: require a <compose_update> since the prior Repl
 *         executed. Reject with UpdateRequired if absent.
 *       - If lastPreflight.cell_kind === 'scout' AND scoutCount >= scoutBudget:
 *         Reject with ScoutBudgetExceeded.
 *
 * Rejection envelopes are TYPED CODES + STRUCTURAL DATA, never corrective
 * prose. Same shape as SecurityError and PlannedPhaseWall (vault canon —
 * the dead-category rule). The model gets facts; the gate's existence
 * teaches the discipline by pattern, not by sentence.
 */
import { parseComposeBlocks, type ParsedPreflight, type ParsedUpdate } from './parser.js';
import type { RequestMode } from './router.js';

export interface GateDecision {
  allowed: boolean;
  /** Typed reason code + structural data when rejected. Null when allowed. */
  reason?: string;
  /** Telemetry-friendly classification when rejected. */
  reasonCode?: 'preflight_required' | 'update_required' | 'scout_budget_exceeded';
  /** When allowed via an exemption rule, the structural reason code. */
  exemptCode?: 'exempt_commit_only' | 'exempt_repair_after_exception';
}

export type ReplStatus = 'ok' | 'exception' | 'rejected' | 'timeout';

// Primitives that are commit, narration, or setup — not real composition work.
// A cell containing ONLY these calls (plus simple variable assignments + comments)
// is exempt from the gate. The 07-pi-parallel-tool failure (2026-05-08): model
// tried to fire a final done() cell after a repair, gate rejected for
// update_required, model dropped to natural-text completion instead of clean
// commit. Bench grader missed function names because the answer was rephrased
// rather than cited. Exempting commit-only cells fixes that without weakening
// the gate on actual work cells.
const EXEMPT_PRIMITIVE_RE =
  /^\s*(?:done|say|ask|plan\.[A-Za-z_]\w*|state\.(?:put|delete)|scratch\.[A-Za-z_]\w*)\s*\(/;
const ASSIGNMENT_THEN_EXEMPT_RE =
  /^\s*[A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*\s*=\s*(?:done|say|ask|plan\.[A-Za-z_]\w*|state\.(?:put|get|has|list|receipts|delete)|scratch\.[A-Za-z_]\w*)\s*\(/;
const COMMENT_RE = /^\s*#/;
const BARE_NAME_RE = /^\s*[A-Za-z_]\w*\s*$/;
const SIMPLE_LITERAL_ASSIGN_RE = /^\s*[A-Za-z_]\w*\s*=\s*(?:[A-Za-z_]\w*|"[^"]*"|'[^']*'|-?\d+(?:\.\d+)?|True|False|None)\s*$/;
const MULTILINE_LITERAL_ASSIGN_RE = /^\s*[A-Za-z_]\w*\s*=\s*[\[{(][\s\S]*[\]})]\s*$/;
const WORK_PRIMITIVE_RE =
  /\b(?:fs|codebase|shell|web|vault|research|compute|rlm|api|reindex)\s*(?:\.|\()/;
const DANGEROUS_EXPR_RE = /\b(?:eval|exec|compile|__import__|open)\s*\(/;

function logicalStatements(code: string): string[] {
  const statements: string[] = [];
  let current = '';
  let depth = 0;
  let quote: '"' | "'" | null = null;
  let tripleQuote: '"""' | "'''" | null = null;
  let escaped = false;

  for (const rawLine of code.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    current += current ? `\n${line}` : line;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!;
      const next3 = line.slice(i, i + 3);

      if (tripleQuote) {
        if (next3 === tripleQuote) {
          tripleQuote = null;
          i += 2;
        }
        continue;
      }

      if (quote) {
        if (escaped) {
          escaped = false;
        } else if (ch === '\\') {
          escaped = true;
        } else if (ch === quote) {
          quote = null;
        }
        continue;
      }

      if (next3 === '"""' || next3 === "'''") {
        tripleQuote = next3 as '"""' | "'''";
        i += 2;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        continue;
      }
      if (ch === '#') break;
      if (ch === '(' || ch === '[' || ch === '{') depth += 1;
      if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
    }

    if (depth === 0 && !quote && !tripleQuote) {
      statements.push(current);
      current = '';
    }
  }

  if (current.trim()) statements.push(current);
  return statements;
}

function isLiteralAssignmentStatement(statement: string): boolean {
  if (SIMPLE_LITERAL_ASSIGN_RE.test(statement)) return true;
  if (!MULTILINE_LITERAL_ASSIGN_RE.test(statement)) return false;
  return !WORK_PRIMITIVE_RE.test(statement) && !DANGEROUS_EXPR_RE.test(statement);
}

/**
 * True when every non-trivial statement in `code` is one of:
 *   - an exempt primitive call: done(...), say(...), ask(...), plan.<verb>(...),
 *     state.put or state.delete (...), scratch.<verb>(...)
 *   - a simple variable assignment from such a call: `result = state.get("x")`
 *   - a literal-only assignment: `flag = True`, `name = "x"`
 *   - a bare name reference: `result`
 *   - a comment or blank line
 *
 * Exempt cells skip the compose gate entirely. They are commit/narration/setup,
 * not composition. The discipline is for compositional work cells; closure
 * actions (done/say) and durable handoff (state.put) shouldn't be gated.
 *
 * Lenient by design — the regex accepts the natural shapes of commit cells
 * without trying to fully parse Python. False positives (a cell that looks
 * exempt but does hidden work) are not the failure mode we're fixing.
 * False negatives (a real commit cell that looks composed) get gated as
 * normal — same as today's behavior. The gain is unidirectional.
 */
export function isExemptOnlyCell(code: string): boolean {
  let foundAnyStatement = false;
  for (const statement of logicalStatements(code)) {
    const line = statement.trim();
    if (!line || COMMENT_RE.test(line)) continue;
    foundAnyStatement = true;
    if (EXEMPT_PRIMITIVE_RE.test(line)) continue;
    if (ASSIGNMENT_THEN_EXEMPT_RE.test(line)) continue;
    if (isLiteralAssignmentStatement(line)) continue;
    if (BARE_NAME_RE.test(line)) continue;
    return false;
  }
  // Empty cells (no statements at all) are not exempt — they're noise; let the
  // gate handle them so we don't accidentally pass a no-op past the discipline.
  return foundAnyStatement;
}

export interface ComposeTelemetry {
  preflights_parsed: number;
  updates_parsed: number;
  gate_rejections: number;
  scout_count: number;
  repl_count: number;
}

export interface ComposeControllerOptions {
  mode: RequestMode;
  requestId: string;
  scoutBudget?: number;
  /** Optional callback for telemetry emissions. */
  onEvent?: (event: { type: string; [k: string]: unknown }) => void;
}

export class ComposeController {
  readonly mode: RequestMode;
  readonly requestId: string;
  readonly scoutBudget: number;
  private readonly onEvent: (event: { type: string; [k: string]: unknown }) => void;

  private replCount: number = 0;
  private scoutCount: number = 0;
  private gateRejections: number = 0;
  private preflightsParsed: number = 0;
  private updatesParsed: number = 0;

  // Set true at start of request and after each Repl executes.
  // Cleared when a preflight is parsed in subsequent assistant text.
  private needsPreflight: boolean = true;
  // Set true after a Repl executes. Cleared when an update is parsed.
  // First Repl call: false (no prior Repl, so no update needed).
  private needsUpdate: boolean = false;

  // Most-recent parsed blocks. Cleared after they "satisfy" their gate so
  // the model can't reuse one preflight for two consecutive Repl calls.
  private pendingPreflight: ParsedPreflight | null = null;
  private pendingUpdate: ParsedUpdate | null = null;
  // Status of the most recent Repl exec. Used by V2 to exempt repair cells
  // from update_required when the prior cell exceptioned (the repair preflight
  // IS the implicit update for the failure). Null before any cell has run.
  private lastReplStatus: ReplStatus | null = null;
  // Raw block identities are intentionally separate from pending* state.
  // pendingPreflight is cleared after a Repl consumes it, but the same raw
  // preflight may still be the last block in accumulatedText on the next
  // turn. Without these seen markers, adding a later compose_update would
  // cause parseComposeBlocks(accumulatedText) to rediscover and recount the
  // old preflight.
  private seenPreflightRaw: string | null = null;
  private seenUpdateRaw: string | null = null;

  // Tracks how much of the accumulated assistant text we've already parsed.
  // Avoids reparsing the same blocks across multiple text deltas in one turn.
  private parsedTextLength: number = 0;
  private accumulatedText: string = '';

  constructor(opts: ComposeControllerOptions) {
    this.mode = opts.mode;
    this.requestId = opts.requestId;
    this.scoutBudget = opts.scoutBudget ?? 2;
    this.onEvent = opts.onEvent ?? (() => {});
  }

  /** Quick mode skips all gating. */
  get isQuickMode(): boolean {
    return this.mode === 'quick';
  }

  /**
   * Feed an incremental text delta. Cheap — just appends to the buffer.
   * Use parseAccumulatedText() at assistant_message boundaries to actually
   * extract blocks.
   */
  feedText(delta: string): void {
    this.accumulatedText += delta;
  }

  /**
   * Parse compose blocks out of the full accumulated text and update state.
   * Idempotent across calls within the same turn — only NEW text is reparsed
   * if the same buffer is passed in repeatedly.
   *
   * Returns whether new preflight/update was found.
   */
  parseAccumulatedText(fullText: string): { newPreflight: boolean; newUpdate: boolean } {
    // The agent sometimes feeds the assembled assistant text directly rather
    // than relying on the accumulator (cleaner: one source of truth at the
    // boundary). Honor whichever is longer so we never miss text.
    if (fullText.length > this.accumulatedText.length) {
      this.accumulatedText = fullText;
    }
    if (this.accumulatedText.length === this.parsedTextLength) {
      return { newPreflight: false, newUpdate: false };
    }
    const result = parseComposeBlocks(this.accumulatedText);
    this.parsedTextLength = this.accumulatedText.length;

    let newPreflight = false;
    let newUpdate = false;
    if (result.preflight && result.preflight.raw !== this.seenPreflightRaw) {
      this.pendingPreflight = result.preflight;
      this.seenPreflightRaw = result.preflight.raw;
      this.needsPreflight = false;
      this.preflightsParsed += 1;
      newPreflight = true;
      this.onEvent({
        type: 'compose_preflight_parsed',
        request_id: this.requestId,
        cell_kind: result.preflight.cell_kind,
        primitives: result.preflight.primitives,
        purpose_chars: result.preflight.purpose?.length ?? 0,
      });
    }
    if (result.update && result.update.raw !== this.seenUpdateRaw) {
      this.pendingUpdate = result.update;
      this.seenUpdateRaw = result.update.raw;
      this.needsUpdate = false;
      this.updatesParsed += 1;
      newUpdate = true;
      this.onEvent({
        type: 'compose_update_parsed',
        request_id: this.requestId,
        findings_chars: result.update.findings?.length ?? 0,
        next_move_chars: result.update.next_move?.length ?? 0,
      });
    }
    for (const w of result.warnings) {
      this.onEvent({
        type: 'compose_parser_warning',
        request_id: this.requestId,
        warning: w,
      });
    }
    return { newPreflight, newUpdate };
  }

  /**
   * Decide whether the next Repl call is allowed under current state.
   * Returns {allowed: true} for quick mode and for compose mode when the
   * preflight/update contract is satisfied. Returns {allowed: false, reason}
   * otherwise — the reason is a typed code + structural facts, never prose.
   *
   * V2 (2026-05-08): the optional `cellCode` parameter enables pre-shape
   * inspection. Cells that contain only commit/narration/setup primitives
   * (done, say, ask, plan.<verb>, state.put, scratch.<verb>) skip the gate
   * entirely. They are closure, not composition. Repair cells after an
   * exception also skip update_required because the repair preflight IS
   * the implicit update for the prior failure. Both exemptions emit
   * `compose_gate_exempt` telemetry so bench rollups can distinguish
   * "model behaved" from "gate let it through" from "gate caught a real
   * lapse."
   */
  gateRepl(cellCode?: string): GateDecision {
    if (this.isQuickMode) return { allowed: true };

    // ── V2 exemption A: commit/narration cells skip the gate entirely ──
    // The 07-pi-parallel-tool failure: gate rejected a final done() cell
    // for update_required, model dropped to natural-text completion, bench
    // grader pattern-match missed the answer. Commit cells aren't work, so
    // gating them on update_required is the wrong shape. Note we exempt
    // BOTH preflight_required AND update_required for these — the model
    // can fire a final done(answer) at any point without ceremony.
    if (cellCode && isExemptOnlyCell(cellCode)) {
      this.onEvent({
        type: 'compose_gate_exempt',
        request_id: this.requestId,
        reason_code: 'exempt_commit_only',
        cell_code_chars: cellCode.length,
      });
      return { allowed: true, exemptCode: 'exempt_commit_only' };
    }

    // ── V2 exemption B: repair-after-exception satisfies update_required ──
    // The repair preflight (cell_kind: repair) IS the response to the prior
    // cell's exception. Forcing a separate <compose_update> between exception
    // and repair is ceremonial — the repair declaration already explains the
    // recovery. Other gate checks (preflight_required, scout_budget) still
    // apply; only update_required gets bypassed in this specific shape.
    const isRepairAfterException =
      this.lastReplStatus === 'exception' &&
      this.pendingPreflight?.cell_kind === 'repair';

    if (this.needsPreflight) {
      this.gateRejections += 1;
      const reason = `ComposeGate: reason=preflight_required mode=${this.mode} request_id=${this.requestId} ` +
        `repl_count=${this.replCount} scout_count=${this.scoutCount} ` +
        `accepts_block=compose_preflight`;
      this.onEvent({
        type: 'compose_gate_rejected',
        request_id: this.requestId,
        reason_code: 'preflight_required',
        repl_count: this.replCount,
      });
      return { allowed: false, reason, reasonCode: 'preflight_required' };
    }

    if (this.needsUpdate) {
      // V2 exemption B applies here: a repair preflight after an exception
      // bypasses the update_required gate. The repair IS the update.
      if (isRepairAfterException) {
        this.onEvent({
          type: 'compose_gate_exempt',
          request_id: this.requestId,
          reason_code: 'exempt_repair_after_exception',
          repl_count: this.replCount,
        });
        // Mark the update as satisfied so subsequent cells don't keep
        // tripping on the same exception. Repair preflight = implicit update.
        this.needsUpdate = false;
      } else {
        this.gateRejections += 1;
        const reason = `ComposeGate: reason=update_required mode=${this.mode} request_id=${this.requestId} ` +
          `repl_count=${this.replCount} ` +
          `accepts_block=compose_update`;
        this.onEvent({
          type: 'compose_gate_rejected',
          request_id: this.requestId,
          reason_code: 'update_required',
          repl_count: this.replCount,
        });
        return { allowed: false, reason, reasonCode: 'update_required' };
      }
    }

    if (this.pendingPreflight?.cell_kind === 'scout' && this.scoutCount >= this.scoutBudget) {
      this.gateRejections += 1;
      const reason = `ComposeGate: reason=scout_budget_exceeded mode=${this.mode} request_id=${this.requestId} ` +
        `scout_count=${this.scoutCount} budget=${this.scoutBudget} ` +
        `pending_cell_kind=${this.pendingPreflight.cell_kind} accepted_cell_kinds=composed,verify,repair,commit`;
      this.onEvent({
        type: 'compose_gate_rejected',
        request_id: this.requestId,
        reason_code: 'scout_budget_exceeded',
        scout_count: this.scoutCount,
        budget: this.scoutBudget,
      });
      return { allowed: false, reason, reasonCode: 'scout_budget_exceeded' };
    }

    return { allowed: true };
  }

  /**
   * Record that a Repl just executed. Increments counters, sets needsUpdate
   * for the next gate check, and clears the pending preflight (one preflight
   * = one cell — the model can't reuse it).
   *
   * V2: optionally takes the exec status so the controller can track when
   * the prior cell exceptioned. A subsequent cell with cell_kind=repair then
   * bypasses update_required (the repair IS the implicit update). Without
   * the status, lastReplStatus stays at whatever it was — back-compat for
   * callers that don't pass it (smokes, headless paths during transition).
   */
  recordReplExecuted(status?: ReplStatus): void {
    this.replCount += 1;
    if (this.pendingPreflight?.cell_kind === 'scout') {
      this.scoutCount += 1;
    }
    this.pendingPreflight = null;
    if (status !== undefined) {
      this.lastReplStatus = status;
    }
    if (!this.isQuickMode) {
      this.needsUpdate = true;
    }
    this.onEvent({
      type: 'repl_after_preflight',
      request_id: this.requestId,
      repl_count: this.replCount,
      scout_count: this.scoutCount,
      status,
    });
  }

  /**
   * Snapshot of internal counters for telemetry / scratch close events.
   */
  telemetry(): ComposeTelemetry {
    return {
      preflights_parsed: this.preflightsParsed,
      updates_parsed: this.updatesParsed,
      gate_rejections: this.gateRejections,
      scout_count: this.scoutCount,
      repl_count: this.replCount,
    };
  }

  /** Pending preflight (cleared after recordReplExecuted). For tests/inspection. */
  peekPreflight(): ParsedPreflight | null {
    return this.pendingPreflight;
  }

  /** Pending update (cleared after parseAccumulatedText absorbs the next one). */
  peekUpdate(): ParsedUpdate | null {
    return this.pendingUpdate;
  }
}
