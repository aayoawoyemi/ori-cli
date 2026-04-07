import React from 'react';
import { Box, Text } from 'ink';
import { Select, type SelectOption } from './select.js';
import { colors, figures } from './theme.js';
import type { SessionMeta } from '../session/storage.js';

// ── Time Formatting ─────────────────────────────────────────────────────

function timeAgo(epochMs: number): string {
  const seconds = Math.floor((Date.now() - epochMs) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 4) return `${weeks}w ago`;
  return new Date(epochMs).toLocaleDateString();
}

function formatCost(usd: number): string {
  if (usd === 0) return '';
  if (usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}

// ── Component ───────────────────────────────────────────────────────────

interface ResumePickerProps {
  sessions: SessionMeta[];
  onSelect: (session: SessionMeta) => void;
  onCancel: () => void;
}

export function ResumePicker({ sessions, onSelect, onCancel }: ResumePickerProps): React.ReactElement {
  if (sessions.length === 0) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text color={colors.dim}>No previous sessions found.</Text>
      </Box>
    );
  }

  const options: SelectOption<string>[] = sessions.slice(0, 20).map(s => {
    const title = s.userTitle ?? s.title ?? s.id;
    const time = timeAgo(s.lastActiveAt);
    const turns = s.messageCount > 0 ? `${s.messageCount} turns` : '';
    const cost = formatCost(s.costEstimate);

    // Build a padded label line
    const titlePart = title.slice(0, 40).padEnd(42);
    const timePart = time.padStart(10);
    const turnsPart = turns.padStart(10);
    const costPart = cost.padStart(8);

    return {
      value: s.id,
      label: `${titlePart}${timePart}${turnsPart}${costPart}`,
    };
  });

  return (
    <Box flexDirection="column" borderStyle="single" borderColor={colors.border} paddingX={1}>
      <Box marginBottom={1}>
        <Text bold color={colors.suggestion}>Recent Sessions</Text>
      </Box>
      <Select<string>
        options={options}
        visibleCount={8}
        onChange={(id) => {
          const session = sessions.find(s => s.id === id);
          if (session) onSelect(session);
        }}
        onCancel={onCancel}
      />
      <Box marginTop={1}>
        <Text color={colors.dim}>
          {figures.arrowDown} navigate  enter select  esc cancel
        </Text>
      </Box>
    </Box>
  );
}
