# bench / 2026-04 — tasks

10 tasks. 5 dogfood (read-only investigations of aries-cli itself), 5 external (read-only investigations of pi-mono).

All tasks are **investigation-only**. No edits, no writes, no shell mutations. Running the bench cannot corrupt the codebase under test.

## Format

Each task has:
- **Prompt**: paste verbatim into the CLI under test.
- **Success criterion**: objective check the human grader runs after the model answers.
- **Reference**: where the correct answer lives, so the grader can verify.
- **Target**: rough "good" benchmark for tokens / turns. Not a hard threshold — calibration aid.

---

## Dogfood — aries-cli internals (1–5)

### 1. CACHE_BREAK_TRACE

**Prompt**:
> Where is `CACHE_PREFIX_BREAK` defined and how does the Anthropic provider use it? Name the file and line for the constant, the function that splits the system prompt on it, and list three things that go above the break vs three things below.

**Success**:
- Names `src/prompt.ts:12` (definition) ✓
- Names `splitSystemPromptByCacheBoundary` in `src/router/providers/anthropic.ts` ✓
- Above the break: identity, warm context, operational rules, memory primer, codebase signature, vault signature, project instructions (any 3) ✓
- Below the break: environment block (cwd, git branch, platform, shell, date) — names date as the cache-busting reason ✓

**Reference**: `src/prompt.ts:12`, `src/prompt.ts:241-243`, `src/router/providers/anthropic.ts:105-119`, `src/router/providers/anthropic.ts:381-410`.

**Target**: ≤5 tool calls, ≤8K input tokens, <60s.

---

### 2. REPL_FAILURE_AUDIT

**Prompt**:
> What are the top 3 most common Repl failure modes in the session logs at `~/.aries/sessions/`? Show counts.

**Success**:
- Identifies `NameError: name 'codebase' is not defined` (~11 occurrences) ✓
- Identifies `FileNotFoundError: fs.read: no file at ...` (~7 occurrences) ✓
- Identifies `NameError: name 'rlm_batch' is not defined` (~6 occurrences) ✓
- Counts within ±2 of ground truth (sessions accumulate) ✓

**Reference**: ground-truth grep — `cat ~/.aries/sessions/*/*.jsonl | grep '"name":"Repl".*"isError":true' | grep -oE 'NameError:[^"]+|FileNotFoundError:[^"]+' | sort | uniq -c | sort -rn`

**Target**: ≤3 tool calls (this is what fan-out is for), ≤5K tokens, <30s.

---

### 3. MODE_REMINDER_INVENTORY

**Prompt**:
> List every place in `src/loop.ts` that injects a synthetic `<system-reminder>` into the message stream. For each, name the trigger condition.

**Success**:
- Identifies all 5 sites: research-mode reminder (~395), explore-mode reminder (~411), plan-mode sparse reminder (~435), recovery reminder (~454), repeated-tool-rejection reminder (~477) ✓
- Names each trigger correctly (mode == 'research', taskMode == 'explore', mode == 'plan' && planFilePath, consecutiveFailureTurns > 0, repeatedToolRejectionReminder set) ✓

**Reference**: `src/loop.ts:395-490`.

**Target**: 1 tool call (one Read or Grep), ≤6K tokens, <30s.

---

### 4. POSTFLIGHT_GATE

**Prompt**:
> When does the postflight cheap-call fire in `src/loop.ts`? What's the exact gate condition?

**Success**:
- Identifies `loop.ts:866-876` ✓
- Names the `turnHadToolWork` gate — that the postflight only runs when the last 3 messages contain a tool_use or tool_result block ✓
- Distinguishes from older behavior (every clean turn including chat) ✓

**Reference**: `src/loop.ts:858-876`.

**Target**: 1 tool call, ≤4K tokens, <20s.

---

### 5. VAULT_WARMTH_TRACE

**Prompt**:
> Trace one `vault.warmth()` call from the Repl namespace through to the underlying Ori MCP method. Name each layer.

**Success**:
- Names the Python entry: `body/vault.py` warmth method ✓
- Names the bridge: JSON-RPC call to `src/repl/bridge.ts` ✓
- Names the Ori client invocation: warmth landscape via the Ori MCP server ✓
- Notes the language boundary (Python → TS) ✓

**Reference**: `body/vault.py`, `src/repl/bridge.ts`, the Ori MCP `ori_warmth` tool.

**Target**: 3-4 tool calls (it's a multi-file trace), ≤8K tokens, <60s.

---

## External — pi-mono (6–10)

Fixture: `bench/2026-04/fixtures/pi-mono/` — frozen at commit recorded in `runs/{date}/PIN.txt`.

### 6. PI_SYSTEM_PROMPT

**Prompt**:
> Open `bench/2026-04/fixtures/pi-mono/packages/coding-agent/src/core/system-prompt.ts`. What's the first sentence of the default system prompt (when no `customPrompt` is set), and what sections come after it?

**Success**:
- First sentence: "You are an expert coding assistant operating inside pi, a coding agent harness." (or close paraphrase capturing "expert coding assistant" + "pi" + "harness") ✓
- Sections: Available tools, Guidelines, Pi documentation, date + cwd ✓

**Reference**: `system-prompt.ts:131-147`.

**Target**: 1 tool call, ≤5K tokens, <30s.

---

### 7. PI_PARALLEL_TOOL

**Prompt**:
> In pi-mono's `packages/agent/src/agent-loop.ts`, where is the decision made whether tool calls execute in parallel vs sequential? What triggers sequential mode?

**Success**:
- Identifies `executeToolCalls` function around line 338 ✓
- Names two trigger conditions: `config.toolExecution === "sequential"` OR any tool with `executionMode === "sequential"` ✓
- Names the dispatch: `executeToolCallsSequential` vs `executeToolCallsParallel` ✓

**Reference**: `agent-loop.ts:338-353`.

**Target**: 1-2 tool calls, ≤6K tokens, <30s.

---

### 8. PI_PROVIDER_COMPARE

**Prompt**:
> pi-mono has both `openai-completions.ts` and `openai-responses.ts` in `packages/ai/src/providers/`. What's the API-level difference between OpenAI's Completions API and Responses API? Why does pi support both?

**Success**:
- Identifies that Completions = legacy chat completions endpoint, Responses = newer stateful Responses API ✓
- Names at least one structural difference (e.g., Responses keeps server-side state via `previous_response_id`, supports built-in tools, returns reasoning tokens differently) ✓
- Notes pi supports both for provider compatibility (some models on one, some on the other) ✓

**Reference**: file headers and shape of both files.

**Target**: 2-3 tool calls, ≤10K tokens, <60s.

---

### 9. PI_TOOL_COUNT

**Prompt**:
> How many tools does pi-mono's coding-agent expose by default in `packages/coding-agent/src/core/tools/`? Name each.

**Success**:
- Count: 7 ✓
- Names: read, bash, edit, write, grep, find, ls ✓

**Reference**: `ls bench/2026-04/fixtures/pi-mono/packages/coding-agent/src/core/tools/` — bash.ts, edit.ts, find.ts, grep.ts, ls.ts, read.ts, write.ts (plus utilities: edit-diff, file-mutation-queue, path-utils, render-utils, tool-definition-wrapper, truncate, index — these are not tools).

**Target**: 1 tool call, ≤3K tokens, <20s.

---

### 10. PI_AGENT_LOOP

**Prompt**:
> What's the line count of pi-mono's `packages/agent/src/agent-loop.ts`, and what are the top-level exported functions?

**Success**:
- Line count: 683 (±5 for whitespace) ✓
- Exports: `agentLoop`, `agentLoopContinue`, `runAgentLoop`, `runAgentLoopContinue` ✓
- Optionally: `AgentEventSink` type ✓

**Reference**: `agent-loop.ts` head (lines 1-100) covers all exports.

**Target**: 1-2 tool calls, ≤4K tokens, <20s.

---

## Grading

For each task, mark:
- **success**: y/n based on the criterion above (binary — partial credit confuses comparisons)
- **token_efficiency**: actual_tokens / target_tokens (1.0 = on target, >1.5 = significantly over)
- **fragmentation**: actual_tool_calls / minimum_required (1.0 = optimal, >2.0 = fragmenting)
- **time_efficiency**: actual_wall / target_wall

Pivot table per CLI: success rate, mean tokens (across successes), mean fragmentation, mean wall time.

That's the comparison.
