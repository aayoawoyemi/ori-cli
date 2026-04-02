import React from 'react';
import { Box, Text } from 'ink';
import { colors } from './theme.js';

interface StatusBarProps {
  model: string;
  effort: string;
  tokenCount: number;
  contextWindow: number;
  vaultNotes?: number;
  isLoading: boolean;
}

function progressBar(fraction: number, width: number): string {
  const clamped = Math.max(0, Math.min(1, fraction));
  const filled = Math.round(clamped * width);
  const empty = width - filled;
  return '\u2588'.repeat(filled) + '\u2591'.repeat(empty);
}

export function StatusBar({ model, effort, tokenCount, contextWindow, vaultNotes, isLoading }: StatusBarProps): React.ReactElement {
  const pct = contextWindow > 0 ? Math.round((tokenCount / contextWindow) * 100) : 0;
  const bar = progressBar(tokenCount / Math.max(contextWindow, 1), 20);
  const tokStr = tokenCount >= 1000 ? `${Math.round(tokenCount / 1000)}K` : `${tokenCount}`;
  const ctxStr = contextWindow >= 1000 ? `${Math.round(contextWindow / 1000)}K` : `${contextWindow}`;

  return (
    <Box flexDirection="row" width="100%">
      <Text dimColor>
        [{model}] {effort}  {bar}  {pct}% | {tokStr}/{ctxStr} tokens
        {vaultNotes !== undefined ? ` | vault: ${vaultNotes}` : ''}
      </Text>
    </Box>
  );
}
