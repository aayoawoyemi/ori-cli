import type { Message, SystemPromptInput } from './router/types.js';
import type { ModelRouter } from './router/index.js';
import type { ReplHandle } from './repl/setup.js';
import type { SessionStorage } from './session/storage.js';
import { extractCodeCells, type CodeExtractionResult } from './loop/codeExtractor.js';
import { formatExecutionResult, mapReplResultToCell, type ExecutedCell } from './loop/resultFormatter.js';

export type Loop2Event =
  | { type: 'model_start'; turn: number; model: string }
  | { type: 'provider_event'; stage: 'request_start' | 'first_event' | 'backoff' | 'request_error'; provider: string; model: string; attempt?: number; elapsedMs?: number; backoffMs?: number; reason?: string; message?: string }
  | { type: 'text'; content: string }
  | { type: 'thinking'; content: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number; totalTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }
  | { type: 'execution_result'; content: string; status: 'ok' | 'error' | 'note'; cells: number }
  | { type: 'done_committed'; value: unknown }
  | { type: 'turn_complete'; turn: number; tokenEstimate: number; toolCallCount: number; toolNames: string[]; replCellCount: number }
  | { type: 'cutoff_warning'; reason: 'max_tokens' | 'context_window'; message: string }
  | { type: 'error'; error: unknown };

export interface Loop2Params {
  messages: Message[];
  systemPrompt: SystemPromptInput;
  router: ModelRouter;
  replHandle: ReplHandle | null;
  session: SessionStorage | null;
  maxTurns?: number;
  signal?: AbortSignal;
}

function capText(text: string, maxChars: number): string | undefined {
  if (!text) return undefined;
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars);
}

function tailText(text: string, maxChars: number): string | undefined {
  if (!text) return undefined;
  if (text.length <= maxChars) return text;
  return text.slice(text.length - maxChars);
}

function turnPredicate(assistantText: string, extraction: CodeExtractionResult) {
  return {
    hasDoneCall: assistantText.includes('done('),
    hasClosedPyFence: extraction.cells.length > 0,
    hasOnlyProse: !extraction.hasAnyFence && extraction.cells.length === 0,
    hasMalformedFence: extraction.notes.some((note) => /unclosed|non-python|ignored non-python/i.test(note)),
  };
}

async function executeCells(params: {
  extraction: CodeExtractionResult;
  replHandle: ReplHandle;
  session: SessionStorage | null;
  turn: number;
  signal?: AbortSignal;
}): Promise<ExecutedCell[]> {
  const { extraction, replHandle, session, turn, signal } = params;
  const executedCells: ExecutedCell[] = [];

  session?.log({
    type: 'loop2_cell_batch_start',
    turn,
    cell_count: extraction.cells.length,
    timestamp: Date.now(),
  });

  for (const cell of extraction.cells) {
    const header = cell.id ? `# cell ${cell.index}: ${cell.id}` : `# cell ${cell.index}`;
    try {
      const result = await replHandle.exec(
        { code: `${header}\n${cell.code}`, timeout_ms: cell.timeoutMs },
        signal,
      );
      const mapped = mapReplResultToCell(cell, result);
      executedCells.push(mapped);

      const status = mapped.exception
        ? 'exception'
        : mapped.rejectedReason
          ? 'rejected'
          : mapped.timedOut
            ? 'timeout'
            : 'ok';
      session?.log({
        type: 'loop2_cell_result',
        turn,
        cell_index: cell.index,
        cell_id: cell.id,
        status,
        duration_ms: mapped.durationMs,
        timestamp: Date.now(),
      });

      if (mapped.doneValue !== undefined) {
        break;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      session?.log({
        type: 'loop2_cell_result',
        turn,
        cell_index: cell.index,
        cell_id: cell.id,
        status: 'exception',
        duration_ms: 0,
        timestamp: Date.now(),
      });
      executedCells.push({
        cell,
        stdout: '',
        stderr: '',
        exception: message,
        rejectedReason: null,
        timedOut: false,
        durationMs: 0,
        sayTexts: [],
      });
      break;
    }
  }

  return executedCells;
}

export async function* agentLoop2(params: Loop2Params): AsyncGenerator<Loop2Event> {
  const {
    messages,
    systemPrompt,
    router,
    replHandle,
    session,
    maxTurns = 50,
    signal,
  } = params;

  let turn = 0;

  while (turn < maxTurns) {
    turn += 1;
    let assistantText = '';
    yield { type: 'model_start', turn, model: router.current.model };

    try {
      for await (const event of router.stream(messages, systemPrompt, [], signal)) {
        switch (event.type) {
          case 'provider_event':
            session?.log({ ...event, type: 'provider_event', timestamp: Date.now() });
            yield event;
            break;
          case 'thinking':
            session?.log({
              type: 'loop2_thinking',
              turn,
              chars: event.content.length,
              timestamp: Date.now(),
            });
            yield event;
            break;
          case 'text':
            assistantText += event.content;
            yield event;
            break;
          case 'usage':
            session?.log({ ...event, type: 'usage', timestamp: Date.now() });
            yield event;
            break;
          case 'cutoff_warning':
            assistantText += `\n\n[harness:cutoff reason="${event.reason}"] ${event.message}`;
            session?.log({ ...event, type: 'cutoff_warning', timestamp: Date.now() });
            yield event;
            break;
          default:
            break;
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Preserve any accumulated assistant text so the forensic logging
      // surfaces partial output on stream termination. Without this, an early
      // stream error wipes the diagnostic surface (content_head/tail) and the
      // model's pre-error behavior is invisible to the bench parser.
      session?.log({
        type: 'loop2_assistant',
        turn,
        chars: assistantText.length,
        content_head: capText(assistantText, 2000),
        content_tail: assistantText.length > 2000 ? tailText(assistantText, 2000) : undefined,
        partial_on_error: true,
        timestamp: Date.now(),
      });
      if (assistantText.trim().length > 0 && replHandle) {
        messages.push({ role: 'assistant', content: assistantText });
        const partialExtraction = extractCodeCells(assistantText);
        session?.log({
          type: 'loop2_extraction',
          turn,
          cell_count: partialExtraction.cells.length,
          has_any_fence: partialExtraction.hasAnyFence,
          notes: [...partialExtraction.notes, 'recovered-from-stream-error'],
          timestamp: Date.now(),
        });
        session?.log({
          type: 'loop2_turn_predicate',
          turn,
          ...turnPredicate(assistantText, partialExtraction),
          timestamp: Date.now(),
        });

        if (partialExtraction.cells.length > 0 && partialExtraction.cells.length <= 20) {
          const recoveredCells = await executeCells({
            extraction: partialExtraction,
            replHandle,
            session,
            turn,
            signal,
          });
          const envelope = formatExecutionResult({
            cells: recoveredCells,
            notes: [...partialExtraction.notes, 'recovered from stream error'],
          });
          messages.push({ role: 'user', content: envelope.xml });
          session?.log({
            type: 'loop2_execution_result',
            turn,
            cell_count: recoveredCells.length,
            status: envelope.status,
            duration_ms: envelope.totalDurationMs,
            timestamp: Date.now(),
          });
          yield {
            type: 'execution_result',
            content: envelope.xml,
            status: envelope.status,
            cells: recoveredCells.length,
          };

          const doneCommitted = envelope.doneValue !== undefined;
          if (doneCommitted) {
            session?.log({
              type: 'loop2_done_committed',
              turn,
              value: envelope.doneValue,
              timestamp: Date.now(),
            });
            yield { type: 'done_committed', value: envelope.doneValue };
          }

          const tokenEstimate = router.current.estimateTokens(messages);
          session?.log({
            type: 'loop2_turn_complete',
            turn,
            cell_count: recoveredCells.length,
            done_committed: doneCommitted,
            status: envelope.status,
            timestamp: Date.now(),
          });
          yield {
            type: 'turn_complete',
            turn,
            tokenEstimate,
            toolCallCount: recoveredCells.length > 0 ? 1 : 0,
            toolNames: recoveredCells.length > 0 ? ['loop2_exec'] : [],
            replCellCount: recoveredCells.length,
          };

          if (doneCommitted) {
            return;
          }
          continue;
        }
      }
      session?.log({ type: 'error', message: `loop2 stream error: ${message}`, timestamp: Date.now() });
      yield { type: 'error', error };
      return;
    }

    messages.push({ role: 'assistant', content: assistantText });
    session?.log({
      type: 'loop2_assistant',
      turn,
      chars: assistantText.length,
      content_head: capText(assistantText, 2000),
      content_tail: assistantText.length > 2000 ? tailText(assistantText, 2000) : undefined,
      timestamp: Date.now(),
    });

    const extraction = extractCodeCells(assistantText);
    session?.log({
      type: 'loop2_extraction',
      turn,
      cell_count: extraction.cells.length,
      has_any_fence: extraction.hasAnyFence,
      notes: extraction.notes,
      timestamp: Date.now(),
    });
    session?.log({
      type: 'loop2_turn_predicate',
      turn,
      ...turnPredicate(assistantText, extraction),
      timestamp: Date.now(),
    });

    if (extraction.cells.length === 0) {
      if (extraction.notes.length > 0) {
        const envelope = formatExecutionResult({
          cells: [],
          notes: extraction.notes,
          forceStatus: 'error',
        });
        messages.push({ role: 'user', content: envelope.xml });
        session?.log({
          type: 'loop2_execution_result',
          turn,
          cell_count: 0,
          status: envelope.status,
          duration_ms: envelope.totalDurationMs,
          timestamp: Date.now(),
        });
        yield {
          type: 'execution_result',
          content: envelope.xml,
          status: envelope.status,
          cells: 0,
        };
        const tokenEstimate = router.current.estimateTokens(messages);
        session?.log({
          type: 'loop2_turn_complete',
          turn,
          cell_count: 0,
          done_committed: false,
          status: envelope.status,
          timestamp: Date.now(),
        });
        yield {
          type: 'turn_complete',
          turn,
          tokenEstimate,
          toolCallCount: 0,
          toolNames: [],
          replCellCount: 0,
        };
        continue;
      }

      const tokenEstimate = router.current.estimateTokens(messages);
      session?.log({
        type: 'loop2_turn_complete',
        turn,
        cell_count: 0,
        done_committed: false,
        status: 'ok',
        timestamp: Date.now(),
      });
      yield {
        type: 'turn_complete',
        turn,
        tokenEstimate,
        toolCallCount: 0,
        toolNames: [],
        replCellCount: 0,
      };
      return;
    }

    if (!replHandle) {
      const envelope = formatExecutionResult({
        cells: [],
        notes: [...extraction.notes, 'execution substrate unavailable; cannot run Python cells.'],
      });
      messages.push({ role: 'user', content: envelope.xml });
      session?.log({
        type: 'loop2_execution_result',
        turn,
        cell_count: 0,
        status: 'error',
        duration_ms: 0,
        timestamp: Date.now(),
      });
      yield {
        type: 'execution_result',
        content: envelope.xml,
        status: 'error',
        cells: 0,
      };
      const tokenEstimate = router.current.estimateTokens(messages);
      session?.log({
        type: 'loop2_turn_complete',
        turn,
        cell_count: 0,
        done_committed: false,
        status: 'error',
        timestamp: Date.now(),
      });
      yield {
        type: 'turn_complete',
        turn,
        tokenEstimate,
        toolCallCount: 0,
        toolNames: [],
        replCellCount: 0,
      };
      return;
    }

    if (extraction.cells.length > 20) {
      const envelope = formatExecutionResult({
        cells: [],
        notes: [...extraction.notes, `${extraction.cells.length} cells found; max 20 per turn.`],
      });
      messages.push({ role: 'user', content: envelope.xml });
      session?.log({
        type: 'loop2_execution_result',
        turn,
        cell_count: 0,
        status: 'error',
        duration_ms: 0,
        timestamp: Date.now(),
      });
      yield {
        type: 'execution_result',
        content: envelope.xml,
        status: 'error',
        cells: 0,
      };
      const tokenEstimate = router.current.estimateTokens(messages);
      session?.log({
        type: 'loop2_turn_complete',
        turn,
        cell_count: 0,
        done_committed: false,
        status: 'error',
        timestamp: Date.now(),
      });
      yield {
        type: 'turn_complete',
        turn,
        tokenEstimate,
        toolCallCount: 0,
        toolNames: [],
        replCellCount: 0,
      };
      continue;
    }

    const executedCells = await executeCells({ extraction, replHandle, session, turn, signal });

    const envelope = formatExecutionResult({
      cells: executedCells,
      notes: extraction.notes,
    });
    messages.push({ role: 'user', content: envelope.xml });
    session?.log({
      type: 'loop2_execution_result',
      turn,
      cell_count: executedCells.length,
      status: envelope.status,
      duration_ms: envelope.totalDurationMs,
      timestamp: Date.now(),
    });

    yield {
      type: 'execution_result',
      content: envelope.xml,
      status: envelope.status,
      cells: executedCells.length,
    };

    const doneCommitted = envelope.doneValue !== undefined;
    if (doneCommitted) {
      session?.log({
        type: 'loop2_done_committed',
        turn,
        value: envelope.doneValue,
        timestamp: Date.now(),
      });
      yield { type: 'done_committed', value: envelope.doneValue };
    }

    const tokenEstimate = router.current.estimateTokens(messages);
    session?.log({
      type: 'loop2_turn_complete',
      turn,
      cell_count: executedCells.length,
      done_committed: doneCommitted,
      status: envelope.status,
      timestamp: Date.now(),
    });
    yield {
      type: 'turn_complete',
      turn,
      tokenEstimate,
      toolCallCount: executedCells.length > 0 ? 1 : 0,
      toolNames: executedCells.length > 0 ? ['loop2_exec'] : [],
      replCellCount: executedCells.length,
    };

    if (doneCommitted) {
      return;
    }
  }

  const error = new Error(`max_turns_exceeded: Loop2 reached ${maxTurns} turns without natural stop or done(value).`);
  session?.log({ type: 'error', message: error.message, timestamp: Date.now() });
  yield { type: 'error', error };
}
