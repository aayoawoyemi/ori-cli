import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { colors, figures } from './theme.js';

interface PromptInputProps {
  onSubmit: (text: string) => void;
  model: string;
  isLoading: boolean;
}

export function PromptInput({ onSubmit, model, isLoading }: PromptInputProps): React.ReactElement {
  const [value, setValue] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);

  useInput((_input, key) => {
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
  });

  const handleSubmit = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || isLoading) return;
    setHistory(prev => [...prev, trimmed]);
    setHistoryIdx(-1);
    setValue('');
    onSubmit(trimmed);
  };

  const width = process.stdout.columns || 80;

  return (
    <Box flexDirection="column" marginTop={1}>
      {/* Top border — single line with rounded ends */}
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
            onChange={setValue}
            onSubmit={handleSubmit}
            placeholder=""
          />
        )}
      </Box>
    </Box>
  );
}
