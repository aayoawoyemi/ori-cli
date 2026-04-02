import React, { useState, useCallback, useRef, useEffect } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { Messages, type DisplayMessage, type DisplayToolCall } from './messages.js';
import { PromptInput } from './input.js';
import { StatusBar } from './statusBar.js';
import { Spinner } from './spinner.js';
import { agentLoop, type LoopEvent } from '../loop.js';
import { ModelRouter } from '../router/index.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { OriVault } from '../memory/vault.js';
import type { ProjectBrain } from '../memory/projectBrain.js';
import type { SessionStorage } from '../session/storage.js';
import type { Message } from '../router/types.js';
import { syncSession } from '../session/sync.js';
import { runHooks } from '../hooks/runner.js';
import type { HooksConfig } from '../config/types.js';
import { runResearch } from '../research/index.js';
import type { ResearchDepth } from '../research/types.js';

interface AppProps {
  agentName: string;
  cwd: string;
  router: ModelRouter;
  registry: ToolRegistry;
  vault: OriVault | null;
  projectBrain: ProjectBrain | null;
  session: SessionStorage;
  systemPrompt: string;
  hooks: HooksConfig;
  vaultNoteCount?: number;
  initialPrompt?: string;
}

export function App(props: AppProps): React.ReactElement {
  const { exit } = useApp();
  const {
    agentName, cwd, router, registry, vault, projectBrain,
    session, systemPrompt, hooks, vaultNoteCount, initialPrompt,
  } = props;

  // ── State ───────────────────────────────────────────────────────────
  const [displayMessages, setDisplayMessages] = useState<DisplayMessage[]>([]);
  const [toolCalls, setToolCalls] = useState<DisplayToolCall[]>([]);
  const [streamingText, setStreamingText] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [tokenCount, setTokenCount] = useState(0);
  const [activeTool, setActiveTool] = useState<string | undefined>();

  // Conversation messages for the loop (mutable ref to avoid stale closures)
  const messagesRef = useRef<Message[]>([]);

  // Handle Ctrl+C
  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      runHooks('stop', hooks, { cwd, vaultPath: vault?.vaultPath })
        .then(() => syncSession(messagesRef.current, 0, projectBrain, vault, router))
        .finally(() => {
          vault?.disconnect();
          exit();
        });
    }
  });

  // Run sessionStart hooks + initial prompt
  useEffect(() => {
    (async () => {
      await runHooks('sessionStart', hooks, { cwd, vaultPath: vault?.vaultPath });
      if (initialPrompt) {
        handleSubmit(initialPrompt);
      }
    })();
  }, []);

  // ── Handle user input ───────────────────────────────────────────────
  const handleSubmit = useCallback(async (input: string) => {
    const trimmed = input.trim();
    if (!trimmed) return;

    // ── Slash commands ──────────────────────────────────────────────
    if (trimmed.startsWith('/')) {
      await handleSlashCommand(trimmed);
      return;
    }

    // ── Shell passthrough ───────────────────────────────────────────
    if (trimmed.startsWith('!')) {
      const { execSync } = await import('node:child_process');
      try {
        const output = execSync(trimmed.slice(1).trim(), { cwd, encoding: 'utf-8' });
        setDisplayMessages(prev => [
          ...prev,
          { role: 'user', text: trimmed },
          { role: 'assistant', text: '```\n' + output + '\n```' },
        ]);
      } catch (err) {
        setDisplayMessages(prev => [
          ...prev,
          { role: 'user', text: trimmed },
          { role: 'assistant', text: `Error: ${(err as Error).message}` },
        ]);
      }
      return;
    }

    // ── Normal message → agent loop ─────────────────────────────────
    setDisplayMessages(prev => [...prev, { role: 'user', text: trimmed }]);
    setIsLoading(true);
    setStreamingText('');
    setToolCalls([]);

    messagesRef.current.push({ role: 'user', content: trimmed });
    session.log({ type: 'user', content: trimmed, timestamp: Date.now() });

    let fullText = '';

    try {
      const loop = agentLoop({
        messages: messagesRef.current,
        systemPrompt,
        router,
        registry,
        toolContext: { cwd },
        vault,
        projectBrain,
        session,
        hooks,
      });

      for await (const event of loop) {
        handleLoopEvent(event, (text) => {
          fullText += text;
          setStreamingText(fullText);
        });
      }
    } catch (err) {
      fullText = `Error: ${(err as Error).message}`;
    }

    // Finalize: move streaming text to messages
    setStreamingText('');
    setToolCalls([]);
    setIsLoading(false);
    setActiveTool(undefined);

    if (fullText) {
      setDisplayMessages(prev => [...prev, { role: 'assistant', text: fullText }]);
    }
  }, [cwd, systemPrompt, router, registry, vault, projectBrain, session]);

  // ── Handle loop events ──────────────────────────────────────────────
  const handleLoopEvent = useCallback((event: LoopEvent, appendText: (text: string) => void) => {
    switch (event.type) {
      case 'text':
        appendText(event.content);
        break;

      case 'tool_call': {
        const tc = event.toolCall;
        const summary = getToolSummary(tc.name, tc.input);
        setToolCalls(prev => [...prev, {
          id: tc.id, name: tc.name, summary, resolved: false, isError: false,
        }]);
        setActiveTool(tc.name);
        break;
      }

      case 'tool_result':
        setToolCalls(prev => prev.map(tc =>
          tc.id === event.id
            ? { ...tc, resolved: true, isError: event.isError }
            : tc
        ));
        setActiveTool(undefined);
        break;

      case 'usage':
        setTokenCount(event.totalTokens);
        break;

      case 'compact':
        setDisplayMessages(prev => [...prev, {
          role: 'assistant',
          text: event.pruneOnly
            ? '*[Context compacted: pruned old tool outputs]*'
            : `*[Context compacted: ${event.savedCount} insights saved to memory]*`,
        }]);
        break;

      case 'error': {
        const msg = event.error instanceof Error ? event.error.message : String(event.error);
        appendText(`\n\nError: ${msg}`);
        break;
      }
    }
  }, []);

  // ── Slash commands ──────────────────────────────────────────────────
  const handleSlashCommand = useCallback(async (input: string) => {
    const [cmd, ...rest] = input.split(/\s+/);
    const arg = rest.join(' ');

    switch (cmd) {
      case '/exit':
      case '/quit':
        await runHooks('stop', hooks, { cwd, vaultPath: vault?.vaultPath });
        await syncSession(messagesRef.current, 0, projectBrain, vault, router);
        vault?.disconnect();
        exit();
        break;

      case '/clear':
        messagesRef.current.length = 0;
        setDisplayMessages([]);
        setTokenCount(0);
        break;

      case '/model':
        if (arg) {
          try {
            const result = router.setModel(arg);
            setDisplayMessages(prev => [...prev, {
              role: 'assistant', text: `Model: ${result.model} | Effort: ${result.effort}`,
            }]);
          } catch (err) {
            setDisplayMessages(prev => [...prev, {
              role: 'assistant', text: (err as Error).message,
            }]);
          }
        } else {
          const current = router.info;
          const available = ModelRouter.availableModels.join(', ');
          const slots = router.slots.map(s =>
            `  ${s.slot}: ${s.model}${s.slot === current.slot ? ' (active)' : ''}`
          ).join('\n');
          setDisplayMessages(prev => [...prev, {
            role: 'assistant',
            text: `**Current:** ${current.model} | effort: ${current.effort}\n\n**Slots:**\n${slots}\n\n**Available:** ${available}\n\n**Usage:** /model opus high, /model sonnet low, /model gemini`,
          }]);
        }
        break;

      case '/effort':
        if (arg && ['high', 'medium', 'low'].includes(arg)) {
          router.setEffort(arg as any);
          setDisplayMessages(prev => [...prev, {
            role: 'assistant', text: `Effort: ${arg}`,
          }]);
        } else {
          setDisplayMessages(prev => [...prev, {
            role: 'assistant', text: `**Effort:** ${router.effort}\n**Usage:** /effort high, /effort medium, /effort low`,
          }]);
        }
        break;

      case '/vault':
        setDisplayMessages(prev => [...prev, {
          role: 'assistant',
          text: vault?.connected
            ? `**Vault:** ${vault.vaultPath}\n**Notes:** ${vaultNoteCount ?? '?'}`
            : 'No vault connected.',
        }]);
        break;

      case '/brain':
        setDisplayMessages(prev => [...prev, {
          role: 'assistant',
          text: projectBrain && projectBrain.count > 0
            ? `**Project brain:** ${projectBrain.count} memories\n${projectBrain.all().slice(0, 10).map(m => `- ${m.title}`).join('\n')}`
            : 'Project brain: empty (memories accumulate from compaction).',
        }]);
        break;

      case '/cost':
        setDisplayMessages(prev => [...prev, {
          role: 'assistant',
          text: `**Tokens:** ${tokenCount} / ${router.current.contextWindow}`,
        }]);
        break;

      case '/tools':
        setDisplayMessages(prev => [...prev, {
          role: 'assistant',
          text: `**Tools (${registry.all().length}):**\n${registry.all().map(t => `- ${t.name} [${t.readOnly ? 'read' : 'write'}]`).join('\n')}`,
        }]);
        break;

      case '/research': {
        if (!arg) {
          setDisplayMessages(prev => [...prev, {
            role: 'assistant', text: 'Usage: `/research "query" --depth standard`',
          }]);
          break;
        }
        setIsLoading(true);
        let depth: ResearchDepth = 'standard';
        let query = arg;
        const depthMatch = arg.match(/--depth\s+(quick|standard|deep|exhaustive)/);
        if (depthMatch) {
          depth = depthMatch[1] as ResearchDepth;
          query = arg.replace(/--depth\s+\w+/, '').trim().replace(/^["']|["']$/g, '');
        }
        const fetchFn = async (url: string) => {
          const r = await fetch(`https://r.jina.ai/${url}`, {
            headers: { Accept: 'text/markdown' },
            signal: AbortSignal.timeout(15_000),
          });
          return r.ok ? await r.text() : '';
        };
        try {
          const report = await runResearch(query, depth, router, vault, fetchFn);
          setDisplayMessages(prev => [...prev, { role: 'assistant', text: report }]);
        } catch (err) {
          setDisplayMessages(prev => [...prev, {
            role: 'assistant', text: `Research failed: ${(err as Error).message}`,
          }]);
        }
        setIsLoading(false);
        break;
      }

      case '/help':
        setDisplayMessages(prev => [...prev, {
          role: 'assistant',
          text: `**Commands:**
- \`/model opus high\` — switch model + effort (opus, sonnet, haiku, gemini, flash)
- \`/effort high|medium|low\` — change effort level
- \`/cost\` — token usage
- \`/tools\` — list tools
- \`/vault\` — vault status
- \`/brain\` — project brain
- \`/research "query"\` — deep multi-source research
- \`/clear\` — clear conversation
- \`/exit\` — exit`,
        }]);
        break;

      default:
        setDisplayMessages(prev => [...prev, {
          role: 'assistant', text: `Unknown command: ${cmd}`,
        }]);
    }
  }, [vault, projectBrain, router, registry, tokenCount, vaultNoteCount]);

  // ── Render ──────────────────────────────────────────────────────────
  return (
    <Box flexDirection="column" height="100%">
      {/* Scrollable conversation area */}
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        <Messages
          messages={displayMessages}
          toolCalls={toolCalls}
          streamingText={streamingText}
          isStreaming={isLoading}
        />

        {/* Spinner */}
        <Spinner isLoading={isLoading} activeTool={activeTool} />
      </Box>

      {/* Pinned bottom: input + status */}
      <Box flexDirection="column" flexShrink={0}>
        <PromptInput
          onSubmit={handleSubmit}
          model={router.info.model}
          isLoading={isLoading}
        />
        <StatusBar
          model={router.info.model}
          effort={router.effort}
          tokenCount={tokenCount}
          contextWindow={router.current.contextWindow}
          vaultNotes={vaultNoteCount}
          isLoading={isLoading}
        />
      </Box>
    </Box>
  );
}

/** Extract a brief summary from tool input for display. */
function getToolSummary(name: string, input: Record<string, unknown>): string {
  if (input.command) return (input.command as string).slice(0, 80);
  if (input.file_path) return input.file_path as string;
  if (input.pattern) return input.pattern as string;
  if (input.query) return (input.query as string).slice(0, 60);
  if (input.url) return input.url as string;
  if (input.title) return (input.title as string).slice(0, 60);
  if (input.task) return (input.task as string).slice(0, 60);
  if (input.context) return (input.context as string).slice(0, 60);
  return '';
}
