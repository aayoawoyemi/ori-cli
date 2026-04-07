// ── Color Palette ──────────────────────────────────────────────────────────
// Ori Parchment Theme — warm cream, no yellow tint.
// Dark parchment feel: like working on aged paper under soft light.
// Single source of truth — change here to retheme everything.

export const colors = {
  // Core text — warm cream, not yellow
  text: '#e4e0da',           // parchment cream — primary text (warm, not yellow)
  dim: '#958e84',            // warm muted — labels, timestamps, metadata
  subtle: '#a69e94',         // warm mid — secondary text, descriptions
  inactive: '#7a746c',       // warm dark — disabled, very secondary

  // Branding
  claude: '#c4a46c',         // antique gold — the Ori accent (spinner, headers)

  // Semantic — warm versions, no neon
  success: '#7d9b6b',        // sage green — resolved tools, confirmations
  error: '#c47a6c',          // terracotta — errors, rejected tools
  warning: '#d4a040',        // amber — warnings, caution

  // UI elements
  suggestion: '#c4a46c',     // gold — links, selected items, model picker
  permission: '#bfa87a',     // warm gold — permission prompts, modal borders
  autoAccept: '#a89068',     // warm bronze — auto-accept mode
  research: '#8a9fa8',       // muted slate blue — research/exploration mode

  // Backgrounds — dark parchment, warm but not yellow
  userMessageBg: '#272523',         // dark parchment — user message fill
  messageActionsBg: '#2c2a27',      // slightly lighter — selected message
  bashMessageBg: '#2a2825',         // warm dark — bash output

  // Borders — warm, not cold
  border: '#44403a',
  promptBorder: '#44403a',
  bashBorder: '#a89068',            // warm bronze — bash mode border
} as const;

// ── Unicode Glyphs ────────────────────────────────────────────────────────
// Exact characters from Claude Code's constants/figures.ts

const isMac = process.platform === 'darwin';

export const figures = {
  // Prompt & messages
  pointer: '\u276F',                              // ❯
  dot: isMac ? '\u23FA' : '\u25CF',               // ⏺ (mac) or ● (win/linux)
  toolResult: '\u23BF',                            // ⎿
  thinking: '\u2234',                              // ∴
  compact: '\u2738',                               // ✻
  reference: '\u203B',                             // ※
  bullet: '\u2219',                                // ∙

  // Borders & layout
  divider: '\u2500',                               // ─
  modalBorder: '\u2594',                           // ▔
  blockquote: '\u258E',                            // ▎
  arrowDown: '\u2193',                             // ↓

  // Effort
  effortLow: '\u25CB',                             // ○
  effortMedium: '\u25D0',                          // ◐
  effortHigh: '\u25CF',                            // ●
  effortMax: '\u25C9',                             // ◉

  // Mode indicators
  lightning: '\u21AF',                             // ↯
  planMode: '\u23F8',                              // ⏸
  autoMode: '\u23F5\u23F5',                        // ⏵⏵
  researchMode: '\u2315',                          // ⌕
} as const;
