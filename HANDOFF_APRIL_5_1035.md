# Handoff — April 5, 2026 (10:35 PM session end)

## Session summary

Massive session. Phase 8 shipped, harness thesis tested empirically, competitive research done, optimization plan written, OAuth fixed, CLI polish started.

---

## What shipped this session

### Phase 8 — Judgment Tools
- `body/judgment.py` — shared utilities (tokenize_identifier, jaccard, detect_casing, normalize_code_window, ast_shape_hash, hash_sequence_distance). 48 unit tests.
- `body/codebase.py` — 5 new methods on CodebaseGraph:
  - `find_similar_patterns(pattern, limit, mode)` — name/signature/shape modes
  - `suggest_location(description, limit)` — community ranking
  - `find_convention(topic, limit)` — recurring patterns across authority files
  - `detect_duplication(snippet, threshold)` — exact/structural/fuzzy match
  - `is_consistent_with(snippet, reference, criteria)` — naming/structure/imports deviation
- `test/repl/judgment.test.ts` — 22 integration tests through REPL bridge
- `src/prompt.ts` — 5 methods documented in system prompt

### Post-edit codebase refresh
- `CodebaseGraph.refresh_files(paths, root)` — re-parses changed files, patches graph in-place
- `body/server.py` — new `refresh_files` op
- `src/repl/bridge.ts` — `refreshFiles(paths, rootDir)` method
- `src/loop.ts` — `onFileMutated` callback wired after Edit/Write tool execution

### Input fixes
- `src/ui/stableInput.tsx` — ref-based input replacing ink-text-input (fixes dropped characters)
- `src/ui/clipboard.ts` — cross-platform clipboard reader (Windows/macOS/Linux)
- `src/ui/input.tsx` — Alt+V paste handler

### Terminal polish
- `src/ui/terminal.ts` — title management (setTitleBusy/Idle/Done, flashTaskbar)
- Startup banner with Ori elephant + version/model/auth info
- `/reload` slash command — re-indexes codebase + refreshes vault + clears conversation

### Dynamic tool exposure (Phase A optimization)
- `src/tools/toolSets.ts` — lean/full phase system. Lean = Repl + Edit + Write + Bash (4 tools vs 16+)
- `src/loop.ts` — PhaseTracker with fallback-to-full on tool mismatch
- `dynamicTools` param in LoopParams

### Constrained Bash
- `src/tools/bash.ts` — whitelist-based command filtering
  - Allowed: tsc, npm, npx, node, git, mkdir, rm, cp, mv, pip, python, docker, ori, etc.
  - Blocked: cat, grep, find, curl, sed (use Repl/Edit/WebFetch instead)
  - Platform-aware: cmd.exe on Windows, bash on Unix

### OAuth fix
- `src/auth/cch.ts` — VERSION updated to 2.1.92, removed xxHash64 computation (cch=00000 stays literal)
- `src/router/providers/anthropic.ts`:
  - Added `anthropic-beta: oauth-2025-04-20` header (required for OAuth)
  - Added `apiKey: null` to suppress env ANTHROPIC_API_KEY override
  - Removed `computeCch` body-signing step

### Tool result batching fix
- `src/loop.ts` — all tool_results from one assistant turn combined into single user message (fixes Anthropic 400 error)

### Goals freshness fix
- `src/prompt.ts` — removed stale `vaultIdentity.goals` from frozen system prompt. Fresh goals come per-turn via `assembleCurrentState()` → `ori_orient()`
- `brain/self/goals.md` — updated to reflect April 2026 reality

---

## Benchmark results (the thesis)

### Sonnet 4.6 — rename task (5 runs, with dynamic tools + post-edit refresh)
```
BARE:           5/5 pass, 6 turns, ~10K tokens, 16s, tsc 5/5
HARNESS-STRICT: 5/5 pass, 4 turns, ~10K tokens, 15s, tsc 5/5

Delta: turns -33%, tokens ~0% (parity with lean tools), wall -3%
Pass rate: 100% both. Code quality: IDENTICAL.
```

### Qwen 3.6 — same task
```
BARE:           3/3 pass, 6 turns, 29K tokens
HARNESS-STRICT: 0/3 pass, 15 turns, 88K tokens

Thesis: model-conditional. Claude composes. Qwen doesn't.
```

### Key finding
- Prompt-level budget constraints have ZERO effect on Qwen (tested, 0/6 pass)
- Text harness is fake — code enforcement is the only path for non-Claude models
- Aider achieves 4.2x token reduction vs Claude Code (we're at ~1x with lean tools, 2.5x pre-lean)

---

## Plans & docs written

- `OPTIMIZATION_PLAN.md` — Phase A-D plan for closing efficiency gap with Aider
- `PHASE_8_PLAN.md` — Phase 8 design (completed)
- `docs/LEARNINGS_2026_04_05_HARNESS_EVAL.md` — full post-mortem with per-turn traces
- `docs/COMPETITIVE_RESEARCH_2026_04_06.md` — 6-agent research sweep (papers, Reddit, blogs, Twitter, open-source, token efficiency)

---

## Vault notes captured

1. `ori-cli-repl-mandatory-harness-loses-to-bare-tool-calling-on-qwen36.md`
2. `qwen36-fails-repl-mandatory-harness-via-over-targeted-queries-without-synthesis.md`
3. `prompt-level-budget-constraints-have-zero-effect-on-qwen36-repl-behavior.md`
4. `ori-cli-repl-harness-thesis-is-model-conditional-and-confirmed-for-claude-sonnet.md`
5. `sonnet-achieves-33-pass-with-60-token-reduction-after-post-edit-refresh-fix.md`
6. `repl-harness-produces-identical-code-quality-to-bare-tool-calling-but-in-60-fewer-tokens.md`
7. `aider-achieves-42x-token-efficiency-over-claude-code-without-repl-via-repo-map-and-diff-editing.md`

---

## What's next

### Immediate (next session)
1. **Elephant banner** — test rendering in terminal, adjust if braille still broken
2. **Auto-routing per model family** — `claude-auto` mode (Opus plans via rlm_call, Sonnet executes). Needs measurement before shipping as default.
3. **Subagent spawning** — IPC channel is fixed but needs live testing

### Phase A completion
- Run 5x benchmark matrix WITH dynamic tools on Sonnet to measure schema savings
- Token attribution logging is wired but needs analysis

### Phase B-D (from OPTIMIZATION_PLAN.md)
- B: Validate 429 reduction + efficiency delta
- C: Architect/editor split behind flag
- D: Model-family interface routing (Claude → REPL, Qwen → editblock)

### CLI polish backlog
- Model picker UX (multi-step: provider → model)
- Chat history / session management
- `/save` / `/resume` improvements
- Token cost transparency UX

---

## Config state

`~/.aries/config.yaml`:
```yaml
agent.name: Aries
models.primary.provider: anthropic
models.primary.auth: oauth
models.primary.model: claude-opus-4-6
models.primary.contextWindow: 1000000
vault.path: C:\Users\aayoa\brain
repl.enabled: true
experimental.localClaudeSubscription: true
```

`.env` has: DASHSCOPE_API_KEY, DEEPSEEK_API_KEY, ANTHROPIC_API_KEY (depleted)

---

## Commands

```bash
# Run CLI
cd C:\Users\aayoa\Desktop\aries-cli && npx tsx src/index.ts

# Run benchmark
npx tsx bench/quick.ts --model sonnet --task rename --runs 5 --verbose

# Typecheck
npx tsc --noEmit

# Run all tests
for t in security bridge restart codebase reachability vault signature vault-signature judgment; do npx tsx test/repl/${t}.test.ts; done
npx tsx test/memory/orientation.test.ts
npx tsx test/memory/currentState.test.ts
python body/test_judgment.py
```
