# Codemode Roadmap — Aries Preview v2 → YC → Ori Cloud

## Past-action mimicry fix + SWE-Bench-Lite n=3 validation (2026-05-08, late PM)

### What changed

`renderAssistantTranscript` and `renderObservationTranscript` in `src/loop3/agent.ts` (lines 282-326) rewrote completed `tool_use` + `tool_result` pairs from structured API blocks into prose for cache stability:

```
assistant: <prior text>\n\nExecuted Python (toolu_X):\n```python\n<code>\n```
user: Observation (ok, toolu_X):\n<output>
```

This actively poisoned the substrate. After 2-3 turns, the model learned the prose format and started emitting it directly instead of firing `tool_use` API blocks. The psf__requests-3362 failure earlier on 2026-05-08 was the model emitting `Executed Python (toolu_0193YTqvs3m7iqpnM3hjz9u8):` followed by a markdown code block — the LITERAL output of `renderAssistantTranscript`, replayed as prose. Loop3 saw no action, terminated via `natural_text`, no edit was made.

Fix: XML-wrapped, namespace-distinct from compose's `<compose_preflight>` / `<compose_update>` blocks:

```
<repl_call id="toolu_X">
<code><![CDATA[
<code>
]]></code>
</repl_call>

<repl_observation id="toolu_X" status="ok">
<output><![CDATA[
<output>
]]></output>
</repl_observation>
```

`xmlAttr` and `cdataBlock` helpers in `src/loop3/agent.ts:282-292` handle escaping. `src/session/resume.ts:155-179` also writes the same format for crash-recovery transcript reconstruction. Migration helpers (`migrateLoop3AssistantTranscript`, `migrateLoop3ObservationTranscript`) absorb older session logs that still carry the prose shape so resume keeps working across the format break. Smoke at `scripts/loop3_adapter_test.ts:81-88` asserts the new XML format.

### Design principle: no mimicable rewrites

Sister rule to the **dead-category rule** (no corrective prose, only typed structural rejections):

> **No mimicable rewrites.** Agent harnesses must never show the model output that's confusable with the model's own emission format. If the harness rewrites past actions for caching/compression, the rewritten format must be visually distinct enough that the model cannot pattern-match it as a way to emit new actions.

Both rules are about not letting harness output pollute the model's emission distribution. Together they describe a substrate-design discipline: **the model's view of the conversation must contain only (a) authoritative input from the user, (b) the model's own structured output, and (c) data the model interprets but does not emit.** Everything else is mimicry risk.

### Empirical validation

Same task, same model, same prompt, same session date — only the past-action format changed:

```
Format     Result   Tokens   Tools   Cells   Composed   Reuse   Diff       FTP/PTP
Prose      ✗ FAIL   9,616    2       0       —          —       empty       0/1 + 0/—
XML        ✓ PASS   29,771   4       4       4          5       +1/-1       1/1 + 29/29
```

The XML run produced more tokens and longer wall (54s → 196s) because the model is doing real work (composed cells, state reuse, file edit, pytest verification) instead of bailing out via mimicked-prose. The "more tokens" is the right direction — it's the model actually composing.

### SWE-Bench-Lite n=3 post-fix headline

```
                      aries          claude-code    aries advantage
psf__requests-3362   ✓ 29.8K/196s   ✓ 213K/89s     7.1× cheaper, 2.2× slower
pylint-5859          ✓ 36.1K/148s   ✓ 413K/252s    11.4× cheaper, 1.7× faster
pytest-7220          ✓ 10.4K/71s    ✓ 1.66M/323s   159.6× cheaper, 4.5× faster

Pass rate            3/3            3/3
Mean tokens          25.4K          762.5K         (30× aggregate)
Mean wall            104s           222s           (2.1× faster)
```

**3/3 pass parity, 30× aggregate token efficiency, 2.1× faster mean wall** on real GitHub bugs graded by real test suites. n=3 is still anecdotal, but it's the cleanest data we have for the codemode efficiency claim.

### Natural-text steering (Alt+S removed)

`src/ui/input.tsx`: removed the Alt+S handler, simplified ESC latch back to Alt+V only. Mid-turn steering is now purely natural-text — typing during a run + Enter injects into the live `steeringQueueRef`, the loop drains it between tools and aborts the rest of the current batch. JSDoc on `onSteer` updated to describe the gesture as typing, not a keybind.

### Paper-readiness gap

| Need | Status |
|---|---|
| n ≥ 20 tasks × ≥ 6 repos | Have 3 post-fix |
| Cross-model (Opus + Haiku alongside Sonnet) | Sonnet only |
| Pre-compose / V1 / V2 ablation on SWE-Bench-Lite | Have it on bench/2026-04 only |
| Wilcoxon signed-rank on token ratios paired by task | Mean only |
| Failure attribution taxonomy (hallucinated, gate-stuck, no-edit, wrong-edit, PTP-regression, infra-fail) | Manual |
| Replication artifact (pinned git SHA, tasks.json hash, MODEL+VERSION, runnable README) | Not packaged |

Three-track plan in vault note: `brain/notes/compose-loop-paper-needs-n20-cross-model-ablation-plus-past-action-prose-rewrite-is-the-load-bearing-substrate-mechanism-finding.md`. ~3-4 weeks of focused work to publishable artifact.

### Next architectural action

Expand `bench/swe-lite/run-batch.ts` TASKS from 3 to 12-15. Run post-fix bench. Decide based on n=15 distribution whether to spend on cross-model + ablation work for the paper.

---

## Compose architecture breakthrough (2026-05-08)

The model does not manually call `scratch.append(...)` most of the time. Instead:

```text
model emits <compose_preflight> / <compose_update>
        |
        v
Loop3 parses those blocks
        |
        v
ComposeController records them
        |
        v
Loop3 syncs them into body scratch
        |
        v
body/scratch.py writes the request .md file
        |
        v
next model turn sees that markdown injected back into context
```

So the model updates the markdown file by emitting structured visible blocks. The harness turns those into scratch-file writes.

### Architecture diagram

```text
User request
   |
   v
Request Router
classifyRequestMode()
quick / compose / goal
   |
   +-- quick
   |     |
   |     v
   |   Loop3 without compose discipline
   |
   +-- compose / goal
         |
         v
   Request Setup
   - new request_id
   - bridge.configure(session_id, request_id, mode)
   - scratch_start()
   - create .aries/tmp/requests/<session>-<request>.md
         |
         v
   Dynamic System Prompt
   stable prompt
   + compose protocol
   + volatile scratch contents every turn
         |
         v
   Model Turn
   emits text:
   <compose_preflight>
   purpose: ...
   primitives: ...
   cell_kind: ...
   </compose_preflight>
         |
         v
   ComposeController
   - parses preflight/update XML
   - tracks repl_count
   - tracks scout_count
   - tracks last result status
   - gates Repl calls
         |
         +-- allowed
         |     |
         |     v
         |   Repl executes Python cell
         |     |
         |     v
         |   result status recorded
         |
         +-- rejected / exempted
               |
               v
            structural telemetry
            ComposeGate / compose_gate_exempt
         |
         v
   Scratch Sync
   preflight -> scratch.set("preflight", ...)
   update    -> scratch.append("findings", ...)
         |
         v
   Markdown Scratch File
   .aries/tmp/requests/<session>-<request>.md
         |
         v
   Next Turn
         |
         v
   Final
   model should call done(answer)
   scratch_close()
   request_completed telemetry
```

What this means: the new architecture is not "tell the model to plan." It is:

```text
make the model's plan/update artifacts visible,
persist them in a live markdown substrate,
then show that substrate back every turn.
```

That is exactly the visibility thesis. The model sees its own working document evolve, and the gate makes Repl execution depend on that visible document discipline.

This is a real Aries breakthrough, not because XML tags or a markdown scratch file are individually novel, but because the harness finally closes the loop:

```text
model emits intent/update
harness parses it
harness writes durable request state
harness shows it back next turn
harness gates action based on it
telemetry proves whether it happened
```

Before this, the model was told once to plan carefully, use state, compose cells, and close phases. Under pressure it ignored that prose. Now the model sees a live substrate every turn, and the Repl gate makes the substrate behavior consequential.

Bench evidence says the behavior changed:

```text
05-vault-warmth:
old-ish headless: 243K tokens, 9 tools, no compose telemetry
new compose headless: 53K tokens, 6 tools, real preflight/update telemetry
V2 runs: done() path moved from 0/10 to 6/10
```

The important breakthrough: **composition discipline is now observable, enforceable, and measurable.** Before this, failures were vibes and transcripts. Now failures become counters: gates, exemptions, scratch contents, done rate, repair loops, scout budgets, and state reuse.

### Codemode protocol risk: narrated tool use

Why this matters for the codemode story: Claude Code's tool-use protocol on the same SWE-style task did not trigger the hallucination. Claude Code fired 10 actual tool calls and won. The codemode prompt structure with Python code blocks may make the model more likely, when uncertain, to slip into "narrating Python" rather than emitting a real `tool_use` block.

Failure shape: the model emits a valid `<compose_update>` and `<compose_preflight>`, then writes prose like `Executed Python (toolu_...)` followed by a fenced Python block. Loop3 sees no action because no native tool call was emitted, so the request can terminate naturally without making the edit. Compose did its job; the action boundary failed.

This is a real substrate risk, not a reason to abandon the architecture. Preferred hardening is structural: detect the narrated-tool-use pattern and emit `loop3_hallucinated_tool_use` with the captured code and request id. Do not auto-execute the code. The next turn can see a typed event instead of corrective prose, staying inside the dead-category rule.

Patched 2026-05-08: the primary self-poisoning source is removed. Loop3 now archives completed Repl history as `<repl_call>` and `<repl_observation>` records with CDATA payloads instead of `Executed Python (...)` prose. Resume reconstruction uses the same archive format. Detection remains useful as tail-risk telemetry, but the substrate no longer teaches the model to mimic the action transcript.

Written 2026-04-19. Supersedes the token-fix pass in RUNNING.md as the active build plan. Token-fix pass was preparation; this is the kernel.

**Updated 2026-05-08 (PM)**: Compose sub-loop shipped end-to-end (Tier 0-5 of `~/.claude/plans/from-code-dont-take-zany-kurzweil.md`). The 10-task bench validates the composition thesis (9/10 pass at 26K mean tokens vs Claude Code's 7/10 at 169K — **6.4× cheaper, higher pass rate**, 16× on the standout 05-vault-warmth task). One failure (07-pi-parallel-tool) exposed the gate-on-commit bug; comprehensive V2 fix design lives in §Compose Loop V2 below. See [RUNNING.md § Compose sub-loop bench validation](RUNNING.md) for the headline data and architectural progression.

**Updated 2026-05-05 (PM)**: Phase A shipped under a refined architectural shape. Two intermediate forms (Loop2: zero tools, fenced text; Loop2 + stop_sequences band-aids) were tried and bench-falsified. The shipped form is **Loop3**: provider-neutral structured-action channel, with one Anthropic adapter (Repl tool, code parameter) live and OpenAI/JSON adapters stubbed for future backends. Phase A exit criterion is satisfied: Repl is the only verb the model invokes; everything else is a namespace primitive inside the cell. Full session log: [`notes/remake-running-empty.md` § Loop3 Pivot 2026-05-05](notes/remake-running-empty.md). Architecture decision note: `brain/notes/agent-harness-convergence-2026-validates-aries-direction-next-build-is-deterministic-sensors-rlm-revival-and-goal-mode-not-llm-judges.md`.

---

## Compose Loop V2 — comprehensive next fix (designed 2026-05-08)

The 10-task bench shipped V1 of the compose sub-loop. Three issues surfaced. Comprehensive V2 fix lands them together because they share the same code paths and design surface.

### Bugs surfaced by the bench

**Bug 1 — gate fires on commit-only cells (the 07 failure).**
Reconstructed sequence on 07-pi-parallel-tool from the run JSON:
1. Cell 1 (scout, ok), cell 2 (composed, ok), cell 3 (composed, *exception*)
2. Model emits `<compose_preflight>cell_kind: repair` + cell 4 (the repair, ok)
3. Model wants to fire cell 5 — likely `done(answer)` only
4. Gate rejects cell 5 for `update_required` (cell 4's update wasn't emitted because the repair WAS the implicit follow-up to cell 3's exception)
5. Model abandons structured commit, falls through to natural-text completion
6. Bench grader pattern-matches the answer text, misses the function names because the answer was rephrased rather than cited
7. Result: `structuredDone=false`, regex grader fails

The gate is correctly enforcing discipline on work cells but incorrectly enforcing it on commit/closure cells. Commit cells are not composition — they are the act of finishing. The discipline should apply to compositional work, not to closure.

**Bug 2 — repair-after-exception double-charges the update gate.**
A repair cell (`cell_kind: repair`) following an exception is implicitly the response to the prior cell's failure. Requiring a separate `<compose_update>` between the failed cell and the repair cell is over-strict — the repair preflight already explains "I'm fixing the exception." The update_required gate should treat a `cell_kind: repair` preflight as inherently update-satisfying for the prior exception cell.

**Bug 3 — 0/10 structured `done()` commits across the bench.**
Model produces correct answers but ends in natural-text mode. The compose protocol teaches preflight + update but doesn't sufficiently weight commit. The model has no reason to call `done(value)` if natural text closes the loop equally well from the model's perspective. Tier 7 (completion audit) was the originally planned fix; V2 ships a scoped narrow version of it.

### V2 fix design — three changes, ~150 LOC

**Change 1: Pre-shape inspection in the gate (Bug 1).**
`ComposeController.gateRepl(cellCode?: string)` now takes the upcoming cell's source code as an optional argument. A new helper `isExemptOnlyCell(code)` returns true when every non-trivial statement in the cell is one of: `done(...)`, `say(...)`, `ask(...)`, `plan.<verb>(...)`, `state.put/delete(...)`, `scratch.<verb>(...)`. Exempt cells skip the gate entirely (both `needsPreflight` and `needsUpdate`). They are commit/narration/setup, not composition.

In `src/loop3/agent.ts:case 'action'`, the gate call becomes `composeController.gateRepl(event.action.code)`. New telemetry event: `compose_gate_exempt` with `reason_code: 'exempt_commit_only'` so bench rollups can distinguish "model behaved" from "gate let it through" from "gate caught a real lapse."

Predicate is regex-based (cheap, no AST round-trip to body). Lenient — comments stripped, simple variable assignments preceding exempt calls allowed (`result = state.get("x"); done(result)`). Hostile cases (cells that mix commit calls with hidden side effects) are not the failure mode we're fixing; the regex covers the natural shapes.

**Change 2: Repair cells satisfy update_required for the prior exception cell (Bug 2).**
`ComposeController` tracks `lastReplStatus: 'ok' | 'exception' | null`. When `gateRepl` is called and `lastReplStatus === 'exception'` AND the parsed preflight has `cell_kind === 'repair'`, skip the `update_required` check. Rationale: the repair preflight IS the update — it acknowledges the prior failure and proposes the recovery. Forcing a separate `<compose_update>` block between exception-and-repair is ceremonial, not diagnostic.

`recordReplExecuted(execResult)` now takes the result so the controller can update `lastReplStatus`. The agent already has the result at the call site; small signature change.

**Change 3: System prompt content emphasizes commit (Bug 3).**
The compose protocol section in `src/prompt.ts:buildComposeRequestSystemPrompt` gets one new line emphasizing: every compose-mode request ends with a final cell that calls `done(answer)`. The final cell can be commit-only (just `done(...)`); no preflight or update is required for it (Change 1 makes this true structurally). The bench grader and downstream tools pattern-match `done()` payloads, not natural-language paragraphs — synthesizing in prose without committing means the answer doesn't get scored.

This is content, not structure. The model already knows about `done()` from the namespace primitive description; this binds it to the compose protocol explicitly so the model doesn't "complete" via natural text when in compose mode.

### Telemetry additions for V2

- `compose_gate_exempt` (event): `request_id`, `reason_code` (`'exempt_commit_only'` | `'exempt_repair_after_exception'`), `cell_code_chars`
- Bench rollup column: `commit_rate` = (cells with cell_kind=commit OR exempted as commit-only) / total cells per request
- Bench rollup column: `done_rate` = structured_done / total compose requests (currently 0/10; should rise sharply post-V2)

### Verification plan for V2

1. `scripts/compose_loop_smoke.ts` extended with three new cases:
   - Exempt-only cell with no preflight → allowed (Bug 1 fix)
   - Repair cell after exception with no intervening update → allowed (Bug 2 fix)
   - Final commit cell after composed work cells with no update emitted → allowed (Bug 1 fix in commit context)
2. Re-run task 07-pi-parallel-tool single-task. Should now pass (model can fire final commit cell without gate friction).
3. Re-run full 10-task bench with V2 active. Watch:
   - `done_rate`: target ≥6/10 (was 0/10). Should rise sharply with the prompt nudge.
   - Wall time: should drop slightly (one fewer rejection round-trip per request).
   - Gate rejections: should still be non-zero on tasks where the model genuinely skips updates between work cells (real lapses preserved).

### What V2 explicitly does NOT do

- Does NOT relax the gate for non-commit work cells. The discipline that delivered 16× on 05-vault-warmth is preserved.
- Does NOT auto-add `done()` calls. The model must commit; we just tell it more clearly to do so.
- Does NOT introduce LLM-as-judge-style answer validation. The bench grader and natural rejections remain the only judges.
- Does NOT touch the auto-router. 10/10 correct classification stands.

### Out-of-scope for V2 (deferred)

- Wall time deep optimization (24s mean regression vs Claude Code) — structural cost, multiple sources, separate investigation.
- Multiple-tool-uses-in-one-message handling — not yet observed as a failure mode.
- Tier 6 UX polish (compact rendering of preflight/update blocks) — visibility into what shipped is fine for now; render polish is a daily-driver UX concern that gates dogfood, not bench validation.
- Long-running task validation — separate bench effort, not a V2 fix.

### Files this fix touches

- `src/compose/controller.ts` (~50 LOC): add `isExemptOnlyCell` helper, extend `gateRepl(cellCode?)`, track `lastReplStatus`, extend `recordReplExecuted(execResult?)`, emit `compose_gate_exempt` telemetry
- `src/loop3/agent.ts` (~10 LOC): pass `event.action.code` to `gateRepl`, pass `execResult` to `recordReplExecuted`
- `src/prompt.ts:buildComposeRequestSystemPrompt` (~5 LOC): one new line about commit cells
- `bench/2026-04/runner/parsers.ts` (~30 LOC): add `commit_rate` and `done_rate` columns to per-CLI aggregates
- `scripts/compose_loop_smoke.ts` (~50 LOC): three new test cases for exempt and repair-after-exception scenarios
- `src/session/storage.ts` (~3 LOC): add `compose_gate_exempt` event type to the union

Total ~150 LOC. Ship in one commit; the three changes share state and don't decompose well.

---

---

## Build status as of 2026-05-05

| Phase | April 19 plan | What actually shipped | Status |
|---|---|---|---|
| **A — Codemode CLI v1** | Strip tool surface to one Repl tool; every capability becomes a namespace primitive. | Three architectural attempts. **Loop1**: 18 Anthropic tools with code as one (April-shipped, dilutes composition). **Loop2** (April-May): tools=[], fenced ```py``` in assistant text — bench-falsified at Tasks 02/03 due to fence-collision and missing trained yield. **Loop3** (2026-05-05 PM, shipped): provider-neutral structured-action channel; one Repl tool with `{code: string}` input via tool_use; adapters per-provider; body namespace untouched. | **DONE** under Loop3 shape. Bench: 3/3 tasks pass with 30-60% wall-clock improvement vs Loop2. Phase A exit criterion (Repl is the only verb) is met. |
| B — Episodic error memory | Errors compound across sessions; gotcha demo works. | Not yet started. Loop3 substrate is ready to host this. | OPEN |
| C — Benchmark validation | Write regression eliminated; publishable numbers. | Bench infra (`bench/2026-04/runner/*`) shipped + Loop3 metrics block landed. Three tasks (01/02/03) re-validated under Loop3. Need: broader task coverage; multi-model runs (Haiku, Opus); statistical-variance runs (5x). | PARTIAL |
| D — Distribution | Paper + demo + HN + MCP adapter live. | Synthesis note in vault + project running log updated. Paper / demo / HN / MCP-adapter all OPEN. | OPEN |
| E — YC application | Submitted May 4. | YC deadline passed; outcome not gating subsequent work. | (date passed) |
| F — Ori Cloud | First paying customer. | OPEN. | OPEN |

### Why Loop3 is the right realization of Phase A's intent

The original Phase A goal was "Repl is the only verb. Every capability is a namespace primitive." Three execution paths were tested:

- **Loop1** (kept around 8-18 tools alongside Repl) — composition diluted; model routes around code to Edit/Bash/Read instead of composing inside one cell. Still shipped today but not the primary runtime.
- **Loop2** (zero tools, fenced code in assistant text) — solved composition diltution but lost the trained `tool_use → tool_result` yield boundary. Bench-failed Task 02 in three configurations: with stop_sequences (fence collision against ts/md prose fences fragmented answers across 12 turns), without stop_sequences (Sonnet rambled to 43K-char fanout in 189s), without max_tokens cap (predicted same shape).
- **Loop3** (one tool with `{code: string}` parameter via Anthropic native tool_use, provider-neutral interface for future backends) — composition forced (code is the only verb available), trained yield restored (`tool_use → tool_result → message_stop` is heavily post-trained), no fence collision (action lives in a different content-block type from prose). Bench passes all three tasks including the Loop2 failure case.

The convergence with the production literature (Cloudflare codemode, mini-SWE-agent, OpenHands CodeAct) is via Loop3's shape, not Loop2's. Loop2 had one production peer (smolagents.CodeAgent at 27K stars) that engineered around the fence-collision problem differently than we did and that we'd been unintentionally fighting at the wrong layer.

### Why the shape is *provider-neutral*, not "Anthropic tool_use"

The portable architectural commitment is **a structured action channel** with `{kind: 'code', code: string}` as the model-emitted action shape. Backends implement this differently:

- **Anthropic / OpenAI / Gemini**: native tool_use / function call with one tool, code parameter (`AnthropicToolUseAdapter` shipped; `OpenAIToolUseAdapter` stubbed)
- **Local models with reliable tool-calling**: same via OpenAI-compatible schema
- **Local models without reliable tool-calling**: `JsonActionAdapter` (stubbed) — parses a strict JSON action block from text rather than markdown fences
- **Codex-style harness backends**: implement `ActionAdapter` against Codex's existing structured action/event protocol
- **Loop2's fence-in-text shape**: kept as a `FenceAdapter` debug fallback if ever needed; never default

Loop3 sees only `CodeAction` and `ActionEvent`. Adapters absorb wire-format differences. Adding a new backend is implementing one interface; loop3 logic is unchanged. This decouples the kernel commitment ("structured action channel") from any specific provider's API.

### Active phase A→B handoff items

Now that Loop3 substrate is shipped, the next composable building blocks (each a body-side primitive, none changing the loop3 outer harness):

1. **Goal mode primitive** (`body/goal.py`): `Goal(text, expected_shape, checks)` carrying deterministic verification. Bench grader becomes the Goal. Pairs with the synthesis note's argument that LLM-as-judge is dead category and compilers/types/schemas are the only true verifiers.
2. **Sensor layer primitives** (`body/sensors/`): `sensor.typecheck`, `sensor.lint`, `sensor.schema` — deterministic feedback loops for the harness to fold into tool_result.
3. **Parallel sub-loop primitives** (`body/parallel.py`): `parallel`, `race`, `pool` over the body's existing asyncio loop. Concurrency inside a single tool call.
4. **RLM revival as body primitive** (`body/rlm.py`): surface `rlm.call(prompt, context, model="haiku")` and `rlm.batch(...)`. Cross-model default avoids same-model self-validation collapse (vault canon: closed-loop self-validation is dead category). Pairs with `parallel` for fanout to cheap models.
5. **Patch 4 — namespace narrowing per task mode** (`read_only` / `general` / `write`): strip side-effecting primitives from read-only tasks at namespace-build time. The "primary control mechanism" of the production-agent survey, ships independently of loop3.

These four+one are tracked in the project task list (#5-11). Order of operations is dependent only on what we want to bench next; they're orthogonal to each other and orthogonal to loop3.

### Cleanup pending (manual, user-driven)

Phase A's transitional band-aids in the Loop2 path are now dead code:

- `src/router/providers/anthropic.ts:243-247` — `ARIES_LOOP2_MAX_TOKENS` cap. Numeric output caps were the wrong shape (encouragement, not enforcement).
- `src/router/providers/anthropic.ts:601-609` — Loop2 `stop_sequences` injection.
- `src/router/providers/anthropic.ts:924-933` — Loop2 stop_sequence text reinsertion.

Loop2 itself (`src/loop2.ts`, `src/loop/codeExtractor.ts`, `src/loop/resultFormatter.ts`) and its session storage event types stay in-tree as a fallback gated behind `ARIES_LOOP2=1` until Loop3 has 2-3 weeks of stability across multiple models. Removing them now would also break re-parsing of historical bench data.

**Cleanup partially complete as of 2026-05-05 PM dogfood**: targets 1-3 above could not be located in the current codebase — likely consolidated by an earlier Codex pass. Target 4 (`src/index.ts:321` warning narrowing) shipped via the first interactive Loop3 dogfood session. Stale-spec problem to track; the running log section "Loop3 Interactive: First Dogfood..." has the empirical detail.

---

## Phase A → B handoff: kernel primitives, not a top-down kernel design (added 2026-05-05 PM)

After the first interactive Loop3 dogfood session, the strategic question of "are we ready to build Ori Nous as a kernel OS product" got answered: **No, not as a marketed standalone product. Yes, as an emergent set of kernel-grade primitives accumulating inside Aries through dogfood.** Full reasoning in the vault note `brain/notes/the-kernel-is-built-not-designed-loop3-validates-aries-substrate-and-the-next-quarter-is-dogfood-driven-ori-nous-primitive-accumulation.md`. Mapped against the eight-component harness-OS framing (vault: `harness-is-an-eight-component-operating-system-for-agents-and-memory-is-component-four-not-the-whole-thing`), Aries has 2/8 components fully shipped (execution runtime, tool registry) and 6/8 as partials. A kernel is the integration of all 8 with shared abstractions; Aries is at substrate-grade, not OS-grade.

The path forward: dogfood-forced primitives, not top-down design. Loop3 itself proved that posture at the substrate level — it was built from bench data (Tasks 02/03 failures), not from an architecture diagram. Same discipline at the kernel level.

### Architectural commitment for the next subsystem

Every component of the harness "guidance layer" must be a *silent transformation* between model and body, not a "validate-then-reject-with-corrective-message" path. This is a hard line — the same dead-category rule that killed Loop2's `NON_PY_NOTE` and "do not answer in prose yet" injections applies here. Discipline test for any proposed kernel addition: *does the model ever see a message saying "you did X wrong, please do Y"?* If yes, drop. Even nicely-formatted "structured repair" with one-retry budgets fails this test.

```
model emits CodeAction
   ↓
[Silent Action Normalizer]   ← transparent transformation, never sends repair-and-retry
   ↓
[Body executes (existing AST + security path)]
   ↓
[Silent Result Cleaner]      ← already shipped: stdout/say dedup
   ↓
ExecutionResult → tool_result → model
```

### The next four kernel primitives, ordered by dogfood evidence

Each is an Ori Nous component in disguise. Build as Aries needs. Don't build speculatively.

| # | Primitive | Where | Effort | Trigger |
|---|---|---|---|---|
| 1 | Conservative import-strip | `body/security.py` AST pre-pass + `body/test_security.py` | Shipped 2026-05-05 | Built and verified. Silent top-level preloaded import strip prevents `import json`-style turn burn without corrective retry prose. |
| 2 | Capability manifest | New module; refactors `prompt.ts`, `loop3/adapters/anthropic.ts` REPL_TOOL desc, `body/server.py` namespace | 1-2 days | When a second normalization rule needs `is_preloaded?`, OR when Goal mode lands and needs available-primitive set. |
| 3 | Goal mode as a structural object | `body/goal.py` + `src/loop3/agent.ts` integration | Deferred | Only if over-investigation persists after Loop3 polish, import-strip, cleaner specs, and more dogfood traces. Aries should work without Goal mode for now. |
| 4 | Mnemos eviction integration with Loop3 | `body/` + Mnemos package + `loop3/adapters/anthropic.ts` tool_result formatter | Multi-day | When 642K-cache-read patterns repeat across more dogfood sessions. Cooled `tool_result` blocks compact into handles model can re-fetch. |

Conservative import-strip details:

- Strip `import X` and bare `from X import ...` *only* when X is in the preloaded set (`json`, `re`, `math`, `collections`, `itertools`, `datetime`, `random`, `statistics`).
- Don't strip aliased imports (`import json as j` — would NameError on `j`), `from datetime import datetime` (model wants the class shadowing the module), `from collections import Counter` (model wants `Counter` binding, not module access).
- Genuinely unsafe imports (`os`, `subprocess`, `sys`) continue to be rejected by existing security path.
- Strip pass runs *first*, then security validator. Multi-import lines (`import json, sys`) are NOT stripped — security catches `sys` and rejects the whole statement.

Test cases that have to pass before ship:

```python
import json                        → (silently removed)
import re; import math             → (both removed; multi-line OK)
import json, re                    → (both removed when comma-separated and all preloaded)
import json as j                   → preserved (security may still reject if alias semantics matter)
import json, sys                   → preserved (security rejects whole stmt for sys)
from collections import Counter    → preserved
from datetime import datetime      → preserved
import os                          → rejected (security, unchanged)
import subprocess                  → rejected (security, unchanged)
```

### What stays out of scope for this phase

- **Sub-agent spawn / multi-process abstraction**: hardest piece, needs more dogfood data on what shape sub-agents should take. Defer to Q3 2026 at earliest.
- **Top-down "Ori Nous OS" product launch**: earns its launch when Aries hosts it as the underlying runtime and primitives are battle-tested.
- **Competing with OpenAI Agents SDK at the developer-platform level**: different audience, different shape. Aries is a daily-driver coding agent; their SDK is a developer framework.
- **Reactive prose/structured-repair guidance rules** of any kind. Dead category. Walk every proposal through the discipline test before shipping.

### Cleanup tasks superseded by Loop3 win (manual, user-driven)

The earlier Loop2 cleanup sites in the queue (#14-19 in `~/.claude/projects/.../tasks`) are made moot by Loop3's structural-yield architecture: stop_sequences, max_tokens cap, fence collision, yield-marker fallback, custom delimiter. None apply under Loop3. The Phase E manual deletions in `src/router/providers/anthropic.ts` may be partially or fully complete already (see "Cleanup pending" above).

---

## One-line thesis

Every agent gets its own computer.

A persistent Python process with eight namespace primitives (codebase, vault, research, fs, shell, web, compute, rlm) + persistent cross-session memory via Ori Mnemos + episodic error learning that compounds. Repl is the only verb. The environment IS the interface.

---

## Why this now

- **Phase 7 benchmark already proved the architecture** — mandatory REPL beats additive harness 2.14x on tokens, 3.62x vs baseline, on Sonnet.
- **Phase 7 blocker was Edit/Write living outside the namespace** — the write regression was caused by the zigzag. Adding `fs.write`/`fs.edit` inside the namespace is the unshipped fix.
- **Convergence signal: five thinkers converged on variants of this architecture in April 2026.** Distribution window is months, not quarters. First to formalize owns the category.
- **YC Summer 2026 deadline: May 4, 2026.** 15 days from today. Aligns with shipping something real.
- **Nobody has shipped codemode + episodic error memory + MCP distribution together.** White space.

---

## YC application position

- **Company**: Ori
- **One-liner**: *"AI runtime. Every agent gets its own computer."*
- **Problem**: Agents are stateless — tokens plus tool schemas. Every call is a round-trip. They forget between sessions.
- **Solution**: Codemode — Python is the only verb, every capability is a namespace primitive, state persists, memory compounds via Mnemos, every error teaches the system.
- **Proof**: Phase 7 benchmark (2.14x token reduction), 230+ GitHub stars on Mnemos (shipping), working Python body.
- **Why now**: MCP protocol standardizing tool discovery, Anthropic Managed Agents commoditizing the harness layer (we're the substrate below), five-thinker convergence signal.
- **Business model**: Open-core. Substrate open-source (Aries CLI, Mnemos, codemode MCP adapter). Ori Cloud closed, priced per-agent / per-memory / per-compute.
- **First 18 months**: Ship codemode CLI v1, publish paper, 10 paying cloud customers, MCP adapter in 1000+ Claude Code installs.

**Do not miss the May 4 deadline.** Fall batch is September. Competitors may ship by then.

---

## The six phases

| Phase | Days | Cumulative | Exit criterion |
|---|---|---|---|
| A — Codemode CLI v1 | 6-7 | Day 7 | Repl is the only tool. Every capability is a namespace primitive. |
| B — Episodic error memory | 3 | Day 10 | Errors compound across sessions. Gotcha demo works. |
| C — Benchmark validation | 1.5 | Day 11.5 | Write regression eliminated. Publishable numbers. |
| D — Distribution | 5-6 | Day 17 | Paper + demo + HN + MCP adapter live. |
| E — YC application | 2-3 | Day 20 | Submitted May 4. |
| F — Ori Cloud | months | post-YC | First paying customer. |

---

## Phase A — Codemode CLI v1

Goal: Repl is the only tool. Every capability is a Python namespace primitive. Strip the legacy tool surface.

### A1 — `fs.write` callback
Mirrors the existing `vault_request` / `research_request` pattern.
- `body/server.py`: dispatcher for `fs_write_request` in the main loop (reference the vault_response handling at ~line 457)
- `body/repl.py` namespace: `fs.write(path, content)` emits request over stdout, blocks on response
- `src/repl/bridge.ts`: `handleFsCallback` method + `fs_request` dispatcher (mirror `handleVaultCallback` at ~line 471)
- Permission gate: writes outside workspace require user approval; inside workspace auto-approve
- **Est**: 1 day

### A2 — `fs.edit` callback
Same pattern as A1. Wraps Edit tool semantics (old_string / new_string / replace_all).
- `body/repl.py`: `fs.edit(path, old, new, replace_all=False)`
- **Est**: 0.5 day

### A3 — `fs.patch` multi-edit
`fs.patch(path, [(old, new), ...])` applies multiple edits in one callback. Reduces bridge round-trips for batched refactors.
- **Est**: 0.5 day

### A4 — `shell.run` callback
Biggest change — replaces top-level Bash.
- `shell.run(cmd, timeout=30, cwd=None)` returns `{stdout, stderr, code}`
- Wraps existing Bash tool with same permission gate
- Always routes through permission flow unless `alwaysAllowTools.has('shell')`
- **Est**: 1 day

### A5 — `web.fetch` / `web.search` callbacks
Wrap existing WebFetch / WebSearch.
- `web.fetch(url)` returns markdown
- `web.search(query, limit=10)` returns `[{title, url, snippet}]`
- **Est**: 0.5 day

### A6 — `say` / `ask` primitives
User-visible I/O from inside Python.
- `say(text)` pushes to the assistant-text stream; UI renders
- `ask(question)` blocks Repl execution, pops modal, waits for user input, returns string
- This is how the agent speaks to the user when everything runs inside Repl
- **Est**: 1 day (ask is trickier — needs UI integration)

### A7 — Rich docstrings + first-turn namespace dump
- Every primitive gets a docstring with one composition example
- First Repl call in a session returns a result with pinned header:
  ```
  === Aries body ready ===
  Namespace: codebase, vault, fs, shell, web, compute, research, rlm_call, rlm_batch, say, ask
  State: empty (use any primitive to begin)
  Help: run help(name) or name.readme() for API
  Persistent: variables defined here survive across Repl calls until reset()
  ```
- `help(obj)` discovery via native Python introspection
- **File**: `body/server.py` first-turn result formatter
- **Est**: 0.5 day

### A8 — Strip tool registry
- `src/tools/registry.ts` — remove Bash, Edit, Write, Read, Grep, Glob, WebFetch, WebSearch, VaultSearch, VaultRead, VaultExplore, VaultWarmth, VaultAdd, ProjectSearch, ProjectSave from default mode
- Keep: Repl, EnterPlanMode, ExitPlanMode, AskUserQuestion, Task
- Keep stripped tools as dead code — research mode / plan mode may still reference them (grep pass to find callers)
- **Est**: 0.5 day

### A9 — Prompt rewrite
- `src/prompt.ts` — remove all Bash/Read/Edit/Write/Grep/Glob references
- Replace tool-usage section with "Your body" section — terse, lists namespace primitives with one example each
- Lift language from vault note `repl-as-mandatory-interface-is-the-structural-constraint-that-produces-cognition-like-behavior-in-sequential-llms`
- **Est**: 0.5 day

### A10 — Integration smoke test
Run aries-cli, complete five representative tasks using only Repl calls: read file, search codebase, query vault, edit file, run build.
- **Est**: 0.5 day iterating on bugs

**Phase A total: 6-7 days.**

Exit criterion: tool schema visible to the model contains Repl + mode-switchers only. Every other operation happens inside Python. aries-cli usable for real work end-to-end.

---

## Phase B — Episodic error memory

Goal: errors are structured learning events. Every resolved error compounds into future sessions.

### B1 — Structured error objects
Every primitive returns errors as dicts:
```python
{
  "error": "PermissionDenied",
  "primitive": "fs.write",
  "tried": "/etc/passwd",
  "reason": "outside workspace boundary",
  "suggestions": ["write to workspace path", "use ask() to request approval"],
  "related_memory": null
}
```
- Touch: `body/repl.py` (wrap primitive calls), `body/server.py` (format response)
- **Est**: 1 day

### B2 — Auto vault query on error
When a structured error fires, body fires `vault.explore(error_signature)` in background. Result appended to `related_memory` field. Model sees error + past resolutions together.
- **Est**: 0.5 day

### B3 — Gotchas capture
When pattern `[error, later same-class success]` fires, capture `(error_signature, resolution_script)` to `<vault>/gotchas/<error_class>.md`.
- New file: `src/memory/gotchas.ts`
- Hook in `src/loop.ts` after each turn
- **Est**: 1 day

### B4 — `vault.gotchas(pattern)` primitive
Query the gotchas folder by pattern match. Returns prior resolutions.
- Add to Python namespace
- **Est**: 0.25 day

### B5 — UI signal
Status bar shows "3 gotchas learned this session."
- **Est**: 0.25 day

**Phase B total: 3 days.**

Exit criterion: trigger an error, resolve it, restart the CLI, trigger the same error, see the resolution pre-loaded. This is the demo for the blog post.

---

## Phase C — Benchmark validation

Goal: empirical proof codemode + gotchas works across all task types. Publishable numbers.

### C1 — Re-run Phase 7 read task
`bench/compare.ts`. Confirm 2.14x token reduction holds after codemode rewrite.
- **Est**: 0.25 day

### C2 — Write task under codemode
Critical test — does `fs.write`/`fs.edit` inside the namespace eliminate the Phase 7 write regression?
- **Est**: 0.25 day

### C3 — Refactor task under codemode
Judge score recovery expected — refactor was worst under additive harness.
- **Est**: 0.25 day

### C4 — Gotchas compounding experiment
Novel benchmark nobody else can run.
- Same task, same model, N=10 sessions
- Measure: tokens per session, gotchas accumulated, time to completion
- Expected: monotonically decreasing tokens as gotchas accumulate
- **Est**: 0.5 day (mostly waiting for runs)

### C5 — Compile results table
Rows: Baseline, Additive, Mandatory-no-gotchas, Codemode-with-gotchas. Columns per task type: tokens, turns, judge score. Goes in paper + blog.
- **Est**: 0.25 day

**Phase C total: 1.5 days.**

Exit criterion: publishable numbers. If the write regression is not eliminated, discover it here and diagnose before announcing.

---

## Phase D — Distribution

Goal: ship the MCP adapter. Publish the paper. HN + social.

### D1 — MCP adapter package
New npm package: `ori-codemode-mcp`. Wraps the Python body as an MCP server exposing `ori_repl`, `ori_namespace_describe`, `ori_gotchas`. Ships with embedded Python body.
- **Est**: 2 days

### D2 — 30-second demo video
Split screen: Claude Code doing a codebase question (14 tool calls, 100K tokens) vs Aries doing the same (3 Repl calls, 30K tokens). Overlay: *"Same task. Same model. Different architecture."* End card: *"Ori — every agent gets its own computer."*
- Tools: asciinema + OBS
- **Est**: 0.5 day

### D3 — Paper / blog post
Hosted at `github.com/<user>/aries-cli/PAPER.md` or personal site.
- Structure: abstract, motivation, architecture, experiments, results, related work, limitations, code link
- Lift prose from vault notes `codemode-paradigm`, `codemode-primitive-set`, `repl-as-mandatory-interface`
- **Est**: 2 days

### D4 — README rewrites
New pitch — *"Every agent gets its own computer"* — on aries-cli + ori-mnemos READMEs. Link to paper + demo + MCP adapter.
- **Est**: 0.5 day

### D5 — HN submission + social blitz
- HN: Tuesday 9am Pacific. Title: *"Aries: every agent gets its own computer (2.14x fewer tokens than Claude Code)"*
- Twitter: demo video as primary asset
- Reddit: r/LocalLLaMA, r/MachineLearning, r/singularity
- Reply-guy strategy: ready responses for 10 big-account posts about agents
- **Est**: 1 day execute, 2 weeks amplification

### D6 — DMs to amplifiers
Personal (not templated) DMs to: Simon Willison, Swyx, Nate Berkopec, Letta team, oh-my-pi team, Jeremy Howard.
- **Est**: 0.5 day

**Phase D total: 5-6 days.**

Exit criterion: paper published, demo video live, HN post submitted, MCP adapter on npm, 5 DMs sent. Star count tracking daily.

---

## Phase E — YC application

Goal: submit YC Summer 2026 by May 4.

### E1 — Application draft
Form questions, one-liner, short description, founder background, why now, prior work. Use positioning above.
- **Est**: 1 day

### E2 — Founder video
60 seconds, direct-to-camera, clean pitch. One screen moment of the demo.
- **Est**: 0.5 day

### E3 — Submit
Deadline: May 4, 2026.
- **Est**: 0.25 day

### E4 — Parallel applications
1517 Medici (pending), Founders Inc, YC, Anthropic Startup Program. Do not put all eggs in YC basket.
- **Est**: 0.5 day

**Phase E total: 2-3 days.**

---

## Phase F — Post-YC

If accepted: move to SF, full-time on Ori Cloud build, codemode-as-managed-service.

If rejected: keep shipping, apply Fall batch with 3x the traction. Meanwhile:

### F1 — Ori Cloud MVP
WASM or Docker sandbox for multi-tenant codemode. Per-user Mnemos isolation. Basic usage metering + billing. Months 2-3 after Phase E.

### F2 — First paying customer
Mom's CRM agent — already scoped in RUNNING.md, already customer-ready.

### F3 — Expand primitives
`compute.spawn()` sub-agents. `net.serve()` endpoints (the "make APIs instead of calling them" primitive from `codemode-primitive-set`).

---

## Timeline compression

Today is April 19. YC deadline is May 4. 15 days.

**If committing 6+ hours/day, the full timeline works.** Including Moneyball event + university + Jubilee Agent. Tight.

### Minimum-viable descope (if schedule slips)
Cut Phase B or compress Phase D aggressively:
- **Cut B**: apply with codemode but no gotchas. Gotchas becomes "next 60 days" in the YC app. Still strong.
- **Cut D to essentials**: demo video + README + single tweet + HN post. Skip MCP adapter, skip full paper. Apply with thesis + Phase 7 proof + working demo.

### Minimum viable YC application by May 4
- Phase A partially shipped (`fs.write` + `shell.run` at least — demonstrates the thesis)
- Phase C re-run on read task (confirms Phase 7 still holds)
- Demo video + one-page write-up
- YC app submitted

**Recommended sequence**: commit Phase A fully (8 days), compressed Phase C (1 day), skip B for now, minimum Phase D (demo + README + single tweet), apply to YC with thesis + Phase 7 proof + working demo. Gotchas + full paper come AFTER May 4, positioned as "next 60 days of execution."

---

## Phase dependencies

```
A (codemode CLI) ──> B (gotchas) ──> C (benchmark) ──> D (distribution) ──> E (YC)
                 ──> C (without gotchas, fallback path if B slips)
```

A must ship before C (cannot benchmark codemode until codemode works).
C must ship before D (no publishable numbers = no paper).
D (demo + README minimum) must ship before E (YC wants traction, not just thesis).

---

## Open questions

- Sandbox hardening path for Ori Cloud — WASM vs Docker vs Firecracker. Decision deferred until post-YC.
- Small-model degradation path — do we add discoverability primitives specifically for weaker models, or accept frontier-first as the near-term position?
- MCP adapter distribution — publish to npm directly, or go through Anthropic's MCP registry when available?
- Paper venue — blog-first, arXiv if endorsement arrives, workshop submission post-launch?

---

## Naming (frozen 2026-04-19)

- **Ori Mnemos** — memory substrate (shipping, 230+ stars)
- **Ori Nous** — kernel / codemode runtime (this roadmap)
- **Aries** — first harness / reference CLI (this repo)
- **Ori Cloud** — hosted managed service (Phase F)

One-liner: *Ori Mnemos remembers. Ori Nous thinks. Aries acts.*

Public-facing tagline: *Every agent gets its own computer.*
