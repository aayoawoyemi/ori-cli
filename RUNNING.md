# RUNNING — Aries Agent Runtime

Living document. Session-by-session evolution of what we're building, why, and what's next. Read top-to-bottom for arc; jump to "Current Plan" for what to execute.

Last updated: 2026-04-19 (end-of-day). **Codemode pivot — A1-A5 shipped. Active plan now lives in [CODEMODE_ROADMAP.md](CODEMODE_ROADMAP.md).** Token-fix pass below is retained as historical prep work, not the active focus.

---

## Codemode pivot (2026-04-19 PM session)

Token-fix pass was tuning. Codemode IS the kernel. The realization of the session: Phase 7's 2.14× token win (mandatory REPL > additive harness) never shipped as the CLI's main runtime — we were still iterating symptoms. Codemode-as-default closes that gap.

### The thesis, sharpened
**Every agent gets its own computer.** Persistent Python process as the substrate. Model as CPU. Codebase graph as filesystem. Vault as state. Shell/web/compute as namespace primitives. Not a metaphor — the literal architecture. Nobody ships this.

### What shipped today (A1-A5 per CODEMODE_ROADMAP)
- **`fs.write` / `fs.edit` / `fs.patch`** — Python namespace primitives for file mutation. Route through TS bridge via `fs_request`/`fs_response` callbacks, mirror the vault proxy pattern exactly. Workspace-scope check on bridge side; outside-workspace writes return a teaching error pointing to `ask()`. Full fuzzy-matching logic reused from `EditTool` (exported `fuzzyFind` + `generateDiff`), zero duplication.
- **`shell.run`** — system-shell execution via `spawn`, 2MB output cap, timeout (default 30s, max 600s), cwd-scoped. No Bash-tool-style blocklists — inside codemode there's no zigzag to prevent.
- **`web.fetch` / `web.search`** — delegate to existing `WebFetchTool` / `WebSearchTool`. Bridge parses the flat text output back into structured `list[dict]` for Python consumption. WebSearchConfig plumbed through `setup.ts` via `setWebSearchConfig`.

### Files touched this session
- **New**: `body/fs.py`, `body/shell.py`, `body/web.py`, `CODEMODE_ROADMAP.md`, `ORI.md`, memory feedback files in `~/.claude/projects/.../memory/`
- **Modified**: `body/server.py` (imports, FS/SHELL/WEB instantiation, namespace registration, response routing for fs/shell/web), `src/repl/bridge.ts` (cwd + webSearchConfig state, onLine routing for 3 new request types, 3 handler methods, 3 dispatchers, parseWebSearchOutput helper, assertInsideWorkspace), `src/repl/setup.ts` (setCwd + setWebSearchConfig wiring), `src/tools/edit.ts` (exported fuzzyFind + generateDiff), `src/prompt.ts` (PROJECT_MD_CHAR_CAP 6000 → 20000 so new ORI.md fits in cached prefix)

### What didn't ship and why
- **A6 say/ask** — needs UI integration in `src/ui/app.tsx` (say must stream to user-visible text channel; ask needs blocking modal). Deferred to be done focused, not rushed.
- **A7 rich docstrings + first-turn namespace dump** — quick but held so it can ship alongside A8/A9 as one coherent discoverability change.
- **A8 strip tool registry** — depends on A6 (model needs `say`/`print` before we remove top-level text-emission paths).
- **A9 prompt rewrite** — after A8 so the prompt reflects the actual schema.
- **A10 integration smoke test** — end-of-phase gate before Phase B (episodic errors).

### Architectural state
Python namespace now has: `codebase`, `vault`, `research`, `fs`, `shell`, `web`, `rlm_call`, `rlm_batch`, `json`, `reindex`. **Every capability Edit/Write/Bash/WebFetch/WebSearch provided is now reachable inside Repl.** A8 (removing those from the top-level schema) is unblocked on capability grounds; only sequencing remains.

---

## YC Summer 2026 — apply May 4 (14 days away)

Decision made 2026-04-19: apply with the codemode thesis. Details in [CODEMODE_ROADMAP.md §Phase E](CODEMODE_ROADMAP.md) but the headline:

- **Company**: Ori. **Tagline**: *"AI runtime. Every agent gets its own computer."*
- **Proof**: Phase 7 benchmark (2.14× token reduction vs additive harness), 230+ stars on Mnemos, A1-A5 shipped architecture.
- **Minimum-viable YC-day artifact**: codemode working for reads+writes+shell+web, 30-second demo video, one-page write-up, HN post live.
- **Positioning correction**: NOT "AI research lab" (reads as academic) — "AI runtime, horizontal substrate, coding agent is first surface."
- **Risk**: writing the application cold without a fresh commit is weaker. Push to have A6-A9 and benchmark numbers shipped by May 1.

## Distribution plan (summary; full detail in CODEMODE_ROADMAP §Phase D)

- Open-core: substrate open (Aries CLI + Mnemos + codemode MCP adapter), Ori Cloud closed.
- Distribution surface = MCP server. `ori-codemode-mcp` on npm. Plugs into Claude Code / Cursor / Claude Desktop — we become substrate for their harnesses rather than competitor to them.
- Paper strategy: no arXiv gate. Long structured blog post with reproducible benchmark code wins HN for this audience (Simon Willison / Swyx / SemiAnalysis precedent).
- Launch assets: 30-second demo video (Claude Code vs Aries on same task), paper-style blog post, `ori-codemode-mcp` on npm, HN post, reply-guy blitz to named amplifiers (Simon, Swyx, Letta, oh-my-pi, Nate Berkopec, Jeremy Howard).
- Honest star projection: 800-3000 first month if all assets ship. 100 would mean something went wrong.

---

## Code discipline (new rules file: `ORI.md`)

Written 2026-04-19 based on user's existing Cursor rules (`~/nba-robinhood/.cursor/rules/code-implemtation-rules.mdc`) plus Feb 2026 AI-slop research. Loaded automatically into cached prefix via `src/prompt.ts:264-269`.

Key principles:
- Root cause over symptom. Name the structural claim or call the fix a band-aid.
- **What counts as slop** (defined concretely): length bloat, over-engineering, defensive bloat, fabrication, scope creep, type gymnastics, logging noise, god functions, stringly-typed code, dead-code preservation, context rot, attention dilution. 12 patterns, each traced to a real mistake.
- Dense WHY comments — this codebase IS a design journal. Match `src/loop.ts` / `body/server.py` / `body/vault.py` house style.
- File headers (path, purpose, key pieces, role). Block comments every 5-15 lines of logical step. Function docstrings on exports.
- Soft LOC limits (Python 300-400, TS 400-600).
- Callback pattern for Python↔TS is canonical — don't invent a new transport when adding a bridged primitive.
- Permission flow for mutations must route through the gate (unless `alwaysAllowTools` opts in) — never bypass.

---

## One-Sentence Thesis

We are not building a coding agent with memory. **We are building an agent runtime whose working set is a cache, whose memory is a scheduler-backed compounding store, and whose first public face is a coding agent.**

---

## Naming (locked 2026-04-19)

Three layers, three names. Greek-pair coherence.

- **Ori Mnemos** (μνήμος, memory) — the memory substrate. MCP server + vault + warmth + wiki-link PPR + Q-value reranking. Already shipping (npm, 230+ stars). Commodity-resistant. Plugs into any runtime.
- **Ori Nous** (νοῦς, mind/intellect) — the kernel. Working-set management, uniform explore verb, handle-based continuous eviction, tiered router, lane orchestration. Built on Mnemos. Not yet shipping — the build target.
- **Aries** — the first harness. Reference coding agent. Distribution vehicle. Built on Ori Nous.

One-sentence story: **Ori Mnemos remembers. Ori Nous thinks. Aries acts.**

---

## The Philosophy

### OS-level reframe
Context window = cache. Vault = state of record. Codebase graph = filesystem. Conversation = execution trace. The agent is a process scheduled against a memory hierarchy.

Once taken seriously, every design decision is forced:
- Cache is small, hot, evicted continuously. You don't "compact" L1 cache — category error.
- The vault is durable, reward-shaped, and grows. Filesystem plus learned index.
- The harness is the kernel. It schedules. The model is the CPU.

### The real claim
Compounding memory + intelligent scheduling beats bigger windows.

Bigger windows are a hardware bet. We are making a systems bet. The bet survives 1M tokens, survives 10M — because dilution is a real cost of pre-stuffing and scheduling has no window ceiling.

### Three load-bearing commitments
1. **One retrieval verb across surfaces.** `explore(surface, query)` where surface ∈ {vault, codebase, web, …}. Same shape, surface-specific implementation. Model learns one move.
2. **The harness owns the working set; the model owns the thinking.** Tool results become handles, not content. Conversation preserved. Tool exhaust compressed continuously, not at a cliff.
3. **Hard rails > text instructions.** Structural enforcement wins. Prose rails break under load.

---

## Convergence Signal — April 2026 Week

Five external thinkers independently articulated pieces of this architecture in one week. Saved as vault note: `april-19-2026-convergence-signal-five-thinkers-arrived-at-our-agent-runtime-architecture-independently-in-one-week.md`.

- **OpenFang** (`openfangg`): "agent operating system." Rust one-binary, kernel scheduling, capability gates, WASM sandbox, memory-as-filesystem, hands-as-daemons, channel adapters as drivers.
- **OpenAI Agents SDK** (Apr 15): "Harness separate from compute." Agent loop + MCPS/tools run on Temporal/AWS; sandbox swappable (E2B, Cloudflare, Vercel). Validates the kernel/surface split.
- **Aakash Gupta** (Apr 15): "Subagents are garbage collection for AI... the memory architecture is the moat." Our thesis stated externally.
- **Chayenne Zhao** (SGLang core dev): token efficiency crisis essay. Claude Code destroys prefix cache. Agent/inference co-design missing. Engineering sense is sorting.
- **Nate Berkopec**: "The chat interface of coding agents is entirely wrong." Every Enter is a just-born agent. Matches our cursive instinct.
- **Gym-Anything** (CMU): any software → agent environment. Eval substrate.

Read: we're the synthesis, not the inventor. Novelty is in the combination. Distribution window measured in months.

---

## Competitive Landscape (Researched 2026-04-19)

| System | Context hierarchy | Retrieval verb | Subagent clean slate | Eviction |
|---|---|---|---|---|
| OpenAI Agents SDK | Flat + manifest | N tool-specific | Yes (sandbox) | Rolling summaries |
| Claude Agent SDK / Code | Flat + CLAUDE.md | N verbs | Yes (YAML subagents) | Cliff (`/compact`, auto) |
| Gemini CLI | Flat | N verbs | Yes | Spoke purges |
| OpenFang | Flat unified | N tools (38 built-in) | Yes | Fuel/epoch metering |
| **Letta / Letta Code** | **CoALA hierarchy** | **Self-editing memory tools** | **Yes + shared memory** | **Continuous micro-eviction** |
| LangGraph | Flat | Per-node | Per subgraph | None (checkpoints) |

**Letta is the real memory competitor.** Not OpenAI, not Claude Code. They already ship CoALA Core/Recall/Archival + continuous eviction + memory-first coding agent (Letta Code, #1 model-agnostic on Terminal-Bench, Dec 2025).

### How we differentiate vs Letta
- Graph-aware retrieval (wiki-link PPR — they don't have it)
- Uniform explore across surfaces (they're memory-only)
- Warmth-as-reward-signal (bandit-style; they have retention/summarization, not learned ranking)
- Markdown-native git-versioned memory (they're Postgres-backed)
- Local-first (they're cloud-first)

### White space (novel if shipped together)
Uniform retrieval verb + CoALA hierarchy + continuous micro-eviction + speculative retrieval during input + kernel-level capability gates. No shipped system combines more than two of these.

---

## Past-Me Prior Work (Vault Notes Pulled)

- `harness-is-an-eight-component-operating-system` (Mar 18) — 8 canonical components: execution runtime, tool registry, context engine, **memory (#4)**, state persistence, lifecycle, guardrails, observability. Memory is one component, not the OS.
- `codemode-primitive-set-seven-native-operations` (Apr 14) — 7 primitives: vault, codebase, research, sandbox.fs, sandbox.net, sandbox.serve, sandbox.compute. `sandbox.compute.spawn(agent, task)` + `parallel(tasks)` already designed for orchestration. `sandbox.serve` (agents creating endpoints) flagged as differentiator.
- `claude-managed-agents-launched-april-8-2026` — Anthropic commoditizing the harness. Past-me's verdict: reposition Ori as memory substrate, plug INTO Managed Agents via MCP. They win the boring infra; Ori wins the memory layer. **This matters: Aries is the demo, Ori is the long game.**
- `claude-code-source-reveals-a-while-true-generator-loop-with-three-layer-context-assembly-and-five-compaction-strategies` (Mar 31) — decompiled CC architecture mapped.

---

## What Claude Code + oh-my-pi Taught Us (Research 2026-04-19)

Decompiled Claude Code source is on-machine at `C:/Users/aayoa/Downloads/claw-code-src/` (`QueryEngine.ts`, `Task.ts`, `Tool.ts`). Can reference directly during implementation.

### Claude Code patterns worth stealing
- **Hard numeric output limits**: "≤25 words between tool calls, ≤100 words final." Ships as system-prompt invariant. Measurably reduces yap.
- **Static/dynamic system prompt split** for prompt-cache discipline. Static prefix cached across orgs; dynamic suffix below boundary. Changing dynamic busts cache. We have `CACHE_PREFIX_BREAK` but then inject via message mutations post-prompt — architecturally messier.
- **Tool-result disk spillover**: large results write to disk, model gets path + preview. Conversation never accumulates noise.
- **Five compaction strategies** layered: tool-result budget → history snip → microcompact → context collapse → autocompact. Snip (keep head/tail, drop middle) is cheap and we don't do it.
- **Subagent architecture**: YAML frontmatter agent definitions, own tool allowlist, own context. Parent only sees synthesis.
- **Read-only tools run concurrent, writes serial.** We partially have this.

### Oh-my-pi patterns worth stealing
- **Bash interceptor as runtime block with tool-name mapping.** Regex catches bad bash, returns `Blocked: use 'read' instead` — only when 'read' is actually in the current tool set. Much stronger than our prose routing.
- **Tool-result artifact spill with back-reference**: truncate in transcript at N KB, full stream to `artifact://<id>`, include URL in metadata. This is the handle pattern shipping.
- **Compaction that protects `read` and `skill` outputs.** Prune exhaust first.
- **Hashline edits**: content-hash anchors per line (`41#ZZ`). Model references anchors, not text. 10× improvement on weaker models, 61% fewer output tokens on Grok 4 Fast.
- **Intent field** on every tool call (`_i: "Updating imports"`). 4-6 word present-participle. Cheap telemetry + anti-yap.
- **TTSR (Time-Traveling Streamed Rules)**: regex-on-stream, abort + inject. Complex, defer.

---

## Current State of aries-cli (Where Token Bloat Lives)

Read at 2026-04-19 from `src/loop.ts`, `src/prompt.ts`, `src/memory/preflight.ts`, `src/memory/warmContext.ts`, `src/tools/bash.ts`, `src/config/defaults.ts`, `src/tools/toolSets.ts`, `src/router/index.ts`.

### Per-session bloat (loaded every session start)
- Warm context: ~2000 tokens (identity + goals + last reflection + 3 warm notes)
- Ambient signatures: codebase 1500 + vault 1500 = 3000 tokens (configurable but on by default)
- System prompt boilerplate (Repl doc + rules + tool usage): ~3-4K tokens
- Project MD files (ORI.md / CLAUDE.md): up to 40K tokens, UNBOUNDED
- **Session start total: ~10K tokens before the first user word.**

### Per-turn bloat (injected every turn)
- Preflight block: 500-1000 tokens (compound vault call OR 5-way fan-out — ranked + warmth + explore + similar)
- Proprioception block: ~50 tokens (`<context-status>Context: X%...`)
- **Per turn: ~600 tokens of pure injection.**

### Structural issues causing retry/oscillation
- Both Bash and REPL in lean phase → model reaches for Bash, gets blocked, retries. `tryRewriteAsRepl` in `src/tools/bash.ts` covers ~10 patterns, misses many.
- Output Discipline is prose (`src/prompt.ts` lines ~79-99). Opus ignores under context bloat.
- Compaction disabled in loop (`src/loop.ts` line 215: "Auto-compaction disabled — never compact mid-task") but config still says `compact.auto: true` — drift.
- Dynamic tools enabled (`dynamicTools: true` in defaults) — lean phase working, but auto-widens on any non-lean tool call. Good.
- Router HAS `cheap` / `reasoning` / `bulk` slots + `cheapCall`, but default config has empty `models: {}` → tiering infra exists but isn't wired for end users by default.

---

## Evolution of the Plan

### Initial framing (early this session)
RMH = Recursive Memory Harness, `vault.explore` should be default. Kernel rewrite: handle-based eviction, lane orchestration, status bar reframe, cursive streaming, voice input.

### User correction 1
"We're not having one voice that is poison. Writing to the main voice almost never happens." → Pushed toward CoALA-style tiered memory with graduation gates.

### User correction 2
"We're not building a coding agent. The coding agent is the first demo of the runtime philosophy." → Reframed as agent runtime. Scope expanded to kernel.

### User correction 3 (critical)
"Don't write the full spec. Focus on what's actually broken NOW." → Cut the kernel rewrite. Scoped down to token-heavy fix pass only.

### User correction 4 (critical)
"No injections. Preflight shouldn't exist. Even the MD file doesn't need to be 40[K]." → Confirmed no-injection principle. Kill preflight entirely.

### User correction 5 (critical)
"Hard-coded computation, where it literally cannot do anything else, is better than text instructions. Bash is the wrong primitive if we're blocking it — is REPL the right primitive? That's the real question." → Reframed: the problem isn't Bash-vs-REPL, it's having BOTH in the lean tool set creating choice paralysis. Drop Bash from lean. Structural enforcement.

### User observation (not yet fixed, flagged for kernel phase)
"Other CLIs feel structured, ours feels flaily — 'let me try this, let me try that'." → Real issue: we lack procedural scaffolding. No TodoWrite, no skills, subagents not default. CC and oh-my-pi feel structured because the agent isn't improvising — it's ticking boxes in a todo, delegating to subagents, invoking skills. **Kernel work. Deferred.** (Smartness research later showed TodoWrite is mostly theatre — <2pt SWE-Bench delta — so deprioritized further.)

### User correction 6 (lean phase)
"How does it know to get out of lean phase?" → Audit revealed lean-phase widen is dead code (model can't call a tool not in its schema). User direction: **drop phase tracker entirely.** Full tool set every turn, accept the schema cost, real usage will reveal what breaks. Bash + REPL choice paralysis to be mitigated via description asymmetry + tool ordering + soft rewrite, not structural blocking.

### User correction 7 (real fix for Bash)
The clean answer is **make Bash a sub-primitive of REPL** (top-level tools become Repl/Edit/Write only; `bash.run("npm test")` lives inside the Repl namespace). Mirrors oh-my-pi. Eliminates schema-level choice between Bash and REPL because Bash isn't there. **Deferred to kernel work** — requires permission-model rework (bash.run inside Repl needs same approval flow as top-level Bash).

### Smartness research arrived (2026-04-19)
Sub-agent finding: ~60% of felt smartness at fixed model tier is harness, ~40% is model. Three biggest "feel smarter than CC at same Sonnet tier" levers: symbol-graph awareness made visible (we have the infra in `body/codebase.py`, just under-surfaced), episodic memory recall with VISIBLE "Recall:" prefix (model emits when pulling, not harness injecting — preserves no-injection rule), productive disagreement (no "you're right" openers, hard prompt rule). TodoWrite is theatre per benchmarks. Skills system pointless until 10+ skills exist.

### Audit research arrived (2026-04-19)
Sub-agent surfaced 20 additional structural fixes beyond our original 9. Biggest finds: cache_prefix_break is broken (env block above the break busts cache daily), postflight runs cheapCall every turn silently, microcompact code is unreachable dead code, mode reminders leak across transitions without synthetic markers, no per-turn tool result aggregate cap, cheapCall has no maxTokens override, medium effort always burns 1500 thinking tokens. Folded into Current Plan below.

---

## Shipped 2026-04-19 (Batches 1-3, 17 items, type-checks clean)

**Batch 1 — cache + kill injections (highest cost wins):**
- A1 ✅ cache_prefix_break fix — Repl doc, project instructions, ambient sigs all moved into cached prefix; only Environment block (date, git) is in the dynamic remainder. Date changes won't bust cache anymore. Likely the single biggest cost win.
- B1 ✅ killed preflight per-turn injection
- B2 ✅ killed proprioception block
- B3 ✅ gated postflight behind `turnHadToolWork`; bonus: removed `trackAgreementRatio` (was writing keyword-scan results to vault on every threshold)
- B4 ✅ dropped warm-context tickTurn loop
- B6 ✅ killed echo/fizzle entirely
- A6 ✅ (bonus, fit naturally) capped project MD load at 6000 chars (~1500 tokens)

**Batch 2 — prompt + config tightening:**
- A5 ✅ shrunk ambient signatures (codebase 1500→600, vault 1500→600 in defaults.ts)
- A7 ✅ trimmed Repl doc (extensive rewrite, leads with structural code understanding, much tighter)
- B5 ✅ shrunk warm-context auto-inject to identity+goals only (400 chars each, removed 2 vault queries)
- C1 ✅ asymmetric tool descriptions — Bash narrow + forbidding ("If reaching for cat/grep/find/ls/head/tail/wc, you are using the wrong tool")
- C2 ✅ REPL first in tool ordering — `definitions()` sorts Repl to the front of the schema
- C3 ✅ numeric output limits — Output Discipline now has hard ≤25/≤100 word limits at the top
- C4 ✅ no-sycophancy hard rule — Epistemic Integrity strengthened with explicit "no 'You're right' openers"
- E1 ✅ promoted vault.explore() as primary verb in Repl doc
- F1 ✅ visible "Recall:" pattern — Memory section instructs model to surface vault hits with prefix
- F2 ✅ surfaced symbol-graph — Repl doc now leads with find_symbol/show_dependents/communities/find_convention

**Batch 3 — soft-rewrite + cleanup:**
- C5 ✅ pedagogical soft-rewrite annotations — "[harness routed your Bash through Repl. Next time call Repl directly with: ...]" replaces silent routing
- C6 ✅ expanded soft-rewrite patterns — added tail -N/bare, head bare, ls path/-la, bare find, wc -c
- D2 ✅ compressed research-mode reminder from ~400 words to ~50
- B7 ✅ capped + cached experience log read (mtime-based cache, 1600 char return cap)
- B8 ✅ stripSyntheticFromMessages O(N²) → O(1) when no markers (sentinel check)

**Batch 4 — structural + behavior (post-greenlight):**
- A2 ✅ phase tracker dropped — loop.ts simplified, full tool set every turn. toolSets.ts kept as dead code for later sweep.
- A3 ✅ per-turn tool result aggregate cap — 25K char cap across all tool_results in one message, proportional shrinkage when exceeded
- A4 ✅ microcompact every turn at 100K token threshold — prunes old tool_result bodies to '[output pruned]', protects most recent 40K. STOPGAP, to be replaced by kernel handle-based rehydration
- A8 ✅ cheapCall maxTokens override — optional param on cheapCall, duck-typed setter on AnthropicProvider, applied at 5 call sites (postflight 2500, compact-extract 2500, compact-summary 3000, reflection 2000, session title 100)
- A11 ✅ token estimate consistency — standardized on 3.5 chars/token (was 4.0 in tokens.ts vs 3.5 in anthropic.ts)
- C7 ✅ few-shot routing examples in Repl doc — 3 examples using OUR verbs (vault.explore with "Recall:" prefix, codebase.find_symbol + show_dependents, rlm_batch composition). Not CC-verbatim.
- C8 ✅ recovery loop on failure classifier — consecutive-failure counter in loop.ts; 1 failure nudges "state hypothesis before retrying"; 2+ nudges vault.explore(error) before retry. Memory-first flavor, not in CC/oh-my-pi.
- D1 ✅ mode reminders wrapped with synthetic markers — research/plan/explore reminders now use wrapSynthetic, strip cleanly each turn, no more leak across transitions
- E2 ✅ dropped identity contamination from preflight query — was prefixing `[Aries, building TypeScript agent harness]` into every semantic search
- E3 ✅ single ambient context wrapper — three separate H1/H2 headers collapsed into one `## Ambient Context` with tagged subsections

**Cut from plan**: A9 (thinking budget = 0) — audit was wrong, it's already a cap.

**Deferred from Tier 4 (small, could land anytime but finicky for the win):**
- A10 tool result error dedup — needs history comparison logic
- C10 nudge aggregation — needs synth marker extension to tool_result blocks
- C9 REPL batching nudge — already effectively in new Repl doc from Batch 2

---

## Still in Plan — Awaiting Decision (parked from this session)

These were flagged as touching loop logic / wanting your eyes before execution:
- **A2** drop phase tracker entirely (touches loop.ts + toolSets.ts; need to verify no other consumers read `phase`)
- **A3** per-turn tool result aggregate cap (algorithm change to applyResultBudget; edge cases on proportional shrinkage)
- **A4** microcompact every turn at threshold (moves dead code from compact.ts into live loop; threshold calibration)
- **A8** cheapCall maxTokens override (requires ModelProvider interface change to add optional setter)
- **C7** few-shot routing examples (needs taste — could bloat prompt if done badly)
- **C8** recovery loop on failure classifier (new logic in loop.ts; could create loop trap if diagnosis turn itself fails)
- **D1** wrap mode reminders synthetic markers (latent bug fix; want test coverage we don't have)

Tier 4 small wins still available (low risk, can batch anytime):
- **A10** tool result error dedup
- **A11** token estimate consistency (3.5 vs 4)
- **C9** REPL batching nudge (already partly in new Repl doc)
- **C10** nudge aggregation
- **E2** drop identity contamination from preflight query (moot since preflight killed)
- **E3** single ambient context wrapper

---

## Current Plan — Token-Fix Pass (full reference list below)

Comprehensive list synthesized from original 9 + audit's 20 + smartness research. All file-level edits. No new architecture. Grouped by intent. Within each group, **HIGH** items first.

### Group A — Cache & cost discipline (largest cost wins)

- **A1. [HIGH] Fix the cache_prefix_break.** `src/prompt.ts` ~lines 216-241. Move `## Environment` block (gitBranch + date + cwd + shell) BELOW `CACHE_PREFIX_BREAK`. Currently above → date changes daily → entire prefix cache busted every day. **Likely the single biggest cost win available.** Source: audit finding #4 + CC pattern.
- **A2. [HIGH] Drop the phase tracker entirely.** `src/tools/toolSets.ts` and `src/loop.ts`. Remove `PhaseTracker`, `dynamicTools` config flag. Always expose all tools (CC pattern). Lean-phase widen was dead code anyway.
- **A3. [HIGH] Per-turn tool result aggregate cap.** `src/loop.ts:97-120` (`applyResultBudget`). Currently 10K per result with no aggregate. Add: if combined results in one message exceed ~25K chars, proportional shrinkage (`25000 / N` each). Source: audit #6.
- **A4. [HIGH] Microcompact every turn at threshold.** Move `pruneToolOutputs` from `src/memory/compact.ts:43-72` (currently unreachable since auto-compact disabled) into `src/loop.ts` to run when cumulative history > 100K tokens, protecting most recent 40K of tool output. Pure bookkeeping, no LLM. Source: audit #7 + CC microCompact pattern.
- **A5. [MEDIUM] Shrink ambient signatures.** `src/config/defaults.ts`: `signature.codebase.maxTokens: 1500 → 600`, same for vault. (Original #4.)
- **A6. [MEDIUM] Cap project MD load.** `src/prompt.ts:244-258`. Truncate ORI.md/CLAUDE.md at ~1500 tokens. (Original #5.)
- **A7. [MEDIUM] Trim the Repl doc section** in `src/prompt.ts` ~lines 133-202. Keep top 8 primitives inline, reference extended list compactly. (Original #4 partial.)
- **A8. [MEDIUM] cheapCall maxTokens override.** `src/router/index.ts:563-593`. Add optional `{ maxTokens?: number }` param. Pass 1500 for reflection, 2500 for extraction. Source: audit #14.
- **A9. [MEDIUM] Medium effort thinking budget = 0.** `src/router/index.ts:11-16`. Currently `medium: { thinkingBudget: 1_500 }` — every turn burns 1500 thinking tokens. Drop to 0. User raises `/effort high` when needed. Source: audit #15.
- **A10. [LOW] Tool result error dedup.** `src/loop.ts:447-511`. If identical error output to prior turn, replace with `[same error as prior turn]`. Source: audit #19.
- **A11. [LOW] Token estimate consistency.** `src/router/providers/anthropic.ts:115` (3.5) vs `src/utils/tokens.ts` (4). Standardize on 3.5. Causes 1M-beta gate misfires. Source: audit #16.

### Group B — Kill hidden spend (silent token leaks)

- **B1. [HIGH] Kill preflight per-turn injection.** `src/loop.ts:188-214`. Remove `runPreflight` call + `injectTurnSynthetics` for preflight blocks. Functions stay in `src/memory/preflight.ts` for repurpose later as session-start soft-map. (Original #1.)
- **B2. [HIGH] Kill proprioception block.** `src/loop.ts:198-213` (`proprioceptionBlock`). Delete entirely. (Original #2.)
- **B3. [HIGH] Gate postflight behind work-worthy signal.** `src/loop.ts:584-585`, `src/memory/postflight.ts:42-71`. Currently runs `cheapCall` + agreement-ratio keyword scan every turn (silent second LLM call). Gate behind `hadToolCalls && messages.length > prior`. Remove agreement-ratio scanning entirely (keyword slop). Move reflection to explicit `/reflect` command. Source: audit #1.
- **B4. [HIGH] Drop warm-context tickTurn loop.** `src/loop.ts:591-594`, `src/memory/warmContext.ts:36-84`. Without injection, the 2 vault queries every 10 turns are dead weight. Keep `assembleWarmContext` for session-start only. Source: audit #2.
- **B5. [MEDIUM] Kill warm-context auto-inject into system prompt.** `src/prompt.ts:52`. Remove the `sections.push(ctx.warmContext)` OR shrink to ~200 tokens identity-only (no warm notes, no last reflection). Preference: shrink, identity anchoring is cheap and useful. (Original #3.)
- **B6. [MEDIUM] Gate echo/fizzle behind preflight enabled.** `src/loop.ts:575-581`, `src/memory/echoFizzle.ts`. Without preflight per-turn, echo detection runs against stale `lastPreflight` and writes to vault for nothing. Gate or move to compaction-only. Source: audit #3.
- **B7. [LOW] Cap experience log read + cache.** `src/prompt.ts:124-127`, `src/memory/experienceLog.ts`. Cap at ~400 chars. Read once at session start, cache the string. Source: audit #5.
- **B8. [LOW] stripSyntheticFromMessages O(N²) fix.** `src/memory/syntheticMarkers.ts:44-54`. Only scan the last user message (synthetics are always injected there). Source: audit #10.

### Group C — Routing & discipline (anti-yap, tool selection)

- **C1. [HIGH] Asymmetric tool descriptions.** `src/tools/bash.ts:259-262` and the `Repl` tool definition. Make Bash description short and forbidding: "Run shell commands. ONLY for: build, test, git, install, file management. NEVER for reading files (use Repl), searching code (use Repl), listing directories (use Repl)." Make Repl description rich and inviting with composable patterns. Lifted directly from CC's leaked Bash prompt.
- **C2. [HIGH] Tool ordering — REPL first in schema.** `src/tools/registry.ts` definition order. Anthropic models have measurable primacy bias. Free win.
- **C3. [HIGH] Add numeric output limits.** `src/prompt.ts` `## Output Discipline` section — prepend: "Keep text between tool calls to ≤25 words. Keep final responses to ≤100 words unless the task requires more detail." From CC. (Original #8.)
- **C4. [HIGH] No-sycophancy hard rule.** `src/prompt.ts` Operational Rules section — add: "If user's premise is wrong, state disagreement in one sentence before complying. Never preface with 'You're right'." From smartness research. Tiny edit, real felt-IQ bump.
- **C5. [MEDIUM] Pedagogical soft-rewrite annotations.** `src/tools/bash.ts:294-317`. Current `[Routed via Repl: ...]` is silent-ish. Make it: `[Used Repl instead. Next time call repl directly: print(fs.read('foo.ts')). This saved one turn.]` In-context learning per occurrence.
- **C6. [MEDIUM] Expand soft-rewrite patterns.** `src/tools/bash.ts:175-242` (`tryRewriteAsRepl`). Currently ~10 patterns. Add: `tail -N`, `head file` (no N), `ls path`, `ls -la`, `wc -c`, bare `find path`, `head/tail | grep` chains.
- **C7. [MEDIUM] Few-shot examples in system prompt.** `src/prompt.ts`. Add 2 short examples: "User asked: where is X used? → assistant called codebase.search/find_symbol via Repl, not bash grep." Few-shot is more sticky than instruction.
- **C8. [MEDIUM] Recovery loop on failure classifier.** `src/loop.ts`. If last tool failed, inject a "recovery turn" system nudge forbidding identical retry and requiring stated hypothesis. Track consecutive-failure counter; at 2, force a `read`/`grep` before any write. From smartness research.
- **C9. [LOW] REPL-batching nudge.** `src/prompt.ts` Repl doc — ensure the Composition Pattern example leads, with explicit "prefer one Repl turn with composed operations over N sequential tool calls."
- **C10. [LOW] Nudge aggregation.** `src/tools/nudge.ts:36-47`. Emit nudges as single aggregated `<system-reminder>` per turn, not appended emoji-lines per result. Strip after one turn via synth markers. Source: audit #20.

### Group D — Mode hygiene (latent bugs)

- **D1. [HIGH] Wrap mode reminders with synthetic markers.** `src/loop.ts:262-311` — research-mode, plan-mode, explore-mode reminders all use `content.includes(...)` dedup but lack `wrapSynthetic` markers. Means they get baked into messages permanently and leak across mode transitions. Wrap all three with distinct synth kinds (`research-mode`, `plan-mode`, `explore-mode`). Source: audit #13.
- **D2. [MEDIUM] Compress research-mode reminder.** `src/loop.ts:256-270`. Currently ~400 words. Compress to ~80 words listing the 6 verbs, drop pedagogy. Source: audit #12.

### Group E — Tool surface cleanup

- **E1. [MEDIUM] Promote `vault.explore()` as primary verb in Repl doc.** `src/prompt.ts` Repl doc vault section — reorder so `vault.explore(query, depth, limit)` leads, `query_ranked` demoted to escape hatch. No backend change. (Original #9.)
- **E2. [LOW] Identity contamination in preflight query.** `src/memory/preflight.ts:69-72`. Identity prefix corrupts semantic embedding. Drop entirely (moot if B1 lands first; do anyway for the session-start soft-map version). Source: audit #17.
- **E3. [LOW] Ambient sections single wrapper.** `src/prompt.ts:116-127`. Three separate H1/H2 headers → single `## Ambient Context` wrapper with three tagged subsections. Source: audit #18.

### Group F — Smartness multipliers (felt-IQ, no architecture)

- **F1. [HIGH] Visible "Recall:" pattern.** No file change yet — this is a behavior the model adopts via prompt instruction. Add to `src/prompt.ts` Memory section: "When you call `vault.*` and find something relevant, surface it to the user with `Recall:` prefix in your prose. Make memory hits visible — silent recall is invisible smartness." From smartness research. Pull-with-visibility, preserves no-injection rule.
- **F2. [HIGH] Surface symbol-graph awareness in prompt.** `src/prompt.ts` Repl doc codebase section — lead with `codebase.find_symbol`, `codebase.show_dependents`, `codebase.communities`, `codebase.find_convention`. We have the infra (tree-sitter + PageRank + HITS + Louvain) — it's just buried in the doc. Surfacing it = the single biggest "knows the codebase" felt-smartness unlock per smartness research.

---

## Explicitly NOT in this pass (per audit's "drop these")

- TodoWrite tool (theatre per SWE-Bench Verified ablations, <2pt delta; we're not long-horizon enough to benefit)
- Skills system / ToolSearch deferred-schema pattern (only pays off with 40+ tools; we have ~15)
- Per-tool GrowthBook-style flag overrides (CC needs this for A/B testing at scale; we don't)
- New oh-my-pi-style bash interceptor (we have `tryRewriteAsRepl` already; just expand it per C6)
- LLM-scored postflight importance (cheapCall per turn we just killed)
- Per-tool-schema cache_control markers (Anthropic caps at 4 blocks; tool schemas are already in prefix)
- Collapsing tool_result blocks into single text (violates Anthropic API pairing requirement; will 400)

---

## What's out of this pass (kernel work, deferred)

- Preflight → soft-map reframe (one-shot cached session-start map of vault topology, no per-turn inject)
- **Bash as a sub-primitive of REPL.** Top-level tools become `Repl`/`Edit`/`Write` only; `bash.run("npm test")` lives inside the Repl namespace. Eliminates schema-level Bash/REPL choice paralysis structurally. Mirrors oh-my-pi. Requires permission-model rework (bash.run inside Repl needs same approval flow as top-level Bash). **This is the real fix for the routing problem; description asymmetry + ordering + soft rewrite in the current pass are the 80% mitigation.**
- Tool-result artifact spill with handle rehydration (CC + oh-my-pi pattern; we cap at 10K, they spill to disk and re-read on demand)
- Continuous micro-eviction on unreferenced handles (beyond the simple microcompact in A4)
- Lane orchestration (user-as-hub spawn/monitor/kill primitive, parallel sub-agents)
- Streaming cutoff for text-before-tool-use (enforces ≤25 word rule structurally instead of via prompt)
- Tiered router default wiring (nano/cheap/mid/large auto-routing; infra exists, defaults don't)
- `codebase.explore` as twin to `vault.explore` (uniform retrieval verb, codebase side)
- Status bar reframe (working-set health display, not token-percentage doom meter)
- UI primitive rework (Tauri TUI-aesthetic → ambient pane)
- Voice input + speculative pre-fetch during typing
- MCP backend: make `ori_explore` the actual default at the Ori-server level
- Collapsing VaultSearch/ProjectSearch into unified scope-param tools (audit #11; possible now but lower-leverage than the in-pass items)

---

## Failure Modes Named Across This Session

Consolidated for reference. Some fixed by current plan, most applicable only when kernel work starts.

- **Retrieval silently wrong** → confidence score on explore, auto-escalate to deeper recurse or direct read below threshold.
- **Stale handle** (content changed since fetch) → hash check on rehydrate, force re-explore on mismatch.
- **Sub-agent cascade** (nested spawns blow up cost) → per-turn RLM budget + hard depth cap (default 1, deeper requires explicit approval).
- **Vault pollution** (write-back drift) → warmth decay, periodic prune, cheap-model gate on write-back.
- **Over-synthesis** (summarizer drops load-bearing detail) → synthesis always ships with 2-3 raw citation windows.
- **Latency floor** (every retrieval = explore+synthesize) → speculative pre-fetch during typing, hot cache, direct-read bypass for unambiguous ops.
- **Memory scope confusion** (writes to wrong tier) → default-to-smallest-scope + graduation gates.
- **Voice mistranscription** → only act on high-confidence final transcripts; pre-warm on partials is throwaway.
- **Autonomy drift** over many steps → check-in gates + budget caps + trace readability.
- **Poison voice** (everything writes to main vault) → tier system — most writes die in session.
- **Orphan lanes** (user ignores, cost piles) → idle timeout + auto-suspend.
- **User cognitive overload** (too many concurrent lanes) → soft cap (default 3).
- **Deadlock** (lane waits on parent) → lanes can't block, return "needs X" status and terminate.
- **Goal drift in sub-agent** → frozen task description + mid-budget audit.

---

## UI / Aesthetic Decisions

- **Keep existing color palette.** Don't redesign. Parchment was inspiration, not prescription.
- **Cursive = flowing feel, not literal italic.** Character-by-character streaming with ink-bleed easing. Terminal constrained but workable.
- **V1 stays terminal.** Fix aries-cli as terminal. Port to Tauri / ambient pane later.
- **V2 direction**: Tauri-based native window, TUI aesthetic, parchment-inspired (cream-on-ink palette, margin status), char-level streaming, optional pen sounds. Cursive italic reserved for Aries' voice; roman for code/paths.
- **V3 direction**: ambient side panel, not a terminal at all. Agent is presence, not app you open.
- **Status bar reframe** (deferred): working-set health — `3 files · 7 notes · 12 handles` — instead of `X% | Y/Z tokens`.

---

## Distribution & Positioning

- Ori Mnemos stays as-is on npm (substrate). Continue growing stars.
- Aries README rewrite: lead with **"memory-first agent runtime, coding agent included"** — not "coding agent with memory."
- We **plug into** OpenAI Agents SDK, Anthropic Managed Agents, E2B, Cloudflare Sandbox for compute/sandboxing. We **do not rebuild** them.
- Our fight is the **memory kernel layer**. Ori Nous is where we win.

---

## On-Machine Resources

- **`C:/Users/aayoa/Downloads/claw-code-src/`** — decompiled Claude Code source. `QueryEngine.ts` (master loop), `Task.ts`, `Tool.ts`. Reference directly during kernel implementation.
- **`C:/Users/aayoa/Desktop/ClaudeBot/`** — prior work, has its own `ori.config.yaml`. Unknown status, worth revisiting.
- **Vault** — `C:/Users/aayoa/brain/notes/` — 946+ notes, all prior design work queryable via `vault.*`.

---

## What to remember next session

1. **Type-checking is not runtime testing.** Everything passes `tsc --noEmit` but the new binary has NOT been launched yet. First real run is the verification. Expect at least one "oh I missed a case" moment — especially around the synthetic-marker wrapping for mode reminders (D1) and the recovery-loop counter (C8). Run it, notice what feels off, fix.
2. **A4 microcompact is a stopgap. Don't forget.** When kernel work starts, replace it with handle-based artifact spill. If `[output pruned]` markers pile up and the model gets confused trying to recover, that's the signal — time for real handles.
3. **Benchmark session is still undefined.** We said "pick 10 real user messages and replay." Never actually did it. The cost-win claims from this pass are unverified until you measure. Do it before kernel work begins — otherwise you have no baseline to compare against.
4. **Resist TodoWrite when it tempts you.** Research cited <2pt SWE-Bench delta. Our evidence says procedural scaffolding is theater for short-horizon coding. If Aries feels unstructured once you're using it, the fix is better routing + better Repl composition + subagent delegation — not a todo tool.
5. **Bash-as-Repl-sub-primitive is the real routing fix.** Current mitigation is soft (description asymmetry + ordering + rewrite annotations). If Bash still gets picked for navigation, the fix isn't a bigger description — it's removing Bash from the top-level schema and moving it to `bash.run()` inside Repl. Requires permission-model rework.

---

## Open Questions (Next Decisions)

- **Green-light the comprehensive token-fix pass (Groups A-F)?** Or cut/reorder before handoff to a different session.
- **Order of operations**: A1 (cache fix) and A2 (drop phase) first because they're highest-leverage and structural. B1-B3 (kill injections) next because they're already-decided. Then C1-C4 (routing + discipline) because they're behavior-changing. The rest can batch.
- **Benchmark session for measurement**: pick 10 user messages from a recent real session you've had. Replay before and after each batch. Total session tokens is the metric. This needs to be agreed before execution.
- **When we enter kernel-work phase, do we branch or keep going in-place?**
- **Should the kernel rewrite target Ori Nous as a separate npm package**, so Aries depends on it cleanly — or keep it inlined in aries-cli for now?
- **When do we write the README rewrite?** After token-fix works and we have measurable impact to point at.

---

## Session Credits

This document is the product of one long design session on 2026-04-19 between Aayo Awoyemi and the Aries instance running in Opus 4.7 (1M context). Research subagents contributed the agent-SDK landscape map and the Claude Code + oh-my-pi harness comparison. Vault notes queried: 14. Notes saved this session: 2 (convergence signal, naming lock).

---

## 2026-04-25 / 2026-04-26 — Honesty pass + Nous direction set

Six follow-on sessions between Aayo + Aries (Opus 4.6 / 4.7) + Codex collaboration. Token-fix-pass arc closed; harness honesty arc opened and substantially shipped; codemode-rhetoric corrected against vault canon; Ori Nous design committed for the next major arc.

### Shipped since the 2026-04-19 token-fix pass

- **Batch 1.5** — `body/schema.py` as single source of truth for `NAMESPACE_SIGNATURES`; `_enrich_exception` appends `NOTE: <primitive> returns <shape>` so wrong-shape KeyErrors self-correct without a discovery turn.
- **Batch 1.6** — `body/_protocol.py` atomic `os.write` helper; comprehensive `_stdout_lock` removal across `body/*.py`. Eliminated the `_async_raise`-mid-lock deadlock window. `bridge_callback_hang_repro.py` (50 trials) green post-fix.
- **Batch 1.7** — input-repair shim in `src/tools/repl.ts` covers 5 broken-shape cases (pre-Stream-A `{code}`, plan+code at root, stringified ops, wrong key name, missing purpose) with `NOTE: harness repaired ...` teaching channel.
- **Batch 1.8** — runtime calibration (`body/schema_calibrate.py` + `schema.calibrated.json`) catches phantom-key drift structurally; Agent tool output capture fix (subagent-mode now surfaces last Repl `output_full` when no assistant text emitted); `NAMESPACE_VERSION` blake2b hash of schema (A.9.1 pulled forward); audit pass killed `vault.top` snippet lie, `prompt.ts:46` filesystem-access lie, `compact.auto: true` config drift; `ori/ROADMAP.md` got Consumer Requests section documenting server-side snippet ask.
- **Batch 3** — per-model `MAX_TOKENS` table in `src/router/model-capabilities.ts` (Opus 4.6/4.7 → 128K, Sonnet 4.6 → 64K default / 128K upper, Haiku 4.5 → 64K); pattern lifted from CC's `utils/context.ts:149-210` with deliberate divergence (default = upperLimit on Opus for codemode maximalism). `cutoff_warning` StreamEvent + `message_delta` handler (CC pattern from `services/api/claude.ts:2266-2292`); force-flush `toolInputBuffers` in `try/finally`; stream-no-events guard (CC's `claude.ts:2350` pattern); `resolveThinkingBudget` for thinking + tiny-cap interaction; 21/21 model-capability smoke.
- **Batch 3.5 — bridge serialization fix (Codex root-cause)** — top-level TS→Python bridge requests could overlap with a running exec, causing the main loop to block on `exec_thread.join()` and starve callback responses. Pattern matched the 122s pre-existing bridge hang the standalone repros couldn't catch. Codex serialized the queue in `src/repl/bridge.ts`, kept callback responses bypassing it, added `bridge_request_serialization_smoke.ts` + `walkmode_live.ts`. Walk-codemode now clean: 1 Repl, 0 timeouts on Opus 4.6.
- **Per-op Repl execution (Codex)** — each operation in a composed batch runs independently in the shared Python namespace via `bridge.exec()` per op. Variables persist op-to-op; if op 2 fails, ops 3-5 still run. Per-op timing, per-op `lintError` (TS-shape detection per op), per-op `[harness:cutoff]` survival. Replaces all-or-nothing batch failure semantics. Composition got cheaper to attempt aggressively because failures are contained.
- **Max-tokens recovery loop (Codex/Aries)** — `MAX_OUTPUT_RECOVERY_LIMIT = 3` in `src/loop.ts`; when `[harness:cutoff` marker appears in `assistantText`, harness auto-injects a synthetic user "resume mid-thought" message and re-enters the loop. Telemetry: `max_output_recovery` + `max_output_recovery_exhausted` events. Pre-fix the model just stopped mid-sentence; user had to manually type "continue."
- **Phase B/C of Batch 3 close-out** — TS-shape detector in `src/tools/repl.ts:looksLikeTypeScriptOrJavaScript` (5 anchored TS regex patterns + `=>` catch-all) → if matched, rejection prepends actionable Edit/Write/`shell.run("npx tsx ...")` guidance. Repeated-rejection guard in `src/loop.ts` (per-turn `Map<toolName, {count, reason}>`) injects `[harness:steering]` system-reminder after 2nd same-reason rejection; one-shot per turn. 12/12 input_repair smoke including 4 new TS rejection cases + 1 Python-with-TS-tokens negative case.
- **Vault.read(None) guard** — wiki-link stubs (graph nodes without backing files) surface in `vault.explore` results with `path=None`. Pre-fix `vault.read(None)` died in `os.path.join` with cryptic TypeError; post-fix raises `VaultError` with teaching message ("Filter results with `if h['path']:` before reading").
- **Shell.run unix-ism hint enrichment** — failure-time only (zero false positives on real Unix hosts). `_UNIX_HINTS` table maps `grep/ls/cat/find/sed/head/tail/wc` to harness primitives; when a command fails AND was a unix-ism, hint appended to stderr next to the actual error. 10/10 detector cases pass.
- **Calibration fixture covers `vault.top` / `vault.neighbors` / `vault.backlinks`** — drift probe (`a10_substrate_smoke.py:#24`) verified to catch phantom keys via simulated snippet-lie test. Fixture is narrow on purpose; expands as primitives are audited live.

### The codemode-honesty correction (2026-04-26)

We are not "pure codemode" in the maximalist sense. We built a **composition surface over existing primitives**, with JSON-RPC bridge underneath. The vault already corrected this framing months ago — the rhetoric just hadn't caught up.

- Honest framing: *"Not a different computer — a better way to drive the same one."* (vault note 2026-04-20, Sonnet-inside-Aries arrived at this independently)
- "Every agent gets its own computer" = one body subprocess per `ori` launch (replicating); primitives are how the agent traverses inside it (per `replicating-and-traversing-are-nested-not-parallel`).
- Python is the **driver**, target language is anything (per `codemode-is-python-as-driver`). Kills the "I don't use Python" objection.
- The hybrid (Python REPL + JSON-RPC bridge + MCP backend) is the *intended* architecture for Aries-the-harness, not a thesis violation. The maximalist `codemode-paradigm` note (2026-04-14) was rhetorical north star; the April 19-20 notes are the corrected, vault-canonical framing.

### Where we actually are in the three-layer story

- **Mnemos (memory substrate)** — shipping. Nothing structurally missing for Aries' use today.
- **Aries (harness)** — shipping, in active polish. Per-op execution, cutoff recovery, schema honesty, bridge serialization all landed. Friction inventory below is the last leg before "harness layer is honest and feels like one substrate."
- **Nous (kernel)** — **NOT STARTED.** This is the missing piece for transformative-feeling sessions. Without it: context bloats, sub-tasks can't be cheaply forked, sessions degrade after ~hour 2 even with the polish work. With it: long sessions feel as fresh as turn 1.

### Refined product vision: Jarvis-class assistants, not pure-codemode-with-sandboxes

Sharpened by the realtor-Jarvis thought experiment (2026-04-26):

- Bounded primitive set + composition surface + kernel-level memory management = transformative.
- Sandbox-per-agent maximalism is NOT required for the personal-assistant case. The agent runs the user's tools on the user's machine — no untrusted code to isolate.
- Pure codemode (agent creates persistent infrastructure, replaces MCP, makes APIs instead of calling them) is a v2.0 / Phase F decision. Not the immediate north star.
- The unlock for Jarvis is **the kernel**, not more codemode-purity.

### Ori Nous — Batch-1 sketch (next major arc)

Three sub-batches because handle infrastructure is load-bearing for the rest:

- **Nous-1: Handle infrastructure** — replace tool_result content >2KB with `<handle:abc123>` token; `expand(handle)` primitive for rehydration; eviction after N turns; telemetry on create/expand/evict. Single biggest unlock; replaces our crude microcompact band-aid with real continuous eviction. Reference: `oh-my-pi`'s `artifact://` pattern, Letta's recall storage. ~200-300 LOC over a few sessions.
- **Nous-2: Cheap sub-agent orchestration** — `delegate(task, model='cheap')` primitive; sub-agents have restricted tool sets + own context; parent gets a synthesis handle (not full transcript); hard depth cap. Becomes cheap once handles work because parent doesn't accumulate sub-agent exhaust. Reference: Claude Code's `Task` tool + YAML subagents, OpenAI Agents SDK handoffs. ~400-500 LOC.
- **Nous-3: Tiered router auto-wiring** — automatic model selection per task type (Haiku for parsing, Opus for reasoning, Flash for bulk); infrastructure exists (we have primary/cheap/bulk slots + `cheapCall`); just needs wiring + per-task routing rules. ~150 LOC + config.

### Reference work to study before starting Nous

- **Letta** (formerly MemGPT) — closest production agent kernel. CoALA hierarchy, continuous micro-eviction, memory tools that self-edit. Letta Code hit #1 model-agnostic on Terminal-Bench Dec 2025. **Read their memory module first.**
- **oh-my-pi** — smallest production handle/artifact-spill example. Easiest reference impl to lift wholesale.
- **OpenAI Agents SDK** (April 2026) — explicit "harness separate from compute" architecture. Sandbox swappable (E2B, Cloudflare, Vercel). Read the architectural split, not specific code.
- **OpenFang** — most kernel-shaped of all in design. Verify production-grade vs. ambitious-vapor before betting on it.
- **Claude Code source** at `C:\Users\aayoa\Downloads\cc-src-2\out\src` — already mined for max_tokens table + cutoff recovery. More to steal: 5-layer compaction, `Task` subagents, tool-result disk spillover (`tengu` patterns).
- **pi-mono** (`packages/ai/src/models.generated.ts`) — confirmed our static-table approach over SDK runtime introspection.

### Decided NOT to do

- **TsRepl as second runtime** — codemode thesis violation; doubles harness maintenance forever; cognitive routing tax on the model. Aries already edits TS files via `fs.edit` + `codebase.search` and validates with `shell.run("npm run typecheck")`. Defer indefinitely; revisit only if metrics show ≥10 sessions where TsRepl would have saved >2 turns each.
- **Whole-substrate TS rewrite** — opportunity cost too high mid-thesis; throws away the empirical 2.14× on a counterfactual; loses Python training prior. Maximalist v2.0 story at best.
- **C from the friction inventory (fs.write plan-mode workspace boundary)** — research disproved the "circular" framing. Plan mode swaps tool set; uses top-level Write (no boundary check); Repl absent from active tools. Not a bug. Document the layering instead of fixing.

### Active friction inventory (next ship — Batch 1.9)

- **B — `codebase.map(path)`** — single primitive returning `[{path, type, depth}]` flat list, capped at depth 5 / 500 entries. Saves 4-5 round trips per exploration session. ~50 LOC. Plan in `notes/plan-batch-1.9-research.md`.
- **A — TS detector string-literal pre-pass** — pure-TS regex-based stripper that scrubs Python strings (`'...'`, `"..."`, `'''...'''`, `"""..."""`) and `#` comments before applying TS-shape regexes. Eliminates 3 confirmed false-positive classes (regular, triple-quoted, raw strings). ~70 LOC.
- **D — `vault.read(None)` guard** — already shipped this session.

### Open meta-question

After B + A ship, do we close out the harness polish arc (Batch 4 contracts, Batch 5 craft) before starting Nous, or jump to Nous-1 directly? Contracts/craft are high-value but harness-layer; Nous-1 is the unlock that changes session feel. Probable answer: ship B + A as Batch 1.9, then start Nous-1 immediately, let contracts/craft sit until Nous-1 lands and shows what primitive-shape changes the kernel actually wants.

### Memory notes added this period

- `project_aries_self_reflection_2026_04_25` — Aries-self's mid-session reflection on harness maturity + remaining friction. Captures the meta-insight that "the agent running on the harness now contributes R&D to its own environment" — treat such signals as first-class roadmap input.
