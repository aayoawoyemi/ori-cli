import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { colors, figures } from './theme.js';
import { CommandPalette, getFilteredCommands } from './commandPalette.js';

interface PromptInputProps {
  onSubmit: (text: string) => void;
  model: string;
  isLoading: boolean;
}

export function PromptInput({ onSubmit, model, isLoading }: PromptInputProps): React.ReactElement {
  const [value, setValue] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const [paletteIdx, setPaletteIdx] = useState(0);

  const showPalette = value.startsWith('/') && !isLoading;
  const filteredCommands = showPalette ? getFilteredCommands(value) : [];

  useInput((_input, key) => {
    if (showPalette && filteredCommands.length > 0) {
      if (key.upArrow) {
        setPaletteIdx(i => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow) {
        setPaletteIdx(i => Math.min(filteredCommands.length - 1, i + 1));
        return;
      }
      if (key.tab) {
        // Tab-complete the selected command
        const selected = filteredCommands[Math.min(paletteIdx, filteredCommands.length - 1)];
        if (selected) {
          setValue(selected.name + ' ');
          setPaletteIdx(0);
        }
        return;
      }
    }

    // History navigation (only when palette not showing)
    if (!showPalette) {
      if (key.upArrow && history.length > 0) {
        const newIdx = Math.min(historyIdx + 1, history.length - 1);
        setHistoryIdx(newIdx);
        setValue(history[history.length - 1 - newIdx]);
      }
      if (key.downArrow) {
        if (historyIdx > 0) {
          const newIdx = historyIdx - 1;
          setHistoryIdx(newIdx);
          setValue(history[history.length - 1 - newIdx]);
        } else {
          setHistoryIdx(-1);
          setValue('');
        }
      }
    }
  });

  const handleChange = (newValue: string) => {
    setValue(newValue);
    setPaletteIdx(0); // reset palette selection on input change
  };

  const handleSubmit = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || isLoading) return;
    setHistory(prev => [...prev, trimmed]);
    setHistoryIdx(-1);
    setValue('');
    setPaletteIdx(0);
    onSubmit(trimmed);
  };

  const width = process.stdout.columns || 80;

  return (
    <Box flexDirection="column" marginTop={1}>
      {/* Command palette overlay */}
      <CommandPalette
        filter={value}
        selectedIndex={paletteIdx}
        visible={showPalette && filteredCommands.length > 0}
      />

      {/* Border */}
      <Box>
        <Text color={colors.border}>{'─'.repeat(width)}</Text>
      </Box>

      {/* Input row */}
      <Box flexDirection="row">
        <Text color={colors.subtle}>{figures.pointer} </Text>
        {isLoading ? (
          <Text dimColor>...</Text>
        ) : (
          <TextInput
            value={value}
            onChange={handleChange}
            onSubmit={handleSubmit}
            placeholder=""
          />
        )}
      </Box>
    </Box>
  );
}
