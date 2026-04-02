# UI Plan — Port Claude Code, Then Customize

## The Problem
We keep building half-measures. Claude Code has a battle-tested UI with hundreds of interactions.
We need to port it properly, not reinvent each piece.

## Priority 1: Interactive Commands (Broken Right Now)

### /model → Interactive Picker (NOT text dump)
Claude Code: opens an inline Select component. Arrow up/down to pick model. Left/right to change effort. Enter to confirm. Esc to cancel. Shows descriptions.

What we need:
- `ModelPicker` component with `<Select>` style list
- Models: opus, sonnet, haiku, gemini, flash (+ descriptions + context window size)
- Effort: left/right arrows cycle low → medium → high
- Enter confirms, Esc cancels
- Renders inline above the input (not a text message)
- File: `src/ui/modelPicker.tsx`

### Slash command autocomplete → Tab completion + Enter to execute
Current: shows a list but Tab doesn't work reliably, Enter doesn't execute the selected command.
Fix: Tab inserts command text, Enter executes it directly if it's a no-arg command.

### /help → Inline dialog with keybindings
Current: prints text as a message.
Should: render as an inline component above input, Esc to dismiss.

## Priority 2: Input Behavior (Feels Wrong)

### Mode indicators
- `>` for normal prompt (we have this as ❯)
- `!` prefix switches to bash mode (not implemented)
- When loading: dim the prompt, show "Esc to interrupt"

### Multiline
- Shift+Enter for newline (not implemented)
- Up/Down navigate within multiline before falling through to history

### Paste handling
- Long pastes become [Pasted text, N lines] chip (not implemented, low priority)

### Esc behavior
- During loading: cancel/interrupt the request
- On empty input with double-press: open message rewind selector (future)
- Otherwise: clear autocomplete

### Input stash
- Ctrl+S saves current input, second Ctrl+S restores it (nice to have)

## Priority 3: Message Rendering (Close But Off)

### Tool result prefix
- Claude Code uses `⎿` (two spaces + character + two spaces) dim, for all tool results
- We show nothing for successful results — they're silent
- We should show `  ⎿  [brief result]` for completed tool calls

### Thinking blocks
- Not relevant yet (we don't use extended thinking in Phase 1)
- Future: show `∴ Thinking...` dim italic

### Message grouping
- Parallel tool calls grouped visually
- Read/search calls collapsed into one line
- Not critical for V1

### Interrupted message
- When user hits Esc during streaming: show "Interrupted" indicator
- Not implemented

## Priority 4: Layout & Scroll (Works But Basic)

### Auto-scroll + "N new messages" pill
- Auto-scroll to bottom on new content (we have this via Ink)
- When user scrolls up: stop auto-scroll, show pill
- Not critical — Ink's default scrolling is acceptable for V1

### Keyboard scroll
- PageUp/PageDown for scroll
- Not critical for V1

## Priority 5: Status Bar (Functional But Plain)

### Custom statusline hook
- Claude Code runs a user shell command that produces ANSI
- We have a built-in bar — good enough for V1
- Future: support custom statusline commands

### Footer hints
- "Esc to interrupt" during loading
- Permission mode indicator
- "? for shortcuts"
- Notification area (right side)

## Priority 6: Keyboard Shortcuts (Missing)

### Essential
- Ctrl+C: interrupt during loading, double-press to exit
- Esc: cancel/interrupt
- Alt+P: open model picker
- Ctrl+L: redraw terminal

### Nice to have
- Ctrl+O: toggle verbose/transcript mode
- Ctrl+R: history search
- Ctrl+S: stash input
- Ctrl+G: open in $EDITOR

## Build Order

### Sprint 1: Fix what's broken (model picker + command execution)
1. `src/ui/modelPicker.tsx` — interactive Select with effort
2. `src/ui/select.tsx` — reusable Select component (arrow keys, Enter, Esc)
3. Update `commandPalette.tsx` — Tab completes, Enter executes no-arg commands
4. Update `app.tsx` — /model opens ModelPicker as inline overlay, not text dump

### Sprint 2: Input polish
1. `!` bash mode prefix detection
2. Shift+Enter multiline
3. Esc to interrupt during loading
4. "Esc to interrupt" hint in footer during loading
5. Double Ctrl+C to exit

### Sprint 3: Message rendering polish
1. Tool result `⎿` prefix for completed tools
2. Interrupted indicator when Esc cancels streaming
3. Dim loading state for prompt

### Sprint 4: Keyboard shortcuts
1. Alt+P for model picker
2. Ctrl+L redraw
3. Ctrl+C interrupt logic
4. Esc context-dependent behavior

### Sprint 5: Scroll + advanced (V2)
1. PageUp/PageDown scroll
2. "N new messages" pill
3. Message rewind (double-Esc)
4. Custom statusline hook
