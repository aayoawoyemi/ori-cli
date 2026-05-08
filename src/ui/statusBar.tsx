// File: src/ui/statusBar.tsx
// Redesigned 2026-04-29

import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { colors, figures } from './theme.js';
import { homedir } from 'node:os';
import type { PermissionMode } from '../loop.js';

export interface StatusBarProps {
  cwd: string;
  gitBranch?: string | null;
  indexedFiles?: number;
  sessionTitle?: string | null;
  model: string;
  provider?: string;
  effort: string;
  tokenCount: number;
  contextWindow: number;
  inputTokens?: number;
  outputTokens?: number;
  cost?: number;
  isLoading: boolean;
  permissionMode?: PermissionMode;
  taskMode?: 'normal' | 'explore';
  // True when the running Python body subprocess is stale relative to the
  // current source on disk. Body code does not hot-reload — body/*.py edits
  // require a CLI restart to take effect. We surface this so the user knows
  // when dogfooding signal is unreliable (changes shipped but not in effect).
  bodyStale?: boolean;
  // Compose sub-loop active mode for the current request. Null when no
  // request is in flight. 'quick' is silent (default lane); 'compose' and
  // 'goal' get a compact indicator since they activate visible structure.
  composeMode?: 'quick' | 'compose' | 'goal' | null;
}

const EFFORT_SYMBOL: Record<string, string> = { low: figures.effortLow, medium: figures.effortMedium, high: figures.effortHigh, max: figures.effortMax };

const MODE_DISPLAY: Record<PermissionMode, { symbol: string; label: string; color: string } | null> = {
  default: null,
  accept: { symbol: figures.autoMode, label: 'accept edits on', color: colors.autoAccept },
  plan: { symbol: figures.planMode, label: 'plan mode', color: colors.permission },
  research: { symbol: figures.researchMode, label: 'research mode', color: colors.research },
  yolo: { symbol: figures.autoMode, label: 'yolo', color: colors.error },
};

function shortenCwd(cwd: string): string {
  const home = homedir();
  let display = cwd.replace(/\\/g, '/');
  const homeNorm = home.replace(/\\/g, '/');
  if (display.startsWith(homeNorm)) { display = '~' + display.slice(homeNorm.length); }
  return display;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

function formatCostShort(usd: number): string {
  if (usd === 0) return '$0';
  if (usd < 0.001) return '<$0.001';
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

function progressIndicator(fraction: number, barWidth: number): { circle: string; bar: string; color: string | undefined } {
  const clamped = Math.max(0, Math.min(1, fraction));
  const pct = Math.round(clamped * 100);
  // Double-width filling indicator for visibility
  let circle: string;
  if (clamped <= 0)       circle = '○○';     // ○○ empty
  else if (clamped < 0.15) circle = '◔○';    // quarter + empty
  else if (clamped < 0.30) circle = '◔◔';    // quarter + quarter
  else if (clamped < 0.45) circle = '◑◔';    // half + quarter
  else if (clamped < 0.60) circle = '◑◑';    // half + half
  else if (clamped < 0.75) circle = '◕◑';    // three-quarter + half
  else if (clamped < 0.90) circle = '◕◕';    // three-quarter + three-quarter
  else                     circle = '●●';     // full + full
  const filled = Math.round(clamped * barWidth);
  const empty = barWidth - filled;
  const bar = '█'.repeat(filled) + '░'.repeat(empty);
  let color: string | undefined;
  if (pct >= 95) color = colors.error;
  else if (pct >= 80) color = colors.warning;
  return { circle, bar, color };
}

export function StatusBar({
  cwd, gitBranch, indexedFiles, sessionTitle,
  model, provider, effort,
  tokenCount, contextWindow, inputTokens = 0, outputTokens = 0, cost = 0,
  isLoading, permissionMode = 'default', taskMode = 'normal',
  bodyStale = false, composeMode = null,
}: StatusBarProps): React.ReactElement {
  // Subtle pulse on the context circle â€” alternates between dim and
  // normal every 2s. So gentle you barely notice, but alive.
  const [pulse, setPulse] = useState(false);
  useEffect(() => {
    const id = setInterval(() => setPulse(p => !p), 2000);
    return () => clearInterval(id);
  }, []);

  const width = process.stdout.columns || 80;
  const pct = contextWindow > 0 ? Math.round((tokenCount / contextWindow) * 100) : 0;
  const effortSym = EFFORT_SYMBOL[effort] ?? figures.effortMedium;
  const { circle, bar, color: barColor } = progressIndicator(tokenCount / Math.max(contextWindow, 1), 20);
  const modeInfo = MODE_DISPLAY[permissionMode];
  const cwdShort = shortenCwd(cwd);
  const branchPart = gitBranch ? ` (${gitBranch})` : '';
  const indexPart = indexedFiles != null ? ` [${indexedFiles} files]` : '';
  const titlePart = sessionTitle ? ` \u2219 ${sessionTitle}` : '';
  const statsText = `\u2191${formatTokens(inputTokens)} \u2193${formatTokens(outputTokens)} ${formatCostShort(cost)}`;
  const barAndPct = `${pct}%/${formatTokens(contextWindow)}`;
  const modelText = `${provider ? `(${provider}) ` : ''}${model} ${effortSym} ${effort}`;
  const leftLen = 2 + statsText.length + 2 + 1 + 1 + barAndPct.length;
  const gap = Math.max(2, width - leftLen - modelText.length);
  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text color={colors.dim}>{cwdShort}{branchPart}{indexPart}{titlePart}</Text>
      </Box>
      <Box flexDirection="row">
        <Text dimColor>{' '.repeat(2)}{statsText}{'  '}</Text>
        <Text color={barColor || (pulse ? colors.claude : undefined)} dimColor={!barColor && !pulse}>{circle}</Text>
        <Text dimColor={pct < 80} color={barColor}>{' '}{barAndPct}</Text>
        <Text>{' '.repeat(gap)}</Text>
        <Text dimColor>{modelText}</Text>
      </Box>
      {modeInfo ? (
        <Box flexDirection="row">
          <Text color={modeInfo.color}>{'  '}{modeInfo.symbol} {modeInfo.label}</Text>
          {permissionMode === 'plan'
            ? <Text dimColor> (meta+q: finish plan \u00b7 meta+m to cycle)</Text>
            : <Text dimColor> (meta+m to cycle)</Text>
          }
        </Box>
      ) : null}
      {taskMode === 'explore' ? (
        <Box flexDirection="row">
          <Text color={colors.research}>{'  '}explore mode</Text>
          <Text dimColor> (meta+z to exit)</Text>
        </Box>
      ) : null}
      {bodyStale ? (
        <Box flexDirection="row">
          <Text color={colors.error}>{'  '}body stale</Text>
          <Text dimColor> restart CLI for body/*.py changes</Text>
        </Box>
      ) : null}
      {composeMode && composeMode !== 'quick' ? (
        <Box flexDirection="row">
          <Text color={colors.research}>{'  '}{figures.pointer} {composeMode === 'goal' ? 'goal compose' : 'compose'}</Text>
          <Text dimColor> scratch+gate</Text>
        </Box>
      ) : null}
    </Box>
  );
}
