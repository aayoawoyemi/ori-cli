import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { figures, colors } from './theme.js';

const VERBS = [
  'Thinking', 'Reasoning', 'Analyzing', 'Processing',
  'Searching', 'Reading', 'Writing', 'Evaluating',
];

interface SpinnerProps {
  isLoading: boolean;
  activeTool?: string;
}

export function Spinner({ isLoading, activeTool }: SpinnerProps): React.ReactElement | null {
  const [frame, setFrame] = useState(0);
  const [verb] = useState(() => VERBS[Math.floor(Math.random() * VERBS.length)]);

  useEffect(() => {
    if (!isLoading) return;
    const interval = setInterval(() => setFrame(f => f + 1), 120);
    return () => clearInterval(interval);
  }, [isLoading]);

  if (!isLoading) return null;

  const dots = '.'.repeat((frame % 3) + 1).padEnd(3);
  const label = activeTool ?? verb;

  return (
    <Box>
      <Text dimColor>{label}{dots}</Text>
    </Box>
  );
}

interface ToolDotProps {
  resolved: boolean;
  isError: boolean;
}

export function ToolDot({ resolved, isError }: ToolDotProps): React.ReactElement {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    if (resolved) return;
    const interval = setInterval(() => setVisible(v => !v), 500);
    return () => clearInterval(interval);
  }, [resolved]);

  const color = isError ? colors.error : resolved ? colors.success : undefined;
  const char = visible || resolved ? figures.dot : ' ';

  return (
    <Box minWidth={2}>
      <Text color={color} dimColor={!resolved && !isError}>{char}</Text>
    </Box>
  );
}
