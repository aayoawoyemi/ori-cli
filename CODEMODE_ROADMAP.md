# Codemode Roadmap — Aries CLI v1 → YC → Ori Cloud

Written 2026-04-19. Supersedes the token-fix pass in RUNNING.md as the active build plan. Token-fix pass was preparation; this is the kernel.

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
