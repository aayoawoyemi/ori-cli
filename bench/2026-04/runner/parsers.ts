/**
 * Per-CLI metric extraction.
 *
 * Each parser takes raw stdout (and optionally stderr / supplementary files)
 * and returns a Metrics object in the common shape.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Metrics {
  tokens: {
    input: number;
    cached: number;
    output: number;
    total: number;
  };
  toolCalls: {
    total: number;
    byTool: Record<string, number>;
  };
  finalAnswer: string;
  /** Raw transcript (for archival). */
  transcript: string;
}

// ── Claude Code (--output-format stream-json) ──────────────────────────────

interface ClaudeStreamEvent {
  type: string;
  message?: {
    content?: Array<{ type: string; text?: string; name?: string }>;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
  result?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

export function parseClaude(stdout: string): Metrics {
  const lines = stdout.split('\n').filter((l) => l.trim());
  let inputTokens = 0;
  let cachedTokens = 0;
  let outputTokens = 0;
  let finalAnswer = '';
  const byTool: Record<string, number> = {};

  for (const line of lines) {
    let event: ClaudeStreamEvent;
    try {
      event = JSON.parse(line) as ClaudeStreamEvent;
    } catch {
      continue;
    }

    // Aggregate tool_use blocks per assistant message
    if (event.type === 'assistant' && event.message?.content) {
      for (const block of event.message.content) {
        if (block.type === 'tool_use' && block.name) {
          byTool[block.name] = (byTool[block.name] ?? 0) + 1;
        }
      }
      // Usage on assistant message_delta is the most accurate per-turn
      const u = event.message.usage;
      if (u) {
        inputTokens += u.input_tokens ?? 0;
        cachedTokens += u.cache_read_input_tokens ?? 0;
        outputTokens += u.output_tokens ?? 0;
      }
    }

    // Final result event has the textual answer
    if (event.type === 'result' && typeof event.result === 'string') {
      finalAnswer = event.result;
      // Result event also carries final usage; prefer it if present
      const u = event.usage;
      if (u && (u.input_tokens ?? 0) > 0) {
        inputTokens = u.input_tokens ?? inputTokens;
        cachedTokens = u.cache_read_input_tokens ?? cachedTokens;
        outputTokens = u.output_tokens ?? outputTokens;
      }
    }
  }

  const totalTools = Object.values(byTool).reduce((a, b) => a + b, 0);

  return {
    tokens: {
      input: inputTokens,
      cached: cachedTokens,
      output: outputTokens,
      total: inputTokens + cachedTokens + outputTokens,
    },
    toolCalls: { total: totalTools, byTool },
    finalAnswer,
    transcript: stdout,
  };
}

// ── pi-coding-agent (--mode json) ──────────────────────────────────────────

interface PiEvent {
  type?: string;
  // pi emits assistant_message_event / message_start / message_end / etc.
  // Final assistant message has content array with text + toolCall blocks
  message?: {
    role?: string;
    content?: Array<{ type: string; text?: string; name?: string }>;
    usage?: {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
    };
  };
  assistantMessageEvent?: { partial?: { content?: Array<{ type: string; text?: string; name?: string }> } };
  toolCallId?: string;
  toolName?: string;
}

export function parsePi(stdout: string): Metrics {
  const lines = stdout.split('\n').filter((l) => l.trim());
  let inputTokens = 0;
  let cachedTokens = 0;
  let outputTokens = 0;
  let finalAnswer = '';
  const byTool: Record<string, number> = {};
  const seenToolCallIds = new Set<string>();

  for (const line of lines) {
    let event: PiEvent;
    try {
      event = JSON.parse(line) as PiEvent;
    } catch {
      continue;
    }

    // Tool execution events carry toolCallId + toolName
    if (event.type === 'tool_execution_start' && event.toolName && event.toolCallId) {
      if (!seenToolCallIds.has(event.toolCallId)) {
        seenToolCallIds.add(event.toolCallId);
        byTool[event.toolName] = (byTool[event.toolName] ?? 0) + 1;
      }
    }

    // Assistant message_end has full content + usage
    if (event.type === 'message_end' && event.message?.role === 'assistant') {
      const content = event.message.content ?? [];
      for (const block of content) {
        if (block.type === 'text' && typeof block.text === 'string') {
          finalAnswer = block.text; // last text block wins
        }
      }
      const u = event.message.usage;
      if (u) {
        inputTokens += u.input ?? 0;
        cachedTokens += u.cacheRead ?? 0;
        outputTokens += u.output ?? 0;
      }
    }
  }

  const totalTools = Object.values(byTool).reduce((a, b) => a + b, 0);

  return {
    tokens: {
      input: inputTokens,
      cached: cachedTokens,
      output: outputTokens,
      total: inputTokens + cachedTokens + outputTokens,
    },
    toolCalls: { total: totalTools, byTool },
    finalAnswer,
    transcript: stdout,
  };
}

// ── aries-cli (session log + stdout) ───────────────────────────────────────

interface AriesEvent {
  type?: string;
  name?: string;
  content?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  timestamp?: number;
}

export function parseAries(stdout: string, _stderr: string, sessionStartedAt: number): Metrics {
  // Find the session log file most recently created/modified after sessionStartedAt
  const sessionsDir = join(homedir(), '.aries', 'sessions');
  let logPath: string | null = null;

  if (existsSync(sessionsDir)) {
    const candidates: { path: string; mtime: number }[] = [];
    for (const sessId of readdirSync(sessionsDir)) {
      const sessPath = join(sessionsDir, sessId);
      try {
        const stat = statSync(sessPath);
        if (!stat.isDirectory()) continue;
        for (const f of readdirSync(sessPath)) {
          if (!f.endsWith('.jsonl')) continue;
          const fp = join(sessPath, f);
          const fstat = statSync(fp);
          if (fstat.mtimeMs >= sessionStartedAt - 1000) {
            candidates.push({ path: fp, mtime: fstat.mtimeMs });
          }
        }
      } catch {
        // skip
      }
    }
    candidates.sort((a, b) => b.mtime - a.mtime);
    if (candidates.length > 0) logPath = candidates[0]!.path;
  }

  let inputTokens = 0;
  let cachedTokens = 0;
  let outputTokens = 0;
  let finalAnswer = '';
  const byTool: Record<string, number> = {};
  let transcript = stdout;

  if (logPath) {
    const log = readFileSync(logPath, 'utf-8');
    transcript = log;
    for (const line of log.split('\n').filter((l) => l.trim())) {
      let event: AriesEvent;
      try {
        event = JSON.parse(line) as AriesEvent;
      } catch {
        continue;
      }

      if (event.type === 'tool_call' && event.name) {
        byTool[event.name] = (byTool[event.name] ?? 0) + 1;
      }
      if (event.type === 'usage') {
        inputTokens += event.inputTokens ?? 0;
        cachedTokens += event.cacheReadTokens ?? 0;
        outputTokens += event.outputTokens ?? 0;
      }
      if (event.type === 'assistant' && typeof event.content === 'string') {
        finalAnswer = event.content; // last assistant text wins
      }
    }
  } else {
    // Fall back to stdout if no session log found
    finalAnswer = stdout;
  }

  const totalTools = Object.values(byTool).reduce((a, b) => a + b, 0);

  return {
    tokens: {
      input: inputTokens,
      cached: cachedTokens,
      output: outputTokens,
      total: inputTokens + cachedTokens + outputTokens,
    },
    toolCalls: { total: totalTools, byTool },
    finalAnswer,
    transcript,
  };
}
