import React, { useState, useEffect, useRef } from 'react';
import { Box, Text } from 'ink';
import { figures, colors } from './theme.js';

// ── Color interpolation ──────────────────────────────────────────────────

function lerpColor(a: string, b: string, t: number): string {
  const ah = a.replace('#', '');
  const bh = b.replace('#', '');
  const ar = parseInt(ah.slice(0, 2), 16);
  const ag = parseInt(ah.slice(2, 4), 16);
  const ab = parseInt(ah.slice(4, 6), 16);
  const br = parseInt(bh.slice(0, 2), 16);
  const bg = parseInt(bh.slice(2, 4), 16);
  const bb = parseInt(bh.slice(4, 6), 16);
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const b_ = Math.round(ab + (bb - ab) * t);
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b_.toString(16).padStart(2, '0')}`;
}

// Attempt true 60fps. Falls back to whatever the runtime can sustain.
const FRAME_MS = 16;

// ── Spinner ──────────────────────────────────────────────────────────────
// Single ring character. Breathes between near-invisible walnut shadow
// and warm antique gold. Time-based animation — frame drops don't cause
// stutter, the ring simply jumps to the correct brightness.

interface SpinnerProps {
  isLoading: boolean;
  activeTool?: string;
  hasStreamingText?: boolean;
}

const RING = '○';                           // U+25CB — thin, clean
const COLOR_DIM = '#2e2620';                // nearly invisible walnut
const COLOR_MID = '#7a6545';                // mid warmth (breathe floor)
const COLOR_BRIGHT = '#d4aa55';             // warm gold peak
const BREATH_MS = 3000;                     // one full inhale-exhale

// Attempt to mimic smoothstep easing for organic feel
function breathe(now: number, origin: number): number {
  const elapsed = now - origin;
  const phase = ((elapsed % BREATH_MS) / BREATH_MS) * Math.PI * 2;
  // sin gives -1..1, remap to 0..1 with a slight bias toward the dim end
  // so it lingers in the quiet range and blooms briefly
  const raw = (Math.sin(phase - Math.PI / 2) + 1) / 2; // 0..1, starts at 0
  // Smooth-step: 3t² - 2t³ — removes the linear feel at the turnarounds
  return raw * raw * (3 - 2 * raw);
}

export function Spinner({ isLoading, activeTool, hasStreamingText }: SpinnerProps): React.ReactElement | null {
  const [, forceRender] = useState(0);
  const originRef = useRef(0);
  const rafRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!isLoading) {
      if (rafRef.current) clearInterval(rafRef.current);
      rafRef.current = null;
      return;
    }
    originRef.current = Date.now();
    // Drive renders at 60fps via interval — Ink doesn't have rAF
    rafRef.current = setInterval(() => forceRender(n => n + 1), FRAME_MS);
    return () => {
      if (rafRef.current) clearInterval(rafRef.current);
    };
  }, [isLoading]);

  if (!isLoading) return null;

  const now = Date.now();
  const elapsed = ((now - originRef.current) / 1000).toFixed(1);
  const t = breathe(now, originRef.current);

  // Two-stage color: dim→mid is the quiet range, mid→bright is the bloom
  const ringColor = t < 0.5
    ? lerpColor(COLOR_DIM, COLOR_MID, t * 2)
    : lerpColor(COLOR_MID, COLOR_BRIGHT, (t - 0.5) * 2);

  // Label color also subtly breathes — dimmer version of ring
  const labelT = t * 0.3; // much subtler
  const labelColor = lerpColor('#5c4f3e', '#8a7a65', labelT);

  let label: string;
  if (activeTool) {
    label = activeTool;
  } else if (hasStreamingText) {
    label = 'Forming';
  } else {
    label = 'Thinking';
  }

  return (
    <Box marginTop={1}>
      <Text color={ringColor}>{RING} </Text>
      <Text color={labelColor}>{label}</Text>
      <Text color={colors.dim}> ({elapsed}s)</Text>
    </Box>
  );
}

// ── Tool Dot ───────────────────────────────────────────────────────────
// Same breathing animation while in-progress. Solid on resolve.

interface ToolDotProps {
  resolved: boolean;
  isError: boolean;
}

export function ToolDot({ resolved, isError }: ToolDotProps): React.ReactElement {
  const [, forceRender] = useState(0);
  const originRef = useRef(Date.now());
  const rafRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (resolved) {
      if (rafRef.current) clearInterval(rafRef.current);
      rafRef.current = null;
      return;
    }
    originRef.current = Date.now();
    rafRef.current = setInterval(() => forceRender(n => n + 1), FRAME_MS);
    return () => {
      if (rafRef.current) clearInterval(rafRef.current);
    };
  }, [resolved]);

  if (resolved) {
    const color = isError ? colors.error : colors.success;
    return (
      <Box minWidth={2} flexShrink={0}>
        <Text color={color}>{figures.dot}</Text>
      </Box>
    );
  }

  const t = breathe(Date.now(), originRef.current);
  const dotColor = t < 0.5
    ? lerpColor(COLOR_DIM, COLOR_MID, t * 2)
    : lerpColor(COLOR_MID, colors.claude, (t - 0.5) * 2);

  return (
    <Box minWidth={2} flexShrink={0}>
      <Text color={dotColor}>{figures.dot}</Text>
    </Box>
  );
}
