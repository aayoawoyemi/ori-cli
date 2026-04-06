import React, { useState, useMemo, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import { colors, figures } from './theme.js';

// ── Types ──────────────────────────────────────────────────────────────

export interface SelectOption<T = string> {
  value: T;
  label: string;
  description?: string;
  disabled?: boolean;
}

export interface SelectProps<T = string> {
  options: SelectOption<T>[];
  onChange: (value: T) => void;
  onCancel?: () => void;
  onFocus?: (value: T) => void;
  defaultValue?: T;
  visibleCount?: number;
  isActive?: boolean;
}

// ── Select Component ───────────────────────────────────────────────────
// Ported from Claude Code's CustomSelect. Arrow keys navigate, Enter
// selects, Esc cancels. Viewport scrolls when list exceeds visibleCount.

export function Select<T = string>({
  options,
  onChange,
  onCancel,
  onFocus,
  defaultValue,
  visibleCount = 5,
  isActive = true,
}: SelectProps<T>): React.ReactElement | null {
  // Find initial index from defaultValue
  const initialIndex = useMemo(() => {
    if (defaultValue !== undefined) {
      const idx = options.findIndex(o => o.value === defaultValue);
      return idx >= 0 ? idx : 0;
    }
    return 0;
  }, []);

  const [focusedIndex, setFocusedIndex] = useState(initialIndex);
  const [viewStart, setViewStart] = useState(() => {
    // Initialize viewport to show the focused item
    const visible = Math.min(visibleCount, options.length);
    if (initialIndex >= visible) {
      const start = Math.min(initialIndex, options.length - visible);
      return start;
    }
    return 0;
  });

  const visible = Math.min(visibleCount, options.length);

  const moveFocus = useCallback((direction: 1 | -1) => {
    setFocusedIndex(prev => {
      let next = prev + direction;
      // Wrap around
      if (next < 0) next = options.length - 1;
      if (next >= options.length) next = 0;

      // Adjust viewport
      setViewStart(vs => {
        if (next < vs) return next;
        if (next >= vs + visible) return next - visible + 1;
        // Wrap to start
        if (direction === 1 && next === 0) return 0;
        // Wrap to end
        if (direction === -1 && next === options.length - 1) {
          return Math.max(0, options.length - visible);
        }
        return vs;
      });

      onFocus?.(options[next]!.value);
      return next;
    });
  }, [options.length, visible, onFocus]);

  useInput((input, key) => {
    if (!isActive) return;

    if (key.upArrow) {
      moveFocus(-1);
      return;
    }
    if (key.downArrow) {
      moveFocus(1);
      return;
    }
    if (key.return) {
      const opt = options[focusedIndex];
      if (opt && !opt.disabled) {
        onChange(opt.value);
      }
      return;
    }
    if (key.escape && onCancel) {
      onCancel();
      return;
    }
    // Number keys 1-9 jump to option
    if (/^[1-9]$/.test(input)) {
      const idx = parseInt(input) - 1;
      if (idx < options.length) {
        const opt = options[idx];
        if (opt && !opt.disabled) {
          onChange(opt.value);
        }
      }
    }
  }, { isActive });

  if (options.length === 0) return null;

  const viewEnd = viewStart + visible;
  const visibleOptions = options.slice(viewStart, viewEnd);
  const showUpArrow = viewStart > 0;
  const showDownArrow = viewEnd < options.length;

  return (
    <Box flexDirection="column">
      {visibleOptions.map((opt, i) => {
        const globalIndex = viewStart + i;
        const isFocused = globalIndex === focusedIndex;
        const indexNum = globalIndex + 1;
        const isFirst = i === 0;
        const isLast = i === visibleOptions.length - 1;

        return (
          <Box key={String(opt.value)} flexDirection="row">
            {/* Scroll indicator column */}
            <Text color={colors.dim}>
              {isFirst && showUpArrow ? '▲' : isLast && showDownArrow ? '▼' : ' '}
            </Text>
            {/* Index */}
            <Text color={colors.dim}>{String(indexNum).padStart(2)} </Text>
            {/* Focus indicator */}
            <Text color={isFocused ? colors.suggestion : undefined}>
              {isFocused ? figures.pointer : ' '}{' '}
            </Text>
            {/* Label */}
            <Text
              color={opt.disabled ? colors.dim : isFocused ? 'white' : colors.subtle}
              bold={isFocused}
            >
              {opt.label}
            </Text>
            {/* Description */}
            {opt.description && (
              <Text color={colors.dim}>{' '}{opt.description}</Text>
            )}
          </Box>
        );
      })}
    </Box>
  );
}
