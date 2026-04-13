# Ori CLI v1.0 — RMH-Native Agent Harness

## Context

Ori CLI has a working agent loop, 6-signal graph-aware preflight, permission system, multi-model routing (18 models, 8 providers), OAuth, Ink UI, and Ori MCP vault integration. But the harness doesn't use Ori's full cognitive engine (Q-value learning, spreading activation, stage meta-learning are running but unrewarded), the system prompt tells the model about memory instead of structurally forcing it, and there are critical bugs silently corrupting tool rendering and Gemini use. ByteRover CLI (3,800 stars) validates the market with BM25 keyword search and zero learning. We have a 12-stage cognitive engine. v1.0 wires the harness into the engine, implements the 7 RMH patterns from vault research, fixes all critical bugs, and ships.

## Two Tracks (parallel where possible)

**Track A: Cognitive Harness (Phases 0-4, 6)** — the unique value
**Track B: Product Polish (Phase 5)** — Claude Code parity
**Ship (Phase 7)** — npm publish + GitHub

## Phase 0: Critical Bug Fixes

*Size: Medium | Prerequisite for everything*

### 0A. Tool result casing — `src/ui/app.tsx`
`formatToolResult()` switch uses lowercase (`'read'`, `'bash'`) but tools register PascalCase (`'Read'`, `'Bash'`). All results fall through to generic format. Fix: match PascalCase names.

### 0B. Gemini tool result name — `src/router/providers/google.ts`
Line 39: `functionResponse.name` uses `tool_use_id` instead of tool name. Gemini can't correlate results. Fix: maintain `Map<id, name>` in provider, populated from `tool_use_start`, used when building `functionResponse`.

### 0C. Wire real reflection — `src/memory/postflight.ts`
Internal `triggerReflection()` stub just concatenates text. Replace with call to `triggerReflectionWithModel()` from `reflection.ts`. Thread `router` through `runPostflight` → `loop.ts`.

### 0D. Config permissions → UI state — `src/index.ts`, `src/ui/app.tsx`
`config.permissions.mode` is loaded but never read. Map to initial `permissionMode` state. Pass as prop to `App`.

### 0E. Persist OAuth refresh tokens — `src/auth/oauth.ts`
`refreshOAuthToken()` updates in-memory only. Add `persistCredentials()` that writes back to `~/.claude/.credentials.json` atomically.

### 0F. Call `ori_orient` at session start — `src/index.ts`
`vault.orient()` exists but is never called. Call after `vault.connect()`, display orient results on boot screen.

**Verify:** Gemini tool calls work. Tool result previews show tool-specific format. Session starts with orient output. Config permissions take effect.

---

## Phase 1: WAKE — Warm Context Layer

*Size: Small | Depends: Phase 0*

### 1A. Warm context assembly — `src/memory/warmContext.ts` (NEW)
Assemble ~2K token always-present block:
- Identity (from `vaultIdentity.identity`)
- Goals (from `vaultIdentity.goals`)
- Last reflection (query `vault.queryRanked('recent reflection', 1)`)
- Top 3 warm notes (`vault.queryWarmth(goals_text, 3)`)

Stored in module-level variable. Refreshes every 10 turns or after reflection fires. NOT per-turn — identity-anchored and persistent.

### 1B. Inject into system prompt — `src/prompt.ts`
Add `warmContext` to `PromptContext`. Inject between identity and operational rules (top edge = highest attention per Lost in the Middle).

### 1C. Survives compaction — `src/memory/compact.ts`
Prepend warm context to compacted summary message. Identity+goals block is NEVER lost.

**Verify:** `npx tsx src/index.ts`, inspect system prompt, confirm warm context at top. Run to compaction, confirm it survives.

---

## Phase 2: ORIENT — Layered Context Assembly + Structural Enforcement

*Size: Medium | Depends: Phase 1*

### 2A. Position-aware injection — `src/memory/preflight.ts`
Replace single `<system-reminder>` blob. Split into:
- **Before user message:** Semantic vault notes + episodic examples (high attention)
- **After user message:** Contradictions as `<required-response>` blocks + proprioception (closest to generation = highest salience)

Refactor `injectPreflightContext` to accept position parameter.

### 2B. Structural contradiction enforcement — `src/memory/preflight.ts`
Contradicting notes become:
```xml
<required-response>
Your vault says: "[note title]" — this contradicts the current approach.
Address this tension before proceeding.
</required-response>
```
Not advisory text. Structural block the model can't skip.

### 2C. Plan mode removes write tools — `src/loop.ts`
Before `router.stream()`:
```ts
const activeTools = permissionMode === 'plan'
  ? tools.filter(t => registry.isReadOnly(t.name))
  : tools;
```
Model can't call what doesn't exist. Remove the post-stream plan interception (line ~252) — unnecessary when tools are structurally absent.

**Verify:** Plan mode, confirm Edit/Write/Bash never appear in model output. Add contradicting vault note, confirm `<required-response>` appears.

---

## Phase 3: CAPTURE — Echo/Fizzle + Identity-Conditioned Retrieval

*Size: Medium | Depends: Phase 2*

### 3A. Echo/fizzle detection — `src/memory/echoFizzle.ts` (NEW)
After each assistant response, scan for preflight note title terms in the output:
- **Echo** (terms found): note was useful → boost signal
- **Fizzle** (retrieved, not referenced): note was noise → weak negative

### 3B. Feed to Q-values — `src/memory/vault.ts`
Add `vault.update(title)` wrapping `ori_update` (already exposed in MCP). Echo notes get updated (triggers vitality bump + activation spread). Fizzle notes are left alone (natural decay handles them).

### 3C. Identity-conditioned queries — `src/memory/preflight.ts`
Thread `vaultIdentity` to `runPreflight`. Prefix queries with identity context:
```
[Context: Aries, building TypeScript agent harness, user prefers clean architecture]
<actual user query>
```
Q-values learn what's relevant to THIS agent.

**Verify:** Run multiple sessions. Notes consistently cited should show rising Q-values. Unused notes should decay.

---

## Phase 4: SLEEP — Episodic Few-Shot + Session Learning

*Size: Medium-Large | Depends: Phase 3*

### 4A. Structured session reflection — `src/memory/sessionReflection.ts` (NEW)
At session end (before `vault.disconnect()`), cheap model call produces:
```json
{
  "summary": "Built permission system for Ori CLI",
  "what_worked": ["Promise-based callback paused generator cleanly"],
  "what_to_avoid": ["System prompt rewrite — structural changes more effective"],
  "tags": ["permission", "harness", "structural-enforcement"]
}
```
Saved to vault as `session-reflection: <tags> — <date>`.

### 4B. Episodic retrieval at session start — `src/memory/warmContext.ts`
During warm context assembly, query `vault.queryRanked('session reflection ' + cwd_name, 2)`. If matching session reflections found, inject as `<episodic-example>` in warm context. Model starts knowing how past similar sessions went.

### 4C. Detailed session logging — `src/session/learningLog.ts` (NEW)
Structured JSON log written throughout each session. This is the data layer everything else learns from.

```
.aries/logs/{timestamp}.jsonl
```

Events logged:
- `retrieval` — query, returned notes, signal sources (which RRF signal contributed each note)
- `tool_call` — name, args, success/failure, duration
- `tool_result` — output summary, isError
- `user_correction` — when user redirects approach, corrects framing, rejects plan
- `plan_decision` — accepted/rejected with feedback
- `echo` — note title, context (what task type it echoed in)
- `fizzle` — note title, context
- `model_switch` — when cheap vs expensive model was used and why

Wire into `loop.ts`: log after every tool result, after every echo/fizzle detection, after plan approval/rejection.

### 4D. Decouple experience log from compaction — `src/memory/experienceLog.ts`
**Current state (broken):** `appendExperience()` only fires from `compact.ts extractAndSave()`. Compaction rarely fires in practice — users start new sessions instead. The experience log is effectively dead.

**Fix:** Add new write triggers:
- **Session end** — sessionReflection (4A) writes its `what_to_avoid` entries as experience entries
- **User correction** — when the user pushes back on approach/framing, detect and log the pattern
- **Task outcome** — after an edit passes/fails tests, after a plan is accepted/rejected
- **Sleep mode** — the agent reviews session logs and writes synthesized learnings

Redesign the log format from append-only FIFO to categorized + utility-weighted:
```markdown
# Experience Log

## Communication [utility: 0.9]
- [2026-04-09] When analyzing related work, absorb and learn — don't frame competitively

## Retrieval [utility: 0.7]
- [2026-04-09] Graph exploration produces high-echo notes for architecture questions

## Tool Use [utility: 0.8]
- [2026-04-06] Always run Repl search before Bash grep — Repl is faster and indexed

## Failure Modes [utility: 0.95]
- [2026-04-09] Experience log gated behind compaction — decouple learning from compression
```

Utility scores updated during sleep mode. Contradictions resolved (new entry replaces old, not appended alongside).

### 4E. Sleep mode — `src/session/sleepMode.ts` (NEW), `aries sleep` CLI command
Dedicated processing time for the agent to learn from accumulated experience. Triggered manually (`aries sleep`) or at session end.

**What happens during sleep:**
1. Load session logs from `.aries/logs/` (all since last sleep)
2. Compute statistics — tool success rates, retrieval hit rates, correction frequency
3. Analyze retrieval quality — which RRF signal source produced notes that echoed vs fizzled
4. Process user corrections — identify behavioral patterns, update experience log
5. Vault maintenance — find contradictions between notes, update stale info, strengthen connections
6. Update agent config — write learned parameters to `.aries/agent-config.yaml`
7. Write experience entries — synthesized procedural learnings

Uses cheap model calls for analysis. The agent has the best vantage point for self-evaluation — it knows what information it needed and didn't have, what it had and didn't use.

Research backing: Advisor Models paper (arXiv:2510.02453) proves small models can learn to steer large models through RL on task outcomes. Sleep mode is the reflective-practice analog — review, analyze, adjust — before we have infrastructure for real RL.

### 4F. Agent configuration as learning medium — `.aries/agent-config.yaml` (NEW)
A harness-readable, agent-writable config file that encodes procedural knowledge:

```yaml
# Written by the agent during sleep mode. Read by harness at session start.
retrieval:
  rrf_weights:
    semantic: 2.0
    keyword: 1.0
    graph: 1.5
    warmth: 0.25

communication:
  default_depth: terse
  depth_triggers:
    - pattern: "paper analysis"
      depth: thorough
    - pattern: "quick fix"
      depth: minimal

tools:
  preferred_first:
    refactoring: [Repl, Edit]
    debugging: [Repl, Bash]

failure_modes:
  - pattern: "competitive framing when analyzing related work"
    correction: "absorb and learn, don't differentiate"
```

The harness reads this at session start and injects relevant sections into context. The agent updates it during sleep mode. This is procedural memory — it changes how the agent behaves, not just what it knows.

**Verify:** Run two sessions with logging. Run `aries sleep`. Confirm experience log updated, agent-config written. Start third session — confirm config entries appear in context.

---

## Phase 5: Product Polish (PARALLEL with Phases 1-4)

*Size: Large | Depends: Phase 0 only*

### 5A. Wire `/resume` — `src/ui/app.tsx`
Add `case '/resume'` calling `resumeFromSession()` from `session/resume.ts`. Populate `messagesRef.current`, show system message.

### 5B. Rich tool rendering — `src/ui/app.tsx`, `src/ui/messages.tsx`
- **Edit:** Return unified diff from `EditTool.execute`. Render with green/red coloring.
- **Bash:** Extract exit code, show `"Exit 0 | 3 lines"`.
- **Read:** Show `"285 lines (1-285)"`.
- **Glob/Grep:** Show match counts + first few results.

### 5C. File snapshots + `/undo` — `src/tools/snapshot.ts` (NEW)
Capture pre-edit file content before Write/Edit. Store in session-scoped array (max 20). `/undo` restores last snapshot. `/undo N` reverts N steps.

### 5D. Message virtualization — `src/ui/messages.tsx`
Cap `displayMessages` render at last 100. Show `"(N earlier messages)"` indicator.

### 5E. UX completions — `src/ui/app.tsx`, `src/ui/statusBar.tsx`
- Double Ctrl+C to exit (first shows warning, second exits within 2s)
- Token warning in status bar at 85% and 95%
- Terminal bell on completion when not focused

**Verify:** `/resume` loads prior session. `/undo` reverts edit. 200+ messages render smoothly. Token warning appears.

---

## Phase 6: Cognitive Loop Integration

*Size: Small | Depends: Phases 1-4*

### 6A. Full WAKE → ORIENT → WORK → CAPTURE → COMPRESS → SLEEP audit
Walk through one full session confirming each phase fires in order. Add `--verbose-memory` flag to print cognitive loop state to stderr.

### 6B. New loop events for observability
```ts
| { type: 'warm_context'; tokenCount: number }
| { type: 'echo_fizzle'; echoed: string[]; fizzled: string[] }
```
Shown as dim system messages. User sees the cognitive loop working.

**Verify:** `npx tsx src/index.ts --verbose-memory`, inspect full loop trace.

---

## Phase 7: Ship

*Size: Medium | Depends: All*

### 7A. Package — `package.json`
Version `1.0.0`. Bins: `ori`, `aries`. Add `"files"` field.

### 7B. GitHub push
Init remote, push. Tag `v1.0.0`.

### 7C. README
Lead with: "The only coding agent with a recursive memory harness." ASCII architecture diagram. Cognitive loop explanation. Model table. Quick install.

### 7D. npm publish
`npm publish --access public` as `@ori-memory/aries`.

### 7E. Benchmarks (v1.1)
LoCoMo + LongMemEval-S test runner. Evidence for technical superiority claim. Can follow ship.

---

## Phase 8: SDK Layer (post-ship)

*Size: Medium | Depends: Phase 7*

Replicate the Anthropic Claude Agent SDK pattern (`github.com/anthropics/claude-code-sdk-python`) for Ori CLI. The SDK spawns `ori` as a subprocess and wraps it with a typed API.

### 8A. Python SDK — `ori-agent-sdk`
- `query(prompt, options)` → async iterator of messages
- `OriAgentOptions`: permission_mode, model, vault_path, allowed_tools, disallowed_tools
- Custom tools as in-process MCP servers (`@tool` decorator)
- Hooks as Python functions for PreToolUse/PostToolUse
- `OriSDKClient` for bidirectional interactive sessions

### 8B. TypeScript SDK — `@ori-memory/agent-sdk`
Same API surface, wraps `ori` CLI via `child_process.fork()`.

### 8C. Differentiators over Anthropic's SDK
- `vault_path` option → memory compounds across calls
- Any model (18 shortcuts, 8 providers), not Claude-only
- RMH cognitive loop automatic — every `query()` benefits from prior sessions
- Permission modes as first-class options

This is a **distribution layer** — enables developers to embed Ori in scripts, CI, notebooks, multi-agent orchestration. One-weekend build once CLI is solid.

---

## Phase 9: Cognitive Anywhere — Entropy-Triggered Memory-First Reasoning (v1.1)

*Size: Medium | Depends: Phase 7 (ship) | Target: Paper #2 artifact*

The core differentiator. During LLM streaming, monitor token-level entropy via logprobs. When entropy sustains above threshold (model is uncertain), interrupt generation:
1. Query Ori for relevant memory about the uncertain concept
2. If memory hit → inject memory, restart generation (**REMEMBER**)
3. If memory miss → inject reasoning prompt, restart generation (**THINK**)

**First try to remember. If nothing helps, then think.** Human cognition mechanized.

Research basis: "Think Anywhere in Code Generation" (Jiang et al., arXiv 2603.29957) — entropy-triggered selective reasoning. We extend it with a persistent knowledge graph as first resort.

### 9A. Logprobs Parsing — `src/router/providers/openai-compatible.ts`

Add `logprobs: true, top_logprobs: 5` to the request body. Parse logprobs from SSE chunks (`choice.logprobs.content[]`). ~30 lines.

Providers with logprobs: Ollama, OpenAI, DeepSeek, Groq, Gemini, Together, Fireworks.

### 9B. Entropy Monitor — `src/cognition/entropyMonitor.ts` (NEW)

Rolling Shannon entropy computation:
```
H(t) = -Σ p(token_i) * log₂(p(token_i))
```
Computed from top logprobs at each token position. Spike detection: entropy above threshold for N consecutive tokens (sustained uncertainty, not noise).

```typescript
interface EntropySource {
  measureUncertainty(context: string, token: string): Promise<number>;
}

class LogprobEntropy implements EntropySource { /* real entropy from logprobs */ }
class SelfReportEntropy implements EntropySource { /* Claude fallback */ }
class HybridEntropy implements EntropySource { /* logprobs when available, self-report otherwise */ }
```

~100 lines.

### 9C. Cognitive Interrupt — `src/cognition/cognitiveInterrupt.ts` (NEW)

The abort/query/decide/restart loop:

1. Entropy spike detected in stream
2. Abort current generation (AbortController.abort())
3. Extract concept from last ~50 generated tokens
4. Query Ori: `vault.queryRanked(concept, 3)`
5. **Decision gate:**
   - If top result relevance > threshold → REMEMBER (inject memory)
   - If no relevant memory → THINK (inject reasoning prompt)
6. Reconstruct prompt: original context + partial generation + `<memory>` or `<think>` block
7. Restart generation from new context
8. Log event: remember vs think, concept, memory title (if hit), latency

```typescript
interface CognitiveEvent {
  type: 'remember' | 'think';
  concept: string;
  entropy: number;
  memoryTitle?: string;    // if remember
  tokenPosition: number;
  latencyMs: number;
}
```

~200 lines.

### 9D. Loop Integration — `src/loop.ts`

Wire entropy monitor into the streaming loop. New LoopEvent types:

```typescript
| { type: 'entropy_spike'; concept: string; entropy: number; position: number }
| { type: 'cognitive_interrupt'; mode: 'remember' | 'think'; concept: string; memoryTitle?: string }
```

Handle interrupt/restart cycle within the existing `agentLoop` generator. ~70 lines.

### 9E. Claude Fallback — `src/router/providers/anthropic.ts`

Claude doesn't expose logprobs. Fallback: add to system prompt:
```
When uncertain during generation, output <UNCERTAIN>concept</UNCERTAIN> tags.
```
Parse these from stream, trigger Ori query, inject result. Cruder but functional.

### 9F. Adaptive Preflight Depth — `src/memory/preflight.ts`

Score query entropy BEFORE retrieval to select depth:

- **Low entropy** (exact match likely): keyword + warmth only → 50ms, 2 results
- **Medium entropy** (moderate ambiguity): keyword + semantic + warmth → 200ms, 5 results  
- **High entropy** (abstract/cross-domain): all 6 signals + higher limits → 500ms, 15 results

Entropy signals: keyword hit count, embedding score spread, cross-project span. Data already returned by `ori_query_ranked`.

### Token Economics

| Mode | Tokens per hard task | Cost (Sonnet, 100/day) |
|------|---------------------|----------------------|
| Always-think (standard CoT) | 2,500 | $112/mo |
| Think Anywhere (selective) | 800 | $36/mo |
| Cognitive Anywhere (memory hit) | 650 | $29/mo |
| No thinking | 500 | $22/mo (worse quality) |

Memory hits skip reasoning entirely — retrieval is cheaper than thinking.

### Paper #2: "Remember Anywhere: Entropy-Triggered Associative Retrieval"

This phase IS the artifact. Experimental comparison:
- **Baseline A**: Orient-only (bulk preload)
- **Baseline B**: Preflight per-turn (current Phase 2)
- **Experiment**: Cognitive Anywhere (mid-generation entropy-triggered)
- **Metrics**: token cost per session, echo rate (existing echo/fizzle system), task completion quality, context utilization

The echo/fizzle system from Phase 3 is the measurement instrument. Add retrieval cost tracking and we have the full dataset.

### Files

| File | Action | What |
|------|--------|------|
| `src/cognition/entropyMonitor.ts` | NEW | Rolling entropy, spike detection, adapter pattern |
| `src/cognition/cognitiveInterrupt.ts` | NEW | Abort/query/decide/restart loop |
| `src/router/providers/openai-compatible.ts` | MODIFY | Add logprobs parsing to SSE stream |
| `src/router/providers/anthropic.ts` | MODIFY | Self-reported confidence fallback |
| `src/memory/preflight.ts` | MODIFY | Adaptive depth based on query entropy |
| `src/loop.ts` | MODIFY | Wire entropy monitor, handle interrupts |

**~400 lines total. The capability nobody else has.**

### Why This Compounds

Session 1: model thinks from scratch at every uncertainty (standard).
Session 10: model remembers solutions from sessions 1-9 at uncertainty points.
Session 50: model almost never needs to think — the vault resolves most uncertainties.

The more you use Ori, the less you need to reason. That's the product thesis.

---

## Build Dependency Graph

```
Phase 0 (bugs) ──────────────────────────────────────┐
    │                                                  │
    ├── Phase 1 (WAKE)                                 │
    │       │                                          │
    │       └── Phase 2 (ORIENT)                       ├── Phase 5 (polish)
    │               │                                  │   [PARALLEL]
    │               └── Phase 3 (CAPTURE)              │
    │                       │                          │
    │                       └── Phase 4 (SLEEP)        │
    │                               │                  │
    │                               v                  │
    │                      Phase 6 (integration) ◄─────┘
    │                               │
    │                               v
    └──────────────────────► Phase 7 (ship v1.0)
                                    │
                                    v
                            Phase 8 (SDK layer)
                                    │
                                    v
                            Phase 9 (Cognitive Anywhere — v1.1)
                                    │
                                    v
                            Paper #2 (Remember Anywhere)
```

## Files Created (NEW)

| File | Phase | Purpose |
|------|-------|---------|
| `src/memory/warmContext.ts` | 1 | Always-present identity block |
| `src/memory/echoFizzle.ts` | 3 | Usage tracking for retrieved notes |
| `src/memory/sessionReflection.ts` | 4 | Structured session-end synthesis |
| `src/session/learningLog.ts` | 4 | Structured JSONL session logging for learning |
| `src/session/sleepMode.ts` | 4 | Sleep mode — retroactive session analysis and learning |
| `.aries/agent-config.yaml` | 4 | Agent-writable config for procedural learning |
| `src/tools/snapshot.ts` | 5 | Pre-edit file capture for undo |
| `src/cognition/entropyMonitor.ts` | 9 | Rolling entropy from logprobs, spike detection |
| `src/cognition/cognitiveInterrupt.ts` | 9 | Abort/query Ori/decide remember vs think/restart |

## Files Modified (key changes)

| File | Phases | What changes |
|------|--------|--------------|
| `src/loop.ts` | 0,2,3,4,6 | Reflection wiring, plan tool filtering, echo/fizzle call, learning log writes, new events |
| `src/memory/preflight.ts` | 2,3 | Layered injection, structural contradictions, identity-conditioned queries |
| `src/memory/postflight.ts` | 0 | Wire real reflection |
| `src/memory/compact.ts` | 1 | Warm context preservation |
| `src/memory/experienceLog.ts` | 4 | Decouple from compaction, categorized format, utility weighting, contradiction resolution |
| `src/memory/vault.ts` | 3 | Add `update()` method |
| `src/prompt.ts` | 1,4 | Warm context injection, agent-config injection at session start |
| `src/ui/app.tsx` | 0,4,5 | Casing fix, /resume, /undo, session reflection, UX |
| `src/ui/messages.tsx` | 5 | Virtualization, rich tool rendering |
| `src/router/providers/google.ts` | 0 | Tool name fix |
| `src/auth/oauth.ts` | 0 | Persist refresh tokens |
| `src/index.ts` | 0,1,4 | Orient call, config→permission, warm context init, load agent-config |
| `src/router/providers/openai-compatible.ts` | 9 | Logprobs parsing from SSE stream |
| `src/router/providers/anthropic.ts` | 9 | Self-reported confidence fallback |

## What Makes This Beat Everything

| | Claude Code | ByteRover | Ori CLI v1.0 | Ori CLI v1.1 |
|---|---|---|---|---|
| Memory | None | Manual curation + BM25 | 12-stage Q-learning + graph traversal + echo/fizzle | + entropy-triggered mid-generation retrieval |
| Learning | None | None | Q-values learn per-note, stages self-configure | + learns when retrieval beats reasoning |
| Identity | None | None | Identity conditions retrieval | Same |
| Cross-session | None | Cloud sync | Vault + episodic few-shot | Same |
| Cognition | Fixed CoT or none | None | None | Cognitive Anywhere: remember-first, think-as-fallback |
| Context assembly | One system prompt | Flat list | Layered by position (Lost in the Middle) | + surgical mid-generation injection at entropy spikes |
| Models | Anthropic only | 20+ providers | 18 shortcuts, 8 providers | + logprobs entropy from all OpenAI-compatible |
| Feedback loop | None | Access count bump | Echo/fizzle → Q-values → stage learning | + cognitive events feed Q-values (remember hits boost notes) |
| Token efficiency | Full CoT always | N/A | Selective retrieval (60x cheaper than raw context) | + 74% reasoning token savings via memory-first |
