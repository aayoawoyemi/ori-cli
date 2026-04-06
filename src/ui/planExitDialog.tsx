import React, { useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import { Select, type SelectOption } from './select.js';
import { colors, figures } from './theme.js';

// ── Types ──────────────────────────────────────────────────────────────────

export type PlanSaveTarget = 'project' | 'brain' | 'vault' | 'none';

export interface PlanExitChoice {
  execute: boolean;
  saveTarget: PlanSaveTarget;
}

export interface PlanExitDialogProps {
  planSummary?: string;
  onChoice: (choice: PlanExitChoice) => void;
  onCancel: () => void;
}

// ── Options ────────────────────────────────────────────────────────────────

const EXIT_OPTIONS: SelectOption<string>[] = [
  { value: 'project', label: 'Execute + save to project (.aries/plans/)' },
  { value: 'brain',   label: 'Execute + save to brain (searchable next session)' },
  { value: 'execute', label: 'Execute (don\'t save plan)' },
  { value: 'keep',    label: 'Keep planning' },
];

// ── Component ──────────────────────────────────────────────────────────────

export function PlanExitDialog({
  planSummary,
  onChoice,
  onCancel,
}: PlanExitDialogProps): React.ReactElement {
  const handleSelect = (value: string) => {
    switch (value) {
      case 'project':
        onChoice({ execute: true, saveTarget: 'project' });
        break;
      case 'brain':
        onChoice({ execute: true, saveTarget: 'brain' });
        break;
      case 'execute':
        onChoice({ execute: true, saveTarget: 'none' });
        break;
      case 'keep':
        onCancel();
        break;
    }
  };

  return (
    <Box flexDirection="column">
      {/* Top border */}
      <Box>
        <Text color={colors.permission}>
          {'\u256D'}{figures.divider.repeat((process.stdout.columns || 80) - 2)}
        </Text>
      </Box>

      <Box flexDirection="column" paddingX={2}>
        {/* Header */}
        <Box marginBottom={1} flexDirection="column">
          <Text color={colors.permission} bold>
            {figures.planMode} Plan complete
          </Text>
          {planSummary && (
            <Text dimColor>{planSummary.slice(0, 120)}</Text>
          )}
        </Box>

        {/* Options with number shortcuts */}
        <Select
          options={EXIT_OPTIONS}
          onChange={handleSelect}
          onCancel={onCancel}
          visibleCount={4}
        />

        {/* Hint */}
        <Box marginTop={1}>
          <Text dimColor italic>1-4 to select {figures.bullet} Esc to keep planning</Text>
        </Box>
      </Box>
    </Box>
  );
}
