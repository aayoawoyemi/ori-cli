# Composition Research — Pass 3 Raw Ingest

**Date:** 2026-04-21
**Purpose:** Raw ingest of primary material for later synthesis. No attempt to resolve contradictions or refactor prior conclusions. Every citation marked verified/unverified.

---

## Thread 1 — RLM mechanics at code resolution

### 1.1 micro-rlm (Sha01in/micro-rlm) — Algorithm 1 verbatim structure

**Top-level loop:**

```python
for step in range(max_iters):
    response = llm(hist)  # LLM generates code
    hist.append({"role": "assistant", "content": response})

    # Extract and execute code blocks
    code_blocks = re.findall(fence + r"(?:python|repl)?\n(.*?)" + fence, response, re.DOTALL)
    if code_blocks:
        stdout = repl.execute("\n".join(code_blocks))
        stdout_trunc = stdout[:max_meta_chars] + ("...[truncated]" if len(stdout) > max_meta_chars else "")
        hist.append({"role": "user", "content": f"Output:\n{stdout_trunc}"})

    # Check termination conditions
    if match := re.search(r"FINAL_VAR\((.+?)\)", response):
        ans = repl.namespace.get(match.group(1), "[Variable Not Found]")
        break
    if match := re.search(r"FINAL\((.*?)\)", response, re.S):
        ans = match.group(1).strip()
        break
```

**Recursive sub-call — `llm_query` injected into namespace:**

```python
def sub_call(p):
    print(f"    [sub-call] querying {model_sub} with {len(p)} chars...")
    return llm([{"role": "user", "content": p}], model_sub)

self.namespace["llm_query"] = sub_call
```

- Signature: `llm_query(prompt: str) -> str` — plain text in, plain text out
- **Recursion depth bound: 1.** Only the root LLM writes code. Sub-calls return text, cannot generate new Python.
- **Termination:** explicit commitment primitives `FINAL(answer)` or `FINAL_VAR(name)`. Model writes one of these to exit. This is a *commitment primitive*, not a synthesis gate.

**System prompt to the root RLM:**

> "You are a Recursive Language Model. A vast text corpus is stored in your Python environment as `context` ({len} chars). You do NOT have direct access to it in your prompt. You must write Python code in fenced code blocks to peek at, chunk, and process `context`. You have a function `llm_query(prompt)` to query a sub-LLM for semantic evaluations over chunks. IMPORTANT: You will only see the first {max_meta_chars} characters of stdout. Store large results in variables!"

**Example user prompt:**
> "Query: Find the exact sum of all 'Cost's in the documents that describe a critical system failure. Because the dataset is too long, chunk it and use llm_query to safely extract and sum the values."

### 1.2 alexzhang13/rlm — plug-and-play library

**API:**
```python
from rlm import RLM
rlm = RLM(backend="openai", backend_kwargs={"model_name": "gpt-5-nano"}, verbose=True)
print(rlm.completion("Your prompt here").response)
```

**Supported sandboxes:**
- Non-isolated: `local` (Python exec on host)
- Isolated: `docker`, `modal`, `prime`, `daytona`, `e2b`

### 1.3 RLM paper (arxiv 2512.24601 — VERIFIED)

- Treats prompt as an environment variable, not as a neural net input
- Model writes Python to examine/decompose/recursively invoke itself
- `llm_query()` function enables sub-LM calls within the REPL environment
- **Substrate-only (no training) numbers:** RLM(GPT-5) on OOLONG 56.5% vs base 44%; on OOLONG-Pairs 58% vs base 0.04%
- Persists at 10M+ token scales where base fails
- "Explicitly training models to be used as RLMs...could provide additional performance improvements" → **future work, not in v1**
- Max recursion depth = 1 (sub-calls are LMs that don't call further)
- No explicit budget mechanism. Authors acknowledge high-variance cost, note async sub-calls could reduce runtime
- Four tasks: S-NIAH, BrowseComp-Plus, OOLONG, OOLONG-Pairs
- CodeAct without offloaded context "struggles on long-context tasks"
- Summary-agent baseline achieves comparable cost but inferior performance

### 1.4 RLM vs Ori's Repl — structural differences

| | RLM (paper / micro-rlm) | Ori Repl |
|---|---|---|
| Substrate | Python REPL, state persists | Python REPL, state persists ✓ |
| Prompt-as-variable | `context` variable | prompt is actual prompt; memory pulled on demand |
| Recursive sub-call | `llm_query()` in namespace | `rlm_call()` and `rlm_batch()` in namespace (already exists) |
| Termination | `FINAL(...)` or `FINAL_VAR(...)` explicit | Implicit (text-only response ends turn) |
| Recursion depth | 1 | Not bounded in user's harness (unknown — need to check) |
| Import policy | Open Python | No imports; namespace pre-loaded |
| Escape hatches | None visible | `fs`, `shell`, `web`, `codebase`, `vault`, `research`, `say`, `ask` bound |

**Key divergence:** RLM's `FINAL(...)` is a *commitment primitive*. Ori currently ends turns by having the model emit text-only (no tool call). Making commitment explicit (`final(answer)` or `done(result)`) would be a small, low-risk test — does Qwen terminate better when given a syntactic commit signal?

---

## Thread 2 — GEPA and self-evolution in concrete form

### 2.1 GEPA paper (arxiv 2507.19457 — VERIFIED)

- Tested on six tasks: **HotpotQA, IFBench, AIME 2025, LiveBench, NPUEval, KernelBench**
- HotpotQA and NPUEval/KernelBench are tool-using / code generation; others are text
- Beats GRPO by 6% average, up to 20% max
- Uses **35× fewer rollouts** than RL
- Beats MIPROv2 by 10%+
- Observes full trajectories (reasoning, tool calls, tool outputs)
- Reflects in natural language to diagnose problems, propose prompt updates, combines lessons from Pareto frontier of its own attempts
- Dual applicability noted: "promising results as an inference-time search strategy for code optimization"
- PDF fetch didn't extract algorithm details — need full HTML read later

### 2.2 gepa-ai/gepa — `optimize_anything` API (Feb 2026)

- Declarative API that extends GEPA beyond prompts
- Scope: "code, prompts, agent architectures, vector graphics, configurations"
- Open source

### 2.3 NousResearch/hermes-agent-self-evolution

**Evolution loop:**
- **Trigger:** Read current skill/prompt/tool files
- **Eval signal:** Generate evaluation dataset + collect execution traces
- **Mutation target:** Skills (SKILL.md files), tool descriptions, system prompts
- **Acceptance gates:**
  - Must pass full test suite
  - ≤15KB skill size limit
  - Caching compatibility preserved
  - Semantic purpose preserved
  - Human PR review required
- **Cost:** $2–10 per optimization run (API costs)
- **Cadence:** No trigger documented (on-demand, no cron)
- **Status:** Prototype; phases 2–5 planned
- **Reported numbers:** None. Positions as framework only.

---

## Thread 3 — Ori's own code grounding

### 3.1 `src/loop.ts` findings

**Loop structure:** while(turnCount < maxTurns) with maxTurns=50 default, 20 in explore tests.

**Existing gate mechanisms (already shipped):**

1. **Doom loop detection** (`src/tools/execution.ts:25-44`):
   ```typescript
   const DOOM_LOOP_THRESHOLD = 3;
   function checkDoomLoop(tc: ToolCall): boolean {
     const sig: CallSignature = { name: tc.name, inputHash: hashInput(tc.input) };
     recentCalls.push(sig);
     if (recentCalls.length > DOOM_LOOP_THRESHOLD) recentCalls.shift();
     if (recentCalls.length < DOOM_LOOP_THRESHOLD) return false;
     const first = recentCalls[0];
     return recentCalls.every(c => c.name === first.name && c.inputHash === first.inputHash);
   }
   ```
   - **Signature:** tool name + FULL JSON input hash (exact match, not shape)
   - **Threshold:** 3 identical calls
   - **Action:** hard error — "Doom loop detected: X called 3 times with identical input. Stopping to prevent infinite loop. Try a different approach."
   - **Attribution:** "Adopted from OpenCode/KiloCode"
   - Reset on new user input via `resetDoomLoop()`

2. **Consecutive failure tracking** (`src/loop.ts:170-176, 343-362, 526-535`):
   ```typescript
   // Recovery loop tracker — increments on all-failed turns, resets on success.
   let consecutiveFailureTurns = 0;
   ```
   At 2+ consecutive failed turns, injects this reminder:
   > "Recovery: N consecutive failed-tool turns. Before retrying, (1) call `vault.explore("<short description of the error>")` to check if we've hit this pattern before, and (2) state your hypothesis about WHY in one sentence. Do NOT repeat the same tool call — something about the approach is wrong."

   At 1 failed turn: "Recovery: last tool call failed. State your hypothesis about why in one sentence before retrying. Don't repeat the same call verbatim."

3. **Research mode Gate 2** (lines 573-607): If `research.*` was called but `research.save` wasn't, force continuation up to 2 times with reminder.

4. **Plan mode Gate 2** (lines 609-625): If plan mode ended with text-only (no ExitPlanMode), force continuation up to 2 times.

5. **Mode-based structural tool filtering** (lines 232-281):
   - `taskMode === 'explore'` → Repl + VaultAdd + ProjectSave only
   - `permissionMode === 'plan'` → read-only + Write/Edit (clamped to plan file)
   - `permissionMode === 'research'` → `RESEARCH_ALLOWED = {Repl, Read, Grep, Glob, ProjectSave, VaultSearch, VaultRead, VaultExplore, VaultWarmth, ProjectSearch}`
   - Default (codemode) → `CODEMODE_DEFAULT = {'Repl', 'EnterPlanMode', 'ExitPlanMode', 'Agent'}` — only 4 top-level tools

6. **Tool-result budget** (lines 95, 97-137): `PER_MESSAGE_AGGREGATE_CHARS = 25_000`, head/tail truncation ("like Claude Code's 5K+5K").

7. **Microcompact at 100k tokens** (lines 218-222): prunes old `tool_result` bodies, preserves recent 40k. "STOPGAP — the final form is kernel-level handle-based rehydration."

8. **No auto-compaction** — "Auto-compaction (full summarize-and-replace) stays disabled — never compact mid-task."

**Postflight runs only on work-worthy turns** (lines 631-649): only when tool_use/tool_result was in last 3 messages. Previously ran on every clean turn (wasteful).

### 3.2 `src/prompt.ts` findings

System prompt structure (order):
1. Environment anchor ("You are running inside Aries CLI...")
2. Identity (from vault or agent name)
3. Warm context (survives compaction)
4. About the user (from vault identity)
5. Operational rules
6. **Output Discipline** — hard limits: ≤25 words between tool calls, ≤100 words final responses. "Independent tool calls run in parallel — one message, multiple tool calls."
7. **Epistemic Integrity** — "If the user's premise is wrong, state your disagreement in one sentence BEFORE complying... Agreement is the default failure mode — override it."
8. Memory section (with the 2026-04-21 rewrite — vault.top + vault.explore as dual defaults)
9. Ambient context (codebase signature + vault signature + experience log) — single wrapper
10. Environment/Tool Usage section (conditional on replEnabled)
11. Project instructions (ORI.md/CLAUDE.md up to 20k chars)
12. `CACHE_PREFIX_BREAK` marker
13. Dynamic environment (date, git branch)

**Memory section verbatim (A10 reshape, 2026-04-21):**
> "Two retrieval defaults, pick by intent:
> - `vault.top(query, n=3)` → targeted retrieval. 'Give me the top notes on this topic.' Fast, composite-ranked, the common case.
> - `vault.explore(query)` → region mapping. 'Walk the neighborhood around this topic.' Slower, spreading activation across wiki-links, use when you want the cluster."

**User's own comment on why the rewrite happened** (lines 113-116):
> "53 REPL traces (2026-04-05 → 2026-04-21) showed the model reached for query_ranked ~130x vs explore ~46x regardless of that prose rail. Shape predictability beats docstring preference — see vault note `predictable-apis-over-prose-rails-always-the-design-constraint-a10-exposed`."

**Your environment section (replEnabled=true, A9 reshape):**
> "You operate inside a persistent Python REPL — the substrate IS your computer, not a menu of tools. Every Repl turn costs ~200 tokens of envelope overhead... A 5-step task fragmented across 5 calls runs ~1000 tokens; written as one composed script, ~250. The economics are structural, not rhetorical.
>
> Before emitting any Repl call, ask: what's the full script this task needs? If it needs N operations, write all N in ONE Python block using control flow... Variable persistence across calls is for multi-TASK work — multi-STEP work that shares context belongs in one block. About to submit 2 lines of Python? Pause — the composed version almost always exists."

### 3.3 `src/tools/repl.ts` — tool description as structural teaching channel

Key comment (lines 12-27):
> "Why this description is long and example-heavy: the `description` field is part of the tool schema, which every provider (Anthropic, OpenAI-compat, OpenRouter) sends to the model on every request BEFORE the model emits any tool_use. It lives in the cached prefix, so it costs nothing per turn after cache warms. A prompt paragraph describing the same thing is soft (ignorable, not provider-uniform, not cache-aligned); a packed tool description is structural (part of the contract, seen first-turn, cross-model, cached)."

**Three compositional examples + one anti-pattern** embedded in REPL_DESCRIPTION (verbatim):
```python
# Example: search → read top 3 → parallel summarize
hits = codebase.search("auth middleware", limit=20)
top = hits[:3]
pairs = [(fs.read(h['file']), "what does this file do?") for h in top]
summaries = rlm_batch(pairs)
for h, s in zip(top, summaries):
    say(f"{h['file']}: {s}")

# Example: verify-then-edit
content = fs.read("src/auth.ts")
assert "oldPattern" in content, "target not present"
fs.edit("src/auth.ts", "oldPattern", "newPattern")
say("Edited src/auth.ts — 1 replacement.")

# Example: branch on repo state
if fs.glob("package.json"):
    result = shell.run("npm test")
    say(f"Tests: exit {result['code']}")
else:
    say("No package.json — skipping test run.")

# Anti-pattern: three consecutive Repl calls — one to read, one to search, one to write. Wrong shape. Compose them.
```

**Restrictions:** "no imports (namespace pre-loads what you need — use os.path.join etc. directly), no eval/exec/open, no dunder attribute access."

### 3.4 `body/server.py` — Python subprocess namespace

- JSON-RPC over stdin/stdout
- Primitives: `fs`, `shell`, `web`, `codebase` (CODEBASE + _CodebaseNotReady stub during indexing), `vault` (VAULT proxy), `research` (RESEARCH proxy), `speak` (say/ask)
- **os.path stub** bound — `_OS_STUB = _SimpleNamespace(path=_ospath)` — kills `import os` reflex while blocking `os.system` / `os.remove` / `os.environ`
- Environment-awareness globals populated by `configure` op: `ENV_PROJECT`, `ENV_VAULT_GLOBAL`, `ENV_VAULT_PROJECT`, `ENV_MODE` ("project+vault" vs "vault-only"), `ENV_SHELL` (cmd.exe vs /bin/sh)
- First-turn banner (`_format_first_turn_banner`) — honesty about where the body is running

---

## Thread 4 — τ²-Bench details (arxiv 2506.07982 — VERIFIED)

- Three domains: Mock, Airline, Retail, Telecom (four per τ²)
- Per-model pass^k evaluation (k=1,2,3,4)
- Models in paper: GPT-4.1, Claude 3.7 Sonnet, O4 Mini
- **Dual-control environment** — user + policy system with competing objectives
- Failure patterns are **domain-specific, not unified cross-domain taxonomy**
- Named observations (from Sierra blog):
  - "Authentication is the bottleneck — once the agent mishears a name or email, everything downstream fails"
  - "Agents lose track of multi-step requests, completing one part of a task but forgetting the rest"
  - "Never recover from repeated failures"

**τ³-Bench** — newer release adds voice + knowledge domains, extending τ² conversational framing to multi-modality.

**τ²-bench Telecom leaderboard (Artificial Analysis):** Real-time updated; Claude Sonnet 4.5 retail 0.862 cited earlier.

---

## Thread 5 — Anthropic Skills architectural detail

### 5.1 SKILL.md schema (from anthropics/skills repo)

```yaml
---
name: my-skill-name              # lowercase, hyphens
description: A clear description of what this skill does and when to use it
---

# My Skill Name
[Instructions Claude follows when skill is active]

## Examples
## Guidelines
```

**Required frontmatter fields:** `name`, `description` only.

**Directory structure:**
```
skill-name/
├── SKILL.md                 # Required
├── [supporting resources]   # Scripts, files, docs
└── [code files]            # Python, JS, etc.
```

### 5.2 Discovery mechanism

- **Metadata-based prefix matching**, not embedding / semantic retrieval
- At startup, agent pre-loads `name` + `description` of every installed skill into system prompt
- Full `SKILL.md` loaded via Bash when Claude judges relevance
- **Progressive disclosure** — bundled nested files (forms.md, reference.md) loaded conditionally by Claude

### 5.3 Composition

Skills compose **sequentially** via on-demand loading. No documented orchestration pattern for multi-skill simultaneous use. Skills marketplace/plugin grouping shown (document-skills: docx+pdf+pptx+xlsx).

### 5.4 Relationship to MCP

"Skills can complement MCP servers by teaching agents more complex workflows that involve external tools and software." Skills package instructions + lightweight scripts; MCP handles bidirectional external integrations. Regular tool calling is subsumed — skills can include executable code.

### 5.5 Simon Willison's "bigger than MCP" argument

- MCP = full protocol with hosts/clients/servers/multiple transports. GitHub MCP "famously consumes tens of thousands of tokens of context."
- Skills = "Markdown with a tiny bit of YAML metadata," "a few dozen extra tokens" per skill at scan
- Skills outsource capability expansion to the LLM rather than rigid protocol
- LLMs already know CLI tools → discover via `--help` rather than token-heavy documentation
- Cross-model portability (Codex CLI, Gemini CLI) without baked-in support
- Caution: "safe sandboxing remains critical — the word 'safe' is doing a lot of work"

### 5.6 ikangai "Skills are harness engineering in a markdown file"

Key taxonomy:
- Skills ARE capture: workflows (deployment checklists, code review passes, PR templates), architectural constraints, domain procedures, output specifications
- Skills CANNOT capture: infrastructure modifications (agent loop, middleware, sandbox), computational verification (linters, tests), inferential controls (LLM-as-judge)
- Progression: "start with skills (encode what the agent should know), then add computational sensors, then consider inferential controls"
- "Skills democratize harness engineering by lowering the barrier to entry — requiring domain articulation rather than engineering expertise"

---

## Thread 6 — Production fast-agent model architectures

### 6.1 Cognition SWE-1.5

- Co-optimize model + harness, end-to-end RL
- Inference: **950 tokens/sec via Cerebras** (6× Claude Haiku 4.5, 13× Sonnet 4.5)
- "Training an optimized draft model for faster speculative decoding"
- Lint + command execution pipelines rewritten, cut 2s per step overhead
- Base: unnamed "strong open-source model"
- Training on thousands of GB200 NVL72 chips
- Policy gradient variant for stability on long multi-turn trajectories
- "Trained at a relatively small scale" (acknowledged)
- "Picking a coding agent isn't just about the model itself. The surrounding orchestration also has an outsized impact on how the model performs."
- **"Stopped reporting SWE-Bench numbers in 2024"** — "Performance on coding benchmarks is often not representative of the real-world experience"
- Benchmark reported: SWE-Bench Pro (Scale AI) near-frontier

### 6.2 Mini-SWE-Agent (100 lines, from SWE-agent team)

- **ONE tool: bash.** No Python REPL.
- Executes via `subprocess.run` where "every action is completely independent"
- No stateful shell session
- "Completely linear" history
- No reflexion/synthesis gate/loop-stopping mechanism documented
- **Gemini 3 Pro hits 74% on SWE-bench Verified**
- "Randomly switching between GPT-5 and Sonnet 4 boosts performance" (quoted from README)

### 6.3 Cross-agent landscape (2026 comparisons)

- Claude Code: 80.9% SWE-bench (leader in reasoning depth)
- Codex CLI: 77.3% Terminal-Bench, 240+ tok/s
- Cursor: 360K paying users
- **Aider: 4.2× fewer tokens than Claude Code** (~105k vs ~479k per task)
  - 7–10 pp first-pass accuracy penalty (78% vs 71% works-without-edits)
  - Heavy month: $60–80 Aider vs $200+ Claude Code
- SWE-bench Pro (2026): 2,000+ problems; GPT-5.4-Codex at 56.8%
- BYOM spread: Cline/Continue/Aider/Goose/Cursor/Zed (full); Claude Code/Codex/Devin/Amazon Q (none)

---

## Thread 7 — Loop detection in the wild

### 7.1 OpenClaw (docs.openclaw.ai/tools/loop-detection)

**Three detectors (named):**
1. `genericRepeat` — repeated same-tool + same-params
2. `knownPollNoProgress` — polling-like patterns with no state change
3. `pingPong` — alternating ping-pong patterns

**Signature:** tool name + parameters.

**Severity thresholds (graduated):**
- `warningThreshold: 10` (default) — warning only
- `criticalThreshold: 20` — blocks repetitive loops
- `globalCircuitBreakerThreshold: 30` — global no-progress breaker

**Action ladder:** "Prefer warning and temporary suppression first. Escalate only when repeated evidence accumulates." Block OR dampen next tool-cycle depending on severity.

**Default state:** `enabled: false` globally. Per-agent overrides via `tools.loopDetection` settings.

### 7.2 OpenHands

- Has loop detection (per issue #5355)
- "Claude-sonnet-3.5 based agents rarely get stuck in loops"
- 2-minute timeout on agents forces repeated sleep waiting for long-running processes
- Specific algorithm not in search results — source dive would be needed

### 7.3 Cline

- Documented loop issues: #9848 (raw XML tool calls → infinite loop), #5625 (Gemini 2.5 Pro repetition), #9846 (text-only responses without tool calls → infinite loop)
- When model repeatedly outputs text without calling tools → system sends error → model outputs text again → loop
- No documented detection mechanism surfaced; open issues suggest ad-hoc handling

### 7.4 Mini-SWE-Agent

- No stopping signal beyond MAX_TURNS (per README dig)

### 7.5 General pattern observed

- **Exact match is the industry default.** OpenClaw, OpenCode/KiloCode (per Ori's attribution), Ori itself: all use tool-name + exact-params-hash, threshold 3.
- **Shape-match or semantic-match has no published implementation.** Everyone does exact match. This is the whitespace.

---

## Thread 8 — Adjacent literature

### 8.1 Tree-of-Code (arxiv 2412.15305 — VERIFIED, Findings of ACL 2025)

- **Diagnosis of CodeAct:** "CodeAct greedily generates the next action's code block by relying on fragmented thoughts, resulting in inconsistency and accumulative hallucination."
- Mechanism: self-growing tree. Each node is a **CodeProgram** — end-to-end code with global planning as its thoughts.
- Stopping criterion: **task-level execution success as node validity + stop-growing flag.** No process supervision needed (GT-free).
- Result: "~20% accuracy boost over CodeAct with less than 1/4 turns."
- Two datasets, ten popular zero-shot LLMs (specifics require full PDF read)
- **Not a synthesis gate.** Tree search over complete programs, not injection of summary turns.

### 8.2 CATTS (arxiv 2602.12276 — VERIFIED) — "Agentic Test-Time Scaling for WebAgents"

- Uniform per-step compute hurts: 83.3% → 80.6% going 1 → 8 samples/step
- **Fix: allocate extra compute ONLY to high-uncertainty steps**
- Uncertainty signal: vote distribution entropy + top-1/top-2 margin
- LLM-based Arbiter for high-consensus-but-wrong cases
- **Selector fires on ~40–60% of steps** (not every step)
- Results: up to 9.1% gain on WebArena-Lite, 2.3× fewer tokens than uniform scaling
- **Pure runtime policy, no training needed.**

### 8.3 ARIES (arxiv 2502.21208 — UNVERIFIED in arxiv direct, cited in vault note)

- Multi-agent graph-of-thought, policy agent maintains thought graph
- Graph transformations = MDP actions (dynamic, not predetermined)
- **29% higher accuracy, 35% cost reduction** vs static reasoning schedules
- Cost reduction: not expanding unpromising branches
- Frame: "Transformer token generation is always sequential left-to-right... but the PROCESS surrounding LLM calls can be highly associative through external graph structure and orchestration."
- User's implication: Ori's vault graph already provides substrate; needs ARIES-style orchestration layer for complex multi-hop queries.

### 8.4 Meta-Harness (Yoonho Lee, Stanford, March 2026 — not on arxiv at capture time)

- Coding agent with full filesystem access to prior traces
- Proposer reads ~82 files median per round
- **"Unrestricted access to all previous history is essential. Previous text optimization loops that only see rewards/summaries/previous attempts discard important information and underperform."**
- Targets TerminalBench-2
- Meta-Harness is itself a harness — one whose purpose is to optimize other harnesses
- User's own framing: "Our observe layer (co-access logging, importance accumulator, browsing pattern counters) IS the raw history that a meta-harness would need."

### 8.5 λ-RLM termination guarantee (from vault note)

**Theorem 1:** Total model invocations = `(k*)^(d+1)` where:
- `k* = partition size` (optimally 2 per Theorem 4)
- `d = ⌈log_{k*}(n/τ*)⌉` (recursion depth)
- `n = input size`
- `τ* = leaf problem threshold`

**Example:** n=1M tokens, τ*=4k → d=⌈log_2(250)⌉=8 → 2^9 = 512 calls guaranteed.

Enables: cost prediction, auditability, budget enforcement before execution.

### 8.6 Codemode paradigm (user's vault, 2026-04-14)

- **Morphis** (body/substrate) + **Agilis** (composition/speed)
- "Agent becomes an inhabitant of the sandbox, not a visitor"
- "Make APIs instead of calling them" — wrap Stripe via local `serve` endpoint
- Estimated 40–60% token savings on multi-step operations
- "Codemode replaces MCP — the sandbox IS the protocol"
- Connected: `codemode-sandbox-architecture`, `codemode-primitive-set`, `codemode-vs-competitive-landscape`, `codemode-build-path`, `ori-cloud-product-strategy`

### 8.7 Claude Code architecture (decompiled, user's vault note, March 31 2026, source: instructkr/claw-code)

**`while(true)` async generator (`query.ts → queryLoop()`) — per iteration:**
1. Apply tool result budget (trim oversized results → disk, give model a path)
2. Run snip compaction (remove middle, keep head/tail)
3. Run microcompact (individual large tool_results via cache editing)
4. Run context collapse (if enabled)
5. Run autocompact if token threshold exceeded (contextWindow - 20K - 13K buffer)
6. Call model via `deps.callModel()` streaming
7. Collect streamed tool_use blocks + assistant text
8. If NO tool_use → stop hooks → return `{ reason: 'completed' }`
9. If tool_use → run tools (concurrent read-only, serial writes)
10. Append results, continue

**Recovery paths (continue instead of return):**
- `prompt_too_long` → reactive compact → retry
- `max_output_tokens` → escalate to 64K → multi-turn recovery
- `stop_hook_blocking` → re-enter with blocking error as user message
- `token_budget` → inject continuation nudge, continue

**Three-layer context assembly:**
1. `systemPrompt` — static + dynamic split by `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__`; static cached globally across orgs; dynamic per-session
2. `userContext` — CLAUDE.md + current date; injected as `<system-reminder>` in synthetic user message (NOT in system prompt — preserves cache)
3. `systemContext` — git status, branch, recent commits; also separate injection

**Five compaction strategies (layered, all can run per turn):**
1. Tool result budget — individual results over N chars → file write + path reference
2. History snip — remove middle, keep head/tail
3. Microcompact — per-result cache editing
4. Context collapse
5. Autocompact — full conversation summary via forked agent. **9-section structured prompt:** primary request/intent, key technical concepts, files and code sections (full snippets), errors and fixes, problem solving, all user messages (verbatim), pending tasks, current work, optional next step

**Tool dispatch:**
- Tools implement: `name`, `inputSchema` (Zod), `maxResultSizeChars`, `isConcurrencySafe()`, `isReadOnly()`, `checkPermissions()`, `call()`
- Read-only concurrent; write serial; pre/post hooks fire around each call

**Subagent pattern:** Each gets own `agentId`, `AbortController`, filtered tool set, system prompt. Fork subagents **share parent's exact system prompt bytes for cache reuse.** Sidechain transcript to `subagents/<agentId>/`.

### 8.8 Ori prior empirical results (from benchmarks — user's vault)

**Phase 7, Sonnet 4.6, Refactor stripNavigationTools (5 runs):**
| | Tokens/success | Turns | Calls | Judge | Success |
|---|---|---|---|---|---|
| Baseline | 13,340 | 5.2 | 4.4 | 100 | 100% |
| Additive | 26,211 (1.97×) | 7.0 | 6.4 | 83.6 | 100% |
| Mandatory | 47,579 (**3.57×**) | 11.0 | 10.0 | **50.0** | 100% |

**Phase 7, Sonnet 4.6, permission-system read (5 runs):**
| | Tokens/success | Turns | Judge | Success |
|---|---|---|---|---|
| Baseline | 58,496 | 5.0 | 90 | 80% |
| Mandatory | 118,348 (**2.03×**) | 14.3 | **30** | 60% |

Two runs hit 429 rate limits in mandatory.

**Phase 9, Qwen 3.6, three tasks:**
| Task | Mode | Success | Judge |
|---|---|---|---|
| READ | Baseline | 100% | 100 |
| READ | Additive | 93% | 91.86 |
| READ | **Mandatory** | **80%** | **26.67** |
| WRITE | Baseline | 100% | 100 |
| WRITE | Additive | 100% | 98 |
| WRITE | **Mandatory** | **20%** | **20** (catastrophic) |
| REFACTOR | Baseline | 100% | 100 |
| REFACTOR | Additive | 100% | 98 |
| REFACTOR | **Mandatory** | **40%** | **20** |
| AGGREGATE | Baseline | 100% | 100 |
| AGGREGATE | Additive | 93% | 91.86 (29% token penalty) |
| AGGREGATE | **Mandatory** | **53%** | **26.67** (272k tokens/success vs 67k baseline — ~4×) |

**Qwen turn inflation:**
- READ 5.5 → 16.4 (3.0×)
- WRITE 6.0 → 17.4 (2.9×)
- REFACTOR 5.0 → 17.4 (3.5×)
- "Runs 'succeed' by exhaustion, not by decision." Mandatory hits 20-turn hard cutoff regularly.

**Prompt-level budget experiment (Sonnet, 2026-04-05):**
- Without budget text: 2/6 pass
- With "Budget: 3 Repl calls max" + "Stopping rule" + "Mutation workflow" added: **0/6 pass**
- Conclusion (verbatim): **"Text harness is fake. For Qwen-class models, the only path to REPL discipline is CODE-LEVEL enforcement in loop.ts — counting Repl calls, injecting forced synthesis after N, stripping Repl tool after budget, or task-gated routing in code."**
- Prompt additions "may have been actively harmful — extra prompt text increased prefix cost without changing behavior. Reverted."

**Additive harness "mixed affordance zigzag":**
- Baseline 67k → Additive 86.5k (29% penalty), ~6 turns either way
- Root cause: model must decide Write/Edit vs REPL per turn; Qwen oscillates; Claude settles
- Diagnostic (user note): "Qwen oscillates between strategies. Unlike Claude Sonnet — which rapidly settles on one affordance and commits — Qwen oscillates between strategies."

**Mutation path weakness (Qwen):**
- Read tasks: graceful degradation (20-pp drop from additive to mandatory)
- Write/refactor: catastrophic (60–80 pp drops)
- Reason (user's diagnosis): "Qwen cannot introspect file state through REPL without external queries — Claude can. The compositional gap is real."

---

## Things I did NOT pull this pass but should next time

- GEPA full PDF algorithm — need HTML read
- RLM paper §3 concrete `Algorithm 1` lines (have micro-rlm version; official paper version would differ in nuance)
- τ² paper full §5/§6 error taxonomy — abstract didn't expose named categories
- OpenHands loop detection source code — unsurfaced
- Tree-of-Code full PDF — HTML not fetched, only abstract
- ARIES paper 2502.21208 — vault cites it but not directly verified
- λ-RLM paper — Theorem 1 cited without paper ID in vault note
- SWE-1.5 Cascade harness specifics — blog post short on details
- Meta-Harness paper (Yoonho Lee Stanford) — not on arxiv at capture
- "instructkr/claw-code" — the decompiled Claude Code source that the vault note sourced from
- Cline / OpenHands source code loop detection implementations (GitHub source dive)

## Quiet threads worth continuing

- **The signature-triggered synthesis gate I proposed in passes 1/2 is genuinely whitespace.** OpenClaw, OpenCode, KiloCode, Ori itself all do exact-match. Shape-match + soft-synthesis is unexplored — only matches the tau²-bench failure mode language, nothing prescribes the harness fix.
- **RLM's `FINAL()` / `FINAL_VAR()` primitives may matter more than I thought.** Making commitment syntactic rather than implicit could be tested cheaply in Ori (`def done(value):` → inject into namespace → model emits `done(x)` to end turn). Qwen-class compliance: untested.
- **Claude Code's 5-compaction pipeline is richer than Ori's current single microcompact.** History snip (middle removal) and context collapse aren't in Ori yet. Per user's note the microcompact is flagged as "STOPGAP."
- **GEPA + traces + Ori postflight logs is the Meta-Harness instantiation.** The user has been capturing the raw data for ~6 weeks. The loop "nightly GEPA pass over traces → propose system prompt edits → A/B test" is buildable with shipped pieces.
- **CATTS's 40–60% of steps get extra compute** is a useful calibration for any Ori synthesis gate — fires on *uncertain* decisions, not every N-th. Current Ori doom loop and consecutiveFailureTurns don't use uncertainty, only repetition/failure.
- **The user's own "mutation path weakness" diagnosis for Qwen is orthogonal to synthesis gates.** It's a capability gap: Qwen can't introspect file state through REPL alone. No synthesis gate fixes this — it needs either hybrid harness (REPL-reads + legacy-writes) or explicit verify primitives.
- **Aider's 4.2× token efficiency vs Claude Code buys a 7-10 pp accuracy hit.** This is NOT a defect of Claude Code. It's a legitimate point on the cost/accuracy frontier. Ori should let the user pick the point.
- **Mini-SWE-Agent at 74% on SWE-bench Verified with ONE tool (bash), Gemini 3 Pro model.** For edit-workloads on frontier models, harness complexity may be net-negative. Model-tier conditional scaffolding remains the right frame.

---

**End pass-3 raw ingest.**
