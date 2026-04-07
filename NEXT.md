# What's Next — Ori CLI

## Immediate (next build session)

### Ambient Memory / Warm Context Layer
- Assemble always-present ~2-3K token block at session start
- Identity + goals + user model + last reflection + top warm notes
- Refresh every N turns (not every turn)
- Conversation arc tracking for warmth queries
- Proactive surfacing when preflight notes cross relevance threshold
- Reflection → identity feedback loop

### Per-Model System Prompts
- Different prompts tuned for Anthropic vs Gemini vs OpenAI
- From OpenCode research: each model family has different strengths/quirks
- Same prompt to every model is suboptimal

### UI Polish
- Port Claude Code rendering more closely (horizontal rules, exact colors)
- Test and iterate on the Ink components with real usage
- Fix any streaming/display issues found during testing

## Medium-term

### More Providers (Phase 4 gaps)
- OpenAI provider (GPT-5, o4-mini)
- Moonshot/Kimi K2.5 provider
- Ollama provider (local models)
- OpenAI-compatible provider (any endpoint)

### Shadow Git Snapshots
- Per-step file snapshots for undo (from KiloCode research)
- `.aries/snapshots/` shadow git repo
- /undo command to revert last write

### Tests
- Zero test coverage currently
- Loop tests, preflight tests, compaction tests, router tests
- Research engine integration tests

### npm Publish
- Package as @ori-memory/aries
- Global install: npm i -g @ori-memory/aries
- `ori` or `aries` command

## Research / Deep Dive

### Active Memory — What Does It Mean?
The big open question. Current memory is passive — the vault stores things,
preflight retrieves them. Active memory means:
- The vault changes itself based on what happens
- Notes strengthen, weaken, connect, and disconnect autonomously
- The memory system has its own agency, not just responding to queries
- See brainstorm below.

### Epistemic Integrity V1
- LLM-driven contradiction detection (not just keyword heuristics)
- Agreement threshold calibration from real session data
- Devil's advocate turns
- Outcome tracking with predictions
- CATTS connection (confidence-aware compute scaling)
- Publishable paper angle: memory as antidote to sycophancy

### Research Engine Battle-Testing
- Run /research on real queries, evaluate quality
- Compare output to manual research
- Tune depth levels, source ranking, reflection loop count

### Native Token Compressor (Build Our Own)
- RTK validated the approach (19K stars, 60-90% savings) but has device-fingerprinting telemetry that phones home every 23h — rejected
- Build native compressors in formatToolResult() and tool execution layer instead
- Port the 5-6 highest-value filters: git status/diff, test runners, ls/tree, build errors, log dedup
- Each filter: strip ANSI, remove blank lines, group similar entries, truncate at N lines, dedup repeats
- ~50 lines TypeScript per filter, no external dependency, no telemetry, full control
- Apply to both Bash tool output AND built-in tool results (RTK couldn't do the latter)
- Measure: track input/output token counts per tool call to quantify savings

### Nanochat WASM Compute (Future — Post V1)
- Nanochat (@EastlondonDev) proved a model can be a stack computer where each forward pass is both a compute tick and a token
- Model learned WASM instructions (i32.const, i32.sub, local.set) as vocabulary tokens
- No tool-call round-trip — compute is inline with generation
- Not open source yet (preview only) — track for release
- Application for Aries: lightweight inline evaluator for deterministic ops (math, string transforms, sorting)
- Our REPL bridge already does this at the tool-call level; the gap is latency
- Could build a micro-WASM runtime that intercepts deterministic patterns before they hit the model
- Philosophy to steal NOW even without the tech: deterministic operations should be computed, not generated
- Related: body/server.py REPL already has the sandbox; could add a fast-path eval for simple expressions
