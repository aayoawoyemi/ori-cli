/**
 * Request mode auto-router.
 *
 * Every top-level user message gets routed to one of three lanes BEFORE
 * agentLoop3() is invoked. The lanes are orthogonal mechanisms with
 * different forcing functions:
 *
 *   - quick:    trivial questions, math, single-fact lookup. No scratch,
 *               no preflight gate, no ceremony. Default Loop3 behavior.
 *   - compose:  default for task-shaped requests (build, fix, look deeply,
 *               investigate, etc.). Scratch doc created. Preflight required
 *               before each Repl call. Update required after each Repl.
 *               This is where the new ComposeLoop sub-loop lives.
 *   - goal:     explicit /goal only. Long-running objective lifecycle —
 *               persistent objective + idle continuation. Currently uses
 *               the legacy buildGoalModePrompt path; full Codex-style goal
 *               runtime is deferred to a later tier.
 *
 * Default when uncertain: compose. False compose costs mild ceremony;
 * false quick recreates the dogfood failure pattern (model micro-steps
 * 21 times when given a "find 3 brain notes" task). Bias is intentional.
 *
 * Triggers:
 *   - Explicit prefix markers: #quick, #compose, #goal (one of these is
 *     prepended by the corresponding slash command, e.g. /compose foo →
 *     handleSubmit("#compose foo")). These take absolute precedence.
 *   - Verb heuristics: "build", "fix", "look deeply", "audit", etc. at
 *     the start or after common preambles ("please", "can you", "lets").
 *   - Multi-artifact phrases: "across the codebase", "each file", etc.
 *   - Short question shape: messages under 80 chars starting with
 *     interrogatives or ending with "?" → quick.
 *   - Otherwise → compose (the safe default for real work).
 *
 * This is a pure function. Behavior is fully determined by the input
 * text. No side effects, no harness state read, no env. Testable in
 * isolation.
 */

export type RequestMode = 'quick' | 'compose' | 'goal';

export type RequestModeReason =
  | 'slash'           // explicit #compose / #quick / #goal prefix
  | 'verb_match'      // matched a known compose-shaped verb
  | 'phrase_match'    // matched a multi-artifact phrase
  | 'short_question'  // looked like a quick lookup
  | 'default';        // bias-to-compose fallback

export interface ClassifyResult {
  mode: RequestMode;
  reason: RequestModeReason;
  /** What in the input matched. For verb/phrase matches: the verb/phrase. */
  matchedTrigger?: string;
  /**
   * The user text with any leading mode marker stripped. The model never
   * sees `#compose`, `#quick`, or `#goal` markers — they're harness signals
   * only and would clutter context if forwarded.
   */
  cleanedText: string;
}

// Compose-shaped verbs at the start of a message (or after a polite preamble).
// Order matters slightly: longer phrases first so "look section by section"
// matches before "look".
const COMPOSE_VERBS: ReadonlyArray<string> = [
  'look section by section', 'look at this in detail', 'look deeply',
  'walk through', 'go through', 'work through',
  'analyze section by section', 'analyze in detail',
  'find and synthesize', 'find and summarize', 'find and explain',
  'add support for', 'add a feature', 'add tests for',
  'figure out', 'work out', 'reason through',
  'build', 'fix', 'implement', 'edit', 'refactor', 'rewrite',
  'test', 'bench', 'benchmark', 'audit', 'review',
  'investigate', 'diagnose', 'reproduce', 'debug', 'profile',
  'compare', 'analyze', 'optimize', 'verify',
  'trace', 'map', 'walk',
];

// Multi-artifact / multi-step phrases anywhere in the message.
const COMPOSE_PHRASES: ReadonlyArray<string> = [
  'across the codebase', 'across the repo', 'across the project',
  'every file', 'each file', 'all the files', 'all of the',
  'in parallel', 'step by step', 'one at a time',
  'multiple', 'several',
  'and synthesize', 'and summarize',
  'find the', 'list the',
  'section by section', 'piece by piece',
];

// Interrogative words that signal a quick question when the message is short.
const INTERROGATIVES_RE = /^(what|where|when|why|who|how|which|is|are|can|does|do|did|will|would|should)\b/i;

// Common polite preambles. Verb match is allowed at the start OR right after
// one of these (with optional comma).
const PREAMBLES: ReadonlyArray<string> = [
  "please", "can you", "could you", "would you", "let's", "lets", "let us",
  "i want to", "i need to", "help me", "go and", "go ahead and",
];

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchVerb(lower: string): { verb: string } | null {
  const preambleAlt = PREAMBLES.map(escapeRegex).join('|');
  for (const verb of COMPOSE_VERBS) {
    const verbPattern = escapeRegex(verb).replace(/\\?\s+/g, '\\s+');
    const re = new RegExp(`(?:^|^(?:${preambleAlt})[,\\s]+)${verbPattern}\\b`, 'i');
    if (re.test(lower)) return { verb };
  }
  return null;
}

function matchPhrase(lower: string): { phrase: string } | null {
  for (const phrase of COMPOSE_PHRASES) {
    if (lower.includes(phrase)) return { phrase };
  }
  return null;
}

/**
 * Classify a user message into one of three request modes.
 *
 * Pure function — same input always produces same output. Caller is
 * responsible for using the cleanedText (mode markers stripped) and for
 * acting on the mode (creating scratch, etc.).
 */
export function classifyRequestMode(userText: string): ClassifyResult {
  const trimmed = userText.trim();

  // ── Explicit mode prefix markers (highest precedence) ──────────────
  // /compose, /quick, /goal slash commands prepend these markers before
  // calling handleSubmit, so they round-trip cleanly through the existing
  // input flow. Strip the marker so the model never sees it. Both `#goal`
  // and `\goal` (backslash variant, legacy parseGoalTrigger compat) match.
  const markerMatch = trimmed.match(/^[#\\](quick|compose|goal)\b\s*([\s\S]*)$/i);
  if (markerMatch) {
    return {
      mode: markerMatch[1]!.toLowerCase() as RequestMode,
      reason: 'slash',
      matchedTrigger: `#${markerMatch[1]!.toLowerCase()}`,
      cleanedText: (markerMatch[2] ?? '').trim(),
    };
  }

  // Empty input → quick (degenerate; nothing for compose to work on).
  if (!trimmed) {
    return { mode: 'quick', reason: 'default', cleanedText: '' };
  }

  const lower = trimmed.toLowerCase();

  // ── Verb match: build/fix/audit/etc. at start of message ───────────
  const verbHit = matchVerb(lower);
  if (verbHit) {
    return {
      mode: 'compose',
      reason: 'verb_match',
      matchedTrigger: verbHit.verb,
      cleanedText: trimmed,
    };
  }

  // ── Phrase match: across the codebase / each file / etc. ────────────
  const phraseHit = matchPhrase(lower);
  if (phraseHit) {
    return {
      mode: 'compose',
      reason: 'phrase_match',
      matchedTrigger: phraseHit.phrase,
      cleanedText: trimmed,
    };
  }

  // ── Short question shape: ≤80 chars + interrogative or trailing ? ──
  // These look like fact lookups or definitions. Quick mode is right for
  // them — no need to spin up a scratch doc and gate to answer "what is X".
  if (trimmed.length <= 80 && (trimmed.endsWith('?') || INTERROGATIVES_RE.test(trimmed))) {
    return { mode: 'quick', reason: 'short_question', cleanedText: trimmed };
  }

  // ── Default: bias to compose ───────────────────────────────────────
  // When uncertain, prefer compose. False compose costs ~50 tokens of
  // ceremony (preflight emit + parse). False quick lets the model
  // micro-step on real tasks — that's the dogfood failure we're fixing.
  return { mode: 'compose', reason: 'default', cleanedText: trimmed };
}

/**
 * Generate a short request id. Used to scope scratch files and tag
 * telemetry events. Format: `req_<8-hex-from-randomUUID>` keeps it
 * filesystem-safe and short enough for log lines.
 */
export function newRequestId(): string {
  // crypto.randomUUID is available on Node ≥ 14.17 (we require ≥ 22).
  // Take the first 8 hex chars — collision risk inside a single session
  // is negligible at that length.
  const uuid = (globalThis.crypto as Crypto | undefined)?.randomUUID?.()
    ?? Math.random().toString(16).slice(2, 10);
  return `req_${uuid.replace(/-/g, '').slice(0, 8)}`;
}
