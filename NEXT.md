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

---

## Issues — Must Fix

### Response Cutoff Bug
Agent gets cut off mid-response. Needs investigation — could be token limit, streaming issue, or context window management. Reproduce and fix.

### Permission Modes — Edit Approval System
Agent currently writes files without asking. Need a tiered permission system with interactive approval UX.

**Four modes:**
1. **Lockdown** — Agent cannot write/edit anything without explicit approval per file
2. **Normal** — Agent presents plan, user approves batch (default)
3. **Accept All Edits** — Agent writes freely, user sees a summary after
4. **YOLO** — Full autonomy, agent asks when it sees fit

**Approval UX (for Lockdown and Normal modes):**
When the agent wants to write/edit, a popup box appears in the terminal:

```
┌─ Aries wants to: Write src/vault/reader.ts (new file, ~120 lines) ─┐
│                                                                      │
│  [1] Yes    [2] No    [3] Edit plan    [4] Skip this file           │
└──────────────────────────────────────────────────────────────────────┘
```

- **1** = approve, proceed
- **2** = reject, agent adjusts
- **3** = user gives alternative instruction
- **4** = skip this specific file, continue with rest

Mode is set at session start or toggled mid-session via `/permissions` command. Persists in config.

**Implementation notes:**
- Gate lives in the tool execution layer (before Write/Edit/Bash execute)
- Bash commands that modify files (mkdir, rm, mv, cp) also go through the gate
- Read-only tools (Repl codebase.*, fs.read, vault.query) are NEVER gated
- In YOLO mode, the gate is a no-op passthrough

### Terminal-Native Visualization
Need architecture diagrams and progress visualizations rendered directly in Windows Terminal. Not browser, not VS Code preview. Must work offline.

**Tool:** `beautiful-mermaid` (npm) — TypeScript native, synchronous, renders Mermaid syntax to Unicode box-drawing art. Already tested and working in jubilee-agent. `renderMermaidASCII(code) → string`.

**The harness problem:** Bash tool output gets collapsed to "N lines" in the Ink UI. Diagrams render fine but the user can't see them without expanding. Need either:
1. **Rich output detection** — if Bash output contains box-drawing characters (─│┌┐└┘├┤┬┴┼►▼◇), render it expanded/inline instead of collapsed
2. **Explicit `--rich` flag** — agent marks certain Bash calls as "render this output fully" and the harness respects it
3. **Diagram tool** — dedicated tool (not Bash) that renders Mermaid ASCII and always displays expanded. Like how Read tool output isn't collapsed.

Option 3 is cleanest — a `Diagram` tool that takes Mermaid code, runs `renderMermaidASCII()`, and returns the result through a rendering path that doesn't collapse. The agent calls `Diagram` instead of `Bash` and the output shows inline in the conversation.

**Requirements:**
- Box-drawing Unicode characters for flowcharts and architecture diagrams
- Progress tracking (phase completion, what's built vs pending)
- Architecture views (how components connect)
- Editable — user can see the plan visually and request changes
- Works in Windows Terminal (confirmed: WT renders Unicode box-drawing perfectly)
