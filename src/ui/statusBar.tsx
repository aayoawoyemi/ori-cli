import React from 'react';
import { Box, Text } from 'ink';
import { colors, figures } from './theme.js';
import type { PermissionMode } from '../loop.js';

interface StatusBarProps {
  model: string;
  effort: string;
  tokenCount: number;
  contextWindow: number;
  vaultNotes?: number;
  isLoading: boolean;
  permissionMode?: PermissionMode;
  sessionTitle?: string | null;
  taskMode?: 'normal' | 'explore';
}

const EFFORT_SYMBOL: Record<string, string> = {
  low: figures.effortLow,
  medium: figures.effortMedium,
  high: figures.effortHigh,
};

const MODE_DISPLAY: Record<PermissionMode, { symbol: string; label: string; color: string } | null> = {
  default: null,
  accept: { symbol: figures.autoMode, label: 'accept edits on', color: colors.autoAccept },
  plan: { symbol: figures.planMode, label: 'plan mode', color: colors.permission },
  research: { symbol: figures.researchMode, label: 'research mode', color: colors.research },
  yolo: { symbol: figures.autoMode, label: 'yolo', color: colors.error },
};

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

function progressBar(fraction: number, width: number): string {
  const clamped = Math.max(0, Math.min(1, fraction));
  const filled = Math.round(clamped * width);
  const empty = width - filled;
  return '\u2588'.repeat(filled) + '\u2591'.repeat(empty);
}

export function StatusBar({
  model, effort, tokenCount, contextWindow, vaultNotes, isLoading, permissionMode = 'default', sessionTitle, taskMode = 'normal',
}: StatusBarProps): React.ReactElement {
  const pct = contextWindow > 0 ? Math.round((tokenCount / contextWindow) * 100) : 0;
  const effortSym = EFFORT_SYMBOL[effort] ?? figures.effortMedium;
  const bar = progressBar(tokenCount / Math.max(contextWindow, 1), 20);
  const modeInfo = MODE_DISPLAY[permissionMode];

  return (
    <Box flexDirection="column">
      {/* Session title — shown when set */}
      {sessionTitle && (
        <Box>
          <Text color={colors.suggestion}>{figures.bullet} {sessionTitle}</Text>
        </Box>
      )}
      {/* Line 1: model + progress bar + tokens */}
      <Box flexDirection="row">
        <Text dimColor>[{model}] {bar}  </Text>
        <Text color={pct >= 95 ? colors.error : pct >= 80 ? colors.warning : undefined} dimColor={pct < 80}>
          {pct}% | {formatTokens(tokenCount)}/{formatTokens(contextWindow)} tokens
        </Text>
        {pct >= 80 && pct < 95 && <Text color={colors.warning}> — consider /compact</Text>}
        {pct >= 95 && <Text color={colors.error}> — compaction imminent</Text>}
        {vaultNotes !== undefined && <Text dimColor> | vault: {vaultNotes}</Text>}
      </Box>

      {/* Line 2: mode indicator (only when non-default) */}
      {modeInfo ? (
        <Box flexDirection="row">
          <Text color={modeInfo.color}>{modeInfo.symbol} {modeInfo.label}</Text>
          {permissionMode === 'plan'
            ? <Text dimColor> (meta+q: finish plan · meta+m to cycle)</Text>
            : <Text dimColor> (meta+m to cycle)</Text>
          }
        </Box>
      ) : null}
      {taskMode === 'explore' ? (
        <Box flexDirection="row">
          <Text color={colors.research}>🔍 explore mode</Text>
          <Text dimColor> (meta+z to exit)</Text>
        </Box>
      ) : null}
    </Box>
  );
}
