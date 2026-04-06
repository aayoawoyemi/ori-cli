# Competitive Research: CLI Coding Agent Landscape — 2026-04-06

Sources: 6 parallel research agents covering academic papers, Reddit, dev blogs, Twitter/X, open-source frameworks, and token efficiency techniques.

---

## The Headline Numbers

| Tool | Stars | SWE-bench | Token efficiency vs Claude Code |
|---|---|---|---|
| OpenHands | 70.6K | 77.6% | unknown |
| Cline | 59.9K | unknown | unknown |
| Goose | 37.1K | unknown | unknown |
| Claude Code | closed | 77.2% | baseline |
| Aider | open | 83% (polyglot) | **4.2x fewer tokens than Claude Code** |
| SWE-agent | open | 12.5% (2024) | N/A (research) |
| **Ori CLI** | 230 | untested | **2.5x fewer tokens (Claude only)** |

**Aider is the efficiency king at 4.2x.** They do it WITHOUT a REPL — repo map + diff editing + selective file loading. Our 2.5x is good but there's headroom.

---

## Five Patterns That Win

### 1. Architect/Editor Split (Aider)
Two models: one reasons about the problem (architect), one translates to precise edits (editor). Paul Gauthier hit **83% on polyglot benchmarks** with o3-high as architect + gpt-4.1 as editor.

**Ori CLI application:** We already have `rlm_call` for sub-reasoning. Use it as the architect: "given this codebase state, what files need changing and why?" Main model only writes edits. This is the two-LLM pattern we have infrastructure for but don't use.

### 2. Selective File Loading (Aider, Mentat)
Don't dump the whole codebase into context. Aider's repo map uses tree-sitter + PageRank to fit **10x more files** into the same token budget by including only signatures, not full files. Mentat uses RAG to retrieve only relevant snippets.

**Ori CLI application:** Our codebase signature already does this (Phase 5). But we load it on every turn even for simple tasks. Make it lazy — only inject when the model requests structural context. Saves ~600 tok/turn on mechanical edits.

### 3. Diff-Based Editing (Aider, GPT-4.1)
Output diffs instead of full file rewrites. GPT-4.1 was specifically trained for diff format. **86% output token reduction** on edits. Aider supports 8 editing strategies and routes by model capability.

**Ori CLI application:** Our Edit tool already does search/replace (similar to Aider's editblock). But we don't have a diff-output mode. Adding unified-diff editing for models trained on it (GPT-4.1, Claude) could further cut output tokens.

### 4. Dynamic Tool Exposure (Speakeasy, Claude beta)
Every unused tool schema gets tokenized and billed. Dynamic toolsets — expose only relevant tools per task phase — **reduce per-call overhead by 70%**. Claude has a beta for "token-efficient tool use."

**Ori CLI application:** We expose 16+ tools always. For a rename task, the model only needs Grep + Edit (or Repl + Edit). Strip everything else per-task. This is the tool-count reduction from the Gemini CLI insight (5 tools total).

### 5. Event-Stream Architecture (OpenHands)
All agent-environment interactions flow as typed events through a central hub. Decouples agent logic from execution. Scales to multi-agent hierarchies.

**Ori CLI application:** Our loop.ts already yields events (tool_call, tool_result, text, usage). We're close. The gap: we don't have typed Action/Observation pairs like OpenHands. Not urgent but worth noting for v2.

---

## What Developers Actually Want (Reddit/Twitter)

1. **Token cost transparency** — "I need to know upfront how many tokens this task will consume." Show budget, not just usage.
2. **Rate limit awareness** — Claude Code's #1 complaint. Users hit limits mid-refactor and switch tools.
3. **Multi-model routing** — Use expensive models for hard reasoning, cheap models for mechanical edits. Aider proves this works.
4. **Task planning quality > tool quality** — "No meaningful difference in code quality anymore between Cursor and Claude Code." What matters is how clearly you plan the task, not which tool.
5. **Git integration** — Auto-commits, diff preview, undo. Aider has this; we don't.

---

## What This Means for Ori CLI

### Our Actual Competitive Position

**Strengths (keep):**
- REPL composition on Claude: 2.5x token reduction, proven
- Codebase graph (tree-sitter + PageRank + HITS + Louvain): matches Aider's repo map
- Phase 8 judgment tools: unique — no competitor has find_similar_patterns, detect_duplication, is_consistent_with as first-class tools
- Vault memory: persistent cross-session context. Only Ori has this.
- Multi-model routing: already supports Claude, Qwen, DeepSeek, Gemini, local models

**Weaknesses (fix):**
- Token efficiency: 2.5x is good but Aider does 4.2x. Gap is in our signature overhead + tool count
- No architect/editor split: we have rlm_call but don't use it for planning
- Tool overload: 16+ tools. Should be 5-8 per task phase
- No git integration: no auto-commits, no diff preview, no /undo
- No cost transparency UX: no per-task budget, no token forecast

**Unique differentiators (nobody else has):**
- Persistent memory via Ori vault (cross-session, cross-project)
- Phase 8 judgment tools (structural code analysis as first-class agent tools)
- REPL as internal computation engine (not just tool-calling)
- Model-conditional harness (proven that different models need different interfaces)

### Priority Actions

1. **Dynamic tool exposure** — strip tools per task phase. Biggest efficiency win for least effort.
2. **Architect/editor split via rlm_call** — planning model + editing model. Aider proves 83% on this pattern.
3. **Token budget UX** — show estimated cost before running, show running total. The moat Reddit wants.
4. **Git integration** — auto-commit after successful edits. Table stakes.
5. **Lazy signature** — don't load codebase signature unless model requests it or task needs exploration.

### What NOT to Build

- Full state machine (inspect→plan→mutate→verify): Aider and SWE-agent both prove simpler approaches work
- More tools: strip, don't add. Gemini CLI ships with 5.
- Per-turn compression: no evidence it helps more than threshold-triggered compaction
- Multi-agent hierarchies: "most teams skip to Level 4 multi-agent then spend months debugging coordination" (Twitter)

---

## Key Quotes

> "System prompt architecture matters more than model choice." — Kevin Rose, reverse-engineering Claude Code

> "When agents fail, it's a skill issue for the humans." — Andrej Karpathy, March 2026

> "The best coding tool I've ever used, for the 45 minutes a day I can actually use it." — Reddit user on Claude Code

> "Interface design matters more than LLM size." — SWE-agent paper

> "Aider uses 4.2x fewer tokens than Claude Code on identical tasks." — MorphLLM benchmark

---

## For the Paper

The Ori CLI paper should position against this landscape:

1. **Novel finding:** REPL composition is model-conditional. Claude achieves 2.5x; Qwen degrades. No other paper has tested this.
2. **Novel contribution:** Phase 8 judgment tools (structural code analysis as agent-native tools). Nobody else has is_consistent_with or detect_duplication as first-class agent capabilities.
3. **Novel architecture:** persistent memory (Ori vault) as harness component. Cross-session context that compounds.
4. **Honest limitation:** 2.5x is behind Aider's 4.2x. The gap is in tool overhead and signature tax, not in the composition approach.
5. **Research question for future work:** does architect/editor split via rlm_call close the gap with Aider?
