// File: src/ui/askDialog.tsx
// Purpose: Modal prompt for ask() calls from inside the Python Repl body.
//   When Python runs `answer = ask("which file?")`, the body blocks on a
//   threading.Event and emits an ask_request over the bridge. The TS side
//   (bridge.handleAskCallback → app.tsx's onAsk handler → here) renders
//   this dialog to collect the user's typed answer, then calls
//   bridge.resolveAsk(id, answer) to unblock Python.
// Key pieces:
//   - AskDialog component — props: question, onSubmit(answer), onCancel
//   - Enter submits the typed value (even when empty — empty is a valid answer)
//   - Esc cancels — we contract that cancel returns empty string to Python,
//     not an exception, so the model can check `if not answer:` naturally
// Role: Mirror of permissionDialog.tsx in structure. Renders only when
//   app.tsx has a pendingAsk state set. Priority ordering in app.tsx's
//   dialog-selection block decides when ask fires vs permission/plan.

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { colors, figures } from './theme.js';

// ── Props ──────────────────────────────────────────────────────────────────

export interface AskDialogProps {
  question: string;
  /** Called with the typed answer when the user presses Enter. Empty string is a valid submit — don't filter it here; the model may want "yes I want empty" as a signal. */
  onSubmit: (answer: string) => void;
  /** Called when the user presses Esc. The Python-side contract is that cancel returns empty string, so app.tsx's handler should call resolveAsk(id, '') — not a special "cancelled" sentinel. */
  onCancel: () => void;
}

// ── Component ──────────────────────────────────────────────────────────────

export function AskDialog({
  question,
  onSubmit,
  onCancel,
}: AskDialogProps): React.ReactElement {
  const [answer, setAnswer] = useState('');

  // Keyboard handling — TextInput's onSubmit prop would also work for Enter,
  // but we want Esc as a peer behavior and useInput gives both in one place.
  // TextInput swallows Enter by default so submit has to come from here or
  // its onSubmit callback. Using TextInput.onSubmit would be cleaner but
  // that prop is typed as () => void in some ink-text-input versions — the
  // explicit useInput handler is the safer cross-version path.
  useInput((_input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.return) {
      onSubmit(answer);
    }
  });

  const width = process.stdout.columns || 80;

  return (
    <Box flexDirection="column">
      {/* Top border — warm-gold matches permission dialog, signals "modal blocking" */}
      <Box>
        <Text color={colors.permission}>
          {'\u256D'}{figures.divider.repeat(width - 2)}
        </Text>
      </Box>

      <Box flexDirection="column" paddingX={2}>
        {/* Question header. The agent asked it; render as the agent's voice. */}
        <Box marginBottom={1} flexDirection="column">
          <Text color={colors.permission} bold>
            {question}
          </Text>
        </Box>

        {/* Input row */}
        <Box>
          <Text dimColor>{'> '}</Text>
          <TextInput value={answer} onChange={setAnswer} />
        </Box>

        {/* Hint */}
        <Box marginTop={1}>
          <Text dimColor italic>
            Enter to submit {figures.bullet} Esc to cancel (returns empty)
          </Text>
        </Box>
      </Box>
    </Box>
  );
}
