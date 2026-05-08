import type { ContentBlock, Message, SystemPromptInput } from '../router/types.js';
import type { ToolCall } from '../router/types.js';
import type { ReplHandle } from '../repl/setup.js';
import type { SessionStorage } from '../session/storage.js';
import type { ActionAdapter, ExecutionResult } from './types.js';
import { mapReplResultToExecution } from './resultMapper.js';
import type { ComposeController } from '../compose/controller.js';

export type Loop3PermissionMode = 'default' | 'accept' | 'plan' | 'research' | 'yolo';
export type Loop3PermissionDecision = 'allow' | 'deny' | 'always';

export type Loop3Event =
  | { type: 'model_start'; turn: number; provider: string }
  | { type: 'text'; content: string }
  | { type: 'thinking'; content: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number; totalTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }
  | { type: 'provider_event'; stage: string; reason?: string; message?: string }
  | { type: 'cutoff_warning'; reason: 'max_tokens' | 'context_window'; message: string }
  | { type: 'max_output_recovery'; attempt: number; maxAttempts: number }
  | { type: 'action_start'; turn: number; toolCall: ToolCall }
  | { type: 'action_executed'; turn: number; toolCall: ToolCall; result: ExecutionResult; doneCommitted: boolean }
  | { type: 'action_denied'; turn: number; toolCall: ToolCall }
  | { type: 'turn_complete'; turn: number; tokenEstimate: number; cellCount: number }
  | { type: 'done_committed'; value: unknown }
  | { type: 'error'; error: unknown };

export interface Loop3Params {
  messages: Message[];
  systemPrompt: SystemPromptInput | (() => SystemPromptInput | Promise<SystemPromptInput>);
  adapter: ActionAdapter;
  replHandle: ReplHandle | null;
  session: SessionStorage | null;
  estimateTokens?: (messages: Message[]) => number;
  maxTurns?: number;
  signal?: AbortSignal;
  modelTimeoutMs?: number;
  permissionMode?: Loop3PermissionMode;
  permissionModeRef?: { current: Loop3PermissionMode };
  alwaysAllowTools?: Set<string>;
  onPermissionRequest?: (toolCall: ToolCall) => Promise<Loop3PermissionDecision>;
  /**
   * Compose sub-loop controller for this request. When present and mode is
   * compose/goal, gates Repl execution on <compose_preflight> /
   * <compose_update> blocks parsed from assistant text. Quick mode passes
   * a controller too but its gateRepl always allows. Optional — when null
   * (e.g. headless bench, legacy callers) the loop runs without compose
   * gating, matching pre-Tier-3 behavior.
   */
  composeController?: ComposeController | null;
}

const MAX_OUTPUT_RECOVERY_LIMIT = 3;
const MAX_OUTPUT_RECOVERY_MESSAGE =
  'Output token limit hit. Resume directly — no apology, ' +
  'no recap of what you were doing. Pick up mid-thought ' +
  'if that is where the cut happened. Break remaining ' +
  'work into smaller pieces.';

async function resolveSystemPrompt(
  source: Loop3Params['systemPrompt'],
): Promise<SystemPromptInput> {
  return typeof source === 'function' ? await source() : source;
}

async function syncComposeBlocksToScratch(params: {
  composeController: ComposeController;
  replHandle: ReplHandle | null;
  parsed: { newPreflight: boolean; newUpdate: boolean };
  session: SessionStorage | null;
  turn: number;
}): Promise<void> {
  const { composeController, replHandle, parsed, session, turn } = params;
  const bridge = replHandle?.bridge;
  if (!bridge || composeController.isQuickMode) return;

  if (parsed.newPreflight) {
    const preflight = composeController.peekPreflight();
    if (preflight) {
      try {
        await bridge.composeSet({ section: 'preflight', text: preflight.raw });
      } catch (err) {
        session?.log({
          type: 'compose_scratch_sync_error',
          request_id: composeController.requestId,
          turn,
          section: 'preflight',
          error: err instanceof Error ? err.message : String(err),
          timestamp: Date.now(),
        });
      }
    }
  }

  if (parsed.newUpdate) {
    const update = composeController.peekUpdate();
    if (update) {
      try {
        await bridge.composeAppend({ section: 'findings', text: update.raw });
      } catch (err) {
        session?.log({
          type: 'compose_scratch_sync_error',
          request_id: composeController.requestId,
          turn,
          section: 'findings',
          error: err instanceof Error ? err.message : String(err),
          timestamp: Date.now(),
        });
      }
    }
  }
}

function head(text: string, n: number): string | undefined {
  if (!text) return undefined;
  return text.length <= n ? text : text.slice(0, n);
}

function tail(text: string, n: number): string | undefined {
  if (!text || text.length <= n) return undefined;
  return text.slice(-n);
}

function unknownType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function unknownPreview(value: unknown, headChars = 1000, tailChars = 500): {
  type: string;
  chars: number;
  head?: string;
  tail?: string;
} {
  let text: string;
  if (typeof value === 'string') {
    text = value;
  } else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  return {
    type: unknownType(value),
    chars: text.length,
    head: head(text, headChars),
    tail: tail(text, tailChars),
  };
}

function resultCharCount(result: ExecutionResult): number {
  return stdoutWithoutSayEcho(result.stdout, result.sayTexts).length
    + result.stderr.length
    + result.sayTexts.reduce((sum, text) => sum + text.length, 0)
    + (result.exception?.length ?? 0)
    + (result.rejectedReason?.length ?? 0);
}

function stdoutWithoutSayEcho(stdoutRaw: string, sayTexts: string[]): string {
  let stdout = stdoutRaw.trim();
  for (const say of sayTexts) {
    const text = say.trim();
    if (!text) continue;
    if (stdout === text) return '';
    if (stdout.startsWith(`${text}\n`)) stdout = stdout.slice(text.length).trimStart();
    if (stdout.endsWith(`\n${text}`)) stdout = stdout.slice(0, -text.length).trimEnd();
  }
  return stdout;
}

function withAssistantTextAppended(message: Message, text: string): Message {
  if (!text) return message;
  if (typeof message.content === 'string') {
    return { ...message, content: `${message.content}${text}` };
  }
  const blocks = [...message.content];
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (block?.type === 'text') {
      blocks[i] = { ...block, text: `${block.text}${text}` };
      return { ...message, content: blocks };
    }
  }
  return { ...message, content: [{ type: 'text', text }, ...blocks] };
}

function statusOf(result: ExecutionResult): 'ok' | 'exception' | 'rejected' | 'timeout' {
  if (result.exception) return 'exception';
  if (result.rejectedReason) return 'rejected';
  if (result.timedOut) return 'timeout';
  return 'ok';
}

function activeElapsed(startedAt: number, idleMs: number): number {
  return Math.max(0, Date.now() - startedAt - idleMs);
}

function defaultModelTimeoutMs(): number {
  const raw = process.env.ARIES_LOOP3_MODEL_TIMEOUT_MS;
  if (!raw) return 10 * 60 * 1000;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : 10 * 60 * 1000;
}

function createTurnSignal(parent: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  timedOut: () => boolean;
  cleanup: () => void;
} {
  const controller = new AbortController();
  let didTimeout = false;
  const onParentAbort = () => controller.abort(parent?.reason);
  if (parent) {
    if (parent.aborted) {
      controller.abort(parent.reason);
    } else {
      parent.addEventListener('abort', onParentAbort, { once: true });
    }
  }
  const timer = timeoutMs > 0
    ? setTimeout(() => {
        didTimeout = true;
        controller.abort(new Error(`loop3 model stream timed out after ${timeoutMs}ms`));
      }, timeoutMs)
    : null;
  return {
    signal: controller.signal,
    timedOut: () => didTimeout,
    cleanup: () => {
      if (timer) clearTimeout(timer);
      parent?.removeEventListener('abort', onParentAbort);
    },
  };
}

function actionToolCall(turn: number, action: { id?: string; code: string; timeoutMs?: number }): ToolCall {
  return {
    id: action.id ?? `loop3-repl-${turn}`,
    name: 'Repl',
    input: {
      code: action.code,
      ...(action.timeoutMs !== undefined ? { timeout_ms: action.timeoutMs } : {}),
    },
  };
}

function blocksOf(message: Message): ContentBlock[] | null {
  return Array.isArray(message.content) ? message.content : null;
}

function assistantTextAndToolUses(message: Message): {
  text: string;
  toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }>;
} | null {
  if (message.role !== 'assistant') return null;
  const blocks = blocksOf(message);
  if (!blocks) return null;
  const text = blocks
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('');
  const toolUses = blocks
    .filter((block): block is Extract<ContentBlock, { type: 'tool_use' }> => block.type === 'tool_use')
    .map((block) => ({ id: block.id, name: block.name, input: block.input }));
  if (toolUses.length === 0) return null;
  if (!toolUses.every((toolUse) => toolUse.name === 'Repl' && typeof toolUse.input?.code === 'string')) {
    return null;
  }
  return { text, toolUses };
}

function userToolResults(message: Message): Array<Extract<ContentBlock, { type: 'tool_result' }>> | null {
  if (message.role !== 'user') return null;
  const blocks = blocksOf(message);
  if (!blocks || blocks.length === 0) return null;
  if (!blocks.every((block) => block.type === 'tool_result')) return null;
  return blocks as Array<Extract<ContentBlock, { type: 'tool_result' }>>;
}

function xmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function cdataBlock(value: string): string {
  return `<![CDATA[\n${value.replace(/\]\]>/g, ']]]]><![CDATA[>')}\n]]>`;
}

function renderAssistantTranscript(text: string, toolUses: Array<{ id: string; input: Record<string, unknown> }>): string {
  const parts: string[] = [];
  const trimmed = text.trim();
  if (trimmed) parts.push(trimmed);
  for (const toolUse of toolUses) {
    const code = String(toolUse.input.code ?? '');
    parts.push([
      `<repl_call id="${xmlAttr(toolUse.id)}">`,
      `<code>${cdataBlock(code.trimEnd())}</code>`,
      '</repl_call>',
    ].join('\n'));
  }
  return parts.join('\n\n') || '<repl_call />';
}

function renderObservationTranscript(
  toolUses: Array<{ id: string }>,
  resultsById: Map<string, Extract<ContentBlock, { type: 'tool_result' }>>,
): string {
  const parts: string[] = [];
  for (const toolUse of toolUses) {
    const result = resultsById.get(toolUse.id);
    if (!result) continue;
    const status = result.is_error ? 'error' : 'ok';
    const content = result.content.trim() || 'ok';
    parts.push([
      `<repl_observation id="${xmlAttr(toolUse.id)}" status="${status}">`,
      `<output>${cdataBlock(content)}</output>`,
      '</repl_observation>',
    ].join('\n'));
  }
  return parts.join('\n\n') || '<repl_observation status="ok"><output><![CDATA[ok]]></output></repl_observation>';
}

export function rewriteCompletedReplToolPairsInPlace(
  messages: Message[],
  session?: SessionStorage | null,
): number {
  let rewrites = 0;
  let i = 0;
  while (i < messages.length) {
    const assistant = assistantTextAndToolUses(messages[i]!);
    if (!assistant) {
      i += 1;
      continue;
    }

    const needed = new Set(assistant.toolUses.map((toolUse) => toolUse.id));
    const resultsById = new Map<string, Extract<ContentBlock, { type: 'tool_result' }>>();
    let j = i + 1;
    while (j < messages.length && needed.size > 0) {
      const results = userToolResults(messages[j]!);
      if (!results) break;
      for (const result of results) {
        if (needed.has(result.tool_use_id)) {
          resultsById.set(result.tool_use_id, result);
          needed.delete(result.tool_use_id);
        }
      }
      j += 1;
    }

    if (needed.size > 0) {
      i += 1;
      continue;
    }

    const assistantTranscript = renderAssistantTranscript(assistant.text, assistant.toolUses);
    const observationTranscript = renderObservationTranscript(assistant.toolUses, resultsById);
    messages.splice(
      i,
      j - i,
      { role: 'assistant', content: assistantTranscript },
      { role: 'user', content: observationTranscript },
    );
    session?.log({
      type: 'loop3_transcript',
      assistant: assistantTranscript,
      user: observationTranscript,
      timestamp: Date.now(),
    });
    rewrites += 1;
    i += 2;
  }
  return rewrites;
}

async function approveAction(params: {
  toolCall: ToolCall;
  permissionMode: Loop3PermissionMode;
  alwaysAllowTools?: Set<string>;
  onPermissionRequest?: (toolCall: ToolCall) => Promise<Loop3PermissionDecision>;
}): Promise<{ approved: boolean; decision: 'auto_allow' | 'allow' | 'always' | 'deny'; promptShown: boolean; elapsedMs: number }> {
  const { toolCall, permissionMode, alwaysAllowTools, onPermissionRequest } = params;
  const startedAt = Date.now();
  if (permissionMode === 'accept' || permissionMode === 'plan' || permissionMode === 'research' || permissionMode === 'yolo') {
    return { approved: true, decision: 'auto_allow', promptShown: false, elapsedMs: Date.now() - startedAt };
  }
  if (alwaysAllowTools?.has(toolCall.name)) {
    return { approved: true, decision: 'always', promptShown: false, elapsedMs: Date.now() - startedAt };
  }
  if (!onPermissionRequest) {
    return { approved: true, decision: 'auto_allow', promptShown: false, elapsedMs: Date.now() - startedAt };
  }
  const decision = await onPermissionRequest(toolCall);
  if (decision === 'always') alwaysAllowTools?.add(toolCall.name);
  return {
    approved: decision === 'allow' || decision === 'always',
    decision,
    promptShown: true,
    elapsedMs: Date.now() - startedAt,
  };
}

export async function* agentLoop3(params: Loop3Params): AsyncGenerator<Loop3Event> {
  const { messages, systemPrompt, adapter, replHandle, session, estimateTokens, maxTurns = 50, signal } = params;
  const composeController = params.composeController ?? null;
  const modelTimeoutMs = params.modelTimeoutMs ?? defaultModelTimeoutMs();

  let turn = 0;
  let maxOutputRecoveryCount = 0;
  while (turn < maxTurns) {
    rewriteCompletedReplToolPairsInPlace(messages, session);
    turn += 1;
    const turnStartedAt = Date.now();
    let turnIdleMs = 0;
    session?.log({
      type: 'loop3_model_start',
      turn,
      provider: adapter.providerName,
      message_count: messages.length,
      timestamp: turnStartedAt,
    });
    yield { type: 'model_start', turn, provider: adapter.providerName };

    let assistantText = '';
    let cellCount = 0;
    let actedThisTurn = false;
    let doneCommittedThisTurn = false;
    let cutoffMarkerThisTurn = '';

    const turnSignal = createTurnSignal(signal, modelTimeoutMs);
    try {
      const systemPromptForTurn = await resolveSystemPrompt(systemPrompt);
      for await (const event of adapter.stream(messages, systemPromptForTurn, turnSignal.signal)) {
        switch (event.type) {
          case 'text':
            assistantText += event.content;
            // Feed compose controller for incremental block parsing. Cheap —
            // just appends to a buffer. Actual parsing happens at
            // assistant_message boundary below where we have the full text.
            composeController?.feedText(event.content);
            yield { type: 'text', content: event.content };
            break;
          case 'thinking':
            session?.log({ type: 'loop3_thinking', turn, chars: event.content.length, timestamp: Date.now() });
            yield { type: 'thinking', content: event.content };
            break;
          case 'usage':
            session?.log({
              type: 'usage',
              inputTokens: event.inputTokens,
              outputTokens: event.outputTokens,
              totalTokens: event.inputTokens + event.outputTokens,
              cacheReadTokens: event.cacheReadTokens,
              cacheWriteTokens: event.cacheWriteTokens,
              timestamp: Date.now(),
            });
            yield {
              type: 'usage',
              inputTokens: event.inputTokens,
              outputTokens: event.outputTokens,
              totalTokens: event.inputTokens + event.outputTokens,
              cacheReadTokens: event.cacheReadTokens,
              cacheWriteTokens: event.cacheWriteTokens,
            };
            break;
          case 'provider_event':
            session?.log({ type: 'provider_event', stage: event.stage as any, provider: adapter.providerName, model: event.model ?? '', reason: event.reason, message: event.message, elapsedMs: event.elapsedMs, timestamp: Date.now() });
            yield { type: 'provider_event', stage: event.stage, reason: event.reason, message: event.message };
            break;
          case 'cutoff_warning': {
            cutoffMarkerThisTurn =
              `\n\n[harness:cutoff reason="${event.reason}"] ${event.message}`;
            assistantText += cutoffMarkerThisTurn;
            session?.log({ type: 'cutoff_warning', reason: event.reason, message: event.message, timestamp: Date.now() } as any);
            yield { type: 'cutoff_warning', reason: event.reason, message: event.message };
            break;
          }
          case 'assistant_message':
            messages.push(withAssistantTextAppended(event.message, cutoffMarkerThisTurn));
            // Compose sub-loop: parse <compose_preflight> / <compose_update>
            // blocks out of the full assistant text BEFORE the action event
            // fires. Anthropic streams text content blocks before tool_use
            // blocks within one assistant message, so by the time we get
            // here assistantText contains everything we need to extract.
            if (composeController) {
              const parsed = composeController.parseAccumulatedText(assistantText);
              await syncComposeBlocksToScratch({
                composeController,
                replHandle,
                parsed,
                session,
                turn,
              });
              if (parsed.newPreflight || parsed.newUpdate) {
                session?.log({
                  type: 'loop3_compose_blocks',
                  turn,
                  request_id: composeController.requestId,
                  new_preflight: parsed.newPreflight,
                  new_update: parsed.newUpdate,
                  timestamp: Date.now(),
                });
              }
            }
            session?.log({
              type: 'loop3_assistant_text',
              turn,
              chars: assistantText.length,
              content_head: head(assistantText, 2000),
              content_tail: tail(assistantText, 2000),
              timestamp: Date.now(),
            });
            break;
          case 'action': {
            actedThisTurn = true;
            if (event.action.kind === 'final') {
              const preview = unknownPreview(event.action.value);
              session?.log({
                type: 'loop3_action_start',
                turn,
                tool_call_id: `loop3-final-${turn}`,
                action_kind: 'final',
                timestamp: Date.now(),
              });
              session?.log({
                type: 'loop3_done_committed',
                turn,
                value: event.action.value,
                value_type: preview.type,
                value_chars: preview.chars,
                value_head: preview.head,
                value_tail: preview.tail,
                timestamp: Date.now(),
              });
              session?.log({
                type: 'loop3_completion',
                turn,
                channel: 'done',
                assistant_chars: assistantText.length,
                cell_count: cellCount,
                elapsed_ms: Date.now() - turnStartedAt,
                active_elapsed_ms: activeElapsed(turnStartedAt, turnIdleMs),
                idle_ms: turnIdleMs,
                timestamp: Date.now(),
              });
              yield { type: 'done_committed', value: event.action.value };
              return;
            }

            const toolCall = actionToolCall(turn, event.action);
            session?.log({
              type: 'loop3_action_start',
              turn,
              tool_call_id: toolCall.id,
              action_kind: 'code',
              cell_id: event.action.id,
              code_chars: event.action.code.length,
              timeout_ms: event.action.timeoutMs,
              timestamp: Date.now(),
            });
            yield { type: 'action_start', turn, toolCall };

            // Compose sub-loop gate: in compose/goal mode, the model must
            // emit <compose_preflight> before each Repl and <compose_update>
            // between Repls. Gate fires BEFORE the permission prompt so the
            // user isn't prompted for a tool call we're about to reject.
            // The rejection envelope is structural data only — no corrective
            // prose (vault canon: dead-category rule).
            if (composeController && !composeController.isQuickMode) {
              // V2 (2026-05-08): pass cell code so the gate can pre-shape
              // inspect for commit/narration-only cells (done/say/ask/plan.*/
              // state.put/scratch.*) and exempt them. Fixes the 07 failure
              // pattern where a final done(answer) cell was rejected for
              // update_required and the model dropped to natural-text.
              const gate = composeController.gateRepl(event.action.code);
              if (!gate.allowed) {
                const gatedResult: ExecutionResult = {
                  stdout: '',
                  stderr: '',
                  exception: null,
                  rejectedReason: gate.reason!,
                  timedOut: false,
                  durationMs: 0,
                  sayTexts: [],
                };
                messages.push(adapter.buildResultMessage(event.ref, gatedResult));
                rewriteCompletedReplToolPairsInPlace(messages, session);
                session?.log({
                  type: 'loop3_compose_gate_rejected',
                  turn,
                  tool_call_id: toolCall.id,
                  request_id: composeController.requestId,
                  reason_code: gate.reasonCode,
                  reason: gate.reason ?? '',
                  timestamp: Date.now(),
                });
                yield { type: 'action_executed', turn, toolCall, result: gatedResult, doneCommitted: false };
                break;
              }
            }

            const permissionMode = params.permissionModeRef?.current ?? params.permissionMode ?? 'default';
            const permission = await approveAction({
              toolCall,
              permissionMode,
              alwaysAllowTools: params.alwaysAllowTools,
              onPermissionRequest: params.onPermissionRequest,
            });
            if (permission.promptShown) turnIdleMs += permission.elapsedMs;
            session?.log({
              type: 'loop3_permission',
              turn,
              tool_call_id: toolCall.id,
              mode: permissionMode,
              decision: permission.decision,
              prompt_shown: permission.promptShown,
              elapsed_ms: permission.elapsedMs,
              timestamp: Date.now(),
            });
            if (!permission.approved) {
              const deniedResult: ExecutionResult = {
                stdout: '',
                stderr: '',
                exception: 'Tool use denied by user.',
                rejectedReason: null,
                timedOut: false,
                durationMs: 0,
                sayTexts: [],
              };
              messages.push(adapter.buildResultMessage(event.ref, deniedResult));
              rewriteCompletedReplToolPairsInPlace(messages, session);
              session?.log({
                type: 'loop3_tool_result',
                turn,
                cell_count: cellCount,
                status: 'exception',
                duration_ms: 0,
                done_committed: false,
                timestamp: Date.now(),
              });
              yield { type: 'action_denied', turn, toolCall };
              yield { type: 'action_executed', turn, toolCall, result: deniedResult, doneCommitted: false };
              break;
            }

            session?.log({
              type: 'loop3_tool_use',
              turn,
              tool_call_id: toolCall.id,
              cell_id: event.action.id,
              code_chars: event.action.code.length,
              code_head: head(event.action.code, 1000),
              code_tail: tail(event.action.code, 500),
              code: event.action.code,
              timeout_ms: event.action.timeoutMs,
              timestamp: Date.now(),
            });

            let execResult: ExecutionResult;
            session?.log({
              type: 'loop3_execution_start',
              turn,
              tool_call_id: toolCall.id,
              cell_id: event.action.id,
              substrate_available: replHandle !== null,
              timestamp: Date.now(),
            });
            if (!replHandle) {
              execResult = {
                stdout: '',
                stderr: '',
                exception: 'execution substrate unavailable; cannot run code.',
                rejectedReason: null,
                timedOut: false,
                durationMs: 0,
                sayTexts: [],
              };
            } else {
              cellCount += 1;
              const replResult = await replHandle.exec({ code: event.action.code, timeout_ms: event.action.timeoutMs }, signal);
              if (replResult.shape) {
                session?.log({
                  type: 'loop3_repl_shape',
                  turn,
                  tool_call_id: toolCall.id,
                  cell_id: event.action.id,
                  stmt_count: replResult.shape.stmt_count,
                  line_count: replResult.shape.line_count,
                  char_count: replResult.shape.char_count,
                  distinct_primitive_count: replResult.shape.distinct_primitive_count,
                  total_primitive_call_count: replResult.shape.total_primitive_call_count,
                  has_for_or_while: replResult.shape.has_for_or_while,
                  has_if: replResult.shape.has_if,
                  has_def: replResult.shape.has_def,
                  has_try: replResult.shape.has_try,
                  has_comprehension: replResult.shape.has_comprehension,
                  is_micro_repl: replResult.shape.is_micro_repl,
                  is_composed: replResult.shape.is_composed,
                  composition_kind: replResult.shape.composition_kind,
                  primitives_called: replResult.shape.primitives_called,
                  costs: replResult.shape.costs,
                  effects: replResult.shape.effects,
                  expensive_primitives: replResult.shape.expensive_primitives,
                  parse_error: replResult.shape.error,
                  timestamp: Date.now(),
                });
              }
              if (replResult.runtime) {
                session?.log({
                  type: 'loop3_runtime_state',
                  turn,
                  tool_call_id: toolCall.id,
                  cell_id: event.action.id,
                  footer: replResult.runtime.footer,
                  state: replResult.runtime.state,
                  vars: replResult.runtime.vars,
                  plan: replResult.runtime.plan,
                  spanner: replResult.runtime.spanner,
                  timestamp: Date.now(),
                });
                for (const telemetry of replResult.runtime.telemetry ?? []) {
                  session?.log({
                    type: 'loop3_body_telemetry',
                    turn,
                    tool_call_id: toolCall.id,
                    cell_id: event.action.id,
                    event: telemetry,
                    timestamp: Date.now(),
                  });
                }
              }
              execResult = mapReplResultToExecution(replResult);
            }

            const status = statusOf(execResult);
            session?.log({
              type: 'loop3_cell_result',
              turn,
              tool_call_id: toolCall.id,
              cell_id: event.action.id,
              status,
              duration_ms: execResult.durationMs,
              stdout_chars: execResult.stdout.length,
              stderr_chars: execResult.stderr.length,
              say_count: execResult.sayTexts.length,
              done_value_type: execResult.doneValue !== undefined ? unknownType(execResult.doneValue) : undefined,
              done_value_chars: execResult.doneValue !== undefined ? unknownPreview(execResult.doneValue).chars : undefined,
              timestamp: Date.now(),
            });

            const resultMessage = adapter.buildResultMessage(event.ref, execResult);
            messages.push(resultMessage);
            const nativeOutput = userToolResults(resultMessage)?.map((block) => block.content).join('\n\n');
            rewriteCompletedReplToolPairsInPlace(messages, session);
            // Compose sub-loop: tell the controller this Repl actually ran.
            // Increments replCount, increments scoutCount if the preflight
            // declared cell_kind=scout, and flips needsUpdate=true so the
            // next Repl is gated until <compose_update> is parsed.
            // V2: pass exec status so a subsequent cell_kind=repair preflight
            // can bypass update_required (the repair IS the implicit update).
            composeController?.recordReplExecuted(status);
            const doneCommitted = execResult.doneValue !== undefined;
            doneCommittedThisTurn = doneCommitted;
            session?.log({
              type: 'loop3_tool_result',
              turn,
              tool_call_id: toolCall.id,
              cell_count: cellCount,
              status,
              duration_ms: execResult.durationMs,
              done_committed: doneCommitted,
              result_chars: resultCharCount(execResult),
              output: nativeOutput,
              timestamp: Date.now(),
            });
            yield { type: 'action_executed', turn, toolCall, result: execResult, doneCommitted };

            if (doneCommitted) {
              const preview = unknownPreview(execResult.doneValue);
              session?.log({
                type: 'loop3_done_committed',
                turn,
                value: execResult.doneValue,
                value_type: preview.type,
                value_chars: preview.chars,
                value_head: preview.head,
                value_tail: preview.tail,
                timestamp: Date.now(),
              });
              session?.log({
                type: 'loop3_completion',
                turn,
                channel: 'done',
                assistant_chars: assistantText.length,
                cell_count: cellCount,
                elapsed_ms: Date.now() - turnStartedAt,
                active_elapsed_ms: activeElapsed(turnStartedAt, turnIdleMs),
                idle_ms: turnIdleMs,
                timestamp: Date.now(),
              });
              yield { type: 'done_committed', value: execResult.doneValue };
            }
            break;
          }
          case 'done':
            break;
          case 'error':
            session?.log({ type: 'error', message: event.error instanceof Error ? event.error.message : String(event.error), timestamp: Date.now() });
            if (event.recoverable && actedThisTurn) {
              session?.log({
                type: 'loop3_stream_recovery',
                turn,
                recovered: true,
                acted_this_turn: actedThisTurn,
                error_name: event.error instanceof Error ? event.error.name : undefined,
                error_message: event.error instanceof Error ? event.error.message : String(event.error),
                timestamp: Date.now(),
              });
              break;
            }
            session?.log({
              type: 'loop3_completion',
              turn,
              channel: 'error',
              assistant_chars: assistantText.length,
              cell_count: cellCount,
              elapsed_ms: Date.now() - turnStartedAt,
              active_elapsed_ms: activeElapsed(turnStartedAt, turnIdleMs),
              idle_ms: turnIdleMs,
              timestamp: Date.now(),
            });
            yield { type: 'error', error: event.error };
            return;
        }
      }
    } catch (error) {
      const streamError = turnSignal.timedOut()
        ? new Error(`loop3 model stream timed out after ${modelTimeoutMs}ms`)
        : error;
      session?.log({
        type: 'loop3_assistant_text',
        turn,
        chars: assistantText.length,
        content_head: head(assistantText, 2000),
        content_tail: tail(assistantText, 2000),
        partial_on_error: true,
        timestamp: Date.now(),
      });
      session?.log({ type: 'error', message: streamError instanceof Error ? streamError.message : String(streamError), timestamp: Date.now() });
      session?.log({
        type: 'loop3_stream_recovery',
        turn,
        recovered: false,
        acted_this_turn: actedThisTurn,
        error_name: streamError instanceof Error ? streamError.name : undefined,
        error_message: streamError instanceof Error ? streamError.message : String(streamError),
        timestamp: Date.now(),
      });
      session?.log({
        type: 'loop3_completion',
        turn,
        channel: 'error',
        assistant_chars: assistantText.length,
        cell_count: cellCount,
        elapsed_ms: Date.now() - turnStartedAt,
        active_elapsed_ms: activeElapsed(turnStartedAt, turnIdleMs),
        idle_ms: turnIdleMs,
        timestamp: Date.now(),
      });
      yield { type: 'error', error: streamError };
      return;
    } finally {
      turnSignal.cleanup();
    }

    const tokenEstimate = estimateTokens ? estimateTokens(messages) : 0;
    const elapsedMs = Date.now() - turnStartedAt;
    session?.log({
      type: 'loop3_turn_complete',
      turn,
      cell_count: cellCount,
      done_committed: doneCommittedThisTurn,
      acted: actedThisTurn,
      assistant_chars: assistantText.length,
      elapsed_ms: elapsedMs,
      active_elapsed_ms: Math.max(0, elapsedMs - turnIdleMs),
      idle_ms: turnIdleMs,
      timestamp: Date.now(),
    });

    if (cutoffMarkerThisTurn && !doneCommittedThisTurn) {
      maxOutputRecoveryCount += 1;
      if (maxOutputRecoveryCount <= MAX_OUTPUT_RECOVERY_LIMIT) {
        messages.push({
          role: 'user',
          content: MAX_OUTPUT_RECOVERY_MESSAGE,
        });
        session?.log({
          type: 'max_output_recovery',
          attempt: maxOutputRecoveryCount,
          timestamp: Date.now(),
        });
        yield {
          type: 'max_output_recovery',
          attempt: maxOutputRecoveryCount,
          maxAttempts: MAX_OUTPUT_RECOVERY_LIMIT,
        };
        yield {
          type: 'turn_complete',
          turn,
          tokenEstimate: estimateTokens ? estimateTokens(messages) : tokenEstimate,
          cellCount,
        };
        continue;
      }
      session?.log({
        type: 'max_output_recovery_exhausted',
        attempts: maxOutputRecoveryCount,
        timestamp: Date.now(),
      });
    }

    yield { type: 'turn_complete', turn, tokenEstimate, cellCount };

    if (doneCommittedThisTurn || !actedThisTurn) {
      if (!doneCommittedThisTurn) {
        session?.log({
          type: 'loop3_completion',
          turn,
          channel: 'natural_text',
          assistant_chars: assistantText.length,
          cell_count: cellCount,
          elapsed_ms: elapsedMs,
          active_elapsed_ms: Math.max(0, elapsedMs - turnIdleMs),
          idle_ms: turnIdleMs,
          timestamp: Date.now(),
        });
      }
      return;
    }
  }

  const error = new Error(`loop3 max_turns_exceeded (${maxTurns})`);
  session?.log({
    type: 'loop3_completion',
    turn,
    channel: 'max_turns',
    assistant_chars: 0,
    cell_count: 0,
    elapsed_ms: 0,
    active_elapsed_ms: 0,
    idle_ms: 0,
    timestamp: Date.now(),
  });
  session?.log({ type: 'error', message: error.message, timestamp: Date.now() });
  yield { type: 'error', error };
}
