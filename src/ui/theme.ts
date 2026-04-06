// ── Color Palette ──────────────────────────────────────────────────────────
// Matches Claude Code's dark theme for visual parity.
// Single source of truth — change here to retheme everything.

export const colors = {
  // Core text
  text: '#ffffff',
  dim: '#999999',
  subtle: '#afafaf',
  inactive: '#999999',

  // Branding
  claude: '#d77757',       // Claude orange

  // Semantic
  success: '#4eba65',      // green — resolved tools
  error: '#ff6b80',        // red — errors, rejected tools
  warning: '#ffc107',      // yellow

  // UI elements
  suggestion: '#b1b9f9',   // blue-lilac — links, selected items, model picker
  permission: '#99ccff',   // light blue — permission prompts, modal borders
  autoAccept: '#af87ff',   // purple — auto-accept mode, bash border

  // Backgrounds
  userMessageBg: '#373737',       // user message fill
  messageActionsBg: '#2c323e',    // selected message highlight
  bashMessageBg: '#413c41',       // bash output

  // Borders
  border: '#666666',
  promptBorder: '#666666',
  bashBorder: '#af87ff',
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
