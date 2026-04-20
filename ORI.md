# Aries CLI — code rules

Guidelines for all new and modified code in this repo. Based on our existing `code-implemtation-rules.mdc` base, adapted for this codebase (TS harness + Python body) and updated with modern AI-slop patterns. Loaded into the cached prefix every session. Live file — extend it, don't balloon it.

---

## Prime directive — trace bugs to the root

When something breaks, diagnose the layer underneath the symptom. Ask "why does this happen" until the answer is a structural claim about the code, not a local exception. Then fix at the root.

Examples from our own history:
- Model zigzags between Bash and Repl → root was *having both in the schema*, not better prose rails.
- Cache miss every day → root was the date block *above* `CACHE_PREFIX_BREAK`, not a bigger cache.
- Write-task regression → root is Edit/Write living outside the Repl namespace, not worse prompting.

If a quick symptomatic fix is tactically necessary, ship it AND name the root cause in the commit or a `// TODO(root):` comment. Never hide a band-aid.

---

## What counts as slop (define it, then avoid it)

A concrete list. When you're about to commit code, scan for these. Every one traces to a real failure mode documented in the LLM code-quality literature (Factory.ai, Greptile, the Feb 2026 arXiv security study, Anthropic's Claude Code canon).

**Length bloat** — writing 100 lines when 10 would do. Ten helpers for a one-shot. Config objects for single-use values. This is the #1 slop pattern by volume. If a function could be 5 lines and you wrote 50, delete.

**Over-engineering** — factory patterns for one implementation, dependency injection before tests exist, abstract base classes with one subclass, generic `<T>` with one concrete use, interface + impl split when no second impl is coming. Rule of three: no abstraction until three call sites need it.

**Defensive bloat** — `try/except Exception: pass` wrapping every call, null-checks on things internal invariants guarantee non-null, fallback chains that mask the real error. Errors only get caught where there's a meaningful action to take. Otherwise let them propagate.

**Fabrication** — inventing API methods, importing packages that aren't in `package.json` / `requirements.txt`, calling functions that don't exist in the referenced file. Before calling something, confirm it exists. Before importing, confirm it's installed.

**Scope creep** — "while I'm here" refactoring, adjacent cleanup during a bug fix, renaming variables in code you weren't asked to touch. Finish the asked task. Note adjacent slop in the commit message, don't silently rewrite it.

**Type gymnastics** — `any` or `unknown` everywhere to silence TS, or the opposite: over-complex generics for a single shape. Match the plainest type that expresses the value.

**Logging noise** — `console.log`, `print`, debug traces left in code. If a log is load-bearing for ops, use the project's structured logger with a real level.

**God functions / god files** — 300-line functions doing five things, 800-line files owning five responsibilities. Break at natural seams.

**Stringly-typed everything** — `type === "admin"` string comparisons scattered through code. Use enums / constants / discriminated unions.

**Dead-code preservation** — commenting out old code "just in case," keeping unused imports, unreachable branches. Delete. Git has it.

**Context rot** — instruction/config files that start specific and grow general. This file is at risk. If you add a rule, it must trace to a specific past mistake or prevent a specific future one. Generic advice gets deleted on sight.

**Attention dilution** — adding a fifth way to say "keep it simple." If a rule already exists, extend the example, don't duplicate the rule.

---

## File header comments

Every new file, and every significantly refactored file, begins with a header block:

```typescript
// File: src/repl/bridge.ts
// Purpose: JSON-RPC bridge between the TypeScript harness and the Python body
//   subprocess. Request queue, restart-on-crash, vault/research callback routing.
// Key pieces:
//   - ReplBridge class (start, exec, shutdown, request)
//   - handleVaultCallback — routes vault_request from Python through OriVault
//   - handleResearchCallback — routes research_request through TS research stages
//   - dispatchResearchMethod — switch over research.* verbs
// Role: Called by src/repl/setup.ts to create the body handle exposed to the
//   Repl tool. Sits between Python's stdio JSON-RPC and the TS vault/research
//   subsystems. Every namespace callback (vault.*, research.*, fs.*, shell.*,
//   web.*) routes through here.
```

Python files use the same shape with `#` comments.

---

## Code block commenting — dense WHY

**This codebase is a design journal.** Match the house style in `src/loop.ts` and `body/server.py`. Comments carry the reasoning, not the mechanics. Future-you six months from now needs the context.

Rules:
- **Every ~5-15 lines forming a logical step gets a preceding comment** — a short paragraph explaining *what the block does and why this way, not the alternative*.
- **Section markers** with box-drawing: `// ── Section Name ──────────────────────`. Scannable, grep-friendly.
- **Dated decision history inline**: `// Phase tracker dropped 2026-04-19. Widen path was dead code (model can't call a tool it can't see). Full tool set every turn.` When you touch a decision, extend the history — don't erase it.
- **Inline explanation** for non-obvious single lines (why this regex, why this timeout, why this off-by-one).
- **Trade-offs called out** — if you trade correctness for speed or simplicity for flexibility, say so.
- **Cross-file references** when logic genuinely spreads (e.g. *"mirrors `handleVaultCallback` in `bridge.ts`"*). These are anchors; keep them current.

Do NOT write:
- Comments that restate the identifier (`// set x to 1`, `// loop over files`). This is the bland-restate-the-obvious slop.
- Sycophantic commentary (`// elegant solution`, `// clean way to handle this`).
- Mystery "hack" comments without explanation. If it's a hack, explain what would fix it.
- Comments that lie — if you change the code, update the comment or delete it.

When in doubt, more WHY context — not more bland description.

---

## Function and method docstrings

- **TypeScript**: JSDoc on all exported functions. Explain purpose, non-obvious parameter semantics, return meaning, side effects, assumptions. Internal helpers — match the file's convention.
- **Python**: PEP 257 triple-quoted docstrings on every public function, class, and module. Describe intent, args (when non-obvious), returns, side effects.

Focus on intent and side effects, not signature restatement. `def read(path: str) -> str` does not need a docstring saying *"reads the path and returns a string."* It needs one saying *"raises FileNotFoundError if path missing; refuses files over 2MB; UTF-8 with replace-on-invalid."*

---

## File length and modularity

Soft limits (per `code-implemtation-rules.mdc`, unchanged):
- Python files — **300-400 LOC** excluding comments/blanks
- TypeScript files — **400-600 LOC** excluding comments/blanks
- React component files — **200-300 LOC**

A file larger than the limit is a prompt to review for refactoring — it is not an unbreakable rule. `src/loop.ts` currently exceeds this intentionally because it is *the* agent loop and fragmenting it hurts readability. When a file grows past the limit, decide deliberately: break it apart, or note in a comment why it stays whole.

**Aim to keep files focused on one responsibility.** If a file is owning three things, it's eventually going to have three bugs that look like one.

---

## Error handling

- Errors handled at boundaries (user input, MCP protocol, subprocess stdio, external HTTP), not at every call site.
- Never `try/catch` "to be safe." Catch a specific exception you can handle meaningfully, or let it propagate.
- A catch block that only logs and swallows is a function lying to its caller. Rewrite.
- Errors carry structured context — not raw strings. See the codemode error-object shape in `CODEMODE_ROADMAP.md` phase B1.
- API endpoints return real HTTP status codes (400/401/403/404/500) with clear JSON messages.
- Use structured logging (`structlog` for Python, the project logger for TS) with context fields — not `console.log` / `print`.

---

## Naming

- Match existing identifiers in the same file. Don't invent parallel vocabulary.
- Variable names name the value, not the type (`matches`, not `matchesList`).
- Functions are verbs (`runPostflight`, `applyNudges`), objects are nouns (`ReplBridge`, `OriVault`).
- Boolean flags start with `is`/`has`/`should`.
- No abbreviations unless the domain already uses them.
- No `tmp` / `data` / `result` as non-local names. `result` inside a 5-line function is fine; `result` as a module-level export is not.

---

## This codebase's patterns

- **TypeScript harness, Python body.** Host is `src/`, agent substrate is `body/`. Do not cross the boundary casually — cross via the JSON-RPC bridge or not at all.
- **Callback pattern for Python ↔ TS.** See `src/repl/bridge.ts:handleVaultCallback`, `handleResearchCallback`. When adding a new bridged primitive (fs, shell, web), mirror this pattern exactly. Don't invent a new transport.
- **Cache prefix discipline.** Everything above `CACHE_PREFIX_BREAK` in `src/prompt.ts` is cached daily. Nothing dynamic (dates, git state, per-turn data) may sit above it.
- **Synthetic markers for per-turn injection.** If you inject into a message, wrap with `wrapSynthetic(kind, ...)` so `stripSyntheticFromMessages` cleans it next turn. Raw injection leaks forever.
- **No silent vault writes.** `vault.add` is the only path. Keyword scans and agreement-ratio heuristics are banned — they pollute the graph.
- **Permission flow for mutations.** Writes, edits, shell commands MUST route through the permission gate (`onPermissionRequest` in `src/loop.ts`) unless `alwaysAllowTools` explicitly opts in. Never bypass.

---

## Non-breaking changes and impact awareness

- Strive to change code in ways that do not break existing functionality elsewhere.
- Before finalizing, actively consider side effects on other modules. Run the type-checker. If the change touches `loop.ts`, `bridge.ts`, `prompt.ts`, or `registry.ts`, assume downstream breakage is likely — check callers.
- If a proposed change might break something else, **state the concern and potential impact explicitly** before applying it. Let me review.

---

## Questions, assumptions, and scope

- If requirements are unclear, or multiple trade-offs exist, **ask before assuming.**
- If an assumption must be made to proceed, state it in a comment: `// Assuming the handle string always contains a dash — see bridge.ts:558.`
- **Stay within the asked scope.** Note related refactors for follow-up rather than expanding the current change.
- If a clean fix genuinely requires a larger refactor, **stop and propose** before proceeding.

---

## On the existing slop

This codebase has real slop — layered patches, dead code paths, over-abstract layers, bland comments. That happened because we were exploring fast. Do not treat it as precedent.

When you touch a slopped area:
1. Finish what was asked first.
2. Flag non-trivial slop with a `// TODO(slop): <one-line reason>` so future-you has an anchor.
3. In the commit message: `Adjacent: <what's slopped, one line>.`
4. Never silently rewrite large swaths of neighboring code while landing a small fix. That hides regressions.

If a clean fix requires a larger refactor, STOP and ask.

---

## Testing and verification

- Run the type-checker before claiming "done" (`npm run typecheck` or build).
- For runtime changes (loop, bridge, router), launch the CLI and exercise the path. Type-checking is not runtime testing.
- For UI changes, open the terminal and USE the feature. Don't claim it works based on the diff.
- For new API endpoints or significant business logic, consider what unit/integration test would be appropriate — even if you don't write it now, note it in a TODO.
- If you can't verify, say so out loud.

---

## Output discipline (assistant-facing, not code)

- Text between tool calls: ≤25 words. Announcing is noise.
- Final responses: ≤100 words unless the task genuinely needs more.
- No summaries of what just happened — the diff shows it.
- No emojis in code, output, or docs unless explicitly asked.
- No sycophantic openers ("Great question", "You're absolutely right"). Say what's true.

---

## Iteration and rule maintenance

These rules are load-bearing because each one traces to a specific mistake in this repo's history or a documented LLM-slop pattern. If a rule bites and you think violating it is correct, articulate why before doing it. Good: *"this is genuinely a boundary; logging the error is the right call."* Bad: *"it's just this one place."*

When new patterns emerge (3+ files repeating), add a rule. When a rule's example goes stale, update it. When two rules contradict, reconcile them. Keep this file dense — every line should earn its place.
