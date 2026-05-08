import type { ContentBlock, Message, ToolDefinition, SystemPromptInput } from '../../router/types.js';
import type { ModelRouter } from '../../router/index.js';
import type { ActionAdapter, ActionEvent, ActionRef, CodeAction, ExecutionResult } from '../types.js';

const REPL_TOOL: ToolDefinition = {
  name: 'Repl',
  description: [
    'Execute Python in the persistent body REPL. Variables persist across calls as scratch.',
    '',
    'Available primitives in the namespace:',
    '  fs.read/write/edit/glob/grep/listdir/tree/context - file system',
    '  shell.run(cmd, timeout=, cwd=) - shell execution',
    '  web.fetch(url) / web.search(query) - web access',
    '  codebase.search(query) / .find_symbol(name) - code navigation',
    '  vault.top(query, n=) / .add(...) / .search(...) - memory',
    '  say(text) - synthesis output (also captured in result)',
    '  ask(question) - pause for input (interactive only)',
    '  done(value) - commit final answer; ends the agent turn',
    '  plan.create/read/append_layer/enter_phase/exit_phase/status - goal plans',
    '  spanner.escalate(reason, layers=) / .status() - model-driven tier escalation',
    '  state.put/get/has/list/delete/receipts - durable session handoff for planned phases',
    '  api.stub() / api.describe(name) - discover live primitive surface',
    '',
    'Imports are forbidden by the sandbox. Use preloaded modules directly:',
    '  json, os.path, re, collections, itertools, math, datetime, random, statistics',
    '',
    'Compose multi-step programs in one call. Use Python variables for local scratch; use state.put(...) and state.get(...) for cross-phase handoff. For planned work, declare produces_state and call state.put before plan.exit_phase.',
  ].join('\n'),
  input_schema: {
    type: 'object',
    properties: {
      code: {
        type: 'string',
        description: 'Python source. Multi-line composed program preferred over many small calls.',
      },
      timeout_ms: {
        type: 'number',
        description: 'Optional cell timeout in ms. Defaults to body default (30s).',
      },
      id: {
        type: 'string',
        description: 'Optional human-readable cell tag for trajectory logging.',
      },
    },
    required: ['code'],
  },
};

interface AnthropicActionRef {
  toolUseId: string;
  toolName: string;
}

export class AnthropicToolUseAdapter implements ActionAdapter {
  readonly providerName = 'anthropic-tool-use';

  constructor(private router: ModelRouter) {}

  async *stream(messages: Message[], systemPrompt: SystemPromptInput, signal?: AbortSignal): AsyncGenerator<ActionEvent> {
    let assistantText = '';
    const partialToolUses = new Map<string, { name: string; input: Record<string, unknown> | null; inputJson: string }>();
    const completedToolUses: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];

    const emitRecovered = function* (self: AnthropicToolUseAdapter, error?: unknown): Generator<ActionEvent> {
      yield { type: 'assistant_message', message: self.buildAssistantMessage(assistantText, completedToolUses) };
      if (completedToolUses.length === 0) {
        if (error) yield { type: 'error', error };
        return;
      }
      for (const toolUse of completedToolUses) {
        if (toolUse.name !== REPL_TOOL.name) {
          yield { type: 'error', error: new Error(`unexpected tool call: ${toolUse.name}`) };
          return;
        }
        const action = self.parseAction(toolUse.input);
        if (!action) {
          yield { type: 'error', error: new Error(`tool_use input missing required code: ${JSON.stringify(toolUse.input)}`) };
          return;
        }
        yield {
          type: 'action',
          action,
          ref: { toolUseId: toolUse.id, toolName: toolUse.name } satisfies AnthropicActionRef,
        };
      }
      if (error) yield { type: 'error', error, recoverable: true };
    };

    try {
    for await (const event of this.router.stream(messages, systemPrompt, [REPL_TOOL], signal)) {
      switch (event.type) {
        case 'text':
          assistantText += event.content;
          yield { type: 'text', content: event.content };
          break;
        case 'thinking':
          yield { type: 'thinking', content: event.content };
          break;
        case 'usage':
          yield {
            type: 'usage',
            inputTokens: event.inputTokens,
            outputTokens: event.outputTokens,
            cacheReadTokens: event.cacheReadTokens,
            cacheWriteTokens: event.cacheWriteTokens,
          };
          break;
        case 'provider_event':
          yield {
            type: 'provider_event',
            stage: event.stage,
            reason: event.reason,
            message: event.message,
            elapsedMs: event.elapsedMs,
            model: this.router.info.model,
          };
          break;
        case 'cutoff_warning':
          yield { type: 'cutoff_warning', reason: event.reason, message: event.message };
          break;
        case 'tool_use_start':
          partialToolUses.set(event.id, { name: event.name, input: null, inputJson: '' });
          break;
        case 'tool_use_delta': {
          const partial = partialToolUses.get(event.id);
          if (partial) partial.inputJson += event.delta;
          break;
        }
        case 'tool_use_end': {
          const partial = partialToolUses.get(event.id);
          if (partial) {
            completedToolUses.push({ id: event.id, name: partial.name, input: event.input });
            partialToolUses.delete(event.id);
          }
          break;
        }
        case 'done': {
          yield* emitRecovered(this);
          yield { type: 'done' };
          return;
        }
      }
    }
    } catch (error) {
      for (const [id, partial] of partialToolUses) {
        if (partial.input || partial.inputJson.trim().length === 0) continue;
        try {
          const input = JSON.parse(partial.inputJson) as Record<string, unknown>;
          completedToolUses.push({ id, name: partial.name, input });
        } catch {
          // A syntactically incomplete tool input is not recoverable.
        }
      }
      yield* emitRecovered(this, error);
    }
  }

  buildResultMessage(ref: ActionRef, result: ExecutionResult): Message {
    const r = ref as AnthropicActionRef;
    return {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: r.toolUseId,
        content: this.formatResult(result),
        is_error: result.exception !== null || result.rejectedReason !== null || result.timedOut,
      }],
    };
  }

  private buildAssistantMessage(text: string, toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }>): Message {
    const blocks: ContentBlock[] = [];
    if (text.trim().length > 0) blocks.push({ type: 'text', text });
    for (const toolUse of toolUses) {
      blocks.push({ type: 'tool_use', id: toolUse.id, name: toolUse.name, input: toolUse.input });
    }
    return { role: 'assistant', content: blocks };
  }

  private parseAction(input: Record<string, unknown>): CodeAction | null {
    if (typeof input.code !== 'string' || input.code.trim().length === 0) return null;
    return {
      kind: 'code',
      code: input.code,
      timeoutMs: typeof input.timeout_ms === 'number' ? input.timeout_ms : undefined,
      id: typeof input.id === 'string' ? input.id : undefined,
    };
  }

  private formatResult(result: ExecutionResult): string {
    const parts: string[] = [];
    const stdout = this.stdoutWithoutSayEcho(result);
    if (stdout.trim()) parts.push(`stdout: ${stdout.trim()}`);
    for (const say of result.sayTexts) parts.push(`say: ${say}`);
    if (result.stderr.trim()) parts.push(`stderr: ${result.stderr.trim()}`);
    if (result.exception) parts.push(`exception: ${result.exception}`);
    if (result.rejectedReason) parts.push(`rejected: ${result.rejectedReason}`);
    if (result.timedOut) parts.push('timeout');
    if (result.doneValue !== undefined) {
      const doneStr = typeof result.doneValue === 'string' ? result.doneValue : JSON.stringify(result.doneValue);
      parts.push(`done: ${doneStr}`);
    }
    if (typeof result.runtime?.footer === 'string' && result.runtime.footer.trim()) {
      parts.push(result.runtime.footer.trim());
    }
    parts.push(`duration_ms: ${result.durationMs}`);
    return parts.length > 0 ? parts.join('\n') : 'ok';
  }

  private stdoutWithoutSayEcho(result: ExecutionResult): string {
    let stdout = result.stdout.trim();
    for (const say of result.sayTexts) {
      if (stdout === say.trim()) return '';
      if (stdout.startsWith(`${say.trim()}\n`)) stdout = stdout.slice(say.trim().length).trimStart();
      if (stdout.endsWith(`\n${say.trim()}`)) stdout = stdout.slice(0, -say.trim().length).trimEnd();
    }
    return stdout;
  }
}
