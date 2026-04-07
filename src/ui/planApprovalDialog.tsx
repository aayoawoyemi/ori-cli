import React, { useState, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { colors, figures } from './theme.js';

// ── Types ──────────────────────────────────────────────────────────────────

export type PlanAcceptMode = 'keep_context' | 'clear_context' | 'accept_edits';

export interface PlanApprovalDialogProps {
  planFilePath: string;
  planContent: string;
  onAccept: (mode: PlanAcceptMode) => void;
  onReject: (feedback: string) => void;
  onCancel: () => void;
  onContentChange?: (content: string) => void;
}

// ── Component ──────────────────────────────────────────────────────────────

const MAX_PREVIEW_LINES = 25;

export function PlanApprovalDialog({
  planFilePath,
  planContent,
  onAccept,
  onReject,
  onCancel,
  onContentChange,
}: PlanApprovalDialogProps): React.ReactElement {
  const [mode, setMode] = useState<'select' | 'feedback'>('select');
  const [feedback, setFeedback] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);

  const options = [
    { key: '1', label: 'Accept — continue working', action: () => onAccept('keep_context') },
    { key: '2', label: 'Accept — clear context, inject plan', action: () => onAccept('clear_context') },
    { key: '3', label: 'Accept — auto-accept edits', action: () => onAccept('accept_edits') },
    { key: '4', label: 'Reject — give feedback', action: () => setMode('feedback') },
  ];

  const editInEditor = useCallback(() => {
    const editor = process.env.EDITOR || process.env.VISUAL || 'vim';
    spawnSync(editor, [planFilePath], { stdio: 'inherit' });
    // Re-read after editor exits
    try {
      const updated = readFileSync(planFilePath, 'utf-8');
      onContentChange?.(updated);
    } catch { /* file unchanged */ }
  }, [planFilePath, onContentChange]);

  useInput((input, key) => {
    if (mode === 'feedback') {
      if (key.return && feedback.trim()) {
        onReject(feedback.trim());
      }
      if (key.escape) {
        setMode('select');
        setFeedback('');
      }
      return;
    }

    // Number shortcuts
    const num = parseInt(input, 10);
    if (num >= 1 && num <= options.length) {
      options[num - 1]!.action();
      return;
    }

    // Arrow navigation
    if (key.upArrow) {
      setSelectedIndex(i => Math.max(0, i - 1));
    } else if (key.downArrow) {
      setSelectedIndex(i => Math.min(options.length - 1, i + 1));
    } else if (key.return) {
      options[selectedIndex]!.action();
    }

    // Ctrl+G → edit in $EDITOR
    if (input === 'g' && key.ctrl) {
      editInEditor();
      return;
    }

    // Escape → keep planning
    if (key.escape) {
      onCancel();
    }
  });

  // Preview: truncate long plans
  const lines = planContent.split('\n');
  const truncated = lines.length > MAX_PREVIEW_LINES;
  const preview = truncated
    ? lines.slice(0, MAX_PREVIEW_LINES).join('\n') + `\n... (${lines.length - MAX_PREVIEW_LINES} more lines)`
    : planContent;

  const cols = (process.stdout.columns || 80) - 2;

  return (
    <Box flexDirection="column">
      {/* Top border */}
      <Box>
        <Text color={colors.permission}>
          {'\u256D'}{figures.divider.repeat(cols)}
        </Text>
      </Box>

      <Box flexDirection="column" paddingX={2}>
        {/* Header */}
        <Box marginBottom={1} flexDirection="column">
          <Text color={colors.permission} bold>
            {figures.planMode} Plan ready for review
          </Text>
          <Text dimColor>{planFilePath}</Text>
        </Box>

        {/* Plan preview */}
        <Box flexDirection="column" marginBottom={1}>
          <Text dimColor>{preview}</Text>
        </Box>

        {/* Separator */}
        <Box>
          <Text dimColor>{figures.divider.repeat(cols - 4)}</Text>
        </Box>

        {mode === 'select' ? (
          <Box flexDirection="column" marginTop={1}>
            {options.map((opt, i) => (
              <Box key={opt.key}>
                <Text color={i === selectedIndex ? colors.permission : undefined} bold={i === selectedIndex}>
                  {i === selectedIndex ? figures.pointer : ' '} [{opt.key}] {opt.label}
                </Text>
              </Box>
            ))}
            <Box marginTop={1}>
              <Text dimColor italic>
                1-4 to select {figures.bullet} Ctrl+G edit in $EDITOR {figures.bullet} Esc keep planning
              </Text>
            </Box>
          </Box>
        ) : (
          <Box flexDirection="column" marginTop={1}>
            <Text color={colors.permission} bold>Feedback:</Text>
            <Box>
              <Text dimColor>{'> '}</Text>
              <TextInput value={feedback} onChange={setFeedback} />
            </Box>
            <Box marginTop={1}>
              <Text dimColor italic>Enter to submit {figures.bullet} Esc to cancel</Text>
            </Box>
          </Box>
        )}
      </Box>
    </Box>
  );
}
