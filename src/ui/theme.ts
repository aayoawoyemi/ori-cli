// ── Color Palette ──────────────────────────────────────────────────────────
// Ori Parchment Theme — warm walnut & gold.
// Inspired by oriminemos.com. Aged paper under lamplight, not a spaceship.
// Single source of truth — change here to retheme everything.

export const colors = {
  // Core text — warm cream, never cold white
  text: '#e8e0d4',           // warm cream — primary text
  dim: '#978a78',            // warm muted — labels, timestamps, metadata (AA 4.5+)
  subtle: '#a89880',         // warm mid — secondary text, descriptions
  inactive: '#7d7168',       // warm dark — disabled, very secondary (AA 3.0+ large)

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

  // Backgrounds — warm walnut tones
  userMessageBg: '#2a2520',         // dark walnut — user message fill
  messageActionsBg: '#302a24',      // slightly lighter walnut — selected message
  bashMessageBg: '#2e2822',         // warm dark — bash output

  // Borders — warm, not cold gray
  border: '#4a4238',
  promptBorder: '#4a4238',
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
} as const;
