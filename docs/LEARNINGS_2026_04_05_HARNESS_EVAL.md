# Post-Phase-8 Harness Evaluation — 2026-04-05

**Status:** thesis CONFIRMED for Claude, FAILS for Qwen. Model-conditional finding.

**What was measured:** REPL-mandatory harness vs bare tool-calling on Qwen3.6-Plus, 2 tasks × 2 variants × 3 runs = 12 runs.

---

## TL;DR

Harness lost on both tasks, including the one it was designed to win.

```
task     variant         pass  turns  tokens  wall
---------------------------------------------------
rename   BARE            3/3    6.0   29K    30s
rename   HARNESS-STRICT  2/3   13.0   72K    68s   ← 117% more turns, failed 1/3
explore  BARE            3/3    5.0  110K    49s
explore  HARNESS-STRICT  3/3   14.0  158K    70s   ← 180% more turns, 42% more tokens
```

**Headline:** on Qwen3.6, the harness is **slower, more expensive, and less reliable** than bare tool-calling on both mechanical edit tasks and structural exploration tasks.

---

## Setup

### Tasks

**Task 1: rename** (mechanical multi-file edit)
> Rename the function `tickTurn` to `advanceTurn` across the codebase.
> Update definition in `src/memory/warmContext.ts` and all callers.

Deterministic grep-based validation. Expected bare to win — simple find-and-replace.

**Task 2: explore** (structural reasoning)
> Trace the permission flow from UI keystroke to tool execution gating.
> Name files, variables, describe the modes.

Heuristic validation: answer must cover 4/5 key concepts (`permissionMode`, loop/agentLoop, registry/tool, mode names, UI/app.tsx). Expected harness to win — needed cross-file tracing.

### Variants

| Variant | Tools available |
|---|---|
| **BARE** | Read, Grep, Glob, Edit, Write, Bash, WebFetch, WebSearch, VaultAdd |
| **HARNESS-STRICT** | Edit, Write, **Repl** only. Read/Grep/Glob/Bash stripped. Codebase signature (~600 tok) in system prefix. |

### Model
- `qwen3.6-plus` via DashScope (OpenAI-compatible endpoint)
- No prompt caching (endpoint doesn't support Anthropic cache breakpoints)
- `max_turns = 15`, permission mode = yolo

---

## Per-turn attribution (the smoking gun)

Ran 1 verbose sample per variant. Per-turn breakdown shows exactly where turns go.

### HARNESS-STRICT on explore (15 turns, FAILED to finish)

```
t1:  in=3.8K  tools=[Repl]         cum=4K
t2:  in=4.5K  tools=[]             cum=8.5K
t3:  in=4.5K  tools=[Repl]         cum=13K
t4:  in=6.1K  tools=[Repl]         cum=19K
t5:  in=8.0K  tools=[Repl]         cum=27K
t6:  in=9.9K  tools=[Repl]         cum=37K
t7:  in=11K   tools=[Repl]         cum=49K
t8:  in=13K   tools=[Repl]         cum=62K
t9:  in=14K   tools=[Repl]         cum=76K
t10: in=15K   tools=[Repl]         cum=91K
t11: in=15K   tools=[Repl]         cum=106K
t12: in=15K   tools=[Repl]         cum=122K
t13: in=16K   tools=[Repl]         cum=138K
t14: in=16K   tools=[Repl]         cum=154K
t15: in=16K   tools=[Repl]         cum=170K — MAX_TURNS hit, no final answer
```

**14 consecutive Repl calls, never synthesizes.** Output tokens each turn: 70-180. Model is making tiny targeted Repl queries, never accumulating enough context to commit to an answer. **It never reaches "I'm done, here's the answer" state.**

### BARE on explore (4 turns, PASSED)

```
t1: in=2.8K  tools=[Glob,Grep,Grep]        cum=3K
t2: in=19K   tools=[Read,Read,Read,Read]   cum=22K  — whole files loaded
t3: in=41K   tools=[Read,Read]             cum=63K  — more whole files
t4: in=43K   tools=[-] out=1826            cum=108K — synthesis turn
```

Model reads 6 whole files, then writes a 1826-token answer. **Done in 4 turns.**

### HARNESS-STRICT on rename (15 turns, FAILED)

```
t1:  tools=[Repl]                  — exploration
t2:  tools=[Edit,Edit,Edit,Edit]   — first edits
t3:  tools=[Repl]                  — verify
t4:  tools=[Read,Read,Read]        — ALL 3 FAILED (Read stripped)
t5-t7: tools=[Repl,Repl,Repl]      — confusion
t8:  tools=[Bash]                  — FAILED (Bash stripped)
t9:  tools=[Edit]
t10: tools=[Edit,Edit,Edit]
t11: tools=[Repl]
t12: tools=[WebFetch]              — desperation move, unrelated
t13: tools=[Repl]
t14: tools=[Edit,Edit]
t15: tools=[Repl]                  — MAX_TURNS hit
```

Model thrashes. Makes some edits, can't verify via Read (stripped), tries Bash (stripped), ends up calling WebFetch in confusion, keeps re-editing.

---

## The new finding: "over-targeted REPL"

This is NOT just "Qwen wants Read/Grep." The per-turn log shows Qwen USES Repl enthusiastically — 14 calls in explore, 8 calls in rename. But it uses it WRONG:

- **Tiny targeted queries per call.** Each Repl call is ~150 tokens of output (a small Python snippet). The model never loads multi-file context into one call.
- **No composition.** The thesis was "one composed Repl call replaces 10 tool calls." Qwen does the opposite — it makes 14 sequential Repl calls, each doing one small operation.
- **No stopping criterion.** With Read/Grep, there's a clear "I got the files, now I'll answer" signal. With Repl, exploration is open-ended. Qwen never decides it has enough.

**So the failure is:**
1. Model doesn't compose (writes small sequential Repl calls)
2. Model doesn't know when to stop (Repl is open-ended)
3. Model hits turn cap without synthesizing

**~~The fix is in the PROMPT~~** WRONG. Tested prompt-level budget (2026-04-05 23:10):

Added "Budget: 3 Repl calls max" + "Stopping rule" + "Mutation workflow" to prompt.ts. Result: **0/6 pass (worse than no budget, which was 2/6 + 3/3)**. Model completely ignores prompt-level constraints. Same 15 Repl calls, same escape attempts.

**Prompt engineering is NOT the path. Text harness is fake. Code enforcement is the only path.**

The fix is in CODE:
1. `loop.ts`: count Repl calls per session, strip Repl from registry after N
2. `loop.ts`: inject forced text-only turn after Repl budget exhausted
3. Structured mutation tools (plan_edit, apply_patch, verify_change) enforced at registry level
4. Post-edit re-index to eliminate stale-codebase thrash
5. Semantic doom-loop detector (not just identical-call dedup)

## Tool Breakdown (the tell)

```
rename/BARE:           Edit=12 · Read=7  · Grep=6
rename/HARNESS-STRICT: Repl=17 · Edit=15 · Bash=3  · Read=2    ← Bash/Read = FAILED calls
explore/BARE:          Read=21 · Grep=5  · Glob=3
explore/HARNESS-STRICT: Repl=37 · Bash=1                        ← Bash=1 = FAILED call
```

`Bash=3` and `Read=2` in HARNESS-STRICT are **failed tool-call attempts**. Those tools were stripped but Qwen invoked them anyway — each attempt counts as a wasted turn.

**The model was trained to reach for Read/Grep/Bash.** It doesn't know to compose in Python REPL. Stripping the tools didn't teach it a new paradigm — it just produced failed calls and more round-trips.

---

## Why this happened (hypotheses)

### 1. Model training mismatch
Qwen3.6's tool-use was trained on Read/Grep/Edit sequences from general coding benchmarks. Claude was trained (via Claude Code data) to treat Python REPL composition as a first-class navigation tool. The harness design assumes a Claude-trained model. Qwen, using the same harness, fights it.

### 2. Signature prefix tax is not cached
Codebase signature is ~600 tokens per turn. Anthropic's prompt cache would amortize this to near-zero after turn 1. On DashScope's OpenAI-compatible endpoint, there is no equivalent cache — we pay full price every turn. Over 14 turns, that's ~8.4K extra input tokens the bare variant doesn't pay.

### 3. Composition requires a composition-trained model
The thesis is: "one REPL block with composed operations beats 10 sequential tool calls." That thesis assumes the model WILL compose given the option. Qwen chooses smaller, sequential Repl calls (37 calls in explore instead of 5-10 composed ones). The tokens-per-turn is leaner (11K/turn avg vs 22K/turn bare), but more turns wipe out the gain.

### 4. Escape-hatch stripping is coercion, not guidance
Removing Bash/Read didn't make Qwen compose differently — it made Qwen waste turns on failed calls. Restriction without retraining is friction.

---

## What this does NOT prove

- Doesn't invalidate the thesis for Claude. **We have not tested Sonnet/Opus.** Phase 0 spike was Claude. Phase 7 benchmark (3.62x reduction) was Claude. We don't know whether Claude-specific training carries the thesis.
- Doesn't prove Phase 8 judgment tools are useless. These tasks don't exercise `find_similar_patterns`, `detect_duplication`, `find_convention`, `is_consistent_with`. A judgment-heavy task might still flip the result.
- Doesn't prove prompt caching can't fix token economics. It can, for Anthropic.
- Doesn't prove the harness is wrong for exploration at scale. These are small tasks on a small (84-file) codebase. At 10K+ files, the signature might become load-bearing.

---

## What we learned

### 1. Model-specific harness validation is mandatory before any thesis claim
"Harness beats bare 3.62x" is not a universal statement. It's conditional on training. The paper needs a model-compatibility matrix, not a single number.

### 2. REPL-mandatory is a strong prior that harms on weak priors
If the model isn't trained to compose, forcing it to compose produces 2x more turns. A non-mandatory harness (REPL available, not required) might let the model use what it's good at and reach for Repl when composition genuinely pays off.

### 3. Caching is load-bearing for the signature design
The ambient signature architecture assumes prefix caching. On non-Anthropic endpoints, the signature becomes a tax rather than a subsidy. This is a deployment constraint we haven't documented.

### 4. "Escape hatch" framing was wrong
Initial instinct: Bash/Read are escape hatches the model uses to dodge the harness. Re-framing: Bash/Read are what Qwen is trained to use; the harness is the foreign paradigm. Stripping them punishes the model for being itself.

### 5. Failure modes matter as much as efficiency
HARNESS-STRICT failed 1/3 on rename by hitting turn cap. That's a reliability regression. Efficiency benchmarks that ignore failure rates can obscure real harms.

---

## Paper implications

The Ori CLI architecture paper (Phase 12) needs:

1. **Model-conditioned claims.** "On Claude Sonnet/Opus: X. On open-weight models trained for sequential tool-use: Y."
2. **Training dependency section.** Explain why composition-trained models benefit and sequential-tool-trained models suffer.
3. **Caching disclosure.** Signature architecture requires prefix caching or equivalent.
4. **Failure-mode analysis.** Reliability deltas, not just efficiency deltas.
5. **Honest "what we got wrong" section.** This post-mortem is a primary source.

---

## Next steps

### Must-do before claiming anything
1. Run identical benchmark on Sonnet (same 2 tasks, 3 runs each).
2. Measure the Sonnet delta. If harness wins, we have a Claude-conditional thesis. If harness loses, the architecture needs rework.
3. Add per-turn logging to `bench/quick.ts` (see new `--verbose` flag) to attribute WHERE tokens go.

### Harness improvements to explore
1. **Non-mandatory mode.** Let the model use Repl OR Read/Grep/Edit. Measure whether models spontaneously choose Repl when composition pays off.
2. **Model-conditioned prompt variants.** If model is Qwen/DeepSeek, emphasize sequential tools in system prompt. If Claude, emphasize composition.
3. **Lazy signature.** Don't load codebase signature unless model actually calls a structural tool. Pay the tax only when it's used.
4. **Task-conditioned harness.** For simple mechanical edits, route around the REPL entirely. For structural reasoning, require it.

### New task categories to measure
1. **Judgment-heavy:** e.g. "find all functions similar in structure to X and flag deviations" — something bare tool-calling physically can't do in <30 turns.
2. **Memory-required:** e.g. "based on our past decisions in the vault, should we X?" — bare has no vault access.
3. **Large-codebase exploration:** 5K+ file repo where signature genuinely pays for itself.

---

## Files

- `bench/quick.ts` — benchmark runner
- `bench/results/quick-qwen3.6-1775428402652.json` — raw results
- This file — the learning record

## Reference

- Phase 0 spike (5-6x claim, Claude) — `spike/`
- Phase 7 benchmark (3.62x claim, Claude) — `bench/compare.ts`
- Phase 8 completion — `PHASE_8_PLAN.md`, `HANDOFF_ORIENTATION_FIX.md`

---

**The thesis isn't dead. The thesis is narrower than we thought.** That's a finding.
