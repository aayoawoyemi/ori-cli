/**
 * StableInput — ref-based text input immune to render-cycle keystroke drops.
 *
 * Ink's useInput fires listeners synchronously for each parsed keypress from
 * stdin. Multiple useInput hooks (App-level for shortcuts, PromptInput for
 * history, StableInput for chars) all fire for the SAME event. When an
 * upstream handler triggers a React state update (setDisplayMessages,
 * setPermissionMode), the re-render can cause this component to unmount and
 * remount its useInput listener, potentially missing a concurrent event.
 *
 * Defense: ref-based buffer (never stale), minimal state surface, and a
 * post-render effect that forces display sync. Even if useInput misses a
 * beat, the refs hold the truth.
 *
 * NOTE: On Windows terminals (ConPTY/Git Bash), fast typing can coalesce
 * multiple characters into a single stdin chunk. Ink delivers these as one
 * `input` string in useInput, which we handle as a batch insert.
 */
import React, { useRef, useReducer, useEffect, useCallback } from 'react';
import { Text, useInput } from 'ink';

interface StableInputProps {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  placeholder?: string;
  /** When true, the component ignores keystrokes (e.g. during loading). */
  disabled?: boolean;
}

export function StableInput({
  value,
  onChange,
  onSubmit,
  placeholder = '',
  disabled = false,
}: StableInputProps): React.ReactElement {
  const bufferRef = useRef<string>(value);
  const cursorRef = useRef<number>(value.length);
  const [renderTick, forceRender] = useReducer((x: number) => x + 1, 0);
  const lastNotifiedRef = useRef<string>(value);

  // Keep the ref in sync when the parent programmatically sets value
  // (history navigation, palette tab-completion, submit-clears-input, etc.)
  useEffect(() => {
    if (bufferRef.current !== value) {
      bufferRef.current = value;
      cursorRef.current = value.length;
      lastNotifiedRef.current = value;
      forceRender();
    }
  }, [value]);

  // Post-render sync: if the buffer changed but onChange wasn't called
  // (e.g. a useInput handler was skipped during a re-render storm),
  // notify the parent now.
  useEffect(() => {
    if (bufferRef.current !== lastNotifiedRef.current) {
      lastNotifiedRef.current = bufferRef.current;
      onChange(bufferRef.current);
    }
  }, [renderTick, onChange]);

  const insertText = useCallback((text: string) => {
    const cleaned = text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
    if (!cleaned) return;
    const buf = bufferRef.current;
    const cur = cursorRef.current;
    bufferRef.current = buf.slice(0, cur) + cleaned + buf.slice(cur);
    cursorRef.current = cur + cleaned.length;
    lastNotifiedRef.current = bufferRef.current;
    onChange(bufferRef.current);
    forceRender();
  }, [onChange]);

  useInput((input, key) => {
    if (disabled) return;

    const buf = bufferRef.current;
    const cur = cursorRef.current;

    // ── Submit ────────────────────────────────────────────────────────
    if (key.return) {
      onSubmit(buf);
      return;
    }

    // ── Arrow nav (let parent intercept up/down for history first) ────
    if (key.leftArrow) {
      if (cur > 0) {
        cursorRef.current = cur - 1;
        forceRender();
      }
      return;
    }
    if (key.rightArrow) {
      if (cur < buf.length) {
        cursorRef.current = cur + 1;
        forceRender();
      }
      return;
    }
    // Up/down arrows are consumed by parent for history. We do nothing.
    if (key.upArrow || key.downArrow) {
      return;
    }

    // ── Backspace / Delete ────────────────────────────────────────────
    if (key.backspace || key.delete) {
      if (cur > 0) {
        bufferRef.current = buf.slice(0, cur - 1) + buf.slice(cur);
        cursorRef.current = cur - 1;
        lastNotifiedRef.current = bufferRef.current;
        onChange(bufferRef.current);
        forceRender();
      }
      return;
    }

    // ── Emacs-style line editing ──────────────────────────────────────
    if (key.ctrl) {
      if (input === 'a') {
        cursorRef.current = 0;
        forceRender();
        return;
      }
      if (input === 'e') {
        cursorRef.current = buf.length;
        forceRender();
        return;
      }
      if (input === 'u') {
        bufferRef.current = buf.slice(cur);
        cursorRef.current = 0;
        lastNotifiedRef.current = bufferRef.current;
        onChange(bufferRef.current);
        forceRender();
        return;
      }
      if (input === 'k') {
        bufferRef.current = buf.slice(0, cur);
        lastNotifiedRef.current = bufferRef.current;
        onChange(bufferRef.current);
        forceRender();
        return;
      }
      if (input === 'w') {
        let i = cur;
        while (i > 0 && /\s/.test(buf[i - 1]!)) i--;
        while (i > 0 && !/\s/.test(buf[i - 1]!)) i--;
        bufferRef.current = buf.slice(0, i) + buf.slice(cur);
        cursorRef.current = i;
        lastNotifiedRef.current = bufferRef.current;
        onChange(bufferRef.current);
        forceRender();
        return;
      }
      // Swallow unknown ctrl combos
      return;
    }

    // ── Alt/Meta combos are consumed by parent (Alt+P, Alt+M, Alt+V) ──
    // On Windows, Alt may arrive as escape instead of meta
    if (key.meta) return;
    if (key.escape && input && /^[a-z]$/i.test(input)) return;

    // ── Regular char input or paste ───────────────────────────────────
    // Ink may deliver multiple chars in a single `input` when stdin
    // coalesces fast keystrokes or pastes. insertText handles the batch.
    if (input) {
      insertText(input);
    }
  });

  // ── Render ──────────────────────────────────────────────────────────
  const buf = bufferRef.current;
  const cur = cursorRef.current;

  if (!buf && placeholder) {
    return (
      <Text>
        <Text inverse> </Text>
        <Text dimColor>{placeholder}</Text>
      </Text>
    );
  }

  const before = buf.slice(0, cur);
  const atChar = buf[cur] ?? ' ';
  const after = buf.slice(cur + 1);

  return (
    <Text>
      {before}
      <Text inverse>{atChar}</Text>
      {after}
    </Text>
  );
}
