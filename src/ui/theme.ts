// Color palette matching Claude Code's dark theme
// All rendering uses these tokens — change here to retheme everything.

export const colors = {
  text: 'white',
  dim: 'gray',
  subtle: '#afafaf',
  border: '#999999',
  success: '#2c7a39',
  error: '#ab2b3f',
  userPointer: '#afafaf',
  suggestion: '#5769f7',
} as const;

// Special characters — platform-aware like Claude Code
export const figures = {
  pointer: '\u276F',       // ❯
  dot: process.platform === 'darwin' ? '\u23FA' : '\u25CF',  // ⏺ or ●
  toolResult: '\u237F',    // ⎿
} as const;
