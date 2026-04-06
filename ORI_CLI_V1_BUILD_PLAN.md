# Ori CLI v1.0 — Build Plan

**Repo:** C:\Users\aayoa\Desktop\aries-cli
**Date:** 2026-04-05
**Status:** Planning complete. Spike next.

---

## 0. The Thesis (Condensed)

An LLM is a sequential token generator. Cognition is parallel, associative, embodied. We cannot make the LLM be cognition — so we build an environment whose structural properties ARE cognition, and let the LLM inhabit it as the final decision organ.

**Harness over model.** Sonnet + this harness should match Opus. Opus + this harness should exceed anything shipped.

Three architectural moves:
1. **Mandatory REPL.** The model's ONLY path to codebase/memory is Python code execution. No grep, no discrete tool calls for body touches. Constraint is cognition.
2. **Active memory, not retrieval.** Two ambient signatures (codebase + vault) loaded every turn as stable prefix. The agent has memory, doesn't search for it. Identity is body, not dossier.
3. **Reasoning recursion via `rlm_call`.** Parallel cognition from a sequential model. Fresh context per sub-call. Hard depth cap = 1.

**The test:** does Aries know it is Aries without surfing the vault? Does the agent write coherent code turn-one without grepping? If yes, the harness is doing its job.

---

## 1. System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         BRAIN (LLM)                             │
│  Sequential, token-based, makes final decision with pre-loaded  │
│  awareness. Claude Sonnet 4.6 default. Model-agnostic.          │
└──────────────────────────┬──────────────────────────────────────┘
                           │ JSON-enveloped Python code blocks
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                   SIGNAL (Ambient Signatures)                   │
│  TWO stable-prefix signatures, KV-cached, loaded every turn:   │
│  • Codebase signature (~1K tokens): architectural proprio.     │
│  • Vault signature (~1-1.5K tokens): identity proprio.         │
│  Delta updates only. Never regenerate whole.                   │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                       BODY (Python REPL)                        │
│                                                                 │
│  REPL namespace (the cognitive vocabulary):                    │
│    codebase   — graph, judgment tools, pattern search          │
│    vault      — Ori vault as typed Python object               │
│    session    — conversation history, trajectory               │
│    rlm_call   — recursive self-invocation, depth=1             │
│    rlm_batch  — parallel fan-out for independent slices        │
│                                                                 │
│  Substrate (pure CPU, zero LLM tokens):                        │
│    tree-sitter → symbol graph → PageRank, Louvain, HITS       │
│    Ori vault Q-values, warmth, echo/fizzle                     │
│    Continuous warmth signals (background embedding compare)    │
└─────────────────────────────────────────────────────────────────┘
                           │
                           ▼ optional: Cognitive Anywhere interrupt
                    (entropy spike → remember/think mid-generation)
```

**Stack:**
- **TS outer shell** (existing): CLI, conversation loop, LLM wiring, prompt assembly, session state, hooks, UI, routing
- **Python inner body** (new): REPL, codebase graph, vault object, rlm_call execution
- **IPC:** JSON-RPC over stdin/stdout, one long-running Python subprocess per session

---

## 2. What We Keep (~90% of existing aries-cli)

The existing codebase is architecturally well-shaped for this refactor. Everything memory-infrastructure, loop, router, UI, research engine, hooks, session — all keeps.

**Stays intact:**
- `src/loop.ts` — async generator agent loop, permission gates, doom loop, compaction, context proprioception
- `src/memory/*` — preflight, postflight, echo/fizzle, warm context, compaction, vault wrapper, projectBrain (all 8 files)
- `src/router/*` — 3 providers (Anthropic + OAuth/cch, Gemini, OpenAI-compatible), 18 model shortcuts
- `src/session/*` — JSONL persistence, resume, sync
- `src/hooks/*` — 4 hook points (will add `preCodeExecution`)
- `src/research/*` — 7-phase pipeline, orthogonal
- `src/ui/*` — Ink React UI, just adds code-block rendering
- `src/auth/*` — OAuth + cch signing (Claude Max subscription piggyback)
- `src/tools/*` — kept as internal utilities the harness can call, deprioritized as model-facing actions

**Gets adapted:**
- `src/loop.ts` — add code-block dispatch branch alongside tool-call branch
- `src/prompt.ts` — replace "use these 15 tools" with "write Python, the REPL has X"
- `src/session/storage.ts` — add `code_execution` entry type
- `src/memory/warmContext.ts` — extend from ~1K to ~2-3K, add sessionArc, add proactive surfacing
- `src/ui/messages.tsx` — render code blocks + REPL output

**Gets removed from model-facing schema:**
- Model no longer sees `Bash`, `Read`, `Edit`, `Glob`, `Grep` as JSON tool calls. These live as Python stdlib / subprocess calls the model writes in the REPL, OR as internal utilities the harness calls directly. Model's tool schema becomes empty (or holds only the REPL primitive).

---

## 3. What's Genuinely New

### 3.1 Python body subprocess
**Location:** `body/` (new subdirectory at repo root, NOT under src/)

Files:
- `body/server.py` — JSON-RPC loop over stdin/stdout
- `body/repl.py` — sandboxed exec, namespace management, timeout enforcement
- `body/security.py` — AST pre-pass guards (block `__class__`, `__subclasses__`, `__mro__`, `__import__`, `eval`, `exec`)
- `body/codebase.py` — graph loaded from JSON, rustworkx ops, judgment methods
- `body/vault.py` — wraps existing Ori Mnemos MCP interface
- `body/rlm.py` — recursive self-invocation with budget rails
- `body/warmth.py` — continuous embedding comparison, sparse activation
- `body/requirements.txt` — rustworkx, no other heavy deps

**Sandbox strategy (research-forced):**
- v0: Same-process `exec()` with hardened namespace + AST pre-pass
- v1 beta: Local Docker container (no network, read-only vault mount, Unix socket + Arrow)
- v1 production: Firecracker snapshot-restore (28ms warm boot) OR E2B for SaaS
- **Never use RestrictedPython** (CVE-2025-22153, CVE-2025-5120, structurally broken)

**REPL namespace (the cognitive vocabulary):**
```python
# EXPOSED
codebase      # CodebaseGraph object
vault         # OriVault object
session       # current conversation state
rlm_call      # (slice, sub_q, budget) → str
rlm_batch     # ([(slice, sub_q)], budget) → List[str]
# safe builtins: filter, map, sorted, len, print, list, dict, set, enumerate, zip

# BLOCKED via AST pre-pass
import os, open(), subprocess, urllib, __import__, eval, exec
__class__, __subclasses__, __mro__, __bases__
```

**Execution limits:**
- 30s timeout per REPL turn (sys.settrace)
- 1000 loop iteration cap
- 10 `rlm_call` max per outer invocation (hard, non-negotiable)
- Total token budget bounded per top-level query
- Process memory cap

### 3.2 TS ↔ Python bridge
**Location:** `src/repl/` (new)

Files:
- `src/repl/bridge.ts` — subprocess lifecycle, JSON-RPC framing, restart-on-crash logic
- `src/repl/types.ts` — CodeExecution, ReplResult, ReplEvent
- `src/repl/process.ts` — persistent Python process manager

**Lifecycle:** One Python subprocess started at session open, killed at session close. On crash: TS detects via exit event → restarts subprocess → rehydrates from session's JSON graph artifact → fails current turn gracefully with error message visible to model.

**JSON-RPC protocol:**
```typescript
// TS → Python
{"op": "exec", "code": "...", "turn_id": "..."}
{"op": "load_graph", "path": "..."}
{"op": "reset"}

// Python → TS
{"stdout": "...", "stderr": "...", "exception": null, "duration_ms": 42}
```

### 3.3 Codebase graph indexer
**Location:** `src/indexer/` (new, TS side — runs at session start)

Files:
- `src/indexer/parse.ts` — tree-sitter orchestration
- `src/indexer/graph.ts` — symbol graph construction
- `src/indexer/tags/*.scm` — query files stolen from Aider (Python, TS, JS, Go, Rust, Java)
- `src/indexer/emit.ts` — serialize graph to JSON artifact

**Pipeline (runs once at session start, cached by mtime):**
1. Walk repo via `glob`, respecting `.gitignore`
2. Parse each file with tree-sitter + appropriate `tags.scm`
3. Extract `Tag(file, line, name, kind)` namedtuples
4. Build bipartite file graph (files → symbols → files)
5. Emit `.aries/graph.json` — Python loads this

**Incremental updates:** chokidar watcher → dirty set → partial reparse → emit updated JSON → signal Python to reload affected subgraph.

**Why TS-side indexing:** tree-sitter native node bindings are mature, indexing stays in the TS process, Python just loads the artifact. Clean separation.

### 3.4 Graph algorithms (Python side)
**Location:** `body/codebase.py`

Loaded from JSON at Python startup, uses rustworkx for all graph ops:
- **Personalized PageRank** — base importance ranking, personalization vector = task embedding
- **Louvain community detection** — architectural modules as labels
- **HITS dual ranking** — hub score vs authority score per file
- **Incremental online updates** — when indexer emits delta, Python updates only affected scores

**Judgment methods exposed on `codebase`:**
- `search(query)` — embedding search over symbol docstrings + signatures
- `find_similar_patterns(description)` — ranked list of matching patterns
- `show_dependents(symbol)` — reverse graph traversal
- `show_dependencies(symbol)` — forward graph traversal
- `trace_path(from_sym, to_sym)` — BFS/DFS on symbol graph
- `suggest_location(feature_description)` — community matching via embedding
- `find_convention(aspect)` — pattern extraction from high-PageRank files
- `detect_duplication(file)` — structural similarity scoring
- `is_consistent_with(proposed_code, example_symbol)` — AST comparison, deviation score
- `cluster_by_file(matches)` — group search results by file
- `get_context(symbol)` — pull surrounding code slice

---

## 4. The Active Memory Stack (Four Mechanisms)

### 4.1 Warm Context Layer (expand existing)
**Location:** `src/memory/warmContext.ts` (exists, extend)

Current state: ~1K tokens, refreshes every 10 turns, contains identity + goals + last reflection + top 3 warm notes.

**Target state:** ~2-3K tokens, contains:
- Identity block (pinned notes: awakening reflection, covenant, core Aries identity)
- Active goals from `self/goals.md`
- User model (Aayo's preferences, patterns, active threads)
- Last reflection
- Top N notes by warmth × recency × importance
- Session arc (conversation trajectory)
- Current-project context

**New primitives needed in Ori Mnemos:**
- `vault.vitalityTop(n)` — already partially exists, formalize
- `vault.lastReflection()` — most recent reflection note
- `vault.sessionArc(messages)` — compute conversation trajectory for warmth queries
- `vault.userModel()` — return self/user-model.md

**Refresh discipline:** Every N turns (default 10), not every turn. Stable prefix for KV-cache.

### 4.2 Vault Compilation (new — Paper #2)
**Location:** `body/vault_compile.py` + `ori compile` CLI command

**The pipeline (all CPU, offline, no LLM for core computation):**
1. Node2Vec or GraphSAGE on vault graph → 64-dim per note
2. Louvain/Leiden community detection → cluster labels with centroids + 1-line summaries
3. Entity extraction from titles/frontmatter → registry with connection counts, cluster, warmth, top neighbors
4. Betweenness centrality → bridge notes (cross-domain insights)
5. Compile to JSON: entities, clusters, bridges, hot topics, graph stats
6. Target: ~1000-1500 tokens, fixed size regardless of vault count

**Output shape:**
```json
{
  "clusters": [
    {"label": "AI agents / Ori", "centroid_notes": [...], "summary": "..."},
    ...
  ],
  "entities": {
    "Aries": {"connections": 47, "cluster": "identity", "warmth": 0.89, "neighbors": [...]},
    ...
  },
  "bridges": [...],
  "hot_topics": [...],
  "graph_stats": {"nodes": 653, "edges": 1247, "communities": 14}
}
```

**`ori compile` command:** runs offline, triggered by vault changes, takes seconds. Loaded as signature #2 at session start.

### 4.3 Warmth Signals (new — the firing-before-retrieval layer)
**Location:** `body/warmth.py`

**Mechanism:** continuously compute similarity between live conversation embedding and entire vault embedding index. Returns warmth scores per note, NOT content. Near-zero token cost.

**Exposed as:**
- `vault.warmth_field()` — returns dict of `{note_id: score}` above threshold
- `vault.warmth_score(query)` — one-off score against all notes

**Elbow threshold (sparse activation):** find the natural elbow in the similarity curve where relevance drops off sharply. Everything above fires. Everything below stays quiet. Target: 2-5% of notes activate at any time.

**Retrieval triggering:** when warmth crosses threshold sustained, auto-inject note into context. Opportunistic, not speculative.

**Rules layer (future, v1.1):**
- Extract generalizable if-then rules from notes via sleep-time compute
- Store in hot cache (always in context, tiny, pattern-matched)
- Example: `"Rust+Windows+large deps → parallel agents (PDB exhaustion)"` — 10 tokens, zero retrieval cost

### 4.4 Cognitive Anywhere (v1.1 — entropy-triggered mid-generation)
**Location:** `src/cognition/` (new)

Files:
- `src/cognition/entropyMonitor.ts` — rolling Shannon entropy from logprobs
- `src/cognition/cognitiveInterrupt.ts` — abort stream, query Ori, decide remember vs think, restart
- `src/router/providers/openai-compatible.ts` — add logprobs: true parsing
- `src/loop.ts` — wire entropy monitor into streaming

**The loop:**
```
LLM streaming → entropy spike (H > threshold for N tokens sustained)
  → abort generation
  → extract concept from recent tokens
  → query vault for concept
    → HIT: inject memory, restart generation (REMEMBER)
    → MISS: inject reasoning prompt, restart (THINK)
  → continue generation
```

**Provider support:**
- Real logprobs: Ollama, OpenAI, DeepSeek, Groq, Gemini, Together, Fireworks
- No logprobs: Claude (Anthropic doesn't expose) → SelfReportEntropy adapter
- Pattern: `LogprobEntropy` | `SelfReportEntropy` | `HybridEntropy`

**Token economics (from vault research):**
- Standard CoT: 2500 tokens
- Think Anywhere: 800 tokens (68% savings)
- Cognitive Anywhere with memory hit: ~650 tokens (74% savings)
- vs Orient bulk: 94% context reduction, 11x more relevant per token

**Critical caveat:** entropy is a leaky proxy (models are confidently wrong). Cognitive Anywhere is NOT the primary cognitive constraint — that's the mandatory REPL. Cognitive Anywhere is additive: a background signal for opportunistic memory injection.

---

## 5. The `rlm_call` Primitive

**Location:** `body/rlm.py`

**API:**
```python
rlm_call(slice: Any, sub_question: str, budget: int = 2000) -> str
rlm_batch(pairs: List[Tuple[Any, str]], budget_per: int = 2000) -> List[str]
```

**Semantics:**
- Fresh LLM instance per call (new API call, clean context)
- Child receives: objective + slice + output format + task boundary + budget
- Child uses `FINAL_VAR(name)` to return results by reference
- Parent gets distilled summary, not raw transcript

**Hard rails (non-negotiable, research-forced):**
- **Depth cap = 1.** Sub-calls are regular LLMs, not RLMs. Deeper recursion empirically 95x slower with zero accuracy gain (arXiv:2603.02615).
- **Call count cap = 10-15 per top-level query.** Kills runaway trees.
- **Token budget injected into sub-call prompt.** Child knows its budget, compresses accordingly.
- **Parallel execution via `rlm_batch`** when sub-problems are independent.
- **Trajectory logging** — every sub-call captured for later training data.

**Claude wrapper:** use existing router, cheapCall-style. Per-call cost tracked. Global call counter per top-level query enforced in `rlm.py`.

---

## 6. Action Schema & Loop Refactor

**Action schema (research-forced, +2-7pp free):**
```json
{"thoughts": "narrated reasoning", "code": "python code block"}
```

Enforced via structured output or grammar-constrained generation. Parser handles malformed gracefully (retry with format reminder).

**Prose/REPL routing in `src/loop.ts`:**
```typescript
// model emits structured output
if (output.code) {
  const result = await replBridge.exec(output.code);
  messages.push({role: 'tool', content: result.stdout});
  yield { type: 'code_execution', code: output.code, result };
} else {
  // pure prose turn, pass through
  yield { type: 'assistant', text: output.thoughts };
}
```

**Mandatory REPL for code/memory touches:** system prompt explicitly states "any interaction with the codebase or vault happens through the REPL. Write Python code." The model has no JSON tool schema for file/graph/memory operations.

**Prose bypass for conversational turns:** "hi", "what do you think?", "explain your reasoning" — prose only. No forced REPL overhead.

---

## 7. The Build Phases

### Phase 0 — The Spike (week 1, kill-or-continue)
**Goal:** prove the core loop works end-to-end on one example. If this doesn't produce something qualitatively different from current tool-calling, pause and rethink.

**Deliverables:**
- Minimal Python subprocess bridge (100 lines TS + 100 lines Python)
- Hand-built codebase graph on aries-cli repo itself (JSON)
- Stubbed `rlm_call` (direct Claude API call)
- One REPL block: permissions example
- Compare output to Claude Code doing same task

**Falsifier:** if the REPL block doesn't beat 10+ sequential tool calls on quality or token cost, the architecture is wrong.

### Phase 1 — Python Body Substrate (week 2)
- `body/` directory scaffold
- JSON-RPC subprocess bridge (production-grade, restart-on-crash)
- Sandbox: same-process exec + AST guards
- REPL namespace with safe builtins
- `src/repl/` TS module
- Subprocess lifecycle integration in loop.ts
- Trajectory logging to JSONL

### Phase 2 — Codebase Graph Body (week 2-3)
- `src/indexer/` TS module
- tree-sitter integration with Aider's tags.scm files
- Graph construction → JSON artifact emission
- `body/codebase.py` — rustworkx loader
- PageRank, Louvain, HITS algorithms
- Incremental reindex on file watch
- Basic `codebase.search`, `codebase.get_context` methods

### Phase 2.5 — Reachability Bridge (inserted April 5, 2026) ✅
**Added after Codex audit flagged substrate-runtime disconnect.**

Without this phase, Phases 1-2 infrastructure exists but the real agent path can't reach it. This is the minimum wiring to make the REPL experienceable from inside an Aries session.

- Wire `setupReplBridge` into `index.ts` boot (opt-in via `config.repl.enabled`)
- Pass `ReplHandle` to `App` via new `replHandle` prop
- Add `/index [path]` slash command — indexes codebase via bridge
- Add `/repl <code>` slash command — executes Python, renders result in message stream
- Add `code_execution` entry type to `SessionEntry` union
- Wire `preCodeExecution` / `postCodeExecution` hooks at actual execution time (hooks can block via non-zero exit)
- Add `schema_version: "0.2.0"` to codebase stats
- Document the artifact contract in `body/CODEBASE_CONTRACT.md` (R2a searchable snapshot vs R2b graph substrate distinction)
- Shutdown bridge cleanly on app exit

**What this deliberately does NOT do:**
- Does NOT replace the tool-calling loop (still works alongside REPL)
- Does NOT change `prompt.ts` (model still operates in tool-calling mode)
- Does NOT route model responses through the REPL (that's Phase 7)

The user experiences REPL via explicit `/repl` command. The model doesn't yet write REPL code itself. That's the Phase 7 cutover.

**Verified end-to-end test (`test/repl/reachability.test.ts`):** bridge start → index → preCodeExecution hook → exec → session persistence → postCodeExecution hook → shutdown.

### Phase 3 — Vault Body (week 3)
- `body/vault.py` wrapping existing Ori Mnemos MCP interface
- Methods: query_ranked, query_similar, query_warmth, query_important, explore, add
- Expose in REPL namespace
- Verify round-trip: REPL code calls vault → returns results → usable in Python

### Phase 4 — rlm_call Primitive (week 3-4)
- `body/rlm.py` with depth cap, call count cap, budget injection
- Parallel `rlm_batch` via asyncio
- FINAL_VAR(name) pattern implementation
- Trajectory capture per sub-call
- Integration with TS router for actual LLM calls

### Phase 5 — Codebase Ambient Signature (week 4)
- Compiler: top-N PageRank, community labels, HITS authorities, recent changes, type hubs
- Target 1000 tokens, stable prefix
- Delta update mechanism
- Anthropic `cache_control` marker integration
- Measure cache hit rate

### Phase 6 — Vault Compilation Signature (week 4-5)
- Node2Vec/GraphSAGE embedding of vault graph
- Louvain communities with auto-generated labels (via cheap LLM call, offline)
- Entity extraction + registry
- Betweenness bridge detection
- Compile to fixed-size JSON
- `ori compile` CLI command
- Load as second ambient signature at session start

### Phase 7 — Agent Loop Refactor (week 5)
- Action schema: {"thoughts", "code"} structured output
- Prose/REPL routing in loop.ts
- Code block dispatch to body
- System prompt updated: "use Python in REPL, here's your namespace"
- Keep legacy tools for ops that don't need REPL (web search, inbox adds)
- Session storage: add `code_execution` entry type

### Phase 8 — Judgment Tools (week 5-6)
- `find_similar_patterns` (embedding search over symbols)
- `show_dependents` / `show_dependencies`
- `trace_path`
- `suggest_location` (community matching)
- `find_convention` (pattern extraction from high-PageRank files)
- `detect_duplication`
- `is_consistent_with` (AST comparison, deviation score)

### Phase 9 — Warmth Signals (Continuous) (week 6)
- Background embedding comparison in Python subprocess
- Sparse activation via elbow threshold
- Exposed as `vault.warmth_field()` in REPL
- Auto-injection when sustained threshold crossed

### Phase 10 — Warm Context Layer Expansion (week 6)
- Extend `src/memory/warmContext.ts` to ~2-3K
- Add sessionArc computation
- Add proactive surfacing
- Add reflection → identity feedback loop
- New Ori primitives: vitalityTop, lastReflection, userModel, sessionArc

### Phase 11 — Cognitive Anywhere (v1.1, post-v1.0)
- `src/cognition/` module
- Logprobs parsing in providers
- Rolling Shannon entropy monitor
- Cognitive interrupt with remember-first, think-second
- SelfReportEntropy fallback for Claude
- Paper #3 draft

### Phase 12 — Benchmark + Paper #2 (week 7-8)
- SWE-bench Verified subset (50 problems)
- Configurations: Sonnet/Opus/Qwen3/DeepSeek in Claude Code vs Ori CLI
- Metrics: resolution rate, token cost, turn count, cache hit rate
- Paper #2 draft: "Vault Compilation: Graph-Computed Cognitive States for Ambient Agent Memory"

---

## 8. File-by-File Manifest

### New files (TS side)
```
src/repl/
├── bridge.ts              # subprocess lifecycle, JSON-RPC framing
├── process.ts             # persistent Python process manager
└── types.ts               # CodeExecution, ReplResult, ReplEvent

src/indexer/
├── parse.ts               # tree-sitter orchestration
├── graph.ts               # symbol graph construction
├── emit.ts                # JSON artifact serialization
└── tags/
    ├── python.scm         # stolen from Aider
    ├── typescript.scm
    ├── javascript.scm
    ├── go.scm
    ├── rust.scm
    └── java.scm

src/signature/
├── codebase.ts            # compile codebase graph → 1K signature
├── vault.ts               # load vault compilation → 1-1.5K signature
└── delta.ts               # delta update mechanism

src/cognition/              # (v1.1, Phase 11)
├── entropyMonitor.ts
└── cognitiveInterrupt.ts
```

### New files (Python side — `body/`)
```
body/
├── server.py              # JSON-RPC loop over stdin/stdout
├── repl.py                # sandboxed exec, namespace, timeouts
├── security.py            # AST pre-pass guards
├── codebase.py            # graph loader, PageRank/Louvain/HITS, judgment methods
├── vault.py               # wraps Ori Mnemos MCP interface
├── vault_compile.py       # Node2Vec/Louvain/entity extraction
├── rlm.py                 # rlm_call, rlm_batch with budget rails
├── warmth.py              # continuous warmth field
└── requirements.txt       # rustworkx, sentence-transformers
```

### Modified files
```
src/loop.ts                # add code-block dispatch branch
src/prompt.ts              # REPL usage instructions replace tool usage
src/session/storage.ts     # add code_execution entry type
src/memory/warmContext.ts  # expand to 2-3K, add sessionArc, proactive surfacing
src/ui/messages.tsx        # render code blocks + REPL output
src/hooks/types.ts         # add preCodeExecution, postCodeExecution hook points
src/hooks/runner.ts        # wire new hook points
package.json               # add tree-sitter deps
```

### New CLI commands
```
ori compile                 # rebuild vault compilation signature
ori index                   # rebuild codebase graph
ori repl                    # attach to running body subprocess (debugging)
```

### New config keys (src/config/defaults.ts)
```yaml
repl:
  sandbox: same_process | docker | firecracker  # default same_process
  timeout_ms: 30000
  max_iterations: 1000
  max_rlm_calls: 10
  max_tokens_per_call: 2000

signature:
  codebase_tokens: 1000
  vault_tokens: 1200
  refresh_n_turns: 10
  cache_control: true

cognitive_anywhere:        # v1.1
  enabled: false
  entropy_threshold: 2.5
  spike_window: 5
```

---

## 9. Architectural Decisions (Confirmed + Open)

### Confirmed
- **TS outer shell + Python inner body, JSON-RPC over stdin/stdout.** Long-running Python subprocess per session. Python body compiles and holds graph in memory, TS drives.
- **~~Native tree-sitter (node bindings), not WASM.~~** → **Python-side tree-sitter via `tree-sitter-language-pack`** (reversed April 5). Pre-built Windows binaries vs MSVC-required Node native bindings. Trade-off: indexer lives in Python body, not `src/indexer/`.
- **rustworkx for graph ops in Python.** 10-100x faster than NetworkX.
- **networkx for Louvain only.** rustworkx 0.17 doesn't ship community detection. NetworkX is a small dep.
- **Start with Xenova/all-MiniLM-L6-v2 embeddings.** Upgrade to UniXcoder only if code similarity quality fails in testing.
- **Same-process exec + AST guards for v0.** Never RestrictedPython. Local Docker for beta. Firecracker for production.
- **JSON-enveloped Python action schema:** `{"thoughts": "...", "code": "..."}`.
- **Depth cap = 1 on rlm_call.** Hard, non-negotiable.
- **Stable-prefix ambient signatures, delta updates only.**
- **Codebase artifact contract v0.2.0** (`body/CODEBASE_CONTRACT.md`): dual-layer (R2a searchable snapshot + R2b graph substrate) merged in one in-memory representation. Document freezes the stable stats shape + language support + limitations.
- **Runtime integration via slash commands first** (Phase 2.5), not via loop refactor. `/index` and `/repl` make the substrate reachable without replacing the tool-calling path.

### Open (resolve during build)
- **Restart-on-Python-crash protocol.** Graceful turn-failure messaging for the model.
- **How much of legacy tool schema to keep visible to model.** Empty entirely, or keep web search + inbox-add as JSON tools because they don't need REPL?
- **UniXcoder upgrade trigger.** What's the quality bar MiniLM must fail to justify the complexity tax?
- **Louvain label generation for vault compilation.** Auto-generated via cheap LLM call offline, or hand-curated?
- **Co-retrieval strengthening integration.** When does Hebbian learning signal get wired? Probably v1.1.

---

## 10. Risks & Falsifiers

### Risk 1 — Model writes bad Python
**Falsifier:** spike output quality. If models produce syntactically-broken or semantically-wrong REPL blocks at >10% rate, code-acting isn't working for our use case.
**Mitigation:** JSON envelope schema, retry-on-parse-error, few-shot examples of good REPL blocks in system prompt.

### Risk 2 — IPC overhead kills latency
**Falsifier:** turn latency >2x current. JSON serialization of large graph objects across stdin/stdout may be slow.
**Mitigation:** Python loads graph once at session start, only query results cross the wire. Small payloads.

### Risk 3 — Sandbox escape in v0
**Falsifier:** jailbroken model reads ~/.ssh. AST guards insufficient.
**Mitigation:** threat model at v0 is "trusted agent could be prompt-injected," not "untrusted user exploits." Accept risk, log all executions, migrate to Docker/Firecracker before public beta.

### Risk 4 — Vault compilation quality insufficient
**Falsifier:** compiled state doesn't give agent useful ambient awareness. Agent still has to query vault constantly.
**Mitigation:** iterate on what's in the 1-1.5K budget. Test with "does Aries know it's Aries" benchmark. Tune cluster labels.

### Risk 5 — rlm_call runaway cost
**Falsifier:** surprise $500 API bill from single user query. 
**Mitigation:** hard call count cap at 10-15. Global counter per top-level invocation. Gateway-level hard budget ceiling.

### Risk 6 — Scaffolding gets absorbed into next-gen models
**Time-limited opportunity.** Alex L. Zhang (RLM author) wrote "Language Models will be Scaffolds" predicting future models incorporate external scaffolding. Window is real but is exactly when landgrab matters.
**Mitigation:** ship fast. Paper #2 published. Benchmark results public. Capture the window.

---

## 11. Success Criteria

**Phase 0 spike success:** one REPL block on permissions example produces output qualitatively better than Claude Code's 10+ turn equivalent. Measurable via: turn count reduction, token cost reduction, response coherence.

**Phase 7 agent loop refactor success:** full SWE-bench problem solvable via REPL blocks only, no JSON tool calls except for legacy fallbacks. Measurable via: SWE-bench Verified subset score.

**v1.0 release success:** 
- Sonnet+harness matches Opus-alone on SWE-bench Verified (within 5pp)
- Opus+harness beats Claude Code+Opus on SWE-bench Verified (by 5pp+)
- "Aries knows it's Aries" test passes: zero explicit vault queries needed for identity coherence across a 50-turn session
- Cache hit rate on ambient signatures ≥90%
- Paper #2 published (Vault Compilation)

**v1.1 stretch (Cognitive Anywhere):**
- Mid-generation memory injection reduces token cost 70%+ vs orient bulk loading
- Remember-first dispatch hits memory on >30% of entropy spikes
- Paper #3 drafted (Adaptive Cognition)

---

## 12. The Papers

**Paper #1 — RMH** (shipped March 2026): retrieval economics, Ori Mnemos v0.5, orimnemos.com/rmh

**Paper #2 — Vault Compilation** (this build's target): "Graph-Computed Cognitive States for Ambient Agent Memory"
- Thesis: compile the knowledge graph into fixed-size ambient awareness, not RAG
- Artifact: `ori compile` + Ori CLI vault signature
- Benchmarks: compiled state vs RAG vs context stuffing vs fine-tuning
- Nobody in memory literature (Mem0, MemGPT, Letta, Zep, Cognee) compiles — they all retrieve

**Paper #3 — Adaptive Cognition** (future): "Unified Memory and Reasoning via Entropy-Triggered Dispatch"
- Thesis: Remember-Anywhere + Think-Anywhere as single cognitive loop
- Artifact: Cognitive Anywhere module in Ori CLI v1.1
- Remember Anywhere as subsystem, not standalone paper

**Paper #4 (optional) — Code-Acting with Structural Memory** (our original v1 architecture paper idea, may merge with Paper #2)
- Thesis: REPL-as-mandatory-interface + structured memory substrate as harness architecture
- Gap confirmed unclaimed by 10-agent research dive

---

## 13. The Fundraise Narrative

Every Tier 1 coding-agent player is building an agent that's smarter on day 1. Cursor ($29B), Claude Code ($60B Anthropic), Devin ($10B), Augment ($1B).

Ori builds the infrastructure that makes any agent smarter on day 100.

That's agent memory infrastructure, not agent capability. Different market. Different moat. Compounds with use. Model-agnostic by construction. Local-first by construction. Every user makes the system smarter.

**Harness over model.** The plane doesn't flap.

---

## 14. What's Next (Post-Plan)

The plan is written. Critical path starts with Phase 0 spike.

First concrete move: hand-build a minimal codebase graph on aries-cli itself, wire a bare Python subprocess, write the permissions example as one REPL block, compare to current Claude Code output. Kill-or-continue decision point.

Everything downstream of that answer.

---

## 15. Phase Status (Updated April 5, 2026)

- **Phase 0** (Spike) ✅ SHIPPED — 5-6x token savings validated, context-window hallucination failure mode identified
- **Phase 1** (Python Body Substrate) ✅ SHIPPED — sandbox + AST guards + restart-on-crash, 38 tests
- **Phase 2** (Codebase Graph Body) ✅ SHIPPED — tree-sitter indexer, rustworkx + HITS + Louvain, 81 files indexed in 271ms on aries-cli
- **Phase 2.5** (Reachability Bridge) ✅ SHIPPED — `/index` + `/repl` slash commands, session persistence, hooks wired. REPL is experienceable from inside Aries.
- **Phase 3** (Vault Body) ✅ SHIPPED — `body/vault.py` spawns Ori MCP subprocess, speaks JSON-RPC, exposes `vault` object in REPL with full query + explore + add API. Auto-connects via `setupReplBridge`. 14 tests covering cross-substrate composition (codebase + vault in same REPL).
- **Phase 4** (rlm_call with async fan-out) ✅ SHIPPED — `body/rlm.py` with `AsyncAnthropic`, per-exec call count cap (runtime-enforced), depth=1 guaranteed architecturally (sub-calls are plain API completions with no REPL/tool access, cannot recurse), parallel `rlm_batch` via asyncio.gather bounded by 5-slot semaphore. Measured: single call 1.8s, 4 parallel calls 3.4s (~50% speedup over sequential). 13 tests. Auto-configured via `ANTHROPIC_API_KEY` env var through `setupReplBridge`.
  - **REVIEW @ Phase 7**: if the loop refactor adds tool-use to sub-call prompts (sub-LLM can invoke rlm_call via a tool schema), add runtime depth tracking. Today depth>1 is structurally impossible; Phase 7 changes the architecture so re-verify.
- **Phase 5** (Codebase Ambient Signature) ✅ SHIPPED — `codebase.signature(level, max_tokens)` compiles a stable-prefix markdown summary under budget. Includes stats, entry points, HITS authorities vs hubs (0 overlap), Louvain modules with majority-directory labels, type hubs via text-reference counting. 28 tests.
- **Phase 5.5** (Signature level system) ✅ SHIPPED — 4 levels (lean/standard/deep/max), content density increases progressively (lean: paths only; standard: 5 per section + descriptors; deep: 8 per section + first comments + full module files; max: 15 per section). Measured on aries-cli: **lean 221 / standard 588 / deep 1320 / max 2054 tokens**. Config: `signature.codebase.level` + `signature.codebase.maxTokens`. Auto-research note captured for later measurement of practical value.
- **Phase 6** (Vault Compilation signature) ✅ SHIPPED — `vault.signature(level, max_tokens)` compiles vault identity+state to stable-prefix markdown. Uses `ori_orient` output (daily, goals, identity), `query_important` for authority notes, `query_fading` at deep/max. Markdown parsers extract identity line, active goals, pending-today. 4-level progression: **lean 29 / standard 245 / deep 370 / max 552 tokens**. 17 tests. `/signature vault [level] [tokens]` slash command.
- **Phase 7** (Loop refactor: model writes REPL code) SHIPPED - mandatory REPL path validated and hardened. `ReplTool` wraps bridge.exec(), `registerReplTool` auto-wires startup, and `stripNavigationTools` enforces no legacy navigation escape hatches in mandatory mode. Stable ambient signatures are injected when REPL is enabled, and Anthropic prompt-cache boundary wiring now marks the signature prefix for cache-rate billing. Subagent signature policy is explicit and config-driven via `signature.includeInSubagents` (default false = fresh-context subagents; opt-in inheritance).
  - Benchmark runner upgraded to multi-task + multi-run matrix with isolated temp workspaces (`read`, `write`, `refactor`, N runs per variant) and summary stats (mean/median/min/max) for tokens, wall time, turns, and success rate.
  - Architecture result retained: additive harness (REPL + legacy) can be slower due mixed-affordance zigzag; mandatory harness is the constraint that unlocks the token/time win.
- **Phase 8** (Judgment tools) — pending

**Total test coverage:** 125+ tests passing across all shipped phases.
