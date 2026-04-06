import React, { useState, useEffect, useRef } from 'react';
import { Box, Text } from 'ink';
import { figures, colors } from './theme.js';

// ── Spinner ──────────────────────────────────────────────────────────────────

interface SpinnerProps {
  isLoading: boolean;
  activeTool?: string;
  hasStreamingText?: boolean;
}

export function Spinner({ isLoading, activeTool, hasStreamingText }: SpinnerProps): React.ReactElement | null {
  const [frame, setFrame] = useState(0);
  const startRef = useRef(Date.now());

  useEffect(() => {
    if (!isLoading) {
      startRef.current = Date.now();
      return;
    }
    const interval = setInterval(() => setFrame(f => f + 1), 80);
    return () => clearInterval(interval);
  }, [isLoading]);

  if (!isLoading) return null;

  const elapsed = ((Date.now() - startRef.current) / 1000).toFixed(1);

  // State-aware label
  let label: string;
  if (activeTool) {
    label = `Running ${activeTool}`;
  } else if (hasStreamingText) {
    label = 'Forming...';
  } else {
    label = 'Waiting for response...';
  }

  // Shimmer animation: cycle through block characters
  const shimmerChars = ['░', '▒', '▓', '█', '▓', '▒', '░', ' '];
  const shimmer = Array.from({ length: 6 }, (_, i) =>
    shimmerChars[(frame + i) % shimmerChars.length]
  ).join('');

  return (
    <Box marginTop={1}>
      <Text color={colors.claude}>{shimmer} </Text>
      <Text dimColor>{label}</Text>
      <Text color={colors.dim}>{' '}({elapsed}s)</Text>
    </Box>
  );
}

// ── Tool Dot ───────────────────────────────────────────────────────────────
// Blinking ⏺ while in-progress, solid green/red when resolved.

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

  const color = isError ? colors.error : resolved ? colors.success : colors.dim;
  const char = visible || resolved ? figures.dot : ' ';

  return (
    <Box minWidth={2} flexShrink={0}>
      <Text color={color}>{char}</Text>
    </Box>
  );
}
