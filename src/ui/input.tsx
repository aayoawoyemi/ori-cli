import React, { useState, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import { StableInput } from './stableInput.js';
import { readClipboard } from './clipboard.js';
import { colors, figures } from './theme.js';
import { CommandPalette, getFilteredCommands } from './commandPalette.js';

// Commands that execute immediately on Enter (no args required)
const NO_ARG_COMMANDS = new Set([
  '/tools', '/vault', '/brain', '/cost', '/clear', '/help', '/exit',
  '/quit', '/resume', '/model', '/config', '/mode', '/execute', '/compact', '/undo',
]);

// ── Input Modes ────────────────────────────────────────────────────────────
// Claude Code: ❯ for prompt, ! for bash, / for commands

type InputMode = 'prompt' | 'bash';

function getModeFromInput(value: string): InputMode {
  if (value.startsWith('!')) return 'bash';
  return 'prompt';
}

// ── Props ──────────────────────────────────────────────────────────────────

export interface AttachedImage {
  path: string;
  base64: string;
  mediaType: string;
}

interface PromptInputProps {
  onSubmit: (text: string, images?: AttachedImage[]) => void;
  model: string;
  isLoading: boolean;
}

// ── Component ──────────────────────────────────────────────────────────────

export function PromptInput({ onSubmit, model, isLoading }: PromptInputProps): React.ReactElement {
  const [value, setValue] = useState('');
  const [images, setImages] = useState<AttachedImage[]>([]);
  const imageCountRef = useRef(0);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const [paletteIdx, setPaletteIdx] = useState(0);
  const [helpOpen, setHelpOpen] = useState(false);

  const mode = getModeFromInput(value);
  const showPalette = value.startsWith('/') && !isLoading && !helpOpen;
  const filteredCommands = showPalette ? getFilteredCommands(value) : [];

  useInput((input, key) => {
    // Close help on any key
    if (helpOpen) {
      setHelpOpen(false);
      return;
    }

    // Alt+V → paste clipboard (text OR image) at cursor
    if (key.meta && input === 'v' && !isLoading) {
      const result = readClipboard();
      if (result.type === 'text') {
        // Strip trailing newline from pasted text
        const clean = result.value.replace(/\r?\n$/, '');
        setValue(prev => prev + clean);
      } else if (result.type === 'image') {
        const imageNumber = ++imageCountRef.current;
        setImages(prev => [...prev, {
          path: result.path,
          base64: result.base64,
          mediaType: result.mediaType,
        }]);
        setValue(prev => {
          const sep = prev && !prev.endsWith(' ') ? ' ' : '';
          return `${prev}${sep}[Image ${imageNumber}]`;
        });
      }
      return;
    }

    // ? opens help (only on empty input)
    if (input === '?' && value === '' && !isLoading) {
      setHelpOpen(true);
      return;
    }

    // Palette navigation
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
    setPaletteIdx(0);
  };

  const handleSubmit = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || isLoading) return;

    // If palette is showing, Enter acts on the selected command
    if (showPalette && filteredCommands.length > 0) {
      const selected = filteredCommands[Math.min(paletteIdx, filteredCommands.length - 1)];
      if (selected) {
        if (NO_ARG_COMMANDS.has(selected.name)) {
          setHistory(prev => [...prev, selected.name]);
          setHistoryIdx(-1);
          setValue('');
          setImages([]);
          imageCountRef.current = 0;
          setPaletteIdx(0);
          onSubmit(selected.name);
        } else {
          setValue(selected.name + ' ');
          setPaletteIdx(0);
        }
        return;
      }
    }

    setHistory(prev => [...prev, trimmed]);
    setHistoryIdx(-1);
    setValue('');
    const submittedImages = [...images];
    setImages([]);
    imageCountRef.current = 0;
    setPaletteIdx(0);
    onSubmit(trimmed, submittedImages.length > 0 ? submittedImages : undefined);
  };

  const width = process.stdout.columns || 80;
  const borderColor = mode === 'bash' ? colors.bashBorder : colors.promptBorder;

  return (
    <Box flexDirection="column">
      {/* Help menu (above everything when open) */}
      {helpOpen && <HelpMenu />}

      {/* Command palette overlay */}
      <CommandPalette
        filter={value}
        selectedIndex={paletteIdx}
        visible={showPalette && filteredCommands.length > 0}
      />

      {/* Divider */}
      <Box>
        <Text color={borderColor}>{figures.divider.repeat(width)}</Text>
      </Box>

      {/* Input row */}
      <Box flexDirection="row">
        {/* Mode indicator */}
        <ModeIndicator mode={mode} isLoading={isLoading} />

        {isLoading ? (
          <Text dimColor>Waiting for response...</Text>
        ) : (
          <StableInput
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

// ── Mode Indicator ─────────────────────────────────────────────────────────
// Claude Code: ❯ for prompt, ! for bash (colored)

function ModeIndicator({ mode, isLoading }: { mode: InputMode; isLoading: boolean }): React.ReactElement {
  if (mode === 'bash') {
    return <Text color={colors.bashBorder} dimColor={isLoading}>{'! '}</Text>;
  }
  return <Text color={colors.subtle} dimColor={isLoading}>{figures.pointer}{' '}</Text>;
}

// ── Help Menu ──────────────────────────────────────────────────────────────
// Claude Code: 3-column layout, triggered by ? on empty input

function HelpMenu(): React.ReactElement {
  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={colors.border}
      paddingX={1}
      paddingY={0}
      marginBottom={0}
    >
      <Box flexDirection="row" gap={4}>
        {/* Column 1: Input modes */}
        <Box flexDirection="column" width={28}>
          <Text dimColor>{'! '}<Text color={colors.bashBorder}>for bash mode</Text></Text>
          <Text dimColor>{'/ '}<Text>for commands</Text></Text>
        </Box>

        {/* Column 2: Key shortcuts */}
        <Box flexDirection="column" width={32}>
          <Text dimColor>esc          interrupt</Text>
          <Text dimColor>ctrl+c       exit</Text>
          <Text dimColor>alt+v        paste image</Text>
          <Text dimColor>alt+p        switch model</Text>
        </Box>

        {/* Column 3: More */}
        <Box flexDirection="column">
          <Text dimColor>up/down      history</Text>
          <Text dimColor>tab          autocomplete</Text>
        </Box>
      </Box>
    </Box>
  );
}
