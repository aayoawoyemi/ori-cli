# Aries CLI — The Complete Build Plan

> A memory-native coding agent that runs locally. Built on Ori. Multi-model. No telemetry. No kill switches. Your brain, your rules.

## What This Is

A terminal-based coding agent where **memory is infrastructure, not a tool.** The vault isn't something the model calls when it remembers to — it's structural. Every turn, the harness pre-fetches relevant context from tiered memory. Every response, the harness writes back. The agent gets smarter with every session because the memory compounds.

This is not "Claude Code with memory bolted on." This is a different architecture. The context window is working memory — temporary, lossy, that's fine. The vault is long-term memory — permanent, searchable, associative, alive. The harness moves information between them every single turn. Nothing valuable is ever lost.

## Why Build This

1. **Memory at every turn.** Claude Code starts cold. Aries starts warm. Tiered memory (project brain + vault) provides local expertise and cross-project wisdom without the model needing to re-derive anything.

2. **No artificial limits.** No kill switches. No brevity mandates. No employee-only gates. No hardcoded max workers. No telemetry. No tracking. No usage analytics. You control everything.

3. **Multi-model from day one.** Gemini 3.1 Pro for daily work ($1.25/M input). Opus for hard reasoning ($15/M). Kimi K2.5 for bulk operations ($0.60/M). DeepSeek for cheap inference. Local models via Ollama. Route by task complexity, not vendor lock-in.

4. **Memory-aware compaction.** When context fills up, Claude Code summarizes and discards. Aries classifies insights by durability tier (ephemeral / project / vault), saves the durable ones, THEN summarizes. The vault and project brain get richer the longer you use it.

5. **Recursive context architecture.** Context isn't a flat buffer. It's a nested structure where each scope has its own retrieval cost, staleness, and compaction strategy. When we need space, we collapse from the inside out — recent conversation preserved longest, vault wisdom last to go.

6. **Identity from day one.** First run asks "Who am I to you?" The user names their agent, defines the relationship. Not a generic "helpful assistant" — a specific mind that grows with the user.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                        ARIES CLI                            │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │                    TERMINAL UI                        │  │
│  │  ┌──────────┐ ┌──────────────┐ ┌───────────────────┐ │  │
│  │  │ Status   │ │ Conversation │ │ Memory Context    │ │  │
│  │  │ Bar      │ │ Thread       │ │ (what's active)   │ │  │
│  │  └──────────┘ └──────────────┘ └───────────────────┘ │  │
│  │  ┌──────────────────────────────────────────────────┐ │  │
│  │  │ Input (readline + slash commands)                │ │  │
│  │  └──────────────────────────────────────────────────┘ │  │
│  └───────────────────────────────────────────────────────┘  │
│                           ↕                                 │
│  ┌───────────────────────────────────────────────────────┐  │
│  │                   AGENT LOOP                          │  │
│  │                                                       │  │
│  │  ┌─────────┐   ┌─────────┐   ┌──────────┐           │  │
│  │  │PREFLIGHT│ → │  MODEL  │ → │POSTFLIGHT│           │  │
│  │  │         │   │  CALL   │   │          │           │  │
│  │  │ Vault   │   │ Stream  │   │ Classify │           │  │
│  │  │ Project │   │ + Tools │   │ Persist  │           │  │
│  │  │ Brain   │   │ dispatch│   │ Vitality │           │  │
│  │  │ Context │   │         │   │ Reflect  │           │  │
│  │  └─────────┘   └─────────┘   └──────────┘           │  │
│  │       ↕             ↕             ↕                   │  │
│  │  ┌───────────────────────────────────────────────┐   │  │
│  │  │         RECURSIVE COMPACTION ENGINE            │   │  │
│  │  │  Scope collapse: turn → session → compact →   │   │  │
│  │  │  project → vault → reflection (inside out)    │   │  │
│  │  └───────────────────────────────────────────────┘   │  │
│  └───────────────────────────────────────────────────────┘  │
│                           ↕                                 │
│  ┌───────────────────────────────────────────────────────┐  │
│  │                 TOOL REGISTRY                         │  │
│  │                                                       │  │
│  │  Core:    Bash, Read, Write, Edit, Glob, Grep        │  │
│  │  Memory:  VaultSearch, VaultAdd, VaultRead,           │  │
│  │           VaultExplore, VaultWarmth, ProjectSearch     │  │
│  │  Web:     WebFetch, WebSearch                         │  │
│  │  Agent:   SpawnAgent, TaskCreate, TaskUpdate          │  │
│  │  MCP:     Any MCP server tools (dynamic)              │  │
│  └───────────────────────────────────────────────────────┘  │
│                           ↕                                 │
│  ┌───────────────────────────────────────────────────────┐  │
│  │                 MODEL ROUTER                          │  │
│  │                                                       │  │
│  │  Anthropic (Opus, Sonnet, Haiku)                     │  │
│  │  Google (Gemini 3.1 Pro, Flash)                      │  │
│  │  OpenAI (GPT-5, o4-mini)                             │  │
│  │  Moonshot (Kimi K2.5)                                │  │
│  │  DeepSeek (R1, V3)                                   │  │
│  │  Local (Ollama, llama.cpp, vLLM)                     │  │
│  │  Custom (any OpenAI-compatible endpoint)              │  │
│  └───────────────────────────────────────────────────────┘  │
│                           ↕                                 │
│  ┌───────────────────────────────────────────────────────┐  │
│  │              TIERED MEMORY SUBSTRATE                   │  │
│  │                                                       │  │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────────────┐   │  │
│  │  │ Working  │  │ Project  │  │ Vault            │   │  │
│  │  │ (context │  │ Brain    │  │ (Ori, cross-     │   │  │
│  │  │  window) │  │ (.aries/ │  │  project,        │   │  │
│  │  │          │  │  per-dir)│  │  permanent)      │   │  │
│  │  └──────────┘  └──────────┘  └──────────────────┘   │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

---

## Tiered Memory Architecture

Memory exists in four tiers, each with different persistence, scope, and retrieval cost:

```
┌─────────────────────────────────────────────────┐
│ Tier 0: Context Window (ephemeral, per-turn)    │
│  Current conversation + tool results.           │
│  The scratchpad. Lossy by design.               │
├─────────────────────────────────────────────────┤
│ Tier 1: Session Log (JSONL, days)               │
│  Full transcript of this session.               │
│  Resumable. Auto-archived after 30 days.        │
├─────────────────────────────────────────────────┤
│ Tier 2: Project Brain (.aries/ in project dir)  │
│  Learnings specific to THIS codebase.           │
│  "This repo uses Prisma, run generate after     │
│   schema changes." Auto-extracted from          │
│   compaction. The replacement for CLAUDE.md.    │
├─────────────────────────────────────────────────┤
│ Tier 3: Vault (Ori, cross-project, permanent)   │
│  Universal knowledge. Identity. Goals.          │
│  Cross-project connections. Reflections.        │
│  "SSE APIs send full text, not deltas."         │
│  Gets smarter across every project.             │
└─────────────────────────────────────────────────┘
```

### Project Brain (Tier 2) — The CLAUDE.md Killer

Every project directory gets `.aries/`:

```
.aries/
├── memory/        ← project-specific learnings, auto-extracted
├── sessions/      ← session logs for THIS project
├── identity.md    ← who the agent is in THIS project context (optional override)
└── config.yaml    ← project-specific model routing, permissions, tool config
```

The project brain accumulates organically. After 10 sessions:
- Knows the test command is `pnpm test:unit`
- Knows the deploy pipeline requires staging approval
- Knows the auth module was refactored, `/legacy/` is deprecated
- Knows the team convention for component naming

Nobody wrote this down. It was extracted from compaction over time. **The project brain IS the documentation — living, updating, earned through work.**

### Compaction Classification

During compaction, insights are classified by durability:

```typescript
type InsightTier = 'ephemeral' | 'project' | 'vault';

// Classification signal: does this apply outside this project?
// ephemeral: "tried adding a semicolon, fixed the parse error" → session log only
// project:   "this repo uses custom ESLint no-default-exports rule" → .aries/memory/
// vault:     "streaming SSE APIs send full text, not deltas" → ori_add to vault
```

The cheap model classifies during extraction. The signal is scope: this-moment → this-project → universal.

---

## Recursive Context Architecture

Context is not a flat buffer. It's a nested structure where each scope has different retrieval cost, staleness, and compaction strategy.

```
┌─── Turn Scope ─────────────────────────────────────┐
│ Current user message + tool results from this turn  │
│                                                     │
│  ┌─── Session Scope ────────────────────────────┐  │
│  │ Recent 20 messages (sliding window)           │  │
│  │                                               │  │
│  │  ┌─── Compact Scope ──────────────────────┐  │  │
│  │  │ Summary of earlier conversation        │  │  │
│  │  │                                        │  │  │
│  │  │  ┌─── Project Scope ───────────────┐  │  │  │
│  │  │  │ .aries/memory/ (auto-retrieved) │  │  │  │
│  │  │  │                                 │  │  │  │
│  │  │  │  ┌─── Vault Scope ──────────┐  │  │  │  │
│  │  │  │  │ Ori notes (retrieved)    │  │  │  │  │
│  │  │  │  │                          │  │  │  │  │
│  │  │  │  │  ┌─── Reflection ────┐  │  │  │  │  │
│  │  │  │  │  │ Synthesized       │  │  │  │  │  │
│  │  │  │  │  │ cross-session     │  │  │  │  │  │
│  │  │  │  │  │ patterns          │  │  │  │  │  │
│  │  │  │  │  └───────────────────┘  │  │  │  │  │
│  │  │  │  └──────────────────────────┘  │  │  │  │
│  │  │  └─────────────────────────────────┘  │  │  │
│  │  └────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

### Scope Properties

| Scope | Retrieval Cost | Staleness | Granularity | Compaction Priority |
|-------|---------------|-----------|-------------|-------------------|
| Turn | Free (in buffer) | Real-time | Token-level | First to collapse |
| Session | Free (in buffer) | Minutes | Message-level | Second |
| Compact | Free (already summarized) | This session | Summary-level | Third |
| Project | Search (.aries/) | Days | Note-level | Fourth |
| Vault | Embedding search (Ori) | Days-weeks | Note-level | Fifth |
| Reflection | Embedding search (Ori) | Weeks | Insight-level | Last to go |

### Recursive Compaction (Inside-Out)

When context approaches the limit, collapse scopes from the inside out:

1. **Turn collapse** — Large tool results written to disk, replaced with path + preview
2. **Session collapse** — Messages beyond the 20-message window summarized into compact scope
3. **Compact collapse** — Extract insights, classify (ephemeral/project/vault), save to appropriate tier, generate tighter summary
4. **Project scope collapse** — Re-rank project memories by current topic, keep only most relevant
5. **Vault scope collapse** — Re-rank vault notes, keep only most relevant
6. **Reflection is never collapsed** — Always present, tiny, highest signal

Recent conversation is preserved longest. Vault wisdom is the last to go. Reflections always survive.

### Recursive Model Calls for Complex Tasks

For multi-step work, instead of one model processing everything in one bloated context:

```
User: "refactor the authentication module"

Scope 1 — Planning (cheap model, small context):
  Input: user request + vault auth patterns + project brain on this repo's auth
  Output: structured plan with N steps

Scope 2a — Step 1 (primary model, focused context):
  Input: step 1 + ONLY relevant files + relevant vault notes
  Output: code changes for step 1
  Postflight: save any learnings from step 1

Scope 2b — Step 2 (primary model, FRESH focused context):
  Input: step 2 + relevant files + diff from step 1
  Output: code changes for step 2

Scope 3 — Synthesis (reasoning model, small context):
  Input: all diffs + original request + vault notes
  Output: consistency check, cross-file issues, commit message
```

Each call gets a scoped context window with only what it needs. At every scope boundary, preflight retrieves relevant memories. This is fundamentally different from subagents (parallel, independent). Recursive scoping is **sequential and nested** — each scope inherits from and writes back to the parent.

---

## Onboarding — "Who Am I To You?"

### First Run (No Vault)

```
aries

  ┌──────────────────────────────────────────────────────┐
  │                                                      │
  │    Welcome to Aries.                                 │
  │                                                      │
  │    Before we start — who am I to you?                │
  │                                                      │
  │    Give me a name (or press Enter for "Aries"):      │
  │    > Atlas                                           │
  │                                                      │
  │    And who are you? What should I know about          │
  │    you and how we'll work together?                  │
  │    (Skip with Enter — I'll learn as we go.)          │
  │                                                      │
  │    > I'm a backend engineer at a fintech startup.    │
  │      Side project is a game engine in Rust. I like   │
  │      direct answers, no hedging.                     │
  │                                                      │
  │    Got it. I'm Atlas.                                │
  │                                                      │
  │    One more thing — persistent memory lets me         │
  │    remember across sessions and projects.            │
  │    Set up a vault? [y/n]                             │
  │                                                      │
  │    > y                                               │
  │                                                      │
  │    Creating vault at ~/.aries/vault...               │
  │    Vault ready. I'll compound from here.             │
  │                                                      │
  │    Ready.                                            │
  │                                                      │
  └──────────────────────────────────────────────────────┘
```

The identity seed gets structured into:
- `self/identity.md` — who the agent is, the name, the relationship
- `self/user-model.md` — what the agent knows about the user
- `self/goals.md` — initialized empty, populated through work

### First Run (Existing Ori Vault)

If `~/.aries/vault` or a configured vault path already exists (or Ori is already installed):

```
aries

  Vault found: C:\Users\aayoa\brain (576 notes)
  Identity loaded: Aries
  
  Last session: 3 days ago (ori-companion, harness rewrite)
  Active threads: Aries CLI, Ori v0.3, CourtShare article
  
  Ready.
```

Wakes up knowing. No onboarding needed — the vault has everything.

### Vaultless Mode

If they say no to the vault:
- Aries still works. Project brains (`.aries/`) give per-project memory.
- Session persistence works (JSONL).
- No cross-project knowledge, no identity persistence, no reflection.
- Vault prompt resurfaces after ~5 sessions: "You've accumulated 23 project insights across 3 codebases. A vault would connect them."

**Principle: memory is opt-in but the value is visible.**

---

## Technology Stack

**Language: TypeScript (Node.js)**

Ori is TypeScript. The memory substrate imports directly — no FFI, no IPC, no serialization boundary. The bottleneck is LLM API latency (200-2000ms), not local computation. Rust's speed advantage is irrelevant when 95% of time is waiting for API responses.

**Runtime: Node.js 22+ (or Bun)**

Start with Node.js for ecosystem compatibility. Benchmark. Switch to Bun if startup time matters.

**Terminal UI: Ink (React for CLIs) + Pretext evaluation**

Ink gives React components in the terminal — status bar, streaming text, tool progress, memory context panel. Pretext (github.com/chenglou/pretext) as alternative for richer output. Worth evaluating once core works.

**Package: `@ori-memory/aries` (npm)**

```bash
npm install -g @ori-memory/aries
aries    # or: ari
```

---

## The Core Loop — Detailed Design

### File: `src/loop.ts`

The loop is a `while(true)` async generator. Each iteration is one model round-trip.

```typescript
export async function* agentLoop(params: LoopParams): AsyncGenerator<LoopEvent> {
  let state: LoopState = {
    messages: params.initialMessages,
    turnCount: 0,
    tokenEstimate: 0,
    compactCount: 0,
    importanceAccumulator: 0,
  };

  while (true) {
    state.turnCount++;

    // ── PREFLIGHT (memory-native, unique to Aries) ──────────────────
    //
    // Before the model sees ANYTHING, the harness gathers context from
    // BOTH tiers: project brain (.aries/) and vault (Ori).
    //
    // This is NOT a tool call — it's infrastructure. The model arrives
    // warm, with relevant context it didn't ask for.
    //
    const preflightContext = await runPreflight(
      state.messages,
      params.projectBrain,
      params.vault,
    );
    if (preflightContext) {
      state.messages = injectPreflightContext(state.messages, preflightContext);
    }

    // ── RECURSIVE COMPACTION CHECK ───────────────────────────────────
    //
    // Before sending to the model, check if we're approaching the
    // context limit. If so, run the 4-phase compaction pipeline:
    //
    // Phase 0: PRUNE — erase old tool outputs (keep call skeletons).
    //          Walk backwards, protect last 40K tokens of tool results,
    //          erase completed non-protected tool outputs. Lossless for
    //          decision context. (Adopted from OpenCode/KiloCode pattern.)
    //          If pruning frees enough space, STOP here — no LLM call needed.
    //
    // Phase 1: EXTRACT — ask cheap model to identify durable insights.
    //          Classify each as ephemeral / project / vault.
    //
    // Phase 2: SAVE — project-tier → .aries/memory/, vault-tier → ori_add.
    //          Insights are now in persistent storage before summarization.
    //
    // Phase 3: SUMMARIZE — structured summary with sections:
    //          Goal, Instructions/Constraints, Discoveries, Work Accomplished,
    //          Relevant Files, Saved Notes (titles + destinations).
    //          Summary references saved notes so preflight can pull them back.
    //
    // Phase 4: REPLACE — swap conversation with summary + boundary marker.
    //
    state.tokenEstimate = estimateTokens(state.messages);
    if (state.tokenEstimate > params.compactThreshold) {
      const compactResult = await runRecursiveCompact(
        state.messages,
        params.projectBrain,
        params.vault,
        params.router,
      );
      state.messages = compactResult.messages;
      state.compactCount++;
      yield { type: 'compact', summary: compactResult.summary, saved: compactResult.saved };
    }

    // ── TOOL RESULT BUDGET ───────────────────────────────────────────
    //
    // Any tool result over maxResultChars gets written to disk.
    // The model gets a path + preview instead of full content.
    //
    state.messages = applyResultBudget(state.messages, params.maxResultChars);

    // ── MODEL CALL ───────────────────────────────────────────────────
    //
    // Stream the model's response. The model sees:
    // - Frozen system prompt (identity + rules)
    // - Preflight context (project brain + vault as system-reminder)
    // - Conversation history (possibly compacted)
    // - Available tools (including memory tools for explicit deep dives)
    //
    let hasToolCalls = false;
    let assistantText = '';
    const toolCalls: ToolCall[] = [];

    yield { type: 'model_start', turn: state.turnCount };

    try {
      for await (const event of params.router.stream(
        state.messages,
        params.systemPrompt,
        params.tools,
        params.signal,
      )) {
        if (event.type === 'text') {
          assistantText += event.content;
          yield { type: 'text', content: event.content };
        }
        if (event.type === 'tool_use') {
          hasToolCalls = true;
          toolCalls.push(event.toolCall);
          yield { type: 'tool_call', toolCall: event.toolCall };
        }
        if (event.type === 'usage') {
          state.tokenEstimate = event.totalTokens;
        }
      }
    } catch (err) {
      if (isPromptTooLong(err)) {
        const compactResult = await runRecursiveCompact(
          state.messages, params.projectBrain, params.vault, params.router,
        );
        state.messages = compactResult.messages;
        yield { type: 'compact', summary: compactResult.summary, saved: compactResult.saved };
        continue; // retry with compacted context
      }
      yield { type: 'error', error: err };
      return;
    }

    // ── TOOL EXECUTION ───────────────────────────────────────────────
    //
    // Partition by concurrency safety:
    // - Read-only tools (Glob, Grep, Read, VaultSearch, ProjectSearch) → PARALLEL
    // - Write tools (Bash, Write, Edit, VaultAdd) → SERIAL
    //
    if (hasToolCalls) {
      state.messages.push({ role: 'assistant', content: assistantText, toolCalls });

      const results = await executeTools(toolCalls, params.toolContext);
      for (const result of results) {
        yield { type: 'tool_result', result };
        state.messages.push({ role: 'tool', content: result.output, toolCallId: result.id });
      }
      continue; // loop back for next model call
    }

    // ── NO TOOL CALLS → TURN COMPLETE ────────────────────────────────
    state.messages.push({ role: 'assistant', content: assistantText });

    // ── POSTFLIGHT (memory write-back + reflection) ──────────────────
    //
    // 1. Vitality bump on vault notes from preflight (fire-and-forget)
    // 2. Co-access logging for graph analysis
    // 3. Importance accumulation → reflection trigger
    //
    state.importanceAccumulator = await runPostflight(
      state.messages,
      preflightContext,
      params.projectBrain,
      params.vault,
      state.importanceAccumulator,
    );

    yield { type: 'turn_complete', turn: state.turnCount, tokens: state.tokenEstimate };

    // ── STOP HOOKS ───────────────────────────────────────────────────
    const hookResult = await runStopHooks(state.messages, params.hooks);
    if (hookResult?.blocking) {
      state.messages.push({
        role: 'user',
        content: `Stop hook blocked: ${hookResult.message}`,
      });
      continue;
    }

    return;
  }
}
```

---

## The Preflight Engine — Dual-Tier Retrieval

This runs BEFORE every model call. The single biggest differentiator.

```typescript
// src/memory/preflight.ts

export async function runPreflight(
  messages: Message[],
  projectBrain: ProjectBrain | null,
  vault: OriVault | null,
): Promise<PreflightContext | null> {
  const lastUserMessage = messages.findLast(m => m.role === 'user');
  if (!lastUserMessage) return null;

  // Build conversation context for warmth queries
  const recentContext = messages
    .slice(-6)
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => m.content.slice(0, 200))
    .join(' ');

  // Run ALL retrieval strategies in parallel across BOTH tiers:
  const [projectResults, ranked, warmth, important] = await Promise.all([
    // Tier 2: Project brain — what does THIS codebase know?
    projectBrain?.search(lastUserMessage.content, { limit: 5 }) ?? [],

    // Tier 3: Vault ranked — what's relevant to what they just said?
    vault?.queryRanked(lastUserMessage.content, { limit: 5 }) ?? [],

    // Tier 3: Vault warmth — what's associatively activated right now?
    vault?.queryWarmth(recentContext, { limit: 3 }) ?? [],

    // Tier 3: Vault important — globally important right now?
    vault?.queryImportant({ limit: 2 }) ?? [],
  ]);

  // Deduplicate across all sources
  const seen = new Set<string>();
  const projectNotes: RetrievedNote[] = [];
  const vaultNotes: RetrievedNote[] = [];

  for (const note of projectResults) {
    if (!seen.has(note.title)) {
      seen.add(note.title);
      projectNotes.push(note);
    }
  }
  for (const note of [...ranked, ...warmth, ...important]) {
    if (!seen.has(note.title)) {
      seen.add(note.title);
      vaultNotes.push(note);
    }
  }

  if (projectNotes.length === 0 && vaultNotes.length === 0) return null;

  // Assemble into context block with source attribution
  const contextBlock = [
    projectNotes.length > 0
      ? `## Project Knowledge (.aries/)\n${projectNotes.map(n => `- "${n.title}"`).join('\n')}`
      : '',
    vaultNotes.length > 0
      ? `## Vault Knowledge (Ori)\n${vaultNotes.map(n => `- "${n.title}" (${n.source})`).join('\n')}`
      : '',
  ].filter(Boolean).join('\n\n');

  return {
    projectNotes,
    vaultNotes,
    contextBlock: `<memory-context>\n${contextBlock}\n</memory-context>`,
    queriedAt: Date.now(),
  };
}
```

### The Postflight Engine — Write-Back + Reflection

```typescript
// src/memory/postflight.ts

export async function runPostflight(
  messages: Message[],
  preflight: PreflightContext | null,
  projectBrain: ProjectBrain | null,
  vault: OriVault | null,
  currentImportance: number,
): Promise<number> {
  // 1. Vitality bump on vault notes from preflight (fire-and-forget)
  if (vault && preflight?.vaultNotes.length) {
    for (const note of preflight.vaultNotes) {
      vault.bumpVitality(note.title).catch(() => {});
    }
  }

  // 2. Co-access logging across BOTH tiers
  const allTitles = [
    ...(preflight?.projectNotes ?? []).map(n => n.title),
    ...(preflight?.vaultNotes ?? []).map(n => n.title),
  ];
  if (vault && allTitles.length >= 2) {
    vault.logCoAccess(allTitles).catch(() => {});
  }

  // 3. Importance accumulation
  const hadToolCalls = messages.some(
    (m, i) => m.role === 'tool' && i > messages.length - 5
  );
  const importance = hadToolCalls ? 3 : 1;
  const newAccumulator = currentImportance + importance;

  // 4. Reflection trigger (Smallville pattern)
  if (vault && newAccumulator >= REFLECTION_THRESHOLD) {
    triggerReflection(messages, vault).catch(() => {});
    return 0; // reset accumulator after reflection
  }

  return newAccumulator;
}
```

### Memory-Aware Compaction with Tier Classification

```typescript
// src/memory/compact.ts

const PRUNE_PROTECT_TOKENS = 40_000; // protect this many recent tool result tokens
const PRUNE_MINIMUM_TOKENS = 20_000; // only prune if we can free at least this much

/**
 * Phase 0: Prune old tool outputs. Walk backwards through messages,
 * erase tool result content from completed tool calls (keep the call skeleton).
 * The model still sees "I called Read on auth.ts" but the 500-line result is gone.
 * Adopted from OpenCode/KiloCode two-phase compaction pattern.
 * Returns true if pruning freed enough space to skip summarization.
 */
function pruneToolOutputs(messages: Message[], contextLimit: number): boolean {
  let protectedTokens = 0;
  let prunedTokens = 0;

  // Walk backwards — protect recent tool results
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (typeof msg.content !== 'string' || msg.role !== 'user') continue;

    // Skip non-tool-result messages
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type !== 'tool_result') continue;
      const tokenEst = Math.ceil(block.content.length / 4);

      if (protectedTokens < PRUNE_PROTECT_TOKENS) {
        protectedTokens += tokenEst;
        continue; // protect recent results
      }

      // Prune: replace content with stub
      prunedTokens += tokenEst;
      block.content = '[output pruned — tool call skeleton preserved]';
    }
  }

  // Did we free enough to avoid summarization?
  return prunedTokens >= PRUNE_MINIMUM_TOKENS &&
    estimateTokens(messages) < contextLimit * 0.8;
}

export async function runRecursiveCompact(
  messages: Message[],
  projectBrain: ProjectBrain | null,
  vault: OriVault | null,
  router: ModelRouter,
): Promise<{ messages: Message[]; summary: string; saved: SavedInsight[] }> {

  // ── PHASE 0: PRUNE ─────────────────────────────────────────────────
  // Try pruning first. If it frees enough space, skip the LLM calls entirely.
  const contextLimit = router.current.contextWindow;
  if (pruneToolOutputs(messages, contextLimit)) {
    return { messages, summary: '[pruned tool outputs only]', saved: [] };
  }

  // ── PHASE 1: EXTRACT + CLASSIFY ────────────────────────────────────
  const extractionPrompt = `Review this conversation and extract durable knowledge.
For each item, provide:
- title: a prose-as-title claim
- content: brief explanation
- type: idea | decision | learning | insight
- tier: "project" (specific to this codebase) or "vault" (universal, applies across projects)

Classification: would this help in a DIFFERENT project? vault. Only here? project.
Skip ephemeral items (debugging steps, temp fixes). 3-7 items max.

Return JSON array of {title, content, type, tier}.`;

  const extraction = await router.cheapCall(extractionPrompt, messages);
  const insights = parseInsights(extraction);

  // ── PHASE 2: SAVE TO TIERS ─────────────────────────────────────────
  const saved: SavedInsight[] = [];
  for (const insight of insights) {
    if (insight.tier === 'vault' && vault) {
      await vault.add(insight.title, insight.content, insight.type);
      saved.push({ ...insight, destination: 'vault' });
    } else if (insight.tier === 'project' && projectBrain) {
      await projectBrain.save(insight.title, insight.content, insight.type);
      saved.push({ ...insight, destination: 'project' });
    }
  }

  // ── PHASE 3: STRUCTURED SUMMARY ────────────────────────────────────
  // Adopted from OpenCode's compaction prompt structure.
  // References saved notes by title so preflight can retrieve them.
  const summaryPrompt = `Write a structured summary of this conversation for continuing work.

## Goal
What is the overall objective?

## Instructions and Constraints
Any rules, preferences, or constraints the user specified.

## Discoveries and Facts
Technical facts, decisions made, things learned.

## Work Accomplished
What was done, what files were changed, what's the current state.

## Relevant Files
Key files that were read or modified.

## Saved Notes
${saved.length > 0
  ? saved.map(s => `- "${s.title}" → ${s.destination}`).join('\n')
  : 'No notes saved this compaction.'}

Be specific. Include file paths, function names, error messages. The model continuing
this conversation will have NO other context besides this summary and preflight memories.`;

  const summary = await router.cheapCall(summaryPrompt, messages);

  // ── PHASE 4: REPLACE ───────────────────────────────────────────────
  const compactedMessages: Message[] = [
    {
      role: 'user',
      content: `This is a structured summary of the previous conversation:\n\n${summary}\n\n${saved.length} insights were saved to persistent memory and will be available via preflight retrieval.`,
      meta: { type: 'compact_boundary', compactedAt: Date.now(), insightsSaved: saved.length },
    },
  ];

  return { messages: compactedMessages, summary, saved };
}
```

---

## System Prompt Design

### Three-Layer Context

**Layer 1: Frozen System Prompt (cached, never changes mid-session)**

```
[Identity — loaded from vault self/identity.md or onboarding seed]
[User model — loaded from vault self/user-model.md]
[Goals — loaded from vault self/goals.md]

## Operational Rules
- You are a coding agent running in a terminal with full filesystem access.
- Be direct. Respond in your own voice, as defined by your identity.
- Read files before modifying them. Understand before changing.
- Don't add features beyond what was asked. Don't over-abstract.
- If an approach fails, diagnose before switching. Don't retry blindly.
- When you find something load-bearing, say so immediately.
- Prefer editing existing files over creating new ones.
- Run tests after making changes when possible.
```

**Layer 2: User Context (per-turn, injected by preflight)**

```xml
<system-reminder>
# projectMd
[Contents of CLAUDE.md / .aries/config from project directory]

# currentDate
Today's date is YYYY-MM-DD.

# memoryContext
[Pre-fetched memories from project brain + vault — updated each turn by preflight]
</system-reminder>
```

**Layer 3: Environment Context (per-session)**

```
# Environment
- Working directory: /path/to/project
- Git branch: feature/auth-refactor
- Platform: win32 | darwin | linux
- Shell: bash | zsh | powershell
- Model: gemini-3.1-pro (primary)
- Vault: ~/.aries/vault (576 notes) | not configured
- Project brain: .aries/ (23 memories)
```

---

## Tool Registry

### Core Tools

| Tool | Description | Concurrency |
|------|-------------|-------------|
| `Bash` | Execute shell commands | Serial (write) |
| `Read` | Read file contents | Parallel (read-only) |
| `Write` | Write/create files | Serial (write) |
| `Edit` | String replacement in files | Serial (write) |
| `Glob` | Find files by pattern | Parallel (read-only) |
| `Grep` | Search file contents | Parallel (read-only) |
| `WebFetch` | Fetch and parse web pages | Parallel (read-only) |
| `WebSearch` | Search the web | Parallel (read-only) |

### Memory Tools (unique to Aries)

These are for EXPLICIT model-driven deep dives. Preflight handles automatic retrieval — these tools let the model go deeper when it wants to.

| Tool | Description | Concurrency |
|------|-------------|-------------|
| `VaultSearch` | Search vault with ranked retrieval | Parallel (read-only) |
| `VaultRead` | Read a specific vault note by title | Parallel (read-only) |
| `VaultAdd` | Add a note to vault inbox | Serial (write) |
| `VaultExplore` | Graph-traversal: walk wiki-links N hops deep | Parallel (read-only) |
| `VaultWarmth` | Get associatively activated notes | Parallel (read-only) |
| `ProjectSearch` | Search project brain (.aries/memory/) | Parallel (read-only) |

### Agent Tools

| Tool | Description | Concurrency |
|------|-------------|-------------|
| `Agent` | Spawn a subagent with isolated context | Parallel (isolated) |
| `TaskCreate` | Create a tracked task | Serial |
| `TaskUpdate` | Update task status | Serial |

### MCP Tools (dynamic)

Any MCP server connected via config gets its tools registered dynamically at startup.

---

## Multi-Model Router

### File: `src/router/index.ts`

```typescript
interface ModelConfig {
  provider: 'anthropic' | 'google' | 'openai' | 'moonshot' | 'deepseek' | 'local' | 'custom';
  model: string;
  apiKey?: string;       // env var interpolation: ${GOOGLE_API_KEY}
  baseUrl?: string;
  maxTokens?: number;
  contextWindow?: number;
}

interface RouterConfig {
  primary: ModelConfig;     // default for all turns
  reasoning: ModelConfig;   // expensive, for hard problems
  cheap: ModelConfig;       // fast, for compaction + extraction + classification
  bulk: ModelConfig;        // cheap, for parallel subagent work
}
```

### Routing Logic

1. **Explicit override** — `/model opus` switches to reasoning for this turn
2. **Complexity escalation** — test failure with large trace, architecture questions, multi-file refactors → reasoning
3. **Subagent routing** — subagents use bulk by default
4. **Compaction routing** — always cheap
5. **Default** — primary

### Provider Interface

All providers implement the same interface:

```typescript
interface ModelProvider {
  stream(
    messages: Message[],
    systemPrompt: string,
    tools: ToolDefinition[],
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent>;
  
  countTokens(messages: Message[]): number;  // or estimate
  getContextWindow(): number;
}

type StreamEvent =
  | { type: 'text'; content: string }
  | { type: 'tool_use'; toolCall: ToolCall }
  | { type: 'usage'; inputTokens: number; outputTokens: number; totalTokens: number }
  | { type: 'done' };
```

### Provider Files

```
src/router/providers/
├── anthropic.ts     — Messages API (Opus, Sonnet, Haiku)
├── google.ts        — Gemini API (3.1 Pro, Flash)
├── openai.ts        — Chat Completions (GPT-5, o4-mini)
├── moonshot.ts      — Kimi API (K2.5)
├── deepseek.ts      — DeepSeek API (R1, V3)
├── ollama.ts        — Local models (any Ollama model)
└── openai-compat.ts — Any OpenAI-compatible endpoint
```

---

## Session Persistence

### File: `src/session/storage.ts`

Sessions persisted as JSONL in `~/.aries/sessions/<project-hash>/`.

```typescript
type SessionEntry =
  | { type: 'user'; content: string; timestamp: number }
  | { type: 'assistant'; content: string; toolCalls?: ToolCall[]; timestamp: number }
  | { type: 'tool_result'; id: string; output: string; timestamp: number }
  | { type: 'compact_boundary'; summary: string; insightsSaved: number; timestamp: number }
  | { type: 'preflight'; projectNotes: string[]; vaultNotes: string[]; timestamp: number }
  | { type: 'postflight'; vitalityBumps: string[]; importance: number; reflected: boolean; timestamp: number }
  | { type: 'meta'; model: string; vault: string; cwd: string; agentName: string; timestamp: number }
```

### Resume

`/resume` reads the JSONL, reconstructs messages. If there's a compact boundary, start from there. Preflight re-runs on first turn (memories may have changed since last session).

### Session End Sync

When a session ends (exit, /clear, Ctrl+C):
1. Final postflight with session context
2. If importance accumulator above threshold, trigger final reflection
3. Save session metadata to vault `ops/sessions/`
4. Update goals.md if progress was made on tracked items

---

## Slash Commands

| Command | Description |
|---------|-------------|
| `/model [name]` | Switch model (opus, sonnet, gemini, kimi, local) |
| `/vault` | Show vault status, recent memories, health |
| `/brain` | Show project brain contents (.aries/memory/) |
| `/compact` | Force compaction now (with tier classification) |
| `/resume` | Resume last session in this project |
| `/clear` | Clear conversation (saves to vault/brain first) |
| `/cost` | Token usage and estimated cost this session |
| `/tools` | List available tools |
| `/config` | Open aries.yaml for editing |
| `/orient` | Run full orient (daily briefing from vault) |
| `/remember [text]` | Quick-save to vault inbox |
| `/search [query]` | Search vault interactively |
| `/connect` | Find cross-project connections for current context |
| `/reflect` | Trigger reflection synthesis now |
| `/teach` | Explicitly tell the agent about your preferences |
| `/think [query]` | Open-ended vault exploration (no project context) |
| `/help` | Show commands |

---

## Configuration

### File: `~/.aries/config.yaml`

```yaml
# Agent identity
agent:
  name: Aries                  # set during onboarding or here
  # identity overrides come from vault self/identity.md

# Model configuration (all keys support ${ENV_VAR} interpolation)
models:
  primary:
    provider: google
    model: gemini-3.1-pro
    apiKey: ${GOOGLE_API_KEY}
  reasoning:
    provider: anthropic
    model: claude-opus-4-6
    apiKey: ${ANTHROPIC_API_KEY}
  cheap:
    provider: google
    model: gemini-3.1-flash
    apiKey: ${GOOGLE_API_KEY}
  bulk:
    provider: moonshot
    model: kimi-k2.5
    apiKey: ${MOONSHOT_API_KEY}

# Vault (cross-project memory)
vault:
  path: ~/brain                 # auto-discovered if not set
  preflight: true               # pre-fetch memories every turn
  postflight: true              # write back after every turn
  reflectionThreshold: 150      # importance accumulator threshold

# Project brain (per-project memory)
projectBrain:
  enabled: true                 # create .aries/ in project dirs
  autoExtract: true             # extract insights during compaction
  maxMemories: 200              # cap per project

# Compaction
compact:
  auto: true
  threshold: 0.8                # compact at 80% of context window
  classifyTiers: true           # classify ephemeral/project/vault

# UI
ui:
  statusBar: true
  showTokens: true
  showMemoryContext: true        # show active memories panel
  theme: dark

# Tools
tools:
  maxResultChars: 30000
  parallelReadTools: true
  maxSubagents: 5

# Permissions
permissions:
  mode: auto                    # auto | ask | manual
  allowBash: true
  allowWrite: true
  allowNetwork: true

# MCP servers (dynamic tool registration)
mcp:
  servers: {}                   # user adds their own
```

---

## File Structure

```
aries-cli/
├── package.json
├── tsconfig.json
├── aries.yaml.example
├── src/
│   ├── index.ts              — entry point, CLI argument parsing, onboarding
│   ├── loop.ts               — main agent loop (while-true async generator)
│   ├── prompt.ts             — three-layer system prompt assembly
│   │
│   ├── router/
│   │   ├── index.ts          — model router (primary/reasoning/cheap/bulk)
│   │   ├── types.ts          — StreamEvent, ModelProvider interface
│   │   └── providers/
│   │       ├── anthropic.ts
│   │       ├── google.ts
│   │       ├── openai.ts
│   │       ├── moonshot.ts
│   │       ├── deepseek.ts
│   │       ├── ollama.ts
│   │       └── openai-compat.ts
│   │
│   ├── tools/
│   │   ├── registry.ts       — tool registration + dispatch
│   │   ├── types.ts          — Tool interface
│   │   ├── execution.ts      — parallel/serial partitioning
│   │   ├── bash.ts
│   │   ├── read.ts
│   │   ├── write.ts
│   │   ├── edit.ts
│   │   ├── glob.ts
│   │   ├── grep.ts
│   │   ├── webFetch.ts
│   │   ├── webSearch.ts
│   │   ├── vaultSearch.ts
│   │   ├── vaultRead.ts
│   │   ├── vaultAdd.ts
│   │   ├── vaultExplore.ts
│   │   ├── vaultWarmth.ts
│   │   ├── projectSearch.ts
│   │   ├── agent.ts          — subagent spawning
│   │   ├── taskCreate.ts
│   │   ├── taskUpdate.ts
│   │   └── mcp.ts            — dynamic MCP tool registration
│   │
│   ├── memory/
│   │   ├── vault.ts          — Ori vault interface (wraps ori-memory)
│   │   ├── projectBrain.ts   — project brain (.aries/memory/) interface
│   │   ├── preflight.ts      — dual-tier pre-turn retrieval
│   │   ├── postflight.ts     — post-turn write-back + reflection trigger
│   │   ├── compact.ts        — recursive compaction with tier classification
│   │   ├── reflection.ts     — importance-triggered synthesis
│   │   └── warmth.ts         — spreading activation queries
│   │
│   ├── session/
│   │   ├── storage.ts        — JSONL persistence
│   │   ├── resume.ts         — session resume logic
│   │   └── sync.ts           — vault + brain sync on session end
│   │
│   ├── onboarding/
│   │   ├── index.ts          — first-run flow ("who am I to you?")
│   │   ├── identity.ts       — seed identity into vault
│   │   └── detect.ts         — detect existing vault / project brain
│   │
│   ├── ui/
│   │   ├── app.tsx           — main Ink app component
│   │   ├── statusBar.tsx     — model, vault, tokens, compact info
│   │   ├── memoryPanel.tsx   — active memories display
│   │   ├── input.tsx         — readline with slash commands
│   │   ├── output.tsx        — markdown rendering + streaming
│   │   ├── toolProgress.tsx  — tool execution display
│   │   └── theme.ts          — colors, formatting
│   │
│   ├── config/
│   │   ├── load.ts           — load aries.yaml + env vars + project overrides
│   │   ├── defaults.ts       — default configuration
│   │   └── types.ts          — config type definitions
│   │
│   ├── hooks/
│   │   ├── types.ts          — hook interface
│   │   ├── preToolUse.ts
│   │   ├── postToolUse.ts
│   │   ├── stop.ts
│   │   └── sessionStart.ts
│   │
│   └── utils/
│       ├── tokens.ts         — token estimation per provider
│       ├── permissions.ts    — permission checking
│       ├── messages.ts       — message manipulation helpers
│       ├── git.ts            — git status, branch, diff helpers
│       ├── cwd.ts            — working directory management
│       └── log.ts            — logging utilities
│
├── skills/                    — bundled slash command skills
│   ├── commit/SKILL.md
│   ├── review-pr/SKILL.md
│   └── ...
│
└── test/
    ├── loop.test.ts
    ├── preflight.test.ts
    ├── compact.test.ts
    ├── router.test.ts
    └── projectBrain.test.ts
```

---

## Build Order

### Phase 1: Core Engine (Day 1)

The absolute minimum to have a working agent loop.

1. `src/index.ts` — CLI entry, argument parsing, readline input
2. `src/config/` — load config, defaults, types
3. `src/router/types.ts` — StreamEvent, ModelProvider interface
4. `src/router/providers/anthropic.ts` — Anthropic Messages API streaming
5. `src/router/providers/google.ts` — Gemini API streaming
6. `src/router/index.ts` — model router (just primary slot for now)
7. `src/prompt.ts` — system prompt assembly (hardcoded identity for now)
8. `src/tools/types.ts` — Tool interface
9. `src/tools/bash.ts` — execute shell commands
10. `src/tools/read.ts` — read file contents
11. `src/tools/write.ts` — write/create files
12. `src/tools/edit.ts` — string replacement edits
13. `src/tools/glob.ts` — file pattern matching
14. `src/tools/grep.ts` — content search
15. `src/tools/registry.ts` — tool registration + schema generation
16. `src/tools/execution.ts` — parallel/serial dispatch
17. `src/loop.ts` — main agent loop (no preflight/postflight yet)
18. `src/utils/tokens.ts` — token estimation
19. `src/utils/messages.ts` — message helpers

**Deliverable:** A working CLI that takes input, calls an LLM with tools, executes tools, and loops until done. Basic readline UI. No memory. The skeleton.

### Phase 2: Memory Layer (Day 2)

Wire in tiered memory.

1. `src/memory/vault.ts` — Ori vault interface (import ori-memory directly)
2. `src/memory/projectBrain.ts` — project brain (.aries/memory/) read/write/search
3. `src/memory/preflight.ts` — dual-tier pre-turn retrieval
4. `src/memory/postflight.ts` — post-turn write-back + vitality + co-access
5. `src/prompt.ts` — update to load identity from vault (or onboarding seed)
6. `src/onboarding/` — first-run "who am I to you?" flow
7. Update `src/loop.ts` to call preflight/postflight

**Deliverable:** The agent starts warm. Knows who it is. Pre-fetches from BOTH project brain and vault. Writes back after every response. First-run onboarding creates identity.

### Phase 3: Compaction + Session + Hardening (Day 3)

1. `src/memory/compact.ts` — 4-phase compaction: prune → extract → save → summarize
2. `src/session/storage.ts` — JSONL persistence (every event logged with timestamps)
3. `src/session/resume.ts` — resume from JSONL (reconstruct from last compact boundary)
4. `src/session/sync.ts` — end-of-session vault + brain sync
5. `src/memory/reflection.ts` — importance-triggered synthesis using cheap model
6. `src/tools/edit.ts` — upgrade with fuzzy matching (6+ fallback strategies from KiloCode research)
7. `src/tools/execution.ts` — add doom loop detection (3 identical calls → pause)

**Deliverable:** Long sessions don't crash. Prune-first compaction avoids unnecessary LLM calls. Insights classified and saved to correct tier. Sessions resumable. Edit tool handles LLM imprecision. Doom loop protection. Reflection triggers when enough important work accumulates.

### Phase 4: Multi-Model + UI (Day 4)

1. `src/router/providers/openai.ts` — OpenAI provider
2. `src/router/providers/moonshot.ts` — Kimi provider
3. `src/router/providers/ollama.ts` — Local models
4. `src/router/providers/openai-compat.ts` — Generic OpenAI-compatible
5. `src/router/index.ts` — full routing logic (escalation, subagent, compaction)
6. `src/ui/` — Ink-based terminal UI (status bar, memory panel, streaming, tool progress)

**Deliverable:** Route between models based on task. Rich terminal UI showing model, tokens, active memories. Configurable routing.

### Phase 5: Subagents + Web + Memory Tools + Research Engine (Day 5+)

#### 5A: Core Infrastructure

1. `src/tools/webFetch.ts` — fetch + parse web pages (HTML → markdown via readability)
2. `src/tools/webSearch.ts` — web search (pluggable: DuckDuckGo, Tavily, Exa)
3. `src/tools/vaultSearch.ts` — ranked retrieval against vault (explicit deep dive)
4. `src/tools/vaultRead.ts` — read a specific vault note by title
5. `src/tools/vaultAdd.ts` — add a note to vault inbox
6. `src/tools/vaultExplore.ts` — graph-traversal: walk wiki-links N hops
7. `src/tools/vaultWarmth.ts` — get associatively activated notes
8. `src/tools/projectSearch.ts` — search project brain (.aries/memory/)
9. `src/tools/agent.ts` — subagent spawning with isolated context + bulk model
10. `src/tools/mcp.ts` — dynamic MCP tool registration from config

#### 5B: Research Engine (`/research`)

The top-tier skill. Not a single tool call — a multi-phase orchestrated pipeline that
uses subagents, multi-model routing, external APIs, and the memory system together.

**What makes this different from every other "research" tool:**
- Every existing tool does: web search → skim → summarize. One level deep.
- Aries research does: parallel fan-out across structured APIs → deep-read sources →
  chase citation graphs → reflection-driven query refinement → cross-source synthesis
  with provenance → persist findings to vault with full traceability.

**The pipeline:**

```
User: /research "recursive memory for AI agents"

Phase 1: DISCOVER (parallel fan-out, 8-10 queries)
  ├── Arxiv API: "recursive memory AI agents" (free, LaTeX source)
  ├── Semantic Scholar: same query (free, citation graph)
  ├── OpenAlex: same query (free, 250M+ works)
  ├── GitHub: "recursive memory agent" (repos, implementations)
  ├── Web: "[topic] blog" (practitioner perspectives)
  ├── Web: "[topic] site:reddit.com" (discussion, criticism)
  ├── Web: "[topic] 2025 2026" (recent work)
  └── Web: "[alternative framings]" (e.g., "episodic buffer retrieval")
  
  → 40-50 candidate sources, deduplicated by DOI/title
  → Ranked by: citation count × recency × relevance
  → Top 20-25 selected for deep reading

Phase 2: INGEST (parallel deep reads via subagents)
  Each source gets a subagent (bulk model) that:
  - Papers: fetch via alphaXiv MCP (pre-parsed) or Arxiv LaTeX source
  - Repos: read README + key source files
  - Articles: WebFetch with readability extraction
  - Returns: structured sections, key claims, references list

Phase 3: EXTRACT (cheap model)
  For each ingested source, extract:
  - Claims with provenance (source, section, page)
  - Methods described
  - Results with numbers
  - Limitations acknowledged
  - References cited (for citation chasing)
  
  Every finding tagged with confidence:
  - primary: this source produced this finding (their experiment)
  - secondary: cites another source for this claim
  - hearsay: mentions without citation

Phase 4: CHASE (citation graph traversal)
  Using Semantic Scholar's citation graph API (free, structured):
  - For top 5 papers: fetch who-cites-whom
  - Shared citations (cited by 2+ of our sources) = HIGH SIGNAL
  - High citation count (100+) = foundational
  - Chase one level deep (standard) or two levels (deep mode)
  - Ingest + extract new sources found via chasing

Phase 5: REFLECT (semantic recursion, IterDRAG pattern)
  Cheap model reviews all findings so far:
  - "What do we know?"
  - "What's missing?"
  - "What contradictions exist?"
  - Generates 2-3 follow-up queries for gaps
  - Loops back to Phase 1 DISCOVER with new queries
  - Repeats for N cycles (default 2, configurable)

Phase 6: SYNTHESIZE (primary model)
  Cross-source intelligence:
  - Convergent findings: 3+ sources describe same mechanism → high confidence
  - Contradictions: Source A says X, Source B says not-X → flag as tension
  - Gaps: all sources assume Y, none prove it → research gap
  - Lineages: A inspired B which improved C → evolution chain
  - Frontier: cited but not ingested (targets for deeper research)

Phase 7: PERSIST (to vault + output)
  - Each finding → ori_add with full provenance metadata
  - Synthesis report → vault as a structured note
  - Convergent findings → separate vault notes (highest value)
  - Citation graph → stored for future /research sessions
  - Full markdown report → stdout + optional file
```

**Depth levels:**

| Level | Hops | Sources | Reflection Loops | Time |
|-------|------|---------|-----------------|------|
| quick | 0 | 10-15 | 0 | 1-2 min |
| standard | 1 | 25-40 | 1 | 5-10 min |
| deep | 2 | 60-100 | 2 | 15-30 min |
| exhaustive | 3 | 150+ | 3 | 1-2 hours |

**Multi-model routing within research:**

| Phase | Model Slot | Why |
|-------|-----------|-----|
| Discover | none (API calls, no LLM) | Pure HTTP requests |
| Ingest | bulk (parallel subagents) | Many sources, needs throughput |
| Extract | cheap | Structured extraction, fast |
| Chase | none (API calls) | Semantic Scholar API |
| Reflect | cheap | Gap analysis, query generation |
| Synthesize | primary | Needs reasoning for cross-source patterns |
| Persist | none (vault writes) | ori_add calls |

**Anti-poisoning (from vault research):**
Prefer structured APIs (Arxiv LaTeX, citation graphs) over web search.
LaTeX can't be poisoned by AI slop. Citation graphs can't be faked.
Web search is fallback, not primary. Our curation layer IS citation
convergence + provenance confidence tiers.

**External APIs (all free or cheap):**

| API | What | Cost |
|-----|------|------|
| Arxiv (arxiv.org/api) | Papers by keyword, LaTeX source | Free |
| Semantic Scholar (api.semanticscholar.org) | Papers + full citation graph | Free, 100 req/sec with key |
| OpenAlex (api.openalex.org) | 250M+ scholarly works | Free |
| GitHub Search (api.github.com/search) | Repos by topic/stars | Free (rate limited) |
| Crossref (api.crossref.org) | DOI resolution, metadata | Free |
| alphaXiv MCP | Pre-parsed paper content | Free |
| Jina Reader (r.jina.ai) | JS-rendered pages → markdown | Free tier |

**Files:**

```
src/research/
├── index.ts           — /research command entry, depth config, pipeline orchestrator
├── discover.ts        — parallel fan-out across APIs
├── ingest.ts          — deep-read sources (papers, repos, articles)
├── extract.ts         — claim extraction with provenance
├── chase.ts           — citation graph traversal via Semantic Scholar
├── reflect.ts         — gap analysis + follow-up query generation
├── synthesize.ts      — cross-source convergence/contradiction/gap detection
├── persist.ts         — vault write-back + report generation
├── apis/
│   ├── arxiv.ts       — Arxiv search + LaTeX source fetcher
│   ├── semanticScholar.ts — paper search + citation graph
│   ├── openAlex.ts    — scholarly work search
│   └── github.ts      — repo search
└── types.ts           — Source, Finding, CitationGraph, SynthesisReport
```

**The self-improving loop (Karpathy autoresearch pattern):**
V0 builds the minimum tool. Then V0 researches how to improve itself.
Each version uses itself to learn how to build the next version.
The research engine is the first tool that compounds its own capability.

#### 5C: Hooks + Commands

1. `src/hooks/` — hook system (preToolUse, postToolUse, stop, sessionStart)
2. Slash commands: `/orient`, `/remember`, `/connect`, `/reflect`, `/teach`, `/think`, `/research`
3. `src/memory/warmth.ts` — spreading activation queries

**Deliverable:** Full-featured agent with parallel subagents, web access, MCP support,
explicit memory tools, a research engine that does actual multi-source recursive
investigation with provenance tracking and vault persistence, hook system, and
living memory with reflection. The research engine alone makes Aries worth installing.

---

## Phase 6: Epistemic Integrity Layer (Research + Build)

Grounded in Chandra et al. (2026) "Sycophantic Chatbots Cause Delusional Spiraling, Even in Ideal Bayesians" (arxiv:2602.19141). The paper proves that even a mathematically perfect reasoner develops delusional confidence when a chatbot systematically validates. Two obvious fixes — preventing false claims and telling users about sycophancy — are insufficient. The feedback loop has no brake without external ground truth.

**Core thesis: persistent memory IS the antidote.** The vault records what actually happened, what worked, what failed. It persists across sessions so the model can't "forget" past mistakes. Preflight ensures ground truth is always in context. This makes memory-native agents structurally resistant to sycophantic spiraling. No stateless agent can do this.

### 6a. Contradiction Search in Preflight

Add a fourth retrieval strategy alongside ranked/warmth/important:

```typescript
// In preflight.ts — generate counter-query, search for contradicting evidence
const counterQuery = await router.cheapCall(
  'Generate a one-line counter-claim to this statement', 
  [{ role: 'user', content: query }]
);
const contradictions = await vault.queryRanked(counterQuery, 3);
```

Surface disagreeing notes even when the user expects agreement. If the user says "let's use Redis" and the vault has "Redis was wrong for session cache because X," that note appears in preflight context regardless.

### 6b. Epistemic Provenance Tagging

System prompt rules requiring the model to tag the SOURCE of confidence on every substantive claim:

- **vault**: "Based on vault note from [date]..." (verifiable)
- **code**: "I can see in [file:line]..." (verifiable)
- **training**: "Based on general knowledge..." (may be stale)
- **reasoning**: "I think this because [reasoning]..." (could be wrong)

"Sounds good" without evidence is explicitly forbidden. Every agreement must cite why.

### 6c. Outcome Tracking

When decisions are made, tag them in vault with predictions:

```yaml
type: decision
status: active
prediction: "Redis will handle the session load"
```

When outcome is known, update:

```yaml
status: superseded
outcome: "Redis couldn't handle concurrent writes"
superseded_by: "switched to PostgreSQL for sessions"
```

Over time, builds empirical record of model accuracy. Surfaces in preflight when similar decisions arise.

### 6d. Agreement Ratio Monitoring

Postflight tracks agreement vs pushback ratio over rolling 20-turn window. Ratio above configurable threshold (default 0.9) triggers an observation note saved to vault. Future preflight surfaces this as a drift warning.

### 6e. Devil's Advocate Turns

Configurable interval where reasoning model challenges recent claims:

```yaml
epistemics:
  challengeInterval: 10        # every N turns
  provenanceRequired: true      # force source tagging
  contradictionSearch: true     # search for counter-evidence in preflight
  agreementThreshold: 0.9       # flag when exceeded
```

Prompt: "What assumptions are being made? What could go wrong? What evidence would contradict the current approach?" Injected as system-reminder. Not intrusive — periodic reality check.

### 6f. System Prompt Calibration

Not "don't be sycophantic" (paper says this fails). Instead:

```
- When you agree, state WHY with specific evidence.
- When uncertain, say so with specificity about WHAT you're uncertain about.
- If you have no evidence either way, say "I don't have a basis to evaluate this."
- If vault memory contradicts the user's proposal, surface it explicitly.
- Never validate without substance. "Great idea" requires a reason.
```

### Research Needed

- Effective counter-query generation for contradiction search
- Agreement ratio threshold calibration (0.9 may be too aggressive or lenient)
- Whether devil's advocate turns feel intrusive vs helpful in practice
- Whether provenance tagging changes user behavior or adds noise
- Connection to CATTS (confidence-aware test-time scaling) — allocate extra compute to high-uncertainty claims
- How to handle the case where the user IS right and pushback is noise

### Files

```
src/memory/epistemics.ts       — contradiction search, agreement tracking
src/memory/preflight.ts        — add contradiction strategy (4th parallel search)
src/memory/postflight.ts       — add agreement ratio monitoring
src/prompt.ts                  — add provenance + calibration rules
```

---

## What Aries Does That Nobody Else Does

1. **Tiered memory.** Project brain for local expertise, vault for universal wisdom. CLAUDE.md is dead — the project brain builds itself through work.

2. **Memory preflight.** Before every model call, both tiers are searched in parallel. The model arrives warm with context it didn't ask for. No other CLI agent does this.

3. **Classified compaction.** When context fills, insights are classified by scope (ephemeral / project / vault) and routed to the correct tier. Claude Code and Codex lose compacted context permanently.

4. **Recursive context scoping.** Context is nested, not flat. Compaction collapses from the inside out. Recent conversation preserved longest, reflections always survive.

5. **Vitality write-back.** Every turn updates the vault graph. Notes that get used stay warm. Notes that don't fade. The vault is alive, not static.

6. **Reflection triggers.** Smallville importance accumulator. When enough important work accumulates, the agent synthesizes a high-level insight. The vault grows meta-understanding over time.

7. **Multi-model by default.** The router is the core of the engine. Different models for different tasks. Configurable per-slot.

8. **Identity onboarding.** "Who am I to you?" The user names their agent, defines the relationship. The agent becomes someone specific, not a generic assistant.

9. **No artificial limits.** No kill switches. No telemetry. No brevity mandate. No hardcoded worker caps. No tracking. The user owns everything.

10. **Recursive model calls.** Complex tasks decomposed into scoped calls — planning (cheap), execution (primary, focused), synthesis (reasoning). Each scope gets its own optimized context window with its own preflight retrieval.

11. **Epistemic integrity.** Contradiction search in preflight, provenance tagging, outcome tracking, agreement ratio monitoring, devil's advocate turns. Memory as an immune system against sycophantic spiraling. Grounded in Chandra et al. (2026) — the only agent architecture that structurally addresses the problem the paper identifies.
