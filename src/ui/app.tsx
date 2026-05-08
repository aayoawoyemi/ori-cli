import React, { useState, useCallback, useRef, useEffect } from 'react';
import { Box, Text, useApp, useInput, Static } from 'ink';
import { Messages, type DisplayMessage, type DisplayToolCall, type StreamSegment } from './messages.js';
import { PromptInput, type AttachedImage } from './input.js';
import { StatusBar } from './statusBar.js';
import { Spinner } from './spinner.js';
import { ModelPicker } from './modelPicker.js';
import { agentLoop, type LoopEvent, type PermissionMode, type PermissionDecision } from '../loop.js';
import { agentLoop3, type Loop3Event } from '../loop3/agent.js';
import { AnthropicToolUseAdapter } from '../loop3/adapters/anthropic.js';
import { PermissionDialog } from './permissionDialog.js';
import { AskDialog } from './askDialog.js';
import { PlanApprovalDialog, type PlanAcceptMode } from './planApprovalDialog.js';
import { setTitleBusy, setTitleDone, setTitleIdle, flashTaskbar } from './terminal.js';
import { registerPlanTools } from '../tools/registry.js';
import type { PlanApprovalResult } from '../tools/planTypes.js';
import { readFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { ResumePicker } from './resumePicker.js';
import { figures, colors } from './theme.js';
import { UsageTracker, formatTokenCount, formatCost, formatDuration } from '../telemetry/tracker.js';
import { ModelRouter, type EffortLevel } from '../router/index.js';
import type { Message, SystemPromptInput, ToolCall } from '../router/types.js';
import { buildComposeRequestSystemPrompt } from '../prompt.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { OriVault } from '../memory/vault.js';
import type { ProjectBrain } from '../memory/projectBrain.js';
import type { SessionStorage } from '../session/storage.js';
// syncSession removed 2026-04-29. It performed three auto-vault-writes on
// every session exit (final postflight reflection, ungated session-end
// reflection, session-metadata note). All were LLM-synthesized noise that
// polluted warm-context retrieval. See src/memory/postflight.ts header.
import { runHooks } from '../hooks/runner.js';
import type { HooksConfig, DisplayMode, ExperimentalConfig } from '../config/types.js';
import type { ReplHandle } from '../repl/setup.js';
import { runResearch } from '../research/index.js';
import type { ResearchDepth } from '../research/types.js';
import { ResearchJournal, type ResearchJournalHandle } from './researchJournal.js';
import { classifyRequestMode, newRequestId, type RequestMode } from '../compose/router.js';
import { ComposeController } from '../compose/controller.js';
import { ComposeDisplayFilter, renderComposeBlocksForDisplay } from '../compose/display.js';

interface AppProps {
  agentName: string;
  cwd: string;
  router: ModelRouter;
  registry: ToolRegistry;
  vault: OriVault | null;
  projectBrain: ProjectBrain | null;
  session: SessionStorage;
  systemPrompt: SystemPromptInput;
  hooks: HooksConfig;
  vaultNoteCount?: number;
  initialPrompt?: string;
  initialPermissionMode?: PermissionMode;
  replHandle?: ReplHandle | null;
  getReplHandle?: () => ReplHandle | null;
  resumedMessages?: Message[] | null;
  initialResumePicker?: boolean;
  experimental?: ExperimentalConfig;
}

function formatLoop3ExecutionOutput(event: Extract<Loop3Event, { type: 'action_executed' }>): string {
  const result = event.result;
  const stdout = stdoutWithoutSayEcho(result.stdout, result.sayTexts);
  const parts = [
    ...result.sayTexts,
    stdout,
    result.stderr,
    result.exception,
    result.rejectedReason,
    result.timedOut ? 'timeout' : '',
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  if (result.doneValue !== undefined) {
    parts.push(formatDoneValueForDisplay(result.doneValue));
  }
  if (typeof result.runtime?.footer === 'string' && result.runtime.footer.trim()) {
    parts.push(result.runtime.footer.trim());
  }
  return parts.join('\n') || 'ok';
}

function formatDoneValueForDisplay(value: unknown): string {
  if (typeof value === 'string') return value;
  const planSummary = summarizePlanCreateValue(value);
  if (planSummary) return planSummary;
  return JSON.stringify(value, null, 2);
}

function summarizePlanCreateValue(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.ok !== true || typeof record.path !== 'string') return null;
  if (typeof record.goal !== 'string' && typeof record.phase_count !== 'number') return null;

  const goal = typeof record.goal === 'string' && record.goal.trim()
    ? ` goal="${record.goal.trim().slice(0, 80)}"`
    : '';
  const layers = typeof record.layer_count === 'number' ? ` layers=${record.layer_count}` : '';
  const phases = typeof record.phase_count === 'number' ? ` phases=${record.phase_count}` : '';
  const warnings = Array.isArray(record.warnings) && record.warnings.length > 0
    ? ` warnings=${record.warnings.length}`
    : '';
  return `plan.create: ok${goal}${layers}${phases}${warnings} path=${record.path}`;
}

function summarizePlanCreateText(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
  try {
    return summarizePlanCreateValue(JSON.parse(trimmed));
  } catch {
    return null;
  }
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

function parseGoalTrigger(input: string): string | null {
  const match = input.match(/^(#goal|\\goal)\b\s*/i);
  if (!match) return null;
  return input.slice(match[0].length).trim();
}

function buildGoalModePrompt(goalText: string): string {
  return `Goal mode requested.

User goal:
${goalText || '(not yet specified)'}

Refine the goal before implementation. If the goal is ambiguous, ask concise clarifying questions with say()/ask(). Once it is sharp, call spanner.escalate(reason, layers=...) and create a detailed plan with plan.create(...). The plan must use Layer -> Phase -> Composition structure: each phase declares intent, primitives, produces, and composition. Execute planned phases with plan.enter_phase(id), one or two composed Repl cells, and plan.exit_phase(id, outputs).`;
}

function buildHeadlessChildInvocation(task: string): { command: string; args: string[] } {
  const entry = process.argv[1];
  if (entry && /\.(?:ts|tsx)$/i.test(entry)) {
    return {
      command: process.platform === 'win32' ? 'npx.cmd' : 'npx',
      args: ['tsx', entry, '--headless', task],
    };
  }
  if (entry) {
    return {
      command: process.execPath,
      args: [entry, '--headless', task],
    };
  }
  return {
    command: process.platform === 'win32' ? 'npx.cmd' : 'npx',
    args: ['tsx', 'src/index.ts', '--headless', task],
  };
}

function capHeadlessText(text: string, maxChars = 20_000): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  const hidden = trimmed.length - maxChars;
  return `${trimmed.slice(0, maxChars)}\n\n[${hidden} chars truncated]`;
}

const MAX_HISTORY_SEGMENTS = 40;
const MAX_HISTORY_TEXT_CHARS = 4000;
const MAX_HISTORY_SAYS = 12;

function truncateForHistory(text: string, maxChars = MAX_HISTORY_TEXT_CHARS): string {
  if (text.length <= maxChars) return text;
  const hidden = text.length - maxChars;
  return `[${hidden} chars hidden]\n${text.slice(-maxChars)}`;
}

function compactToolForHistory(tool: DisplayToolCall): DisplayToolCall {
  return {
    ...tool,
    summary: truncateForHistory(tool.summary, 800),
    resultPreview: tool.resultPreview ? truncateForHistory(tool.resultPreview, 3000) : tool.resultPreview,
    says: tool.says
      ? tool.says.slice(-MAX_HISTORY_SAYS).map(s => truncateForHistory(s, 1200))
      : tool.says,
  };
}

function compactSegmentsForHistory(segments: StreamSegment[]): StreamSegment[] {
  return segments.slice(-MAX_HISTORY_SEGMENTS).map(seg => {
    if (seg.type === 'text') {
      return { ...seg, content: truncateForHistory(seg.content) };
    }
    if (seg.type === 'thinking') {
      return { ...seg, content: truncateForHistory(seg.content, 2000) };
    }
    return { ...seg, data: compactToolForHistory(seg.data) };
  });
}

function mapLoop3EventToLoopEvents(event: Loop3Event): LoopEvent[] {
  switch (event.type) {
    case 'model_start':
      return [{ type: 'model_start', turn: event.turn, model: event.provider }];
    case 'action_start':
      return [{ type: 'tool_call', toolCall: event.toolCall }];
    case 'action_denied':
      return [{ type: 'tool_denied', id: event.toolCall.id, name: event.toolCall.name }];
    case 'action_executed':
      return [{
        type: 'tool_result',
        id: event.toolCall.id,
        name: event.toolCall.name,
        output: formatLoop3ExecutionOutput(event).slice(0, 4000),
        output_full: formatLoop3ExecutionOutput(event),
        isError: event.result.exception !== null || event.result.rejectedReason !== null || event.result.timedOut,
      }];
    case 'turn_complete':
      return [{
        type: 'turn_complete',
        turn: event.turn,
        tokenEstimate: event.tokenEstimate,
        toolCallCount: event.cellCount > 0 ? 1 : 0,
        toolNames: event.cellCount > 0 ? ['Repl'] : [],
        replCellCount: event.cellCount,
      }];
    case 'done_committed':
      return [];
    default:
      return [event as LoopEvent];
  }
}

export function App(props: AppProps): React.ReactElement {
  const { exit } = useApp();
  const {
    agentName, cwd, router, registry, vault, projectBrain,
    session, systemPrompt, hooks, vaultNoteCount, initialPrompt,
    initialPermissionMode, replHandle: initialReplHandle,
    resumedMessages: initialResumedMessages, initialResumePicker,
    experimental,
    getReplHandle,
  } = props;
  const [replHandle, setReplHandle] = useState<ReplHandle | null>(initialReplHandle ?? null);

  // ── State ───────────────────────────────────────────────────────────
  const [displayMessages, setDisplayMessages] = useState<DisplayMessage[]>([]);
  const [streamSegments, setStreamSegments] = useState<StreamSegment[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [tokenCount, setTokenCount] = useState(0);
  const [activeTool, setActiveTool] = useState<string | undefined>();
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(initialPermissionMode ?? 'default');
  // Ref mirror of permissionMode — read by handleSubmit's agentLoop call so
  // changes are visible synchronously within the same event handler (React
  // state updates don't flush until after the handler returns).
  const permissionModeRef = useRef<PermissionMode>(initialPermissionMode ?? 'default');
  const [taskMode, setTaskMode] = useState<'normal' | 'explore'>('normal');
  const [showPlanApproval, setShowPlanApproval] = useState(false);
  const [planApprovalData, setPlanApprovalData] = useState<{ path: string; content: string } | null>(null);
  const planFilePathRef = useRef<string | null>(null);
  const prePlanModeRef = useRef<PermissionMode>('default');
  const preResearchModeRef = useRef<PermissionMode>('default');
  // Research run state — when true, the journal is rendered and Ctrl+C aborts.
  const [researchRunning, setResearchRunning] = useState(false);
  const researchJournalRef = useRef<ResearchJournalHandle | null>(null);
  const researchAbortRef = useRef<AbortController | null>(null);
  const researchRunningRef = useRef(false);
  const isLoadingRef = useRef(false);
  const planApprovalResolveRef = useRef<((r: PlanApprovalResult) => void) | null>(null);
  const [exitWarningAt, setExitWarningAt] = useState<number | null>(null);
  const [displayMode, setDisplayMode] = useState<DisplayMode>('normal');
  // Body drift indicator: true when the running Python body subprocess was
  // started before the current source on disk. Body code does not hot-reload,
  // so structural body changes (e.g. the planned-phase composition wall) do
  // not take effect until the user restarts the CLI. Set by polling the
  // bridge — the bridge captures the body's contentHash on each pong and
  // compares against the on-disk hash. See body/version.py + bridge.ts:
  // checkBodyDrift. Surfaced in the StatusBar so the user knows when
  // dogfooding signal is unreliable.
  const [bodyStale, setBodyStale] = useState<boolean>(false);
  // Compose sub-loop request mode. Set by classifyRequestMode in handleSubmit
  // when a top-level user message arrives; reset to null when the agentLoop3
  // generator finishes. Surfaced in the StatusBar so the user can see which
  // lane (quick / compose / goal) the auto-router picked. Tier 1 of the
  // compose sub-loop only TRACKS the mode for telemetry; the scratch
  // substrate (Tier 2) and gate (Tier 3) build on top of it.
  const [currentRequestMode, setCurrentRequestMode] = useState<RequestMode | null>(null);
  // Track isLoading transitions so we can reset currentRequestMode when a
  // request finishes. Multiple call sites set isLoading(false) (normal
  // completion, abort, error); a single useEffect catching the transition
  // is cleaner than touching each site.
  const prevIsLoadingRef = useRef<boolean>(false);
  const [pendingPermission, setPendingPermission] = useState<{
    toolCall: ToolCall;
    resolve: (decision: PermissionDecision) => void;
  } | null>(null);
  // Pending ask() modal — set by the bridge's onAsk callback when Python
  // calls ask(question). Python is blocked on a threading.Event waiting for
  // resolveAsk(id, answer). id is needed because overlapping ask() calls
  // (shouldn't happen but are possible if the model misbehaves) still need
  // to route their response to the right waiter on the Python side.
  const [pendingAsk, setPendingAsk] = useState<{
    id: number;
    question: string;
  } | null>(null);
  const [showResumePicker, setShowResumePicker] = useState(initialResumePicker ?? false);
  const [sessionTitle, setSessionTitle] = useState<string | null>(null);
  const [pasteStatus, setPasteStatus] = useState<string | null>(null);
  const [pendingCount, setPendingCount] = useState(0);
  const [gitBranch, setGitBranch] = useState<string | null>(null);
  const [indexedFiles, setIndexedFiles] = useState<number | undefined>(undefined);
  const pasteStatusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Conversation messages for the loop (mutable ref to avoid stale closures)
  const messagesRef = useRef<Message[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const alwaysAllowRef = useRef(new Set<string>());
  const trackerRef = useRef(new UsageTracker(session.sessionId, router.current.model));
  const toolTimingRef = useRef(new Map<string, number>());
  // Tracks the id of the currently-executing tool call. Set on tool_call,
  // cleared on tool_result/denied. Used by setOnSay to route say() output
  // to the right segment by id, not by index. Eagerly synced on the JS
  // event loop, so it stays consistent across bridge callbacks even when
  // React has not yet flushed pending setStreamSegments updates.
  const activeToolIdRef = useRef<string | null>(null);
  const turnCountRef = useRef(0);
  // Input queue: messages typed while the model is running. Drained as one
  // combined message on turn complete. Cleared on abort so stale queued
  // messages do not fire into a subsequent unrelated turn.
  const pendingInputRef = useRef<string[]>([]);

  // Token buffer: accumulate text, flush to state at 30fps for smooth rendering
  const textBufferRef = useRef('');
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const segmentsRef = useRef<StreamSegment[]>([]);
  const composeDisplayFilterRef = useRef(new ComposeDisplayFilter());

  useEffect(() => {
    isLoadingRef.current = isLoading;
  }, [isLoading]);

  useEffect(() => {
    researchRunningRef.current = researchRunning;
  }, [researchRunning]);

  const interruptActiveRun = useCallback((): boolean => {
    if (researchRunningRef.current && researchAbortRef.current) {
      researchAbortRef.current.abort();
      setDisplayMessages(prev => [...prev, { role: 'system', text: 'Interrupt requested', subtype: 'info' }]);
      return true;
    }
    if (isLoadingRef.current && abortRef.current) {
      abortRef.current.abort();
      setActiveTool(undefined);
      setDisplayMessages(prev => [...prev, { role: 'system', text: 'Interrupt requested', subtype: 'info' }]);
      return true;
    }
    return false;
  }, []);

  useEffect(() => {
    const onSigint = () => {
      interruptActiveRun();
    };
    process.on('SIGINT', onSigint);
    return () => {
      process.off('SIGINT', onSigint);
    };
  }, [interruptActiveRun]);

  const flushTextBuffer = useCallback(() => {
    flushTimerRef.current = null;
    if (!textBufferRef.current) return;
    const buffered = textBufferRef.current;
    textBufferRef.current = '';
    // Eager ref sync: write segmentsRef BEFORE setStreamSegments so other
    // synchronous readers (e.g. the bridge's setOnSay callback firing between
    // React commits) see the fresh value. Putting the sync inside a functional
    // updater is unsafe — React 18 may defer the updater past the next bridge
    // event, leaving readers with stale state. Pattern: read from ref, mutate,
    // write ref, push to setState.
    const segs = [...segmentsRef.current];
    const last = segs[segs.length - 1];
    if (last && last.type === 'text') {
      segs[segs.length - 1] = { type: 'text', content: last.content + buffered };
    } else {
      segs.push({ type: 'text', content: buffered });
    }
    segmentsRef.current = segs;
    setStreamSegments(segs);
  }, []);

  const bufferText = useCallback((text: string) => {
    textBufferRef.current += text;
    if (!flushTimerRef.current) {
      flushTimerRef.current = setTimeout(flushTextBuffer, 16);
    }
  }, [flushTextBuffer]);

  // ── Load resumed messages on mount ──────────────────────────────────
  // ── Git branch detection (once on mount) ─────────────────────────────
  useEffect(() => {
    try {
      const branch = require('node:child_process')
        .execSync('git rev-parse --abbrev-ref HEAD', { cwd, encoding: 'utf-8', timeout: 2000 })
        .trim();
      setGitBranch(branch);
    } catch { /* not a git repo */ }
  }, [cwd]);


  useEffect(() => {
    if (!getReplHandle) return;
    const update = () => {
      const next = getReplHandle();
      setReplHandle(prev => prev === next ? prev : next);
    };
    update();
    const timer = setInterval(update, 250);
    return () => clearInterval(timer);
  }, [getReplHandle]);

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

  // ── Always-register plan tools (121 tokens, prevents identity confusion) ──
  useEffect(() => {
    registerPlanTools(registry, {
      cwd,
      onEnter: (path) => { planFilePathRef.current = path; },
      onExit: (path, content) => new Promise<PlanApprovalResult>(resolve => {
        setPlanApprovalData({ path, content });
        setShowPlanApproval(true);
        planApprovalResolveRef.current = resolve;
      }),
    });
  }, []);

  // ── Keyboard shortcuts ──────────────────────────────────────────────
  useInput((input, key) => {
    // Ctrl+C → exit
    if (key.ctrl && input === 'c') {
      // If a research run is live, Ctrl+C aborts it first.
      if (interruptActiveRun()) {
        return;
      }
      // Not loading — double Ctrl+C to exit
      if (exitWarningAt && Date.now() - exitWarningAt < 2000) {
        // Second press within 2s — actually exit
        runHooks('stop', hooks, { cwd, vaultPath: vault?.vaultPath })
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

    // Esc → interrupt streaming / close model picker / abort research
    if (key.escape) {
      if (showModelPicker) {
        setShowModelPicker(false);
        return;
      }
      if (interruptActiveRun()) {
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

    // Alt+Q → "just plan" nudge (only in plan mode)
    if (key.meta && input === 'q') {
      if (!isLoading && permissionMode === 'plan') {
        const nudge = 'Stop asking questions. Write the plan based on what we\'ve discussed and call ExitPlanMode.';
        handleSubmit(nudge);
      }
      return;
    }

    // Alt+Z → toggle explore mode (code-only, no mutations)
    if (key.meta && input === 'z') {
      if (!isLoading) {
        setTaskMode(prev => {
          const next = prev === 'normal' ? 'explore' : 'normal';
          setDisplayMessages(p => [...p, {
            role: 'system',
            text: next === 'explore'
              ? '🔍 Explore mode — read-only. Only code, VaultAdd, ProjectSave visible. Alt+Z to exit.'
              : '⚡ Normal mode restored.',
            subtype: 'info',
          }]);
          return next;
        });
      }
      return;
    }

    // Alt+M (meta+m) or Shift+Tab → cycle permission mode
    if ((key.meta && input === 'm') || (key.shift && key.tab)) {
      if (!isLoading) {
        setPermissionMode(prev => {
          // Research mode is NOT in the cycle — enterable only via /research.
          // If we're currently in research mode, Alt+M exits to pre-research mode.
          if (prev === 'research') {
            const next = preResearchModeRef.current;
            replHandle?.bridge.setResearchBudget(null);
            setDisplayMessages(p => [...p, { role: 'system', text: `${figures.researchMode} Exited research mode → ${next}.`, subtype: 'info' }]);
            return next;
          }
          const modes: PermissionMode[] = ['default', 'accept', 'plan', 'yolo'];
          const idx = modes.indexOf(prev);
          const next = modes[(idx + 1) % modes.length]!;

          // Leaving plan mode
          if (prev === 'plan' && next !== 'plan') {
            planFilePathRef.current = null;
            setDisplayMessages(p => [...p, { role: 'system', text: `${figures.planMode} Exited plan mode → ${next}. Plan file preserved if written.`, subtype: 'info' }]);
          }

          // Entering plan mode → inject directive (tools always registered)
          if (next === 'plan') {
            prePlanModeRef.current = prev;
            planFilePathRef.current = null;
            setDisplayMessages(p => [...p, { role: 'system', text: `${figures.planMode} Plan mode — model will call EnterPlanMode to begin. Alt+M to cycle.`, subtype: 'info' }]);
            messagesRef.current.push({ role: 'user', content: 'You are now in plan mode. Call EnterPlanMode to begin.' });
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

  // Keep permissionModeRef in sync with state for any updates that happen
  // through React channels (Alt+M, /mode). Sync sites in the same event
  // handler must also update the ref directly before calling handleSubmit.
  useEffect(() => {
    permissionModeRef.current = permissionMode;
  }, [permissionMode]);

  // Subscribe the usage tracker to router.cheapCall so research, compaction,
  // and session-title spend all show up in /usage. (Postflight spend used to
  // be on this list — removed 2026-04-29 along with its LLM call.)
  useEffect(() => {
    const unsub = router.onCheapCallUsage(({ provider, model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }) => {
      trackerRef.current.markTurnStart();
      trackerRef.current.recordTurn(model, provider, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens);
    });
    return unsub;
  }, [router]);

  // Run sessionStart hooks + initial prompt
  useEffect(() => {
    (async () => {
      await runHooks('sessionStart', hooks, { cwd, vaultPath: vault?.vaultPath });
      if (initialPrompt) {
        handleSubmit(initialPrompt);
      }
    })();
  }, []);

  // Auto-exit research mode when research.save() completes in the bridge.
  useEffect(() => {
    if (!replHandle) return;
    replHandle.bridge.setOnResearchSaved((dir: string) => {
      // Only act if we're still in research mode (user may have Alt+M'd out already).
      setPermissionMode(prev => {
        if (prev !== 'research') return prev;
        const next = preResearchModeRef.current;
        setDisplayMessages(p => [...p, {
          role: 'system',
          text: `${figures.researchMode} Research saved → ${dir}. Mode: ${next}.`,
          subtype: 'info',
        }]);
        return next;
      });
      // Clear the session budget so the next /research starts fresh.
      replHandle.bridge.setResearchBudget(null);
    });
    return () => {
      replHandle.bridge.setOnResearchSaved(null);
    };
  }, [replHandle]);

  // Wire the Python body's say/ask primitives to the UI. Registered whenever
  // a Repl bridge is present; deregistered on unmount / handle change so a
  // stale closure can't keep firing setState on a dropped app.
  //
  // say(text) → append as assistant voice to the message stream. Python has
  //   already continued; nothing to ack. If text arrives while the user is
  //   mid-typing, Ink's render will paint it above the input without
  //   disturbing cursor position.
  //
  // ask(id, question) → pop the AskDialog. The dialog's onSubmit/onCancel
  //   handlers call bridge.resolveAsk(id, answer) to unblock Python. Empty
  //   string is the cancel-contract (matches body/speak.py). If a second
  //   ask fires while one is pending (unlikely but possible under bad model
  //   behavior), we overwrite — the earlier one will time out on the Python
  //   side. Queueing would be nicer but adds complexity for a rare case;
  //   revisit if it actually happens in usage.
  useEffect(() => {
    if (!replHandle) return;
    // Fetch indexed file count when the bridge becomes available.
    // The background index may already be done by the time replHandle lands.
    replHandle.bridge.setOnSay((text: string) => {
      // Attribute say() output to the Repl call that produced it. The bridge
      // doesn't pass call_id, but Repl calls are sequential — the most recent
      // unresolved tool segment is the active one. Routing here keeps the
      // voice visually inside the Repl block instead of fragmenting the
      // turn into separate ● bubbles per say(). Falls back to displayMessages
      // if no active tool (e.g. say() fired outside a Repl execution path).
      const activeId = activeToolIdRef.current;
      if (activeId) {
        const segs = segmentsRef.current;
        const idx = segs.findIndex(s => s.type === 'tool' && s.data.id === activeId);
        if (idx >= 0) {
          const target = segs[idx];
          if (target && target.type === 'tool') {
            const next = [...segs];
            next[idx] = {
              type: 'tool',
              data: { ...target.data, says: [...(target.data.says ?? []), text] },
            };
            segmentsRef.current = next;
            setStreamSegments(next);
            return;
          }
        }
      }
      // Fallback — say() fired with no active tool (e.g. before the first
      // exec lands in segments, or after the tool resolved in a race). Push
      // as a standalone assistant message so the voice isn't lost.
      setDisplayMessages(prev => [...prev, { role: 'assistant', text }]);
    });
    replHandle.bridge.setOnAsk((id: number, question: string) => {
      session.log({
        type: 'loop3_ask',
        phase: 'shown',
        id,
        question_chars: question.length,
        question_head: question.length <= 1000 ? question : question.slice(0, 1000),
        timestamp: Date.now(),
      });
      setPendingAsk({ id, question });
    });
    // Fetch indexed file count. Uses print() so the result lands in stdout
    // without triggering the setOnSay callback we just installed.
    replHandle.bridge.exec({ code: 'print(codebase.stats()["file_count"])' }).then(r => {
      const n = parseInt(r.stdout?.trim() ?? '', 10);
      if (!isNaN(n)) setIndexedFiles(n);
    }).catch(() => {});
    // Body drift watcher: poll the bridge every ~5s. The bridge captures
    // body version + content hash on every heartbeat pong; stale === true
    // means the on-disk body source has changed since the body process
    // started. Polling (vs subscribing to body_drift events) is intentional:
    // it auto-recovers when the user finally restarts (poll observes the
    // false → true → false transition) without needing a separate "recovered"
    // event. 5s is fast enough to surface within one user turn, slow enough
    // not to thrash file IO walking body/*.py.
    const driftInterval = setInterval(() => {
      const stale = replHandle.bridge.isBodyStale();
      if (stale === null) return; // not yet captured
      setBodyStale(prev => prev === stale ? prev : stale);
    }, 5000);
    return () => {
      replHandle.bridge.setOnSay(null);
      replHandle.bridge.setOnAsk(null);
      clearInterval(driftInterval);
    };
  }, [replHandle]);

  // ── Model picker handlers ──────────────────────────────────────────
  const handleModelSelect = useCallback((model: string, effort: EffortLevel) => {
    try {
      router.setModel(`${model} ${effort}`);
      session.updateMeta({ model: router.info.model });
      session.log({
        type: 'model_selected',
        provider: router.info.name,
        model: router.info.model,
        effort: router.info.effort,
        shortcut: router.info.shortcut,
        timestamp: Date.now(),
      });
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

    // Always save approved plan to .aries/plans/ before clearing temp file.
    // Prevents data loss if model re-enters plan mode or tempdir is cleaned.
    if (planFilePathRef.current) {
      try {
        const plansDir = join(cwd, '.aries', 'plans');
        mkdirSync(plansDir, { recursive: true });
        const dest = join(plansDir, basename(planFilePathRef.current));
        copyFileSync(planFilePathRef.current, dest);
        // Only show "saved" message if mode wasn't already 'save_plan' (which shows its own)
        if (mode !== 'save_plan') {
          setDisplayMessages(prev => [...prev, {
            role: 'system',
            text: `${figures.planMode} Plan archived to ${dest}`,
            subtype: 'info',
          }]);
        }
      } catch { /* copy error — temp file still exists */ }
    }

    if (mode === 'clear_context' && planFilePathRef.current) {
      try {
        const plan = readFileSync(planFilePathRef.current, 'utf-8');
        messagesRef.current = [{ role: 'user', content: `Implement this plan:\n\n${plan}` }];
        setDisplayMessages([{ role: 'system', text: 'Context cleared. Plan injected as first message.', subtype: 'info' }]);
      } catch { /* file read error — fall through */ }
    }

    if (mode === 'save_plan' && planFilePathRef.current) {
      // save_plan already archived above — just show explicit "saved" message
      try {
        const dest = join(cwd, '.aries', 'plans', basename(planFilePathRef.current));
        setDisplayMessages(prev => [...prev, {
          role: 'system',
          text: `${figures.planMode} Plan saved to ${dest}`,
          subtype: 'info',
        }]);
      } catch { /* ignore */ }
    }

    const nextMode = mode === 'accept_edits' ? 'accept' as PermissionMode : prePlanModeRef.current;
    permissionModeRef.current = nextMode; // sync ref immediately so running loop reads new mode
    setPermissionMode(nextMode);
    planFilePathRef.current = null;
    setDisplayMessages(prev => [...prev, {
      role: 'system',
      text: `${figures.autoMode} Plan approved — now in ${nextMode} mode.`,
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

  // â”€â”€ Input queue â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Accumulates messages typed while the model is running. The ref holds
  // raw strings; pendingCount is display-facing for the queued indicator.
  const handleQueue = useCallback((text: string) => {
    pendingInputRef.current.push(text);
    setPendingCount(pendingInputRef.current.length);
  }, []);

  // ── Mid-turn steering queue (2026-05-01) ───────────────────────────────
  // Distinct from pendingInputRef:
  //   - pendingInput: typed input becomes a NEW user submission AFTER
  //     this agentLoop returns (handleSubmit recursion at L716-720).
  //     Restarts the conversational arc — fresh turn, no goal context.
  //   - steeringQueueRef: typed input drains at the TOP of the next loop
  //     iteration INSIDE this agentLoop. Same goal context preserved;
  //     model sees the steer as a user message between assistant turns.
  //
  // Mid-stream abort+reinject (Pi's pattern) is NOT done here yet —
  // requires per-turn abort controllers since AbortSignal is single-use.
  // Steering takes effect at the next natural turn boundary instead.
  // Still meaningful: when the loop runs many turns (goal pursuit, tool-
  // call chains), the user can redirect WITHOUT restarting the goal.
  // Mid-stream interrupt is a future enhancement.
  const steeringQueueRef = useRef<string[]>([]);
  const [steerCount, setSteerCount] = useState(0);
  const handleSteer = useCallback((text: string) => {
    steeringQueueRef.current.push(text);
    setSteerCount(steeringQueueRef.current.length);
  }, []);

  // Reset the compose-sub-loop mode indicator when the request loop ends.
  // Triggers on the isLoading true→false transition (any path: completion,
  // abort, error). Initial render has prev=false / isLoading=false so the
  // condition stays false until a real request runs first.
  useEffect(() => {
    if (prevIsLoadingRef.current && !isLoading) {
      setCurrentRequestMode(null);
    }
    prevIsLoadingRef.current = isLoading;
  }, [isLoading]);

  // The loop drains steeringQueueRef when it picks up the messages (mid-batch
  // checkSteering or top-of-iteration drain). Sync the React-visible counter
  // back down on a timer so the status pill clears when the loop consumed
  // the queue. Cheap polling — fires only while the count is non-zero.
  useEffect(() => {
    if (steerCount === 0) return;
    const t = setInterval(() => {
      const live = steeringQueueRef.current.length;
      if (live !== steerCount) setSteerCount(live);
    }, 250);
    return () => clearInterval(t);
  }, [steerCount]);

  // ── Handle user input ───────────────────────────────────────────────
  const handleSubmit = useCallback(async (input: string, images?: AttachedImage[]) => {
    const trimmed = input.trim();
    if (!trimmed && !images?.length) return;

    // ── Slash commands ──────────────────────────────────────────────
    // Slash commands are dispatched BEFORE mode classification because
    // /compose, /quick, /goal etc. transform input into a #-prefixed string
    // and re-enter handleSubmit (e.g. /compose foo → handleSubmit("#compose foo")).
    // The classifier picks up that prefix on the second pass.
    if (trimmed.startsWith('/')) {
      await handleSlashCommand(trimmed);
      return;
    }

    // ── Compose sub-loop: classify mode, generate request id ────────
    // The classifier strips any #compose / #quick / #goal marker and
    // returns the mode + cleaned text. The model never sees the marker —
    // it's a harness-only signal. For goal mode we still wrap with the
    // legacy buildGoalModePrompt for now; the full Codex-style goal
    // runtime ships in a later tier and replaces that path entirely.
    const classification = classifyRequestMode(trimmed);
    const requestId = newRequestId();
    setCurrentRequestMode(classification.mode);
    session.log({
      type: 'request_mode_selected' as any,
      request_id: requestId,
      mode: classification.mode,
      reason: classification.reason,
      matched_trigger: classification.matchedTrigger,
      input_chars: trimmed.length,
      timestamp: Date.now(),
    } as any);
    const modelInput = classification.mode === 'goal'
      ? buildGoalModePrompt(classification.cleanedText)
      : classification.cleanedText;

    // ── Compose sub-loop: instantiate controller for this request ─────
    // The controller is the in-memory state machine for the gate. It
    // parses <compose_preflight> / <compose_update> blocks out of the
    // model's text and decides whether the next Repl call may execute.
    // Lives only for this request — discarded when handleSubmit returns.
    // onEvent forwards telemetry to the session log so bench rollups can
    // measure preflight coverage, gate rejections, scout overruns, etc.
    const composeController = new ComposeController({
      mode: classification.mode,
      requestId,
      onEvent: (e) => session.log({ ...e, timestamp: Date.now() } as any),
    });
    const activeReplHandle = getReplHandle?.() ?? replHandle;
    const isComposeRequest = classification.mode === 'compose' || classification.mode === 'goal';

    // ── Compose substrate: configure body for this request, create scratch ──
    // The body needs session_id + request_id to compute the per-request
    // scratch markdown path. We re-configure on every submit (cheap op,
    // ~2ms) so the body always knows which request scope is active. For
    // compose/goal mode we also fire scratch_start to materialize the file
    // with the user request pre-filled. Quick mode skips scratch creation.
    if (activeReplHandle?.bridge) {
      try {
        await activeReplHandle.bridge.configure({
          sessionId: session.sessionId,
          requestId,
          composeMode: classification.mode,
        });
        if (isComposeRequest) {
          const intent = classification.cleanedText.split(/\r?\n/, 1)[0]?.slice(0, 120) ?? '';
          await activeReplHandle.bridge.composeStart({
            intent,
            userRequest: classification.cleanedText,
            mode: classification.mode === 'goal' ? 'goal' : 'compose',
          });
          session.log({
            type: 'scratch_created' as any,
            request_id: requestId,
            mode: classification.mode,
            intent_chars: intent.length,
            timestamp: Date.now(),
          } as any);
        }
      } catch (err) {
        // Scratch creation is best-effort — never block the request on it.
        // The body footer will show "scratch: (none)" and the gate (Tier 3)
        // will fall back to no-op when no scratch exists.
        session.log({
          type: 'scratch_setup_error' as any,
          request_id: requestId,
          error: (err as Error)?.message ?? String(err),
          timestamp: Date.now(),
        } as any);
      }
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
          ...(modelInput ? [{ type: 'text' as const, text: modelInput }] : []),
          ...images!.map(img => ({
            type: 'image' as const,
            source: {
              type: 'base64' as const,
              media_type: img.mediaType,
              data: img.base64,
            },
          })),
        ]
      : modelInput;

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
    composeDisplayFilterRef.current.reset();
    if (flushTimerRef.current) { clearTimeout(flushTimerRef.current); flushTimerRef.current = null; }

    // 2026-05-01: 'cerebral' mode prefix injection removed. The prefix told
    // the model "Execute directly. Zero narration. Tool calls only." — which
    // suppressed both narration AND thinking, despite the name. With adaptive
    // thinking now enabled (anthropic.ts), the model self-regulates reasoning
    // depth; we no longer need a per-turn prefix to fight that.
    messagesRef.current.push({ role: 'user', content: contentBlocks });
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

      // Loop3 is the default interactive runtime as of 2026-05-06. Architecture:
      // single Repl tool, code-only action surface, all discovery/edits go through
      // Python primitives. Bench (bench/2026-04 head-to-head, 3/3 wins, 30-60%
      // wall-clock improvement) validated Loop3 vs Loop2 in headless mode; flipping
      // the interactive default here so daily-driver use lands on Loop3 too.
      // Legacy loop (the original `agentLoop` from src/loop.ts with 14+ top-level
      // tools — Read/Edit/Bash/Grep/Glob/Web*/Vault*/Project*) stays available as
      // an opt-out via ARIES_LEGACY_LOOP=1 for fallback while we shake out Loop3
      // friction in interactive mode. Loop2 was never supported in interactive.
      const useLoop3Interactive = process.env.ARIES_LEGACY_LOOP !== '1';
      const buildLoopSystemPrompt = async (): Promise<SystemPromptInput> => {
        if (!isComposeRequest) return systemPrompt;
        let scratchContent = '';
        let scratchError: string | undefined;
        let verificationFilled = false;
        const bridge = (getReplHandle?.() ?? activeReplHandle)?.bridge;
        if (bridge) {
          try {
            const scratch = await bridge.composeRead();
            scratchContent = scratch.content ?? '';
            scratchError = scratch.error;
            verificationFilled = Array.isArray(scratch.status?.sections_filled)
              && scratch.status.sections_filled.includes('verification');
          } catch (err) {
            scratchError = err instanceof Error ? err.message : String(err);
          }
        } else {
          scratchError = 'bridge unavailable';
        }
        return buildComposeRequestSystemPrompt(systemPrompt, {
          mode: classification.mode === 'goal' ? 'goal' : 'compose',
          requestId,
          scratchContent,
          scratchError,
          verificationFilled,
        });
      };
      const loop = useLoop3Interactive
        ? agentLoop3({
          messages: messagesRef.current,
          systemPrompt: buildLoopSystemPrompt,
          adapter: new AnthropicToolUseAdapter(router),
          replHandle: activeReplHandle,
          session,
          estimateTokens: (m) => router.current.estimateTokens(m),
          signal: abort.signal,
          permissionMode: permissionModeRef.current,
          permissionModeRef,
          alwaysAllowTools: alwaysAllowRef.current,
          onPermissionRequest: (tc: ToolCall) => {
            return new Promise<PermissionDecision>((resolve) => {
              setPendingPermission({ toolCall: tc, resolve });
            });
          },
          composeController,
        })
        : agentLoop({
        messages: messagesRef.current,
        systemPrompt: await buildLoopSystemPrompt(),
        router,
        registry,
        toolContext: { cwd, signal: abort.signal },
        vault,
        projectBrain,
        session,
        hooks,
        signal: abort.signal,
        // Read from the ref, not the closure — captures mode flips that
        // happened in the same synchronous event handler (e.g. /research).
        permissionMode: permissionModeRef.current,
        permissionModeRef, // live ref — loop re-reads each turn for mid-loop mode changes (ExitPlanMode)
        alwaysAllowTools: alwaysAllowRef.current,
        identityContext: identityCtx,
        dynamicTools: true,
        planFilePathRef,
        taskMode,
        steeringQueueRef, // mid-turn user input for steer-and-reinject
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
        const uiEvents = useLoop3Interactive ? mapLoop3EventToLoopEvents(event as Loop3Event) : [event as LoopEvent];
        for (const uiEvent of uiEvents) {
        handleLoopEvent(uiEvent, (text) => {
          fullText += text;
          if (displayMode === 'quiet') {
            if (uiEvent.type === 'text') {
              displayText2 += text;
            }
          } else {
            displayText2 += text;
            bufferText(text);
          }
        });
        if (uiEvent.type === 'tool_call') {
          hasSeenToolCall = true;
          if (displayMode === 'quiet') {
            displayText2 = '';
          }
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

    // ── Compose substrate: close the per-request scratch markdown ────
    // Idempotent — body's scratch.close no-ops when no file exists. We
    // fire on every request termination path (normal, error, abort) by
    // running this after the try/catch. Quick mode never had a scratch
    // open so the close is a cheap no-op there. The body sweeper handles
    // any file that survives a CLI crash via 24h orphan cleanup.
    if (activeReplHandle?.bridge && isComposeRequest) {
      try {
        await activeReplHandle.bridge.composeClose();
        const composeTelemetry = composeController.telemetry();
        session.log({
          type: 'scratch_closed' as any,
          request_id: requestId,
          mode: classification.mode,
          terminated_via: interrupted ? 'abort' : (fullText.includes('\n\nError:') ? 'error' : 'natural'),
          ...composeTelemetry,
          timestamp: Date.now(),
        } as any);
      } catch (err) {
        session.log({
          type: 'scratch_close_error' as any,
          request_id: requestId,
          error: (err as Error)?.message ?? String(err),
          timestamp: Date.now(),
        } as any);
      }
    }
    // Always log request_completed regardless of mode so bench rollups can
    // count quick vs compose requests, average cells/turns per request, etc.
    session.log({
      type: 'request_completed' as any,
      request_id: requestId,
      mode: classification.mode,
      terminated_via: interrupted ? 'abort' : (fullText.includes('\n\nError:') ? 'error' : 'natural'),
      ...composeController.telemetry(),
      timestamp: Date.now(),
    } as any);
    // Clear queued messages on abort â€” they were typed for a turn that was
    // interrupted; firing them into the next unrelated turn would be wrong.
    pendingInputRef.current = [];
    setPendingCount(0);

    // Finalize: flush any remaining buffered text, then clear stream
    // Finalize: flush any remaining buffered text, then clear stream
    if (flushTimerRef.current) { clearTimeout(flushTimerRef.current); flushTimerRef.current = null; }
    textBufferRef.current = '';
    // Capture segments before clearing — used to preserve tool calls in display history
    const completedSegments = compactSegmentsForHistory(segmentsRef.current);
    setStreamSegments([]);
    segmentsRef.current = [];
    setIsLoading(false);
    setTitleDone(agentName, cwd);
    flashTaskbar();
    setActiveTool(undefined);

    // Drain the input queue â€” all messages typed during this turn arrive as
    // one combined user message. Join with newline so the model sees them
    // as a single coherent block, not separate requests.
    if (pendingInputRef.current.length > 0) {
      const combined = pendingInputRef.current.join('\n');
      pendingInputRef.current = [];
      setPendingCount(0);
      handleSubmit(combined);
    }

    // Track turns and update session metadata
    turnCountRef.current++;
    const userMsgCount = messagesRef.current.filter(m => m.role === 'user').length;
    const totals = trackerRef.current.totals;
    session.touch(userMsgCount, totals.cost);

      if (fullText) {
      // In quiet mode, only show the final text block (after last tool call)
      const shownText = displayMode === 'quiet' ? displayText2.trim() : fullText;
      // Preserve segments (tool calls + text) if the turn had tool calls, so they persist in history
      const hasToolCalls = completedSegments.some(s => s.type === 'tool' || s.type === 'thinking');
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
      case 'text': {
        const displayText = composeDisplayFilterRef.current.push(event.content);
        if (displayText) appendText(displayText);
        break;
      }

      case 'thinking': {
        // 2026-05-01: Extended thinking blocks rendered as dim italic text
        // above the response. Uses the same segment/buffer pattern as text
        // but with a 'thinking' segment type.
        const segs = [...segmentsRef.current];
        const last = segs[segs.length - 1];
        if (last && last.type === 'thinking') {
          segs[segs.length - 1] = { type: 'thinking', content: last.content + event.content };
        } else {
          segs.push({ type: 'thinking', content: event.content });
        }
        segmentsRef.current = segs;
        setStreamSegments(segs);
        break;
      }

      case 'tool_call': {
        // Flush any buffered text so it appears BEFORE the tool in the timeline
        if (flushTimerRef.current) { clearTimeout(flushTimerRef.current); flushTimerRef.current = null; }
        if (textBufferRef.current) {
          const buffered = textBufferRef.current;
          textBufferRef.current = '';
          const segs = [...segmentsRef.current];
          const last = segs[segs.length - 1];
          if (last && last.type === 'text') {
            segs[segs.length - 1] = { type: 'text', content: last.content + buffered };
          } else {
            segs.push({ type: 'text', content: buffered });
          }
          segmentsRef.current = segs;
          setStreamSegments(segs);
        }
        const tc = event.toolCall;
        const summary = getToolSummary(tc.name, tc.input);
        const displayName = getToolDisplayName(tc.name, tc.input);
        toolTimingRef.current.set(tc.id, Date.now());
        activeToolIdRef.current = tc.id;
        const toolData: DisplayToolCall = {
          id: tc.id, name: displayName, summary, resolved: false, isError: false,
        };
        {
          const next: StreamSegment[] = [...segmentsRef.current, { type: 'tool', data: toolData }];
          segmentsRef.current = next;
          setStreamSegments(next);
        }
        setActiveTool(tc.name);
        break;
      }

      case 'tool_result': {
        const preview = formatToolResult(event.name, event.output, event.isError);
        const startTime = toolTimingRef.current.get(event.id);
        const durationMs = startTime ? Date.now() - startTime : undefined;
        toolTimingRef.current.delete(event.id);
        if (activeToolIdRef.current === event.id) activeToolIdRef.current = null;
        const next = segmentsRef.current.map(seg =>
          seg.type === 'tool' && seg.data.id === event.id
            ? { ...seg, data: { ...seg.data, resolved: true, isError: event.isError, resultPreview: preview, durationMs } }
            : seg
        );
        segmentsRef.current = next;
        setStreamSegments(next);
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

      case 'tool_denied': {
        if (activeToolIdRef.current === event.id) activeToolIdRef.current = null;
        const next = segmentsRef.current.map(seg =>
          seg.type === 'tool' && seg.data.id === event.id
            ? { ...seg, data: { ...seg.data, resolved: true, isError: true, resultPreview: 'Denied by user' } }
            : seg
        );
        segmentsRef.current = next;
        setStreamSegments(next);
        setActiveTool(undefined);
        break;
      }

      case 'plan_step': {
        const next: StreamSegment[] = [...segmentsRef.current, {
          type: 'tool',
          data: {
            id: event.toolCall.id,
            name: getToolDisplayName(event.toolCall.name, event.toolCall.input),
            summary: getToolSummary(event.toolCall.name, event.toolCall.input),
            resolved: false,
            isError: false,
            resultPreview: '(plan — not executed)',
          },
        }];
        segmentsRef.current = next;
        setStreamSegments(next);
        break;
      }

      case 'plan_complete':
        setDisplayMessages(prev => [...prev, {
          role: 'system',
          text: `Plan complete: ${event.steps.length} steps proposed. Enter to execute, or refine.`,
          subtype: 'info',
        }]);
        break;

      // echo_fizzle UI case removed 2026-04-21 — echoFizzle.ts deleted
      // (dead plumbing from preflight era); event type also removed from
      // loop.ts. No producer means the case was unreachable.

      case 'max_output_recovery':
        // Max-tokens recovery: model was cut off, harness is auto-continuing.
        // Brief inline indicator so the user knows the pause is intentional.
        appendText(`\n\n*(Continuing... ${event.attempt}/${event.maxAttempts})*\n\n`);
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

      case 'turn_complete':
        // Patch the most recent telemetry record with tool call data.
        // usage event (which drove recordTurn) fires during streaming before
        // tools execute; turn_complete fires after, so tool names + cell counts
        // are available. 2026-05-03: added toolCallCount, toolNames, replCellCount.
        trackerRef.current.patchLastTurn(event.toolCallCount, event.toolNames, event.replCellCount);
        // Use the locally-computed tokenEstimate for context utilization display.
        // The API's usage.totalTokens returns 1 on OAuth/subscription auth (Anthropic
        // doesn't report real counts for Max plan users), making the status bar
        // show 0%. tokenEstimate comes from estimateTokens(messages) in loop.ts â€”
        // a local word-count heuristic that works regardless of auth method.
        // 2026-05-03: fixes 0%/1.0M status bar on OAuth.
        setTokenCount(event.tokenEstimate);
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

    // Convert resumed messages into display messages so the user sees prior conversation
    const historyDisplay: DisplayMessage[] = [{
      role: 'system',
      text: `Resumed: ${label} (${resumed.length} messages)`,
      subtype: 'info',
    }];
    for (const msg of resumed) {
      if (msg.role === 'user') {
        const text = typeof msg.content === 'string'
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content
                .filter((b: any) => b.type === 'text')
                .map((b: any) => b.text)
                .join('\n')
            : '';
        // Skip tool_result-only user messages and compaction markers
        if (text && !text.startsWith('<compaction-summary>')) {
          historyDisplay.push({ role: 'user', text });
        }
      } else if (msg.role === 'assistant') {
        const text = typeof msg.content === 'string'
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content
                .filter((b: any) => b.type === 'text')
                .map((b: any) => b.text)
                .join('\n')
            : '';
        if (text) {
          historyDisplay.push({ role: 'assistant', text: renderComposeBlocksForDisplay(text) });
        }
      }
    }
    setDisplayMessages(historyDisplay);
  }, [session]);

  // ── Slash commands ──────────────────────────────────────────────────
    const handleSlashCommand = useCallback(async (input: string) => {
    const [cmd, ...rest] = input.split(/\s+/);
    const arg = rest.join(' ');

    switch (cmd) {
      case '/exit':
      case '/quit':
        await runHooks('stop', hooks, { cwd, vaultPath: vault?.vaultPath });
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
        if (arg && ['max', 'high', 'medium', 'low'].includes(arg)) {
          router.setEffort(arg as EffortLevel);
          setDisplayMessages(prev => [...prev, {
            role: 'assistant', text: `Effort: ${arg}`,
          }]);
        } else {
          setDisplayMessages(prev => [...prev, {
            role: 'assistant', text: `**Effort:** ${router.effort}\n**Usage:** /effort max, /effort high, /effort medium, /effort low`,
          }]);
        }
        break;

      case '/mode': {
        // Research mode is intentionally omitted — enter via /research <query> only.
        const MODES: PermissionMode[] = ['default', 'accept', 'plan', 'yolo'];
        const MODE_DESC: Record<PermissionMode, string> = {
          default: 'Prompt for write tools',
          accept: 'Auto-approve edits, prompt for Bash',
          plan: 'Read-only planning with spec pass',
          research: 'Research mode — enter via /research <query>',
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
          // Plan tools already registered at mount — just switch mode
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

      case '/goal':
        if (!arg.trim()) {
          setDisplayMessages(prev => [...prev, {
            role: 'assistant',
            text: '**Usage:** `/goal <goal>`\n\nStarts Loop3 goal mode: refine intent, call spanner.escalate(), create a layered plan with phase-level composition, then execute through Repl.',
          }]);
        } else {
          handleSubmit(`#goal ${arg.trim()}`);
        }
        break;

      case '/compose':
        // Force compose mode for the next request: scratch doc + preflight
        // gate active. Sometimes the auto-router misclassifies an ambiguous
        // request as quick; this slash forces compose. The #compose prefix
        // is stripped by classifyRequestMode so the model never sees it.
        if (!arg.trim()) {
          setDisplayMessages(prev => [...prev, {
            role: 'assistant',
            text: '**Usage:** `/compose <task>`\n\nForces compose mode for this request: a temporary request scratch is created, preflight is required before each Repl, and updates are required between Repls. Use this when the auto-router would otherwise route to quick mode.',
          }]);
        } else {
          handleSubmit(`#compose ${arg.trim()}`);
        }
        break;

      case '/quick':
        // Force quick mode for the next request: no scratch, no preflight,
        // no gate. For when you want a fast direct answer without the
        // composition ceremony — even if the auto-router would default to
        // compose. The #quick prefix is stripped by classifyRequestMode.
        if (!arg.trim()) {
          setDisplayMessages(prev => [...prev, {
            role: 'assistant',
            text: '**Usage:** `/quick <question>`\n\nForces quick mode for this request: no scratch, no preflight gate, default Loop3 behavior. Use for trivial questions when the auto-router would otherwise route to compose.',
          }]);
        } else {
          handleSubmit(`#quick ${arg.trim()}`);
        }
        break;

      case '/headless': {
        const task = arg.trim();
        if (!task) {
          setDisplayMessages(prev => [...prev, {
            role: 'assistant',
            text: '**Usage:** `/headless <task>`\n\nRuns a separate headless Aries session using the same compose-loop architecture as the bench path. The child session has its own request scratch, gate telemetry, and session log; this UI shows the final result when it exits.',
          }]);
          break;
        }
        if (isLoadingRef.current) {
          setDisplayMessages(prev => [...prev, {
            role: 'assistant',
            text: 'A request is already running. Stop it or wait for it to finish before launching a headless child session.',
          }]);
          break;
        }

        const startedAt = Date.now();
        const { spawn } = await import('node:child_process');
        const invocation = buildHeadlessChildInvocation(task);
        setIsLoading(true);
        setActiveTool('headless');
        setTitleBusy(agentName, cwd);
        setDisplayMessages(prev => [...prev, {
          role: 'system',
          text: `Headless session started: ${task.slice(0, 140)}`,
          subtype: 'info',
        }]);

        let stdout = '';
        let stderr = '';
        const child = spawn(invocation.command, invocation.args, {
          cwd,
          env: { ...process.env, ARIES_HEADLESS: '1' },
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        child.stdout?.on('data', chunk => { stdout += chunk.toString(); });
        child.stderr?.on('data', chunk => { stderr += chunk.toString(); });

        const result = await new Promise<{ code: number | null; error: Error | null }>((resolve) => {
          child.once('error', error => resolve({ code: null, error }));
          child.once('close', code => resolve({ code, error: null }));
        });
        const code = result.code;
        const elapsed = Date.now() - startedAt;
        setIsLoading(false);
        setActiveTool(undefined);
        setTitleDone(agentName, cwd);

        if (result.error) {
          const message = result.error.message;
          setDisplayMessages(prev => [...prev, {
            role: 'system',
            text: `Headless session failed to start: ${message}`,
            subtype: 'error',
          }]);
          break;
        }

        const output = capHeadlessText(stdout || '(no output)');
        const errText = capHeadlessText(stderr);
        const statusLine = `Headless exited code=${code ?? 'unknown'} wall=${formatDuration(elapsed)}`;
        setDisplayMessages(prev => [
          ...prev,
          {
            role: code === 0 ? 'system' : 'assistant',
            text: code === 0
              ? `${statusLine}\n\n${output}`
              : `${statusLine}\n\n${output}${errText ? `\n\nstderr:\n\`\`\`\n${errText}\n\`\`\`` : ''}`,
            subtype: code === 0 ? 'info' : 'error',
          },
        ]);
        break;
      }

      case '/scratch': {
        const subcommand = arg.trim() || 'show';
        if (subcommand !== 'show') {
          setDisplayMessages(prev => [...prev, {
            role: 'assistant',
            text: '**Usage:** `/scratch show`',
          }]);
          break;
        }

        const handle = getReplHandle?.() ?? replHandle;
        if (!handle?.bridge) {
          setDisplayMessages(prev => [...prev, {
            role: 'assistant',
            text: 'Scratch unavailable: REPL bridge is not running.',
          }]);
          break;
        }

        try {
          const status = await handle.bridge.composeStatus();
          if (!status.active) {
            setDisplayMessages(prev => [...prev, {
              role: 'assistant',
              text: '**Scratch:** inactive',
            }]);
            break;
          }
          const read = await handle.bridge.composeRead();
          const content = read.content?.trimEnd() || '(empty)';
          const pathLine = status.path ? `\n**Path:** \`${status.path}\`` : '';
          setDisplayMessages(prev => [...prev, {
            role: 'assistant',
            text: `**Scratch:** active${pathLine}\n\n\`\`\`markdown\n${content}\n\`\`\``,
          }]);
        } catch (err) {
          setDisplayMessages(prev => [...prev, {
            role: 'assistant',
            text: `**Scratch error:** ${(err as Error).message}`,
          }]);
        }
        break;
      }

      case '/execute':
        // Quick exit from plan mode → execute
        if (permissionMode === 'plan') {
          // Force exit to accept mode
          setPermissionMode('accept');
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

      case '/research': {
        // The only entry point to research mode. Dispatches runResearch
        // directly (no LLM-in-the-loop orchestration) and renders a journal.
        if (researchRunning) {
          setDisplayMessages(prev => [...prev, {
            role: 'system',
            text: 'A research run is already in progress. Press Ctrl+C to abort it first.',
            subtype: 'info',
          }]);
          break;
        }
        if (!arg || !arg.trim()) {
          setDisplayMessages(prev => [...prev, {
            role: 'assistant',
            text: '**Usage:** `/research <query> [--depth quick|standard|deep|exhaustive]`\n\nLaunches the curated research engine across arxiv, semantic scholar, openalex, github, wikipedia, reddit, and exa. Default depth is standard. No --depth needed. WebSearch/WebFetch are stripped for the duration; the pipeline runs on your behalf and the model summarizes the artifact at the end.',
          }]);
          break;
        }
        let depth: ResearchDepth = 'standard';
        let query = arg.trim();
        const depthMatch = query.match(/\s--depth\s+(quick|standard|deep|exhaustive)\b/);
        if (depthMatch) {
          depth = depthMatch[1] as ResearchDepth;
          query = query.replace(depthMatch[0], '').trim();
        }
        if ((query.startsWith('"') && query.endsWith('"')) || (query.startsWith("'") && query.endsWith("'"))) {
          query = query.slice(1, -1);
        }

        // Flip permission mode — model follow-ups after the run stay restricted.
        preResearchModeRef.current = permissionMode;
        permissionModeRef.current = 'research';
        setPermissionMode('research');

        // Set up the run
        const outputDir = vault?.vaultPath
          ? join(vault.vaultPath, 'research')
          : join(cwd, 'research');
        const fetchFn = async (url: string): Promise<string> => {
          try {
            const r = await fetch(`https://r.jina.ai/${url}`, {
              headers: { Accept: 'text/markdown' },
              signal: AbortSignal.timeout(25_000),
            });
            return r.ok ? await r.text() : '';
          } catch {
            return '';
          }
        };
        const abortCtrl = new AbortController();
        researchAbortRef.current = abortCtrl;
        setResearchRunning(true);

        // Fire-and-forget — the journal component handles live rendering via
        // the event callback. When done, we push a directive and kick a model
        // turn to summarize the artifact.
        runResearch(query, depth, router, {
          fetchFn,
          outputDir,
          onEvent: (event) => {
            researchJournalRef.current?.push(event);
          },
          signal: abortCtrl.signal,
        }).then(result => {
          setResearchRunning(false);
          researchAbortRef.current = null;
          // Give the journal a beat to render the final save_done event.
          setTimeout(() => {
            const directive = `The research run finished. Artifact: ${result.artifactDir}\n\nRead \`${result.artifactDir}/report.md\` and give me a conversational summary — the key patterns, contradictions, and gaps you found. Quote findings with their source titles when you do. After the summary, ask if I want to go deeper on any thread or if we're done.`;
            handleSubmit(directive);
          }, 1200);
        }).catch(err => {
          setResearchRunning(false);
          researchAbortRef.current = null;
          const msg = (err as Error)?.message ?? String(err);
          setDisplayMessages(prev => [...prev, {
            role: 'system',
            text: `Research run failed: ${msg}`,
            subtype: 'error',
          }]);
        });
        break;
      }

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

        if (arg === 'week' || arg === 'history') {
          // ── Historical view: last 7 days ──
          const now = new Date();
          const weekAgo = new Date(now);
          weekAgo.setDate(weekAgo.getDate() - 6);
          const fmt = (d: Date) => d.toISOString().slice(0, 10);
          const range = UsageTracker.aggregateRange(fmt(weekAgo), fmt(now));

          const daysActive = range.days.length;
          const modelTotals: Record<string, { turns: number; cost: number }> = {};
          for (const day of range.days) {
            // Reload per-day records to get model breakdown
            const records = UsageTracker.loadDay(day.date);
            for (const r of records) {
              if (!modelTotals[r.model]) modelTotals[r.model] = { turns: 0, cost: 0 };
              modelTotals[r.model].turns++;
              modelTotals[r.model].cost += r.costEstimate;
            }
          }

          const modelLines = Object.entries(modelTotals)
            .sort((a, b) => b[1].cost - a[1].cost)
            .map(([model, data]) =>
              `  ${model.slice(0, 22).padEnd(22)} ${String(data.turns).padStart(5)} turns  ${formatCost(data.cost).padStart(9)}`
            ).join('\n');

          const dailyLines = range.days.map(d => {
            const label = new Date(d.date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            const heaviest = d.cost === Math.max(...range.days.map(x => x.cost)) ? ' ← heaviest' : '';
            return `  ${label.padEnd(6)} ${String(d.turns).padStart(5)} turns  ${formatCost(d.cost).padStart(9)}${heaviest}`;
          }).join('\n');

          const text = [
            `**Usage — Last 7 Days**`,
            '',
            '```',
            `  Days active: ${daysActive}/7`,
            `  Total turns: ${range.total.turns.toLocaleString()}`,
            `  Total input:  ${formatTokenCount(range.total.input).padStart(8)} tokens`,
            `  Total output: ${formatTokenCount(range.total.output).padStart(8)} tokens`,
            `  Total cost:   ${formatCost(range.total.cost).padStart(8)}`,
            '```',
            '',
            '**By model:**',
            '```',
            modelLines || '  (no data)',
            '```',
            '',
            '**Daily:**',
            '```',
            dailyLines || '  (no data)',
            '```',
          ].join('\n');

          setDisplayMessages(prev => [...prev, { role: 'assistant', text }]);
          break;
        }

        // ── Default: current session ──
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
          '',
          `Use \`/cost week\` for 7-day history`,
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
        const modes: DisplayMode[] = ['verbose', 'normal', 'quiet'];
        if (arg && modes.includes(arg as DisplayMode)) {
          setDisplayMode(arg as DisplayMode);
          setDisplayMessages(prev => [...prev, {
            role: 'system', text: `Display mode: ${arg}`, subtype: 'info',
          }]);
        } else {
          // Cycle: verbose → normal → quiet → verbose
          const nextIdx = (modes.indexOf(displayMode) + 1) % modes.length;
          const next = modes[nextIdx]!;
          setDisplayMode(next);
          setDisplayMessages(prev => [...prev, {
            role: 'system', text: `Display mode: ${next}`, subtype: 'info',
          }]);
        }
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
            setIndexedFiles(r.file_count);
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
              setIndexedFiles(idx.file_count);
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
- \`/effort max|high|medium|low\` — change effort level
- \`/cost\` — token usage
- \`/tools\` — list tools
- \`/vault\` — vault status
- \`/brain\` — project brain
- \`/compose <task>\` — force compose mode for a real-work request
- \`/quick <question>\` — force quick mode for a trivial question
- \`/headless <task>\` — launch a separate compose-wired headless session
- \`/scratch show\` — show the active compose request scratch
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
  }, [vault, projectBrain, router, registry, tokenCount, vaultNoteCount, replHandle, getReplHandle]);

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
        {/* Research journal — visible only during a /research run */}
        {researchRunning && <ResearchJournal handleRef={researchJournalRef} />}

        <Messages
          messages={[]}
          streamSegments={streamSegments}
          isStreaming={isLoading}
        />

        {/* Spinner */}
        <Spinner isLoading={isLoading || researchRunning} activeTool={researchRunning ? 'research' : activeTool} hasStreamingText={streamSegments.some(s => s.type === 'text')} />
      </Box>

      {/* Pinned bottom: model picker OR input + status */}
      <Box flexDirection="column" flexShrink={0} marginTop={1}>
        {/* Permission dialog takes priority over everything */}
        {/* Dialogs in priority order: plan exit > permission > ask > resume > model picker > input */}
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
        ) : pendingAsk && replHandle ? (
          // ask() from Python is currently blocking inside a Repl exec; the
          // Python thread is parked on a threading.Event waiting for us to
          // call resolveAsk. Priority is right under permission because both
          // are cases of "the agent cannot proceed until the user responds."
          <AskDialog
            question={pendingAsk.question}
            onSubmit={(answer) => {
              session.log({
                type: 'loop3_ask',
                phase: 'resolved',
                id: pendingAsk.id,
                answer_chars: answer.length,
                timestamp: Date.now(),
              });
              replHandle.bridge.resolveAsk(pendingAsk.id, answer);
              setPendingAsk(null);
            }}
            onCancel={() => {
              // Cancel contract is empty string, not a sentinel. The model
              // can branch on `if not answer:` to detect user refusal. See
              // body/speak.py ask() docstring for the Python-side guarantee.
              session.log({
                type: 'loop3_ask',
                phase: 'cancelled',
                id: pendingAsk.id,
                answer_chars: 0,
                timestamp: Date.now(),
              });
              replHandle.bridge.resolveAsk(pendingAsk.id, '');
              setPendingAsk(null);
            }}
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
            currentModel={
              // Prefer the active shortcut name (e.g. "opus-sub") so the picker
              // opens to the correct family. Fall back to model-id heuristics
              // for the initial state before any explicit switch.
              router.info.shortcut
              ?? (router.info.model.includes('opus') ? 'opus'
                : router.info.model.includes('sonnet') ? 'sonnet'
                : router.info.model.includes('haiku') ? 'haiku'
                : router.info.model.includes('gemini-2.5-pro') ? 'gemini'
                : router.info.model.includes('flash') ? 'flash'
                : router.info.model === 'gpt-5.4' ? 'gpt-5.4'
                : router.info.model === 'gpt-5.4-mini' ? 'gpt-5.4-mini'
                : router.info.model === 'gpt-5.3-codex' ? 'gpt-5.3'
                : router.info.model === 'gpt-5.2' ? 'gpt-5.2'
                : router.info.model === 'gpt-5' ? 'gpt5'
                : router.info.model === 'gpt-4o' ? 'gpt4o'
                : router.info.model === 'o4-mini' ? 'o4-mini'
                : 'sonnet')
            }
            currentEffort={router.effort}
            onSelect={handleModelSelect}
            onCancel={handleModelCancel}
            experimental={experimental}
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
              onQueue={handleQueue}
              pendingCount={pendingCount}
              onSteer={handleSteer}
              steerCount={steerCount}
            />
            <StatusBar
              cwd={cwd}
              gitBranch={gitBranch}
              indexedFiles={indexedFiles}
              sessionTitle={sessionTitle}
              model={router.info.model}
              provider={router.info.name}
              effort={router.effort}
              tokenCount={tokenCount}
              contextWindow={router.current.contextWindow}
              inputTokens={trackerRef.current.totals.inputTokens}
              outputTokens={trackerRef.current.totals.outputTokens}
              cost={trackerRef.current.totals.cost}
              isLoading={isLoading}
              permissionMode={permissionMode}
              taskMode={taskMode}
              bodyStale={bodyStale}
              composeMode={currentRequestMode}
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
    case 'code':
      return 'code';
    // Agent case removed 2026-05-03 — AgentTool deleted; default returns name.
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
    // Agent case removed 2026-05-03 — AgentTool deleted.
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

    // Agent case removed 2026-05-03 — AgentTool deleted; default formats it.

    case 'code': {
      // code output is structured as `# cell N: id (Xms)` headers + cell
      // stdout/stderr/exception, with a footer like `(1234ms total · 2 cells)`.
      // Showing only first-line + (N chars) — the old default behavior — was
      // hiding the actual cell content from the user when a model wrote
      // synthesis or diagnostics inside a cell. Strip header/footer noise and
      // surface the body content directly. The preview can wrap multi-line in
      // the messages.tsx Text node, so newlines are fine.
      if (lines.length === 0) return '(no output)';
      const bodyLines = lines.filter(l =>
        !/^#\s*cell\s+\d+(:|\s)/i.test(l) // strip "# cell 1: id (Xms)" headers
        && !/^\(\s*\d+ms total/.test(l)   // strip aggregate footer
      );
      const body = bodyLines.join('\n').trim();
      const PREVIEW_CAP = 800;
      if (body.length === 0) {
        // Cells ran but produced no body content — fall back to header summary.
        const header = lines[0] ?? '';
        return header.slice(0, 200);
      }
      const planSummary = summarizePlanCreateText(body);
      if (planSummary) return planSummary;
      if (body.length <= PREVIEW_CAP) return body;
      const hidden = body.length - PREVIEW_CAP;
      return `${body.slice(0, PREVIEW_CAP)}\n… (${hidden} more chars — full output went to the model)`;
    }

    default: {
      // Generic: first line, truncated
      if (lines.length === 0) return '(empty)';
      if (output.length <= 200) return lines.join(' ').slice(0, 200);
      return `${lines[0]!.slice(0, 150)}… (${output.length} chars)`;
    }
  }
}
