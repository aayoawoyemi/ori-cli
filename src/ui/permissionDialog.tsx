import React, { useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import { Select, type SelectOption } from './select.js';
import { colors, figures } from './theme.js';
import type { ToolCall } from '../router/types.js';

// ── Props ──────────────────────────────────────────────────────────────────

export interface PermissionDialogProps {
  toolCall: ToolCall;
  onAllow: () => void;
  onDeny: () => void;
  onAlways: () => void;
}

// ── Tool-specific headers ──────────────────────────────────────────────────

function getToolHeader(tc: ToolCall): { title: string; detail: string } {
  const input = tc.input;

  switch (tc.name) {
    case 'Edit':
      return {
        title: `Edit ${input.file_path ?? 'file'}`,
        detail: input.old_string
          ? `Replace ${String(input.old_string).split('\n').length} lines`
          : 'Apply edit',
      };

    case 'Write':
      return {
        title: `Write ${input.file_path ?? 'file'}`,
        detail: input.content
          ? `${String(input.content).split('\n').length} lines`
          : 'Write file',
      };

    case 'Bash': {
      const cmd = String(input.command ?? '').slice(0, 120);
      return {
        title: 'Bash',
        detail: cmd,
      };
    }

    case 'VaultAdd':
      return {
        title: 'Add to vault',
        detail: String(input.title ?? '').slice(0, 80),
      };

    default:
      return {
        title: tc.name,
        detail: Object.values(input)[0] ? String(Object.values(input)[0]).slice(0, 80) : '',
      };
  }
}

// ── Component ──────────────────────────────────────────────────────────────

export function PermissionDialog({
  toolCall,
  onAllow,
  onDeny,
  onAlways,
}: PermissionDialogProps): React.ReactElement {
  const header = useMemo(() => getToolHeader(toolCall), [toolCall]);

  const options: SelectOption<string>[] = useMemo(() => [
    { value: 'allow', label: 'Yes' },
    { value: 'always', label: `Yes, and don't ask again for ${toolCall.name}` },
    { value: 'deny', label: 'No' },
  ], [toolCall.name]);

  const handleSelect = (value: string) => {
    if (value === 'allow') onAllow();
    else if (value === 'always') onAlways();
    else onDeny();
  };

  // Esc to deny
  useInput((_input, key) => {
    if (key.escape) onDeny();
  });

  const width = process.stdout.columns || 80;

  return (
    <Box flexDirection="column">
      {/* Top border */}
      <Box>
        <Text color={colors.permission}>
          {'\u256D'}{figures.divider.repeat(width - 2)}
        </Text>
      </Box>

      {/* Content */}
      <Box flexDirection="column" paddingX={2}>
        {/* Tool header */}
        <Box marginBottom={1} flexDirection="column">
          <Text color={colors.permission} bold>{header.title}</Text>
          {header.detail && (
            <Text dimColor>{header.detail}</Text>
          )}
        </Box>

        {/* Options */}
        <Select
          options={options}
          onChange={handleSelect}
          onCancel={onDeny}
          visibleCount={3}
        />

        {/* Hint */}
        <Box marginTop={1}>
          <Text dimColor italic>Esc to deny</Text>
        </Box>
      </Box>
    </Box>
  );
}
