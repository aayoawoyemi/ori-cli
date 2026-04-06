import React, { useState, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import { colors } from './theme.js';

export interface SlashCommand {
  name: string;
  description: string;
  args?: string;
}

const COMMANDS: SlashCommand[] = [
  { name: '/model', description: 'Switch model or assign slot', args: 'opus | [cheap deepseek] | [bulk llama]' },
  { name: '/mode', description: 'Permission mode', args: 'default | accept | yolo' },
  { name: '/plan', description: 'Enter plan mode (read-only)', args: '[description] | off' },
  { name: '/execute', description: 'Exit plan mode and execute' },
  { name: '/config', description: 'Show model routing' },
  { name: '/effort', description: 'Change effort level', args: 'high | medium | low' },
  { name: '/tools', description: 'List available tools' },
  { name: '/vault', description: 'Show vault status' },
  { name: '/brain', description: 'Show project brain' },
  { name: '/usage', description: 'Token usage, costs, cache stats' },
  { name: '/cost', description: 'Alias for /usage' },
  { name: '/display', description: 'Cycle display mode: verbose/normal/quiet', args: '[verbose|normal|quiet]' },
  { name: '/research', description: 'Deep multi-source research', args: '"query" [--depth quick|standard|deep]' },
  { name: '/resume', description: 'Resume a previous session' },
  { name: '/undo', description: 'Undo last file edit' },
  { name: '/compact', description: 'Compact conversation to save context' },
  { name: '/clear', description: 'Clear conversation' },
  { name: '/help', description: 'Show all commands' },
  { name: '/exit', description: 'Exit' },
];

interface CommandPaletteProps {
  filter: string;          // current input text (starts with /)
  selectedIndex: number;
  visible: boolean;
}

export function CommandPalette({ filter, selectedIndex, visible }: CommandPaletteProps): React.ReactElement | null {
  if (!visible) return null;

  const filtered = useMemo(() => {
    if (filter === '/') return COMMANDS;
    const search = filter.toLowerCase();
    return COMMANDS.filter(c => c.name.startsWith(search));
  }, [filter]);

  if (filtered.length === 0) return null;

  const clampedIdx = Math.max(0, Math.min(selectedIndex, filtered.length - 1));

  return (
    <Box flexDirection="column" borderStyle="single" borderColor={colors.border} paddingX={1}>
      {filtered.map((cmd, i) => {
        const isSelected = i === clampedIdx;
        return (
          <Box key={cmd.name} flexDirection="row" gap={1}>
            <Text
              bold={isSelected}
              color={isSelected ? 'white' : colors.dim}
              backgroundColor={isSelected ? '#444444' : undefined}
            >
              {cmd.name}
            </Text>
            <Text dimColor>{cmd.description}</Text>
            {cmd.args && <Text dimColor color={colors.subtle}>  {cmd.args}</Text>}
          </Box>
        );
      })}
    </Box>
  );
}

/** Get filtered commands for current input. */
export function getFilteredCommands(input: string): SlashCommand[] {
  if (!input.startsWith('/')) return [];
  if (input === '/') return COMMANDS;
  return COMMANDS.filter(c => c.name.startsWith(input.toLowerCase()));
}

export { COMMANDS };
