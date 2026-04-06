/**
 * Terminal title + notification utilities.
 *
 * Sets the terminal tab title via ANSI OSC escape sequences.
 * Flashes the Windows taskbar on task completion.
 */
import { execSync } from 'node:child_process';
import { platform } from 'node:os';
import { basename } from 'node:path';

/** Set the terminal window/tab title via OSC escape. */
export function setTitle(title: string): void {
  process.stdout.write(`\x1b]0;${title}\x07`);
}

/** Build a title from agent name + optional suffix. */
export function formatTitle(agentName: string, _cwd: string, suffix?: string): string {
  return suffix ? `${agentName} — ${suffix}` : agentName;
}

/** Set title to show the agent is thinking/working. */
export function setTitleBusy(agentName: string, cwd: string): void {
  setTitle(formatTitle(agentName, cwd, 'working...'));
}

/** Set title to show the agent is idle/waiting for input. */
export function setTitleIdle(agentName: string, cwd: string): void {
  setTitle(formatTitle(agentName, cwd));
}

/** Set title to show the agent finished a task. */
export function setTitleDone(agentName: string, cwd: string): void {
  setTitle(formatTitle(agentName, cwd, 'done'));
}

/**
 * Flash the taskbar icon to get user attention.
 * Windows: uses PowerShell to flash the console window.
 * macOS: uses osascript to bounce the dock icon.
 * Linux: no-op (terminal-dependent).
 */
export function flashTaskbar(): void {
  const p = platform();
  try {
    if (p === 'win32') {
      // Ring the terminal bell — Windows Terminal will flash the taskbar
      process.stdout.write('\x07');
    } else if (p === 'darwin') {
      execSync('osascript -e \'tell application "Terminal" to activate\'', { stdio: 'ignore' });
    }
  } catch { /* non-fatal */ }
}
