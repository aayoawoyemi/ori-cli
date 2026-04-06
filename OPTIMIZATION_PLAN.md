# Ori CLI Optimization Plan — Closing the Efficiency Gap

**Date:** 2026-04-06
**Goal:** Move from 2.5x token efficiency (current, Claude Sonnet) toward 4.2x (Aider's benchmark) without sacrificing our differentiators (vault memory, judgment tools, REPL composition).

---

## Where We Are Right Now

### What's shipped (Phases 0-8)

**Python body substrate** — persistent Python process (`body/server.py`) speaking JSON-RPC over stdin/stdout. Sandboxed exec with AST security guards, restart-on-crash, 30s timeout. 38 tests.

**Codebase graph** — tree-sitter indexer + rustworkx directed graph. PageRank, HITS (hubs/authorities), Louvain community detection. Indexes 84 files in ~270ms. Repo map equivalent to Aider's — we already have the structural awareness engine.

**Vault body** — Ori MCP subprocess connected via JSON-RPC. Full query API (ranked, warmth, explore, fading, similar, important). Adds persistent cross-session memory that no competitor has.

**rlm_call** — sub-reasoning primitive. AsyncAnthropic, 15-call cap, depth=1 guaranteed (sub-calls can't recurse). Parallel `rlm_batch` via 5-slot semaphore. Measured: 4 parallel calls in 3.4s. **This is our architect engine — built but unused for planning.**

**Codebase signature** — compiled markdown summary (lean/standard/deep/max). Stats, entry points, HITS authorities, Louvain modules, type hubs. Loaded into system prompt as stable prefix. ~600 tokens at standard level. **Currently loaded EVERY turn, even for tasks that don't need it.**

**Vault signature** — orient output compiled into prefix. Identity, goals, pending. ~250 tokens.

**Agent loop** — REPL-mandatory path: model writes Python in Repl tool, composes operations, uses `codebase.*` and `vault.*` in namespace. Legacy tools (Edit, Write, Bash, Grep, Read, Glob) available alongside. **16+ tools exposed always.**

**Phase 8 judgment tools** — 5 methods on `codebase` object: `find_similar_patterns`, `suggest_location`, `find_convention`, `detect_duplication`, `is_consistent_with`. Unique to Ori — no competitor has structural code judgment as first-class agent tools.

**Post-edit refresh** — `CodebaseGraph.refresh_files()` re-parses changed files after Edit/Write, patches the graph in-place. Fixes stale-graph thrash. Wired via `onFileMutated` callback in loop.ts.

**Benchmark infrastructure** — `bench/quick.ts` with per-turn verbose logging, tsc validation, diff saving for post-hoc judging. Tested on Sonnet + Qwen.

### The proven result

```
Sonnet 4.6 — rename task (3 runs):
  BARE:           6 turns, 26K tokens, 3/3 pass
  HARNESS-STRICT: 4 turns, 10K tokens, 3/3 pass
  Delta: -33% turns, -60% tokens, -20% wall
  Code quality: IDENTICAL (same edits, same files, tsc passes both)

Qwen 3.6 — same task:
  BARE:           6 turns, 29K tokens, 3/3 pass
  HARNESS-STRICT: 15 turns, 88K tokens, 0/3 pass
  Thesis: model-conditional. Claude composes. Qwen doesn't.
```

### The gap

Aider achieves **4.2x** fewer tokens than Claude Code. We achieve **2.5x**. The 1.7x gap comes from:

1. **Tool schema overhead** — 16+ tool definitions serialized every API call. Each tool definition is ~200-400 tokens. That's 3-6K tokens/call in tool schemas alone.
2. **Signature always-on** — ~600 tok codebase + ~250 tok vault = ~850 tok prefix on every turn, even for "rename this function" where structural awareness isn't needed.
3. **No planning split** — model does both reasoning AND execution. Aider splits these across models. We have `rlm_call` for exactly this but don't use it.
4. **Single editing strategy** — model writes Edit tool calls always. No diff-format output, no whole-file mode, no model-specific editing style.

---

## Three Optimizations

### Optimization 1: Dynamic Tool Exposure

**Problem:** Every API call serializes all 16+ tool schemas. Each schema is 200-400 tokens. For a simple Edit task, the model doesn't need VaultAdd, VaultExplore, WebSearch, WebFetch, etc. That's 3-6K tokens wasted per turn.

**Solution:** Task-phase tool sets. Only expose tools relevant to the current phase.

```
PHASE: explore
  Tools: Repl (has codebase.*, vault.*)
  Total: 1 tool schema (~400 tok)

PHASE: edit
  Tools: Edit, Write, Repl
  Total: 3 tool schemas (~900 tok)

PHASE: verify
  Tools: Repl, Bash (for running tests/tsc)
  Total: 2 tool schemas (~500 tok)

PHASE: full (default, backwards-compatible)
  Tools: all 16+
  Total: ~5K tok
```

**Implementation:**

File: `src/tools/toolSets.ts` (NEW)
```typescript
export type TaskPhase = 'explore' | 'edit' | 'verify' | 'full';

export const TOOL_SETS: Record<TaskPhase, string[]> = {
  explore: ['Repl'],
  edit: ['Repl', 'Edit', 'Write'],
  verify: ['Repl', 'Bash'],
  full: [], // empty = all tools
};

export function getToolsForPhase(
  registry: ToolRegistry,
  phase: TaskPhase,
): ToolDefinition[] {
  const allowed = TOOL_SETS[phase];
  if (allowed.length === 0) return registry.definitions();
  return registry.definitions().filter(t => allowed.includes(t.name));
}
```

File: `src/loop.ts` — change `tools` from constant to per-turn:
```typescript
// Before each API call:
const tools = getToolsForPhase(registry, currentPhase);
```

**Phase detection:** Start with a simple heuristic. First turn = 'explore'. After model emits any Edit/Write call = 'edit'. After all edits done (model returns text-only) = 'verify'. Override via slash command: `/phase explore`.

**Expected savings:** 3-5K tokens/turn reduction on non-explore turns. Over a 4-turn task: 12-20K saved. That alone could push us from 2.5x to 3x+.

**Risk:** If the model needs a tool that's not in the current phase set, it'll get "unknown tool" error and waste a turn. Mitigation: always include Repl (which has codebase.* and vault.* internally), and keep 'full' as fallback.

### Optimization 2: Architect/Editor Split via rlm_call

**Problem:** The main model does both planning AND execution. Planning burns expensive output tokens on reasoning that could be done by a cheaper model. And the planning context (full codebase awareness) is different from the editing context (focused file content).

**Solution:** Two-phase pattern using existing `rlm_call` infrastructure.

**How Aider does it:** o3-high (architect) generates a plan in prose. Plan is passed to gpt-4.1 (editor) which only writes code. Architect never touches files. Editor never reasons about architecture. Result: 83% on polyglot benchmarks.

**How we'd do it (per model family):**

```
Anthropic family:
  Architect: Opus 4.6 via rlm_call (deep reasoning, ~$15/M input)
  Editor: Sonnet 4.6 as main model (fast edits, ~$3/M input)
  Reviewer: Opus via rlm_call again (verify plan was executed correctly)

  Cost math (CORRECTED):
    Without architect (current):
      4 turns with growing context (1.6K→2.1K→2.8K→3.3K) = 10K total
      Exploration results accumulate in history, re-sent every turn.

    With architect:
      Architect call: ~2K input (signature + task) + ~500 output = ~2.5K
      Editor turns: 2-3 turns × ~2K input (plan + file, NO exploration history)
      Total: ~7-8K per task — LESS than current because exploration is eliminated.

    The savings come from eliminating exploration turns. The architect reasons
    over the compact signature (not full files). The editor never sees grep
    results, Repl output, or search data — just the plan. Context grows slower.

    Aider's 4.2x comes partly from this — architect eliminates the "grep
    around, read files, understand structure" phase that burns tokens in
    accumulating context.

  Verdict: architect split is an EFFICIENCY win on most tasks, not just quality.
  Bigger wins on complex tasks (more exploration eliminated). May also help
  on simple tasks by skipping the exploration turn entirely.

OpenAI family:
  Architect: o3-high via rlm_call
  Editor: gpt-4.1 as main model
  (This is literally Aider's 83% benchmark configuration)

Qwen family:
  Architect: qwen3.6-plus via rlm_call
  Editor: qwen3.6-plus as main model (same model, but planning call
           gets a different system prompt: "You are a planner. Output
           a structured edit plan. Do not write code.")
  (Even same-model split helps because the planning prompt constrains output)

DeepSeek family:
  Architect: deepseek-reasoner (R1) via rlm_call
  Editor: deepseek-chat as main model
```

**Implementation:**

File: `src/config/types.ts` — add architect config:
```typescript
export interface ArchitectConfig {
  enabled: boolean;
  /** Model to use for planning. Defaults to primary model. */
  model?: string;
  /** Minimum file count to trigger architect split. */
  complexityThreshold: number; // default: 3
  /** Max tokens for planning response. */
  planBudget: number; // default: 1500
}
```

File: `src/memory/architect.ts` (NEW) — planning call:
```typescript
export async function generateEditPlan(
  task: string,
  codebaseSignature: string,
  replBridge: ReplBridge,
  config: ArchitectConfig,
): Promise<EditPlan> {
  // 1. Use Repl to gather context (find_symbol, show_dependents, etc.)
  // 2. rlm_call with planning prompt: "Given this codebase structure
  //    and this task, produce a structured edit plan."
  // 3. Parse plan into {files, changes, verification}
  // 4. Return plan for editor to execute
}
```

File: `src/loop.ts` — before the main loop, optionally run architect:
```typescript
if (architectConfig.enabled && estimatedComplexity >= architectConfig.complexityThreshold) {
  const plan = await generateEditPlan(userPrompt, signature, repl, architectConfig);
  // Inject plan into the first message as system context
  // Switch to 'edit' phase tools
}
```

**Hypothesis:** Efficiency AND quality improvement. The architect call costs ~2.5K tokens but should eliminate 1-2 exploration turns that would cost 3-5K each (and pollute context history for all subsequent turns). Expected savings: 20-30% fewer total tokens on complex tasks. **This hypothesis is UNVERIFIED and gated by Phase C measurement.**

**Why it should work:** Exploration results (grep output, file contents, Repl results) go into conversation history and get re-sent on EVERY subsequent API call. The architect replaces all that with a ~500 token plan. The editor's context stays lean because it never sees the raw exploration data.

**Risk:** Adds an extra API call, which worsens 429 rate limits. Must be implemented AFTER token trimming (Phase A) gives us headroom. Fails open to non-architect path if planning call fails.

### Optimization 3: Lazy Signature Loading

**Problem:** Codebase signature (~600 tok) and vault signature (~250 tok) are baked into the system prompt at session start and included on EVERY API call. For a 4-turn rename task, that's 3.4K tokens of signature overhead (850 × 4 turns). The model may not need structural awareness for simple tasks.

**Solution:** Don't include signatures in system prompt by default. Instead, make them available via a lightweight tool that the model can call IF it needs structural context.

**Implementation:**

Option A: **Signature-on-demand tool**
```typescript
// New tool: CodebaseOverview
// When called, injects the codebase signature into the next turn's context
// Model calls it when it needs structural awareness, skips it for simple edits
{
  name: 'CodebaseOverview',
  description: 'Get a structural overview of the codebase (top files, modules, type hubs). Call this when you need to understand the architecture before making changes.',
  input: { level: 'lean | standard | deep' },
  execute: async () => { return codebaseSignatureMd; }
}
```

Option B: **Task-gated inclusion**
```typescript
// In prompt.ts: only include signature if task is classified as 'explore'
if (taskPhase === 'explore' || taskPhase === 'full') {
  sections.push(`# Codebase Proprioception\n${codebaseSignature}`);
}
```

Option C: **Prompt cache dependency**
```
// If using Anthropic (prompt cache available): always include (it's cached after turn 1)
// If using OpenAI-compat (no cache): lazy-load only
if (provider === 'anthropic') {
  // Include in prefix — cached, effectively free after turn 1
  sections.push(signature);
} else {
  // Don't include — model can request via tool if needed
}
```

**Recommended:** Option C. Anthropic prompt caching makes the signature nearly free. Non-Anthropic endpoints pay full price every turn, so lazy-load there.

**Expected savings:** 850 tok/turn saved on non-Anthropic endpoints. Over 4 turns = 3.4K. On Anthropic with caching: no savings needed (cache already handles it).

---

## Build Order (revised per Codex review)

Codex corrections applied:
- Architect split contradicted itself (20-30% savings vs "neutral"). Gated by measurement.
- Architect split adds API calls → worsens 429 rate limits. Do AFTER token trimming.
- Phase detection heuristic is brittle. Need explicit loop state + fallback.
- Aider 4.2x comparison is apples-to-oranges until benchmark protocol matches.

```
Phase A: Token pressure controls (DO FIRST)
  - src/tools/toolSets.ts (NEW) — dynamic tool exposure per phase
  - Explicit loop state machine for phase (not heuristic "first turn = explore")
    with fallback-to-full on mismatch
  - Signature gating by provider + task phase in prompt.ts
  - Keep preflight auto-disabled in REPL mode (already done)
  - Add per-turn token attribution logs: { tools_schema, signature, history, user }
    to bench/quick.ts verbose output
  - Benchmark: run 5x matrix before/after on Sonnet
  - Gate: must show measurable token reduction before proceeding

Phase B: Validate efficiency + stability
  - Rerun 5x matrix: Sonnet + Qwen × (rename + explore) × 5 runs
  - Check: pass-rate stability (no regression from tool stripping)
  - Check: 429 rate limit improvement (fewer tokens/turn = more headroom)
  - Check: actual token attribution (where do tokens go now?)
  - Gate: pass rate ≥ current AND token efficiency improved

Phase C: Architect/editor split (BEHIND FLAG)
  - experimental.architectSplit: boolean (default false)
  - Trigger ONLY on complex tasks (≥3 files touched or high uncertainty)
  - Fail-open: if planning call fails or times out, fall back to non-architect path
  - Benchmark: same 5x matrix WITH and WITHOUT architect flag
  - Hypothesis: 20-30% fewer total tokens via eliminated exploration turns
  - Gate: must show measurable improvement. If neutral or worse, disable.

Phase D: Model-family interface routing
  - Config: models.primary.interface: 'repl' | 'editblock' | 'auto'
  - Auto-detection by model family (Claude → repl, Qwen → editblock, etc.)
  - Per-family prompt profiles (shorter for editblock path)
  - Benchmark: Qwen editblock vs Qwen REPL-mandatory vs Qwen bare
  - Gate: Qwen editblock must reach ≥80% pass rate
```

---

## What We're NOT Doing

- **Full state machine** (inspect→plan→mutate→verify) — Aider proves simpler approaches work. Our dynamic tool exposure achieves similar benefits with less complexity.
- **Per-turn compression** — no evidence it helps more than threshold-triggered compaction.
- **Multi-agent hierarchies** — "most teams skip to Level 4 multi-agent then spend months debugging coordination" (Twitter).
- **More tools** — we're REDUCING tools per phase, not adding. Gemini CLI ships with 5.
- **Diff-format output** — would require model fine-tuning awareness. Search/replace editblock is good enough and works across all models.

---

## Success Criteria

| Metric | Current | Target | Stretch |
|---|---|---|---|
| Token efficiency (Claude) | 2.5x | 3.5x | 4x |
| Token efficiency (Qwen) | 0.4x (worse) | 1.0x (parity) | 1.5x |
| Pass rate (Claude) | 100% | 100% | 100% |
| Pass rate (Qwen) | 0-67% | 80%+ | 90%+ |
| Tool schemas per call | ~5K tok | ~500-900 tok | ~400 tok |
| Signature overhead (non-cached) | 850 tok/turn | 0 tok (lazy) | 0 tok |

---

## Appendix: Model Family Routing Table

| Family | Interface | Architect | Editor | Signature |
|---|---|---|---|---|
| Anthropic (Claude) | REPL-mandatory | Opus via rlm_call | Sonnet (main) | Always-on (cached) |
| OpenAI | REPL-available | o3-high via rlm_call | gpt-4.1 (main) | Lazy (no cache) |
| Qwen | Editblock (no REPL) | qwen3.6 via rlm_call | qwen3.6 (main) | Lazy (no cache) |
| DeepSeek | Editblock (no REPL) | deepseek-reasoner via rlm_call | deepseek-chat (main) | Lazy (no cache) |
| Local (Ollama) | Editblock (no REPL) | same model | same model | Lean only |

**Interface key:**
- **REPL-mandatory:** Read/Grep/Glob stripped. Model composes in Python REPL. Proven 2.5x on Claude.
- **REPL-available:** All tools available. Model can use REPL or sequential tools. Safe default.
- **Editblock:** No REPL. Search/replace editing only. Fewer tools. Shorter prompt. For models that fight the REPL.
