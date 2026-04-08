import React, { useState, useCallback, useRef, useEffect } from 'react';
import { Box, Text, useApp, useInput, Static } from 'ink';
import { Messages, type DisplayMessage, type DisplayToolCall, type StreamSegment } from './messages.js';
import { PromptInput, type AttachedImage } from './input.js';
import { StatusBar } from './statusBar.js';
import { Spinner } from './spinner.js';
import { ModelPicker } from './modelPicker.js';
import { agentLoop, type LoopEvent, type PermissionMode, type PermissionDecision } from '../loop.js';
import { PermissionDialog } from './permissionDialog.js';
import { PlanApprovalDialog, type PlanAcceptMode } from './planApprovalDialog.js';
import { setTitleBusy, setTitleDone, setTitleIdle, flashTaskbar } from './terminal.js';
import { registerPlanTools } from '../tools/registry.js';
import type { PlanApprovalResult } from '../tools/planTypes.js';
import { readFileSync } from 'node:fs';
import { ResumePicker } from './resumePicker.js';
import { figures, colors } from './theme.js';
import { UsageTracker, formatTokenCount, formatCost, formatDuration } from '../telemetry/tracker.js';
import { ModelRouter, type EffortLevel } from '../router/index.js';
import type { ToolCall } from '../router/types.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { OriVault } from '../memory/vault.js';
import type { ProjectBrain } from '../memory/projectBrain.js';
import type { SessionStorage } from '../session/storage.js';
import type { Message } from '../router/types.js';
import { syncSession } from '../session/sync.js';
import { runHooks } from '../hooks/runner.js';
import type { HooksConfig, DisplayMode } from '../config/types.js';
import { runResearch } from '../research/index.js';
import type { ResearchDepth } from '../research/types.js';
import type { ReplHandle } from '../repl/setup.js';

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
  initialPermissionMode?: PermissionMode;
  replHandle?: ReplHandle | null;
  preflightEnabled?: boolean;
  resumedMessages?: Message[] | null;
  initialResumePicker?: boolean;
}

export function App(props: AppProps): React.ReactElement {
  const { exit } = useApp();
  const {
    agentName, cwd, router, registry, vault, projectBrain,
    session, systemPrompt, hooks, vaultNoteCount, initialPrompt,
    initialPermissionMode, replHandle, preflightEnabled = true,
    resumedMessages: initialResumedMessages, initialResumePicker,
  } = props;

  // ── State ───────────────────────────────────────────────────────────
  const [displayMessages, setDisplayMessages] = useState<DisplayMessage[]>([]);
  const [streamSegments, setStreamSegments] = useState<StreamSegment[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [tokenCount, setTokenCount] = useState(0);
  const [activeTool, setActiveTool] = useState<string | undefined>();
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(initialPermissionMode ?? 'default');
  const [showPlanApproval, setShowPlanApproval] = useState(false);
  const [planApprovalData, setPlanApprovalData] = useState<{ path: string; content: string } | null>(null);
  const planFilePathRef = useRef<string | null>(null);
  const prePlanModeRef = useRef<PermissionMode>('default');
  const planApprovalResolveRef = useRef<((r: PlanApprovalResult) => void) | null>(null);
  const [exitWarningAt, setExitWarningAt] = useState<number | null>(null);
  const [displayMode, setDisplayMode] = useState<DisplayMode>('normal');
  const [pendingPermission, setPendingPermission] = useState<{
    toolCall: ToolCall;
    resolve: (decision: PermissionDecision) => void;
  } | null>(null);
  const [showResumePicker, setShowResumePicker] = useState(initialResumePicker ?? false);
  const [sessionTitle, setSessionTitle] = useState<string | null>(null);
  const [pasteStatus, setPasteStatus] = useState<string | null>(null);
  const pasteStatusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Conversation messages for the loop (mutable ref to avoid stale closures)
  const messagesRef = useRef<Message[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const alwaysAllowRef = useRef(new Set<string>());
  const trackerRef = useRef(new UsageTracker(session.sessionId, router.current.model));
  const toolTimingRef = useRef(new Map<string, number>());
  const turnCountRef = useRef(0);

  // Token buffer: accumulate text, flush to state at 30fps for smooth rendering
  const textBufferRef = useRef('');
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const segmentsRef = useRef<StreamSegment[]>([]);

  const flushTextBuffer = useCallback(() => {
    flushTimerRef.current = null;
    if (!textBufferRef.current) return;
    const buffered = textBufferRef.current;
    textBufferRef.current = '';
    // Append to last text segment, or create a new one
    setStreamSegments(prev => {
      const segs = [...prev];
      const last = segs[segs.length - 1];
      if (last && last.type === 'text') {
        segs[segs.length - 1] = { type: 'text', content: last.content + buffered };
      } else {
        segs.push({ type: 'text', content: buffered });
      }
      segmentsRef.current = segs;
      return segs;
    });
  }, []);

  const bufferText = useCallback((text: string) => {
    textBufferRef.current += text;
    if (!flushTimerRef.current) {
      flushTimerRef.current = setTimeout(flushTextBuffer, 16);
    }
  }, [flushTextBuffer]);

  // ── Load resumed messages on mount ──────────────────────────────────
  useEffect(() => {
    if (initialResumedMessages && initialResumedMessages.length > 0) {
      messagesRef.current = initialResumedMessages;
      turnCountRef.current = initialResumedMessages.filter(m => m.role === 'user').length;
      setDisplayMessages([{
        role: 'system',
        text: `Session resumed (${initialResumedMessages.length} messages)`,
        subtype: 'info',
      }]);
    }
  }, []);

  // ── Keyboard shortcuts ──────────────────────────────────────────────
  useInput((input, key) => {
    // Ctrl+C → exit
    if (key.ctrl && input === 'c') {
      // If loading, first Ctrl+C interrupts; second exits
      if (isLoading && abortRef.current) {
        abortRef.current.abort();
        return;
      }
      // Not loading — double Ctrl+C to exit
      if (exitWarningAt && Date.now() - exitWarningAt < 2000) {
        // Second press within 2s — actually exit
        runHooks('stop', hooks, { cwd, vaultPath: vault?.vaultPath })
          .then(() => syncSession(messagesRef.current, 0, projectBrain, vault, router))
          .finally(() => {
            vault?.disconnect();
            exit();
          });
        return;
      }
      // First press — show warning
      setExitWarningAt(Date.now());
      return;
    }

    // Esc → interrupt streaming / close model picker
    if (key.escape) {
      if (showModelPicker) {
        setShowModelPicker(false);
        return;
      }
      if (isLoading && abortRef.current) {
        abortRef.current.abort();
        return;
      }
    }

    // Alt+P → toggle model picker (like Claude Code's meta+p)
    if (key.meta && input === 'p') {
      if (!isLoading) {
        setShowModelPicker(prev => !prev);
      }
      return;
    }

    // Alt+M (meta+m) or Shift+Tab → cycle permission mode
    if ((key.meta && input === 'm') || (key.shift && key.tab)) {
      if (!isLoading) {
        // If in plan mode, Alt+M keeps planning (use /plan off or ExitPlanMode to exit)
        if (permissionMode === 'plan') {
          setDisplayMessages(p => [...p, { role: 'system', text: `${figures.planMode} Already in plan mode. Use /plan off or let the model call ExitPlanMode.`, subtype: 'info' }]);
          return;
        }
        setPermissionMode(prev => {
          const modes: PermissionMode[] = ['default', 'accept', 'plan', 'research', 'yolo'];
          const idx = modes.indexOf(prev);
          const next = modes[(idx + 1) % modes.length]!;

          // Entering plan mode → register plan tools + inject directive
          if (next === 'plan') {
            prePlanModeRef.current = prev;
            planFilePathRef.current = null;
            registerPlanTools(registry, {
              cwd,
              onEnter: (path) => { planFilePathRef.current = path; },
              onExit: (path, content) => new Promise<PlanApprovalResult>(resolve => {
                setPlanApprovalData({ path, content });
                setShowPlanApproval(true);
                planApprovalResolveRef.current = resolve;
              }),
            });
            setDisplayMessages(p => [...p, { role: 'system', text: `${figures.planMode} Plan mode — model will call EnterPlanMode to begin. Alt+M to cycle.`, subtype: 'info' }]);
            messagesRef.current.push({ role: 'user', content: 'You are now in plan mode. Call EnterPlanMode to begin.' });
          }

          // Entering research mode → inject research directive
          if (next === 'research') {
            const directive = '[RESEARCH MODE] You are in research mode. Explore broadly, follow dependencies, surface patterns, build a mental model. Do not write or modify files. Report findings concisely.';
            setDisplayMessages(p => [...p, { role: 'system', text: `${figures.researchMode} Research mode — reads only. Alt+M to cycle.`, subtype: 'info' }]);
            messagesRef.current.push({ role: 'user', content: directive });
          }

          return next;
        });
      }
      return;
    }
  });

  useEffect(() => {
    if (exitWarningAt === null) return;
    const timer = setTimeout(() => setExitWarningAt(null), 2000);
    return () => clearTimeout(timer);
  }, [exitWarningAt]);

  // Run sessionStart hooks + initial prompt
  useEffect(() => {
    (async () => {
      await runHooks('sessionStart', hooks, { cwd, vaultPath: vault?.vaultPath });
      if (initialPrompt) {
        handleSubmit(initialPrompt);
      }
    })();
  }, []);

  // ── Model picker handlers ──────────────────────────────────────────
  const handleModelSelect = useCallback((model: string, effort: EffortLevel) => {
    try {
      router.setModel(`${model} ${effort}`);
      setShowModelPicker(false);
      setDisplayMessages(prev => [...prev, {
        role: 'assistant',
        text: `Model: ${router.info.model} | Effort: ${router.effort}`,
      }]);
    } catch (err) {
      setDisplayMessages(prev => [...prev, {
        role: 'assistant', text: (err as Error).message,
      }]);
      setShowModelPicker(false);
    }
  }, [router]);

  const handleModelCancel = useCallback(() => {
    setShowModelPicker(false);
  }, []);

  // ── Plan approval handler ──────────────────────────────────────────
  const handlePlanApproval = useCallback((mode: PlanAcceptMode) => {
    setShowPlanApproval(false);
    const result: PlanApprovalResult = { action: 'accepted', mode };
    planApprovalResolveRef.current?.(result);
    planApprovalResolveRef.current = null;

    if (mode === 'clear_context' && planFilePathRef.current) {
      try {
        const plan = readFileSync(planFilePathRef.current, 'utf-8');
        messagesRef.current = [{ role: 'user', content: `Implement this plan:\n\n${plan}` }];
        setDisplayMessages([{ role: 'system', text: 'Context cleared. Plan injected as first message.', subtype: 'info' }]);
      } catch { /* file read error — fall through */ }
    }

    const nextMode = mode === 'accept_edits' ? 'accept' as PermissionMode : prePlanModeRef.current;
    setPermissionMode(nextMode);
    registry.unregister('EnterPlanMode');
    registry.unregister('ExitPlanMode');
    planFilePathRef.current = null;
    setDisplayMessages(prev => [...prev, {
      role: 'system',
      text: `${figures.autoMode} Plan approved — now in ${nextMode} mode. Plan saved at .aries/plans/.`,
      subtype: 'info',
    }]);
  }, [registry]);

  const handlePlanReject = useCallback((feedback: string) => {
    setShowPlanApproval(false);
    const result: PlanApprovalResult = { action: 'rejected', feedback };
    planApprovalResolveRef.current?.(result);
    planApprovalResolveRef.current = null;
    // ExitPlanMode tool returns the feedback — model stays in plan mode and refines
  }, []);

  const handlePlanApprovalCancel = useCallback(() => {
    setShowPlanApproval(false);
    // Resolve as rejected with empty feedback — keeps model in plan mode
    const result: PlanApprovalResult = { action: 'rejected', feedback: 'User cancelled — keep planning.' };
    planApprovalResolveRef.current?.(result);
    planApprovalResolveRef.current = null;
  }, []);

  // ── Handle user input ───────────────────────────────────────────────
  const handleSubmit = useCallback(async (input: string, images?: AttachedImage[]) => {
    const trimmed = input.trim();
    if (!trimmed && !images?.length) return;

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

    // ── Build content: text + image blocks ──────────────────────────
    const hasImages = images && images.length > 0;
    const contentBlocks = hasImages
      ? [
          ...(trimmed ? [{ type: 'text' as const, text: trimmed }] : []),
          ...images!.map(img => ({
            type: 'image' as const,
            source: {
              type: 'base64' as const,
              media_type: img.mediaType,
              data: img.base64,
            },
          })),
        ]
      : trimmed;

    const displayText = hasImages
      ? trimmed || `[${images!.length} image${images!.length > 1 ? 's' : ''} attached]`
      : trimmed;

    // ── Normal message → agent loop ─────────────────────────────────
    setDisplayMessages(prev => [...prev, { role: 'user', text: displayText }]);
    setIsLoading(true);
    setTitleBusy(agentName, cwd);
    setStreamSegments([]);
    segmentsRef.current = [];
    textBufferRef.current = '';
    if (flushTimerRef.current) { clearTimeout(flushTimerRef.current); flushTimerRef.current = null; }

    // In cerebral mode, prepend a hard execution constraint to every user turn
    let finalContent: typeof contentBlocks;
    if (displayMode === 'cerebral') {
      const prefix = '[CEREBRAL MODE] Execute directly. Zero narration. No "let me", no "I will", no explaining what you\'re about to do. Tool calls only until you have a final result. One sentence max at the end.\n\n';
      if (typeof contentBlocks === 'string') {
        finalContent = prefix + contentBlocks;
      } else {
        const [first, ...rest] = contentBlocks;
        const firstText = first && 'text' in first ? first.text : '';
        finalContent = [{ type: 'text' as const, text: prefix + firstText }, ...rest];
      }
    } else {
      finalContent = contentBlocks;
    }
    messagesRef.current.push({ role: 'user', content: finalContent });
    session.log({ type: 'user', content: displayText, timestamp: Date.now() });

    let fullText = '';
    let displayText2 = '';  // what the user sees (may differ from fullText in quiet mode)
    let hasSeenToolCall = false;
    let interrupted = false;

    // Create abort controller for this request
    const abort = new AbortController();
    abortRef.current = abort;

    try {
      // Build identity context for conditioned retrieval
      const identityCtx = [
        agentName,
        cwd.split(/[\\/]/).pop() ?? '', // project dir name
      ].filter(Boolean).join(', ');

      const loop = agentLoop({
        messages: messagesRef.current,
        systemPrompt,
        router,
        registry,
        toolContext: { cwd, signal: abort.signal },
        vault,
        projectBrain,
        session,
        hooks,
        signal: abort.signal,
        permissionMode,
        alwaysAllowTools: alwaysAllowRef.current,
        identityContext: identityCtx,
        maxSubagents: 5,
        preflightEnabled,
        dynamicTools: true,
        planFilePath: planFilePathRef.current ?? undefined,
        onPermissionRequest: (tc: ToolCall) => {
          return new Promise<PermissionDecision>((resolve) => {
            setPendingPermission({ toolCall: tc, resolve });
          });
        },
      });

      for await (const event of loop) {
        if (abort.signal.aborted) {
          interrupted = true;
          break;
        }
        handleLoopEvent(event, (text) => {
          fullText += text;
          if (displayMode === 'quiet') {
            if (event.type === 'text') {
              displayText2 += text;
            }
          } else {
            displayText2 += text;
            bufferText(text);
          }
        });
        if (event.type === 'tool_call') {
          hasSeenToolCall = true;
          if (displayMode === 'quiet') {
            displayText2 = '';
          }
        }
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError' || abort.signal.aborted) {
        interrupted = true;
      } else {
        fullText += `\n\nError: ${(err as Error).message}`;
      }
    }

    abortRef.current = null;

    // Finalize: flush any remaining buffered text, then clear stream
    if (flushTimerRef.current) { clearTimeout(flushTimerRef.current); flushTimerRef.current = null; }
    textBufferRef.current = '';
    // Capture segments before clearing — used to preserve tool calls in display history
    const completedSegments = segmentsRef.current.slice();
    setStreamSegments([]);
    segmentsRef.current = [];
    setIsLoading(false);
    setTitleDone(agentName, cwd);
    flashTaskbar();
    setActiveTool(undefined);

    // Track turns and update session metadata
    turnCountRef.current++;
    const userMsgCount = messagesRef.current.filter(m => m.role === 'user').length;
    const totals = trackerRef.current.totals;
    session.touch(userMsgCount, totals.cost);

      if (fullText) {
      // In quiet mode, only show the final text block (after last tool call)
      const shownText = displayMode === 'quiet' ? displayText2.trim() : fullText;
      // Preserve segments (tool calls + text) if the turn had tool calls, so they persist in history
      const hasToolCalls = completedSegments.some(s => s.type === 'tool');
      setDisplayMessages(prev => [
        ...prev,
        ...(shownText ? [{
          role: 'assistant' as const,
          text: shownText,
          ...(hasToolCalls ? { segments: completedSegments } : {}),
        }] : []),
        ...(interrupted ? [{ role: 'system' as const, text: 'Interrupted', subtype: 'info' as const }] : []),
      ]);

      // Auto-title: generate on first completed turn
      if (turnCountRef.current === 1 && !sessionTitle) {
        const userMsg = messagesRef.current.find(m => m.role === 'user');
        const userText = typeof userMsg?.content === 'string' ? userMsg.content : '';
        if (userText) {
          import('../session/title.js').then(({ generateSessionTitle }) => {
            generateSessionTitle(userText, fullText, router, session).then(title => {
              setSessionTitle(title);
            }).catch(() => {});
          }).catch(() => {});
        }
      }
    } else if (interrupted) {
      setDisplayMessages(prev => [...prev, { role: 'system', text: 'Interrupted', subtype: 'info' }]);
    }
  }, [cwd, systemPrompt, router, registry, vault, projectBrain, session]);

  // ── Handle loop events ──────────────────────────────────────────────
  const handleLoopEvent = useCallback((event: LoopEvent, appendText: (text: string) => void) => {
    switch (event.type) {
      case 'text':
        appendText(event.content);
        break;

      case 'tool_call': {
        // Flush any buffered text so it appears BEFORE the tool in the timeline
        if (flushTimerRef.current) { clearTimeout(flushTimerRef.current); flushTimerRef.current = null; }
        if (textBufferRef.current) {
          const buffered = textBufferRef.current;
          textBufferRef.current = '';
          setStreamSegments(prev => {
            const segs = [...prev];
            const last = segs[segs.length - 1];
            if (last && last.type === 'text') {
              segs[segs.length - 1] = { type: 'text', content: last.content + buffered };
            } else {
              segs.push({ type: 'text', content: buffered });
            }
            return segs;
          });
        }
        const tc = event.toolCall;
        const summary = getToolSummary(tc.name, tc.input);
        const displayName = getToolDisplayName(tc.name, tc.input);
        toolTimingRef.current.set(tc.id, Date.now());
        const toolData: DisplayToolCall = {
          id: tc.id, name: displayName, summary, resolved: false, isError: false,
        };
        setStreamSegments(prev => [...prev, { type: 'tool', data: toolData }]);
        setActiveTool(tc.name);
        break;
      }

      case 'tool_result': {
        const preview = formatToolResult(event.name, event.output, event.isError);
        const startTime = toolTimingRef.current.get(event.id);
        const durationMs = startTime ? Date.now() - startTime : undefined;
        toolTimingRef.current.delete(event.id);
        setStreamSegments(prev => prev.map(seg =>
          seg.type === 'tool' && seg.data.id === event.id
            ? { ...seg, data: { ...seg.data, resolved: true, isError: event.isError, resultPreview: preview, durationMs } }
            : seg
        ));
        setActiveTool(undefined);
        break;
      }

      case 'usage':
        setTokenCount(event.totalTokens);
        trackerRef.current.recordTurn(
          router.current.model,
          router.current.name,
          event.inputTokens,
          event.outputTokens,
          event.cacheReadTokens ?? 0,
          event.cacheWriteTokens ?? 0,
        );
        break;

      case 'tool_denied':
        setStreamSegments(prev => prev.map(seg =>
          seg.type === 'tool' && seg.data.id === event.id
            ? { ...seg, data: { ...seg.data, resolved: true, isError: true, resultPreview: 'Denied by user' } }
            : seg
        ));
        setActiveTool(undefined);
        break;

      case 'plan_step':
        setStreamSegments(prev => [...prev, {
          type: 'tool',
          data: {
            id: event.toolCall.id,
            name: getToolDisplayName(event.toolCall.name, event.toolCall.input),
            summary: getToolSummary(event.toolCall.name, event.toolCall.input),
            resolved: false,
            isError: false,
            resultPreview: '(plan — not executed)',
          },
        }]);
        break;

      case 'plan_complete':
        setDisplayMessages(prev => [...prev, {
          role: 'system',
          text: `Plan complete: ${event.steps.length} steps proposed. Enter to execute, or refine.`,
          subtype: 'info',
        }]);
        break;

      case 'echo_fizzle':
        // Show dim indicator of what the engine learned
        if (event.echoed.length > 0) {
          setDisplayMessages(prev => [...prev, {
            role: 'system',
            text: `Memory: ${event.echoed.length} note${event.echoed.length > 1 ? 's' : ''} used → boosted`,
            subtype: 'info',
          }]);
        }
        break;

      case 'compact':
        setDisplayMessages(prev => [...prev, {
          role: 'system',
          text: event.pruneOnly
            ? 'Conversation compacted (pruned old tool outputs)'
            : `Conversation compacted (${event.savedCount} insights saved to memory)`,
          subtype: 'compact',
        }]);
        break;

      case 'error': {
        const msg = event.error instanceof Error ? event.error.message : String(event.error);
        appendText(`\n\nError: ${msg}`);
        break;
      }
    }
  }, []);

  // ── Session resume helper ──────────────────────────────────────────
  const loadSession = useCallback(async (sessionId: string, label: string) => {
    const sessionPath = session.getSessionPath(sessionId);
    const { resumeFromSession } = await import('../session/resume.js');
    const { messages: resumed } = resumeFromSession(sessionPath);
    if (resumed.length === 0) {
      setDisplayMessages(prev => [...prev, {
        role: 'assistant', text: 'Session was empty or could not be loaded.',
      }]);
      return;
    }
    messagesRef.current = resumed;
    turnCountRef.current = resumed.filter(m => m.role === 'user').length;
    setSessionTitle(label);
    setStreamSegments([]);
    segmentsRef.current = [];
    setDisplayMessages([{
      role: 'system',
      text: `Resumed: ${label} (${resumed.length} messages)`,
      subtype: 'info',
    }]);
  }, [session]);

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

      case '/model': {
        if (!arg) {
          // No args → open interactive model picker
          setShowModelPicker(true);
          break;
        }

        const parts = arg.trim().split(/\s+/);
        const SLOTS = ['primary', 'reasoning', 'cheap', 'bulk'];

        // Check if first arg is a slot name: /model cheap deepseek
        if (SLOTS.includes(parts[0]) && parts.length >= 2) {
          const slot = parts[0];
          const modelArg = parts.slice(1).join(' ');
          try {
            router.assignSlot(slot as any, modelArg);
            const slotProvider = router.getProvider(slot as any);
            setDisplayMessages(prev => [...prev, {
              role: 'assistant',
              text: `**${slot}** slot → ${slotProvider?.model ?? modelArg}`,
            }]);
          } catch (err) {
            setDisplayMessages(prev => [...prev, {
              role: 'assistant', text: (err as Error).message,
            }]);
          }
        } else {
          // Direct model switch: /model opus high
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
        }
        break;
      }

      case '/effort':
        if (arg && ['high', 'medium', 'low'].includes(arg)) {
          router.setEffort(arg as EffortLevel);
          setDisplayMessages(prev => [...prev, {
            role: 'assistant', text: `Effort: ${arg}`,
          }]);
        } else {
          setDisplayMessages(prev => [...prev, {
            role: 'assistant', text: `**Effort:** ${router.effort}\n**Usage:** /effort high, /effort medium, /effort low`,
          }]);
        }
        break;

      case '/mode': {
        const MODES: PermissionMode[] = ['default', 'accept', 'plan', 'research', 'yolo'];
        const MODE_DESC: Record<PermissionMode, string> = {
          default: 'Prompt for write tools',
          accept: 'Auto-approve edits, prompt for Bash',
          plan: 'Read-only planning with spec pass',
          research: 'Read-only exploration mode',
          yolo: 'Auto-approve everything',
        };
        if (arg && MODES.includes(arg as PermissionMode)) {
          setPermissionMode(arg as PermissionMode);
          setDisplayMessages(prev => [...prev, {
            role: 'system', text: `Mode: ${arg} — ${MODE_DESC[arg as PermissionMode]}`, subtype: 'info',
          }]);
        } else {
          const modeList = MODES.map(m =>
            `- \`${m}\`${m === permissionMode ? ' ← active' : ''} — ${MODE_DESC[m]}`
          ).join('\n');
          setDisplayMessages(prev => [...prev, {
            role: 'assistant',
            text: `**Permission mode:** ${permissionMode}\n\n${modeList}\n\n**Usage:** \`/mode accept\` or \`shift+tab\` to cycle`,
          }]);
        }
        break;
      }

      case '/plan':
        if (arg === 'off' || arg === 'exit') {
          if (permissionMode === 'plan') {
            // Force exit without approval — restore mode, clean up
            setPermissionMode(prePlanModeRef.current);
            registry.unregister('EnterPlanMode');
            registry.unregister('ExitPlanMode');
            planFilePathRef.current = null;
            setDisplayMessages(prev => [...prev, {
              role: 'system',
              text: `${figures.planMode} Plan mode off. Plan file preserved in .aries/plans/ if written.`,
              subtype: 'info',
            }]);
          }
        } else {
          prePlanModeRef.current = permissionMode;
          planFilePathRef.current = null;
          registerPlanTools(registry, {
            cwd,
            onEnter: (path) => { planFilePathRef.current = path; },
            onExit: (path, content) => new Promise<PlanApprovalResult>(resolve => {
              setPlanApprovalData({ path, content });
              setShowPlanApproval(true);
              planApprovalResolveRef.current = resolve;
            }),
          });
          setPermissionMode('plan');
          setDisplayMessages(prev => [...prev, {
            role: 'system',
            text: `${figures.planMode} Plan mode on — model will call EnterPlanMode. /plan off to exit.`,
            subtype: 'info',
          }]);
          if (arg) {
            handleSubmit(arg);
          }
        }
        break;

      case '/execute':
        // Quick exit from plan mode → execute
        if (permissionMode === 'plan') {
          // Force exit to accept mode
          setPermissionMode('accept');
          registry.unregister('EnterPlanMode');
          registry.unregister('ExitPlanMode');
          planFilePathRef.current = null;
          setDisplayMessages(prev => [...prev, {
            role: 'system',
            text: `${figures.autoMode} Plan mode off — executing with accept edits.`,
            subtype: 'info',
          }]);
        } else {
          setDisplayMessages(prev => [...prev, {
            role: 'system', text: 'Not in plan mode. Use /plan to enter.', subtype: 'info',
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
      case '/usage': {
        const tracker = trackerRef.current;
        const totals = tracker.totals;
        const recent = tracker.lastTurns(10);

        // Per-turn table
        const turnLines = recent.map(t =>
          `  ${String(t.turn).padStart(3)}  ${t.model.slice(0, 20).padEnd(20)}  ${formatTokenCount(t.inputTokens).padStart(7)} in  ${formatTokenCount(t.outputTokens).padStart(7)} out  ${t.cacheReadTokens > 0 ? formatTokenCount(t.cacheReadTokens).padStart(6) + ' cached' : '             '}  ${formatCost(t.costEstimate).padStart(8)}  ${t.durationMs ? formatDuration(t.durationMs).padStart(6) : ''}`
        ).join('\n');

        // Cache efficiency
        const cacheHitRate = totals.inputTokens > 0
          ? Math.round((totals.cacheReadTokens / (totals.inputTokens + totals.cacheReadTokens)) * 100)
          : 0;

        const text = [
          `**Session Usage** (${totals.turns} turns)`,
          '',
          '```',
          `  Input:       ${formatTokenCount(totals.inputTokens).padStart(8)}  tokens`,
          `  Output:      ${formatTokenCount(totals.outputTokens).padStart(8)}  tokens`,
          `  Cache read:  ${formatTokenCount(totals.cacheReadTokens).padStart(8)}  tokens  (${cacheHitRate}% hit rate)`,
          `  Cache write: ${formatTokenCount(totals.cacheWriteTokens).padStart(8)}  tokens`,
          `  ─────────────────────────────`,
          `  Total:       ${formatTokenCount(totals.totalTokens).padStart(8)}  tokens`,
          `  Est. cost:   ${formatCost(totals.cost).padStart(8)}`,
          `  Wall time:   ${formatDuration(totals.durationMs).padStart(8)}`,
          '```',
          '',
          `**Context:** ${formatTokenCount(tokenCount)} / ${formatTokenCount(router.current.contextWindow)} (${Math.round(tokenCount / router.current.contextWindow * 100)}%)`,
          '',
          totals.turns > 0 ? `**Last ${recent.length} turns:**` : '',
          totals.turns > 0 ? '```' : '',
          turnLines,
          totals.turns > 0 ? '```' : '',
        ].filter(Boolean).join('\n');

        setDisplayMessages(prev => [...prev, { role: 'assistant', text }]);
        break;
      }

      case '/tools':
        setDisplayMessages(prev => [...prev, {
          role: 'assistant',
          text: `**Tools (${registry.all().length}):**\n${registry.all().map(t => `- ${t.name} [${t.readOnly ? 'read' : 'write'}]`).join('\n')}`,
        }]);
        break;

      case '/display': {
        const modes: DisplayMode[] = ['verbose', 'normal', 'quiet', 'cerebral'];
        if (arg && modes.includes(arg as DisplayMode)) {
          setDisplayMode(arg as DisplayMode);
          setDisplayMessages(prev => [...prev, {
            role: 'system', text: `Display mode: ${arg}`, subtype: 'info',
          }]);
        } else {
          // Cycle: verbose → normal → quiet → cerebral → verbose
          const nextIdx = (modes.indexOf(displayMode) + 1) % modes.length;
          const next = modes[nextIdx]!;
          setDisplayMode(next);
          setDisplayMessages(prev => [...prev, {
            role: 'system', text: `Display mode: ${next}`, subtype: 'info',
          }]);
        }
        break;
      }

      case '/cerebral': {
        const next = displayMode === 'cerebral' ? 'normal' : 'cerebral';
        setDisplayMode(next as DisplayMode);
        setDisplayMessages(prev => [...prev, {
          role: 'system',
          text: next === 'cerebral'
            ? 'Cerebral mode: execute-only, no narration'
            : 'Cerebral mode: off',
          subtype: 'info',
        }]);
        break;
      }

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

      case '/config': {
        const slots = router.slots;
        const current = router.info;
        const lines = slots.map(s =>
          `  **${s.slot}**: ${s.model}${s.slot === current.slot ? ' ← active' : ''}`
        );
        const available = ModelRouter.availableModels.join(', ');
        setDisplayMessages(prev => [...prev, {
          role: 'assistant',
          text: `**Model Routing**\n${lines.join('\n')}\n\n**Effort:** ${current.effort}\n\n**Available models:** ${available}\n\n**Assign a slot:** \`/model cheap deepseek\`, \`/model bulk llama\`\n**Switch active:** \`/model opus high\`\n**Edit config:** \`~/.aries/config.yaml\``,
        }]);
        break;
      }

      case '/repl': {
        if (!replHandle) {
          setDisplayMessages(prev => [...prev, {
            role: 'assistant',
            text: '**REPL not enabled.** Set `repl.enabled: true` in config to use /repl.',
          }]);
          break;
        }
        if (!arg) {
          setDisplayMessages(prev => [...prev, {
            role: 'assistant',
            text: '**Usage:** `/repl <python code>` — executes in the Python body. Try `/repl print(codebase.top_files(5))` (requires prior `/index`).',
          }]);
          break;
        }
        // Echo the user's command
        setDisplayMessages(prev => [...prev, { role: 'user', text: input }]);

        // preCodeExecution hook (can block)
        const preResult = await runHooks(
          'preCodeExecution',
          hooks,
          { cwd, vaultPath: vault?.vaultPath },
          undefined,
          { code: arg },
        );
        if (preResult.blocked) {
          setDisplayMessages(prev => [...prev, {
            role: 'assistant',
            text: `**preCodeExecution blocked:** ${preResult.blockMessage}`,
          }]);
          break;
        }

        // Execute
        try {
          const result = await replHandle.exec({ code: arg });

          // Log to session
          session.log({
            type: 'code_execution',
            code: arg,
            stdout: result.stdout,
            stderr: result.stderr,
            exception: result.exception,
            duration_ms: result.duration_ms,
            rejected: result.rejected,
            timed_out: result.timed_out,
            rlm_stats: result.rlm_stats
              ? { call_count: result.rlm_stats.call_count, total_tokens: result.rlm_stats.total_tokens }
              : undefined,
            timestamp: Date.now(),
          });

          // postCodeExecution hook (non-blocking)
          await runHooks(
            'postCodeExecution',
            hooks,
            { cwd, vaultPath: vault?.vaultPath },
            undefined,
            {
              code: arg,
              stdout: result.stdout,
              stderr: result.stderr,
              exception: result.exception,
              rejected: result.rejected,
            },
          );

          // Render result
          if (result.rejected) {
            setDisplayMessages(prev => [...prev, {
              role: 'assistant',
              text: `**Rejected by AST guard:** ${result.rejected!.reason}`,
            }]);
          } else if (result.timed_out) {
            setDisplayMessages(prev => [...prev, {
              role: 'assistant',
              text: `**Timed out** after ${result.duration_ms}ms`,
            }]);
          } else {
            const parts: string[] = [];
            if (result.stdout) parts.push('```\n' + result.stdout.trimEnd() + '\n```');
            if (result.stderr) parts.push('**stderr:**\n```\n' + result.stderr.trimEnd() + '\n```');
            if (result.exception) parts.push('**exception:**\n```\n' + result.exception.trimEnd() + '\n```');
            const footer = result.rlm_stats && result.rlm_stats.call_count > 0
              ? `_(${result.duration_ms}ms · ${result.rlm_stats.call_count} rlm calls · ${result.rlm_stats.total_tokens} tokens)_`
              : `_(${result.duration_ms}ms)_`;
            parts.push(footer);
            setDisplayMessages(prev => [...prev, {
              role: 'assistant',
              text: parts.join('\n\n'),
            }]);
          }
        } catch (err) {
          setDisplayMessages(prev => [...prev, {
            role: 'assistant',
            text: `**REPL error:** ${(err as Error).message}`,
          }]);
        }
        break;
      }

      case '/signature': {
        if (!replHandle) {
          setDisplayMessages(prev => [...prev, {
            role: 'assistant',
            text: '**REPL not enabled.** Set `repl.enabled: true` in config.',
          }]);
          break;
        }
        setDisplayMessages(prev => [...prev, { role: 'user', text: input }]);
        // Parse: /signature [codebase|vault] [lean|standard|deep|max] [maxTokens]
        const parts = arg.split(/\s+/).filter(Boolean);
        let which: 'codebase' | 'vault' = 'codebase';
        let level: 'lean' | 'standard' | 'deep' | 'max' = 'standard';
        let maxTokens = 1500;
        for (const p of parts) {
          if (p === 'codebase' || p === 'vault') which = p;
          else if (['lean', 'standard', 'deep', 'max'].includes(p)) level = p as any;
          else {
            const n = parseInt(p, 10);
            if (!isNaN(n)) maxTokens = n;
          }
        }
        try {
          const sig = which === 'vault'
            ? await replHandle.bridge.vaultSignature(level, maxTokens)
            : await replHandle.bridge.codebaseSignature(level, maxTokens);
          if ('error' in sig && sig.error) {
            const hint = which === 'vault' ? 'Vault not connected.' : 'Run `/index` first.';
            setDisplayMessages(prev => [...prev, {
              role: 'assistant',
              text: `**${which} signature error:** ${sig.error}. ${hint}`,
            }]);
          } else {
            setDisplayMessages(prev => [...prev, {
              role: 'assistant',
              text: `${sig.markdown}\n\n_(${which} · ${level} · ${sig.approx_tokens} tokens)_`,
            }]);
          }
        } catch (err) {
          setDisplayMessages(prev => [...prev, {
            role: 'assistant',
            text: `**Signature error:** ${(err as Error).message}`,
          }]);
        }
        break;
      }

      case '/index': {
        if (!replHandle) {
          setDisplayMessages(prev => [...prev, {
            role: 'assistant',
            text: '**REPL not enabled.** Set `repl.enabled: true` in config.',
          }]);
          break;
        }
        const repoPath = arg || cwd;
        setDisplayMessages(prev => [...prev, { role: 'user', text: input }]);
        setIsLoading(true);
        try {
          const r = await replHandle.bridge.index({ repoPath });
          if (r.ok) {
            setDisplayMessages(prev => [...prev, {
              role: 'assistant',
              text: `**Indexed ${r.file_count} files** (${r.symbol_count} symbols, ${r.edge_count} edges, ${r.unique_symbols} unique symbols) in ${r.elapsed_ms}ms.\n\n\`codebase\` is now available in the REPL. Try \`/repl print(codebase.top_files(5))\`.`,
            }]);
          } else {
            setDisplayMessages(prev => [...prev, {
              role: 'assistant',
              text: `**Index failed:** ${r.error ?? 'unknown'}`,
            }]);
          }
        } catch (err) {
          setDisplayMessages(prev => [...prev, {
            role: 'assistant',
            text: `**Index error:** ${(err as Error).message}`,
          }]);
        }
        setIsLoading(false);
        break;
      }

      case '/reload': {
        // Re-index codebase, refresh vault orient, clear conversation
        const reloadParts: string[] = [];
        if (replHandle) {
          try {
            const idx = await replHandle.bridge.index({ repoPath: cwd });
            if (idx.ok) {
              reloadParts.push(`codebase: ${idx.file_count} files, ${idx.symbol_count} symbols`);
            }
          } catch { reloadParts.push('codebase: reindex failed'); }
        }
        if (vault?.connected) {
          try {
            await vault.orient();
            reloadParts.push('vault: orient refreshed');
          } catch { reloadParts.push('vault: orient failed'); }
        }
        messagesRef.current.length = 0;
        setDisplayMessages([{
          role: 'system',
          text: `Reloaded. ${reloadParts.join(' | ')}`,
          subtype: 'info',
        }]);
        setTokenCount(0);
        break;
      }

      case '/help':
        setDisplayMessages(prev => [...prev, {
          role: 'assistant',
          text: `**Commands:**
- \`/model\` — interactive model picker (or \`/model opus high\`)
- \`/model cheap deepseek\` — assign a model to a slot
- \`/config\` — show model routing (which model handles what)
- \`/effort high|medium|low\` — change effort level
- \`/cost\` — token usage
- \`/tools\` — list tools
- \`/vault\` — vault status
- \`/brain\` — project brain
- \`/research "query"\` — deep multi-source research
- \`/index [path]\` — index codebase graph (default: cwd)
- \`/signature [codebase|vault] [lean|standard|deep|max] [tokens]\` — preview ambient signature
- \`/repl <code>\` — execute Python in the body (requires /index first)
- \`/resume\` — resume a previous session (interactive picker)
- \`/rename <title>\` — rename current session
- \`/undo\` — undo last file edit (\`/undo 3\` for multiple)
- \`/compact\` — manually compact conversation
- \`/reload\` — re-index codebase + refresh vault + clear conversation
- \`/setup\` — view/change agent name, vault, Ori MCP
- \`/clear\` — clear conversation
- \`/exit\` — exit

**Shortcuts:** Alt+P — model picker | Ctrl+C — exit`,
        }]);
        break;

      case '/resume': {
        if (!arg) {
          // Open interactive picker
          setShowResumePicker(true);
          break;
        }
        // Quick resume by number, id, or title fragment
        const match = session.findSession(arg);
        if (!match) {
          setDisplayMessages(prev => [...prev, {
            role: 'assistant', text: `No session matching "${arg}". Try \`/resume\` to browse.`,
          }]);
          break;
        }
        await loadSession(match.id, match.userTitle ?? match.title ?? match.id);
        break;
      }

      case '/rename': {
        if (!arg) {
          setDisplayMessages(prev => [...prev, {
            role: 'assistant',
            text: sessionTitle
              ? `**Current title:** ${sessionTitle}\n**Usage:** \`/rename My New Title\``
              : '**Usage:** `/rename My New Title`',
          }]);
          break;
        }
        session.rename(arg);
        setSessionTitle(arg);
        setDisplayMessages(prev => [...prev, {
          role: 'system', text: `Session renamed: ${arg}`, subtype: 'info',
        }]);
        break;
      }

      case '/undo': {
        const { undoLast, undoN, snapshotCount } = await import('../tools/snapshot.js');

        if (arg === 'list') {
          setDisplayMessages(prev => [...prev, {
            role: 'assistant', text: `**Undo stack:** ${snapshotCount()} snapshots available`,
          }]);
          break;
        }

        const count = arg ? parseInt(arg, 10) : 1;
        if (count > 1) {
          const restored = undoN(count);
          if (restored.length === 0) {
            setDisplayMessages(prev => [...prev, {
              role: 'assistant', text: 'Nothing to undo.',
            }]);
          } else {
            const list = restored.map(s => `- Restored ${s.path} (was ${s.tool})`).join('\n');
            setDisplayMessages(prev => [...prev, {
              role: 'system', text: `Undid ${restored.length} edits:\n${list}`, subtype: 'info',
            }]);
          }
        } else {
          const snap = undoLast();
          if (snap) {
            setDisplayMessages(prev => [...prev, {
              role: 'system', text: `Restored ${snap.path} (was ${snap.tool})`, subtype: 'info',
            }]);
          } else {
            setDisplayMessages(prev => [...prev, {
              role: 'assistant', text: 'Nothing to undo.',
            }]);
          }
        }
        break;
      }

      case '/compact': {
        setIsLoading(true);
        try {
          const { runCompaction } = await import('../memory/compact.js');
          const result = await runCompaction(
            messagesRef.current, projectBrain, vault, router,
            Math.floor(router.current.contextWindow * 0.5),
            cwd,
          );
          messagesRef.current.length = 0;
          messagesRef.current.push(...result.messages);
          setTokenCount(0);
          setDisplayMessages(prev => [...prev, {
            role: 'system',
            text: result.pruneOnly
              ? 'Compacted (pruned old tool outputs)'
              : `Compacted: ${result.saved.length} insights saved. ${result.summary.slice(0, 100)}`,
            subtype: 'compact',
          }]);
        } catch (err) {
          setDisplayMessages(prev => [...prev, {
            role: 'system', text: `Compact failed: ${(err as Error).message}`, subtype: 'error',
          }]);
        }
        setIsLoading(false);
        break;
      }

      case '/setup': {
        // Show current config + instructions for changes
        const home = process.env.HOME || process.env.USERPROFILE || '';
        const configPath = `${home}/.aries/config.yaml`;
        const vaultInfo = vault?.connected
          ? `**Vault:** ${vault.vaultPath}`
          : '**Vault:** not configured';
        const oriMcpInfo = [
          '',
          '**Connect other editors to your vault:**',
          '```',
          'npm i -g ori-memory',
          `ori bridge claude-code --vault <path>`,
          '```',
        ].join('\n');

        if (arg === 'name' || arg === 'rename') {
          const newName = rest.slice(1).join(' ').trim();
          if (newName) {
            // Write updated name to config
            const { readFileSync, writeFileSync } = await import('node:fs');
            try {
              let yaml = readFileSync(configPath, 'utf-8');
              yaml = yaml.replace(/^(\s*name:\s*).*$/m, `$1${newName}`);
              writeFileSync(configPath, yaml, 'utf-8');
              setDisplayMessages(prev => [...prev, {
                role: 'assistant',
                text: `Agent renamed to **${newName}**. Restart to apply.`,
              }]);
            } catch {
              setDisplayMessages(prev => [...prev, {
                role: 'assistant',
                text: `Could not write to ${configPath}. Create it manually.`,
              }]);
            }
          } else {
            setDisplayMessages(prev => [...prev, {
              role: 'assistant', text: 'Usage: `/setup name <new-name>`',
            }]);
          }
        } else {
          setDisplayMessages(prev => [...prev, {
            role: 'assistant',
            text: [
              `**Agent:** ${agentName}`,
              vaultInfo,
              `**Config:** ${configPath}`,
              '',
              '**Commands:**',
              '- `/setup name <name>` — rename your agent',
              oriMcpInfo,
            ].join('\n'),
          }]);
        }
        break;
      }

      default:
        setDisplayMessages(prev => [...prev, {
          role: 'assistant', text: `Unknown command: ${cmd}`,
        }]);
    }
  }, [vault, projectBrain, router, registry, tokenCount, vaultNoteCount]);

  // ── Render ──────────────────────────────────────────────────────────
  return (
    <Box flexDirection="column" height="100%">
      {/* Completed messages — Static renders to terminal scrollback buffer, never redrawn */}
      <Static items={displayMessages}>
        {(msg, i) => (
          <Messages key={i} messages={[msg]} streamSegments={[]} isStreaming={false} />
        )}
      </Static>

      {/* Live stream area — only the current turn, redraws during streaming */}
      <Box flexDirection="column">
        <Messages
          messages={[]}
          streamSegments={streamSegments}
          isStreaming={isLoading}
        />

        {/* Spinner */}
        <Spinner isLoading={isLoading} activeTool={activeTool} hasStreamingText={streamSegments.some(s => s.type === 'text')} />
      </Box>

      {/* Pinned bottom: model picker OR input + status */}
      <Box flexDirection="column" flexShrink={0}>
        {/* Permission dialog takes priority over everything */}
        {/* Dialogs in priority order: plan exit > permission > model picker > input */}
        {showPlanApproval && planApprovalData ? (
          <PlanApprovalDialog
            planFilePath={planApprovalData.path}
            planContent={planApprovalData.content}
            onAccept={handlePlanApproval}
            onReject={handlePlanReject}
            onCancel={handlePlanApprovalCancel}
            onContentChange={(content) => setPlanApprovalData(prev => prev ? { ...prev, content } : null)}
          />
        ) : pendingPermission ? (
          <PermissionDialog
            toolCall={pendingPermission.toolCall}
            onAllow={() => { pendingPermission.resolve('allow'); setPendingPermission(null); }}
            onDeny={() => { pendingPermission.resolve('deny'); setPendingPermission(null); }}
            onAlways={() => { pendingPermission.resolve('always'); setPendingPermission(null); }}
          />
        ) : showResumePicker ? (
          <ResumePicker
            sessions={session.listSessions()}
            onSelect={(s) => {
              setShowResumePicker(false);
              loadSession(s.id, s.userTitle ?? s.title ?? s.id);
            }}
            onCancel={() => setShowResumePicker(false)}
          />
        ) : showModelPicker ? (
          <ModelPicker
            currentModel={router.info.model.includes('opus') ? 'opus'
              : router.info.model.includes('sonnet') ? 'sonnet'
              : router.info.model.includes('haiku') ? 'haiku'
              : router.info.model.includes('gemini-2.5-pro') ? 'gemini'
              : router.info.model.includes('flash') ? 'flash'
              : 'sonnet'}
            currentEffort={router.effort}
            onSelect={handleModelSelect}
            onCancel={handleModelCancel}
          />
        ) : (
          <>
            {exitWarningAt && (
              <Box>
                <Text dimColor>Press Ctrl+C again to exit</Text>
              </Box>
            )}
            {pasteStatus && (
              <Box><Text color={colors.warning}>{figures.bullet} {pasteStatus}</Text></Box>
            )}
            <PromptInput
              onSubmit={handleSubmit}
              onPasteError={(msg) => {
                setPasteStatus(msg);
                if (pasteStatusTimerRef.current) clearTimeout(pasteStatusTimerRef.current);
                pasteStatusTimerRef.current = setTimeout(() => setPasteStatus(null), 3000);
              }}
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
              permissionMode={permissionMode}
              sessionTitle={sessionTitle}
            />
          </>
        )}
      </Box>
    </Box>
  );
}

/** Format a tool call as "Verb(arg)" like Claude Code does. */
function getToolDisplayName(name: string, input: Record<string, unknown>): string {
  const filePath = input.file_path as string | undefined;
  const relPath = filePath ? filePath.replace(/\\/g, '/').split('/').slice(-2).join('/') : undefined;

  switch (name) {
    case 'Read':
      return relPath ? `Read(${relPath})` : 'Read';
    case 'Edit':
      return relPath ? `Update(${relPath})` : 'Update';
    case 'Write':
      return relPath ? `Write(${relPath})` : 'Write';
    case 'Glob':
      return `Glob(${(input.pattern as string | undefined)?.slice(0, 40) ?? '*'})`;
    case 'Grep': {
      const pat = (input.pattern as string | undefined)?.slice(0, 30) ?? '';
      return `Grep(${pat})`;
    }
    case 'Bash':
      return 'Bash';
    case 'WebSearch':
      return 'WebSearch';
    case 'WebFetch':
      return 'WebFetch';
    case 'Agent':
      return `Agent(${(input.description as string | undefined)?.slice(0, 30) ?? 'task'})`;
    default:
      return name;
  }
}

/** Extract a brief summary from tool input for display (shown after the tool name). */
function getToolSummary(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'Bash':
      return (input.command as string | undefined)?.slice(0, 80) ?? '';
    case 'WebSearch':
      return (input.query as string | undefined)?.slice(0, 60) ?? '';
    case 'WebFetch':
      return (input.url as string | undefined)?.slice(0, 60) ?? '';
    case 'Agent':
      return '';
    default:
      // For file tools, the path is already in the display name
      if (input.query) return (input.query as string).slice(0, 60);
      if (input.title) return (input.title as string).slice(0, 60);
      if (input.task) return (input.task as string).slice(0, 60);
      return '';
  }
}

/**
 * Format tool result output for the ⎿ preview line.
 * Claude Code shows a compact, tool-appropriate summary.
 */
function formatToolResult(toolName: string, output: string, isError: boolean): string {
  if (isError) {
    // Show first line of error
    const firstLine = output.split('\n')[0] ?? output;
    return firstLine.slice(0, 200);
  }

  const lines = output.split('\n').filter(l => l.trim());

  switch (toolName) {
    case 'Read': {
      const lineCount = output.split('\n').length;
      return `${lineCount} lines`;
    }

    case 'Edit':
    case 'Write': {
      // Parse added/removed line counts from the diff
      const addedLines = (output.match(/^\+[^+]/mg) ?? []).length;
      const removedLines = (output.match(/^-[^-]/mg) ?? []).length;
      const hasDiff = output.includes('\n-') || output.includes('\n+');
      if (hasDiff) {
        const summary = addedLines > 0 && removedLines > 0
          ? `Added ${addedLines} line${addedLines !== 1 ? 's' : ''}, removed ${removedLines} line${removedLines !== 1 ? 's' : ''}`
          : addedLines > 0 ? `Added ${addedLines} line${addedLines !== 1 ? 's' : ''}`
          : removedLines > 0 ? `Removed ${removedLines} line${removedLines !== 1 ? 's' : ''}`
          : 'Modified';
        // Prepend summary to diff so DiffPreview shows both
        return `${summary}\n${output.slice(0, 600)}`;
      }
      if (output.includes('Applied edit')) return output.split('\n')[0]!.slice(0, 150);
      return lines[0]?.slice(0, 150) ?? (toolName === 'Write' ? 'File written' : 'Edit applied');
    }

    case 'Bash': {
      if (lines.length === 0) return '(no output)';
      const exitMatch = output.match(/Exit code: (\d+)/);
      const exitCode = exitMatch ? `Exit ${exitMatch[1]}` : '';
      if (lines.length <= 3) return `${exitCode}${exitCode ? ' | ' : ''}${lines.join(' | ').slice(0, 180)}`;
      return `${exitCode}${exitCode ? ' | ' : ''}${lines.length} lines`;
    }

    case 'Glob': {
      if (lines.length === 0) return 'No matches';
      if (lines.length <= 3) return lines.join(', ').slice(0, 200);
      return `${lines.length} files`;
    }

    case 'Grep': {
      if (lines.length === 0) return 'No matches';
      // Count unique files in output (grep output format: "file:line:content")
      const files = new Set(lines.map(l => l.split(':')[0]).filter(Boolean));
      const fileCount = files.size;
      const matchCount = lines.length;
      if (fileCount <= 1 && matchCount === 1) return lines[0]!.slice(0, 200);
      return fileCount > 1
        ? `${matchCount} match${matchCount !== 1 ? 'es' : ''} in ${fileCount} file${fileCount !== 1 ? 's' : ''}`
        : `${matchCount} match${matchCount !== 1 ? 'es' : ''}`;
    }

    case 'WebFetch':
      return `${output.length} chars fetched`;

    case 'WebSearch': {
      if (lines.length === 0) return 'No results';
      return `${lines.length} result${lines.length !== 1 ? 's' : ''}`;
    }

    case 'VaultSearch':
    case 'VaultRead':
    case 'VaultAdd':
    case 'VaultExplore':
    case 'VaultWarmth':
    case 'ProjectSearch':
      return lines[0]?.slice(0, 200) ?? output.slice(0, 200);

    case 'Agent':
      return lines[0]?.slice(0, 200) ?? 'Agent completed';

    default: {
      // Generic: first line, truncated
      if (lines.length === 0) return '(empty)';
      if (output.length <= 200) return lines.join(' ').slice(0, 200);
      return `${lines[0]!.slice(0, 150)}… (${output.length} chars)`;
    }
  }
}
