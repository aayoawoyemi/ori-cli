import React from 'react';
import { Box, Text } from 'ink';

interface StatusBarProps {
  model: string;
  effort: string;
  tokenCount: number;
  contextWindow: number;
  vaultNotes?: number;
  isLoading: boolean;
}

/** Build a progress bar string. */
function progressBar(fraction: number, width: number): string {
  const filled = Math.round(fraction * width);
  const empty = width - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
}

/** Persistent status bar pinned at the bottom. */
export function StatusBar({ model, effort, tokenCount, contextWindow, vaultNotes, isLoading }: StatusBarProps): React.ReactElement {
  const percentage = contextWindow > 0 ? Math.round((tokenCount / contextWindow) * 100) : 0;
  const bar = progressBar(tokenCount / Math.max(contextWindow, 1), 20);
  const tokenStr = tokenCount >= 1000 ? `${Math.round(tokenCount / 1000)}K` : `${tokenCount}`;
  const ctxStr = contextWindow >= 1000 ? `${Math.round(contextWindow / 1000)}K` : `${contextWindow}`;

  return (
    <Box flexDirection="row" width="100%" justifyContent="space-between">
      <Box gap={1}>
        <Text dimColor>[{model}] {effort}</Text>
        <Text dimColor>{bar}</Text>
        <Text dimColor>{percentage}%</Text>
        <Text dimColor>|</Text>
        <Text dimColor>{tokenStr}/{ctxStr} tokens</Text>
        {vaultNotes !== undefined && (
          <>
            <Text dimColor>|</Text>
            <Text dimColor>vault: {vaultNotes}</Text>
          </>
        )}
      </Box>
      {isLoading && (
        <Text color="yellow">●</Text>
      )}
    </Box>
  );
}
