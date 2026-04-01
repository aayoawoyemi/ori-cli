import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';

interface PromptInputProps {
  onSubmit: (text: string) => void;
  model: string;
  isLoading: boolean;
}

/** Input component with bordered prompt area like Claude Code. */
export function PromptInput({ onSubmit, model, isLoading }: PromptInputProps): React.ReactElement {
  const [value, setValue] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);

  // Handle up/down for history navigation
  useInput((input, key) => {
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
    if (!trimmed) return;
    if (isLoading) return;

    setHistory(prev => [...prev, trimmed]);
    setHistoryIdx(-1);
    setValue('');
    onSubmit(trimmed);
  };

  return (
    <Box flexDirection="column">
      {/* Top border with model name */}
      <Box>
        <Text dimColor>{'─'.repeat(2)} </Text>
        <Text dimColor>{model}</Text>
        <Text dimColor>{' ' + '─'.repeat(Math.max(0, (process.stdout.columns || 80) - model.length - 4))}</Text>
      </Box>

      {/* Input row */}
      <Box flexDirection="row">
        <Text color="blue" bold>{isLoading ? '  ' : '> '}</Text>
        {isLoading ? (
          <Text dimColor>(waiting for response...)</Text>
        ) : (
          <TextInput
            value={value}
            onChange={setValue}
            onSubmit={handleSubmit}
            placeholder="Type a message..."
          />
        )}
      </Box>
    </Box>
  );
}
